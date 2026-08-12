import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { runAgentBatch } from '../../../src/bot/channel.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import type { Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { LocalAttachment, MediaCache } from '../../../src/media/cache.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

const FORWARDED_TEXT = [
  '<forwarded_messages>',
  '[2026-08-01T12:00:00+08:00] User:',
  '    <file key="file_v3_html" name="aifuye-demo.html"/>',
  '</forwarded_messages>',
].join('\n');

describe('merge_forward attachment flow', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('downloads files inside a merged forward, paired to the owning sub-message', async () => {
    const h = await createHarness();
    const channel = createFakeChannel();
    stubForwardedTree(channel);
    const resolve = vi.fn(async () => [htmlAttachment()]);
    const controls = createControls(h, 'claude');

    await runAgentBatch({
      channel: channelAs(channel),
      executor: h.executor,
      sessions: h.sessions,
      workspaces: h.workspaces,
      media: { resolve } as unknown as MediaCache,
      batch: [mergeForwardMessage()],
      controls,
      activePolicyFingerprints: new Map(),
      scope: 'chat-1',
      mode: 'p2p',
    });

    // The sub-message id — not the merge_forward container — is what
    // im.v1.messageResource.get needs to download the bytes.
    expect(resolve).toHaveBeenCalledWith(
      [
        {
          messageId: 'om_sub_html',
          resource: { type: 'file', fileKey: 'file_v3_html', fileName: 'aifuye-demo.html' },
        },
      ],
      expect.anything(),
    );
    // The forwarded text block keeps its inline reference (filename context)…
    const prompt = h.agent.runOptions[0]?.prompt ?? '';
    expect(prompt).toContain('file_v3_html');
    // …and the downloaded attachment arrives with path + originalName so the
    // agent can map one onto the other.
    expect(prompt).toContain('"originalName":"aifuye-demo.html"');
    expect(prompt).toContain('/media/deadbeef.html');
  });

  it('rejects a Kimi merge_forward carrying files before any download', async () => {
    const h = await createHarness();
    const channel = createFakeChannel();
    stubForwardedTree(channel);
    const resolve = vi.fn(async () => []);
    const controls = createControls(h, 'kimi');

    await runAgentBatch({
      channel: channelAs(channel),
      executor: h.executor,
      sessions: h.sessions,
      workspaces: h.workspaces,
      media: { resolve } as unknown as MediaCache,
      batch: [mergeForwardMessage()],
      controls,
      activePolicyFingerprints: new Map(),
      scope: 'chat-1',
      mode: 'p2p',
    });

    // Before the fix the forwarded file slipped past the text-only gate
    // because the SDK reported zero resources for merge_forward parents.
    expect(resolve).not.toHaveBeenCalled();
    expect(h.agent.runOptions).toEqual([]);
    expect(JSON.stringify(channel.sent.at(-1)?.content)).toContain('附件也未下载');
  });

  it('downloads the file behind a quoted file message', async () => {
    const h = await createHarness();
    const channel = createFakeChannel();
    channel.fetchRawMessage = (async () => [
      {
        message_id: 'om_quoted_file',
        msg_type: 'file',
        body: {
          content: JSON.stringify({ file_key: 'file_v3_pdf', file_name: 'spec.pdf' }),
        },
        create_time: '1760000000000',
        sender: { id: 'ou_user' },
      },
    ]) as FakeChannel['fetchRawMessage'];
    const resolve = vi.fn(async () => []);
    const controls = createControls(h, 'claude');

    await runAgentBatch({
      channel: channelAs(channel),
      executor: h.executor,
      sessions: h.sessions,
      workspaces: h.workspaces,
      media: { resolve } as unknown as MediaCache,
      batch: [quoteReplyMessage()],
      controls,
      activePolicyFingerprints: new Map(),
      scope: 'chat-1',
      mode: 'p2p',
    });

    expect(resolve).toHaveBeenCalledWith(
      [
        {
          messageId: 'om_quoted_file',
          resource: { type: 'file', fileKey: 'file_v3_pdf', fileName: 'spec.pdf' },
        },
      ],
      expect.anything(),
    );
    expect(h.agent.runOptions[0]?.prompt).toContain('<quoted_messages>');
  });
});

function mergeForwardMessage(): NormalizedMessage {
  return {
    messageId: 'om_fwd',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-owner',
    senderName: 'Owner',
    content: FORWARDED_TEXT,
    rawContentType: 'merge_forward',
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function quoteReplyMessage(): NormalizedMessage {
  return {
    messageId: 'om_quote_reply',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-owner',
    senderName: 'Owner',
    content: '看下这个文件',
    rawContentType: 'text',
    resources: [],
    rootId: 'om_quoted_file',
    replyToMessageId: 'om_quoted_file',
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function stubForwardedTree(channel: FakeChannel): void {
  channel.fetchRawMessage = (async () => [
    {
      message_id: 'om_fwd',
      msg_type: 'merge_forward',
      body: { content: '{}' },
      create_time: '1760000000000',
      sender: { id: 'ou_user' },
    },
    {
      message_id: 'om_sub_text',
      upper_message_id: 'om_fwd',
      msg_type: 'text',
      body: { content: JSON.stringify({ text: '看看这个 demo' }) },
      create_time: '1760000001000',
      sender: { id: 'ou_user' },
    },
    {
      message_id: 'om_sub_html',
      upper_message_id: 'om_fwd',
      msg_type: 'file',
      body: {
        content: JSON.stringify({ file_key: 'file_v3_html', file_name: 'aifuye-demo.html' }),
      },
      create_time: '1760000002000',
      sender: { id: 'ou_user' },
    },
  ]) as FakeChannel['fetchRawMessage'];
}

function htmlAttachment(): LocalAttachment {
  return {
    absPath: '/media/deadbeef.html',
    path: '/media/deadbeef.html',
    kind: 'file',
    size: 128,
    mime: 'text/html',
    hash: 'deadbeef',
    source: 'lark',
    sourceMessageId: 'om_sub_html',
    sourceFileKey: 'file_v3_html',
    originalName: 'aifuye-demo.html',
    requiredness: 'optional',
    decision: 'accepted',
  };
}

function channelAs(channel: FakeChannel): Parameters<typeof runAgentBatch>[0]['channel'] {
  return channel as unknown as Parameters<typeof runAgentBatch>[0]['channel'];
}

function createControls(
  h: Awaited<ReturnType<typeof createHarness>>,
  agentKind: 'claude' | 'kimi',
): Controls {
  const profileConfig =
    agentKind === 'kimi'
      ? createDefaultProfileConfig({
          agentKind: 'kimi',
          accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
          kimi: { binaryPath: 'kimi' },
        })
      : h.profileConfig;
  return {
    profile: agentKind,
    profileConfig: {
      ...profileConfig,
      workspaces: { ...profileConfig.workspaces, default: h.workspace },
    },
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(h.tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
}

async function createHarness(): Promise<{
  tmp: TmpProfile;
  agent: FakeAgentAdapter;
  executor: RunExecutor;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  workspace: string;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
}> {
  const tmp = await createTmpProfile('forwarded-attachment-');
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
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
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    codex: { binaryPath: '/usr/local/bin/codex' },
  });
  const workspace = await realpath(tmp.workspace);
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  workspaces.setCwd('chat-1', tmp.workspace);
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    agent,
    executor,
    sessions,
    workspaces,
    workspace,
    profileConfig: {
      ...profileConfig,
      workspaces: { ...profileConfig.workspaces, default: workspace },
    },
  };
}
