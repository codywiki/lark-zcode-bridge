import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import type { CodexSandboxMode } from '../../config/permissions';
import { log } from '../../core/logger';
import {
  installProcessOutputExitGuard,
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import {
  AgentPreflightError,
  checkAgentAvailability,
  type AgentAvailability,
} from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import {
  applyZcodeModelOverride,
  applyZcodeReasoningOverride,
  isZcodeModelConfigReady,
  prepareZcodeProfileHome,
  ZCODE_API_KEY_ENV,
  ZCODE_DEFAULT_RUNTIME_PATH,
  ZCODE_REASONING_LEVELS,
  type ZcodeReasoningLevel,
} from './profile-home';

export const ZCODE_RUNTIME_FAILURE_MESSAGE =
  '❌ ZCode 当前无法完成本次任务。请联系 bot 管理员检查 ZCode 运行时与模型配置后重试。';
export const ZCODE_MODEL_CONFIG_HINT =
  `ZCode 模型配置缺失或未填写 API Key。请运行 \`lark-zcode-bridge profile login <name>\` 写入 Key，` +
  `或在创建 profile 前设置 ${ZCODE_API_KEY_ENV} 环境变量。`;

export interface ZcodeAdapterOptions {
  /** Absolute path to zcode.cjs inside ZCode.app. */
  runtimePath?: string;
  /** Node executable used to launch the runtime; defaults to process.execPath. */
  nodePath?: string;
  /** Version recorded at bootstrap; a mismatch is logged, not fatal. */
  recordedVersion?: string;
  defaultModel?: string;
  baseURL?: string;
  profileStateDir: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

type ZcodeChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

type ZcodePermissionMode = 'plan' | 'build' | 'yolo';

interface ZcodeHeadlessResult {
  sessionId?: unknown;
  response?: unknown;
  usage?: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadTokens?: unknown;
  };
}

const MAX_STDERR_BYTES = 64 * 1024;

/**
 * ZCode headless one-shot adapter.
 *
 * Each run spawns `node zcode.cjs --prompt <text> --json --mode <mode>` and
 * parses the single JSON object printed on stdout. Conversation history lives
 * in ZCode's own session store inside the isolated profile home; the bridge
 * persists the returned `sessionId` and passes it back via `--resume`.
 */
export class ZcodeAdapter implements AgentAdapter {
  readonly id = 'zcode';
  readonly displayName = 'ZCode CLI';

  private readonly runtimePath: string;
  private readonly nodePath: string;
  private readonly recordedVersion: string | undefined;
  private readonly defaultModel: string | undefined;
  private readonly baseURL: string | undefined;
  private readonly profileStateDir: string;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ZcodeAdapterOptions) {
    this.runtimePath = opts.runtimePath ?? ZCODE_DEFAULT_RUNTIME_PATH;
    this.nodePath = opts.nodePath ?? process.execPath;
    this.recordedVersion = opts.recordedVersion;
    this.defaultModel = opts.defaultModel?.trim() || undefined;
    this.baseURL = opts.baseURL?.trim() || undefined;
    this.profileStateDir = opts.profileStateDir;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    if (!existsSync(this.runtimePath)) {
      const diagnostic = {
        code: 'agent-binary-not-found' as const,
        agentId: 'zcode' as const,
        agentName: this.displayName,
        command: 'zcode',
        binaryPath: this.runtimePath,
      };
      return { ok: false, error: new AgentPreflightError(diagnostic), diagnostic };
    }
    const availability = await checkAgentAvailability({
      agentId: 'zcode',
      agentName: this.displayName,
      command: 'zcode',
      binaryPath: this.nodePath,
      args: [this.runtimePath, 'version'],
    });
    // ZCode.app self-updates the bundled runtime, so a version drift from the
    // bootstrap recording is logged for support but never blocks the run
    // (fail-closed version pins took the Kimi bridge down on every update).
    if (availability.ok && this.recordedVersion && availability.version !== this.recordedVersion) {
      log.warn('agent', 'version-drift', {
        agent: 'zcode',
        recorded: this.recordedVersion,
        current: availability.version,
      });
    }
    return availability;
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'zcode runtime check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    const prepared = prepareZcodeProfileHome(this.profileStateDir, {
      apiKey: process.env[ZCODE_API_KEY_ENV],
      ...(this.defaultModel ? { model: this.defaultModel } : {}),
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });
    if (!isZcodeModelConfigReady(prepared.homeDir)) {
      throw new SpawnFailed('zcode model config missing api key', undefined, 'agent-prepare-failed');
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for ZcodeAdapter.run');

    const prepared = prepareZcodeProfileHome(this.profileStateDir, {
      apiKey: process.env[ZCODE_API_KEY_ENV],
      ...(this.defaultModel ? { model: this.defaultModel } : {}),
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
    });
    if (!isZcodeModelConfigReady(prepared.homeDir)) {
      // prepareRun normally gates this; emit a clean failure when a caller
      // spawns without preparing.
      return immediateFailureRun(opts.runId, ZCODE_MODEL_CONFIG_HINT);
    }

    // /model changes the profile-wide default in the isolated config; ZCode
    // headless has no per-run model flag.
    const selectedModel = opts.model ?? this.defaultModel;
    if (opts.model) {
      applyZcodeModelOverride(prepared.homeDir, opts.model);
    }
    // Same for /effort: reconcile the reasoning block on every run so a
    // cleared session override deterministically returns to zcode's builtin
    // default (max). Unknown values are ignored rather than failing the run.
    const effort = toZcodeReasoningLevel(opts.reasoningEffort);
    applyZcodeReasoningOverride(prepared.homeDir, effort);

    const mode = zcodePermissionMode(opts.sandbox);
    const args: string[] = [
      this.runtimePath,
      '--prompt',
      prefixBridgeSystemPrompt(opts.prompt, this.botIdentity),
      '--json',
      '--mode',
      mode,
      '--cwd',
      opts.cwd,
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    for (const image of opts.images ?? []) {
      if (image) args.push('--attach', image);
    }

    const imageOutputDir = join(this.profileStateDir, 'images');
    mkdirSync(imageOutputDir, { recursive: true });
    const env = mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel));
    env.HOME = prepared.homeDir;
    env.LARK_CHANNEL_IMAGE_DIR = imageOutputDir;

    const child = spawnProcess(this.nodePath, args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ZcodeChild;
    const outputGuard = installProcessOutputExitGuard(child);
    child.stdin.end();

    log.info('agent', 'spawn', {
      agent: 'zcode',
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      hasModel: Boolean(selectedModel),
      mode,
    });

    let runtimeError: Error | undefined;
    let stopping = false;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { agent: 'zcode', pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    let stopPromise: Promise<void> | undefined;

    return {
      runId: opts.runId,
      pid: child.pid,
      events: createEventStream(child, () => runtimeError, () => stopping, outputGuard.closed),
      stop(): Promise<void> {
        if (stopPromise) return stopPromise;
        stopping = true;
        stopPromise = (async () => {
          try {
            await terminateChild(child, stopGraceMs);
          } finally {
            // Also runs when the direct child exited before stop() was called;
            // descendants may still be holding these pipes open.
            outputGuard.close();
          }
        })();
        return stopPromise;
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return waitForExit(child, timeoutMs);
      },
    };
  }
}

