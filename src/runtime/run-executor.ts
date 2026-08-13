import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun } from '../agent/types';
import { ActiveRuns, type RunHandle, type RunStopReason } from '../bot/active-runs';
import { ProcessPool, ProcessPoolAcquireAborted } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';
import { trackChild, untrackChild } from './orphan-reaper';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  /** Per-profile state dir used to persist in-flight child pids for orphan reaping. */
  profileStateDir?: string;
}

export interface SubmitRunInput {
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: string;
  images?: readonly string[];
  stopGraceMs?: number;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;
  private readonly profileStateDir?: string;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
    this.profileStateDir = deps.profileStateDir;
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const stopBeforeStart = new AbortController();
    const releaseScope = this.activeRuns.reserve(input.scopeId, () => stopBeforeStart.abort());
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    let release: (() => void) | undefined;
    try {
      release = input.nowait
        ? this.pool.tryAcquire()
        : await this.pool.acquire(stopBeforeStart.signal);
    } catch (err) {
      releaseScope();
      if (err instanceof ProcessPoolAcquireAborted || stopBeforeStart.signal.aborted) {
        throw new RunRejected('run-interrupted', 'run was stopped before it started');
      }
      throw err;
    }
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (stopBeforeStart.signal.aborted) {
      release();
      releaseScope();
      throw new RunRejected('run-interrupted', 'run was stopped before it started');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      images: input.images,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    let run: AgentRun;
    try {
      await this.agent.prepareRun?.(runOptions);
    } catch (err) {
      release();
      releaseScope();
      if (stopBeforeStart.signal.aborted) {
        throw new RunRejected('run-interrupted', 'run was stopped before it started');
      }
      if (err instanceof SpawnFailed) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (stopBeforeStart.signal.aborted) {
      release();
      releaseScope();
      throw new RunRejected('run-interrupted', 'run was stopped before it started');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      release();
      releaseScope();
      throw new SpawnFailed('agent spawn failed', err);
    }
    // Persist the child's pid so a future bridge instance can reap it if this
    // one dies ungracefully (SIGKILL / crash) before stopAll() runs.
    if (this.profileStateDir && typeof run.pid === 'number') {
      trackChild(this.profileStateDir, {
        runId,
        scopeId: input.scopeId,
        pid: run.pid,
        bridgePid: process.pid,
        agentKind: this.agent.id,
        startedAt: new Date(this.now()).toISOString(),
      });
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let requestStopImpl = async (_reason: RunStopReason = 'interrupted'): Promise<void> => {
      await run.stop();
    };
    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(
        input.scopeId,
        run,
        (reason) => requestStopImpl(reason),
      );
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    let cleaned = false;
    const cleanup = async (waitForExit: boolean): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      this.activeRuns.unregister(input.scopeId, run);
      if (this.profileStateDir && typeof run.pid === 'number') {
        untrackChild(this.profileStateDir, run.pid);
      }
      release();
      if (waitForExit) {
        try {
          const exited = await run.waitForExit(this.postDoneExitGraceMs);
          if (!exited) {
            log.warn('run', 'post-done-exit-timeout', {
              ...dimensions,
              graceMs: this.postDoneExitGraceMs,
            });
            await run.stop().catch((err) => {
              log.warn('run', 'post-done-stop-failed', {
                ...dimensions,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          }
        } catch (err) {
          log.warn('run', 'post-done-wait-failed', {
            ...dimensions,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };
    let terminalLogged = false;
    const recordTerminal = (event: AgentEvent): void => {
      if (terminalLogged || !isTerminalEvent(event)) return;
      terminalLogged = true;
      if (event.type === 'done') {
        log.info('run', 'completed', {
          ...dimensions,
          result: event.terminationReason,
          durationMs: this.now() - startedAt,
        });
      } else {
        log.warn('run', 'failed', {
          ...dimensions,
          result: event.terminationReason,
          durationMs: this.now() - startedAt,
          error: event.message,
        });
      }
    };
    const fanout = new EventFanout(
      run.events,
      async () => {
        await cleanup(!handle.interrupted);
      },
      recordTerminal,
    );
    let stopPromise: Promise<void> | undefined;
    const requestStop = (reason: RunStopReason = 'interrupted'): Promise<void> => {
      if (stopPromise) return stopPromise;
      handle.interrupted = true;
      fanout.terminate({ type: 'done', terminationReason: reason });
      stopPromise = (async () => {
        try {
          await run.stop();
          const exited = await run.waitForExit(this.postDoneExitGraceMs);
          if (!exited) {
            log.warn('run', 'stop-exit-timeout', {
              ...dimensions,
              graceMs: this.postDoneExitGraceMs,
            });
          }
        } catch (err) {
          log.warn('run', 'stop-failed', {
            ...dimensions,
            err: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await cleanup(false);
        }
      })();
      return stopPromise;
    };
    requestStopImpl = requestStop;

    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: () => requestStop('interrupted'),
    };
  }
}

type TerminalAgentEvent = Extract<AgentEvent, { type: 'done' | 'error' }>;

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly onTerminal: (event: AgentEvent) => void;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private terminal = false;

  constructor(
    source: AsyncIterable<AgentEvent>,
    onDone: () => Promise<void>,
    onTerminal: (event: AgentEvent) => void,
  ) {
    this.source = source;
    this.onDone = onDone;
    this.onTerminal = onTerminal;
  }

  terminate(event: TerminalAgentEvent): boolean {
    if (this.terminal) return false;
    this.publishTerminal(event);
    return true;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private start(): void {
    if (this.started || this.done) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        if (this.terminal) break;
        if (isTerminalEvent(event)) {
          this.publishTerminal(event);
          break;
        }
        this.buffer.push(event);
        this.wakeAll();
      }
      if (!this.terminal) {
        this.publishTerminal({
          type: 'error',
          message: 'agent event stream ended before a terminal event',
          terminationReason: 'failed',
        });
      }
    } catch (err) {
      if (!this.terminal) {
        const detail = err instanceof Error ? `: ${err.message}` : '';
        this.publishTerminal({
          type: 'error',
          message: `agent event stream failed${detail}`,
          terminationReason: 'failed',
        });
      }
    } finally {
      try {
        await this.onDone();
      } catch (err) {
        log.warn('run', 'cleanup-failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      this.done = true;
      this.wakeAll();
    }
  }

  private publishTerminal(event: TerminalAgentEvent): void {
    if (this.terminal) return;
    this.terminal = true;
    this.done = true;
    this.buffer.push(event);
    this.onTerminal(event);
    this.wakeAll();
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): event is TerminalAgentEvent {
  return event.type === 'done' || event.type === 'error';
}
