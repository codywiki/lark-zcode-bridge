import { log } from '../core/logger';
import type { CodexModelRouterConfig } from '../config/profile-schema';
import { spawnProcess } from '../platform/spawn';

/**
 * Difficulty-aware reasoning-effort router for Codex.
 *
 * Codex has no built-in adaptive reasoning effort (openai/codex#8649). The
 * router can invoke one shared local classifier, or fall back to a cheap
 * `codex exec` classification call. Any error, timeout, or unparseable output
 * fails closed at ultra so classifier outages cannot under-route F2 work.
 */

export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'ultra';
export type CodexRunEffort = 'minimal' | CodexEffort;

const VALID_EFFORTS = new Set<CodexEffort>(['low', 'medium', 'high', 'xhigh', 'ultra']);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CLASSIFIER_EFFORT = 'low';
const DEFAULT_FALLBACK_EFFORT: CodexEffort = 'ultra';
export const F2_CODEX_MODEL = 'gpt-5.6-sol';
const PROMPT_CHAR_LIMIT = 4000;

/**
 * Sub-agent budget derived from the difficulty tier. The classifier still only
 * emits a single effort word (reliable); the tier -> sub-agent mapping is made
 * deterministically here so it can't drift with model wording.
 *
 * `maxConcurrentThreads` is a cap, not a quota: the main model decides whether
 * to actually spawn sub-agents. Codex rejects `max_concurrent_threads_per_session=0`
 * (minimum 1), so easy turns simply omit the `agents.*` override and fall back to
 * the configured default; "don't delegate for easy tasks" is enforced by the
 * AGENTS.md prompt, not by config.
 */
export interface CodexSubAgentPlan {
  readonly maxConcurrentThreads: number;
  readonly effort: CodexEffort;
  readonly model?: string;
}

export function subAgentPlanForEffort(effort: CodexEffort): CodexSubAgentPlan {
  switch (effort) {
    case 'low':
      // Main run at low rarely delegates; leave agents.* at the configured default.
      return { maxConcurrentThreads: 1, effort: 'low' };
    case 'medium':
      return { maxConcurrentThreads: 1, effort: 'medium' };
    case 'high':
      return { maxConcurrentThreads: 2, effort: 'high' };
    case 'xhigh':
      return { maxConcurrentThreads: 3, effort: 'high' };
    case 'ultra':
      return { maxConcurrentThreads: 3, effort: 'ultra', model: F2_CODEX_MODEL };
  }
}

/**
 * Codex `-c` override *values* for the given sub-agent budget (no `-c` prefix).
 * Codex rejects `max_concurrent_threads_per_session=0` (minimum 1), so easy
 * turns only lower the sub-agent effort and never cap the count below the
 * configured default. Callers prepend `-c` themselves.
 */
export function subAgentOverrideArgs(plan: CodexSubAgentPlan): string[] {
  const out: string[] = [];
  // Only override the count when it actually differs from the codex default (1+).
  if (plan.maxConcurrentThreads > 1) {
    out.push(`agents.max_concurrent_threads_per_session=${plan.maxConcurrentThreads}`);
  }
  if (plan.model) {
    out.push(`agents.default_subagent_model="${plan.model}"`);
  }
  out.push(`agents.default_subagent_reasoning_effort="${plan.effort}"`);
  return out;
}

export function isCodexEffort(value: unknown): value is CodexEffort {
  return typeof value === 'string' && VALID_EFFORTS.has(value as CodexEffort);
}

/**
 * Session overrides remain authoritative for ordinary work, but cannot lower
 * an automatically classified F2 task. Ultra also pins the main model because
 * F2 policy requires sol+ultra on every Codex surface.
 */
export function resolveCodexRunPolicy(
  sessionEffort: unknown,
  routedEffort: CodexEffort | undefined,
  sessionModel: string | undefined,
): {
  effort: CodexRunEffort | undefined;
  subAgentEffort: CodexEffort | undefined;
  model: string | undefined;
} {
  const explicitEffort =
    sessionEffort === 'minimal'
      ? 'minimal'
      : isCodexEffort(sessionEffort)
        ? sessionEffort
        : undefined;
  const effort = routedEffort === 'ultra' ? 'ultra' : (explicitEffort ?? routedEffort);
  return {
    effort,
    subAgentEffort: effort === 'minimal' ? 'low' : effort,
    model: effort === 'ultra' ? F2_CODEX_MODEL : sessionModel,
  };
}

export interface CodexEffortClassifierOptions {
  binary: string;
  /** The model the main run will use; the classifier reuses it unless overridden. */
  model?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  router?: CodexModelRouterConfig;
}

export function isCodexModelRouterEnabled(router?: CodexModelRouterConfig): boolean {
  return router?.enabled === true;
}

