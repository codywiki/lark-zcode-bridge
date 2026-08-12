import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { KimiAdapter } from '../../src/agent/kimi/adapter.js';
import {
  buildKimiLaunch,
  KIMI_SAFE_LOGIN_SHELL,
} from '../../src/agent/kimi/seatbelt.js';
import { KimiWorkspaceFs } from '../../src/agent/kimi/workspace-fs.js';
import type { AgentEvent, AgentRun } from '../../src/agent/types.js';
import { resolveAppPaths } from '../../src/config/app-paths.js';
import {
  acquireProfileRuntimeLock,
  type AcquiredRuntimeLock,
} from '../../src/runtime/locks.js';

/**
 * Manual production smoke test for the organization-facing Kimi pilot.
 *
 * This file intentionally does not use a *.test.ts suffix, so the ordinary
 * Vitest suite never talks to the real provider or consumes live quota.
 * Run it only while the `kimi` bridge profile is stopped.
 */

const PROFILE = 'kimi';
const KIMI_BINARY =
  process.env.KIMI_SMOKE_BINARY ?? '/Users/cakegrowth/.kimi-code/bin/kimi';
const TURN_TIMEOUT_MS = 120_000;
const EXIT_TIMEOUT_MS = 5_000;
const FIXTURE_PREFIX = '.live-smoke-';
const OUTSIDE_PREFIX = '.live-smoke-outside-';

let currentStep = 'startup';
let currentRun: AgentRun | undefined;
let lastAcpStage = 'unknown';
let lastAcpCode = 'none';
let lastAcpCategory = 'unknown';
let lastAcpLocation = 'unknown';
let lastAcpExecutable = 'unknown';
let lastAcpOperation = 'unknown';

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

// Provider/ACP diagnostics are deliberately categorical in production, but a
// smoke command should still print only its stable PASS/FAIL contract.
console.log = () => {};
console.warn = (...values: unknown[]) => {
  for (const value of values) {
    const text = String(value);
    const stage = /\bstage=([a-z-]+)\b/u.exec(text);
    const code = /\bcode=(-?\d+)\b/u.exec(text);
    const category = /\bcategory=([a-z-]+)\b/u.exec(text);
    const location = /\blocation=([a-z-]+)\b/u.exec(text);
    const executable = /\bexecutable=([a-z-]+)\b/u.exec(text);
    const operation = /\boperation=([a-z-]+)\b/u.exec(text);
    if (stage?.[1]) lastAcpStage = stage[1];
    if (code?.[1]) lastAcpCode = code[1];
    if (category?.[1]) lastAcpCategory = category[1];
    if (location?.[1]) lastAcpLocation = location[1];
    if (executable?.[1]) lastAcpExecutable = executable[1];
    if (operation?.[1]) lastAcpOperation = operation[1];
  }
};
console.error = () => {};

function report(status: 'PASS' | 'FAIL', step: string): void {
  process.stdout.write(`${status} ${step}\n`);
}

function assertSmoke(condition: unknown): asserts condition {
  if (!condition) throw new Error('smoke assertion failed');
}

async function step(name: string, action: () => Promise<void>): Promise<void> {
  currentStep = name;
  await action();
  report('PASS', name);
}

function visibleText(events: readonly AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'text' }> => event.type === 'text')
    .map((event) => event.delta)
    .join('');
}

function systemSession(events: readonly AgentEvent[]): string | undefined {
  return events.find(
    (event): event is Extract<AgentEvent, { type: 'system' }> => event.type === 'system',
  )?.sessionId;
}

function assertNormalRun(
  events: readonly AgentEvent[],
  expectedSession?: string,
  diagnosticPrefix = 'normal-run',
): string {
  currentStep = `${diagnosticPrefix}-no-error`;
  assertSmoke(!events.some((event) => event.type === 'error'));
  const sessionId = systemSession(events);
  currentStep = `${diagnosticPrefix}-session`;
  assertSmoke(typeof sessionId === 'string' && sessionId.length > 0);
  currentStep = `${diagnosticPrefix}-session-match`;
  if (expectedSession !== undefined) assertSmoke(sessionId === expectedSession);
  currentStep = `${diagnosticPrefix}-done`;
  assertSmoke(
    events.some(
      (event) =>
        event.type === 'done' &&
        event.sessionId === sessionId &&
        event.terminationReason === 'normal',
    ),
  );
  return sessionId;
}

async function collectRun(
  adapter: KimiAdapter,
  cwd: string,
  prompt: string,
  sessionId?: string,
): Promise<AgentEvent[]> {
  let timedOut = false;
  const run = adapter.run({
    runId: `kimi-live-smoke-${randomUUID()}`,
    prompt,
    cwd,
    ...(sessionId ? { sessionId } : {}),
    stopGraceMs: 3_000,
  });
  currentRun = run;
  const timer = setTimeout(() => {
    timedOut = true;
    void run.stop();
  }, TURN_TIMEOUT_MS);
  const events: AgentEvent[] = [];
  try {
    for await (const event of run.events) events.push(event);
  } finally {
    clearTimeout(timer);
  }
  if (!(await run.waitForExit(EXIT_TIMEOUT_MS))) await run.stop();
  currentRun = undefined;
  assertSmoke(!timedOut);
  return events;
}

