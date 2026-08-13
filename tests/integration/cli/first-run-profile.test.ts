import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectInstalledAgents, resolveExecutablePath } from '../../../src/cli/agent-detection';
import { createBootstrapProfileConfig } from '../../../src/cli/profile-bootstrap';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-first-run-profile-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('first-run profile bootstrap', () => {
  it('creates a ZCode profile with a default workspace', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');

    const profile = await createBootstrapProfileConfig({
      agentKind: 'zcode',
      accounts: { app: { id: 'cli_zcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
      workspace,
      zcodeRuntimePath: runtime,
    });

    const workspaceRealpath = await realpath(workspace);
    expect(profile.agentKind).toBe('zcode');
    expect(profile.workspaces).toEqual({ default: workspaceRealpath });
    expect(profile.zcode).toEqual({ runtimePath: runtime });
    expect(profile.sandbox).toMatchObject({
      defaultMode: 'danger-full-access',
      maxMode: 'danger-full-access',
    });
    // Bootstrap only records the runtime path; the isolated profile home is
    // created lazily on first run, not at profile creation time.
    await expect(stat(join(root, 'profiles', 'zcode-home'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('falls back to LARK_ZCODE_BRIDGE_RUNTIME_PATH when no runtime path is given', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');
    const previous = process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
    process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = runtime;

    try {
      const profile = await createBootstrapProfileConfig({
        agentKind: 'zcode',
        accounts: { app: { id: 'cli_zcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
        workspace,
      });

      expect(profile.agentKind).toBe('zcode');
      expect(profile.zcode).toEqual({ runtimePath: runtime });
      expect(profile.permissions).toEqual({
        defaultAccess: 'full',
        maxAccess: 'full',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
      } else {
        process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = previous;
      }
    }
  });

  it('creates a profile without requiring a user workspace', async () => {
    const root = await makeRoot();
    const defaultWorkspace = join(root, 'managed-workspaces', 'zcode-dev', 'default');
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');

    const profile = await createBootstrapProfileConfig({
      agentKind: 'zcode',
      accounts: { app: { id: 'cli_zcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
      zcodeRuntimePath: runtime,
      defaultWorkspace,
    });

    const defaultWorkspaceRealpath = await realpath(defaultWorkspace);
    expect(profile.workspaces.default).toBe(defaultWorkspaceRealpath);
  });

  it('reports a missing ZCode bootstrap runtime as an agent preflight diagnostic', async () => {
    const root = await makeRoot();
    const missing = join(root, 'missing-zcode.cjs');

    await expect(
      createBootstrapProfileConfig({
        agentKind: 'zcode',
        accounts: { app: { id: 'cli_zcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
        zcodeRuntimePath: missing,
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-binary-not-found',
        agentId: 'zcode',
        agentName: 'ZCode CLI',
        command: 'zcode',
        binaryPath: missing,
      },
    });
  });

  it('fails closed when a requested bootstrap workspace is not a directory', async () => {
    const root = await makeRoot();
    const file = join(root, 'not-a-dir');
    await writeFile(file, 'x', 'utf8');
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');

    await expect(
      createBootstrapProfileConfig({
        agentKind: 'zcode',
        accounts: { app: { id: 'cli_zcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
        workspace: file,
        zcodeRuntimePath: runtime,
      }),
    ).rejects.toThrow(/路径不是目录/);
  });

  it('accepts a requested bootstrap workspace without requiring git', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');

    const profile = await createBootstrapProfileConfig({
      agentKind: 'zcode',
      accounts: { app: { id: 'cli_zcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
      workspace,
      zcodeRuntimePath: runtime,
    });

    await expect(realpath(workspace)).resolves.toBe(profile.workspaces.default);
  });

  it('leaves workspaces empty when neither explicit nor managed workspace is provided', async () => {
    const root = await makeRoot();
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');

    await expect(
      createBootstrapProfileConfig({
        agentKind: 'zcode',
        accounts: { app: { id: 'cli_zcode', secret: '${APP_SECRET}', tenant: 'feishu' } },
        zcodeRuntimePath: runtime,
      }),
    ).resolves.toMatchObject({
      workspaces: {},
    });
  });

  it('detects the ZCode runtime from LARK_ZCODE_BRIDGE_RUNTIME_PATH', async () => {
    const root = await makeRoot();
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');
    const oldRuntime = process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
    process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = runtime;
    try {
      await expect(detectInstalledAgents()).resolves.toEqual([
        { kind: 'zcode', binaryPath: runtime },
      ]);
    } finally {
      if (oldRuntime === undefined) {
        delete process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
      } else {
        process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = oldRuntime;
      }
    }
  });

  it('detects no agents when the ZCode runtime is missing', async () => {
    const root = await makeRoot();
    const oldRuntime = process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
    process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = join(root, 'missing-zcode.cjs');
    try {
      await expect(detectInstalledAgents()).resolves.toEqual([]);
    } finally {
      if (oldRuntime === undefined) {
        delete process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
      } else {
        process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = oldRuntime;
      }
    }
  });

  it('resolves Windows-style PATHEXT command shims from PATH', async () => {
    const root = await makeRoot();
    await writeExecutable(root, 'zcode.cmd', '@echo off\r\necho zcode 0.16.3\r\n');
    const oldPath = process.env.PATH;
    const oldPathExt = process.env.PATHEXT;
    process.env.PATH = root;
    process.env.PATHEXT = '.cmd;.exe';
    try {
      await expect(resolveExecutablePath('zcode')).resolves.toBe(join(root, 'zcode.cmd'));
    } finally {
      process.env.PATH = oldPath;
      if (oldPathExt === undefined) {
        delete process.env.PATHEXT;
      } else {
        process.env.PATHEXT = oldPathExt;
      }
    }
  });
});

async function writeExecutable(root: string, name: string, content: string): Promise<string> {
  const file = join(root, name);
  await writeFile(file, content, { mode: 0o755 });
  return file;
}
