import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { AccessMode } from '../../config/permissions';
import { KIMI_SAFE_LOGIN_SHELL } from './seatbelt';

const SAFETY_BEGIN = '# BEGIN LARK CHANNEL BRIDGE KIMI SAFETY';
const SAFETY_END = '# END LARK CHANNEL BRIDGE KIMI SAFETY';

const CONTROLLED_ROOT_KEYS = new Set([
  'telemetry',
  'default_permission_mode',
  'default_plan_mode',
  'extra_skill_dirs',
  'hooks',
  'merge_all_available_skills',
  'tools',
]);

// Text reads are served by the bridge through ACP's reverse fs RPC. Kimi
// 0.29.2 ignores the newer global [tools] table, so enumerate every audited
// built-in except Read as a deny rule instead of claiming an ineffective
// allowlist. The adapter pins this exact Kimi version and Seatbelt remains the
// physical write/process boundary beneath these engine-side rules.
export const KIMI_DISABLED_TOOLS = [
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
] as const;

export const KIMI_DENIED_TOOL_PATTERNS = [
  // Kimi's rule matcher canonicalizes this path lexically, so it is only a
  // first filter. The reverse ACP handler remains the authoritative realpath
  // boundary and rejects symlink escapes.
  'Read(!./**)',
  ...KIMI_DISABLED_TOOLS,
] as const;

const KIMI_BASE_ENV = {
  KIMI_DISABLE_TELEMETRY: '1',
  KIMI_DISABLE_CRON: '1',
  KIMI_CODE_NO_AUTO_UPDATE: '1',
  KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: 'false',
} as const;

export const KIMI_FORCED_ENV = {
  ...KIMI_BASE_ENV,
  SHELL: KIMI_SAFE_LOGIN_SHELL,
} as const;

export interface PreparedKimiProfileHome {
  homeDir: string;
  env: Record<string, string>;
}

export interface KimiConfigValidationLaunchInput {
  binary: string;
  args: readonly string[];
  cwd: string;
  profileEnv: NodeJS.ProcessEnv;
}

