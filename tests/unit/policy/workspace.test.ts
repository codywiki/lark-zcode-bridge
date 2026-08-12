import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema';
import {
  allowedWorkspaceRoots,
  isWorkingDirectoryWithinRoot,
  resolveAuthorizedWorkingDirectory,
  resolveWorkingDirectory,
} from '../../../src/policy/workspace';

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('working directory resolver', () => {
  it('accepts an existing non-git directory and returns its realpath', async () => {
    const base = await makeTmp();
    const project = join(base, 'plain-directory');
    await mkdir(project, { recursive: true });

    const result = await resolveWorkingDirectory(project);

    expect(result).toMatchObject({
      ok: true,
      cwdRealpath: await realpath(project),
    });
  });

  it('rejects missing paths and files', async () => {
    const base = await makeTmp();
    const file = join(base, 'file.txt');
    await writeFile(file, 'not a directory', 'utf8');

    await expect(resolveWorkingDirectory(join(base, 'missing'))).resolves.toMatchObject({
      ok: false,
      reason: 'path-inaccessible',
    });
    await expect(resolveWorkingDirectory(file)).resolves.toMatchObject({
      ok: false,
      reason: 'not-directory',
    });
  });

  it('rejects broad or high-risk working directories', async () => {
    await expect(resolveWorkingDirectory('/')).resolves.toMatchObject({
      ok: false,
      reason: 'filesystem-root',
    });
    await expect(resolveWorkingDirectory(homedir())).resolves.toMatchObject({
      ok: false,
      reason: 'home-root',
    });
    await expect(resolveWorkingDirectory(tmpdir())).resolves.toMatchObject({
      ok: false,
      reason: 'temp-root',
    });
    await expect(resolveWorkingDirectory('/etc')).resolves.toMatchObject({
      ok: false,
      reason: 'system-root',
    });
    await expect(resolveWorkingDirectory('/var')).resolves.toMatchObject({
      ok: false,
      reason: 'system-root',
    });
  });

  it('checks allowed-root containment after resolving symlinks', async () => {
    const base = await makeTmp();
    const root = join(base, 'project');
    const child = join(root, 'packages', 'app');
    const sibling = join(base, 'private');
    const similarPrefix = join(base, 'project-private');
    const escape = join(root, 'linked-private');
    await Promise.all([
      mkdir(child, { recursive: true }),
      mkdir(sibling, { recursive: true }),
      mkdir(similarPrefix, { recursive: true }),
    ]);
    await symlink(sibling, escape, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalRoot = await realpath(root);

    await expect(isWorkingDirectoryWithinRoot(root, canonicalRoot)).resolves.toBe(true);
    await expect(isWorkingDirectoryWithinRoot(child, canonicalRoot)).resolves.toBe(true);
    await expect(isWorkingDirectoryWithinRoot(sibling, canonicalRoot)).resolves.toBe(false);
    await expect(isWorkingDirectoryWithinRoot(similarPrefix, canonicalRoot)).resolves.toBe(false);
    await expect(isWorkingDirectoryWithinRoot(escape, canonicalRoot)).resolves.toBe(false);
    await expect(isWorkingDirectoryWithinRoot(join(base, 'missing'), canonicalRoot)).resolves.toBe(
      false,
    );
  });

  it('combines default and allowed roots without changing legacy default-only profiles', () => {
    expect(allowedWorkspaceRoots({ default: '/workspace/default' })).toEqual([
      '/workspace/default',
    ]);
    expect(
      allowedWorkspaceRoots({
        default: ' /workspace/default ',
        allowedRoots: [
          '/workspace/second',
          '/workspace/default',
          ' /workspace/third ',
          '/workspace/second',
        ],
      }),
    ).toEqual(['/workspace/default', '/workspace/second', '/workspace/third']);
  });

  it('authorizes Kimi under either the default or an additional root', async () => {
    const base = await makeTmp();
    const defaultRoot = join(base, 'kimi-default');
    const defaultChild = join(defaultRoot, 'project');
    const additionalRoot = join(base, 'shared-projects');
    const additionalChild = join(additionalRoot, 'nested', 'project');
    await Promise.all([
      mkdir(defaultChild, { recursive: true }),
      mkdir(additionalChild, { recursive: true }),
    ]);
    const profile = kimiProfile({
      default: await realpath(defaultRoot),
      allowedRoots: [await realpath(additionalRoot)],
    });

    await expect(resolveAuthorizedWorkingDirectory(defaultChild, profile)).resolves.toMatchObject({
      ok: true,
      cwdRealpath: await realpath(defaultChild),
    });
    await expect(
      resolveAuthorizedWorkingDirectory(additionalChild, profile),
    ).resolves.toMatchObject({
      ok: true,
      cwdRealpath: await realpath(additionalChild),
    });
  });

  it('rejects Kimi outside every configured root using path-segment containment', async () => {
    const base = await makeTmp();
    const root = join(base, 'project');
    const similarPrefix = join(base, 'project-private');
    const unrelated = join(base, 'unrelated');
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(similarPrefix, { recursive: true }),
      mkdir(unrelated, { recursive: true }),
    ]);
    const profile = kimiProfile({ default: await realpath(root) });

    for (const cwd of [similarPrefix, unrelated]) {
      await expect(resolveAuthorizedWorkingDirectory(cwd, profile)).resolves.toMatchObject({
        ok: false,
        reason: 'outside-profile-root',
      });
    }
  });

  it('rejects a requested cwd symlink that escapes an authorized root', async () => {
    const base = await makeTmp();
    const root = join(base, 'project');
    const outside = join(base, 'private');
    const escape = join(root, 'linked-private');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(outside, { recursive: true })]);
    await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
    const profile = kimiProfile({ default: await realpath(root) });

    await expect(resolveAuthorizedWorkingDirectory(escape, profile)).resolves.toMatchObject({
      ok: false,
      reason: 'outside-profile-root',
    });
  });

  it('fails closed for non-canonical, missing, file, or high-risk authorization roots', async () => {
    const base = await makeTmp();
    const realRoot = join(base, 'real-root');
    const rootLink = join(base, 'root-link');
    const child = join(realRoot, 'child');
    const fileRoot = join(base, 'root.txt');
    await mkdir(child, { recursive: true });
    await symlink(realRoot, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(fileRoot, 'not a directory', 'utf8');

    for (const configuredRoot of [rootLink, join(base, 'missing'), fileRoot, tmpdir()]) {
      const profile = kimiProfile({ default: configuredRoot });
      await expect(resolveAuthorizedWorkingDirectory(child, profile)).resolves.toMatchObject({
        ok: false,
        reason: 'outside-profile-root',
      });
    }
  });

  it('invalidates a canonical root snapshot if that path is later replaced by a symlink', async () => {
    const base = await makeTmp();
    const root = join(base, 'authorized-root');
    const outside = join(base, 'replacement-target');
    await Promise.all([
      mkdir(join(root, 'original-child'), { recursive: true }),
      mkdir(join(outside, 'new-child'), { recursive: true }),
    ]);
    const profile = kimiProfile({ default: await realpath(root) });

    await rm(root, { recursive: true, force: true });
    await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      resolveAuthorizedWorkingDirectory(join(root, 'new-child'), profile),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'outside-profile-root',
    });
  });

  it('skips an invalid root when another canonical root authorizes the cwd', async () => {
    const base = await makeTmp();
    const additionalRoot = join(base, 'additional');
    const child = join(additionalRoot, 'project');
    await mkdir(child, { recursive: true });
    const profile = kimiProfile({
      default: join(base, 'missing'),
      allowedRoots: [await realpath(additionalRoot)],
    });

    await expect(resolveAuthorizedWorkingDirectory(child, profile)).resolves.toMatchObject({
      ok: true,
      cwdRealpath: await realpath(child),
    });
  });

  it('does not apply Kimi root authorization to other agent kinds', async () => {
    const base = await makeTmp();
    const project = join(base, 'claude-project');
    await mkdir(project, { recursive: true });
    const profile = claudeProfile({ default: join(base, 'different-root') });

    await expect(resolveAuthorizedWorkingDirectory(project, profile)).resolves.toMatchObject({
      ok: true,
      cwdRealpath: await realpath(project),
    });
  });
});

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-workdir-'));
  cleanups.push(dir);
  return dir;
}

function kimiProfile(workspaces: ProfileConfig['workspaces']): ProfileConfig {
  const profile = createDefaultProfileConfig({
    agentKind: 'kimi',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
    kimi: { binaryPath: 'kimi' },
  });
  profile.workspaces = workspaces;
  return profile;
}

function claudeProfile(workspaces: ProfileConfig['workspaces']): ProfileConfig {
  const profile = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' } },
  });
  profile.workspaces = workspaces;
  return profile;
}
