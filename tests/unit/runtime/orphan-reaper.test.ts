import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  reapOrphanedChildren,
  trackChild,
  untrackChild,
  clearChildren,
  type ActiveChildEntry,
} from '../../../src/runtime/orphan-reaper.js';

function entry(over: Partial<ActiveChildEntry>): ActiveChildEntry {
  return {
    runId: 'r1',
    scopeId: 'oc_x',
    pid: 0,
    bridgePid: 0,
    agentKind: 'codex',
    startedAt: new Date().toISOString(),
    ...over,
  };
}

/** Spawn a long-lived child we can check/kill deterministically. */
function spawnSleeper(): number {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  child.unref();
  return child.pid!;
}

describe('orphan-reaper', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reaper-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('tracks and untracks children', () => {
    trackChild(dir, entry({ pid: 111, bridgePid: 222 }));
    trackChild(dir, entry({ pid: 333, bridgePid: 222 }));
    let stored = JSON.parse(readFileSync(join(dir, 'active-children.json'), 'utf8'));
    expect(stored.entries).toHaveLength(2);

    untrackChild(dir, 111);
    stored = JSON.parse(readFileSync(join(dir, 'active-children.json'), 'utf8'));
    expect(stored.entries.map((e: ActiveChildEntry) => e.pid)).toEqual([333]);
  });

  it('replaces an existing entry for the same pid', () => {
    trackChild(dir, entry({ pid: 111, runId: 'old' }));
    trackChild(dir, entry({ pid: 111, runId: 'new' }));
    const stored = JSON.parse(readFileSync(join(dir, 'active-children.json'), 'utf8'));
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0].runId).toBe('new');
  });

  it('reaps a live child whose bridge is dead', async () => {
    const childPid = spawnSleeper();
    trackChild(dir, entry({ pid: childPid, bridgePid: 999999 })); // dead bridge pid
    const reaped = reapOrphanedChildren(dir);
    expect(reaped).toBe(1);
    // SIGTERM → wait briefly for the child to actually exit.
    const exited = await new Promise<boolean>((resolve) => {
      const deadline = Date.now() + 3000;
      const tick = () => {
        try {
          process.kill(childPid, 0);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(tick, 25);
        } catch {
          resolve(true);
        }
      };
      tick();
    });
    expect(exited).toBe(true);
    // record cleared
    const stored = JSON.parse(readFileSync(join(dir, 'active-children.json'), 'utf8'));
    expect(stored.entries).toHaveLength(0);
  });

  it('keeps a child whose bridge is still alive', () => {
    const childPid = spawnSleeper();
    try {
      trackChild(dir, entry({ pid: childPid, bridgePid: process.pid })); // we are alive
      const reaped = reapOrphanedChildren(dir);
      expect(reaped).toBe(0);
      // still running
      let alive = true;
      try {
        process.kill(childPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);
      const stored = JSON.parse(readFileSync(join(dir, 'active-children.json'), 'utf8'));
      expect(stored.entries).toHaveLength(1);
    } finally {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });

  it('drops records for children that already exited', () => {
    trackChild(dir, entry({ pid: 999998, bridgePid: 999999 })); // both dead
    const reaped = reapOrphanedChildren(dir);
    expect(reaped).toBe(0); // nothing to kill
    const stored = JSON.parse(readFileSync(join(dir, 'active-children.json'), 'utf8'));
    expect(stored.entries).toHaveLength(0); // stale record pruned
  });

  it('returns 0 when there is no file', () => {
    expect(reapOrphanedChildren(dir)).toBe(0);
  });

  it('clearChildren removes the file', () => {
    trackChild(dir, entry({ pid: 1, bridgePid: 2 }));
    expect(existsSync(join(dir, 'active-children.json'))).toBe(true);
    clearChildren(dir);
    expect(existsSync(join(dir, 'active-children.json'))).toBe(false);
  });
});