export function zcodePermissionMode(sandbox: CodexSandboxMode | undefined): ZcodePermissionMode {
  switch (sandbox ?? 'danger-full-access') {
    case 'read-only':
      return 'plan';
    case 'workspace-write':
      return 'build';
    case 'danger-full-access':
      return 'yolo';
  }
}

/**
 * The session store carries free-form strings (shared with other adapters'
 * vocabularies upstream); clamp to what the GLM runtime actually understands
 * and treat anything else as "no override" → builtin default.
 */
function toZcodeReasoningLevel(effort: string | undefined): ZcodeReasoningLevel | undefined {
  if (!effort) return undefined;
  return (ZCODE_REASONING_LEVELS as readonly string[]).includes(effort)
    ? (effort as ZcodeReasoningLevel)
    : undefined;
}

async function* createEventStream(
  child: ZcodeChild,
  getError: () => Error | undefined,
  isStopping: () => boolean,
  outputClosed: Promise<void>,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn zcode: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const stdoutChunks: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => {
    if (Buffer.byteLength(stderr) < MAX_STDERR_BYTES) {
      stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - Buffer.byteLength(stderr));
    }
  });
  void outputClosed.catch(() => {});

  const exitCode = await waitForExitCode(child);
  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const result = parseZcodeHeadlessResult(stdout);

  if (isStopping()) {
    yield {
      type: 'done',
      ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
      terminationReason: 'interrupted',
    };
    return;
  }

  const runtimeError = getError();
  if (exitCode !== 0) {
    yield {
      type: 'error',
      message: zcodeFailureMessage(exitCode, stderr, runtimeError),
      terminationReason: 'failed',
    };
    return;
  }
  if (!result) {
    yield {
      type: 'error',
      message: runtimeError
        ? `zcode runtime error: ${runtimeError.message}`
        : 'zcode exited without a JSON result',
      terminationReason: 'failed',
    };
    return;
  }

  if (result.sessionId) {
    yield { type: 'system', sessionId: result.sessionId };
  }
  if (result.response) {
    // ZCode headless is one-shot: there are no streaming deltas, so emit the
    // full response as a single `text` delta (renders into the card) as well
    // as `final_text` (consumed by echo-style commands). Mirrors the upstream
    // codex adapter's dual emission.
    yield { type: 'text', delta: result.response };
    yield { type: 'final_text', content: result.response };
  }
  if (result.usage) {
    yield {
      type: 'usage',
      ...(result.usage.inputTokens !== undefined
        ? { inputTokens: result.usage.inputTokens }
        : {}),
      ...(result.usage.outputTokens !== undefined
        ? { outputTokens: result.usage.outputTokens }
        : {}),
      ...(result.usage.cacheReadTokens !== undefined
        ? { cachedInputTokens: result.usage.cacheReadTokens }
        : {}),
    };
  }
  yield {
    type: 'done',
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    terminationReason: 'normal',
  };
}

