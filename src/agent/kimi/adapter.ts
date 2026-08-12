import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import pkg from '../../../package.json';
import type { AccessMode, CodexSandboxMode } from '../../config/permissions';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import {
  AgentPreflightError,
  checkAgentAvailability,
  type AgentAvailability,
  type AgentPreflightDiagnostic,
} from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { assertKimiBootstrapPathsSafe } from './bootstrap-guard';
import { KimiAcpEventTranslator } from './events';
import {
  prepareKimiProfileHome,
  type KimiConfigValidationLauncher,
} from './profile-home';
import { buildKimiLaunch, type KimiSeatbeltTestOverrides } from './seatbelt';
import { KimiWorkspaceFs } from './workspace-fs';

const KIMI_PILOT_CONSTRAINTS = `
## Kimi 只读试点约束

当前 Kimi bridge 只允许通过 Read 工具按已知路径读取工作区内的普通 UTF-8 文本，不能列目录，也不能使用 Glob/Grep。不要尝试附件、Shell、Git、rg、网络、写入、修改文件、调用 lark-cli 或其它工具；不要声称这些操作已经执行。若任务需要这些能力，请明确说明当前只读试点无法执行。
`.trim();

const KIMI_WORKSPACE_CONSTRAINTS = `
## Kimi 工作区权限约束

可以使用 Shell、Glob、Grep、Write 和 Edit 完成当前工作区内的开发任务。文件读写仅限当前工作区；不要尝试访问其它本地目录或 bridge profile 状态。
`.trim();

export const KIMI_SUPPORTED_VERSION = '0.29.2';
export const KIMI_RUNTIME_FAILURE_MESSAGE =
  '❌ Kimi 当前无法完成本次任务。请联系 bot 管理员确认隔离 profile 已完成登录且安全配置正常后重试。';
const KIMI_CANCEL_TIMEOUT_MS = 1_000;

export interface KimiAdapterOptions {
  binary?: string;
  defaultModel?: string;
  profileStateDir: string;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  /** Dependency overrides for deterministic Seatbelt tests. Production callers must omit. */
  seatbeltTestOverrides?: KimiSeatbeltTestOverrides;
}

type KimiChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

interface KimiCwdSnapshot {
  readonly dev: number;
  readonly ino: number;
}

export class KimiAdapter implements AgentAdapter {
  readonly id = 'kimi';
  readonly displayName = 'Kimi Code CLI';