export interface KimiConfigValidationLaunch {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type KimiConfigValidationLauncher = (
  input: KimiConfigValidationLaunchInput,
) => KimiConfigValidationLaunch;

/**
 * Prepare the Kimi runtime home before spawning the ACP server.
 *
 * Kimi normally reads ~/.kimi-code. The bridge instead gives every profile a
 * private home and maintains a fail-closed permission block in that home. The
 * merge is serialized across bridge processes and only replaces config.toml
 * after Kimi itself accepts the complete candidate.
 */
export function prepareKimiProfileHome(
  binary: string,
  profileStateDir: string,
  options: {
    accessMode?: AccessMode;
    shell?: string;
    validationLauncher?: KimiConfigValidationLauncher;
  } = {},
): PreparedKimiProfileHome {
  const accessMode = options.accessMode ?? 'read-only';
  const homeDir = join(profileStateDir, 'kimi-home');
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  chmodSync(homeDir, 0o700);
  const cacheDir = join(homeDir, 'cache');
  const tempDir = join(homeDir, 'tmp');
  for (const dir of [cacheDir, tempDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  const env: Record<string, string> = {
    ...KIMI_BASE_ENV,
    SHELL:
      accessMode === 'read-only'
        ? KIMI_SAFE_LOGIN_SHELL
        : options.shell?.trim() || '/bin/zsh',
    KIMI_CODE_HOME: homeDir,
    // The native SEA loader resolves these before Kimi's ordinary data-dir
    // helpers. Keep extraction and temporary files inside the profile home so
    // macOS Seatbelt never needs access to ~/Library/Caches or system temp.
    KIMI_CODE_CACHE_DIR: cacheDir,
    TMPDIR: tempDir,
  };
  withProfileHomeLock(homeDir, () =>
    maintainSafetyConfig(binary, homeDir, env, accessMode, options.validationLauncher),
  );
  return { homeDir, env };
}

function withProfileHomeLock<T>(homeDir: string, fn: () => T): T {
  const target = join(homeDir, '.lark-channel-bridge-safety');
  writeFileSync(target, '', { flag: 'a', mode: 0o600 });
  chmodSync(target, 0o600);
  const release = acquireProfileHomeLock(target);
  try {
    return fn();
  } finally {
    release();
  }
}

function acquireProfileHomeLock(target: string): () => void {
  // proper-lockfile deliberately rejects `retries` in its sync API. Adapter
  // startup is synchronous, so retry ELOCKED with a short bounded wait while
  // preserving the library's stale-lock handling and ownership checks.
  const deadline = Date.now() + 5_000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      return lockfile.lockSync(target, {
        realpath: false,
        // spawnSync blocks the event loop while `kimi doctor` runs, so give
        // the lock a stale window comfortably above doctor's 30s timeout.
        stale: 120_000,
        update: 60_000,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ELOCKED' || Date.now() >= deadline) throw err;
      Atomics.wait(waiter, 0, 0, 25);
    }
  }
}

function maintainSafetyConfig(
  binary: string,
  homeDir: string,
  forcedEnv: Record<string, string>,
  accessMode: AccessMode,
  validationLauncher?: KimiConfigValidationLauncher,
): void {
  const configPath = join(homeDir, 'config.toml');
  const source = readOptionalFile(configPath);
  assertWellFormedSafetyMarkers(source);

  // Refuse to reinterpret a broken user/login config. This makes the textual
  // merge conservative: it only has to transform TOML Kimi already accepts.
  if (source !== undefined) {
    validateWithKimi(binary, configPath, homeDir, forcedEnv, validationLauncher);
  }

  const candidate = mergeSafetyConfig(source ?? '', accessMode);
  if (source === candidate) {
    chmodSync(configPath, 0o600);
    return;
  }
  writeValidatedAtomic(
    binary,
    configPath,
    candidate,
    homeDir,
    forcedEnv,
    validationLauncher,
  );
}

function readOptionalFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function mergeSafetyConfig(source: string, accessMode: AccessMode): string {
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const withoutOldBlock = removeSafetyBlock(normalized);
  const lines = removeControlledToolsTable(withoutOldBlock.split('\n'));
  const analysis = analyzeTomlLines(lines);
  const kept = lines.filter((line, index) => {
    if (index >= analysis.firstTableIndex || !analysis.topLevelAtStart[index]) return true;
    const key = rootAssignmentKey(line);
    return key === undefined || !CONTROLLED_ROOT_KEYS.has(key);
  });

  const keptAnalysis = analyzeTomlLines(kept);
  const prefix = kept.slice(0, keptAnalysis.firstTableIndex);
  const suffix = kept.slice(keptAnalysis.firstTableIndex);
  trimTrailingBlankLines(prefix);
  trimLeadingBlankLines(suffix);

  const output = [
    ...prefix,
    ...(prefix.length > 0 ? [''] : []),
    ...safetyBlockLines(accessMode),
    ...(suffix.length > 0 ? ['', ...suffix] : []),
  ];
  trimTrailingBlankLines(output);
  return `${output.join('\n')}\n`;
}

function safetyBlockLines(accessMode: AccessMode): string[] {
  if (accessMode !== 'read-only') {
    return [
      SAFETY_BEGIN,
      'telemetry = false',
      'default_permission_mode = "yolo"',
      'default_plan_mode = false',
      'hooks = []',
      'merge_all_available_skills = false',
      'extra_skill_dirs = []',
      SAFETY_END,
    ];
  }
  const rules = KIMI_DENIED_TOOL_PATTERNS.flatMap((pattern, index) => [
    ...(index === 0 ? [] : ['']),
    '[[permission.rules]]',
    'decision = "deny"',
    `pattern = ${JSON.stringify(pattern)}`,
  ]);
  return [
    SAFETY_BEGIN,
    'telemetry = false',
    'default_permission_mode = "manual"',
    // Kimi 0.29.2 plan mode maintains a plan file, which conflicts with this
    // pilot's deny-all-writes boundary. Keep construction in manual mode, then
    // require the adapter's explicit session/set_mode("default") before it
    // publishes or prompts the session. The deny rules, reverse ACP handler,
    // and Seatbelt enforce read-only behavior independently of agent mode.
    'default_plan_mode = false',
    'hooks = []',
    'merge_all_available_skills = false',
    'extra_skill_dirs = []',
    '',
    ...rules,
    '',
    SAFETY_END,
  ];
}

function removeControlledToolsTable(lines: string[]): string[] {
  const headers = tableHeaders(lines);
  const toolsHeaders = headers.filter((header) => header.name === 'tools');
  if (toolsHeaders.length > 1) {
    throw new Error('Kimi config contains duplicate [tools] tables');
  }
  const tools = toolsHeaders[0];
  if (tools === undefined) return lines;
  // Kimi 0.29.2 silently ignores this newer table. Strip it rather than leave
  // a misleading apparent allowlist; the generated permission deny rules are
  // the supported engine-side tool boundary for this pinned version.
  const next = headers.find((header) => header.index > tools.index)?.index ?? lines.length;
  return [...lines.slice(0, tools.index), ...lines.slice(next)];
}

interface TableHeader {
  index: number;
  name?: string;
}

function tableHeaders(lines: readonly string[]): TableHeader[] {
  let multiline: MultilineString;
  let arrayDepth = 0;
  let inlineTableDepth = 0;
  const headers: TableHeader[] = [];
  for (const [index, line] of lines.entries()) {
    const atTopLevel = multiline === undefined && arrayDepth === 0 && inlineTableDepth === 0;
    if (atTopLevel && beginsTableHeader(line)) {
      headers.push({ index, name: exactTableName(line) });
      continue;
    }
    ({ multiline, arrayDepth, inlineTableDepth } = scanTomlLine(line, {
      multiline,
      arrayDepth,
      inlineTableDepth,
    }));
  }
  return headers;
}

function exactTableName(line: string): string | undefined {
  const match = /^\s*\[\s*(?:tools|"tools"|'tools')\s*\]\s*(?:#.*)?$/.exec(line);
  return match ? 'tools' : undefined;
}

function assertWellFormedSafetyMarkers(source: string | undefined): void {
  if (source === undefined) return;
  const lines = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const begins: number[] = [];
  const ends: number[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (line.includes(SAFETY_BEGIN) && trimmed !== SAFETY_BEGIN) {
      throw new Error('Kimi safety config has an ambiguous BEGIN marker');
    }
    if (line.includes(SAFETY_END) && trimmed !== SAFETY_END) {
      throw new Error('Kimi safety config has an ambiguous END marker');
    }
    if (trimmed === SAFETY_BEGIN) begins.push(index);
    if (trimmed === SAFETY_END) ends.push(index);
  }
  const absent = begins.length === 0 && ends.length === 0;
  if (absent) return;
  if (begins.length !== 1 || ends.length !== 1 || begins[0]! >= ends[0]!) {
    throw new Error('Kimi safety config has malformed or duplicate bridge markers');
  }
}

function removeSafetyBlock(source: string): string {
  const lines = source.split('\n');
  const begin = lines.findIndex((line) => line.trim() === SAFETY_BEGIN);
  if (begin === -1) return source;
  const end = lines.findIndex((line, index) => index > begin && line.trim() === SAFETY_END);
  return [...lines.slice(0, begin), ...lines.slice(end + 1)].join('\n');
}

interface TomlAnalysis {
  firstTableIndex: number;
  topLevelAtStart: boolean[];
}

type MultilineString = 'basic' | 'literal' | undefined;

/**
 * Locate the first TOML table without confusing headers with bracket-looking
 * text inside multiline strings, arrays, or inline tables. The source has
 * already passed `kimi doctor config`; this scanner deliberately handles only
 * the boundary needed for a lossless root-key insertion, not TOML parsing.
 */
function analyzeTomlLines(lines: readonly string[]): TomlAnalysis {
  let multiline: MultilineString;
  let arrayDepth = 0;
  let inlineTableDepth = 0;
  let firstTableIndex = lines.length;
  const topLevelAtStart: boolean[] = [];

  for (const [lineIndex, line] of lines.entries()) {
    const atTopLevel = multiline === undefined && arrayDepth === 0 && inlineTableDepth === 0;
    topLevelAtStart.push(atTopLevel);
    if (atTopLevel && beginsTableHeader(line)) {
      firstTableIndex = lineIndex;
      break;
    }
    ({ multiline, arrayDepth, inlineTableDepth } = scanTomlLine(line, {
      multiline,
      arrayDepth,
      inlineTableDepth,
    }));
  }

  while (topLevelAtStart.length < lines.length) topLevelAtStart.push(false);
  return { firstTableIndex, topLevelAtStart };
}

function beginsTableHeader(line: string): boolean {
  const index = firstNonWhitespace(line);
  return index !== -1 && line[index] === '[';
}

interface TomlScanState {
  multiline: MultilineString;
  arrayDepth: number;
  inlineTableDepth: number;
}

function scanTomlLine(line: string, initial: TomlScanState): TomlScanState {
  let { multiline, arrayDepth, inlineTableDepth } = initial;
  let index = 0;

  while (index < line.length) {
    if (multiline === 'basic') {
      const end = findUnescapedTripleQuote(line, index, '"');
      if (end === -1) return { multiline, arrayDepth, inlineTableDepth };
      multiline = undefined;
      index = end + 3;
      continue;
    }
    if (multiline === 'literal') {
      const end = line.indexOf("'''", index);
      if (end === -1) return { multiline, arrayDepth, inlineTableDepth };
      multiline = undefined;
      index = end + 3;
      continue;
    }

    const char = line[index]!;
    if (char === '#') break;
    if (line.startsWith('"""', index)) {
      multiline = 'basic';
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      multiline = 'literal';
      index += 3;
      continue;
    }
    if (char === '"') {
      index = skipBasicString(line, index + 1);
      continue;
    }
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      index = end === -1 ? line.length : end + 1;
      continue;
    }
    if (char === '[') arrayDepth += 1;
    else if (char === ']') arrayDepth = Math.max(0, arrayDepth - 1);
    else if (char === '{') inlineTableDepth += 1;
    else if (char === '}') inlineTableDepth = Math.max(0, inlineTableDepth - 1);
    index += 1;
  }

  return { multiline, arrayDepth, inlineTableDepth };
}

function findUnescapedTripleQuote(line: string, start: number, quote: string): number {
  for (let index = start; index <= line.length - 3; index += 1) {
    if (!line.startsWith(quote.repeat(3), index)) continue;
    let backslashes = 0;
    for (let before = index - 1; before >= 0 && line[before] === '\\'; before -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

function skipBasicString(line: string, start: number): number {
  for (let index = start; index < line.length; index += 1) {
    if (line[index] === '\\') {
      index += 1;
      continue;
    }
    if (line[index] === '"') return index + 1;
  }
  return line.length;
}

function rootAssignmentKey(line: string): string | undefined {
  let index = firstNonWhitespace(line);
  if (index === -1 || line[index] === '#') return undefined;

  let key: string;
  if (line[index] === '"') {
    const end = findClosingBasicQuote(line, index + 1);
    if (end === -1) return undefined;
    try {
      key = JSON.parse(line.slice(index, end + 1)) as string;
    } catch {
      return undefined;
    }
    index = end + 1;
  } else if (line[index] === "'") {
    const end = line.indexOf("'", index + 1);
    if (end === -1) return undefined;
    key = line.slice(index + 1, end);
    index = end + 1;
  } else {
    const match = /^[A-Za-z0-9_-]+/.exec(line.slice(index));
    if (!match) return undefined;
    key = match[0];
    index += key.length;
  }

  while (line[index] === ' ' || line[index] === '\t') index += 1;
  // Dotted tools assignments are another valid spelling of the controlled
  // [tools] table. Removing their leading lines is conservative: if a value
  // spans lines, doctor rejects the candidate and the original stays intact.
  if (key === 'tools' && line[index] === '.') return key;
  return line[index] === '=' ? key : undefined;
}

function findClosingBasicQuote(line: string, start: number): number {
  for (let index = start; index < line.length; index += 1) {
    if (line[index] === '\\') {
      index += 1;
      continue;
    }
    if (line[index] === '"') return index;
  }
  return -1;
}

function firstNonWhitespace(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== ' ' && line[index] !== '\t') return index;
  }
  return -1;
}

function trimTrailingBlankLines(lines: string[]): void {
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
}

function trimLeadingBlankLines(lines: string[]): void {
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();
}

function writeValidatedAtomic(
  binary: string,
  configPath: string,
  contents: string,
  homeDir: string,
  forcedEnv: Record<string, string>,
  validationLauncher?: KimiConfigValidationLauncher,
): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const tempPath = join(
    dirname(configPath),
    `.config.toml.lark-channel-bridge-${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    validateWithKimi(binary, tempPath, homeDir, forcedEnv, validationLauncher);
    renameSync(tempPath, configPath);
    chmodSync(configPath, 0o600);
    fsyncDirectory(dirname(configPath));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function validateWithKimi(
  binary: string,
  configPath: string,
  homeDir: string,
  forcedEnv: Record<string, string>,
  validationLauncher?: KimiConfigValidationLauncher,
): void {
  const input: KimiConfigValidationLaunchInput = {
    binary,
    args: ['doctor', 'config', configPath],
    cwd: homeDir,
    profileEnv: { ...forcedEnv, KIMI_CODE_HOME: homeDir },
  };
  const launch = validationLauncher?.(input) ?? {
    command: input.binary,
    args: input.args,
    cwd: input.cwd,
    env: { ...process.env, ...input.profileEnv },
  };
  const result = spawnSync(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: launch.env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Could not validate the Kimi profile safety config: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    // Doctor output can refer to user-owned config values. Keep it out of
    // bridge errors so provider credentials can never be echoed to chat/logs.
    throw new Error(`Kimi rejected the profile safety config (exit ${String(result.status)})`);
  }
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort on filesystems that do not support it.
  }
}
