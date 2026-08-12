import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProfileConfig } from '../config/profile-schema';

export type WorkingDirectoryRejectReason =
  | 'empty-requested-cwd'
  | 'path-inaccessible'
  | 'not-directory'
  | 'filesystem-root'
  | 'home-root'
  | 'user-root'
  | 'system-root'
  | 'temp-root'
  | 'broad-user-folder'
  | 'volume-root'
  | 'outside-profile-root';

export type WorkingDirectoryResolveResult =
  | { ok: true; requestedCwd: string; cwdRealpath: string }
  | {
      ok: false;
      reason: WorkingDirectoryRejectReason;
      requestedCwd: string;
      userVisible: string;
    };

export async function resolveWorkingDirectory(
  requestedCwd: string,
): Promise<WorkingDirectoryResolveResult> {
  const trimmed = requestedCwd.trim();
  if (!trimmed) {
    return reject('empty-requested-cwd', requestedCwd, '未指定工作目录。');
  }

  let resolved: string;
  try {
    resolved = await realpath(trimmed);
  } catch {
    return reject('path-inaccessible', requestedCwd, `工作目录不存在或不可访问：${requestedCwd}`);
  }

  const info = await stat(resolved).catch(() => undefined);
  if (!info?.isDirectory()) {
    return reject('not-directory', requestedCwd, `路径不是目录：${resolved}`);
  }

  const tempRealpath = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const broad = classifyHighRiskWorkingDirectory(resolved, requestedCwd, tempRealpath);
  if (broad) return broad;

  return {
    ok: true,
    requestedCwd,
    cwdRealpath: resolved,
  };
}

/**
 * Return the configured authorization roots in precedence order. The default
 * workspace remains both the fallback cwd and an authorization root. Older
 * profiles without allowedRoots therefore keep their previous behavior.
 */
export function allowedWorkspaceRoots(workspaces: ProfileConfig['workspaces']): string[] {
  const roots = [workspaces.default, ...(workspaces.allowedRoots ?? [])];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const configuredRoot of roots) {
    const root = configuredRoot?.trim();
    if (!root || seen.has(root)) continue;
    seen.add(root);
    result.push(root);
  }

  return result;
}

/**
 * Resolve the active cwd and enforce Kimi's profile-root authorization.
 *
 * Only the selected cwd is returned to the run policy. Additional roots are
 * authorization choices, not extra filesystem grants for the spawned agent.
 */
export async function resolveAuthorizedWorkingDirectory(
  requestedCwd: string,
  profileConfig: ProfileConfig,
): Promise<WorkingDirectoryResolveResult> {
  const workspace = await resolveWorkingDirectory(requestedCwd);
  if (!workspace.ok || profileConfig.agentKind !== 'kimi') return workspace;

  for (const configuredRoot of allowedWorkspaceRoots(profileConfig.workspaces)) {
    const root = await resolveCanonicalAuthorizationRoot(configuredRoot);
    if (!root) continue;
    if (containsCanonicalPath(root, workspace.cwdRealpath)) return workspace;
  }

  return reject(
    'outside-profile-root',
    requestedCwd,
    'Kimi 只允许使用 Profile 授权工作目录及其子目录。',
  );
}

/**
 * Resolve both paths before checking containment so symlinks cannot escape
 * the configured profile workspace. Both paths must be usable directories,
 * the root must be a canonical configured path, and the root itself is
 * allowed.
 */
export async function isWorkingDirectoryWithinRoot(
  requestedCwd: string,
  allowedRoot: string,
): Promise<boolean> {
  const [workspace, root] = await Promise.all([
    resolveWorkingDirectory(requestedCwd),
    resolveCanonicalAuthorizationRoot(allowedRoot),
  ]);
  return workspace.ok && root !== undefined && containsCanonicalPath(root, workspace.cwdRealpath);
}

async function resolveCanonicalAuthorizationRoot(
  configuredRoot: string,
): Promise<string | undefined> {
  const root = await resolveWorkingDirectory(configuredRoot);
  if (!root.ok) return undefined;

  // Profile startup canonicalizes authorization roots. If a canonical root is
  // later replaced by a symlink, realpath no longer matches the configured
  // snapshot and the grant fails closed instead of silently moving elsewhere.
  if (root.cwdRealpath !== configuredRoot) return undefined;
  return root.cwdRealpath;
}

function containsCanonicalPath(rootRealpath: string, candidateRealpath: string): boolean {
  const fromRoot = relative(rootRealpath, candidateRealpath);
  return (
    fromRoot === '' ||
    (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function reject(
  reason: WorkingDirectoryRejectReason,
  requestedCwd: string,
  userVisible: string,
): WorkingDirectoryResolveResult {
  return { ok: false, reason, requestedCwd, userVisible };
}

function classifyHighRiskWorkingDirectory(
  real: string,
  requestedCwd: string,
  tempRealpath: string,
): WorkingDirectoryResolveResult | undefined {
  if (real === dirname(real)) {
    return reject('filesystem-root', requestedCwd, '不能把文件系统根目录设为工作目录。');
  }

  const home = resolve(homedir());
  if (real === home) {
    return reject('home-root', requestedCwd, '不能把 Home 根目录设为工作目录，请选择更具体的子目录。');
  }
  if (real === dirname(home)) {
    return reject('user-root', requestedCwd, '不能把用户目录根设为工作目录，请选择更具体的子目录。');
  }

  if (dirname(real) === home && new Set(['Desktop', 'Downloads']).has(basename(real))) {
    return reject('broad-user-folder', requestedCwd, '这个目录范围过大，请选择更具体的子目录。');
  }

  const temp = resolve(tmpdir());
  if (real === temp || real === tempRealpath || real === '/tmp' || real === '/private/tmp') {
    return reject('temp-root', requestedCwd, '不能把临时目录根设为工作目录，请选择更具体的子目录。');
  }

  const systemRoots = new Set([
    '/Applications',
    '/bin',
    '/cores',
    '/dev',
    '/etc',
    '/home',
    '/Library',
    '/mnt',
    '/Network',
    '/opt',
    '/private',
    '/private/etc',
    '/private/var',
    '/sbin',
    '/srv',
    '/System',
    '/usr',
    '/var',
  ]);
  if (systemRoots.has(real)) {
    return reject('system-root', requestedCwd, '不能把系统目录设为工作目录。');
  }

  if (real === '/Volumes' || dirname(real) === '/Volumes') {
    return reject('volume-root', requestedCwd, '不能把磁盘卷根目录设为工作目录，请选择更具体的子目录。');
  }

  return undefined;
}