async function assertRejects(action: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assertSmoke(rejected);
}

async function assertMissing(path: string): Promise<void> {
  try {
    await access(path);
    throw new Error('unexpected filesystem entry');
  } catch (error) {
    assertSmoke((error as NodeJS.ErrnoException).code === 'ENOENT');
  }
}

async function removeFixture(
  path: string | undefined,
  expectedParent: string,
  expectedPrefix: string,
): Promise<void> {
  if (path === undefined) return;
  assertSmoke(dirname(path) === expectedParent);
  assertSmoke(basename(path).startsWith(expectedPrefix));
  const fromParent = relative(expectedParent, path);
  assertSmoke(
    fromParent !== '' &&
      fromParent !== '..' &&
      !fromParent.startsWith(`..${sep}`),
  );
  const info = await lstat(path);
  assertSmoke(info.isDirectory() && !info.isSymbolicLink());
  await rm(path, { recursive: true, force: false });
}

async function main(): Promise<void> {
  const rootDir = process.env.LARK_CHANNEL_HOME ?? resolveAppPaths().rootDir;
  const paths = resolveAppPaths({ rootDir, profile: PROFILE });
  let lock: AcquiredRuntimeLock | undefined;
  let workspace: string | undefined;
  let outsideDir: string | undefined;
  let workspaceRoot = '';
  let outsideParent = '';
  let failed = false;

  try {
    await step('preflight', async () => {
      assertSmoke(process.platform === 'darwin');
      await access('/usr/bin/sandbox-exec', constants.X_OK);
      await access(KIMI_BINARY, constants.X_OK);
      await access(paths.profileDir, constants.R_OK | constants.W_OK);
      await mkdir(paths.defaultWorkspaceDir, { recursive: true, mode: 0o700 });
      workspaceRoot = await realpath(paths.defaultWorkspaceDir);
      outsideParent = await realpath(dirname(workspaceRoot));
      lock = await acquireProfileRuntimeLock(paths, 'kimi');
    });

    workspace = await mkdtemp(join(workspaceRoot, FIXTURE_PREFIX));
    outsideDir = await mkdtemp(join(outsideParent, OUTSIDE_PREFIX));
    workspace = await realpath(workspace);
    outsideDir = await realpath(outsideDir);

    const allowedMarker = `READ_OK_${randomUUID()}`;
    const outsideMarker = `OUTSIDE_MUST_NOT_LEAK_${randomUUID()}`;
    const allowedFile = join(workspace, 'allowed.txt');
    const outsideFile = join(outsideDir, 'outside.txt');
    const escapeLink = join(workspace, 'escape-link.txt');
    const writeTarget = join(workspace, 'write-must-not-exist.txt');
    const seatbeltWriteTarget = join(workspace, 'seatbelt-write-must-not-exist.txt');
    await writeFile(allowedFile, `${allowedMarker}\n`, { encoding: 'utf8', mode: 0o600 });
    await writeFile(outsideFile, `${outsideMarker}\n`, { encoding: 'utf8', mode: 0o600 });
    await symlink(outsideFile, escapeLink, 'file');

    const adapter = new KimiAdapter({
      binary: KIMI_BINARY,
      profileStateDir: paths.profileDir,
      larkChannel: {
        profile: PROFILE,
        rootDir,
        configPath: paths.configFile,
        larkCliConfigDir: paths.larkCliConfigDir,
        larkCliSourceConfigFile: paths.larkCliSourceConfigFile,
      },
    });

    await step('adapter-availability-and-real-seatbelt', async () => {
      await adapter.prepareRun();
    });

    let freshSession = '';
    await step('session-new-and-read', async () => {
      currentStep = 'session-new-and-read-run';
      const events = await collectRun(
        adapter,
        workspace!,
        `请必须调用 Read 工具读取这个已知文件：${allowedFile}。只读取第一行，` +
          '然后只回复文件里的完整标识，不要调用其他工具。',
      );
      currentStep = 'session-new-and-read-terminal';
      freshSession = assertNormalRun(events, undefined, 'session-new-and-read');
      currentStep = 'session-new-and-read-tool';
      const reads = events.filter(
        (event): event is Extract<AgentEvent, { type: 'tool_use' }> =>
          event.type === 'tool_use' && event.name === 'Read',
      );
      assertSmoke(reads.length > 0);
      assertSmoke(
        events
          .filter((event) => event.type === 'tool_use')
          .every((event) => event.name === 'Read'),
      );
      currentStep = 'session-new-and-read-tool-result';
      assertSmoke(
        events.some(
          (event) => event.type === 'tool_result' && event.isError === false,
        ),
      );
      currentStep = 'session-new-and-read-answer';
      assertSmoke(visibleText(events).includes(allowedMarker));
    });

    await step('session-resume', async () => {
      const events = await collectRun(
        adapter,
        workspace!,
        '不要读取文件，也不要调用任何工具。只回复你上一轮读到的完整标识。',
        freshSession,
      );
      assertNormalRun(events, freshSession);
      assertSmoke(visibleText(events).includes(allowedMarker));
    });

    await step('symlink-escape-denied', async () => {
      const boundary = new KimiWorkspaceFs({
        cwd: workspace!,
        deniedRoots: [paths.profileDir],
      });
      await assertRejects(() =>
        boundary.readTextFile({
          sessionId: 'smoke-symlink-boundary',
          path: escapeLink,
        }),
      );

      const events = await collectRun(
        adapter,
        workspace!,
        `请必须调用 Read 工具读取这个已知文件：${escapeLink}。` +
          '如果读取失败，只回复精确文本 SYMLINK_DENIED；不要调用其他工具。',
      );
      assertNormalRun(events);
      assertSmoke(
        events.some(
          (event) => event.type === 'tool_use' && event.name === 'Read',
        ),
      );
      const text = visibleText(events);
      assertSmoke(!text.includes(outsideMarker));
      assertSmoke(
        events.some(
          (event) => event.type === 'tool_result' && event.isError === true,
        ) || text.includes('SYMLINK_DENIED'),
      );
    });

    await step('write-denied', async () => {
      const boundary = new KimiWorkspaceFs({
        cwd: workspace!,
        deniedRoots: [paths.profileDir],
      });
      await assertRejects(() =>
        boundary.writeTextFile({
          sessionId: 'smoke-write-boundary',
          path: writeTarget,
          content: 'must not be written',
        }),
      );
      await assertMissing(writeTarget);

      const imageOutputDir = join(paths.profileDir, 'images');
      const kimiHome = join(paths.profileDir, 'kimi-home');
      await mkdir(imageOutputDir, { recursive: true, mode: 0o700 });
      const probeEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        SHELL: KIMI_SAFE_LOGIN_SHELL,
        KIMI_CODE_HOME: kimiHome,
      };
      const launch = buildKimiLaunch({
        binary: '/usr/bin/touch',
        args: [seatbeltWriteTarget],
        cwd: workspace!,
        env: probeEnv,
        profileStateDir: paths.profileDir,
        imageOutputDir,
      });
      assertSmoke(launch.seatbeltProfile !== undefined);
      const probe = spawnSync(launch.command, launch.args, {
        cwd: workspace!,
        env: probeEnv,
        encoding: 'utf8',
      });
      assertSmoke(probe.error === undefined);
      assertSmoke(probe.status !== null && probe.status !== 0);
      await assertMissing(seatbeltWriteTarget);

      const events = await collectRun(
        adapter,
        workspace!,
        `不要调用任何工具。当前只读试点是否允许创建 ${writeTarget}？` +
          '只回复精确文本 WRITE_DENIED。',
      );
      assertNormalRun(events);
      assertSmoke(visibleText(events).includes('WRITE_DENIED'));
      await assertMissing(writeTarget);
    });

    await step('cancel', async () => {
      let timedOut = false;
      let stopIssued = false;
      const run = adapter.run({
        runId: `kimi-live-smoke-cancel-${randomUUID()}`,
        prompt:
          '不要调用任何工具。生成从 1 到 100000 的编号清单，每一项写一个完整句子。',
        cwd: workspace!,
        stopGraceMs: 3_000,
      });
      currentRun = run;
      const timer = setTimeout(() => {
        timedOut = true;
        void run.stop();
      }, TURN_TIMEOUT_MS);
      const events: AgentEvent[] = [];
      try {
        for await (const event of run.events) {
          events.push(event);
          if (!stopIssued && event.type === 'system') {
            stopIssued = true;
            await run.stop();
          }
        }
      } finally {
        clearTimeout(timer);
      }
      const exited = await run.waitForExit(EXIT_TIMEOUT_MS);
      currentRun = undefined;
      assertSmoke(!timedOut && stopIssued && exited);
      assertSmoke(
        events.some(
          (event) =>
            event.type === 'done' && event.terminationReason === 'interrupted',
        ),
      );
    });
  } catch {
    failed = true;
    const acpStage = currentStep.endsWith('-no-error')
      ? `-${lastAcpStage}-${lastAcpCode}-${lastAcpCategory}-${lastAcpLocation}-${lastAcpExecutable}-${lastAcpOperation}`
      : '';
    report('FAIL', `${currentStep}${acpStage}`);
  } finally {
    if (currentRun !== undefined) await currentRun.stop().catch(() => {});
    let cleanupFailed = false;
    try {
      await removeFixture(workspace, workspaceRoot, FIXTURE_PREFIX);
      await removeFixture(outsideDir, outsideParent, OUTSIDE_PREFIX);
    } catch {
      cleanupFailed = true;
      report('FAIL', 'cleanup');
    }
    try {
      await lock?.release();
    } catch {
      if (!cleanupFailed) report('FAIL', 'cleanup');
      cleanupFailed = true;
    }
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    if (!failed && !cleanupFailed) report('PASS', 'cleanup');
    if (failed || cleanupFailed) process.exitCode = 1;
  }
}

await main();
