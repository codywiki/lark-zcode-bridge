import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
import type { AccessMode } from '../../../src/config/permissions.js';
import {
  closeLogger,
  configureLogger,
  flushLogger,
  getLoggerConfig,
} from '../../../src/core/logger.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentRun } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pool: ProcessPool;
  agent: FakeAgentAdapter;
  controls: Controls;
  run(content: string, options?: {
    chatMode?: CommandContext['chatMode'];
    withRunExecutor?: boolean;
  }): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('/status and /doctor diagnostics', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('shows passive status for active run, queue, stale session, and owner API state', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    h.sessions.set('chat-1', 'sess-old', '/old');
    const activeRun = h.agent.run({ runId: 'run-active', prompt: 'running' }) as FakeAgentRun;
    h.activeRuns.register('chat-1', activeRun);
    const release = await h.pool.acquire();

    await expect(h.run('/status')).resolves.toBe(true);

    release();
    expect(h.agent.runOptions).toHaveLength(1);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('旧 cwd');
    expect(status).toContain('active run');
    expect(status).toContain('1/1 active');
    expect(status).toContain('owner API');
    expect(status).toContain('profile');
    expect(status).toContain('claude');
    expect(status).toContain('permission');
    expect(status).toContain('plan');
    expect(status).not.toContain('bypassPermissions');
  });

  it('runs only self-checks when no cwd is selected', async () => {
    const h = await createHarness({ configuredWorkspace: false, bindWorkspace: false });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdownOrText(h.channel)).toContain('未设置工作目录');
    expect(lastMarkdownOrText(h.channel)).toContain('self-check');
  });

  it('uses RunExecutor for a sessionless read-only agent echo check', async () => {
    const h = await createHarness({ configuredWorkspace: true });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);
    expect(opts.sessionId).toBeUndefined();
    expect(opts.threadId).toBeUndefined();
    expect(opts.images).toBeUndefined();
    expect(opts.permissionMode).toBe('plan');
    expect(opts.prompt).toContain('OK');
    const output = lastStreamCardJson(h.channel);
    expect(output).toContain('self-check');
    expect(output).toContain('profile');
    expect(output).toContain('claude');
    expect(output).toContain('workspace check');
    expect(output).toContain('policy check: ok permission=plan');
    expect(output).not.toContain('permission=bypassPermissions');
    expect(output).toContain('agent echo check');
    expect(output).toContain('OK');
  });

  it('uses the dedicated Codex final answer for the doctor echo check', async () => {
    const h = await createHarness({ configuredWorkspace: true, agentKind: 'codex' });
    h.agent.setEvents([
      { type: 'text', delta: 'progress that is not the echo result' },
      { type: 'final_text', content: 'OK' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    await expect(h.run('/doctor')).resolves.toBe(true);

    const output = lastStreamCardJson(h.channel);
    expect(output).toContain('agent echo check');
    expect(output).toContain('OK');
    expect(output).not.toContain('progress that is not the echo result');
  });

  it('uses the profile default workspace when the chat has no bound cwd', async () => {
    const h = await createHarness({
      configuredWorkspace: true,
      bindWorkspace: false,
      defaultWorkspace: true,
    });

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    const opts = h.agent.runOptions[0]!;
    await expect(realpath(h.tmp.workspace)).resolves.toBe(opts.cwd);

    await expect(h.run('/status')).resolves.toBe(true);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain(jsonStringContent(h.tmp.workspace));
    expect(status).not.toContain('工作目录已选择');
  });

  it('fast-fails the agent echo check when the process pool is full', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    const release = await h.pool.acquire();

    await expect(h.run('/doctor')).resolves.toBe(true);

    release();
    expect(h.agent.runOptions).toHaveLength(0);
    expect(lastMarkdownOrText(h.channel)).toContain('pool-full');
  });

  it('reports the enforced Kimi Seatbelt and ACP read-only boundary', async () => {
    const h = await createHarness({ configuredWorkspace: true, agentKind: 'kimi' });

    await expect(h.run('/status')).resolves.toBe(true);
    const status = JSON.stringify(lastContent(h.channel));
    expectKimiSafetyNotice(status);
    expect(status).not.toContain('不等同于操作系统只读沙箱');

    await expect(h.run('/doctor')).resolves.toBe(true);
    const doctor = lastStreamCardJson(h.channel);
    expectKimiSafetyNotice(doctor);
    expect(doctor).toContain('policy check: ok seatbelt=required acp-fs=read-only mode=default');
  });

  it('reports and executes the configured Kimi full-access policy', async () => {
    const h = await createHarness({
      configuredWorkspace: true,
      agentKind: 'kimi',
      accessMode: 'full',
    });

    await expect(h.run('/status')).resolves.toBe(true);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('full：Shell/编辑已开启');
    expect(status).toContain('Kimi yolo');
    expect(status).toContain('Seatbelt 已关闭');

    await expect(h.run('/doctor')).resolves.toBe(true);
    expect(h.agent.runOptions.at(-1)?.sandbox).toBe('danger-full-access');
    expect(lastStreamCardJson(h.channel)).toContain(
      'policy check: ok seatbelt=off acp-fs=read-write mode=yolo',
    );
  });

  it('skips the Kimi echo check when a legacy cwd is outside the profile root', async () => {
    const h = await createHarness({ configuredWorkspace: true, agentKind: 'kimi' });
    const outside = join(h.tmp.root, 'outside-workspace');
    await mkdir(outside, { recursive: true });
    h.workspaces.setCwd('chat-1', outside);

    await expect(h.run('/status')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).not.toContain(outside);

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(0);
    const doctor = lastMarkdownOrText(h.channel);
    expect(doctor).toContain('outside-profile-root');
    expect(doctor).toContain('Profile 授权工作目录及其子目录');
    expect(doctor).not.toContain(outside);
    expect(doctor).toContain('skipped');
  });

  it('runs the Kimi echo check from an additional authorized root', async () => {
    const h = await createHarness({ configuredWorkspace: true, agentKind: 'kimi' });
    const additionalRoot = join(h.tmp.root, 'authorized-project');
    const additionalCwd = join(additionalRoot, 'packages', 'app');
    await mkdir(additionalCwd, { recursive: true });
    h.controls.profileConfig.workspaces.allowedRoots = [await realpath(additionalRoot)];
    h.workspaces.setCwd('chat-1', additionalCwd);

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]?.cwd).toBe(await realpath(additionalCwd));
    expect(lastStreamCardJson(h.channel)).toContain('workspace check: ok');
  });

  it('redacts Kimi workspace paths from group-visible doctor early reports', async () => {
    const inaccessible = await createHarness({
      configuredWorkspace: true,
      agentKind: 'kimi',
    });
    const missingPath = join(inaccessible.tmp.root, 'missing-sensitive-project');
    inaccessible.workspaces.setCwd('chat-1', missingPath);

    await expect(
      inaccessible.run('/doctor', { chatMode: 'group' }),
    ).resolves.toBe(true);

    const inaccessibleReport = lastMarkdownOrText(inaccessible.channel);
    expect(inaccessibleReport).toContain('(群聊已隐藏)');
    expect(inaccessibleReport).toContain('path-inaccessible');
    expect(inaccessibleReport).not.toContain(missingPath);
    expect(inaccessible.agent.runOptions).toHaveLength(0);

    const noExecutor = await createHarness({
      configuredWorkspace: true,
      agentKind: 'kimi',
    });
    const authorized = await realpath(noExecutor.tmp.workspace);
    await expect(
      noExecutor.run('/doctor', { chatMode: 'group', withRunExecutor: false }),
    ).resolves.toBe(true);

    const noExecutorReport = lastMarkdownOrText(noExecutor.channel);
    expect(noExecutorReport).toContain('workspace: (群聊已隐藏)');
    expect(noExecutorReport).toContain('workspace check: ok (群聊已隐藏)');
    expect(noExecutorReport).not.toContain(authorized);
    expect(noExecutor.agent.runOptions).toHaveLength(0);
  });

  it('does not persist secret-bearing Kimi doctor startup errors', async () => {
    const h = await createHarness({ configuredWorkspace: true, agentKind: 'kimi' });
    const secret = 'TOP-SECRET-KIMI-DOCTOR-PROVIDER-ERROR';
    Object.assign(h.agent, {
      prepareRun: vi.fn(async () => {
        throw new Error(secret);
      }),
    });
    const logsDir = join(h.tmp.profile, 'logs');
    const previousLogger = getLoggerConfig();
    configureLogger({
      logsDir,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });

    try {
      await expect(h.run('/doctor')).resolves.toBe(true);
      await flushLogger();
      const logs = await readFile(join(logsDir, 'bridge-20260727.jsonl'), 'utf8');
      expect(logs).toContain('kimi-doctor-submit-failed');
      expect(logs).not.toContain(secret);
      expect(lastMarkdownOrText(h.channel)).toContain('failed');
    } finally {
      await closeLogger();
      configureLogger({
        logsDir: previousLogger.logsDir ?? '',
        retentionDays: previousLogger.retentionDays,
        now: previousLogger.now,
      });
    }
  });
});