function buildClassifierPrompt(message: string): string {
  const clipped =
    message.length > PROMPT_CHAR_LIMIT ? `${message.slice(0, PROMPT_CHAR_LIMIT)}…` : message;
  return [
    '你是飞书机器人任务难度分类器。根据下面这条用户消息判断完成任务所需的推理深度，只回一个词：',
    'low=简单问答/翻译/闲聊/解释概念/格式转换；',
    'medium=单文件改动/局部 bug 修复/写小脚本/读代码回答；',
    'high=多文件重构/复杂调试/性能优化/加测试/审查；',
    'xhigh=跨模块架构调整/安全审计/不可逆数据迁移；',
    'ultra=最高难度：多系统联动的全新架构设计、需要最深层推理的疑难根因分析、复杂度远超日常的任务。只给真正最难的任务用。',
    '只输出这一个词，不要任何解释、标点或前后缀。',
    '',
    `消息：${clipped}`,
  ].join('\n');
}

function parseEffort(text: string): CodexEffort | undefined {
  const token = text.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const stripped = token.replace(/[^a-z]/g, '');
  return VALID_EFFORTS.has(stripped as CodexEffort) ? (stripped as CodexEffort) : undefined;
}

/**
 * `codex exec --json` prints a JSONL event stream. Pull the final assistant
 * text out of it; fall back to the last non-empty line for plain-text output.
 */
function extractFinalText(stdout: string): string {
  let lastText = '';
  let lastLine = '';
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    lastLine = line;
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      const itemText =
        event.type === 'item.completed' && event.item?.type === 'agent_message'
          ? event.item.text
          : undefined;
      if (typeof itemText === 'string' && itemText.trim()) lastText = itemText;
    } catch {
      // not a JSON event line; keep scanning
    }
  }
  return lastText || lastLine;
}

function buildArgs(model: string | undefined, classifierEffort: string): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    ...(model ? ['--model', model] : []),
    '-c',
    `model_reasoning_effort="${classifierEffort}"`,
    '-',
  ];
}

/**
 * Classify the difficulty of one user message. Resolves to the effort tier to
 * use for the main run, or `undefined` to signal "use the default".
 */
export async function classifyCodexEffort(
  message: string,
  opts: CodexEffortClassifierOptions,
): Promise<CodexEffort | undefined> {
  const router = opts.router;
  if (!isCodexModelRouterEnabled(router)) return undefined;

  const timeoutMs = router?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const classifierEffort = router?.classifierEffort ?? DEFAULT_CLASSIFIER_EFFORT;
  const model = router?.classifierModel ?? opts.model;
  const classifierCommand = router?.classifierCommand;
  const command = classifierCommand ?? opts.binary;
  const prompt = classifierCommand ? message : buildClassifierPrompt(message);
  const args = classifierCommand
    ? [...(router?.classifierArgs ?? [])]
    : buildArgs(model, classifierEffort);
  const configuredFallback = router?.fallbackEffort;
  // Lower configured fallbacks remain parse-compatible for existing profiles,
  // but may never weaken the unknown-input safety floor.
  const fallbackEffort =
    configuredFallback === 'ultra' ? configuredFallback : DEFAULT_FALLBACK_EFFORT;

  const started = Date.now();
  return new Promise<CodexEffort | undefined>((resolve) => {
    let settled = false;
    const finish = (
      effort: CodexEffort,
      meta: Record<string, unknown>,
      usedFallback = false,
    ) => {
      if (settled) return;
      settled = true;
      if (!usedFallback) {
        log.info('router', 'classify', { effort, model, ms: Date.now() - started, ...meta });
      } else {
        log.warn('router', 'classify-fallback', {
          effort,
          model,
          ms: Date.now() - started,
          ...meta,
        });
      }
      resolve(effort);
    };

    let child;
    try {
      child = spawnProcess(command, args, {
        cwd: process.cwd(),
        env: { ...process.env, ...(opts.env ?? {}), ...(opts.codexHome ? { CODEX_HOME: opts.codexHome } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(
        fallbackEffort,
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      finish(fallbackEffort, { error: 'timeout', timeoutMs }, true);
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      finish(fallbackEffort, { error: error.message }, true);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        finish(fallbackEffort, {
          status: code,
          stderr: Buffer.concat(stderrChunks).toString('utf8').slice(-300),
        }, true);
        return;
      }
      const effort = parseEffort(
        extractFinalText(Buffer.concat(stdoutChunks).toString('utf8')),
      );
      finish(
        effort ?? fallbackEffort,
        effort ? {} : { error: 'unparseable' },
        effort === undefined,
      );
    });

    try {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(prompt, 'utf8');
    } catch (error) {
      clearTimeout(timer);
      finish(
        fallbackEffort,
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
  });
}
