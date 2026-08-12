import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { AccessMode } from '../../config/permissions';

const DEFAULT_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const KIMI_SAFE_LOGIN_SHELL = '/usr/bin/false';

export interface KimiSeatbeltTestOverrides {
  /** Test-only platform override. Production callers must omit this object. */
  platform?: NodeJS.Platform;
  /** Explicitly permits direct spawn in process-contract tests only. */
  allowUnsandboxed?: boolean;
  sandboxExecPath?: string;
  osHomeDir?: string;
}

export interface KimiLaunchInput {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  profileStateDir: string;
  imageOutputDir: string;
  accessMode?: AccessMode;
  purpose?: 'agent' | 'config-validation';
  testOverrides?: KimiSeatbeltTestOverrides;
}

export interface KimiLaunch {
  command: string;
  args: string[];
  seatbeltProfile?: string;
}

/**
 * Wrap Kimi in macOS Seatbelt. Production runs on other platforms fail closed;
 * only explicit process-contract overrides may spawn directly. Darwin errors
 * must never downgrade a remotely reachable group bot to an unsandboxed run.
 */
export function buildKimiLaunch(input: KimiLaunchInput): KimiLaunch {
  const accessMode = input.accessMode ?? 'read-only';
  if (accessMode === 'full') {
    return {
      command: resolveRequiredExecutable(input.binary, input.cwd, input.env, 'Kimi binary'),
      args: [...input.args],
    };
  }

  const platform = input.testOverrides?.platform ?? process.platform;
  if (platform !== 'darwin') {
    if (input.testOverrides?.allowUnsandboxed === true) {
      return { command: input.binary, args: [...input.args] };
    }
    throw new Error(
      `Kimi Seatbelt is only supported on macOS; refusing unsandboxed run on ${platform}`,
    );
  }

  const sandboxExec = resolveRequiredExecutable(
    input.testOverrides?.sandboxExecPath ?? DEFAULT_SANDBOX_EXEC,
    input.cwd,
    input.env,
    'sandbox-exec',
  );
  const binary = resolveRequiredExecutable(input.binary, input.cwd, input.env, 'Kimi binary');
  const configuredShell = input.env.SHELL?.trim();
  if (!configuredShell) {
    throw new Error('Kimi Seatbelt requires a login shell');
  }
  if (accessMode === 'read-only' && configuredShell !== KIMI_SAFE_LOGIN_SHELL) {
    throw new Error('Kimi read-only Seatbelt requires the fixed no-op login shell');
  }
  const loginShell = resolveRequiredExecutable(
    configuredShell,
    input.cwd,
    input.env,
    accessMode === 'read-only' ? 'Kimi no-op login shell' : 'Kimi login shell',
  );
  // Kimi 0.29.x is a Node SEA executable and loads adjacent payload data at
  // startup. Literal access to the executable alone crashes before ACP can
  // initialize, so the containing install directory is the smallest working
  // read exception. Never grant it when that directory overlaps the remotely
  // selected workspace, or it would become a local-read bypass around ACP.
  const binaryDir = dirname(binary);
  const cwd = resolveRequiredDirectory(input.cwd, 'Kimi cwd');
  const kimiCodeHomeValue = input.env.KIMI_CODE_HOME?.trim();
  if (!kimiCodeHomeValue) {
    throw new Error('Kimi Seatbelt requires KIMI_CODE_HOME');
  }
  const kimiCodeHome = resolveRequiredDirectory(kimiCodeHomeValue, 'KIMI_CODE_HOME');
  // Keep the bridge image path in the child environment for prompt/context
  // compatibility, but do not grant Kimi filesystem access to it. Attachments
  // and image generation are outside the read-only pilot.
  resolveRequiredDirectory(input.imageOutputDir, 'LARK_CHANNEL_IMAGE_DIR');
  const osHome = resolveRequiredDirectory(
    input.testOverrides?.osHomeDir ?? userInfo().homedir,
    'OS user Home',
  );
  const bootstrapReadExceptions =
    accessMode === 'read-only' && (input.purpose ?? 'agent') === 'agent'
      ? guardedWorkspaceBootstrapReads(cwd)
      : [];
  const gitMetadataExceptions =
    accessMode === 'read-only' && (input.purpose ?? 'agent') === 'agent'
      ? guardedGitMetadataProbes(cwd, osHome)
      : [];
  const fullReadExceptions = uniquePaths([
    binaryDir,
    kimiCodeHome,
    ...(accessMode === 'workspace' ? [cwd] : []),
  ]);
  const metadataReadExceptions = [cwd];
  for (const path of [...fullReadExceptions, ...metadataReadExceptions]) {
    assertDoesNotExposeWholeHome(path, osHome);
  }
  assertPathsDoNotOverlap(binaryDir, cwd, 'Kimi binary directory', 'Kimi cwd');
  if ((input.purpose ?? 'agent') === 'agent') {
    assertPathsDoNotOverlap(kimiCodeHome, cwd, 'KIMI_CODE_HOME', 'Kimi cwd');
  }
  const executableExceptions = [binary, loginShell];

  const profile = buildKimiSeatbeltProfile({
    osHome,
    // Workspace mode exposes exactly the active canonical cwd for this run.
    // Profile-level allowed roots are intentionally resolved before reaching
    // the adapter and must never become ambient Seatbelt read exceptions.
    restrictReadsToExceptions: accessMode === 'workspace',
    dataReadDeniedPaths:
      accessMode === 'read-only' && (input.purpose ?? 'agent') === 'agent' ? [cwd] : [],
    fullReadExceptions,
    literalDataReadExceptions: bootstrapReadExceptions,
    literalReadExceptions: [binary],
    metadataReadExceptions,
    // Node's os.homedir() probes the Home directory entry itself on macOS.
    // Grant metadata for that one literal only; this does not permit listing
    // Home or reading any file data beneath it.
    literalMetadataReadExceptions: [osHome, ...gitMetadataExceptions],
    writeExceptions: uniquePaths([
      kimiCodeHome,
      ...(accessMode === 'workspace' ? [cwd] : []),
    ]),
    executableExceptions,
    allowProcessExec: accessMode === 'workspace',
  });

  return {
    command: sandboxExec,
    args: ['-p', profile, binary, ...input.args],
    seatbeltProfile: profile,
  };
}

