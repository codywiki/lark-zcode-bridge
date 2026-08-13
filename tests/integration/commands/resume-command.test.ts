import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { commandSessionCatalogIdentity } from '../../../src/bot/session-catalog-identity.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { canUseDm } from '../../../src/policy/access.js';
import { SessionCatalog, type SessionCatalogIdentity } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  controls: Controls;
  identity: SessionCatalogIdentity;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  run(content: string, options?: {
    withCatalogIdentity?: boolean;
    catalogIdentity?: SessionCatalogIdentity;
    chatMode?: 'p2p' | 'group' | 'topic';
  }): Promise<boolean>;
  dispatchResumeArg(arg: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('zcode catalog resume commands', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('archives only the current catalog entry when starting a new conversation', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      scopeId: 'chat-other',
      sessionId: 'sess-other-scope',
      now: 1000,
    });

    await expect(h.run('/new')).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(
      h.catalog.activeFor({ ...h.identity, scopeId: 'chat-other' }),
    ).toMatchObject({ sessionId: 'sess-other-scope' });
  });

  it('switches model by clearing the current resumable ZCode session', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'sess-current', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });

    await expect(h.run('/model glm-5.2')).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBeUndefined();
    expect(h.sessions.getModel('chat-1')).toBe('glm-5.2');
    expect(h.sessions.getReasoningEffort('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('下一条消息会启动新 session');
  });

  it('switches model and reasoning effort together via /model <id> <effort>', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'sess-current', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });

    await expect(h.run('/model glm-5.2 high')).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBeUndefined();
    expect(h.sessions.getModel('chat-1')).toBe('glm-5.2');
    expect(h.sessions.getReasoningEffort('chat-1')).toBe('high');
    expect(lastMarkdown(h.channel)).toContain('推理强度 `high`');
    expect(lastMarkdown(h.channel)).toContain('下一条消息会启动新 session');
  });

  it('rejects codex-vocabulary effort values without changing model state', async () => {
    const h = await createHarness();

    await expect(h.run('/model glm-5.2 ultra')).resolves.toBe(true);

    expect(h.sessions.getModel('chat-1')).toBeUndefined();
    expect(h.sessions.getReasoningEffort('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('max / high / nothink');
  });

  it('sets reasoning effort via /effort without resetting the session', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'sess-current', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });

    await expect(h.run('/effort nothink')).resolves.toBe(true);

    // Effort is per-request: the resumable session must stay intact.
    expect(h.sessions.getReasoningEffort('chat-1')).toBe('nothink');
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-current');
    expect(h.catalog.activeFor(h.identity)).toMatchObject({ sessionId: 'sess-current' });
    expect(lastMarkdown(h.channel)).toContain('推理强度 `nothink`');
    expect(lastMarkdown(h.channel)).toContain('会话保持连续');
  });

  it('accepts Chinese aliases and shows/clears the effort override', async () => {
    const h = await createHarness();

    await expect(h.run('/effort 高')).resolves.toBe(true);
    expect(h.sessions.getReasoningEffort('chat-1')).toBe('high');

    await expect(h.run('/effort')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('`high`');

    await expect(h.run('/effort default')).resolves.toBe(true);
    expect(h.sessions.getReasoningEffort('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('默认(max)');
  });

  it('rejects unknown /effort values without touching state', async () => {
    const h = await createHarness();
    h.sessions.setReasoningEffort('chat-1', 'high');

    await expect(h.run('/effort medium')).resolves.toBe(true);

    expect(h.sessions.getReasoningEffort('chat-1')).toBe('high');
    expect(lastMarkdown(h.channel)).toContain('max / high / nothink');
  });

  it('explains that cloud-document comments need no workspace binding', async () => {
    const h = await createHarness();

    await expect(h.run('/doc')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('不需要绑定工作区');
  });

  it('allows resume use only for the current cwd/policy catalog entry', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      policyFingerprint: 'stale-fp',
      sessionId: 'sess-stale',
      now: 1000,
    });

    await expect(h.run('/resume use sess-stale')).resolves.toBe(true);
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('不可恢复');

    await expect(h.run('/resume use sess-current')).resolves.toBe(true);
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-current');
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes the current catalog session through a nonce confirmation', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-current');
    expect(h.catalog.activeFor(h.identity)).toMatchObject({ sessionId: 'sess-current' });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes the current catalog session from the card button callback', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));

    await h.dispatchResumeArg(nonce);

    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-current');
    expect(h.catalog.activeFor(h.identity)).toMatchObject({ sessionId: 'sess-current' });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('falls back to an audit-safe reply when resume confirmation is rejected', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));
    const originalSend = h.channel.send.bind(h.channel);
    let attempts = 0;
    h.channel.send = async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('The messages do NOT pass the audit.') as Error & { code: number };
        err.code = 230028;
        throw err;
      }
      return originalSend(...args);
    };

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(attempts).toBe(2);
    expect(lastMarkdown(h.channel)).toBe('命令已处理。');
  });

  it('shows only a nonce for the current catalog-backed session in /resume', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current-secret', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('当前 ZCode session 可恢复');
    expect(lastMarkdown(h.channel)).toMatch(/\/resume use [a-f0-9-]+/);
    expect(lastMarkdown(h.channel)).not.toContain('sess-current-secret');
  });

  it('does not accept raw session ids from a different policy context', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({
      ...h.identity,
      policyFingerprint: 'stale-fp',
      sessionId: 'sess-stale',
      now: 1000,
    });

    await expect(h.run('/resume use sess-stale')).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('不可恢复');
  });

  it('does not fall back to legacy SessionStore when the catalog identity is missing', async () => {
    const h = await createHarness();
    h.sessions.set('chat-1', 'legacy-current', h.identity.cwdRealpath);

    await expect(
      h.run('/resume use cross-policy-session', { withCatalogIdentity: false }),
    ).resolves.toBe(true);

    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('legacy-current');
    expect(lastMarkdown(h.channel)).toContain('没有符合当前工作区和权限策略的 ZCode session');
  });

  it('shows an empty history card when no current session is recorded', async () => {
    const h = await createHarness();

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastContentString(h.channel)).toContain('此 cwd 下没有历史会话');
  });

  it('keeps resume session details out of group chats', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-group-secret', now: 1000 });

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    const rendered = lastContentString(h.channel);
    expect(rendered).toContain('私聊');
    expect(rendered).not.toContain('sess-group-secret');
  });

  it('labels /status as session while reading the recorded session id', async () => {
    const h = await createHarness();

    await expect(h.run('/status')).resolves.toBe(true);
    let status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).not.toContain('**thread**');
    expect(status).not.toContain('**conversation**');

    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current-visible', now: 1000 });
    await expect(h.run('/status')).resolves.toBe(true);

    status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('sess-cur');
  });

  it('requires a selected workspace before listing or applying resume', async () => {
    const h = await createHarness({ bindWorkspace: false, defaultWorkspace: false });

    await expect(h.run('/resume')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('请先使用 /cd');

    await expect(h.run('/resume use sess-anything')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('请先使用 /cd');
  });

  it('rejects resume use when the selected cwd no longer matches the catalog identity', async () => {
    const h = await createHarness();
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    const moved = join(h.tmp.root, 'moved-workspace');
    await mkdir(moved, { recursive: true });
    h.workspaces.setCwd('chat-1', await realpath(moved));

    await expect(h.run('/resume use sess-current')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('请先用 `/resume`');
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
  });
});

async function createHarness(
  options: { bindWorkspace?: boolean; defaultWorkspace?: boolean } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('resume-command-zcode-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const activeRuns = new ActiveRuns();
  const pending = new PendingQueue(60_000, () => {});
  const agent = createFakeAgent();
  const profileConfig = appConfig();
  const workspaceRealpath = await realpath(tmp.workspace);
  if (options.defaultWorkspace !== false) {
    profileConfig.workspaces.default = workspaceRealpath;
  }
  const controls = {
    profile: 'zcode',
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', workspaceRealpath);
  }
  const identity = await commandSessionCatalogIdentity({
    msg: message('/resume'),
    scope: 'chat-1',
    mode: 'p2p',
    workspaces,
    controls,
    access: canUseDm(profileConfig, controls, 'ou-user'),
  });
  const chatModeCache = {
    resolve: async () => 'p2p',
  } as unknown as ChatModeCache;

  const run = (
    content: string,
    runOptions: {
      withCatalogIdentity?: boolean;
      catalogIdentity?: SessionCatalogIdentity;
      chatMode?: 'p2p' | 'group' | 'topic';
    } = {},
  ): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: runOptions.chatMode ?? 'p2p',
      sessions,
      sessionCatalog: catalog,
      sessionCatalogIdentity:
        runOptions.withCatalogIdentity === false
          ? undefined
          : (runOptions.catalogIdentity ?? identity),
      workspaces,
      agent,
      activeRuns,
      controls,
    });

  const dispatchResumeArg = (arg: string): Promise<void> =>
    handleCardAction({
      channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent({ cmd: 'resume.use', arg }),
      sessions,
      sessionCatalog: catalog,
      workspaces,
      activeRuns,
      agent,
      controls,
      pending,
      chatModeCache,
    });

  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    catalog,
    controls,
    identity: identity as SessionCatalogIdentity,
    activeRuns,
    pending,
    run,
    dispatchResumeArg,
  };
}

function appConfig(): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind: 'zcode',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
    zcode: { runtimePath: '/usr/local/bin/zcode' },
  });
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function cardEvent(value: Record<string, unknown>): CardActionEvent {
  return {
    action: { value },
    chatId: 'chat-1',
    messageId: 'om-card',
    operator: {
      openId: 'ou-user',
      name: 'User',
    },
  } as unknown as CardActionEvent;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown as string;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastContentString(channel: FakeChannel): string {
  return JSON.stringify(lastContent(channel));
}

function resumeNonce(markdown: string): string {
  const match = markdown.match(/\/resume use ([a-f0-9-]+)/);
  const nonce = match?.[1];
  expect(nonce).toBeTypeOf('string');
  if (!nonce) throw new Error('missing resume nonce');
  return nonce;
}
