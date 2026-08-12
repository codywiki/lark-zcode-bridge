import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun } from '../../../src/agent/types.js';
import type { RunHandle } from '../../../src/bot/active-runs.js';
import { processAgentStream } from '../../../src/bot/channel.js';
import { renderText } from '../../../src/card/text-renderer.js';

describe('agent stream live status', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows an accepted status before a silent agent emits its first event', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const events = silentUntil(gate.promise);
    const handle = runHandle(events);
    const rendered: string[] = [];

    const statePromise = processAgentStream(
      handle,
      events,
      'scope-live-status',
      undefined,
      () => {},
      async (state) => {
        rendered.push(renderText(state));
      },
      { liveStatus: { initialDelayMs: 2_000, intervalMs: 60_000 } },
    );

    try {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(rendered).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(rendered.at(-1)).toBe('_⏱ 已受理，任务正在运行_\n\n_🧠 正在思考…_');
    } finally {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await statePromise;
    }
  });

  it('refreshes elapsed time while an agent remains silent', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const events = silentUntil(gate.promise);
    const handle = runHandle(events);
    const rendered: string[] = [];

    const statePromise = processAgentStream(
      handle,
      events,
      'scope-live-heartbeat',
      undefined,
      () => {},
      async (state) => {
        rendered.push(renderText(state));
      },
      { liveStatus: { initialDelayMs: 2_000, intervalMs: 60_000 } },
    );

    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rendered).toHaveLength(2);
      expect(rendered.at(-1)).toBe(
        '_⏱ 已运行 1 分钟 · 最近活动 1 分钟前_\n\n_🧠 正在思考…_',
      );
    } finally {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await statePromise;
    }
  });

  it('rejects promptly when a live-status flush fails while the next event is blocked', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const events = silentUntil(gate.promise);
    const handle = runHandle(events);
    const flushError = new Error('status delivery failed');
    const statePromise = processAgentStream(
      handle,
      events,
      'scope-live-status-failure',
      undefined,
      () => {},
      async () => {
        throw flushError;
      },
      { liveStatus: { initialDelayMs: 2_000, intervalMs: 60_000 } },
    );
    const resultPromise = statePromise.then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    try {
      await vi.advanceTimersByTimeAsync(2_000);
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 1);
      });
      const result = Promise.race([resultPromise, timeout]);
      await vi.advanceTimersByTimeAsync(1);

      expect(await result).toBe(flushError);
    } finally {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await statePromise.catch(() => {});
    }
  });

  it('emits a due live status even when non-visible events are continuously ready', async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const events = immediatelyReadyProgressEvents(() => {
      now += 1_000;
    });
    const handle = runHandle(events);
    const liveStates: number[] = [];

    await processAgentStream(
      handle,
      events,
      'scope-live-status-ready-events',
      undefined,
      () => {},
      async (state) => {
        if (state.liveStatus) liveStates.push(state.liveStatus.elapsedSeconds);
      },
      { liveStatus: { initialDelayMs: 2_000, intervalMs: 60_000 } },
    );

    expect(liveStates).toContain(2);
  });

  it('flushes a terminal state only once after showing accepted liveness', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const events = silentUntil(gate.promise);
    const handle = runHandle(events);
    const terminals: string[] = [];
    const statePromise = processAgentStream(
      handle,
      events,
      'scope-live-status-terminal',
      undefined,
      () => {},
      async (state) => {
        if (state.terminal !== 'running') terminals.push(state.terminal);
      },
      { liveStatus: { initialDelayMs: 2_000, intervalMs: 60_000 } },
    );

    await vi.advanceTimersByTimeAsync(2_000);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await statePromise;

    expect(terminals).toEqual(['done']);
  });
});

function immediatelyReadyProgressEvents(onNext: () => void): AsyncIterable<AgentEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          onNext();
          index += 1;
          if (index <= 3) return { done: false, value: { type: 'progress' } };
          return { done: false, value: { type: 'done', terminationReason: 'normal' } };
        },
        async return(): Promise<IteratorResult<AgentEvent>> {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function silentUntil(gate: Promise<void>): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      await gate;
      yield { type: 'done', terminationReason: 'normal' };
    },
  };
}

function runHandle(events: AsyncIterable<AgentEvent>): RunHandle {
  const run: AgentRun = {
    runId: 'run-live-status',
    events,
    async stop() {},
    async waitForExit() {
      return true;
    },
  };
  return {
    run,
    interrupted: false,
    async requestStop() {},
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