  private readonly binary: string;
  private readonly defaultModel: string | undefined;
  private readonly profileStateDir: string;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly seatbeltTestOverrides: KimiSeatbeltTestOverrides | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: KimiAdapterOptions) {
    this.binary = opts.binary ?? 'kimi';
    this.defaultModel = opts.defaultModel?.trim() || undefined;
    this.profileStateDir = opts.profileStateDir;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5_000;
    this.larkChannel = opts.larkChannel;
    this.seatbeltTestOverrides = opts.seatbeltTestOverrides;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    const availability = await checkAgentAvailability({
      agentId: 'kimi',
      agentName: 'Kimi Code CLI',
      command: this.binary,
      binaryPath: this.binary,
      args: ['--version'],
    });
    if (!availability.ok || availability.version === KIMI_SUPPORTED_VERSION) {
      return availability;
    }
    const diagnostic: AgentPreflightDiagnostic = {
      code: 'agent-version-check-unsupported-version',
      agentId: 'kimi',
      agentName: 'Kimi Code CLI',
      command: this.binary,
      binaryPath: this.binary,
      args: ['--version'],
      expected: KIMI_SUPPORTED_VERSION,
      actual: availability.version ?? 'unknown',
    };
    return {
      ok: false,
      error: new AgentPreflightError(diagnostic),
      diagnostic,
    };
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'kimi binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for KimiAdapter.run');
    // RunPolicy stores a canonical cwd, but a submission can wait in the pool
    // before this synchronous spawn path runs. Refuse a deleted/repointed path
    // instead of silently granting the symlink's new target to Kimi.
    const cwdSnapshot = assertKimiCwdMatchesPolicy(opts.cwd);
    const accessMode = kimiAccessMode(opts.sandbox);
    const writable = accessMode !== 'read-only';

    const imageOutputDir = join(this.profileStateDir, 'images');
    mkdirSync(imageOutputDir, { recursive: true });
    const env = buildLarkChannelEnv(this.larkChannel);
    env.LARK_CHANNEL_IMAGE_DIR = imageOutputDir;
    const validationLauncher: KimiConfigValidationLauncher = (input) => {
      const validationEnv = buildKimiChildEnv(process.env, env, input.profileEnv);
      const launch = buildKimiLaunch({
        binary: input.binary,
        args: input.args,
        cwd: input.cwd,
        env: validationEnv,
        profileStateDir: this.profileStateDir,
        imageOutputDir,
        accessMode,
        purpose: 'config-validation',
        ...(this.seatbeltTestOverrides
          ? { testOverrides: this.seatbeltTestOverrides }
          : {}),
      });
      return {
        command: launch.command,
        args: launch.args,
        cwd: input.cwd,
        env: validationEnv,
      };
    };
    const kimiProfile = prepareKimiProfileHome(this.binary, this.profileStateDir, {
      accessMode,
      shell: process.env.SHELL,
      validationLauncher,
    });
    if (accessMode === 'read-only') {
      assertKimiBootstrapPathsSafe({
        cwd: opts.cwd,
        kimiHome: kimiProfile.homeDir,
        osHome: this.seatbeltTestOverrides?.osHomeDir ?? userInfo().homedir,
      });
    }
    const childEnv = buildKimiChildEnv(process.env, env, kimiProfile.env);
    const workspaceFs = new KimiWorkspaceFs({
      cwd: opts.cwd,
      deniedRoots: [this.profileStateDir],
      writable,
      unrestricted: accessMode === 'full',
    });
    const launch = buildKimiLaunch({
      binary: this.binary,
      args: ['acp'],
      cwd: opts.cwd,
      env: childEnv,
      profileStateDir: this.profileStateDir,
      imageOutputDir,
      accessMode,
      ...(this.seatbeltTestOverrides
        ? { testOverrides: this.seatbeltTestOverrides }
        : {}),
    });

    // Profile preparation and launch construction above are synchronous but
    // may execute validation helpers. Recheck at the last possible point and
    // also detect replacement by a different directory at the same pathname.
    assertKimiCwdMatchesPolicy(opts.cwd, cwdSnapshot);
    const child = spawnProcess(launch.command, launch.args, {
      // Kimi 0.29.2's LocalKaos.create() probes process.cwd() before the ACP
      // session exists. Starting inside the profile-local home keeps that
      // bootstrap probe away from workspace directory data; the real workspace
      // is still passed explicitly to session/new below.
      cwd: kimiProfile.homeDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as KimiChild;
    const queue = new AgentEventQueue();
    const translator = new KimiAcpEventTranslator({ cwd: opts.cwd, accessMode });
    let runtimeError: Error | undefined;
    let currentSessionId: string | undefined;
    let acceptingUpdates = false;
    let updateSessionMismatch = false;
    let stopping = false;
    let terminalEmitted = false;
    let stopPromise: Promise<void> | undefined;
    let driveStage = 'initialize';
    const selectedModel = opts.model ?? this.defaultModel;

    log.info('agent', 'spawn', {
      agent: 'kimi',
      pid: child.pid ?? null,
      cwd: opts.cwd,
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      hasModel: Boolean(selectedModel),
      accessMode,
      seatbelt: launch.seatbeltProfile !== undefined,
    });

    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { agent: 'kimi', pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', () => {
      // Stream errors can contain local paths or provider-controlled payloads.
      // Keep Kimi diagnostics categorical because /doctor can surface logs.
      log.warn('agent', 'stdin-error', { agent: 'kimi' });
    });
    logStderr(child.stderr);

    const releaseAcpConsoleRedactor = installKimiAcpConsoleRedactor();
    let acpStream: ReturnType<typeof ndJsonStream>;
    try {
      acpStream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
    } catch (err) {
      releaseAcpConsoleRedactor();
      throw err;
    }
    const client: Client = {
      requestPermission(
        request: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        return protectKimiAcpCallback(() => {
          if (stopping) return { outcome: { outcome: 'cancelled' } };
          if (writable) {
            const allow =
              request.options.find((option) => option.kind === 'allow_once') ??
              request.options.find((option) => option.kind === 'allow_always');
            log.info('agent', 'permission-approved', {
              agent: 'kimi',
              hasAllowOption: allow !== undefined,
              accessMode,
            });
            return allow
              ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
              : { outcome: { outcome: 'cancelled' } };
          }
          const reject = request.options.find(
            (option) => option.kind === 'reject_once' || option.kind === 'reject_always',
          );
          log.warn('agent', 'permission-denied', {
            agent: 'kimi',
            hasRejectOption: reject !== undefined,
          });
          return reject
            ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
            : { outcome: { outcome: 'cancelled' } };
        });
      },
      sessionUpdate(notification: SessionNotification): Promise<void> {
        return protectKimiAcpCallback(() => {
          // session/load replays history before returning. The bridge already owns
          // its transcript, so suppress setup-time notifications and only stream
          // updates produced by the prompt for this run.
          if (!acceptingUpdates) return;
          if (!currentSessionId || notification.sessionId !== currentSessionId) {
            updateSessionMismatch = true;
            acceptingUpdates = false;
            log.warn('agent', 'session-update-mismatch', { agent: 'kimi' });
            return;
          }
          for (const event of translator.translate(notification)) queue.push(event);
        });
      },
      readTextFile: (request) =>
        protectKimiAcpCallback(() => workspaceFs.readTextFile(request)),
      writeTextFile: (request) =>
        protectKimiAcpCallback(() => workspaceFs.writeTextFile(request)),
    };
    let connection: ClientSideConnection;
    try {
      connection = new ClientSideConnection(() => client, acpStream);
    } catch (err) {
      releaseAcpConsoleRedactor();
      throw err;
    }
    void connection.closed.then(
      () => releaseKimiAcpConsoleRedactorAfterTurn(releaseAcpConsoleRedactor),
      () => releaseKimiAcpConsoleRedactorAfterTurn(releaseAcpConsoleRedactor),
    );

    const emitTerminal = (event: AgentEvent): void => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      queue.push(event);
    };

    const drive = async (): Promise<void> => {
      try {
        driveStage = 'initialize';
        const initialized = await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: writable },
            terminal: false,
          },
          clientInfo: {
            name: pkg.name,
            title: 'Lark Channel Bridge',
            version: pkg.version,
          },
        });

        if (opts.sessionId) {
          driveStage = 'session-resume';
          workspaceFs.bindSessionId(opts.sessionId);
          if (initialized.agentCapabilities?.sessionCapabilities?.resume != null) {
            await connection.resumeSession({
              sessionId: opts.sessionId,
              cwd: opts.cwd!,
              mcpServers: [],
            });
          } else if (initialized.agentCapabilities?.loadSession === true) {
            await connection.loadSession({
              sessionId: opts.sessionId,
              cwd: opts.cwd!,
              mcpServers: [],
            });
          } else {
            throw new Error('Kimi ACP agent does not support session resume or load');
          }
          currentSessionId = opts.sessionId;
        } else {
          driveStage = 'session-new';
          const created = await connection.newSession({ cwd: opts.cwd!, mcpServers: [] });
          workspaceFs.bindSessionId(created.sessionId);
          currentSessionId = created.sessionId;
        }

        if (selectedModel) {
          driveStage = 'session-set-model';
          try {
            await connection.unstable_setSessionModel({
              sessionId: currentSessionId,
              modelId: selectedModel,
            });
          } catch (err) {
            throw new Error(
              `Kimi ACP could not select model "${selectedModel}": ${errorMessage(err)}`,
              { cause: err },
            );
          }
        }

        // Kimi 0.29.2 plan mode instructs the model to maintain a plan file,
        // which conflicts with this pilot's deny-all-writes boundary and can
        // loop after a successful Read. Require the explicit default/manual
        // mode before prompting instead: the profile's deny rules, reverse-ACP
        // write rejection, and Seatbelt remain the independent write barriers.
        // Fail closed when an older/incompatible ACP server cannot apply it.
        driveStage = 'session-set-mode';
        const sessionMode = writable ? 'yolo' : 'default';
        try {
          await connection.setSessionMode({ sessionId: currentSessionId, modeId: sessionMode });
        } catch (err) {
          throw new Error(
            `Kimi ACP could not enable required ${sessionMode} mode: ${errorMessage(err)}`,
            { cause: err },
          );
        }

        // Only publish/persist the Kimi session after its mandatory safety
        // mode has been applied successfully.
        queue.push({ type: 'system', sessionId: currentSessionId });
        acceptingUpdates = true;
        driveStage = 'session-prompt';
        const result = await connection.prompt({
          sessionId: currentSessionId,
          prompt: [
            {
              type: 'text',
              text: kimiPrompt(opts.prompt, this.botIdentity, accessMode),
            },
          ],
        });
        acceptingUpdates = false;
        if (updateSessionMismatch) {
          throw new Error('Kimi ACP emitted an update for a different session');
        }
        for (const event of translator.flushAnswer()) queue.push(event);
        for (const event of translator.usage(result.usage)) queue.push(event);
        emitTerminal({
          type: 'done',
          sessionId: currentSessionId,
          terminationReason: result.stopReason === 'cancelled' ? 'interrupted' : 'normal',
        });
      } catch (err) {
        if (stopping) {
          emitTerminal({
            type: 'done',
            sessionId: currentSessionId,
            terminationReason: 'interrupted',
          });
        } else {
          // ACP errors and process failures may carry arbitrary provider text,
          // prompts, credentials, or host paths. Never persist the Error.
          log.warn('agent', 'acp-drive-failed', {
            agent: 'kimi',
            reason: runtimeError ? 'process-error' : 'protocol-error',
            stage: driveStage,
            ...(findKimiRequestError(err) ? { code: findKimiRequestError(err)!.code } : {}),
            category: kimiProtocolFailureCategory(err),
            location: kimiProtocolFailureLocation(err, {
              cwd: opts.cwd!,
              profileStateDir: this.profileStateDir,
              binaryDir: dirname(this.binary),
              osHome: this.seatbeltTestOverrides?.osHomeDir ?? userInfo().homedir,
            }),
            executable: kimiProtocolFailureExecutable(err),
            operation: kimiProtocolFailureOperation(err),
          });
          emitTerminal({
            type: 'error',
            message: KIMI_RUNTIME_FAILURE_MESSAGE,
            terminationReason: 'failed',
          });
        }
      } finally {
        acceptingUpdates = false;
        queue.close();
        if (child.exitCode === null && child.signalCode === null && !child.stdin.destroyed) {
          child.stdin.end();
        }
      }
    };
    void drive();

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    return {
      runId: opts.runId,
      pid: child.pid,
      events: queue,
      stop(): Promise<void> {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          stopping = true;
          if (
            currentSessionId &&
            child.exitCode === null &&
            child.signalCode === null &&
            !connection.signal.aborted
          ) {
            const cancelOutcome = await settleWithTimeout(
              connection.cancel({ sessionId: currentSessionId }),
              Math.min(KIMI_CANCEL_TIMEOUT_MS, Math.max(1, stopGraceMs)),
            );
            if (cancelOutcome.status === 'rejected') {
              log.warn('agent', 'cancel-failed', {
                agent: 'kimi',
                reason: 'notification-rejected',
              });
            } else if (cancelOutcome.status === 'timeout') {
              log.warn('agent', 'cancel-timeout', {
                agent: 'kimi',
                timeoutMs: Math.min(KIMI_CANCEL_TIMEOUT_MS, Math.max(1, stopGraceMs)),
              });
            }
          }
          await terminateChild(child, stopGraceMs);
        })();
        return stopPromise;
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return waitForExit(child, timeoutMs);
      },
    };
  }
}

