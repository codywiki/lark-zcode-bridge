import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface KimiBootstrapGuardInput {
  cwd: string;
  kimiHome: string;
  osHome: string;
}

/**
 * Reject files Kimi 0.29.x reads locally during session construction.
 *
 * Those reads deliberately use LocalKaos/direct node:fs instead of AcpKaos,
 * so the ACP workspace reader cannot police them. The organization-wide pilot
 * keeps these optional extension surfaces absent and lets Seatbelt deny all
 * ordinary workspace file data. This also closes a symlink-to-credential
 * escape through AGENTS.md, MCP config, local config, skills, or plugins.
 */
export function assertKimiBootstrapPathsSafe(input: KimiBootstrapGuardInput): void {
  const cwd = resolve(input.cwd);
  const kimiHome = resolve(input.kimiHome);
  const osHome = resolve(input.osHome);
  const projectRoot = findProjectRoot(cwd);

  const forbiddenFiles = new Set<string>([
    join(kimiHome, 'AGENTS.md'),
    join(kimiHome, 'mcp.json'),
    join(kimiHome, 'plugins', 'installed.json'),
    join(projectRoot, '.mcp.json'),
    join(projectRoot, '.kimi-code', 'local.toml'),
    join(cwd, '.kimi-code', 'mcp.json'),
  ]);
  for (const dir of dirsRootToLeaf(cwd, projectRoot)) {
    forbiddenFiles.add(join(dir, '.kimi-code', 'AGENTS.md'));
    forbiddenFiles.add(join(dir, 'AGENTS.md'));
    forbiddenFiles.add(join(dir, 'agents.md'));
  }

  const forbiddenRoots = [
    join(kimiHome, 'skills'),
    join(projectRoot, '.kimi-code', 'skills'),
    join(projectRoot, '.agents', 'skills'),
  ];

  for (const path of [...forbiddenFiles, ...forbiddenRoots]) {
    if (!pathEntryExists(path)) continue;
    throw new Error(
      `Kimi group pilot refuses local bootstrap file or extension path: ${displayPath(path, cwd, kimiHome)}`,
    );
  }

  // Kimi may probe the conventional ~/.agents locations even with skill
  // merging disabled. Normal entries remain inaccessible under Seatbelt and
  // must not block machines that already use Codex skills. Symlinked entries
  // are different: resolving one into the Kimi profile (an allowed read root)
  // or outside Home could bypass the Home deny, so reject them before spawn.
  for (const path of [
    join(osHome, '.agents', 'AGENTS.md'),
    join(osHome, '.agents', 'agents.md'),
    join(osHome, '.agents', 'skills'),
  ]) {
    assertNoSymlinkComponents(path, osHome);
  }
}

function assertNoSymlinkComponents(path: string, root: string): void {
  const fromRoot = relative(root, path);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('Kimi group pilot received an invalid OS Home bootstrap path');
  }
  let current = root;
  for (const part of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `Kimi group pilot refuses a symlinked OS Home bootstrap path: ${relative(root, current)}`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}

function findProjectRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (pathEntryExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function dirsRootToLeaf(cwd: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('Kimi group pilot could not inspect a local bootstrap path', { cause: err });
  }
}

function displayPath(path: string, cwd: string, kimiHome: string): string {
  if (containsPath(cwd, path)) return `workspace/${relative(cwd, path) || '.'}`;
  if (containsPath(kimiHome, path)) return `kimi-home/${relative(kimiHome, path) || '.'}`;
  const projectRoot = findProjectRoot(cwd);
  if (containsPath(projectRoot, path)) {
    return `workspace/${relative(projectRoot, path) || '.'}`;
  }
  return 'isolated-home extension path';
}

function containsPath(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return (
    fromParent === '' ||
    (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  );
}
