import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientSideConnection, type SessionNotification } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KIMI_RUNTIME_FAILURE_MESSAGE,
  KIMI_SUPPORTED_VERSION,
  KimiAdapter,
  type KimiAdapterOptions,
} from '../../src/agent/kimi/adapter.js';
import {
  KIMI_MAX_BUFFERED_ANSWER_BYTES,
  KIMI_OVERSIZED_ANSWER_MESSAGE,
  KimiAcpEventTranslator,
  sanitizeKimiVisibleText,
} from '../../src/agent/kimi/events.js';
import type { AgentEvent } from '../../src/agent/types.js';
import { ActiveRuns } from '../../src/bot/active-runs.js';
import { ProcessPool } from '../../src/bot/process-pool.js';
import { initialState, reduce } from '../../src/card/run-state.js';
import { renderCard } from '../../src/card/run-renderer.js';
import {
  closeLogger,
  configureLogger,
  flushLogger,
  getLoggerConfig,
} from '../../src/core/logger.js';
import type { RunPolicyAllow } from '../../src/policy/run-policy.js';
import { RunExecutor } from '../../src/runtime/run-executor.js';

interface FakeKimi {
  path: string;
  dir: string;
  recordPath: string;
}

interface FakeRecord {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  messages: Array<Record<string, unknown>>;
  responses: Array<Record<string, unknown>>;
  signal?: string;
}

interface FakeSandboxExec {
  path: string;
  recordPath: string;
}