function assertKimiCwdMatchesPolicy(
  expectedCanonicalCwd: string,
  expectedSnapshot?: KimiCwdSnapshot,
): KimiCwdSnapshot {
  try {
    const resolvedBeforeStat = realpathSync(expectedCanonicalCwd);
    const info = statSync(expectedCanonicalCwd);
    const resolvedAfterStat = realpathSync(expectedCanonicalCwd);
    if (
      resolvedBeforeStat !== expectedCanonicalCwd ||
      resolvedAfterStat !== expectedCanonicalCwd ||
      !info.isDirectory() ||
      (expectedSnapshot !== undefined &&
        (info.dev !== expectedSnapshot.dev || info.ino !== expectedSnapshot.ino))
    ) {
      throw new Error('Kimi cwd no longer matches the authorized policy snapshot');
    }
    return { dev: info.dev, ino: info.ino };
  } catch (err) {
    throw new SpawnFailed('kimi workspace changed before spawn', err);
  }
}

function kimiAccessMode(sandbox: CodexSandboxMode | undefined): AccessMode {
  switch (sandbox ?? 'read-only') {
    case 'read-only':
      return 'read-only';
    case 'workspace-write':
      return 'workspace';
    case 'danger-full-access':
      return 'full';
  }
}

function kimiPrompt(
  prompt: string,
  botIdentity: AgentBotIdentity | undefined,
  accessMode: AccessMode,
): string {
  const bridgePrompt = prefixBridgeSystemPrompt(prompt, botIdentity);
  if (accessMode === 'read-only') return `${bridgePrompt}\n\n${KIMI_PILOT_CONSTRAINTS}`;
  if (accessMode === 'workspace') return `${bridgePrompt}\n\n${KIMI_WORKSPACE_CONSTRAINTS}`;
  return bridgePrompt;
}

