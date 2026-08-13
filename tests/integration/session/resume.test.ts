import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capabilityForProfile,
  zcodeCapability,
} from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import {
  recordRunSessionEvent,
  startRunFlow,
  type StartRunFlowInput,
} from '../../../src/bot/run-flow.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionCatalog } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('zcode run-flow resume', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('resumes ZCode only when scope, agent, cwd, and policy fingerprint match', async () => {
    const h = await createHarness();
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.execution.subscribe());

    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'zcode',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: first.policy.policyFingerprint,
      sessionId: 'sess-catalog',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected resumed run');
    expect(second.resumeFrom).toBe('sess-catalog');
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: 'sess-catalog',
      threadId: undefined,
    });
  });

  it('falls back to legacy sessions only when no catalog is configured', async () => {
    const h = await createHarness();
    const cwdRealpath = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'legacy-session', cwdRealpath);

    const run = await start(h, { withCatalog: false });

    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('expected resumed legacy run');
    expect(run.resumeFrom).toBe('legacy-session');
    expect(h.agent.runOptions[0]).toMatchObject({
      sessionId: 'legacy-session',
      threadId: undefined,
    });
  });

  it('does not fall back to a legacy session when a catalog exists but still applies model overrides', async () => {
    const h = await createHarness();
    const cwdRealpath = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'legacy-cross-policy-session', cwdRealpath);
    h.sessions.setModel('chat-1', 'glm-5.2');

    const run = await start(h);

    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('expected fresh ZCode run');
    expect(run.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[0]).toMatchObject({
      sessionId: undefined,
      threadId: undefined,
      model: 'glm-5.2',
    });
  });

  it('does not resume when the policy fingerprint changes', async () => {
    const h = await createHarness();
    const first = await start(h);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected initial run');
    await collect(first.execution.subscribe());
    h.catalog.upsertActive({
      scopeId: 'chat-1',
      agentId: 'zcode',
      cwdRealpath: first.cwdRealpath,
      policyFingerprint: 'stale-fingerprint',
      sessionId: 'sess-stale',
      now: 1000,
    });

    const second = await start(h);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected fresh run');
    expect(second.resumeFrom).toBeUndefined();
    expect(h.agent.runOptions[1]).toMatchObject({
      sessionId: undefined,
      threadId: undefined,
    });
  });

  it('records system session identifiers into the catalog', async () => {
    const h = await createHarness();
    const run = await start(h);
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error('expected zcode run');
    await collect(run.execution.subscribe());

    recordRunSessionEvent({
      scopeId: 'chat-1',
      sessions: h.sessions,
      sessionCatalog: h.catalog,
      capability: zcodeCapability(h.profileConfig),
      policy: run.policy,
      event: { type: 'system', sessionId: 'sess-recorded', cwd: run.cwdRealpath },
    });

    expect(
      h.catalog.activeFor({
        scopeId: 'chat-1',
        agentId: 'zcode',
        cwdRealpath: run.cwdRealpath,
        policyFingerprint: run.policy.policyFingerprint,
      }),
    ).toMatchObject({ sessionId: 'sess-recorded' });
    expect(h.sessions.resumeFor('chat-1', run.cwdRealpath)).toBe('sess-recorded');
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  profileConfig: ProfileConfig;
}> {
  const tmp = await createTmpProfile('resume-zcode-test-');
  const agent = new FakeAgentAdapter({
    id: 'zcode',
    displayName: 'zcode',
    events: [[{ type: 'done', terminationReason: 'normal' }]],
  });
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'zcode',
    accounts: {
      app: {
        id: 'cli_test',
        secret: '${APP_SECRET}',
        tenant: 'feishu',
      },
    },
    zcode: { runtimePath: '/usr/local/bin/zcode' },
  });
  const workspaceRealpath = await realpath(tmp.workspace);
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', workspaceRealpath);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor: new RunExecutor({
      agent,
      pool: new ProcessPool(() => 10),
      activeRuns: new ActiveRuns(),
      createRunId: () => `run-${agent.runOptions.length + 1}`,
      now: () => 1000,
    }),
    sessions,
    workspaces,
    catalog,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: workspaceRealpath,
      },
    },
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    /* drain */
  }
}

async function start(
  h: Awaited<ReturnType<typeof createHarness>>,
  options: { withCatalog?: boolean } = {},
) {
  const input = {
    scopeId: 'chat-1',
    scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
    prompt: 'hello',
    attachments: [],
    access: { ok: true, reason: 'allowed-user' },
    capability: capabilityForProfile(h.profileConfig),
    profileConfig: h.profileConfig,
    sessions: h.sessions,
    sessionCatalog: options.withCatalog === false ? undefined : h.catalog,
    workspaces: h.workspaces,
    executor: h.executor,
    now: 1000,
  } satisfies StartRunFlowInput;
  return startRunFlow(input);
}
