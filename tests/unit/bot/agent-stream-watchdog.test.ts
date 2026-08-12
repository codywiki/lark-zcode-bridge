import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun } from '../../../src/agent/types.js';
import type { RunHandle, RunStopReason } from '../../../src/bot/active-runs.js';
import { processAgentStream } from '../../../src/bot/channel.js';

describe('agent stream watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out an unmatched tool call instead of disabling the watchdog forever', async () => {
    vi.useFakeTimers();
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const events: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        yield {
          type: 'tool_use',
          id: 'tool-hung',
          name: 'command_execution',
          input: { command: 'long-running-command' },
        };
        await toolGate;
        yield { type: 'done', terminationReason: 'timeout' };
      },
    };
    const run: AgentRun = {
      runId: 'run-hung-tool',
      events,
      async stop() {},
      async waitForExit() {
        return true;
      },
    };
    let stopPromise: Promise<void> | undefined;
    const requestStop = vi.fn((reason: RunStopReason = 'interrupted') => {
      if (!stopPromise) {
        handle.interrupted = true;
        releaseTool();
        stopPromise = Promise.resolve();
      }
      return stopPromise;
    });
    const handle: RunHandle = {
      run,
      interrupted: false,
      requestStop,
    };

    const statePromise = processAgentStream(
      handle,
      events,
      'scope-hung-tool',
      60_000,
      () => {},
      async () => {},
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    const state = await statePromise;
    expect(requestStop).toHaveBeenCalledWith('timeout');
    expect(state.terminal).toBe('idle_timeout');
    expect(state.idleTimeoutMinutes).toBe(1);
  });

  it('bases the 20-minute watchdog on real agent events instead of live-status flushes', async () => {
    vi.useFakeTimers();
    const activity = deferred<void>();
    const stopped = deferred<void>();
    const events: AsyncIterable<AgentEvent> = {
      async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        await activity.promise;
        yield { type: 'progress' };
        await stopped.promise;
        yield { type: 'done', terminationReason: 'timeout' };
      },
    };
    const run: AgentRun = {
      runId: 'run-live-status-watchdog',
      events,
      async stop() {},
      async waitForExit() {
        return true;
      },
    };
    const requestStop = vi.fn(async (_reason: RunStopReason = 'interrupted') => {
      handle.interrupted = true;
      stopped.resolve();
    });
    const handle: RunHandle = {
      run,
      interrupted: false,
      requestStop,
    };
    let liveStatusFlushes = 0;
    const timeoutFlushes: Array<number | undefined> = [];
    const statePromise = processAgentStream(
      handle,
      events,
      'scope-live-status-watchdog',
      20 * 60_000,
      () => {},
      async (state) => {
        if (state.liveStatus) liveStatusFlushes += 1;
        if (state.terminal === 'idle_timeout') {
          timeoutFlushes.push(state.idleTimeoutMinutes);
        }
      },
      { liveStatus: { initialDelayMs: 2_000, intervalMs: 60_000 } },
    );

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(liveStatusFlushes).toBeGreaterThan(0);
    expect(requestStop).not.toHaveBeenCalled();

    activity.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
    expect(requestStop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const state = await statePromise;
    expect(requestStop).toHaveBeenCalledWith('timeout');
    expect(state.terminal).toBe('idle_timeout');
    expect(state.idleTimeoutMinutes).toBe(20);
    expect(timeoutFlushes).toEqual([20]);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