describe('KimiAdapter ACP process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('accepts only the audited Kimi version', async () => {
    const supported = await createFakeKimi({ updates: [], version: KIMI_SUPPORTED_VERSION });
    const unsupported = await createFakeKimi({ updates: [], version: '0.30.0' });
    cleanup.push(supported.dir, unsupported.dir);

    const supportedAdapter = newTestKimiAdapter({
      binary: supported.path,
      profileStateDir: supported.dir,
    });
    const unsupportedAdapter = newTestKimiAdapter({
      binary: unsupported.path,
      profileStateDir: unsupported.dir,
    });
    await expect(supportedAdapter.checkAvailability()).resolves.toEqual({
      ok: true,
      version: KIMI_SUPPORTED_VERSION,
    });
    await expect(supportedAdapter.prepareRun()).resolves.toBeUndefined();
    await expect(unsupportedAdapter.checkAvailability()).resolves.toMatchObject({
      ok: false,
      diagnostic: {
        code: 'agent-version-check-unsupported-version',
        expected: KIMI_SUPPORTED_VERSION,
        actual: '0.30.0',
      },
    });
    await expect(unsupportedAdapter.prepareRun()).rejects.toMatchObject({
      code: 'agent-version-check-unsupported-version',
      diagnostic: {
        expected: KIMI_SUPPORTED_VERSION,
        actual: '0.30.0',
      },
    });
  });

  it('runs the ACP lifecycle, injects bridge context, and translates streamed events', async () => {
    const fake = await createFakeKimi({
      stderr: 'ACP diagnostic only\n',
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'considering' } },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          title: 'Read',
          kind: 'read',
          status: 'in_progress',
          rawInput: { path: 'README.md' },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'completed',
          rawOutput: 'file contents',
        },
      ],
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cachedReadTokens: 3,
        thoughtTokens: 2,
      },
    });
    cleanup.push(fake.dir);
    const cwd = await realpath(fake.dir);
    const profileStateDir = join(fake.dir, 'profile');
    const adapter = newTestKimiAdapter({
      binary: fake.path,
      profileStateDir,
      larkChannel: {
        profile: 'kimi-dev',
        rootDir: join(fake.dir, 'channel-home'),
        larkCliConfigDir: join(fake.dir, 'lark-cli'),
        larkCliSourceConfigFile: join(fake.dir, 'source-config.json'),
      },
    });
    adapter.setBotIdentity({ openId: 'ou_kimi_bot', name: 'Kimi' });

    const run = adapter.run({ runId: 'run-fresh', prompt: 'hello from lark', cwd });
    expect(run.runId).toBe('run-fresh');
    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-new' },
      { type: 'progress' },
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { path: 'README.md' },
      },
      { type: 'tool_result', id: 'tool-1', output: 'Kimi Read completed.', isError: false },
      { type: 'text', delta: 'hello' },
      {
        type: 'usage',
        inputTokens: 12,
        outputTokens: 8,
        cachedInputTokens: 3,
        reasoningOutputTokens: 2,
      },
      { type: 'done', sessionId: 'sess-new', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(1_000)).toBe(true);

    const record = await readRecord(fake.recordPath);
    expect(record.argv).toEqual(['acp']);
    expect(await realpath(record.cwd)).toBe(await realpath(join(profileStateDir, 'kimi-home')));
    expect(record.env).toMatchObject({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'kimi-dev',
      LARK_CHANNEL_HOME: join(fake.dir, 'channel-home'),
      LARK_CHANNEL_CONFIG: join(fake.dir, 'source-config.json'),
      LARKSUITE_CLI_CONFIG_DIR: join(fake.dir, 'lark-cli'),
      LARK_CHANNEL_IMAGE_DIR: join(profileStateDir, 'images'),
      KIMI_CODE_HOME: join(profileStateDir, 'kimi-home'),
      KIMI_CODE_CACHE_DIR: join(profileStateDir, 'kimi-home', 'cache'),
      TMPDIR: join(profileStateDir, 'kimi-home', 'tmp'),
      SHELL: '/usr/bin/false',
      KIMI_DISABLE_TELEMETRY: '1',
      KIMI_DISABLE_CRON: '1',
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: 'false',
    });

    const initialize = request(record, 'initialize');
    expect(initialize.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      },
    });
    expect(request(record, 'session/new').params).toEqual({ cwd, mcpServers: [] });
    expect(request(record, 'session/set_mode').params).toEqual({
      sessionId: 'sess-new',
      modeId: 'default',
    });
    expect(methods(record).indexOf('session/set_mode')).toBeLessThan(
      methods(record).indexOf('session/prompt'),
    );
    const prompt = request(record, 'session/prompt').params as {
      sessionId: string;
      prompt: Array<{ type: string; text: string }>;
    };
    expect(prompt.sessionId).toBe('sess-new');
    expect(prompt.prompt[0]?.text).toContain('lark-channel-bridge 运行约定');
    expect(prompt.prompt[0]?.text).toContain('ou_kimi_bot');
    expect(prompt.prompt[0]?.text).toContain('hello from lark');
    expect(prompt.prompt[0]?.text).toContain('Kimi 只读试点约束');
    expect(prompt.prompt[0]?.text).toContain('不要尝试附件、Shell、Git、rg、网络、写入');
    expect(prompt.prompt[0]?.text).toContain('不要声称这些操作已经执行');
  });

  it('resumes without replay and selects a requested model through session/set_model', async () => {
    const fake = await createFakeKimi({ updates: [] });
    cleanup.push(fake.dir);
    const adapter = newTestKimiAdapter({ binary: fake.path, profileStateDir: fake.dir });
    const run = adapter.run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: await realpath(fake.dir),
      sessionId: 'sess-old',
      model: 'kimi/k2',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-old' },
      { type: 'done', sessionId: 'sess-old', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(1_000)).toBe(true);
    const record = await readRecord(fake.recordPath);
    expect(methods(record)).toEqual([
      'initialize',
      'session/resume',
      'session/set_model',
      'session/set_mode',
      'session/prompt',
    ]);
    expect(request(record, 'session/resume').params).toMatchObject({
      sessionId: 'sess-old',
      mcpServers: [],
    });
    expect(request(record, 'session/set_model').params).toEqual({
      sessionId: 'sess-old',
      modelId: 'kimi/k2',
    });
  });

  it('selects the configured default model when no run override is set', async () => {
    const fake = await createFakeKimi({ updates: [] });
    cleanup.push(fake.dir);
    const adapter = newTestKimiAdapter({
      binary: fake.path,
      defaultModel: ' kimi-code/k3 ',
      profileStateDir: fake.dir,
    });
    const run = adapter.run({
      runId: 'run-default-model',
      prompt: 'hello',
      cwd: await realpath(fake.dir),
    });

    await collect(run.events);
    expect(await run.waitForExit(1_000)).toBe(true);
    const record = await readRecord(fake.recordPath);
    expect(methods(record)).toEqual([
      'initialize',
      'session/new',
      'session/set_model',
      'session/set_mode',
      'session/prompt',
    ]);
    expect(request(record, 'session/set_model').params).toEqual({
      sessionId: 'sess-new',
      modelId: 'kimi-code/k3',
    });
  });

  it('lets a run model override the configured Kimi default model', async () => {
    const fake = await createFakeKimi({ updates: [] });
    cleanup.push(fake.dir);
    const adapter = newTestKimiAdapter({
      binary: fake.path,
      defaultModel: 'kimi-code/k3',
      profileStateDir: fake.dir,
    });
    const run = adapter.run({
      runId: 'run-explicit-model',
      prompt: 'hello',
      cwd: await realpath(fake.dir),
      model: 'kimi-code/k3-256k',
    });

    await collect(run.events);
    expect(await run.waitForExit(1_000)).toBe(true);
    expect(request(await readRecord(fake.recordPath), 'session/set_model').params).toEqual({
      sessionId: 'sess-new',
      modelId: 'kimi-code/k3-256k',
    });
  });

  it('does not inherit host API keys or undeclared bridge-prefixed secrets', async () => {
    const fake = await createFakeKimi({ updates: [] });
    cleanup.push(fake.dir);
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalBridgeSecret = process.env.LARK_CHANNEL_PRIVATE_SECRET;
    const originalShell = process.env.SHELL;
    process.env.OPENAI_API_KEY = 'host-api-key-must-not-leak';
    process.env.LARK_CHANNEL_PRIVATE_SECRET = 'bridge-prefix-must-not-leak';
    process.env.SHELL = join(fake.dir, 'attacker-controlled-shell');
    try {
      const run = newTestKimiAdapter({
        binary: fake.path,
        profileStateDir: join(fake.dir, 'profile'),
        larkChannel: { profile: 'kimi-safe-env' },
      }).run({
        runId: 'run-safe-env',
        prompt: 'hello',
        cwd: await realpath(fake.dir),
      });
      await collect(run.events);
      expect(await run.waitForExit(1_000)).toBe(true);
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
      if (originalBridgeSecret === undefined) delete process.env.LARK_CHANNEL_PRIVATE_SECRET;
      else process.env.LARK_CHANNEL_PRIVATE_SECRET = originalBridgeSecret;
      if (originalShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = originalShell;
    }

    const record = await readRecord(fake.recordPath);
    expect(record.env.OPENAI_API_KEY).toBeUndefined();
    expect(record.env.LARK_CHANNEL_PRIVATE_SECRET).toBeUndefined();
    expect(record.env.LARK_CHANNEL).toBe('1');
    expect(record.env.LARK_CHANNEL_PROFILE).toBe('kimi-safe-env');
    expect(record.env.SHELL).toBe('/usr/bin/false');
    expect(record.env.HOME).toBeUndefined();
  });

  it('falls back to session/load and suppresses replayed history', async () => {
    const fake = await createFakeKimi({
      resume: false,
      historyUpdate: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'old history must stay hidden' },
      },
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live answer' } },
      ],
    });
    cleanup.push(fake.dir);
    const run = newTestKimiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-load',
      prompt: 'continue',
      cwd: await realpath(fake.dir),
      sessionId: 'sess-load',
    });

    expect(await collect(run.events)).toEqual([
      { type: 'system', sessionId: 'sess-load' },
      { type: 'progress' },
      { type: 'text', delta: 'live answer' },
      { type: 'done', sessionId: 'sess-load', terminationReason: 'normal' },
    ]);
    expect(await run.waitForExit(1_000)).toBe(true);
    expect(methods(await readRecord(fake.recordPath))).toEqual([
      'initialize',
      'session/load',
      'session/set_mode',
      'session/prompt',
    ]);
  });

  it('rejects permission requests instead of silently approving them', async () => {
    const fake = await createFakeKimi({
      permissionRequest: {
        sessionId: 'sess-new',
        options: [
          { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
        toolCall: { toolCallId: 'danger', title: 'Bash', status: 'pending' },
      },
      updates: [],
    });
    cleanup.push(fake.dir);
    const run = newTestKimiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-permission',
      prompt: 'dangerous action',
      cwd: await realpath(fake.dir),
    });

    expect((await collect(run.events)).at(-1)).toEqual({
      type: 'done',
      sessionId: 'sess-new',
      terminationReason: 'normal',
    });
    expect(await run.waitForExit(1_000)).toBe(true);
    const record = await readRecord(fake.recordPath);
    expect(record.responses).toContainEqual({
      jsonrpc: '2.0',
      id: 900,
      result: { outcome: { outcome: 'selected', optionId: 'reject' } },
    });
  });

  it('enables Kimi full access with yolo mode, writable ACP fs, and per-run approval', async () => {
    const fake = await createFakeKimi({
      permissionRequest: {
        sessionId: 'sess-new',
        options: [
          { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
          { optionId: 'approve_always', name: 'Approve always', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
        toolCall: { toolCallId: 'shell', title: 'Bash', status: 'pending' },
      },
      updates: [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'shell',
          title: 'Bash: pwd',
          kind: 'execute',
          status: 'completed',
          rawInput: { command: 'pwd' },
        },
      ],
    });
    cleanup.push(fake.dir);
    const profileStateDir = join(fake.dir, 'profile');
    const run = newTestKimiAdapter({ binary: fake.path, profileStateDir }).run({
      runId: 'run-full-access',
      prompt: 'run and edit',
      cwd: await realpath(fake.dir),
      sandbox: 'danger-full-access',
    });

    expect(await collect(run.events)).toContainEqual({
      type: 'tool_use',
      id: 'shell',
      name: 'Bash',
      input: { command: 'pwd' },
    });
    expect(await run.waitForExit(1_000)).toBe(true);

    const record = await readRecord(fake.recordPath);
    expect(request(record, 'initialize').params).toMatchObject({
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
    expect(request(record, 'session/set_mode').params).toEqual({
      sessionId: 'sess-new',
      modeId: 'yolo',
    });
    expect(record.responses).toContainEqual({
      jsonrpc: '2.0',
      id: 900,
      result: { outcome: { outcome: 'selected', optionId: 'approve_once' } },
    });
    const prompt = request(record, 'session/prompt').params as {
      prompt: Array<{ text: string }>;
    };
    expect(prompt.prompt[0]?.text).not.toContain('Kimi 只读试点约束');
    expect(record.env.SHELL).not.toBe('/usr/bin/false');

    const config = await readFile(join(profileStateDir, 'kimi-home', 'config.toml'), 'utf8');
    expect(config).toContain('default_permission_mode = "yolo"');
    expect(config).not.toContain('decision = "deny"\npattern = "Bash"');
    expect(config).not.toContain('[tools]');
  });

  it('lets Kimi full-access Read and Edit callbacks operate outside cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fake-kimi-full-fs-'));
    cleanup.push(root);
    const workspace = join(root, 'workspace');
    const outsideRead = join(root, '.env');
    const outsideWrite = join(root, 'outside', 'edited.txt');
    await mkdir(workspace);
    await writeFile(outsideRead, 'TOKEN=full-access\n', 'utf8');
    const fake = await createFakeKimi({
      fixedDir: join(root, 'fake'),
      updates: [],
      fsScenario: {
        sessionId: 'sess-new',
        wrongSessionId: 'sess-wrong',
        readPath: outsideRead,
        writePath: outsideWrite,
      },
    });
    const run = newTestKimiAdapter({
      binary: fake.path,
      profileStateDir: join(root, 'profile'),
    }).run({
      runId: 'run-full-fs',
      prompt: 'read and edit outside cwd',
      cwd: await realpath(workspace),
      sandbox: 'danger-full-access',
    });

    expect((await collect(run.events)).at(-1)).toMatchObject({
      type: 'done',
      terminationReason: 'normal',
    });
    expect(await run.waitForExit(1_000)).toBe(true);
    await expect(readFile(outsideWrite, 'utf8')).resolves.toBe('must not be written');
    const record = await readRecord(fake.recordPath);
    expect(record.responses).toContainEqual({
      jsonrpc: '2.0',
      id: 901,
      result: { content: 'TOKEN=full-access\n' },
    });
    expect(record.responses).toContainEqual({
      jsonrpc: '2.0',
      id: 903,
      result: {},
    });
  });

  it('serves workspace reads over reverse ACP and rejects wrong-session reads and all writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fake-kimi-reverse-fs-'));
    const workspace = join(root, 'workspace');
    const readPath = join(workspace, 'src', 'hello.txt');
    const writePath = join(workspace, 'new-parent', 'created.txt');
    await mkdir(join(readPath, '..'), { recursive: true });
    await writeFile(readPath, 'hello over ACP\n', 'utf8');
    const fake = await createFakeKimi({
      updates: [],
      fixedDir: root,
      fsScenario: {
        sessionId: 'sess-new',
        wrongSessionId: 'sess-other',
        readPath,
        writePath,
      },
    });
    cleanup.push(fake.dir);
    const sdkConsoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const run = newTestKimiAdapter({
      binary: fake.path,
      profileStateDir: join(fake.dir, 'profile'),
    }).run({
      runId: 'run-reverse-fs',
      prompt: 'read safely',
      cwd: await realpath(workspace),
    });
    expect((await collect(run.events)).at(-1)).toMatchObject({
      type: 'done',
      sessionId: 'sess-new',
    });
    expect(await run.waitForExit(1_000)).toBe(true);

    const record = await readRecord(fake.recordPath);
    expect(response(record, 901)).toMatchObject({ result: { content: 'hello over ACP\n' } });
    expect(response(record, 902)).toMatchObject({ error: { code: -32602 } });
    expect(JSON.stringify(response(record, 902))).toMatch(/wrong sessionId/i);
    expect(response(record, 903)).toMatchObject({ error: { code: -32602 } });
    expect(JSON.stringify(response(record, 903))).toMatch(/writes are disabled/i);
    const rejectedRequestLogs = JSON.stringify(sdkConsoleError.mock.calls);
    expect(sdkConsoleError).toHaveBeenCalled();
    expect(rejectedRequestLogs).toContain('[redacted]');
    expect(rejectedRequestLogs).not.toContain(readPath);
    expect(rejectedRequestLogs).not.toContain(writePath);
    expect(rejectedRequestLogs).not.toContain('sess-other');
    expect(rejectedRequestLogs).not.toContain('must not be written');
    await expect(readFile(writePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(realpath(join(writePath, '..'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fully suppresses malformed ACP JSON log payloads', async () => {
    const malformed =
      '{"content":"prefix \\"quoted-secret\\" trailing-secret","sessionId":"sess-secret","path":"/Users/alice/secret" BROKEN}';
    const fake = await createFakeKimi({ updates: [], malformedStdout: malformed });
    cleanup.push(fake.dir);
    const sdkConsoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = newTestKimiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-malformed-acp-log',
      prompt: 'hello',
      cwd: await realpath(fake.dir),
    });

    expect((await collect(run.events)).at(-1)).toMatchObject({ type: 'done' });
    expect(await run.waitForExit(1_000)).toBe(true);
    const logs = JSON.stringify(sdkConsoleError.mock.calls);
    expect(logs).toContain('Failed to parse JSON message:');
    expect(logs).toContain('[redacted]');
    expect(logs).not.toContain('quoted-secret');
    expect(logs).not.toContain('trailing-secret');
    expect(logs).not.toContain('sess-secret');
    expect(logs).not.toContain('/Users/alice');
  });

  it('fully suppresses arbitrary payloads from failed unknown ACP requests', async () => {
    const fake = await createFakeKimi({
      updates: [],
      unknownRequest: {
        method: 'terminal/create',
        params: {
          command: 'echo TOP-SECRET-COMMAND',
          body: 'TOP-SECRET-BODY',
          args: ['/Users/alice/private-argument'],
          env: { PRIVATE_TOKEN: 'TOP-SECRET-TOKEN' },
        },
      },
    });
    cleanup.push(fake.dir);
    const sdkConsoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = newTestKimiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-unknown-acp-log',
      prompt: 'hello',
      cwd: await realpath(fake.dir),
    });

    expect((await collect(run.events)).at(-1)).toMatchObject({ type: 'done' });
    expect(await run.waitForExit(1_000)).toBe(true);
    const logs = JSON.stringify(sdkConsoleError.mock.calls);
    expect(logs).toContain('Error handling request');
    expect(logs).toContain('[redacted]');
    expect(logs).not.toContain('TOP-SECRET');
    expect(logs).not.toContain('/Users/alice');
    expect(logs).not.toContain('PRIVATE_TOKEN');
  });

  it('rejects a session/new id that differs from the reverse filesystem claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fake-kimi-claimed-session-'));
    const workspace = join(root, 'workspace');
    const readPath = join(workspace, 'claim.txt');
    await mkdir(workspace, { recursive: true });
    await writeFile(readPath, 'claim', 'utf8');
    const fake = await createFakeKimi({
      updates: [],
      fixedDir: root,
      newSessionId: 'sess-returned',
      fsScenario: {
        sessionId: 'sess-claimed',
        wrongSessionId: 'sess-other',
        readPath,
        writePath: join(workspace, 'never-created.txt'),
      },
    });
    cleanup.push(fake.dir);
    const run = newTestKimiAdapter({
      binary: fake.path,
      profileStateDir: join(root, 'profile'),
    }).run({
      runId: 'run-claim-mismatch',
      prompt: 'hello',
      cwd: await realpath(workspace),
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((events[0] as { message: string }).message).toBe(KIMI_RUNTIME_FAILURE_MESSAGE);
    expect(JSON.stringify(events)).not.toContain('session/new returned a different sessionId');
    expect(methods(await readRecord(fake.recordPath))).not.toContain('session/prompt');
  });

  it('fails unsupported model selection without exposing provider detail', async () => {
    const fake = await createFakeKimi({ updates: [], rejectModel: true });
    cleanup.push(fake.dir);
    const run = newTestKimiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-bad-model',
      prompt: 'hi',
      cwd: await realpath(fake.dir),
      model: 'missing-model',
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((events[0] as { message: string }).message).toBe(KIMI_RUNTIME_FAILURE_MESSAGE);
    expect(JSON.stringify(events)).not.toMatch(/missing-model|model selection unsupported/i);
    expect(methods(await waitForRecord(fake.recordPath))).not.toContain('session/prompt');
  });

  it('fails closed when the ACP agent cannot enter required manual mode', async () => {
    const fake = await createFakeKimi({ updates: [], rejectMode: true });
    cleanup.push(fake.dir);
    const run = newTestKimiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-no-plan',
      prompt: 'hi',
      cwd: await realpath(fake.dir),
    });

    const events = await collect(run.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect((events[0] as { message: string }).message).toBe(KIMI_RUNTIME_FAILURE_MESSAGE);
    expect(JSON.stringify(events)).not.toMatch(/manual mode unsupported|required manual mode/i);
    expect(methods(await waitForRecord(fake.recordPath))).not.toContain('session/prompt');
  });

  it('does not expose authentication or local-profile details to chat users', async () => {
    const sensitive = 'Authentication required; run kimi login using /Users/alice/.kimi-code/config.toml';
    const fake = await createFakeKimi({ updates: [], authError: sensitive });
    cleanup.push(fake.dir);
    const run = newTestKimiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-auth-required',
      prompt: 'hi',
      cwd: await realpath(fake.dir),
    });

    const events = await collect(run.events);
    expect(events).toEqual([
      {
        type: 'error',
        message: KIMI_RUNTIME_FAILURE_MESSAGE,
        terminationReason: 'failed',
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/Authentication required|\/Users\/alice|kimi login/);
  });

  it('never persists provider errors, model values, permission ids, or cancel errors', async () => {
    const providerSecret = 'TOP-SECRET-PROVIDER-ERROR';
    const modelSecret = 'TOP-SECRET-MODEL-VALUE';
    const permissionSecret = 'TOP-SECRET-PERMISSION-ID';
    const cancelSecret = 'TOP-SECRET-CANCEL-ERROR';
    const logsDir = await mkdtemp(join(tmpdir(), 'kimi-safe-logs-'));
    cleanup.push(logsDir);
    const previousLogger = getLoggerConfig();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configureLogger({
      logsDir,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });

    try {
      const failed = await createFakeKimi({ updates: [], authError: providerSecret });
      const permission = await createFakeKimi({
        updates: [],
        permissionRequest: {
          sessionId: permissionSecret,
          options: [
            {
              optionId: permissionSecret,
              name: permissionSecret,
              kind: 'reject_once',
            },
          ],
          toolCall: {
            toolCallId: permissionSecret,
            title: permissionSecret,
            status: 'pending',
          },
        },
      });
      const cancelling = await createFakeKimi({ updates: [], holdPrompt: true });
      cleanup.push(failed.dir, permission.dir, cancelling.dir);

      const failedRun = newTestKimiAdapter({
        binary: failed.path,
        profileStateDir: failed.dir,
      }).run({
        runId: 'run-safe-provider-log',
        prompt: 'hello',
        cwd: await realpath(failed.dir),
        model: modelSecret,
      });
      await collect(failedRun.events);
      expect(await failedRun.waitForExit(1_000)).toBe(true);

      const permissionRun = newTestKimiAdapter({
        binary: permission.path,
        profileStateDir: permission.dir,
      }).run({
        runId: 'run-safe-permission-log',
        prompt: 'hello',
        cwd: await realpath(permission.dir),
      });
      await collect(permissionRun.events);
      expect(await permissionRun.waitForExit(1_000)).toBe(true);

      vi.spyOn(ClientSideConnection.prototype, 'cancel').mockRejectedValueOnce(
        new Error(cancelSecret),
      );
      const cancelRun = newTestKimiAdapter({
        binary: cancelling.path,
        profileStateDir: cancelling.dir,
        stopGraceMs: 100,
      }).run({
        runId: 'run-safe-cancel-log',
        prompt: 'wait',
        cwd: await realpath(cancelling.dir),
      });
      const iterator = cancelRun.events[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: 'system' });
      await waitForMethod(cancelling.recordPath, 'session/prompt');
      await cancelRun.stop();
      expect(await cancelRun.waitForExit(1_000)).toBe(true);

      await nextEventLoopTurn();
      await flushLogger();
      const durableLogs = await readFile(join(logsDir, 'bridge-20260727.jsonl'), 'utf8');
      const consoleLogs = JSON.stringify([
        ...consoleWarn.mock.calls,
        ...consoleError.mock.calls,
      ]);
      const allLogs = `${durableLogs}\n${consoleLogs}`;
      expect(allLogs).toContain('acp-drive-failed');
      expect(allLogs).toContain('permission-denied');
      expect(allLogs).toContain('cancel-failed');
      expect(allLogs).not.toContain(providerSecret);
      expect(allLogs).not.toContain(modelSecret);
      expect(allLogs).not.toContain(permissionSecret);
      expect(allLogs).not.toContain(cancelSecret);
    } finally {
      await closeLogger();
      configureLogger({
        logsDir: previousLogger.logsDir ?? '',
        retentionDays: previousLogger.retentionDays,
        now: previousLogger.now,
      });
    }
  });

  it('fails closed when ACP emits a session update for a different session', async () => {
    const fake = await createFakeKimi({
      updateSessionId: 'sess-cross-talk',
      updates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'cross-session-secret' },
        },
      ],
    });
    cleanup.push(fake.dir);
    const run = newTestKimiAdapter({ binary: fake.path, profileStateDir: fake.dir }).run({
      runId: 'run-session-mismatch',
      prompt: 'hello',
      cwd: await realpath(fake.dir),
    });

    const events = await collect(run.events);
    expect(events).toEqual([
      { type: 'system', sessionId: 'sess-new' },
      {
        type: 'error',
        message: KIMI_RUNTIME_FAILURE_MESSAGE,
        terminationReason: 'failed',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('cross-session-secret');
    expect(JSON.stringify(events)).not.toContain('sess-cross-talk');
  });

  it('buffers split answer chunks and sanitizes every user-visible Kimi event', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'fake-kimi-redacted-path-')));
    const workspace = join(root, 'workspace');
    const insidePath = join(workspace, 'src', 'secret.ts');
    const outsidePath = '/Users/alice/.lark-channel/profiles/kimi/config.toml';
    const thoughtPath = '/private/var/tmp/kimi-thought-secret.txt';
    await mkdir(workspace, { recursive: true });
    const fake = await createFakeKimi({
      fixedDir: root,
      updates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'The host path is /Us' },
        },
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ers/alice/My Project/answer-secret.txt\nDone.' },
        },
        {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: `never show ${thoughtPath}` },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'read-1',
          title: `Read ${insidePath}`,
          kind: 'read',
          status: 'in_progress',
          rawInput: {
            path: insidePath,
            fallback: outsidePath,
            note: `embedded fallback: ${outsidePath}`,
          },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'read-1',
          status: 'completed',
          rawOutput: `read ${insidePath}; fallback ${outsidePath}\n/usr/local/bin/kimi`,
        },
      ],
    });
    cleanup.push(fake.dir);
    const run = newTestKimiAdapter({ binary: fake.path, profileStateDir: join(root, 'profile') }).run({
      runId: 'run-redacted-path',
      prompt: 'read it',
      cwd: await realpath(workspace),
    });

    const events = await collect(run.events);
    const serializedEvents = JSON.stringify(events);
    expect(events.find((event) => event.type === 'tool_use')).toEqual({
      type: 'tool_use',
      id: 'read-1',
      name: 'Read',
      input: { path: 'src/secret.ts' },
    });
    expect(events.find((event) => event.type === 'tool_result')).toEqual({
      type: 'tool_result',
      id: 'read-1',
      output: 'Kimi Read completed.',
      isError: false,
    });
    expect(serializedEvents).toContain('src/secret.ts');
    expect(serializedEvents).toContain('[redacted]');
    expect(events.find((event) => event.type === 'text')).toEqual({
      type: 'text',
      delta: 'The host path is [redacted]\nDone.',
    });
    expect(serializedEvents).not.toContain('thinking');
    expect(serializedEvents).not.toContain('thought-secret');
    expect(serializedEvents).not.toContain(root);
    expect(serializedEvents).not.toContain('/Users');
    expect(serializedEvents).not.toContain('/private');
    expect(serializedEvents).not.toContain('/usr');
    expect(serializedEvents).not.toContain(outsidePath);

    let state = initialState;
    for (const event of events) {
      state = reduce(state, event);
      const renderedAtThisStep = JSON.stringify(renderCard(state));
      expect(renderedAtThisStep).not.toContain(root);
      expect(renderedAtThisStep).not.toContain('/Users');
      expect(renderedAtThisStep).not.toContain('/private');
      expect(renderedAtThisStep).not.toContain('/usr');
      expect(renderedAtThisStep).not.toContain('thought-secret');
    }
  });

  it('sanitizes common POSIX, file URI, Windows, UNC, and home paths', () => {
    const cwd = '/safe/pilot-workspace';
    const samples = [
      '/Users/alice/My Project/secret.txt',
      '/private/var/folders/secret',
      '/var/tmp/secret',
      '/tmp/secret',
      '/opt/homebrew/bin/tool',
      '/Library/Application Support/secret',
      '/System/Library/secret',
      '/Volumes/Internal/secret',
      '/usr/local/bin/tool',
      '/etc/passwd',
      '/nix/store/local-secret.txt',
      '/custom/root/local-secret.txt',
      '/secret.txt',
      '/.env',
      '//Users/alice/secret.txt',
      '///private/var/tmp/secret.txt',
      '**//Users/alice/secret.txt**',
      'file:///Users/alice/secret.txt',
      'file://localhost/Users/alice/secret.txt',
      String.raw`\/Users\/alice\/secret.txt`,
      '[file](</Users/alice/My Project/secret.txt>)',
      '**/Users/alice/secret.txt**',
      '|/Users/alice/secret.txt|',
      '_/Users/alice/secret.txt_',
      '~/private/secret.txt',
      String.raw`C:\Users\alice\secret.txt`,
      String.raw`\\server\share\secret.txt`,
    ];

    for (const sample of samples) {
      const sanitized = sanitizeKimiVisibleText(`path=${sample}`, cwd);
      expect(sanitized).toContain('[redacted]');
      expect(sanitized).not.toContain('alice');
      expect(sanitized).not.toContain('secret.txt');
    }
    expect(
      sanitizeKimiVisibleText(`read ${cwd}/src/index.ts`, cwd),
    ).toBe('read ./src/index.ts');
    expect(sanitizeKimiVisibleText('see https://example.com/app/docs', cwd)).toBe(
      'see https://example.com/app/docs',
    );
    expect(sanitizeKimiVisibleText('read src/index.ts', cwd)).toBe('read src/index.ts');
    expect(sanitizeKimiVisibleText('result = 1 / 2 / 3', cwd)).toBe('result = 1 / 2 / 3');
    expect(sanitizeKimiVisibleText('use /new to reset', cwd)).toBe('use /new to reset');
    for (const commandText of [
      'use `/new` to reset',
      'use /new, then continue',
      'use /new. Then continue',
      'use (/new) to reset',
      'use **/new** to reset',
      'use /new, then /status',
    ]) {
      expect(sanitizeKimiVisibleText(commandText, cwd)).toBe(commandText);
    }
  });

  it('bounds buffered Kimi answers and drops all partial oversized content', () => {
    const notification = (text: string): SessionNotification =>
      ({
        sessionId: 'sess-limit',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      }) as SessionNotification;

    for (const size of [
      KIMI_MAX_BUFFERED_ANSWER_BYTES - 1,
      KIMI_MAX_BUFFERED_ANSWER_BYTES,
    ]) {
      const translator = new KimiAcpEventTranslator({ cwd: '/safe/workspace' });
      expect(translator.translate(notification('x'.repeat(size)))).toEqual([
        { type: 'progress' },
      ]);
      expect(translator.flushAnswer()).toEqual([
        { type: 'text', delta: 'x'.repeat(size) },
      ]);
    }

    const oversized = new KimiAcpEventTranslator({ cwd: '/safe/workspace' });
    oversized.translate(notification('private-prefix'.repeat(1_000)));
    oversized.translate(notification('x'.repeat(KIMI_MAX_BUFFERED_ANSWER_BYTES)));
    expect(oversized.flushAnswer()).toEqual([
      { type: 'text', delta: KIMI_OVERSIZED_ANSWER_MESSAGE },
    ]);
    expect(JSON.stringify(oversized.flushAnswer())).not.toContain('private-prefix');

    const emptyChunks = new KimiAcpEventTranslator({ cwd: '/safe/workspace' });
    for (let index = 0; index < 1_000; index += 1) {
      emptyChunks.translate(notification(''));
    }
    expect(emptyChunks.flushAnswer()).toEqual([]);
  });

  it('emits bounded internal progress events while answer chunks stay buffered', () => {
    let now = 0;
    const translator = new KimiAcpEventTranslator({
      cwd: '/safe/workspace',
      now: () => now,
    });
    const notification = (text: string): SessionNotification =>
      ({
        sessionId: 'sess-progress',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      }) as SessionNotification;

    expect(translator.translate(notification('one'))).toEqual([{ type: 'progress' }]);
    now = 1_000;
    expect(translator.translate(notification('two'))).toEqual([]);
    now = 5_000;
    expect(translator.translate(notification('three'))).toEqual([{ type: 'progress' }]);
    expect(translator.flushAnswer()).toEqual([{ type: 'text', delta: 'onetwothree' }]);
  });

  it('sends session/cancel before terminating a stopped run', async () => {
    const fake = await createFakeKimi({ updates: [], holdPrompt: true });
    cleanup.push(fake.dir);
    const run = newTestKimiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 500,
    }).run({
      runId: 'run-stop',
      prompt: 'wait',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', sessionId: 'sess-new' },
    });
    await waitForMethod(fake.recordPath, 'session/prompt');

    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'sess-new', terminationReason: 'interrupted' },
    });
    expect(await run.waitForExit(1_000)).toBe(true);
    const record = await waitForRecord(fake.recordPath);
    const cancelIndex = methods(record).indexOf('session/cancel');
    expect(cancelIndex).toBeGreaterThan(methods(record).indexOf('session/prompt'));
    expect(record.signal).toBe('SIGTERM');
  });

  it('terminates even when the ACP server never answers session/cancel', async () => {
    const fake = await createFakeKimi({ updates: [], holdPrompt: true, ignoreCancel: true });
    cleanup.push(fake.dir);
    const run = newTestKimiAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      stopGraceMs: 50,
    }).run({
      runId: 'run-stuck-cancel',
      prompt: 'wait',
      cwd: await realpath(fake.dir),
    });

    await waitForMethod(fake.recordPath, 'session/prompt');
    await expect(run.stop()).resolves.toBeUndefined();
    expect(await run.waitForExit(500)).toBe(true);
    expect((await readRecord(fake.recordPath)).signal).toBe('SIGTERM');
  });

  it('keeps ACP console redaction active across overlapping runs and restores it last', async () => {
    const first = await createFakeKimi({ updates: [], holdPrompt: true });
    const second = await createFakeKimi({ updates: [] });
    cleanup.push(first.dir, second.dir);
    const originalConsoleError = console.error;
    const firstRun = newTestKimiAdapter({
      binary: first.path,
      profileStateDir: join(first.dir, 'profile'),
    }).run({
      runId: 'run-console-overlap-first',
      prompt: 'wait',
      cwd: await realpath(first.dir),
    });
    const firstIterator = firstRun.events[Symbol.asyncIterator]();
    expect((await firstIterator.next()).value).toMatchObject({ type: 'system' });
    expect(console.error).not.toBe(originalConsoleError);

    const secondRun = newTestKimiAdapter({
      binary: second.path,
      profileStateDir: join(second.dir, 'profile'),
    }).run({
      runId: 'run-console-overlap-second',
      prompt: 'finish',
      cwd: await realpath(second.dir),
    });
    await collect(secondRun.events);
    expect(await secondRun.waitForExit(1_000)).toBe(true);
    await nextEventLoopTurn();
    expect(console.error).not.toBe(originalConsoleError);

    await firstRun.stop();
    expect(await firstRun.waitForExit(1_000)).toBe(true);
    await nextEventLoopTurn();
    expect(console.error).toBe(originalConsoleError);
  });

  it('does not overwrite console instrumentation installed during an ACP run', async () => {
    const fake = await createFakeKimi({ updates: [], holdPrompt: true });
    cleanup.push(fake.dir);
    const originalConsoleError = console.error;
    const run = newTestKimiAdapter({
      binary: fake.path,
      profileStateDir: join(fake.dir, 'profile'),
    }).run({
      runId: 'run-console-external-wrapper',
      prompt: 'wait',
      cwd: await realpath(fake.dir),
    });
    const iterator = run.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'system' });
    const externalConsoleError = vi.fn();
    console.error = externalConsoleError;
    try {
      await run.stop();
      expect(await run.waitForExit(1_000)).toBe(true);
      await nextEventLoopTurn();
      expect(console.error).toBe(externalConsoleError);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('uses an isolated profile home and preserves login config while maintaining safety rules', async () => {
    const fake = await createFakeKimi({ updates: [] });
    cleanup.push(fake.dir);
    const profileStateDir = join(fake.dir, 'profile');
    const kimiHome = join(profileStateDir, 'kimi-home');
    const configPath = join(kimiHome, 'config.toml');
    const credentialsPath = join(kimiHome, 'credentials', 'managed-kimi-code.json');
    const globalHome = join(fake.dir, 'global-home');
    const globalKimiHome = join(globalHome, '.kimi-code');
    const globalConfigPath = join(globalKimiHome, 'config.toml');
    await mkdir(join(kimiHome, 'credentials'), { recursive: true });
    await mkdir(globalKimiHome, { recursive: true });

    const loginConfig = `default_model = "kimi-code/kimi-for-coding"
telemetry = true
default_permission_mode = "yolo"
default_plan_mode = false

[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""
oauth = { storage = "file", key = "oauth/kimi-code" }

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144

[tools]
enabled = ["Bash", "Write"]
disabled = ["Read"]

[[permission.rules]]
decision = "allow"
pattern = "Read"
reason = "profile-local preference"
`;
    const credential = '{"access_token":"profile-only-token"}\n';
    const globalConfig = 'global_only = "must-not-be-inherited"\n';
    await writeFile(configPath, loginConfig, 'utf8');
    await writeFile(credentialsPath, credential, 'utf8');
    await writeFile(globalConfigPath, globalConfig, 'utf8');

    const originalHome = process.env.HOME;
    const originalKimiHome = process.env.KIMI_CODE_HOME;
    process.env.HOME = globalHome;
    process.env.KIMI_CODE_HOME = globalKimiHome;
    try {
      const adapter = newTestKimiAdapter({ binary: fake.path, profileStateDir });
      const first = adapter.run({
        runId: 'run-isolated-first',
        prompt: 'hello',
        cwd: await realpath(fake.dir),
      });
      await collect(first.events);
      expect(await first.waitForExit(1_000)).toBe(true);
      const firstConfig = await readFile(configPath, 'utf8');

      const second = adapter.run({
        runId: 'run-isolated-second',
        prompt: 'hello again',
        cwd: await realpath(fake.dir),
      });
      await collect(second.events);
      expect(await second.waitForExit(1_000)).toBe(true);
      const secondConfig = await readFile(configPath, 'utf8');

      expect(secondConfig).toBe(firstConfig);
      expect(firstConfig).toContain('default_model = "kimi-code/kimi-for-coding"');
      expect(firstConfig).toContain('[providers."managed:kimi-code"]');
      expect(firstConfig).toContain('oauth = { storage = "file", key = "oauth/kimi-code" }');
      expect(firstConfig).toContain('reason = "profile-local preference"');
      expect(firstConfig).not.toContain('must-not-be-inherited');
      expect(await readFile(credentialsPath, 'utf8')).toBe(credential);
      expect(await readFile(globalConfigPath, 'utf8')).toBe(globalConfig);

      expect(occurrences(firstConfig, '# BEGIN LARK CHANNEL BRIDGE KIMI SAFETY')).toBe(1);
      expect(occurrences(firstConfig, '# END LARK CHANNEL BRIDGE KIMI SAFETY')).toBe(1);
      expect(occurrences(firstConfig, 'telemetry = false')).toBe(1);
      expect(occurrences(firstConfig, 'default_permission_mode = "manual"')).toBe(1);
      expect(occurrences(firstConfig, 'default_plan_mode = false')).toBe(1);
      expect(occurrences(firstConfig, 'hooks = []')).toBe(1);
      expect(occurrences(firstConfig, 'merge_all_available_skills = false')).toBe(1);
      expect(occurrences(firstConfig, 'extra_skill_dirs = []')).toBe(1);
      expect(firstConfig).not.toContain('telemetry = true');
      expect(firstConfig).not.toContain('default_permission_mode = "yolo"');
      expect(firstConfig).not.toContain('default_plan_mode = true');
      expect(firstConfig).not.toContain('[tools]');
      expect(firstConfig).not.toContain('enabled = ["Read"]');
      expect(firstConfig).not.toContain('enabled = ["Bash", "Write"]');
      expect(firstConfig).not.toContain('disabled = ["Read"]\n');
      for (const pattern of [
        'Read(!./**)',
        'Glob',
        'Grep',
        'ReadMediaFile',
        'FetchURL',
        'WebSearch',
        'Bash',
        'Write',
        'Edit',
        'Agent',
        'AgentSwarm',
        'AskUserQuestion',
        'CreateGoal',
        'GetGoal',
        'SetGoalBudget',
        'UpdateGoal',
        'TaskList',
        'TaskOutput',
        'TaskStop',
        'TodoList',
        'EnterPlanMode',
        'ExitPlanMode',
        'mcp__*',
        'CronCreate',
        'CronDelete',
        'CronList',
        'Skill',
      ]) {
        expect(
          occurrences(
            firstConfig,
            `decision = "deny"\npattern = ${JSON.stringify(pattern)}`,
          ),
        ).toBe(1);
      }
      expect(occurrences(firstConfig, 'decision = "deny"\npattern = "Read"')).toBe(0);
      expect(occurrences(firstConfig, 'decision = "allow"\npattern = "Read"')).toBe(1);

      const record = await readRecord(fake.recordPath);
      expect(record.env).toMatchObject({
        KIMI_CODE_HOME: kimiHome,
        KIMI_CODE_CACHE_DIR: join(kimiHome, 'cache'),
        TMPDIR: join(kimiHome, 'tmp'),
        SHELL: '/usr/bin/false',
        KIMI_DISABLE_TELEMETRY: '1',
        KIMI_DISABLE_CRON: '1',
        KIMI_CODE_NO_AUTO_UPDATE: '1',
        KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: 'false',
      });
      expect(record.env.HOME).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = originalKimiHome;
    }
  });

  it('fails closed before ACP spawn when bridge safety markers are malformed', async () => {
    const fake = await createFakeKimi({ updates: [] });
    cleanup.push(fake.dir);
    const profileStateDir = join(fake.dir, 'profile');
    const configPath = join(profileStateDir, 'kimi-home', 'config.toml');
    const original = '# BEGIN LARK CHANNEL BRIDGE KIMI SAFETY\ntelemetry = false\n';
    await mkdir(join(profileStateDir, 'kimi-home'), { recursive: true });
    await writeFile(configPath, original, 'utf8');
    const cwd = await realpath(fake.dir);

    expect(() =>
      newTestKimiAdapter({ binary: fake.path, profileStateDir }).run({
        runId: 'run-malformed-safety',
        prompt: 'hello',
        cwd,
      }),
    ).toThrow(/malformed or duplicate bridge markers/i);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    await expect(readFile(fake.recordPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the original config and refuses to spawn when Kimi rejects the merged candidate', async () => {
    const fake = await createFakeKimi({ updates: [], rejectSafetyConfig: true });
    cleanup.push(fake.dir);
    const profileStateDir = join(fake.dir, 'profile');
    const configPath = join(profileStateDir, 'kimi-home', 'config.toml');
    const original = 'default_model = "kept-model"\n';
    await mkdir(join(profileStateDir, 'kimi-home'), { recursive: true });
    await writeFile(configPath, original, 'utf8');
    const cwd = await realpath(fake.dir);

    expect(() =>
      newTestKimiAdapter({ binary: fake.path, profileStateDir }).run({
        runId: 'run-invalid-candidate',
        prompt: 'hello',
        cwd,
      }),
    ).toThrow(/rejected the profile safety config/i);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    await expect(readFile(fake.recordPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when the policy cwd is deleted or repointed before adapter spawn', async () => {
    const fake = await createFakeKimi({ updates: [] });
    cleanup.push(fake.dir);
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'fake-kimi-cwd-snapshot-'));
    cleanup.push(runtimeRoot);
    const workspace = join(runtimeRoot, 'workspace');
    const parkedWorkspace = join(runtimeRoot, 'parked-workspace');
    const outside = join(runtimeRoot, 'outside');
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    const policyCwdRealpath = await realpath(workspace);
    const adapter = newTestKimiAdapter({
      binary: fake.path,
      profileStateDir: join(runtimeRoot, 'profile'),
    });

    await rename(workspace, parkedWorkspace);
    await symlink(outside, workspace, 'dir');
    expect(() =>
      adapter.run({
        runId: 'run-repointed-cwd',
        prompt: 'must not run',
        cwd: policyCwdRealpath,
      }),
    ).toThrow(/workspace changed before spawn/i);

    await rm(workspace);
    expect(() =>
      adapter.run({
        runId: 'run-deleted-cwd',
        prompt: 'must not run',
        cwd: policyCwdRealpath,
      }),
    ).toThrow(/workspace changed before spawn/i);
    await expect(readFile(fake.recordPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates a Kimi cwd after waiting for pool capacity and before ACP spawn', async () => {
    const fake = await createFakeKimi({ updates: [], holdPrompt: true });
    cleanup.push(fake.dir);
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'fake-kimi-queued-cwd-'));
    cleanup.push(runtimeRoot);
    const runningWorkspace = join(runtimeRoot, 'running-workspace');
    const queuedWorkspace = join(runtimeRoot, 'queued-workspace');
    const parkedWorkspace = join(runtimeRoot, 'parked-workspace');
    const outside = join(runtimeRoot, 'outside');
    await Promise.all([
      mkdir(runningWorkspace),
      mkdir(queuedWorkspace),
      mkdir(outside),
    ]);
    const runningCwd = await realpath(runningWorkspace);
    const queuedPolicyCwd = await realpath(queuedWorkspace);
    const adapter = newTestKimiAdapter({
      binary: fake.path,
      profileStateDir: join(runtimeRoot, 'profile'),
    });
    const pool = new ProcessPool(() => 1);
    const activeRuns = new ActiveRuns();
    let nextRun = 1;
    const executor = new RunExecutor({
      agent: adapter,
      pool,
      activeRuns,
      createRunId: () => `queued-cwd-${nextRun++}`,
      now: () => 1_000,
      postDoneExitGraceMs: 100,
    });
    const running = await executor.submit({
      scopeId: 'running-scope',
      policy: kimiRunPolicy(runningCwd),
    });
    const queued = executor.submit({
      scopeId: 'queued-scope',
      policy: kimiRunPolicy(queuedPolicyCwd),
    });
    await vi.waitFor(() => {
      expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });
    });

    await rename(queuedWorkspace, parkedWorkspace);
    await symlink(outside, queuedWorkspace, 'dir');
    expect(await realpath(queuedWorkspace)).toBe(await realpath(outside));
    await running.stop();

    await expect(queued).rejects.toMatchObject({ code: 'agent-spawn-failed' });
    expect(activeRuns.get('queued-scope')).toBeUndefined();
    expect(pool.snapshot()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('wraps the ACP spawn in sandbox-exec with the generated profile', async () => {
    const fake = await createFakeKimi({ updates: [] });
    cleanup.push(fake.dir);
    const sandbox = await createFakeSandboxExec(fake.dir);
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'fake-kimi-runtime-'));
    cleanup.push(runtimeRoot);
    const cwd = join(runtimeRoot, 'workspace');
    await mkdir(cwd, { recursive: true });
    const osHome = await mkdtemp(join(tmpdir(), 'fake-seatbelt-home-'));
    cleanup.push(osHome);
    const profileStateDir = join(runtimeRoot, 'profile');
    const adapter = new KimiAdapter({
      binary: fake.path,
      profileStateDir,
      seatbeltTestOverrides: {
        platform: 'darwin',
        sandboxExecPath: sandbox.path,
        osHomeDir: osHome,
      },
    });

    const run = adapter.run({
      runId: 'run-seatbelt',
      prompt: 'hello',
      cwd: await realpath(cwd),
    });
    expect((await collect(run.events)).at(-1)).toMatchObject({
      type: 'done',
      terminationReason: 'normal',
    });
    expect(await run.waitForExit(1_000)).toBe(true);

    const wrapper = JSON.parse(await readFile(sandbox.recordPath, 'utf8')) as {
      argv: string[];
    };
    expect(wrapper.argv[0]).toBe('-p');
    expect(wrapper.argv.slice(2)).toEqual([await realpath(fake.path), 'acp']);
    const profile = wrapper.argv[1]!;
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(deny process-exec*)');
    expect(profile).toContain('(allow file-read-metadata');
    expect(profile).not.toContain(
      `(allow file-read* (subpath ${JSON.stringify(await realpath(cwd))})`,
    );
    expect(profile).toContain(await realpath(fake.path));
    expect(profile).toContain(await realpath(join(profileStateDir, 'kimi-home')));
    expect(profile).not.toContain(await realpath(join(profileStateDir, 'images')));
    expect((await readRecord(fake.recordPath)).argv).toEqual(['acp']);
  });

  it('fails closed before ACP spawn when sandbox-exec cannot be resolved', async () => {
    const fake = await createFakeKimi({ updates: [] });
    cleanup.push(fake.dir);
    const osHome = await mkdtemp(join(tmpdir(), 'fake-seatbelt-home-'));
    cleanup.push(osHome);
    const cwd = await realpath(fake.dir);

    expect(() =>
      new KimiAdapter({
        binary: fake.path,
        profileStateDir: join(fake.dir, 'profile'),
        seatbeltTestOverrides: {
          platform: 'darwin',
          sandboxExecPath: join(fake.dir, 'missing-sandbox-exec'),
          osHomeDir: osHome,
        },
      }).run({
        runId: 'run-no-sandbox-exec',
        prompt: 'hello',
        cwd,
      }),
    ).toThrow(/could not resolve sandbox-exec/i);
    await expect(readFile(fake.recordPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires a policy-resolved cwd before spawning', () => {
    expect(() =>
      newTestKimiAdapter({ binary: 'unused', profileStateDir: tmpdir() }).run({
        runId: 'run-no-cwd',
        prompt: 'hi',
      }),
    ).toThrow(/cwd is required/);
  });
});

function newTestKimiAdapter(
  options: Omit<KimiAdapterOptions, 'seatbeltTestOverrides'>,
): KimiAdapter {
  return new KimiAdapter({
    ...options,
    seatbeltTestOverrides: { platform: 'linux', allowUnsandboxed: true },
  });
}

function kimiRunPolicy(cwdRealpath: string): RunPolicyAllow {
  return {
    ok: true,
    prompt: 'hello',
    requestedCwd: cwdRealpath,
    cwdRealpath,
    accessMode: 'workspace',
    sandbox: 'workspace-write',
    permissionMode: 'acceptEdits',
    access: { ok: true, reason: 'allowed-user' },
    attachments: [],
    policyFingerprint: 'kimi-cwd-revalidation',
    expiresAt: 2_000,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function request(record: FakeRecord, method: string): Record<string, unknown> {
  const found = record.messages.find((message) => message.method === method);
  if (!found) throw new Error(`missing ACP request: ${method}`);
  return found;
}

function response(record: FakeRecord, id: number): Record<string, unknown> {
  const found = record.responses.find((message) => message.id === id);
  if (!found) throw new Error(`missing ACP response: ${String(id)}`);
  return found;
}

function methods(record: FakeRecord): string[] {
  return record.messages
    .map((message) => message.method)
    .filter((method): method is string => typeof method === 'string');
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function readRecord(path: string): Promise<FakeRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as FakeRecord;
}

async function waitForRecord(path: string): Promise<FakeRecord> {
  let lastError: unknown;
  for (let i = 0; i < 100; i += 1) {
    try {
      return await readRecord(path);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function waitForMethod(path: string, method: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const record = await waitForRecord(path);
    if (methods(record).includes(method)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${method}`);
}

async function createFakeKimi(options: {
  updates: unknown[];
  version?: string;
  usage?: unknown;
  stderr?: string;
  malformedStdout?: string;
  unknownRequest?: { method: string; params: Record<string, unknown> };
  resume?: boolean;
  updateSessionId?: string;
  historyUpdate?: unknown;
  permissionRequest?: unknown;
  rejectModel?: boolean;
  rejectMode?: boolean;
  authError?: string;
  holdPrompt?: boolean;
  ignoreCancel?: boolean;
  rejectSafetyConfig?: boolean;
  fixedDir?: string;
  newSessionId?: string;
  fsScenario?: {
    sessionId: string;
    wrongSessionId: string;
    readPath: string;
    writePath: string;
  };
}): Promise<FakeKimi> {
  const dir = options.fixedDir ?? (await mkdtemp(join(tmpdir(), 'fake-kimi-')));
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'kimi.cjs');
  const recordPath = join(dir, 'record.json');
  const encoded = Buffer.from(JSON.stringify(options)).toString('base64');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const options = JSON.parse(Buffer.from('${encoded}', 'base64').toString('utf8'));
const recordPath = ${JSON.stringify(recordPath)};
if (process.argv[2] === '--version') {
  process.stdout.write((options.version || '0.29.2') + '\\n');
  process.exit(0);
}
if (process.argv[2] === 'doctor' && process.argv[3] === 'config') {
  const config = fs.readFileSync(process.argv[4], 'utf8');
  if (options.rejectSafetyConfig && config.includes('# BEGIN LARK CHANNEL BRIDGE KIMI SAFETY')) {
    process.stderr.write('candidate rejected');
    process.exit(2);
  }
  process.stdout.write('OK config.toml\\n');
  process.exit(0);
}
const record = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    LARK_CHANNEL: process.env.LARK_CHANNEL,
    LARK_CHANNEL_PROFILE: process.env.LARK_CHANNEL_PROFILE,
    LARK_CHANNEL_HOME: process.env.LARK_CHANNEL_HOME,
    LARK_CHANNEL_CONFIG: process.env.LARK_CHANNEL_CONFIG,
    LARKSUITE_CLI_CONFIG_DIR: process.env.LARKSUITE_CLI_CONFIG_DIR,
    LARK_CHANNEL_IMAGE_DIR: process.env.LARK_CHANNEL_IMAGE_DIR,
    KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
    KIMI_CODE_CACHE_DIR: process.env.KIMI_CODE_CACHE_DIR,
    TMPDIR: process.env.TMPDIR,
    SHELL: process.env.SHELL,
    KIMI_DISABLE_TELEMETRY: process.env.KIMI_DISABLE_TELEMETRY,
    KIMI_DISABLE_CRON: process.env.KIMI_DISABLE_CRON,
    KIMI_CODE_NO_AUTO_UPDATE: process.env.KIMI_CODE_NO_AUTO_UPDATE,
    KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: process.env.KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT,
    HOME: process.env.HOME,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    LARK_CHANNEL_PRIVATE_SECRET: process.env.LARK_CHANNEL_PRIVATE_SECRET,
  },
  messages: [],
  responses: [],
};
let pendingPrompt;
let pendingNew;
const save = () => fs.writeFileSync(recordPath, JSON.stringify(record));
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const update = (sessionId, value) => send({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update: value },
});
const finishPrompt = (id, sessionId, stopReason = 'end_turn') => {
  for (const value of options.updates) update(options.updateSessionId || sessionId, value);
  result(id, { stopReason, ...(options.usage ? { usage: options.usage } : {}) });
};
if (options.stderr) process.stderr.write(options.stderr);
if (options.malformedStdout) process.stdout.write(options.malformedStdout + '\\n');
save();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (typeof message.method !== 'string') {
    record.responses.push(message);
    save();
    if (message.id === 901 && pendingNew) {
      result(pendingNew.id, { sessionId: options.newSessionId || 'sess-new' });
      pendingNew = undefined;
      return;
    }
    if (message.id === 902 && pendingPrompt && options.fsScenario) {
      send({
        jsonrpc: '2.0',
        id: 903,
        method: 'fs/write_text_file',
        params: {
          sessionId: options.fsScenario.sessionId,
          path: options.fsScenario.writePath,
          content: 'must not be written',
        },
      });
      return;
    }
    if (message.id === 903 && pendingPrompt) {
      finishPrompt(pendingPrompt.id, pendingPrompt.sessionId);
      pendingPrompt = undefined;
      return;
    }
    if (message.id === 904 && pendingPrompt) {
      finishPrompt(pendingPrompt.id, pendingPrompt.sessionId);
      pendingPrompt = undefined;
      return;
    }
    if (message.id === 900 && pendingPrompt) {
      finishPrompt(pendingPrompt.id, pendingPrompt.sessionId);
      pendingPrompt = undefined;
    }
    return;
  }
  record.messages.push(message);
  save();
  const params = message.params || {};
  switch (message.method) {
    case 'initialize':
      result(message.id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: options.resume === false ? {} : { resume: {} },
        },
        agentInfo: { name: 'Fake Kimi', version: '0.0.0' },
      });
      break;
    case 'session/new':
      if (options.authError) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: options.authError } });
      } else if (options.fsScenario) {
        pendingNew = { id: message.id };
        send({
          jsonrpc: '2.0',
          id: 901,
          method: 'fs/read_text_file',
          params: {
            sessionId: options.fsScenario.sessionId,
            path: options.fsScenario.readPath,
          },
        });
      } else {
        result(message.id, { sessionId: options.newSessionId || 'sess-new' });
      }
      break;
    case 'session/resume':
      result(message.id, {});
      break;
    case 'session/load':
      if (options.historyUpdate) update(params.sessionId, options.historyUpdate);
      result(message.id, {});
      break;
    case 'session/set_model':
      if (options.rejectModel) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'model selection unsupported' },
        });
      } else {
        result(message.id, {});
      }
      break;
    case 'session/set_mode':
      if (options.rejectMode) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'manual mode unsupported' },
        });
      } else {
        result(message.id, {});
      }
      break;
    case 'session/prompt':
      if (options.holdPrompt) {
        pendingPrompt = { id: message.id, sessionId: params.sessionId };
      } else if (options.unknownRequest) {
        pendingPrompt = { id: message.id, sessionId: params.sessionId };
        send({
          jsonrpc: '2.0',
          id: 904,
          method: options.unknownRequest.method,
          params: options.unknownRequest.params,
        });
      } else if (options.permissionRequest) {
        pendingPrompt = { id: message.id, sessionId: params.sessionId };
        send({
          jsonrpc: '2.0',
          id: 900,
          method: 'session/request_permission',
          params: options.permissionRequest,
        });
      } else if (options.fsScenario) {
        pendingPrompt = { id: message.id, sessionId: params.sessionId };
        send({
          jsonrpc: '2.0',
          id: 902,
          method: 'fs/read_text_file',
          params: {
            sessionId: options.fsScenario.wrongSessionId,
            path: options.fsScenario.readPath,
          },
        });
      } else {
        finishPrompt(message.id, params.sessionId);
      }
      break;
    case 'session/cancel':
      if (options.ignoreCancel) {
        break;
      }
      if (pendingPrompt) {
        finishPrompt(pendingPrompt.id, pendingPrompt.sessionId, 'cancelled');
        pendingPrompt = undefined;
      }
      break;
  }
});
rl.on('close', () => {
  save();
  setTimeout(() => process.exit(0), 10);
});
process.on('SIGTERM', () => {
  record.signal = 'SIGTERM';
  save();
  setTimeout(() => process.exit(0), 10);
});
`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return { path, dir, recordPath };
}

async function createFakeSandboxExec(dir: string): Promise<FakeSandboxExec> {
  const path = join(dir, 'sandbox-exec.cjs');
  const recordPath = join(dir, 'sandbox-record.json');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv }));
if (argv[0] !== '-p' || argv.length < 3) process.exit(64);
const child = spawn(argv[2], argv.slice(3), { stdio: 'inherit' });
child.on('error', (error) => {
  process.stderr.write(String(error));
  process.exit(70);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return { path, recordPath };
}
