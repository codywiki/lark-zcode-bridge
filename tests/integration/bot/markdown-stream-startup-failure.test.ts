import { LarkChannelError, type NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRun } from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  recalled: string[];
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(
    chatId: string,
    input: unknown,
    options?: unknown,
  ): Promise<void | { messageId?: string }>;
  recallMessage(messageId: string): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 5000);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(allMarkdown(h.channel)).toContain('agent 失败');
    expect(allMarkdown(h.channel)).toContain('zcode exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 5000);

    expect(allMarkdown(h.channel)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      events: [
        [
          { type: 'text', delta: 'progress update' },
          {
            type: 'error',
            message: 'zcode exited with code 1: missing runtime module',
            terminationReason: 'failed',
          },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);

  it('sends an independent error notice when a started card update rejects', async () => {
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress before failure' },
        { type: 'error', message: 'TERMINAL_PATCH_REJECTED', terminationReason: 'failed' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: {
            producer?: (ctrl: {
              messageId: string;
              update(next: unknown): Promise<void>;
            }) => Promise<void>;
          };
        }).card?.producer;
        await producer?.({
          messageId: 'om_rejected_progress',
          update: async (next) => {
            if (JSON.stringify(next).includes('"streaming_mode":false')) {
              throw new Error('terminal patch rejected');
            }
          },
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_terminal_reject', 'run'));
    await waitFor(() =>
      h.channel.sent.some(({ content }) => JSON.stringify(content).includes('TERMINAL_PATCH_REJECTED')),
    );

    expect(
      h.channel.sent.some(({ content }) => JSON.stringify(content).includes('TERMINAL_PATCH_REJECTED')),
    ).toBe(true);
    await waitFor(() => h.channel.recalled.includes('om_rejected_progress'));
  });

  it('sends an independent error notice when a started card update never settles', async () => {
    const never = deferred<void>();
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress before timeout' },
        { type: 'error', message: 'TERMINAL_PATCH_TIMEOUT', terminationReason: 'failed' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: {
            producer?: (ctrl: {
              messageId: string;
              update(next: unknown): Promise<void>;
            }) => Promise<void>;
          };
        }).card?.producer;
        await producer?.({
          messageId: 'om_timed_out_progress',
          update: async (next) => {
            if (JSON.stringify(next).includes('"streaming_mode":false')) await never.promise;
          },
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_terminal_timeout', 'run'));
    await waitFor(
      () => h.channel.sent.some(({ content }) => JSON.stringify(content).includes('TERMINAL_PATCH_TIMEOUT')),
      7000,
    );

    expect(
      h.channel.sent.some(({ content }) => JSON.stringify(content).includes('TERMINAL_PATCH_TIMEOUT')),
    ).toBe(true);
    await waitFor(() => h.channel.recalled.includes('om_timed_out_progress'));
  }, 12_000);

  it('sends an independent abnormal terminal notice after a settled progress stream', async () => {
    const progressCards: unknown[] = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress before failure' },
        { type: 'error', message: 'VISIBLE_TERMINAL_FAILURE', terminationReason: 'failed' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: {
            producer?: (ctrl: {
              messageId: string;
              update(next: unknown): Promise<void>;
            }) => Promise<void>;
          };
        }).card?.producer;
        await producer?.({
          messageId: 'om_successful_progress',
          update: async (next) => {
            progressCards.push(next);
          },
        });
        return { messageId: 'om_successful_progress' };
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_terminal_notice', 'run'));
    await waitFor(() =>
      h.channel.sent.some(({ content }) =>
        JSON.stringify(content).includes('VISIBLE_TERMINAL_FAILURE'),
      ),
    );

    expect(progressCards.length).toBeGreaterThan(0);
    expect(JSON.stringify(progressCards)).not.toContain('VISIBLE_TERMINAL_FAILURE');
    expect(
      h.channel.sent.some(({ content }) =>
        JSON.stringify(content).includes('VISIBLE_TERMINAL_FAILURE'),
      ),
    ).toBe(true);
  });

  it('falls back and recalls a progress card whose late first update times out', async () => {
    const never = deferred<void>();
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'LATE_PROGRESS_SENTINEL' },
        { type: 'text', delta: 'LATE_CONCLUSION_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await new Promise((resolve) => setTimeout(resolve, 2_900));
        await producer?.({ update: async () => never.promise });
        return { messageId: 'om_late_stale_progress' };
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_late_progress_timeout', 'run'));
    await waitFor(() => h.channel.recalled.includes('om_late_stale_progress'), 8_000);

    const progressFallback = h.channel.sent.find(({ content }) =>
      JSON.stringify(content).includes('LATE_PROGRESS_SENTINEL'),
    );
    expect(progressFallback).toBeDefined();
    // The fork has no separate final-answer message: the conclusion stays in the
    // (single) progress transcript the fallback delivers.
    expect(JSON.stringify(progressFallback?.content)).toContain('LATE_CONCLUSION_SENTINEL');
  }, 12_000);
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  events?: FakeAgentEvents;
  messageReply?: 'card' | 'markdown' | 'text';
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'zcode',
    zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
    },
    ...(options.messageReply
      ? { preferences: { messageReply: options.messageReply, messageReplyMigrated: true } }
      : {}),
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'zcode',
    displayName: 'ZCode',
    events: options.events ?? [
      [
        {
          type: 'error',
          message: 'zcode exited with code 1: missing runtime module',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const recalled: string[] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    recalled,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(options.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
    },
    async recallMessage(messageId) {
      recalled.push(messageId);
    },
    stream: options.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'zcode',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const markdown = [...channel.sent]
    .reverse()
    .map(({ content }) => markdownFromSendContent(content))
    .find((content): content is string => typeof content === 'string');
  expect(markdown).toBeTypeOf('string');
  return markdown ?? '';
}

function allMarkdown(channel: FakeLarkChannel): string {
  return markdownMessages(channel).join('\n');
}

function markdownMessages(channel: FakeLarkChannel): string[] {
  return channel.sent
    .map(({ content }) => markdownFromSendContent(content))
    .filter((markdown): markdown is string => typeof markdown === 'string');
}

function markdownFromSendContent(content: unknown): string | undefined {
  const direct = (content as { markdown?: unknown } | undefined)?.markdown;
  if (typeof direct === 'string') return direct;
  const paragraphs = (
    content as {
      post?: { zh_cn?: { content?: Array<Array<{ tag?: string; text?: unknown }>> } };
    }
  )?.post?.zh_cn?.content;
  if (!Array.isArray(paragraphs)) return undefined;
  const pieces = paragraphs
    .flat()
    .filter((element) => element?.tag === 'md' && typeof element.text === 'string')
    .map((element) => element.text as string);
  return pieces.length > 0 ? pieces.join('') : undefined;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
