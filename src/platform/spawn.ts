import type {
  ChildProcess,
  ChildProcessByStdio,
  SpawnOptions,
  SpawnSyncOptions,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import crossSpawn from 'cross-spawn';

export function spawnProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return crossSpawn(command, [...args], options);
}

export function spawnProcessSync(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
) {
  return crossSpawn.sync(command, [...args], options);
}

/**
 * A direct CLI child can exit while one of its descendants still owns the
 * inherited stdout/stderr pipe. Without this guard, readers wait forever for
 * EOF even though the agent process itself is already gone.
 */
export interface ProcessOutputExitGuard {
  readonly closed: Promise<void>;
  close(): void;
}

export function installProcessOutputExitGuard(
  child: ChildProcess,
  drainMs = 250,
): ProcessOutputExitGuard {
  let scheduled = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    closeProcessOutput(child);
    resolveClosed();
  };
  const scheduleClose = (): void => {
    if (scheduled) return;
    scheduled = true;
    timer = setTimeout(close, drainMs);
    timer.unref?.();
  };
  child.once('exit', scheduleClose);
  // Attach first, then inspect state so a fast exit between the two cannot be
  // missed. scheduleClose() is idempotent if both paths observe it.
  if (child.exitCode !== null || child.signalCode !== null) scheduleClose();
  return { closed: closedPromise, close };
}

export function closeProcessOutput(child: ChildProcess): void {
  if (child.stdout && !child.stdout.destroyed) child.stdout.destroy();
  if (child.stderr && !child.stderr.destroyed) child.stderr.destroy();
}

export function mergeProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === key.toLowerCase()) {
        delete out[existing];
      }
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export type SpawnedProcessByStdio<
  Stdin extends Writable | null,
  Stdout extends Readable | null,
  Stderr extends Readable | null,
> = ChildProcessByStdio<Stdin, Stdout, Stderr>;