interface ParsedZcodeResult {
  sessionId?: string;
  response?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  };
}

/**
 * Extract the headless result object from stdout. `--json` prints one object,
 * but runtime warnings can interleave; try the whole output first, then scan
 * lines from the end for the payload.
 */
export function parseZcodeHeadlessResult(stdout: string): ParsedZcodeResult | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const whole = toZcodeResult(tryParseJson(trimmed));
  if (whole) return whole;
  const lines = trimmed.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line || !line.startsWith('{')) continue;
    const parsed = toZcodeResult(tryParseJson(line));
    if (parsed) return parsed;
  }
  return undefined;
}

function toZcodeResult(value: unknown): ParsedZcodeResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as ZcodeHeadlessResult;
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : undefined;
  const response = typeof raw.response === 'string' ? raw.response : undefined;
  if (!sessionId && response === undefined) return undefined;
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(usage
      ? {
          usage: {
            ...(typeof usage.inputTokens === 'number'
              ? { inputTokens: usage.inputTokens }
              : {}),
            ...(typeof usage.outputTokens === 'number'
              ? { outputTokens: usage.outputTokens }
              : {}),
            ...(typeof usage.cacheReadTokens === 'number'
              ? { cacheReadTokens: usage.cacheReadTokens }
              : {}),
          },
        }
      : {}),
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function zcodeFailureMessage(
  exitCode: number | null,
  stderr: string,
  runtimeError: Error | undefined,
): string {
  // stderr is provider-controlled text (API errors, stack traces). ZCode does
  // not print the configured API key on failure paths; keep the excerpt short
  // and strip the app-bundle path noise.
  const detail = stderr
    .trim()
    .replaceAll('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', 'zcode')
    .slice(0, 500);
  const base = runtimeError
    ? `zcode runtime error: ${runtimeError.message}`
    : `zcode exited with code ${String(exitCode)}`;
  return detail ? `${base}: ${detail}` : base;
}

async function terminateChild(child: ZcodeChild, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  log.info('agent', 'stop-sigterm', { agent: 'zcode', pid: child.pid ?? null, graceMs });
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        log.warn('agent', 'stop-sigkill', {
          agent: 'zcode',
          pid: child.pid ?? null,
          graceMs,
          reason: 'grace-period-expired',
        });
        child.kill('SIGKILL');
      }
      resolve();
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForExitCode(child: ZcodeChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function waitForExit(child: ZcodeChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function immediateFailureRun(runId: string, message: string): AgentRun {
  return {
    runId,
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'error', message, terminationReason: 'failed' };
    })(),
    stop: () => Promise.resolve(),
    waitForExit: () => Promise.resolve(true),
  };
}

/** Exported for tests: resolve the on-disk realpath for diagnostics. */
export function resolveZcodeRuntimeRealpath(runtimePath: string): string | undefined {
  try {
    return realpathSync(runtimePath);
  } catch {
    return undefined;
  }
}
