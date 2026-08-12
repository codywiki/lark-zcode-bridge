import type { AgentCapability } from '../agent/capability';
import type { AgentEvent } from '../agent/types';
import type { ProfileConfig } from '../config/profile-schema';
import {
  classifyCodexEffort,
  resolveCodexRunPolicy,
  subAgentOverrideArgs,
  subAgentPlanForEffort,
  type CodexEffort,
} from '../runtime/codex-effort-router';
import { log } from '../core/logger';
import type { AccessDecision } from '../policy/access';
import {
  evaluateRunPolicy,
  type AgentAttachment,
  type RunPolicyAllow,
  type RunPolicyReject,
  type ScopeContext,
} from '../policy/run-policy';
import {
  resolveAuthorizedWorkingDirectory,
  type WorkingDirectoryRejectReason,
  type WorkingDirectoryResolveResult,
} from '../policy/workspace';
import type { RunExecution, RunExecutor } from '../runtime/run-executor';
import { RunRejected, SpawnFailed, type RunRejectedCode } from '../runtime/errors';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';

export interface StartRunFlowInput {
  scopeId: string;
  scope: ScopeContext;
  prompt: string;
  attachments: AgentAttachment[];
  access: AccessDecision;
  capability: AgentCapability;
  profileConfig: ProfileConfig;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  executor: RunExecutor;
  now: number;
  stopGraceMs?: number;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export type RunFlowRejectCode =
  | WorkingDirectoryRejectReason
  | RunPolicyReject['rejectReason']['code']
  | RunRejectedCode
  | 'kimi-attachments-disabled'
  | 'kimi-safe-start-failed';

export type StartRunFlowResult =
  | {
      ok: true;
      execution: RunExecution;
      policy: RunPolicyAllow;
      cwdRealpath: string;
      resumeFrom?: string;
    }
  | {
      ok: false;
      rejectReason: {
        code: RunFlowRejectCode;
        userVisible: string;
      };
      workspace?: WorkingDirectoryResolveResult;
    };

export interface RecordRunSessionEventInput {
  scopeId: string;
  sessions: SessionStore;
  sessionCatalog?: SessionCatalog;
  capability: AgentCapability;
  policy: RunPolicyAllow;
  event: AgentEvent;
}

export async function startRunFlow(input: StartRunFlowInput): Promise<StartRunFlowResult> {
  if (input.profileConfig.agentKind === 'kimi' && input.attachments.length > 0) {
    return {
      ok: false,
      rejectReason: {
        code: 'kimi-attachments-disabled',
        userVisible: '❌ Kimi 试点暂不支持附件；本批消息未运行。请移除附件后重发纯文本。',
      },
    };
  }

  const requestedCwd =
    input.workspaces.cwdFor(input.scopeId) ?? input.profileConfig.workspaces.default ?? '';
  const workspace = await resolveAuthorizedWorkingDirectory(requestedCwd, input.profileConfig);
  if (!workspace.ok) {
    return {
      ok: false,
      rejectReason: {
        code: workspace.reason,
        userVisible: workspace.userVisible,
      },
      workspace,
    };
  }
  const policy = evaluateRunPolicy({
    scope: input.scope,
    attachments: input.attachments,
    prompt: input.prompt,
    requestedCwd,
    cwdRealpath: workspace.cwdRealpath,
    access: input.access,
    capability: input.capability,
    profileConfig: input.profileConfig,
    now: input.now,
    codexHome: input.profileConfig.codex?.codexHome,
    inheritCodexHome: input.profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) {
    return {
      ok: false,
      rejectReason: policy.rejectReason,
      workspace,
    };
  }

  let resumeFrom: string | undefined;
  let sessionId: string | undefined;
  let threadId: string | undefined;
  if (input.sessionCatalog) {
    const catalogEntry = input.sessionCatalog.activeFor({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath: workspace.cwdRealpath,
      policyFingerprint: policy.policyFingerprint,
    });
    if (catalogEntry?.agentId === 'claude' || catalogEntry?.agentId === 'kimi') {
      sessionId = catalogEntry.sessionId;
      resumeFrom = sessionId;
    } else if (catalogEntry?.agentId === 'codex') {
      threadId = catalogEntry.threadId;
      resumeFrom = threadId;
    }
  }
  if (
    !resumeFrom &&
    (input.capability.agentId === 'claude' ||
      (input.capability.agentId === 'kimi' && !input.sessionCatalog))
  ) {
    resumeFrom = input.sessions.resumeFor(input.scopeId, workspace.cwdRealpath);
    sessionId = resumeFrom;
    const stale = input.sessions.getRaw(input.scopeId);
    if (!resumeFrom && stale?.cwd && stale.cwd !== workspace.cwdRealpath) {
      input.sessions.clear(input.scopeId);
    }
  }

  // Session overrides win for ordinary work. Automatic F2 classification is a
  // hard floor: both the main run and its sub-agents must remain sol+ultra.
  let routedEffort: CodexEffort | undefined;
  let routedSubAgentOverrides: readonly string[] | undefined;
  const sessionEffort = input.sessions.getReasoningEffort(input.scopeId);
  const sessionModel = input.sessions.getModel(input.scopeId);
  if (
    input.capability.agentId === 'codex' &&
    input.profileConfig.codex?.router?.enabled === true
  ) {
    routedEffort = await classifyCodexEffort(input.prompt, {
      binary: input.profileConfig.codex.binaryPath,
      model: sessionModel,
      codexHome: input.profileConfig.codex.codexHome,
      router: input.profileConfig.codex.router,
    });
  }
  const codexPolicy = resolveCodexRunPolicy(sessionEffort, routedEffort, sessionModel);
  const mainEffort = codexPolicy.effort;
  const subAgentEffort = codexPolicy.subAgentEffort;
  if (input.capability.agentId === 'codex' && subAgentEffort) {
    const plan = subAgentPlanForEffort(subAgentEffort);
    routedSubAgentOverrides = subAgentOverrideArgs(plan);
    log.info('run', 'router-effort', {
      scope: input.scopeId,
      effort: mainEffort,
      source:
        routedEffort === 'ultra' && sessionEffort !== 'ultra'
          ? 'f2-router-enforced'
          : sessionEffort === undefined
            ? 'router'
            : 'session-override',
      subAgentMax: plan.maxConcurrentThreads,
      subAgentModel: plan.model,
      subAgentEffort: plan.effort,
    });
  }

  let execution: RunExecution;
  try {
    execution = await input.executor.submit({
      scopeId: input.scopeId,
      policy,
      sessionId,
      threadId,
      model: input.capability.agentId === 'codex' ? codexPolicy.model : sessionModel,
      reasoningEffort:
        input.capability.agentId === 'codex'
          ? mainEffort
          : input.capability.agentId === 'claude'
            ? sessionEffort
            : undefined,
      codexConfigOverrides:
        input.capability.agentId === 'codex' ? routedSubAgentOverrides : undefined,
      images:
        input.capability.agentId === 'codex'
          ? policy.attachments
              .filter((attachment) => attachment.kind === 'image' && attachment.decision === 'accepted')
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path))
          : undefined,
      stopGraceMs: input.stopGraceMs,
      observability: input.observability,
    });
  } catch (err) {
    if (err instanceof RunRejected) {
      return {
        ok: false,
        rejectReason: {
          code: err.code,
          userVisible:
            err.code === 'reconnect-in-progress'
              ? '当前 bot 正在重连，稍后会继续处理新消息。'
              : err.code === 'run-interrupted'
                ? '当前任务已在启动前停止。'
              : err.code === 'run-already-active'
                ? '当前会话已有运行在执行，请稍后再试或先停止当前运行。'
              : '当前无法发起运行，请稍后重试。',
        },
        workspace,
      };
    }
    if (input.profileConfig.agentKind === 'kimi' && err instanceof SpawnFailed) {
      // Kimi is exposed to organization members. Startup failures can embed
      // provider text, local paths, config contents, or credentials, so keep
      // durable diagnostics categorical for this adapter.
      log.warn('run-flow', 'kimi-safe-start-failed', {
        agent: 'kimi',
        code: err.code,
      });
      return {
        ok: false,
        rejectReason: {
          code: 'kimi-safe-start-failed',
          userVisible:
            '❌ Kimi 当前无法安全启动，本次任务未运行。请联系 bot 管理员检查配置后重试。',
        },
        workspace,
      };
    }
    throw err;
  }

  return {
    ok: true,
    execution,
    policy,
    cwdRealpath: workspace.cwdRealpath,
    ...(resumeFrom ? { resumeFrom } : {}),
  };
}

export function recordRunSessionEvent(input: RecordRunSessionEventInput): void {
  if (input.event.type !== 'system') return;
  if (
    (input.capability.agentId === 'claude' || input.capability.agentId === 'kimi') &&
    input.event.sessionId
  ) {
    const cwdRealpath = input.event.cwd ?? input.policy.cwdRealpath;
    input.sessions.set(input.scopeId, input.event.sessionId, cwdRealpath);
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: input.capability.agentId,
      cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      sessionId: input.event.sessionId,
    });
    return;
  }
  if (input.capability.agentId === 'codex' && input.event.threadId) {
    input.sessionCatalog?.upsertActive({
      scopeId: input.scopeId,
      agentId: 'codex',
      cwdRealpath: input.policy.cwdRealpath,
      policyFingerprint: input.policy.policyFingerprint,
      threadId: input.event.threadId,
    });
  }
}