async function createHarness(options: {
  configuredWorkspace: boolean;
  bindWorkspace?: boolean;
  defaultWorkspace?: boolean;
  agentKind?: AgentKind;
  accessMode?: AccessMode;
}): Promise<Harness> {
  const tmp = await createTmpProfile('doctor-status-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const pool = new ProcessPool(() => 1);
  const agent = new FakeAgentAdapter({
    events: [[{ type: 'text', delta: 'OK' }, { type: 'done', terminationReason: 'normal' }]],
  });
  const agentKind = options.agentKind ?? 'claude';
  const profileConfig = appConfig(
    options.configuredWorkspace ? tmp.workspace : undefined,
    agentKind,
    options.accessMode,
  );
  if (profileConfig.workspaces.default) {
    profileConfig.workspaces.default = await realpath(profileConfig.workspaces.default);
  }
  if (options.defaultWorkspace) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  const controls = {
    profile: agentKind,
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', tmp.workspace);
  }
  const executor = new RunExecutor({
    agent,
    pool,
    activeRuns,
    createRunId: () => 'doctor-run-1',
    now: () => 1_700_000_000_000,
    postDoneExitGraceMs: 10,
  });

  const run = (
    content: string,
    runOptions: {
      chatMode?: CommandContext['chatMode'];
      withRunExecutor?: boolean;
    } = {},
  ): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: runOptions.chatMode ?? 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      processPool: pool,
      runExecutor: runOptions.withRunExecutor === false ? undefined : executor,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, pool, agent, controls, run };
}

