import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProfileCreate } from '../../../src/cli/commands/profile';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { loadRootConfig } from '../../../src/config/profile-store';
import { getSecret } from '../../../src/config/keystore';
import { secretKeyForApp } from '../../../src/config/schema';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const auth = vi.hoisted(() => ({
  validateAppCredentials: vi.fn(async () => ({ ok: true, botName: 'ZCode Regression' })),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile create command', () => {
  it('creates a named profile from existing app credentials in an initialized root', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeProfiles(root, 'zcode-dev', ['zcode-dev']);
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');

    await withRuntimePath(runtime, async () => {
      await runProfileCreate('zcode-regression', {
        rootDir: root,
        agent: 'zcode',
        workspace,
        appId: 'cli_zcode_regression',
        appSecret: 'manual-secret',
        tenant: 'feishu',
      });
    });

    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as RootConfig;
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'zcode-regression' });
    const secret = await getSecret(secretKeyForApp('cli_zcode_regression'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(auth.validateAppCredentials).toHaveBeenCalledWith(
      'cli_zcode_regression',
      'manual-secret',
      'feishu',
    );
    expect(saved.activeProfile).toBe('zcode-dev');
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('zcode-dev\n');
    expect(saved.profiles['zcode-dev']?.agentKind).toBe('zcode');
    expect(saved.profiles['zcode-regression']?.agentKind).toBe('zcode');
    expect(saved.profiles['zcode-regression']?.workspaces.default).toBe(workspaceRealpath);
    expect(savedText).not.toContain('manual-secret');
    expect(secret).toBe('manual-secret');
  });

  it('creates a named ZCode profile that can write inside the default workspace by default', async () => {
    const root = await makeRoot();
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    await writeProfiles(root, 'zcode', ['zcode']);
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');

    await withRuntimePath(runtime, async () => {
      await runProfileCreate('zcode-dev', {
        rootDir: root,
        agent: 'zcode',
        workspace,
        appId: 'cli_zcode_dev',
        appSecret: 'manual-secret',
        tenant: 'feishu',
      });
    });

    const configPath = join(root, 'config.json');
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles['zcode-dev']?.agentKind).toBe('zcode');
    expect(saved.profiles['zcode-dev']).not.toHaveProperty('sandbox');

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles['zcode-dev']?.sandbox).toMatchObject({
      defaultMode: 'danger-full-access',
      maxMode: 'danger-full-access',
    });
  });

  it('refuses to overwrite an existing profile', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode']);
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');

    await withRuntimePath(runtime, async () => {
      await expect(
        runProfileCreate('zcode', {
          rootDir: root,
          agent: 'zcode',
          appId: 'cli_other',
          appSecret: 'manual-secret',
        }),
      ).rejects.toThrow(/profile already exists/);
    });
  });

  it('creates a named profile without requiring a user workspace', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode-dev', ['zcode-dev']);
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');

    await withRuntimePath(runtime, async () => {
      await runProfileCreate('zcode-managed', {
        rootDir: root,
        agent: 'zcode',
        appId: 'cli_zcode_managed',
        appSecret: 'manual-secret',
        tenant: 'feishu',
      });
    });

    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as RootConfig;
    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'zcode-managed' }).defaultWorkspaceDir);
    expect(saved.profiles['zcode-managed']?.workspaces.default).toBe(managed);
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-create-'));
  roots.push(root);
  return root;
}

async function withRuntimePath(runtime: string, fn: () => Promise<void>): Promise<void> {
  const oldRuntime = process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
  process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = runtime;
  try {
    await fn();
  } finally {
    if (oldRuntime === undefined) {
      delete process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
    } else {
      process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = oldRuntime;
    }
  }
}

async function writeProfiles(root: string, activeProfile: string, names: string[]): Promise<void> {
  const profiles: RootConfig['profiles'] = {};
  for (const name of names) {
    profiles[name] = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: {
        app: {
          id: `cli_${name.replace(/[^A-Za-z0-9]/g, '_')}`,
          secret: '${APP_SECRET}',
          tenant: 'feishu',
        },
      },
      zcode: { runtimePath: join(root, 'zcode.cjs') },
    });
    await mkdir(join(root, 'profiles', name), { recursive: true });
  }
  const config: RootConfig = {
    schemaVersion: 2,
    activeProfile,
    preferences: {},
    profiles,
  };
  await writeJson(join(root, 'config.json'), config);
  await writeFile(join(root, 'active-profile'), `${activeProfile}\n`, 'utf8');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