export function buildKimiSeatbeltProfile(input: {
  osHome: string;
  restrictReadsToExceptions: boolean;
  dataReadDeniedPaths: readonly string[];
  fullReadExceptions: readonly string[];
  literalDataReadExceptions: readonly string[];
  literalReadExceptions: readonly string[];
  metadataReadExceptions: readonly string[];
  literalMetadataReadExceptions: readonly string[];
  writeExceptions: readonly string[];
  executableExceptions: readonly string[];
  allowProcessExec?: boolean;
}): string {
  if (input.allowProcessExec !== true && input.executableExceptions.length === 0) {
    throw new Error('Kimi Seatbelt requires at least the Kimi executable');
  }
  return [
    '(version 1)',
    '(allow default)',
    ...(input.restrictReadsToExceptions === true
      ? [
          // Keep non-filesystem capabilities available for Kimi workspace
          // mode, but make file reads fail closed. system.sb is Apple's
          // process-bootstrap baseline (dyld, system libraries, locale and
          // special devices); project and profile data remain explicit below.
          '(deny file-read*)',
          '(import "system.sb")',
        ]
      : []),
    `(deny file-read* (subpath ${seatbeltStringLiteral(input.osHome)}))`,
    ...(input.dataReadDeniedPaths.length > 0
      ? [seatbeltRule('deny', 'file-read-data', 'subpath', input.dataReadDeniedPaths)]
      : []),
    seatbeltRule('allow', 'file-read*', 'subpath', input.fullReadExceptions),
    ...(input.literalDataReadExceptions.length > 0
      ? [seatbeltRule('allow', 'file-read-data', 'literal', input.literalDataReadExceptions)]
      : []),
    seatbeltRule('allow', 'file-read*', 'literal', input.literalReadExceptions),
    seatbeltRule('allow', 'file-read-metadata', 'subpath', input.metadataReadExceptions),
    ...(input.literalMetadataReadExceptions.length > 0
      ? [
          seatbeltRule(
            'allow',
            'file-read-metadata',
            'literal',
            input.literalMetadataReadExceptions,
          ),
        ]
      : []),
    '(deny file-write*)',
    seatbeltRule('allow', 'file-write*', 'subpath', input.writeExceptions),
    '(allow file-read* file-write* (literal "/dev/null"))',
    ...(input.allowProcessExec === true
      ? []
      : [
          '(deny process-exec*)',
          seatbeltRule('allow', 'process-exec', 'literal', input.executableExceptions),
        ]),
  ].join('\n');
}

