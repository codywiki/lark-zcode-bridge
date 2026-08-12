import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface RunOverrides {
  scope?: string;
  senderId?: string;
  chatId?: string;
  chatMode?: CommandContext['chatMode'];
  mentions?: NormalizedMessage['mentions'];
}

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: ReturnType<typeof createFakeAgent>;
  controls: Controls;
  run(content: string, overrides?: RunOverrides): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('Bridge command contracts', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('switches /cd to any existing non-risk working directory', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'plain-workdir');
    const file = join(h.tmp.workspace, 'not-a-directory.txt');
    await mkdir(target, { recursive: true });
    await writeFile(file, 'not a directory', 'utf8');

    await expect(h.run('/cd relative')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('绝对路径');

    await expect(h.run(`/cd ${file}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('路径不是目录');

    await expect(h.run(`/cd ${target}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换 cwd');
    expect(lastMarkdown(h.channel)).not.toContain('允许访问目录');
    await expect(realpath(target)).resolves.toBe(h.workspaces.cwdFor('chat-1'));

    await expect(h.run(`/cd ${h.tmp.workspace}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换 cwd');
    await expect(realpath(h.tmp.workspace)).resolves.toBe(h.workspaces.cwdFor('chat-1'));
  });

  it('scopes named workspaces by profile, scope, and owner', async () => {
    const h = await createHarness();
    const alternate = join(h.tmp.root, 'alternate');
    await mkdir(alternate, { recursive: true });

    h.workspaces.setCwd('chat-a', h.tmp.workspace);
    await expect(h.run('/ws save main', { scope: 'chat-a', chatId: 'chat-a' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('工作目录别名已保存');

    h.workspaces.setCwd('chat-b', alternate);
    await expect(h.run('/ws', { scope: 'chat-b', chatId: 'chat-b' })).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain('main');

    await expect(h.run('/ws use main', { scope: 'chat-b', chatId: 'chat-b' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('未找到工作目录别名');
    expect(h.workspaces.cwdFor('chat-b')).toBe(alternate);
  });

  it('continues to support legacy unscoped workspace aliases', async () => {
    const h = await createHarness();
    const legacy = join(h.tmp.root, 'legacy-alias');
    await mkdir(legacy, { recursive: true });
    h.workspaces.saveNamed('legacy', legacy);

    await expect(h.run('/ws')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('legacy');

    await expect(h.run('/ws use legacy')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换到 `legacy`');
    await expect(realpath(legacy)).resolves.toBe(h.workspaces.cwdFor('chat-1'));

    await expect(h.run('/ws remove legacy')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
    expect(h.workspaces.getNamed('legacy')).toBeUndefined();
  });

  it('removes scoped workspace aliases without deleting same-name legacy aliases', async () => {
    const h = await createHarness();
    const legacy = join(h.tmp.root, 'legacy-main');
    await mkdir(legacy, { recursive: true });
    h.workspaces.saveNamed('main', legacy);

    await expect(h.run('/ws save main')).resolves.toBe(true);
    await expect(h.run('/ws remove main')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
    expect(h.workspaces.getNamed('main')).toBe(legacy);

    await expect(h.run('/ws use main')).resolves.toBe(true);
    await expect(realpath(legacy)).resolves.toBe(h.workspaces.cwdFor('chat-1'));
  });

  it('keeps directory commands admin-only', async () => {
    const h = await createHarness();

    await expect(h.run(`/cd ${h.tmp.workspace}`, { senderId: 'ou-not-admin' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');

    await expect(h.run('/ws save mine', { senderId: 'ou-not-admin' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('allows Kimi directory commands in any profile-authorized workspace root', async () => {
    const h = await createHarness('kimi');
    const child = join(h.tmp.workspace, 'packages', 'app');
    const additionalRoot = join(h.tmp.root, 'authorized-project');
    const additionalChild = join(additionalRoot, 'packages', 'app');
    const outside = join(h.tmp.root, 'outside-project');
    await Promise.all([
      mkdir(child, { recursive: true }),
      mkdir(additionalChild, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    h.controls.profileConfig.workspaces.allowedRoots = [await realpath(additionalRoot)];

    await expect(h.run(`/cd ${child}`)).resolves.toBe(true);
    expect(h.workspaces.cwdFor('chat-1')).toBe(await realpath(child));

    await expect(h.run(`/cd ${additionalChild}`)).resolves.toBe(true);
    expect(h.workspaces.cwdFor('chat-1')).toBe(await realpath(additionalChild));
    await expect(h.run('/ws save secondary')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(await realpath(additionalChild));

    h.sessions.set('chat-1', 'session-must-survive-denial', await realpath(additionalChild));
    await expect(h.run(`/cd ${outside}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('Profile 授权工作目录及其子目录');
    expect(lastMarkdown(h.channel)).not.toContain(outside);
    expect(h.workspaces.cwdFor('chat-1')).toBe(await realpath(additionalChild));
    expect(h.sessions.resumeFor('chat-1', await realpath(additionalChild))).toBe(
      'session-must-survive-denial',
    );

    h.workspaces.setCwd('chat-1', outside);
    await expect(h.run('/ws save escaped')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('Profile 授权工作目录及其子目录');
    expect(lastMarkdown(h.channel)).not.toContain(outside);
    expect(Object.values(h.workspaces.listNamed())).not.toContain(await realpath(outside));

    h.workspaces.setCwd('chat-1', child);
    h.workspaces.saveNamed('legacy-outside', outside);
    await expect(h.run('/ws use legacy-outside')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('Profile 授权工作目录及其子目录');
    expect(lastMarkdown(h.channel)).not.toContain(outside);
    expect(h.workspaces.cwdFor('chat-1')).toBe(child);

    await expect(h.run('/ws')).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain(jsonStringFragment(await realpath(additionalChild)));
    expect(card).not.toContain(jsonStringFragment(outside));

    await expect(h.run('/ws use secondary')).resolves.toBe(true);
    expect(h.workspaces.cwdFor('chat-1')).toBe(await realpath(additionalChild));
  });

  it('does not inherit or render a Kimi cwd whose authorization was revoked in /new chat', async () => {
    const h = await createHarness('kimi');
    const revoked = join(h.tmp.root, 'revoked-project');
    await mkdir(revoked, { recursive: true });
    h.workspaces.setCwd('chat-1', revoked);
    const createChat = vi
      .fn()
      .mockResolvedValueOnce({ chatId: 'chat-new' })
      .mockResolvedValueOnce({ chatId: 'chat-authorized' });
    Object.assign(h.channel, {
      createChat,
    });

    await expect(h.run('/new chat Isolated')).resolves.toBe(true);

    expect(h.workspaces.cwdFor('chat-new')).toBeUndefined();
    const welcome = h.channel.sent.find((message) => message.chatId === 'chat-new');
    expect(JSON.stringify(welcome?.content)).toContain('群已建好');
    expect(JSON.stringify(welcome?.content)).not.toContain(revoked);

    const authorized = await realpath(h.tmp.workspace);
    h.workspaces.setCwd('chat-1', authorized);
    await expect(h.run('/new chat Authorized')).resolves.toBe(true);

    expect(h.workspaces.cwdFor('chat-authorized')).toBe(authorized);
    const authorizedWelcome = h.channel.sent.find(
      (message) => message.chatId === 'chat-authorized',
    );
    expect(JSON.stringify(authorizedWelcome?.content)).toContain('已继承获授权工作目录');
    expect(JSON.stringify(authorizedWelcome?.content)).not.toContain(authorized);
  });

  it('keeps Kimi group /cd and /ws save/use admin-only', async () => {
    const h = await createHarness('kimi');
    const child = join(h.tmp.workspace, 'packages');
    await mkdir(child, { recursive: true });

    await expect(
      h.run(`/cd ${child}`, { senderId: 'ou-not-admin', chatMode: 'group' }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
    expect(h.workspaces.cwdFor('chat-1')).toBe(await realpath(h.tmp.workspace));

    await expect(
      h.run('/ws save group', { senderId: 'ou-not-admin', chatMode: 'group' }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');

    h.workspaces.saveNamed('legacy-child', child);
    await expect(
      h.run('/ws use legacy-child', { senderId: 'ou-not-admin', chatMode: 'group' }),
    ).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
    expect(h.workspaces.cwdFor('chat-1')).toBe(await realpath(h.tmp.workspace));
  });

  it('keeps Kimi group session-state commands admin-only', async () => {
    const h = await createHarness('kimi');
    const cwd = await realpath(h.tmp.workspace);

    for (const command of ['/new', '/reset', '/stop', '/timeout 15', '/model kimi-k2']) {
      h.sessions.set('chat-1', 'sess-protected', cwd);
      await expect(
        h.run(command, { senderId: 'ou-not-admin', chatMode: 'group' }),
      ).resolves.toBe(true);
      expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
      expect(h.sessions.resumeFor('chat-1', cwd)).toBe('sess-protected');
      expect(h.sessions.getIdleTimeoutMinutes('chat-1')).toBeUndefined();
      expect(h.sessions.getModel('chat-1')).toBeUndefined();
    }

    await expect(h.run('/timeout 15', { chatMode: 'group' })).resolves.toBe(true);
    expect(h.sessions.getIdleTimeoutMinutes('chat-1')).toBe(15);
    await expect(h.run('/model kimi-k2', { chatMode: 'group' })).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('kimi-k2');
  });

  it('does not apply the Kimi group-only state gate to p2p or other agents', async () => {
    const kimi = await createHarness('kimi');
    const kimiCwd = await realpath(kimi.tmp.workspace);
    kimi.sessions.set('chat-1', 'sess-p2p', kimiCwd);

    await expect(
      kimi.run('/new', { senderId: 'ou-owner', chatMode: 'p2p' }),
    ).resolves.toBe(true);
    expect(kimi.sessions.resumeFor('chat-1', kimiCwd)).toBeUndefined();

    const claude = await createHarness('claude');
    await expect(
      claude.run('/timeout 12', { senderId: 'ou-not-admin', chatMode: 'group' }),
    ).resolves.toBe(true);
    expect(claude.sessions.getIdleTimeoutMinutes('chat-1')).toBe(12);
  });

  it('rejects Kimi /skill: activation case-insensitively without affecting Claude', async () => {
    const kimi = await createHarness('kimi');

    await expect(kimi.run('   /SKILL:local-secret')).resolves.toBe(true);
    expect(lastMarkdown(kimi.channel)).toContain('不允许通过 `/skill:` 激活本地 skill');
    expect(kimi.agent.runOptions).toEqual([]);

    const claude = await createHarness('claude');
    await expect(claude.run('   /SKILL:local-secret')).resolves.toBe(false);
    expect(claude.channel.sent).toEqual([]);
  });

  it('does not expose authorization root management commands', async () => {
    const h = await createHarness();
    const plain = join(h.tmp.root, 'plain-nongit');
    await mkdir(plain, { recursive: true });

    await expect(h.run(`/ws add ${plain} docs`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('用法');
    expect(lastMarkdown(h.channel)).not.toContain('允许访问目录');

    await expect(h.run(`/ws remove --root ${plain}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('未找到工作目录别名');
  });

  it('keeps /ws remove as alias removal by default', async () => {
    const h = await createHarness();

    await expect(h.run('/ws save main')).resolves.toBe(true);
    await expect(h.run('/ws remove main')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('已删除工作目录别名');
  });

  it('shows workspace paths in group-visible workspace replies', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-client-name');
    await mkdir(target, { recursive: true });
    const targetRealpath = await realpath(target);

    await expect(h.run(`/cd ${target}`, { chatMode: 'group' })).resolves.toBe(true);
    await expect(h.run('/ws save client', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('client');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws save main', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('工作目录别名已保存');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws', { chatMode: 'group' })).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain(jsonStringFragment(targetRealpath));
    expect(card).not.toContain('使用 $HOME');

    await expect(h.run('/ws use main', { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('已切换到 `main`');
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);
  });

  it('shows full workspace paths in p2p workspace replies', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-p2p-client');
    await mkdir(target, { recursive: true });
    const targetRealpath = await realpath(target);

    await expect(h.run(`/cd ${target}`)).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws save client')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain(targetRealpath);

    await expect(h.run('/ws')).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain(jsonStringFragment(targetRealpath));
  });

  it('shows invalid /cd paths in group-visible replies', async () => {
    const h = await createHarness();
    const file = join(h.tmp.root, 'sensitive-client-name', 'not-a-directory.txt');
    await mkdir(join(h.tmp.root, 'sensitive-client-name'), { recursive: true });
    await writeFile(file, 'not a directory', 'utf8');

    await expect(h.run(`/cd ${file}`, { chatMode: 'group' })).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('路径不是目录');
    expect(lastMarkdown(h.channel)).toContain(await realpath(file));
  });

  it('treats legacy document workspace commands as informational no-ops', async () => {
    const h = await createHarness();
    const target = join(h.tmp.root, 'sensitive-doc-root');
    await mkdir(target, { recursive: true });

    await expect(h.run(`/doc ws bind doc-token ${target}`, { chatMode: 'group' })).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('不需要绑定工作区');
    expect(lastMarkdown(h.channel)).not.toContain(target);
  });

  it('keeps Claude resume history details out of group chats', async () => {
    const h = await createHarness();

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('私聊');
    expect(lastMarkdown(h.channel)).not.toContain(h.tmp.workspace);
  });

  it('renders /status passively with policy and owner state', async () => {
    const h = await createHarness();

    await expect(h.run('/status')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(0);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('Fake Agent');
    expect(status).toContain('工作目录');
    expect(status).toContain('**session**');
    expect(status).toContain('(无)');
    expect(status).not.toContain('**conversation**');
    expect(status).toContain('permission');
    expect(status).toContain('plan');
    expect(status).not.toContain('bypassPermissions');
    expect(status).not.toContain('workspace-write/workspace-write');
    expect(status).toContain('owner');
    expect(status).toContain(jsonStringFragment(await realpath(h.tmp.workspace)));
  });

  it('shows workspace paths in group-visible /status replies', async () => {
    const h = await createHarness();

    await expect(h.run('/status', { chatMode: 'group' })).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain(jsonStringFragment(await realpath(h.tmp.workspace)));
    expect(status).toContain('chat-1');
  });

  it('redacts Kimi cwd and session details from group /status', async () => {
    const h = await createHarness('kimi');
    const cwd = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'sess-sensitive-secret', cwd);

    await expect(h.run('/status', { chatMode: 'group' })).resolves.toBe(true);

    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('群聊已隐藏');
    expect(status).not.toContain(jsonStringFragment(cwd));
    expect(status).not.toContain('sess-sen');
  });

  it('rejects admin-only commands for non owner/admin users', async () => {
    const h = await createHarness();

    await expect(
      h.run('/ps', { senderId: 'ou-not-admin' }),
    ).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
  });

  it('does not expose access allowlists through the Lark /config form', async () => {
    const h = await createHarness();

    await expect(h.run('/config')).resolves.toBe(true);

    const configCard = JSON.stringify(lastContent(h.channel));
    expect(configCard).not.toContain('allowed_users');
    expect(configCard).not.toContain('allowed_chats');
    expect(configCard).not.toContain('admins');
  });

  it('manages profile access lists through /invite and /remove', async () => {
    const h = await createHarness();

    await expect(
      h.run('/invite user @Alice', { mentions: [mention('ou-alice', 'Alice')] }),
    ).resolves.toBe(true);
    await expect(
      h.run('/invite admin @Bob', { mentions: [mention('ou-bob', 'Bob')] }),
    ).resolves.toBe(true);
    await expect(
      h.run('/invite group', {
        chatId: 'oc-group-1',
        scope: 'oc-group-1',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    let root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedUsers).toContain('ou-alice');
    expect(root?.profiles.claude?.access.admins).toEqual(['ou-admin', 'ou-bob']);
    expect(root?.profiles.claude?.access.allowedChats).toContain('oc-group-1');
    expect(root?.profiles.claude?.preferences).not.toHaveProperty('access');

    await expect(
      h.run('/remove user @Alice', { mentions: [mention('ou-alice', 'Alice')] }),
    ).resolves.toBe(true);
    root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedUsers).not.toContain('ou-alice');
  });

  it('reports an /invite persistence failure instead of silently swallowing it', async () => {
    const h = await createHarness();
    await writeFile(h.controls.configPath, '{ invalid json', 'utf8');

    await expect(
      h.run('/invite group', {
        chatId: 'oc-group-1',
        scope: 'oc-group-1',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('命令处理失败');
    expect(lastMarkdown(h.channel)).toContain('bridge 日志');
  });

  it('lets a Codex runtime update access when the shared config also contains Kimi', async () => {
    const h = await createHarness('codex');
    const root = await loadRootConfig(h.controls.configPath);
    expect(root).toBeDefined();
    root!.profiles.kimi = appConfig(await realpath(h.tmp.workspace), 'kimi');
    await saveRootConfig(root!, h.controls.configPath);

    await expect(
      h.run('/invite user @Alice', { mentions: [mention('ou-alice', 'Alice')] }),
    ).resolves.toBe(true);
    await expect(
      h.run('/invite group', {
        chatId: 'oc-group-1',
        scope: 'oc-group-1',
        chatMode: 'group',
      }),
    ).resolves.toBe(true);

    const saved = await loadRootConfig(h.controls.configPath);
    expect(saved?.profiles.codex?.access.allowedUsers).toContain('ou-alice');
    expect(saved?.profiles.codex?.access.allowedChats).toContain('oc-group-1');
    expect(saved?.profiles.kimi?.agentKind).toBe('kimi');
  });

  it('adds every known bot group through /invite all group', async () => {
    const h = await createHarness();
    h.controls.knownChats = [
      { id: 'oc-group-1', name: 'Group One' },
      { id: 'oc-group-2', name: 'Group Two' },
    ];

    await expect(h.run('/invite all group')).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.claude?.access.allowedChats).toEqual(['oc-group-1', 'oc-group-2']);
  });

  it('fails closed when a Kimi profile tries /invite all group', async () => {
    const h = await createHarness('kimi');
    h.controls.knownChats = [
      { id: 'oc-group-1', name: 'Group One' },
      { id: 'oc-group-2', name: 'Group Two' },
    ];

    await expect(h.run('/invite all group')).resolves.toBe(true);

    const root = await loadRootConfig(h.controls.configPath);
    expect(root?.profiles.kimi?.access.allowedChats).toEqual([]);
    expect(lastMarkdown(h.channel)).toContain('Kimi profile 禁止批量开放群聊');
    expect(lastMarkdown(h.channel)).toContain('/invite group');
  });
});

async function createHarness(agentKind: AgentKind = 'claude'): Promise<Harness> {
  const tmp = await createTmpProfile('commands-v1-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const workspaceRealpath = await realpath(tmp.workspace);
  const profileConfig = appConfig(workspaceRealpath, agentKind);
  const profile = agentKind;
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig(profile, profileConfig), configPath);
  const controls = {
    profile,
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  workspaces.setCwd('chat-1', workspaceRealpath);

  const run = (content: string, overrides: RunOverrides = {}): Promise<boolean> => {
    const chatId = overrides.chatId ?? 'chat-1';
    const scope = overrides.scope ?? chatId;
    return tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, {
        chatId,
        senderId: overrides.senderId ?? 'ou-admin',
        mentions: overrides.mentions ?? [],
      }),
      scope,
      chatMode: overrides.chatMode ?? 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
    });
  };

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, agent, controls, run };
}

function appConfig(defaultWorkspace: string, agentKind: AgentKind): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    preferences: { maxConcurrentRuns: 2 },
    ...(agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
    ...(agentKind === 'kimi' ? { kimi: { binaryPath: 'kimi' } } : {}),
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(
  content: string,
  opts: {
    chatId: string;
    senderId: string;
    mentions?: NormalizedMessage['mentions'];
  },
): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: opts.chatId,
    chatType: 'p2p',
    senderId: opts.senderId,
    senderName: 'User',
    content,
    resources: [],
    mentions: opts.mentions ?? [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function mention(openId: string, name: string): NonNullable<NormalizedMessage['mentions']>[number] {
  return {
    openId,
    name,
    isBot: false,
  } as NonNullable<NormalizedMessage['mentions']>[number];
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = lastContent(channel);
  expect(content.markdown).toBeTypeOf('string');
  return content.markdown as string;
}

function jsonStringFragment(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
