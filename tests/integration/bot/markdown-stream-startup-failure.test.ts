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
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(allMarkdown(h.channel)).toContain('agent 失败');
    expect(allMarkdown(h.channel)).toContain('codex exited with code 1');
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
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

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
            message: 'codex exited with code 1: Error loading config.toml',
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

  it('folds Codex progress and sends the final answer once as a separate card', async () => {
    const progressCards: unknown[] = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
        { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: {
            producer?: (ctrl: {
              update(next: unknown | ((current: unknown) => unknown)): Promise<void>;
            }) => Promise<void>;
          };
        }).card?.producer;
        let current: unknown = {};
        await producer?.({
          update: vi.fn(async (next: unknown | ((current: unknown) => unknown)) => {
            current = typeof next === 'function' ? next(current) : next;
            progressCards.push(current);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_compact', 'run'));
    await waitFor(() => progressCards.length > 0);
    await waitFor(() => h.channel.sent.length === 1);

    const progressJson = JSON.stringify(progressCards);
    const lastProgress = progressCards.at(-1) as {
      body?: {
        elements?: Array<{
          tag?: string;
          content?: string;
          header?: { title?: { content?: string } };
        }>;
      };
    };
    const progressElements = lastProgress.body?.elements ?? [];
    expect(progressJson).toContain('collapsible_panel');
    expect(progressJson).toContain('progress update');
    expect(progressJson).toContain('"expanded":false');
    expect(progressJson).not.toContain('FINAL_SENTINEL');
    expect(progressElements[0]?.tag).toBe('collapsible_panel');
    expect(progressElements[0]?.header?.title?.content).toContain('执行过程');
    expect(
      progressElements.some(
        (element) => element.tag === 'markdown' && element.content?.includes('progress update'),
      ),
    ).toBe(false);

    expect(h.channel.sent).toHaveLength(1);
    const finalJson = JSON.stringify(h.channel.sent[0]?.content);
    expect(finalJson).toContain('FINAL_SENTINEL');
    expect(finalJson).not.toContain('progress update');
    expect(finalJson).not.toContain('collapsible_panel');
    expect(finalJson).not.toContain('执行过程');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_compact' });
  });

  it('sends the dedicated Codex final answer after default markdown progress', async () => {
    const visibleProgress: string[] = [];
    const recallAfterFinalDelivery: boolean[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'MARKDOWN_PROGRESS_SENTINEL' },
        { type: 'final_text', content: 'MARKDOWN_FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: {
            messageId: string;
            setContent(markdown: string): Promise<void>;
          }) => Promise<void>;
        }).markdown;
        await producer?.({
          messageId: 'om_markdown_progress',
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
        return { messageId: 'om_markdown_progress' };
      },
    });
    const recallMessage = h.channel.recallMessage.bind(h.channel);
    h.channel.recallMessage = vi.fn(async (messageId) => {
      recallAfterFinalDelivery.push(
        h.channel.sent.some(({ content }) =>
          JSON.stringify(content).includes('MARKDOWN_FINAL_SENTINEL'),
        ),
      );
      await recallMessage(messageId);
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_markdown_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(visibleProgress.some((value) => value.includes('MARKDOWN_PROGRESS_SENTINEL'))).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('MARKDOWN_FINAL_SENTINEL');
    expect(lastMarkdown(h.channel)).not.toContain('MARKDOWN_PROGRESS_SENTINEL');
    expect(lastMarkdown(h.channel)).not.toContain('结果摘要');
    await waitFor(() => h.channel.recalled.includes('om_markdown_progress'));
    expect(recallAfterFinalDelivery).toEqual([true]);
  });

  it('sends only the dedicated Codex final answer in text mode', async () => {
    const h = await createHarness({
      messageReply: 'text',
      events: [
        { type: 'text', delta: 'TEXT_PROGRESS_SENTINEL' },
        { type: 'final_text', content: 'TEXT_FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async () => {
        throw new Error('text mode must not open a stream');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_text_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toContain('TEXT_FINAL_SENTINEL');
    expect(lastMarkdown(h.channel)).not.toContain('TEXT_PROGRESS_SENTINEL');
  });

  it('keeps an abnormal Codex terminal notice visible in text mode after final_text', async () => {
    const h = await createHarness({
      messageReply: 'text',
      events: [
        { type: 'final_text', content: 'MUST_NOT_HIDE_INTERRUPTION' },
        { type: 'error', message: 'stopped by user', terminationReason: 'interrupted' },
      ],
      stream: async () => {
        throw new Error('text mode must not open a stream');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_text_interrupted', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toContain('已被中断');
    expect(lastMarkdown(h.channel)).not.toContain('MUST_NOT_HIDE_INTERRUPTION');
  });

  it.each(['card', 'markdown', 'text'] as const)(
    'sends one explicit empty-result notice for a final-less Codex %s round',
    async (messageReply) => {
      const h = await createHarness({
        messageReply,
        events: [{ type: 'done', terminationReason: 'normal' }],
        stream: async () => {
          throw new Error('an empty final round must not open a progress stream');
        },
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_empty_${messageReply}`, 'run'));
      await waitFor(() => h.channel.sent.length === 1);

      expect(h.channel.sent).toHaveLength(1);
      expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('未返回内容');
    },
  );

  it('keeps the eager card lifecycle for Claude reasoning-only runs', async () => {
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      events: [
        { type: 'thinking', delta: 'private reasoning' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamCalls.push(input);
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({ update: vi.fn(async () => {}) });
        return { messageId: 'om_claude_reasoning_card' };
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_claude_reasoning', 'run'));
    await waitFor(() => h.agent.runOptions.length === 1);
    await waitFor(() => streamCalls.length === 1);

    expect(streamCalls).toHaveLength(1);
    expect(h.channel.recalled).not.toContain('om_claude_reasoning_card');
  });

  it('falls back to the visible Claude reasoning card when stream startup fails', async () => {
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'card',
      events: [
        { type: 'thinking', delta: 'reasoning that must remain visible' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async () => {
        throw new Error('card stream startup failed');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_claude_reasoning_fallback', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain(
      'reasoning that must remain visible',
    );
  });

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

  it.each(['card', 'markdown'] as const)(
    'still sends the authoritative Codex final when a %s progress fallback fails',
    async (messageReply) => {
      const h = await createHarness({
        messageReply,
        events: [
          { type: 'text', delta: 'progress before fallback failure' },
          { type: 'final_text', content: 'FINAL_AFTER_PROGRESS_FALLBACK_FAILURE' },
          { type: 'done', terminationReason: 'normal' },
        ],
        stream: async (_chatId, input) => {
          if (messageReply === 'card') {
            const producer = (input as {
              card?: {
                producer?: (ctrl: {
                  messageId: string;
                  update(next: unknown): Promise<void>;
                }) => Promise<void>;
              };
            }).card?.producer;
            await producer?.({
              messageId: 'om_failed_card_progress',
              async update() {
                throw new Error('card progress update failed');
              },
            });
          } else {
            const producer = (input as {
              markdown?: (ctrl: {
                messageId: string;
                setContent(markdown: string): Promise<void>;
              }) => Promise<void>;
            }).markdown;
            await producer?.({
              messageId: 'om_failed_markdown_progress',
              async setContent() {
                throw new Error('markdown progress update failed');
              },
            });
          }
          return { messageId: `om_failed_${messageReply}_progress` };
        },
      });
      const send = h.channel.send.bind(h.channel);
      let sendAttempts = 0;
      h.channel.send = vi.fn(async (chatId, content, options) => {
        sendAttempts += 1;
        if (sendAttempts === 1) throw new Error('progress fallback send failed');
        await send(chatId, content, options);
      });
      await startTestBridge(h);

      await h.channel.handlers.message?.(message(`om_${messageReply}_fallback_failure`, 'run'));
      await waitFor(() =>
        h.channel.sent.some(({ content }) =>
          JSON.stringify(content).includes('FINAL_AFTER_PROGRESS_FALLBACK_FAILURE'),
        ),
      );

      expect(sendAttempts).toBe(2);
    },
  );

  it('sends an independent abnormal terminal notice after a settled Codex progress stream', async () => {
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

  it('sends a separate abnormal terminal notice for a settled Claude progress stream', async () => {
    const progressMarkdown: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      messageReply: 'markdown',
      events: [
        { type: 'text', delta: 'claude progress' },
        { type: 'error', message: 'CLAUDE_TERMINAL_FAILURE', terminationReason: 'failed' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: {
            messageId: string;
            setContent(markdown: string): Promise<void>;
          }) => Promise<void>;
        }).markdown;
        await producer?.({
          messageId: 'om_claude_progress',
          setContent: async (markdown) => {
            progressMarkdown.push(markdown);
          },
        });
        return { messageId: 'om_claude_progress' };
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_claude_terminal_notice', 'run'));
    await waitFor(() => allMarkdown(h.channel).includes('CLAUDE_TERMINAL_FAILURE'));

    expect(progressMarkdown.join('\n')).not.toContain('CLAUDE_TERMINAL_FAILURE');
    expect(allMarkdown(h.channel)).toContain('CLAUDE_TERMINAL_FAILURE');
  });

  it('does not block the final answer while an empty progress stream is still settling', async () => {
    const streamReceipt = deferred<{ messageId: string }>();
    let hideTools = (): void => {};
    const h = await createHarness({
      messageReply: 'card',
      events: [
        // Must be a tool the renderer shows (see tool-significance.ts), so the
        // progress stream opens and `hideTools` below has something to empty.
        { type: 'tool_use', id: 'tool-hidden', name: 'Edit', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_result', id: 'tool-hidden', output: 'ok', isError: false },
        { type: 'final_text', content: 'FINAL_WHILE_RECALL_PENDING' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({
          update: async () => {
            hideTools();
          },
        });
        return streamReceipt.promise;
      },
    });
    hideTools = () => {
      h.profileConfig.preferences.showToolCalls = false;
    };
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_recall_pending', 'run'));
    await waitFor(() => h.channel.sent.length === 1, 7000);

    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('FINAL_WHILE_RECALL_PENDING');
    streamReceipt.resolve({ messageId: 'om_empty_progress' });
    await waitFor(() => h.channel.recalled.includes('om_empty_progress'));
  }, 12_000);

  it('falls back and recalls a progress card whose late first update times out', async () => {
    const never = deferred<void>();
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'LATE_PROGRESS_SENTINEL' },
        { type: 'final_text', content: 'LATE_FINAL_SENTINEL' },
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

    expect(
      h.channel.sent.some(({ content }) => JSON.stringify(content).includes('LATE_PROGRESS_SENTINEL')),
    ).toBe(true);
    expect(
      h.channel.sent.some(({ content }) => JSON.stringify(content).includes('LATE_FINAL_SENTINEL')),
    ).toBe(true);
  }, 12_000);

  it('splits an oversized Codex final answer across safe card elements', async () => {
    const longFinal = '长答案段落。'.repeat(12_000);
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'final_text', content: longFinal },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async () => {
        throw new Error('final-only round must not open a progress stream');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_long_final', 'run'));
    await waitFor(() => finalCardMarkdown(h.channel).join('') === longFinal);

    const cards = finalCards(h.channel);
    const markdownElements = cards.flatMap((card) =>
      (card.body?.elements ?? []).filter(
        (element) => element.tag === 'markdown' && typeof element.content === 'string',
      ),
    );
    expect(cards.length).toBeGreaterThan(1);
    expect(
      cards.every((card) => Buffer.byteLength(JSON.stringify(card)) <= 30_000),
    ).toBe(true);
    expect(markdownElements.length).toBeGreaterThan(1);
    expect(markdownElements.every((element) => Buffer.byteLength(element.content ?? '') <= 20_000)).toBe(true);
    expect(markdownElements.map((element) => element.content).join('')).toBe(longFinal);
  });

  it('falls back to bounded markdown messages when a dedicated final card is rejected', async () => {
    const finalText = `CARD_FALLBACK_${'x'.repeat(12_000)}`;
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'final_text', content: finalText },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async () => {
        throw new Error('final-only round must not open a progress stream');
      },
    });
    const send = h.channel.send.bind(h.channel);
    let rejected = false;
    h.channel.send = vi.fn(async (chatId, content, options) => {
      if (!rejected && 'card' in (content as Record<string, unknown>)) {
        rejected = true;
        throw new LarkChannelError('format_error', 'card payload rejected');
      }
      await send(chatId, content, options);
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final_card_fallback', 'run'));
    await waitFor(() => allMarkdown(h.channel).replace(/\n/g, '').includes('CARD_FALLBACK_'));

    const markdown = markdownMessages(h.channel);
    expect(rejected).toBe(true);
    expect(markdown.length).toBeGreaterThan(1);
    expect(markdown.every((chunk) => chunk.length < 3_500)).toBe(true);
    expect(markdown.join('')).toBe(finalText);
  });

  it('does not risk a duplicate fallback when final card delivery is ambiguous', async () => {
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'final_text', content: 'AMBIGUOUS_FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async () => {
        throw new Error('final-only round must not open a progress stream');
      },
    });
    const send = vi.fn(async () => {
      throw new LarkChannelError('send_timeout', 'response timed out after accept');
    });
    h.channel.send = send;
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_ambiguous_final_card', 'run'));
    await waitFor(() => h.agent.runOptions.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(send).toHaveBeenCalledTimes(1);
    expect(h.channel.sent).toHaveLength(0);
  });

  it('splits escaped fenced code into independently valid card elements', async () => {
    const codeLine = `const escaped = ${JSON.stringify('\\\\\\"'.repeat(80))};\n`;
    const codeBody = codeLine.repeat(500);
    const longFinal = `\`\`\`ts\n${codeBody}\`\`\`\n`;
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'final_text', content: longFinal },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async () => {
        throw new Error('final-only round must not open a progress stream');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_long_code_final', 'run'));
    await waitFor(
      () =>
        finalCardMarkdown(h.channel)
          .map((content) => content.replace(/^```ts\n/, '').replace(/```\n?$/, ''))
          .join('') === codeBody,
    );

    const markdown = finalCardMarkdown(h.channel);
    expect(markdown.length).toBeGreaterThan(1);
    expect(
      markdown.every(
        (content) =>
          Buffer.byteLength(JSON.stringify({ tag: 'markdown', content })) <= 20_000,
      ),
    ).toBe(true);
    expect(
      markdown.every((content) => {
        const fences = content.match(/^```/gm) ?? [];
        return content.startsWith('```ts\n') && fences.length === 2;
      }),
    ).toBe(true);
    const reconstructed = markdown
      .map((content) => content.replace(/^```ts\n/, '').replace(/```\n?$/, ''))
      .join('');
    expect(reconstructed).toBe(codeBody);
  });

  it('does not insert newlines when a fenced code line exceeds the card element limit', async () => {
    const codeBody = `${'x'.repeat(60_000)}\n`;
    const longFinal = `\`\`\`json\n${codeBody}\`\`\`\n`;
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'final_text', content: longFinal },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async () => {
        throw new Error('final-only round must not open a progress stream');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_long_single_line_code', 'run'));
    await waitFor(() => finalCardMarkdown(h.channel).length > 1);

    const markdown = finalCardMarkdown(h.channel);
    const reconstructed = markdown
      .map((content) => content.replace(/^```json\n/, '').replace(/```\n?$/, ''))
      .join('');
    expect(reconstructed).toBe(codeBody);
  });

  it('pre-splits non-card final markdown below the SDK chunk limit', async () => {
    const codeBody = `${'y'.repeat(12_000)}\n`;
    const longFinal = `~~~~json\n${codeBody}~~~~\n`;
    const h = await createHarness({
      messageReply: 'markdown',
      events: [
        { type: 'final_text', content: longFinal },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async () => {
        throw new Error('final-only round must not open a progress stream');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_markdown_sdk_boundary', 'run'));
    await waitFor(() => {
      const reconstructed = markdownMessages(h.channel)
        .map((content) => content.replace(/^~~~~json\n/, '').replace(/~~~~\n?$/, ''))
        .join('');
      return reconstructed === codeBody;
    });

    expect(markdownMessages(h.channel).length).toBeGreaterThan(1);
    expect(markdownMessages(h.channel).every((chunk) => chunk.length < 3_500)).toBe(true);
    expect(
      h.channel.sent.every(({ content }) => 'post' in (content as Record<string, unknown>)),
    ).toBe(true);
  });

  it('opens a Codex status stream when the agent is silent after acceptance', async () => {
    const gate = deferred<void>();
    const markdownUpdates: string[] = [];
    const h = await createHarness({
      messageReply: 'markdown',
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: {
            messageId: string;
            setContent(markdown: string): Promise<void>;
          }) => Promise<void>;
        }).markdown;
        await producer?.({
          messageId: 'om_live_status',
          async setContent(markdown) {
            markdownUpdates.push(markdown);
          },
        });
        return { messageId: 'om_live_status' };
      },
    });
    vi.spyOn(h.agent, 'run').mockImplementation((opts): AgentRun => {
      h.agent.runOptions.push(opts);
      return {
        runId: opts.runId,
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
            await gate.promise;
            yield { type: 'done', terminationReason: 'normal' };
          },
        },
        async stop() {
          gate.resolve();
        },
        async waitForExit() {
          return true;
        },
      };
    });
    await startTestBridge(h);

    try {
      await h.channel.handlers.message?.(message('om_silent_status', 'run'));
      await waitFor(() => markdownUpdates.some((content) => content.includes('已受理')), 3_500);

      expect(markdownUpdates.at(-1)).toContain('任务正在运行');
      expect(markdownUpdates.filter((content) => content.includes('已受理'))).toHaveLength(1);
      gate.resolve();
      await waitFor(() => h.channel.sent.length === 1);
      await waitFor(() => h.channel.recalled.includes('om_live_status'));
      expect(allMarkdown(h.channel)).toContain('未返回内容');
    } finally {
      gate.resolve();
    }
  }, 5_000);

  it('shows accepted liveness in a Codex progress card while the agent is silent', async () => {
    const gate = deferred<void>();
    const cardUpdates: unknown[] = [];
    let streamCalls = 0;
    const h = await createHarness({
      messageReply: 'card',
      stream: async (_chatId, input) => {
        streamCalls += 1;
        const producer = (input as {
          card?: {
            producer?: (ctrl: {
              messageId: string;
              update(next: unknown | ((current: unknown) => unknown)): Promise<void>;
            }) => Promise<void>;
          };
        }).card?.producer;
        let current: unknown = {};
        await producer?.({
          messageId: 'om_live_status_card',
          async update(next) {
            current = typeof next === 'function' ? next(current) : next;
            cardUpdates.push(current);
          },
        });
        return { messageId: 'om_live_status_card' };
      },
    });
    vi.spyOn(h.agent, 'run').mockImplementation((opts): AgentRun => {
      h.agent.runOptions.push(opts);
      return {
        runId: opts.runId,
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
            await gate.promise;
            yield { type: 'done', terminationReason: 'normal' };
          },
        },
        async stop() {
          gate.resolve();
        },
        async waitForExit() {
          return true;
        },
      };
    });
    await startTestBridge(h);

    try {
      await h.channel.handlers.message?.(message('om_silent_status_card', 'run'));
      await waitFor(
        () => cardUpdates.some((card) => JSON.stringify(card).includes('已受理，任务正在运行')),
        3_500,
      );

      expect(streamCalls).toBe(1);
      expect(
        cardUpdates.filter((card) => JSON.stringify(card).includes('已受理，任务正在运行')),
      ).toHaveLength(1);
      gate.resolve();
      await waitFor(() => h.channel.sent.length === 1);
      await waitFor(() => h.channel.recalled.includes('om_live_status_card'));
      expect(finalCardMarkdown(h.channel).join('')).toContain('未返回内容');
    } finally {
      gate.resolve();
    }
  }, 5_000);

  it('opens no progress stream for a final-only Codex card round', async () => {
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'final_text', content: 'FINAL_ONLY_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamCalls.push(input);
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final_only', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(streamCalls).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(1);
    const finalJson = JSON.stringify(h.channel.sent[0]?.content);
    expect(finalJson).toContain('FINAL_ONLY_SENTINEL');
    expect(finalJson).not.toContain('collapsible_panel');
  });

  it('waits for a slow Codex progress card instead of sending a duplicate fallback', async () => {
    const progressCards: unknown[] = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'SLOW_PROGRESS_SENTINEL' },
        { type: 'final_text', content: 'SLOW_FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: {
            producer?: (ctrl: {
              update(next: unknown | ((current: unknown) => unknown)): Promise<void>;
            }) => Promise<void>;
          };
        }).card?.producer;
        await new Promise((resolve) => setTimeout(resolve, 200));
        let current: unknown = {};
        await producer?.({
          update: vi.fn(async (next: unknown | ((current: unknown) => unknown)) => {
            current = typeof next === 'function' ? next(current) : next;
            progressCards.push(current);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_slow_card', 'run'));
    await waitFor(() => progressCards.length > 0);
    await waitFor(() => h.channel.sent.length === 1);

    expect(h.channel.sent).toHaveLength(1);
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('SLOW_FINAL_SENTINEL');
  });

  it('does not update a Codex progress card after abandoning its slow producer', async () => {
    const gate = deferred<void>();
    const update = vi.fn(async () => {});
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'ABANDONED_PROGRESS_SENTINEL' },
        { type: 'final_text', content: 'ABANDONED_FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
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
        await gate.promise;
        await producer?.({ messageId: 'om_late_abandoned_progress', update });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_abandoned_card', 'run'));
    await waitFor(() => h.channel.sent.length === 2, 6000);
    gate.resolve();
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.sent).toHaveLength(2);
    expect(JSON.stringify(h.channel.sent[0]?.content)).toContain('ABANDONED_PROGRESS_SENTINEL');
    expect(JSON.stringify(h.channel.sent[1]?.content)).toContain('ABANDONED_FINAL_SENTINEL');
    expect(update).not.toHaveBeenCalled();
    await waitFor(() => h.channel.recalled.includes('om_late_abandoned_progress'));
  }, 15_000);

  it('recalls a late abandoned Codex markdown stream only after the authoritative final', async () => {
    const producerGate = deferred<void>();
    const deliveryOrder: string[] = [];
    const setContent = vi.fn(async () => {});
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'LATE_MARKDOWN_PROGRESS' },
        { type: 'final_text', content: 'LATE_MARKDOWN_FINAL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: {
            messageId: string;
            setContent(markdown: string): Promise<void>;
          }) => Promise<void>;
        }).markdown;
        await producerGate.promise;
        await producer?.({ messageId: 'om_late_markdown_progress', setContent });
        return { messageId: 'om_late_markdown_progress' };
      },
    });
    const send = h.channel.send.bind(h.channel);
    h.channel.send = vi.fn(async (chatId, content, options) => {
      deliveryOrder.push('post' in (content as Record<string, unknown>) ? 'final' : 'progress');
      await send(chatId, content, options);
      if (deliveryOrder.length === 1) {
        producerGate.resolve();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    const recallMessage = h.channel.recallMessage.bind(h.channel);
    h.channel.recallMessage = vi.fn(async (messageId) => {
      deliveryOrder.push('recall');
      await recallMessage(messageId);
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_late_markdown', 'run'));
    await waitFor(() => h.channel.recalled.includes('om_late_markdown_progress'), 8_000);
    await waitFor(() => deliveryOrder.includes('final'));

    expect(deliveryOrder.indexOf('final')).toBeLessThan(deliveryOrder.indexOf('recall'));
    expect(setContent).not.toHaveBeenCalled();
  }, 12_000);
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  events?: FakeAgentEvents;
  messageReply?: 'card' | 'markdown' | 'text';
  agentKind?: 'claude' | 'codex';
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
    agentKind: options.agentKind ?? 'codex',
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
    ...(options.agentKind === 'claude'
      ? {}
      : { codex: { binaryPath: '/usr/local/bin/codex' } }),
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
    id: options.agentKind ?? 'codex',
    displayName: options.agentKind === 'claude' ? 'Claude' : 'Codex',
    events: options.events ?? [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
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
    profile: 'codex',
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

function finalCards(channel: FakeLarkChannel): Array<{
  body?: { elements?: Array<{ tag?: string; content?: string }> };
}> {
  return channel.sent
    .map(({ content }) => (content as { card?: unknown } | undefined)?.card)
    .filter((card): card is {
      body?: { elements?: Array<{ tag?: string; content?: string }> };
    } => typeof card === 'object' && card !== null);
}

function finalCardMarkdown(channel: FakeLarkChannel): string[] {
  return finalCards(channel).flatMap((card) =>
    (card.body?.elements ?? [])
      .filter((element) => element.tag === 'markdown' && typeof element.content === 'string')
      .map((element) => element.content ?? ''),
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