/** Escape a filesystem path for a Seatbelt Scheme string, never a shell. */
export function seatbeltStringLiteral(value: string): string {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('Seatbelt path contains an empty or control-character value');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function seatbeltRule(
  decision: 'allow' | 'deny',
  operation: string,
  filter: 'literal' | 'subpath',
  paths: readonly string[],
): string {
  if (paths.length === 0) throw new Error(`Seatbelt ${operation} rule has no paths`);
  const predicates = paths.map((path) => `(${filter} ${seatbeltStringLiteral(path)})`).join(' ');
  return `(${decision} ${operation} ${predicates})`;
}

function resolveRequiredExecutable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): string {
  const resolved = resolveExecutable(command, cwd, env);
  if (!resolved) throw new Error(`Kimi Seatbelt could not resolve ${label}: ${command}`);
  return resolved;
}

function resolveExecutable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const candidates = isAbsolute(command)
    ? [command]
    : command.includes('/') || command.includes('\\')
      ? [resolve(cwd, command)]
      : (env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (!statSync(candidate).isFile()) continue;
      return realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

function resolveRequiredDirectory(path: string, label: string): string {
  try {
    const resolved = realpathSync(path);
    if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
    return resolved;
  } catch (err) {
    throw new Error(`Kimi Seatbelt could not resolve ${label}: ${path}`, { cause: err });
  }
}

function assertDoesNotExposeWholeHome(exception: string, osHome: string): void {
  if (exception === osHome || containsPath(exception, osHome)) {
    throw new Error(`Kimi Seatbelt exception would expose the OS user Home: ${exception}`);
  }
}

function assertPathsDoNotOverlap(
  left: string,
  right: string,
  leftLabel: string,
  rightLabel: string,
): void {
  if (containsPath(left, right) || containsPath(right, left)) {
    throw new Error(
      `Kimi Seatbelt refuses overlapping ${leftLabel} and ${rightLabel}: ${left} / ${right}`,
    );
  }
}

function containsPath(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return (
    fromParent === '' ||
    (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  );
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function guardedWorkspaceBootstrapReads(cwd: string): string[] {
  const paths = [
    join(cwd, '.mcp.json'),
    join(cwd, '.kimi-code', 'local.toml'),
    join(cwd, '.kimi-code', 'mcp.json'),
  ];
  for (const path of paths) {
    assertNoSymlinkComponents(cwd, path);
    try {
      lstatSync(path);
      throw new Error('Kimi group pilot refuses a workspace bootstrap configuration file');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return paths;
}

function guardedGitMetadataProbes(cwd: string, osHome: string): string[] {
  const exceptions: string[] = [];
  let current = cwd;
  while (true) {
    const marker = join(current, '.git');
    try {
      lstatSync(marker);
      throw new Error('Kimi group pilot refuses Git workspaces');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (containsPath(osHome, marker)) exceptions.push(marker);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return exceptions;
}

function assertNoSymlinkComponents(root: string, path: string): void {
  const fromRoot = relative(root, path);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Kimi group pilot received an invalid bootstrap path');
  }
  let current = root;
  for (const part of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error('Kimi group pilot refuses a symlinked bootstrap path');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}
