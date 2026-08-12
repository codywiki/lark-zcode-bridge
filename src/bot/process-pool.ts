import { log, reportMetric } from '../core/logger';

export class ProcessPoolAcquireAborted extends Error {
  constructor() {
    super('process pool acquire aborted');
    this.name = 'ProcessPoolAcquireAborted';
  }
}

interface PoolWaiter {
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
}

/**
 * FIFO concurrency cap for claude runs. Especially useful in topic-group
 * scenarios where each topic spawns its own run — without a cap, a single
 * busy group could trivially explode to dozens of concurrent claude
 * subprocesses, drowning RAM and Anthropic API rate limit.
 *
 * Use:
 *   const pool = new ProcessPool();
 *   const release = await pool.acquire();
 *   try { ... } finally { release(); }
 *
 * The cap is read fresh each `acquire()`, so `/config maxConcurrentRuns`
 * takes effect for the next run that asks for a slot.
 */
export class ProcessPool {
  private active = 0;
  private readonly waiters: PoolWaiter[] = [];
  /** Snapshot of the cap captured at the moment acquire() decided to wait. */
  private cap: () => number;

  constructor(cap: () => number) {
    this.cap = cap;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new ProcessPoolAcquireAborted();
    if (this.active < this.cap()) {
      this.active++;
      log.info('pool', 'acquired', { active: this.active, cap: this.cap() });
      reportMetric('pool_active', this.active);
      return this.createRelease();
    }
    log.info('pool', 'wait', { active: this.active, cap: this.cap(), waiting: this.waiters.length + 1 });
    reportMetric('pool_waiting', this.waiters.length + 1);
    return new Promise<() => void>((resolve, reject) => {
      const waiter: PoolWaiter = {
        settled: false,
        ...(signal ? { signal } : {}),
        resolve,
        reject,
      };
      if (signal) {
        waiter.onAbort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort!);
          reportMetric('pool_waiting', this.waiters.length);
          reject(new ProcessPoolAcquireAborted());
          this.drainWaiters();
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.cap()) {
      log.info('pool', 'full', { active: this.active, cap: this.cap() });
      return undefined;
    }
    this.active++;
    log.info('pool', 'acquired', { active: this.active, cap: this.cap() });
    reportMetric('pool_active', this.active);
    return this.createRelease();
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    log.info('pool', 'released', { active: this.active });
    reportMetric('pool_active', this.active);
    this.drainWaiters();
  }

  private drainWaiters(): void {
    // Grant synchronously so tryAcquire() cannot steal a slot between waking
    // a waiter and that waiter's promise continuation running.
    while (this.active < this.cap() && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled || waiter.signal?.aborted) continue;
      waiter.settled = true;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      this.active++;
      log.info('pool', 'acquired', { active: this.active, cap: this.cap() });
      reportMetric('pool_active', this.active);
      reportMetric('pool_waiting', this.waiters.length);
      waiter.resolve(this.createRelease());
    }
  }

  snapshot(): { active: number; waiting: number; cap: number } {
    return { active: this.active, waiting: this.waiters.length, cap: this.cap() };
  }
}
