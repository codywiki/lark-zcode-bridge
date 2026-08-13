import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityForProfile } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { runAgentBatch } from '../../../src/bot/channel.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { startRunFlow } from '../../../src/bot/run-flow.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import type { MediaCache } from '../../../src/media/cache.js';
import { SpawnFailed } from '../../../src/runtime/errors.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

describe('attachment run flow', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('passes accepted image attachment paths to the agent adapter image args only', async () => {
    const h = await createHarness();

    const result = await startRunFlow({
      scopeId: 'chat-1',
      scope: { source: 'im', chatId: 'chat-1', actorId: 'ou_user' },
      prompt: 'inspect attachments',
      attachments: [
        {
          kind: 'image',
          path: '/media/image.png',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'file',
          path: '/media/file.txt',
          requiredness: 'optional',
          decision: 'accepted',
        },
        {
          kind: 'image',
          path: '/media/rejected.svg',
          requiredness: 'optional',
          decision: 'rejected',
          rejectionReason: 'unsupported-image-mime',
        },
      ],
      access: { ok: true, reason: 'allowed-user' },
      capability: capabilityForProfile(h.profileConfig),
      profileConfig: h.profileConfig,
      sessions: h.sessions,
      workspaces: h.workspaces,
      executor: h.executor,
      now: 1000,
    });

    expect(result.ok).toBe(true);
    expect(h.agent.runOptions[0]).toMatchObject({
      images: ['/media/image.png'],
    });
  });

  it.each([
    ['bootstrap guard', '/Users/alice/project/AGENTS.md is forbidden'],
    ['profile safety', '/Users/alice/.lark-zcode-bridge/profiles/zcode/zcode-home/.zcode/cli/config.json is invalid'],
    ['Seatbelt', 'sandbox-exec denied /Users/alice/project/secret.txt'],
  ])('returns a safe topic reply when ZCode cannot start: %s', async (_label, detail) => {
    const h = await createHarness();
    const channel = createFakeChannel();
    const controls = {
      profile: 'zcode',
      profileConfig: h.profileConfig,
      botOwnerId: 'ou-owner',
      ownerRefreshState: 'ok',
      async refreshOwner() {},
      restart: vi.fn(async () => {}),
      exit: vi.fn(async () => {}),
      configPath: join(h.tmp.profile, 'config.json'),
      cfg: h.profileConfig,
      processId: 'proc-1',
    } satisfies Controls;
    const submit = vi.fn(async () => {
      throw new SpawnFailed('agent spawn failed', new Error(detail));
    });
    const warn = vi.spyOn(log, 'warn');
    const fail = vi.spyOn(log, 'fail');
    const activePolicyFingerprints = new Map<string, string>();

    await expect(
      runAgentBatch({
        channel: channel as unknown as Parameters<typeof runAgentBatch>[0]['channel'],
        executor: { submit } as unknown as RunExecutor,
        sessions: h.sessions,
        workspaces: h.workspaces,
        media: { resolve: vi.fn(async () => []) } as unknown as MediaCache,
        batch: [topicTextMessage()],
        controls,
        activePolicyFingerprints,
        scope: 'chat-1:thread-1',
        mode: 'topic',
      }),
    ).resolves.toBeUndefined();

    expect(submit).toHaveBeenCalledOnce();
    expect(channel.streams).toHaveLength(0);
    expect(activePolicyFingerprints.size).toBe(0);
    expect(h.sessions.getRaw('chat-1:thread-1')).toBeUndefined();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.options).toMatchObject({
      replyTo: 'om-zcode-text',
      replyInThread: true,
    });
    const reply = JSON.stringify(channel.sent[0]?.content);
    expect(reply).toContain('ZCode 当前无法启动');
    expect(reply).not.toMatch(/\/Users\/alice|AGENTS|config\.json|sandbox|secret\.txt/i);
    const runFlowWarnings = warn.mock.calls.filter(([phase]) => phase === 'run-flow');
    expect(runFlowWarnings).toContainEqual([
      'run-flow',
      'zcode-start-failed',
      expect.objectContaining({ agent: 'zcode' }),
    ]);
    expect(JSON.stringify(runFlowWarnings)).not.toContain(detail);
    expect(fail.mock.calls.filter(([phase]) => phase === 'run-flow')).toEqual([]);
  });
});

function topicTextMessage(): NormalizedMessage {
  return {
    messageId: 'om-zcode-text',
    chatId: 'chat-1',
    chatType: 'group',
    threadId: 'thread-1',
    senderId: 'ou-owner',
    senderName: 'Owner',
    content: 'read README.md',
    resources: [],
    mentionedBot: true,
  } as unknown as NormalizedMessage;
}

async function createHarness(): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('attachment-run-flow-');
  const agent = new FakeAgentAdapter({
    id: 'zcode',
    displayName: 'ZCode',
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => 'run-1',
    now: () => 1000,
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
    zcode: {
      runtimePath: join(tmp.root, 'zcode.cjs'),
    },
  });
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  const workspaceRealpath = await realpath(tmp.workspace);
  return {
    tmp,
    agent,
    executor,
    sessions,
    workspaces,
    profileConfig: {
      ...profileConfig,
      workspaces: {
        ...profileConfig.workspaces,
        default: workspaceRealpath,
      },
    },
  };
}
