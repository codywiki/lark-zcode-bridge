import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { log } from '../core/logger';

/**
 * Orphaned-agent reaper.
 *
 * When the bridge dies ungracefully (SIGKILL from `launchctl kickstart -k`, an
 * OOM kill, a crash), its `stop() → activeRuns.stopAll()` never runs, so the
 * codex/kimi/claude children it spawned stay alive with dead pipe readers —
 * they stall forever and the user sees a run that "ran for hours with no
 * result". The executor persists each in-flight child's pid here; on startup
 * the next bridge instance reaps any whose owning bridge is dead.
 */

export interface ActiveChildEntry {
  runId: string;
  scopeId: string;
  pid: number;
  bridgePid: number;
  agentKind: string;
  startedAt: string;
}

function fileFor(profileStateDir: string): string {
  return join(profileStateDir, 'active-children.json');
}

function read(profileStateDir: string): ActiveChildEntry[] {
  try {
    const raw = readFileSync(fileFor(profileStateDir), 'utf8');
    const parsed = JSON.parse(raw) as { entries?: ActiveChildEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function write(profileStateDir: string, entries: ActiveChildEntry[]): void {
  const file = fileFor(profileStateDir);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    log.warn('reaper', 'persist-failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/** Record an in-flight child so a future instance can reap it if we die. */
export function trackChild(profileStateDir: string, entry: ActiveChildEntry): void {
  const entries = read(profileStateDir).filter((e) => e.pid !== entry.pid);
  entries.push(entry);
  write(profileStateDir, entries);
}

/** Remove a child once it exits cleanly. */
export function untrackChild(profileStateDir: string, pid: number): void {
  write(profileStateDir, read(profileStateDir).filter((e) => e.pid !== pid));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else — treat as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kill every tracked child whose owning bridge is no longer alive. Called once
 * at startup, after profile locks are held so no live sibling instance races us.
 * Returns the number of children reaped.
 */
export function reapOrphanedChildren(profileStateDir: string): number {
  const file = fileFor(profileStateDir);
  if (!existsSync(file)) return 0;
  const entries = read(profileStateDir);
  if (entries.length === 0) return 0;

  const survivors: ActiveChildEntry[] = [];
  let reaped = 0;
  for (const entry of entries) {
    const childAlive = alive(entry.pid);
    const bridgeAlive = alive(entry.bridgePid);
    if (childAlive && !bridgeAlive) {
      // Orphan: pipe reader (old bridge) is gone, it can never deliver a result.
      try {
        process.kill(entry.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      // Escalate to SIGKILL shortly after; the child holds pipes, not state we need.
      setTimeout(() => {
        try {
          process.kill(entry.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2000).unref();
      reaped++;
      log.warn('reaper', 'reaped-orphan', {
        pid: entry.pid,
        runId: entry.runId,
        scope: entry.scopeId,
        agentKind: entry.agentKind,
        bridgePid: entry.bridgePid,
      });
      continue;
    }
    if (!childAlive) {
      // Child already exited; drop the stale record.
      continue;
    }
    // Child alive AND its bridge alive → belongs to a live sibling instance; keep.
    survivors.push(entry);
  }
  write(profileStateDir, survivors);
  return reaped;
}

/** Best-effort: clear the whole file (e.g. after a clean shutdown). */
export function clearChildren(profileStateDir: string): void {
  try {
    unlinkSync(fileFor(profileStateDir));
  } catch {
    /* absent is fine */
  }
}
