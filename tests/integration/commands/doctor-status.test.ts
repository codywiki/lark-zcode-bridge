import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import {
  createDefaultProfileConfig,
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
    expect(status).toContain('zcode');
    expect(status).toContain('mode');
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
    expect(output).toContain('zcode');
    expect(output).toContain('workspace check');
    expect(output).toContain('policy check: ok mode=read-only');
    expect(output).not.toContain('permission=bypassPermissions');
    expect(output).toContain('agent echo check');
    expect(output).toContain('OK');
  });

  it('uses the final answer event for the doctor echo check', async () => {
    const h = await createHarness({ configuredWorkspace: true });
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

  it('reports and executes the configured full-access policy', async () => {
    const h = await createHarness({
      configuredWorkspace: true,
      accessMode: 'full',
    });

    await expect(h.run('/status')).resolves.toBe(true);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('yolo');
    expect(status).toContain('完整权限');

    await expect(h.run('/doctor')).resolves.toBe(true);
    expect(h.agent.runOptions.at(-1)?.sandbox).toBe('danger-full-access');
    expect(lastStreamCardJson(h.channel)).toContain('policy check: ok mode=full');
  });

  it('runs the echo check from any accessible cwd outside the default workspace', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    const otherCwd = join(h.tmp.root, 'other-project', 'packages', 'app');
    await mkdir(otherCwd, { recursive: true });
    h.workspaces.setCwd('chat-1', otherCwd);

    await expect(h.run('/doctor')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]?.cwd).toBe(await realpath(otherCwd));
    expect(lastStreamCardJson(h.channel)).toContain('workspace check: ok');
  });

  it('reports an inaccessible cwd without starting the agent, even in groups', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    const missingPath = join(h.tmp.root, 'missing-sensitive-project');
    h.workspaces.setCwd('chat-1', missingPath);

    await expect(h.run('/doctor', { chatMode: 'group' })).resolves.toBe(true);

    const report = lastMarkdownOrText(h.channel);
    expect(report).toContain('path-inaccessible');
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('reports a missing run executor without starting the agent', async () => {
    const h = await createHarness({ configuredWorkspace: true });

    await expect(h.run('/doctor', { withRunExecutor: false })).resolves.toBe(true);

    const report = lastMarkdownOrText(h.channel);
    expect(report).toContain('workspace check: ok');
    expect(report).toContain('run executor unavailable');
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('does not persist secret-bearing doctor startup errors', async () => {
    const h = await createHarness({ configuredWorkspace: true });
    const secret = 'TOP-SECRET-ZCODE-DOCTOR-PROVIDER-ERROR';
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
      expect(logs).toContain('doctor.submit');
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
  const profileConfig = appConfig(
    options.configuredWorkspace ? tmp.workspace : undefined,
    options.accessMode,
  );
  if (profileConfig.workspaces.default) {
    profileConfig.workspaces.default = await realpath(profileConfig.workspaces.default);
  }
  if (options.defaultWorkspace) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  const controls = {
    profile: 'zcode',
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
  accessMode?: AccessMode,
): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'zcode',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only' as const, maxMode: 'workspace-write' as const },
    zcode: { runtimePath: '/usr/local/bin/zcode' },
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

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
