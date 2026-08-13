import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SessionCatalog,
  sessionCatalogKey,
} from '../../../src/session/catalog.js';

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware session catalog', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('keys entries by scope, agent, cwd realpath, and policy fingerprint', () => {
    expect(
      sessionCatalogKey({
        scopeId: 'chat-1',
        agentId: 'zcode',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBe('chat-1\x1fzcode\x1f/repo\x1ffp-1');
  });

  it('stores ZCode sessions in isolated active entries per cwd/fingerprint', async () => {
    const catalogPath = await path();
    const catalog = new SessionCatalog(catalogPath);

    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'zcode',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      sessionId: 'sess-1',
      now: 1000,
    });
    catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'zcode',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-2',
      sessionId: 'sess-2',
      now: 2000,
    });
    catalog.upsertActive({
      scopeId: 'chat-2',
      agentId: 'zcode',
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      sessionId: 'sess-3',
      now: 3000,
    });

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'zcode',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ sessionId: 'sess-1', agentId: 'zcode' });
    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'zcode',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-2',
      }),
    ).toMatchObject({ sessionId: 'sess-2', agentId: 'zcode' });
    expect(
      catalog.activeFor({
        scopeId: 'chat-2',
        agentId: 'zcode',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ sessionId: 'sess-3', agentId: 'zcode' });
    await catalog.flush();

    const reloaded = new SessionCatalog(catalogPath);
    await reloaded.load();
    expect(
      reloaded.activeFor({
        scopeId: 'chat-1',
        agentId: 'zcode',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toMatchObject({ sessionId: 'sess-1', agentId: 'zcode' });
  });

  it('rejects mismatched ZCode identity fields and does not auto-resume damaged entries', async () => {
    const catalog = new SessionCatalog(await path());

    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'zcode',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        now: 1000,
      }),
    ).toThrow(/require sessionId/i);
    expect(() =>
      catalog.upsertActive({
        scopeId: 'chat-1',
        agentId: 'zcode',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-1',
        threadId: 'thread-wrong',
        now: 1000,
      }),
    ).toThrow(/must not include threadId/i);

    await catalog.replaceForTest([
      {
        key: sessionCatalogKey({
          scopeId: 'chat-1',
          agentId: 'zcode',
          cwdRealpath: '/repo',
          policyFingerprint: 'fp-1',
        }),
        scopeId: 'chat-1',
        agentId: 'zcode',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        sessionId: 'sess-damaged',
        threadId: 'thread-damaged',
        status: 'active',
        updatedAt: 1000,
      },
    ]);

    expect(
      catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'zcode',
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
      }),
    ).toBeUndefined();
    await catalog.flush();
  });

  it('isolates ZCode sessions between topic-thread scopes', async () => {
    const catalog = new SessionCatalog(await path());
    const base = {
      agentId: 'zcode' as const,
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
    };
    catalog.upsertActive({
      ...base,
      scopeId: 'oc_group:omt_topic_a',
      sessionId: 'zcode-session-a',
      now: 1000,
    });
    catalog.upsertActive({
      ...base,
      scopeId: 'oc_group:omt_topic_b',
      sessionId: 'zcode-session-b',
      now: 2000,
    });

    expect(catalog.activeFor({ ...base, scopeId: 'oc_group:omt_topic_a' })).toMatchObject({
      sessionId: 'zcode-session-a',
    });
    expect(catalog.activeFor({ ...base, scopeId: 'oc_group:omt_topic_b' })).toMatchObject({
      sessionId: 'zcode-session-b',
    });
    expect(catalog.activeFor({ ...base, scopeId: 'oc_group' })).toBeUndefined();
    await catalog.flush();
  });

  it('archives only the current cwd/fingerprint entry for a new conversation', async () => {
    const catalog = new SessionCatalog(await path());
    const base = {
      scopeId: 'chat-1',
      agentId: 'zcode' as const,
    };
    catalog.upsertActive({
      ...base,
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-1',
      sessionId: 'sess-1',
      now: 1000,
    });
    catalog.upsertActive({
      ...base,
      cwdRealpath: '/repo-other',
      policyFingerprint: 'fp-1',
      sessionId: 'sess-2',
      now: 1000,
    });
    catalog.upsertActive({
      ...base,
      cwdRealpath: '/repo',
      policyFingerprint: 'fp-2',
      sessionId: 'sess-3',
      now: 1000,
    });

    expect(
      catalog.archiveActive({
        ...base,
        cwdRealpath: '/repo',
        policyFingerprint: 'fp-1',
        now: 2000,
      }),
    ).toBe(true);

    expect(
      catalog.activeFor({ ...base, cwdRealpath: '/repo', policyFingerprint: 'fp-1' }),
    ).toBeUndefined();
    expect(
      catalog.activeFor({ ...base, cwdRealpath: '/repo-other', policyFingerprint: 'fp-1' }),
    ).toMatchObject({ sessionId: 'sess-2' });
    expect(
      catalog.activeFor({ ...base, cwdRealpath: '/repo', policyFingerprint: 'fp-2' }),
    ).toMatchObject({ sessionId: 'sess-3' });
    expect(catalog.entries().filter((entry) => entry.status === 'archived')).toHaveLength(1);
    await catalog.flush();
  });

  it('garbage-collects old archived entries, per-scope overflow, and profile overflow', async () => {
    const catalog = new SessionCatalog(await path());
    await catalog.replaceForTest([
      ...Array.from({ length: 25 }, (_, i) =>
        entry(`chat-1`, `sess-${i}`, 50_000 + i, `fp-${i}`),
      ),
      ...Array.from({ length: 981 }, (_, i) =>
        entry(`chat-${i + 2}`, `other-${i}`, 20_000 + i, `fp-other-${i}`),
      ),
      {
        ...entry('chat-old', 'old', 1),
        status: 'archived',
      },
    ]);

    catalog.gc({
      now: 100 * 24 * 60 * 60 * 1000,
      maxArchivedAgeMs: 90 * 24 * 60 * 60 * 1000,
      maxEntriesPerScope: 20,
      maxEntriesPerProfile: 1000,
    });

    expect(catalog.entries().some((item) => item.sessionId === 'old')).toBe(false);
    expect(catalog.entries().filter((item) => item.scopeId === 'chat-1')).toHaveLength(20);
    expect(catalog.entries()).toHaveLength(1000);
    await catalog.flush();
  });
});

async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-catalog-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'catalog.json');
}

function entry(
  scopeId: string,
  sessionId: string,
  updatedAt: number,
  policyFingerprint = 'fp-1',
) {
  const identity = {
    scopeId,
    agentId: 'zcode' as const,
    cwdRealpath: '/repo',
    policyFingerprint,
  };
  return {
    key: sessionCatalogKey(identity),
    ...identity,
    sessionId,
    status: 'active' as const,
    updatedAt,
  };
}
