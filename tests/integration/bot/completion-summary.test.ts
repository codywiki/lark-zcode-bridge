import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { runAgentBatch } from '../../../src/bot/channel.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { MediaCache } from '../../../src/media/cache.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('stream completion summary', () => {
  it('sends the final assistant result after a long run', async () => {
    const h = await createHarness(undefined, [
      { type: 'text', delta: '我先检查运行配置。' },
      ...toolEvents(8),
      { type: 'text', delta: '已完成：邀请命令恢复，回归测试通过。' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    await h.run();

    expect(h.channel.streams).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(1);
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om-summary' });
    const summary = JSON.stringify(h.channel.sent[0]?.content);
    expect(summary).toContain('结果摘要');
    expect(summary).toContain('邀请命令恢复');
    expect(summary).not.toContain('private command');
    expect(summary).not.toContain('private output');
    expect(summary).not.toContain('我先检查运行配置');
  });

  it('does not send a follow-up summary after a short run', async () => {
    const h = await createHarness(undefined, [
      { type: 'text', delta: '你好！有什么可以帮你的？' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    await h.run();

    expect(h.channel.streams).toHaveLength(1);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('does not duplicate the final reply when plain text mode already sends one', async () => {
    const h = await createHarness('text', [
      { type: 'text', delta: '已完成：这是唯一一条最终回复。' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    await h.run();

    expect(h.channel.streams).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(1);
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('这是唯一一条最终回复');
    expect(JSON.stringify(h.channel.sent[0]?.content)).not.toContain('结果摘要');
  });

  it('also sends the separate summary after a long card stream', async () => {
    const h = await createHarness('card', [
      ...toolEvents(8),
      { type: 'text', delta: '卡片任务已完成。' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    await h.run();

    expect(h.channel.streams).toHaveLength(1);
    expect(JSON.stringify(h.channel.sent.at(-1)?.content)).toContain('卡片任务已完成');
  });

  it('does not turn a completed run into a failure when the summary send fails', async () => {
    const h = await createHarness('markdown', [
      ...toolEvents(8),
      { type: 'text', delta: '主回复已经完成。' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    h.channel.send = vi.fn(async () => {
      throw new Error('summary send failed');
    });

    await expect(h.run()).resolves.toBeUndefined();

    expect(h.channel.streams).toHaveLength(1);
    expect(h.activePolicyFingerprints.size).toBe(0);
  });
});

async function createHarness(
  replyMode: 'card' | 'markdown' | 'text' | undefined,
  events: AgentEvent[],
): Promise<{
  channel: ReturnType<typeof createFakeChannel>;
  activePolicyFingerprints: Map<string, string>;
  run(): Promise<void>;
}> {
  const tmp = await createTmpProfile('completion-summary-');
  const workspace = await realpath(tmp.workspace);
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'zcode',
    accounts: {
      app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' },
    },
    access: { allowedUsers: ['ou-user'] },
    preferences: replyMode
      ? {
          messageReply: replyMode,
          messageReplyMigrated: true,
        }
      : {},
    zcode: { runtimePath: join(tmp.root, 'zcode.cjs') },
  });
  profileConfig.workspaces.default = workspace;
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({ id: 'zcode', events });
  const executor = new RunExecutor({
    agent,
    pool: new ProcessPool(() => 1),
    activeRuns: new ActiveRuns(),
    createRunId: () => 'run-summary',
    now: () => 1000,
  });
  const channel = Object.assign(createFakeChannel(), {
    addReaction: vi.fn(async () => 'reaction-summary'),
    removeReaction: vi.fn(async () => {}),
  });
  const controls = {
    profile: 'zcode',
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.root, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-summary',
  } satisfies Controls;
  const activePolicyFingerprints = new Map<string, string>();

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    channel,
    activePolicyFingerprints,
    async run() {
      await runAgentBatch({
        channel: channel as unknown as Parameters<typeof runAgentBatch>[0]['channel'],
        executor,
        sessions,
        workspaces,
        media: { resolve: vi.fn(async () => []) } as unknown as MediaCache,
        batch: [message()],
        controls,
        activePolicyFingerprints,
        scope: 'chat-summary',
        mode: 'p2p',
      });
    },
  };
}

/** N completed tool calls, enough to push a run over the long-run threshold. */
function toolEvents(count: number): AgentEvent[] {
  return Array.from({ length: count }, (_, i) => [
    {
      type: 'tool_use',
      id: `tool-${i}`,
      name: 'Bash',
      input: { command: 'private command' },
    } satisfies AgentEvent,
    {
      type: 'tool_result',
      id: `tool-${i}`,
      output: 'private output',
      isError: false,
    } satisfies AgentEvent,
  ]).flat();
}

function message(): NormalizedMessage {
  return {
    messageId: 'om-summary',
    chatId: 'chat-summary',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content: '请完成任务',
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