/**
 * Kimi is remotely reachable by organization members, so it must not inherit
 * arbitrary host credentials (OPENAI_API_KEY, AWS_*, npm tokens, etc.). Keep
 * only executable lookup and locale from the host, then merge the exact
 * bridge-bound context and profile-local Kimi environment assembled here.
 */
export function buildKimiChildEnv(
  inherited: NodeJS.ProcessEnv,
  bridge: NodeJS.ProcessEnv,
  profile: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && isAllowedInheritedKimiEnv(key)) allowed[key] = value;
  }
  return mergeProcessEnv(mergeProcessEnv(allowed, bridge), profile);
}

function isAllowedInheritedKimiEnv(key: string): boolean {
  return (
    key === 'PATH' ||
    key === 'LANG' ||
    key === 'LANGUAGE' ||
    key.startsWith('LC_')
  );
}

class AgentEventQueue implements AsyncIterable<AgentEvent> {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.values.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: (): Promise<IteratorResult<AgentEvent>> => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function logStderr(stderr: Readable): void {
  let reported = false;
  stderr.on('data', (chunk: Buffer) => {
    if (reported || chunk.length === 0) return;
    reported = true;
    // Kimi stderr is provider-controlled and can contain prompts, arbitrary
    // host paths, or credential material. Record only that diagnostics were
    // emitted; never buffer or persist their content.
    log.warn('agent', 'stderr', { agent: 'kimi', line: '[redacted]' });
  });
}

async function terminateChild(child: KimiChild, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  log.info('agent', 'stop-sigterm', { agent: 'kimi', pid: child.pid ?? null, graceMs });
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        log.warn('agent', 'stop-sigkill', {
          agent: 'kimi',
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

function waitForExit(child: KimiChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function kimiProtocolFailureCategory(err: unknown): string {
  const normalized = kimiProtocolFailureText(err).toLowerCase();
  if (/authentication|unauthorized|not logged in|login required|credential/u.test(normalized)) {
    return 'authentication';
  }
  if (/\bspawn\b|child[_ -]?process|process-exec|execfile/u.test(normalized)) {
    return 'process-exec';
  }
  if (/sandbox|seatbelt|operation not permitted|\beperm\b|\beacces\b/u.test(normalized)) {
    return 'filesystem-permission';
  }
  if (/\benoent\b|no such file|file not found|directory not found/u.test(normalized)) {
    return 'filesystem-missing';
  }
  if (/network|socket|\bdns\b|\benotfound\b|\beconn/u.test(normalized)) {
    return 'network';
  }
  if (/config|toml|workspace|working directory|\bcwd\b/u.test(normalized)) {
    return 'configuration';
  }
  if (/invalid|parse|schema|validation/u.test(normalized)) return 'protocol-validation';
  if (/method not found|not supported|unsupported/u.test(normalized)) return 'protocol-unsupported';
  if (/session mode|plan mode|mode id/u.test(normalized)) return 'session-mode';
  if (/connection.*closed|stream.*closed|\beof\b|\babort(?:ed)?\b/u.test(normalized)) {
    return 'transport-closed';
  }
  return 'unclassified';
}

function kimiProtocolFailureLocation(
  err: unknown,
  paths: { cwd: string; profileStateDir: string; binaryDir: string; osHome: string },
): string {
  const details = kimiProtocolFailureText(err);
  if (details.includes(paths.cwd)) return 'workspace';
  if (details.includes(paths.profileStateDir)) return 'profile';
  if (details.includes(paths.binaryDir)) return 'binary';
  if (details.includes(paths.osHome)) return 'home-other';
  if (/\/(?:private\/)?tmp\//u.test(details)) return 'temporary';
  if (/\/(?:Applications|Library|System|usr|bin|sbin|opt)\//u.test(details)) return 'system';
  return 'unclassified';
}

function kimiProtocolFailureExecutable(err: unknown): string {
  const details = kimiProtocolFailureText(err).toLowerCase();
  if (/(?:^|[\s/"'])git(?:$|[\s/"'])/u.test(details)) return 'git';
  if (/(?:^|[\s/"'])(?:bash|zsh|sh)(?:$|[\s/"'])/u.test(details)) return 'shell';
  if (/(?:^|[\s/"'])rg(?:$|[\s/"'])/u.test(details)) return 'ripgrep';
  if (/(?:^|[\s/"'])security(?:$|[\s/"'])/u.test(details)) return 'keychain';
  if (/(?:^|[\s/"'])sw_vers(?:$|[\s/"'])/u.test(details)) return 'os-version';
  if (/(?:^|[\s/"'])env(?:$|[\s/"'])/u.test(details)) return 'environment';
  if (/(?:^|[\s/"'])false(?:$|[\s/"'])/u.test(details)) return 'no-op';
  if (/(?:^|[\s/"'])node(?:$|[\s/"'])/u.test(details)) return 'node';
  if (/(?:^|[\s/"'])python(?:3)?(?:$|[\s/"'])/u.test(details)) return 'python';
  return 'unclassified';
}

function kimiProtocolFailureOperation(err: unknown): string {
  const details = kimiProtocolFailureText(err).toLowerCase();
  if (/\bscandir\b|\breaddir\b|\biterdir\b/u.test(details)) return 'directory-read';
  if (/\breadfile\b|\breadtext\b|\bfile-read-data\b/u.test(details)) return 'file-read';
  if (/\blstat\b|\bfstat\b|\bstat\b|\baccess\b|\brealpath\b/u.test(details)) {
    return 'metadata-read';
  }
  if (/\bmkdir\b|\bwritefile\b|\bappendfile\b|\bfile-write\b/u.test(details)) {
    return 'file-write';
  }
  if (/\brename\b|\bunlink\b|\brmdir\b|\brm\b/u.test(details)) return 'filesystem-mutation';
  if (/\bspawn\b|\bexecfile\b|\bprocess-exec\b/u.test(details)) return 'process-exec';
  if (/\bconnect\b|\bsocket\b|\bdns\b/u.test(details)) return 'network';
  return 'unclassified';
}

function kimiProtocolFailureText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    parts.push(errorMessage(current));
    if (current instanceof RequestError && current.data !== undefined) {
      try {
        parts.push(JSON.stringify(current.data));
      } catch {
        // Keep the already collected categorical source text.
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' ').slice(0, 64 * 1024);
}

function findKimiRequestError(err: unknown): RequestError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    if (current instanceof RequestError) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

const ACP_SDK_CONSOLE_MESSAGES = new Set([
  'Error handling request',
  'Error handling notification',
  'Failed to parse JSON message:',
  'Got response to unknown request',
  'Invalid message',
  'Unexpected error during message processing:',
]);
let acpConsoleRedactorUsers = 0;
let acpOriginalConsoleError: typeof console.error | undefined;
let acpInstalledConsoleError: typeof console.error | undefined;

/**
 * ACP SDK 0.23.0 writes rejected request objects directly to console.error,
 * including reverse-FS paths, session IDs, and attempted write contents.
 * Install one process-wide, reference-counted wrapper while any Kimi ACP
 * connection is alive. Only the SDK's fixed log signatures are transformed;
 * unrelated application logs retain their normal behavior.
 */
function installKimiAcpConsoleRedactor(): () => void {
  if (acpConsoleRedactorUsers === 0) {
    const original = console.error;
    const installed = (...args: unknown[]): void => {
      const sdkMessage = args[0];
      if (typeof sdkMessage === 'string' && ACP_SDK_CONSOLE_MESSAGES.has(sdkMessage)) {
        // The SDK includes entire untrusted JSON-RPC messages in these error
        // logs. Do not attempt field-by-field filtering: unknown methods and
        // malformed JSON can carry secrets under arbitrary keys or syntax.
        original.call(console, sdkMessage, '[redacted]');
      } else {
        original.apply(console, args);
      }
    };
    acpOriginalConsoleError = original;
    acpInstalledConsoleError = installed;
    console.error = installed;
  }
  acpConsoleRedactorUsers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    acpConsoleRedactorUsers = Math.max(0, acpConsoleRedactorUsers - 1);
    if (acpConsoleRedactorUsers !== 0 || !acpOriginalConsoleError) return;
    if (console.error === acpInstalledConsoleError) console.error = acpOriginalConsoleError;
    acpOriginalConsoleError = undefined;
    acpInstalledConsoleError = undefined;
  };
}

async function protectKimiAcpCallback<T>(callback: () => T | Promise<T>): Promise<T> {
  const release = installKimiAcpConsoleRedactor();
  try {
    return await callback();
  } finally {
    releaseKimiAcpConsoleRedactorAfterTurn(release);
  }
}

function releaseKimiAcpConsoleRedactorAfterTurn(release: () => void): void {
  setImmediate(release);
}

type TimedOutcome =
  | { status: 'fulfilled' }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout' };

async function settleWithTimeout(task: Promise<unknown>, timeoutMs: number): Promise<TimedOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });
  const settled = task.then<TimedOutcome, TimedOutcome>(
    () => ({ status: 'fulfilled' }),
    (error: unknown) => ({ status: 'rejected', error }),
  );
  const outcome = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return outcome;
}
