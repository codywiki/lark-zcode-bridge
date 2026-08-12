import type { AgentRun } from '../agent/types';

export type RunStopReason = 'interrupted' | 'timeout';

export interface RunHandle {
  run: AgentRun;
  interrupted: boolean;
  requestStop(reason?: RunStopReason): Promise<void>;
}

interface RunReservation {
  cancel: () => void;
}

export class ActiveRuns {
  private readonly handles = new Map<string, RunHandle>();
  private readonly reservations = new Map<string, RunReservation>();
  private readonly executorManagedHandles = new WeakSet<RunHandle>();
  private pauseDepth = 0;
  private pauseReason: string | undefined;

  reserve(chatId: string, cancel: () => void = () => {}): (() => void) | undefined {
    if (this.handles.has(chatId) || this.reservations.has(chatId)) return undefined;
    const reservation = { cancel };
    this.reservations.set(chatId, reservation);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.reservations.get(chatId) === reservation) {
        this.reservations.delete(chatId);
      }
    };
  }

  register(
    chatId: string,
    run: AgentRun,
    requestStop?: (reason?: RunStopReason) => Promise<void>,
  ): RunHandle {
    if (this.handles.has(chatId)) {
      throw new Error(`run already active for scope: ${chatId}`);
    }
    this.reservations.delete(chatId);
    const handle: RunHandle = {
      run,
      interrupted: false,
      requestStop: requestStop ?? (async () => run.stop()),
    };
    if (requestStop) this.executorManagedHandles.add(handle);
    this.handles.set(chatId, handle);
    return handle;
  }

  pauseNewRuns(reason: string): () => void {
    this.pauseDepth++;
    this.pauseReason = reason;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pauseDepth = Math.max(0, this.pauseDepth - 1);
      if (this.pauseDepth === 0) this.pauseReason = undefined;
    };
  }

  newRunsPaused(): boolean {
    return this.pauseDepth > 0;
  }

  newRunsPauseReason(): string | undefined {
    return this.pauseReason;
  }

  get(chatId: string): RunHandle | undefined {
    return this.handles.get(chatId);
  }

  unregister(chatId: string, run: AgentRun): void {
    const existing = this.handles.get(chatId);
    if (existing?.run === run) this.handles.delete(chatId);
  }

  snapshot(): RunHandle[] {
    return [...this.handles.values()];
  }

  scopes(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * Interrupt the current run for this chat, if any. Returns true if an
   * interrupt was issued. Executor-managed handles remain visible until the
   * executor's cleanup path unregisters them; this keeps status and repeated
   * stop requests truthful while the subprocess is still shutting down.
   */
  interrupt(chatId: string): boolean {
    const h = this.handles.get(chatId);
    if (h) {
      h.interrupted = true;
      if (!this.executorManagedHandles.has(h)) this.handles.delete(chatId);
      void h.requestStop('interrupted').catch(() => {
        /* stop errors are non-fatal */
      });
      return true;
    }

    const reservation = this.reservations.get(chatId);
    if (!reservation) return false;
    reservation.cancel();
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.handles.values()];
    const reservations = [...this.reservations.values()];
    this.handles.clear();
    this.reservations.clear();
    for (const h of all) h.interrupted = true;
    for (const reservation of reservations) reservation.cancel();
    await Promise.allSettled(all.map((h) => h.requestStop('interrupted')));
  }

  async waitForAll(timeoutMs = 300_000): Promise<void> {
    const all = [...this.handles.values()];
    await Promise.allSettled(all.map((h) => h.run.waitForExit(timeoutMs)));
  }
}
