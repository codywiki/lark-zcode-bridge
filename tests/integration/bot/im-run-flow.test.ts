import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityForProfile } from '../../../src/agent/capability';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { startRunFlow } from '../../../src/bot/run-flow';
import { ProcessPool } from '../../../src/bot/process-pool';
import {
  createDefaultProfileConfig,
  type AgentKind,
} from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('IM run flow', () => {
  it('rejects missing cwd without falling back to the user home', async () => {
    const h = await createHarness();

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'empty-requested-cwd',
      },
    });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('submits cwd through RunExecutor and resumes matching sessions', async () => {
    const h = await createHarness();
    const workspaceRealpath = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', h.tmp.workspace);
    h.sessions.set('chat-1', 'sess-1', workspaceRealpath);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(result.resumeFrom).toBe('sess-1');
    expect(h.agent.runOptions[0]).toMatchObject({
      runId: 'run-1',
      cwd: workspaceRealpath,
      sessionId: 'sess-1',
    });
  });

  it('uses the profile default workspace when a scope has no explicit binding', async () => {
    const h = await createHarness({ defaultWorkspace: true });
    const workspaceRealpath = await realpath(h.tmp.workspace);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected run flow to start');
    expect(result.cwdRealpath).toBe(workspaceRealpath);
    expect(h.agent.runOptions[0]?.cwd).toBe(workspaceRealpath);
  });

  it('passes Kimi model overrides through to the run executor', async () => {
    const h = await createHarness({ agentKind: 'kimi', defaultWorkspace: true });
    h.sessions.setModel('chat-1', 'kimi-code/k3-256k');

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      model: 'kimi-code/k3-256k',
      reasoningEffort: undefined,
    });
  });

  it('keeps explicit F2 effort and pins Codex sub-agents to sol plus ultra', async () => {
    const h = await createHarness({ agentKind: 'codex', defaultWorkspace: true });
    h.sessions.setModel('chat-1', 'gpt-5.6-terra');
    h.sessions.setReasoningEffort('chat-1', 'ultra');

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: '修复 OAuth 鉴权绕过',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
      codexConfigOverrides: [
        'agents.max_concurrent_threads_per_session=3',
        'agents.default_subagent_model="gpt-5.6-sol"',
        'agents.default_subagent_reasoning_effort="ultra"',
      ],
    });
  });

  it('preserves minimal for the Codex main run while mapping sub-agents to low', async () => {
    const h = await createHarness({ agentKind: 'codex', defaultWorkspace: true });
    h.sessions.setModel('chat-1', 'gpt-5.6-terra');
    h.sessions.setReasoningEffort('chat-1', 'minimal');

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'minimal',
      codexConfigOverrides: ['agents.default_subagent_reasoning_effort="low"'],
    });
  });

  it('does not let a low session override downgrade an automatically classified F2 run', async () => {
    const h = await createHarness({ agentKind: 'codex', defaultWorkspace: true });
    h.sessions.setModel('chat-1', 'gpt-5.6-sol');
    h.sessions.setReasoningEffort('chat-1', 'low');
    enableUltraRouter(h.profileConfig);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: '修复 OAuth 鉴权绕过',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
      codexConfigOverrides: [
        'agents.max_concurrent_threads_per_session=3',
        'agents.default_subagent_model="gpt-5.6-sol"',
        'agents.default_subagent_reasoning_effort="ultra"',
      ],
    });
  });

  it('pins the main model to sol when automatic routing classifies F2', async () => {
    const h = await createHarness({ agentKind: 'codex', defaultWorkspace: true });
    h.sessions.setModel('chat-1', 'gpt-5.6-terra');
    enableUltraRouter(h.profileConfig);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: '修复 OAuth 鉴权绕过',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
  });

  it('rejects a legacy Kimi cwd outside the profile default workspace root', async () => {
    const h = await createHarness({ agentKind: 'kimi', defaultWorkspace: true });
    const outside = join(h.tmp.root, 'outside-workspace');
    await mkdir(outside, { recursive: true });
    h.workspaces.setCwd('chat-1', outside);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result).toMatchObject({
      ok: false,
      rejectReason: {
        code: 'outside-profile-root',
      },
    });
    expect(h.agent.runOptions).toEqual([]);
  });

  it('runs Kimi from an additional profile-authorized workspace root', async () => {
    const h = await createHarness({ agentKind: 'kimi', defaultWorkspace: true });
    const secondary = join(h.tmp.root, 'secondary-workspace');
    await mkdir(secondary, { recursive: true });
    h.profileConfig.workspaces.allowedRoots = [await realpath(secondary)];
    h.workspaces.setCwd('chat-1', secondary);

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'hello',
      attachments: [],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]?.cwd).toBe(await realpath(secondary));
  });
});

async function createHarness(
  options: { defaultWorkspace?: boolean; agentKind?: AgentKind } = {},
): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('bridge-im-run-flow-');
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => 'run-1',
    now: () => 1000,
  });
  const agentKind = options.agentKind ?? 'claude';
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    ...(agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
    ...(agentKind === 'kimi' ? { kimi: { binaryPath: 'kimi' } } : {}),
  });
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor,
    sessions,
    workspaces,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        ...(options.defaultWorkspace ? { default: await realpath(tmp.workspace) } : {}),
      },
    },
  };
}

function enableUltraRouter(
  profileConfig: ReturnType<typeof createDefaultProfileConfig>,
): void {
  if (!profileConfig.codex) throw new Error('expected codex profile');
  profileConfig.codex.router = {
    enabled: true,
    classifierCommand: process.execPath,
    classifierArgs: ['-e', 'process.stdout.write("ultra\\n")'],
    timeoutMs: 1000,
    fallbackEffort: 'ultra',
  };
}