function appConfig(
  defaultWorkspace: string | undefined,
  agentKind: AgentKind,
  accessMode?: AccessMode,
): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    ...(agentKind === 'claude'
      ? { sandbox: { defaultMode: 'read-only' as const, maxMode: 'workspace-write' as const } }
      : {}),
    ...(agentKind === 'codex' ? { codex: { binaryPath: 'codex' } } : {}),
    ...(agentKind === 'kimi' ? { kimi: { binaryPath: 'kimi' } } : {}),
    ...(accessMode
      ? { permissions: { defaultAccess: accessMode, maxAccess: accessMode } }
      : {}),
  });
  if (defaultWorkspace) config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdownOrText(channel: FakeChannel): string {
  const content = lastContent(channel);
  const value = content.markdown ?? content.text;
  expect(value).toBeTypeOf('string');
  return value as string;
}

function lastStreamCardJson(channel: FakeChannel): string {
  const stream = channel.streams.at(-1);
  expect(stream).toBeDefined();
  const initial = (stream?.input as { card?: { initial?: unknown } } | undefined)?.card?.initial;
  return JSON.stringify(stream?.cardUpdates.at(-1) ?? initial);
}

function expectKimiSafetyNotice(value: string): void {
  expect(value).toContain('macOS Seatbelt + ACP 受控文本读取');
  expect(value).toContain('default 模式与拒绝审批');
  expect(value).toContain('写入');
  expect(value).toContain('进程执行');
  expect(value).toContain('附件');
  expect(value).toContain('MCP');
  expect(value).toContain('Skill');
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
