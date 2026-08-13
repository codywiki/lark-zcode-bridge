import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { clearKeystoreDerivedKeyCache, setSecret } from '../../../src/config/keystore';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { secretKeyForApp } from '../../../src/config/schema';
import {
  runProfileCreate,
  runProfileExport,
  runProfileRemove,
} from '../../../src/cli/commands/profile';
import type { ProcessEntry } from '../../../src/runtime/registry';
import { withProfileAndAppLocks } from '../../../src/runtime/locks';
import { writeVersionExecutable } from '../../helpers/fake-executable';

const auth = vi.hoisted(() => ({
  validateAppCredentials: vi.fn(async () => ({ ok: true, botName: 'Recreated Bot' })),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearKeystoreDerivedKeyCache();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile retention and export', () => {
  it('ignores stale registry entries that are not protected by a runtime lock', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode', 'zcode-dev']);
    await writeRegistry(root, [processEntry({ profileName: 'zcode-dev', agentKind: 'zcode' })]);

    await runProfileRemove('zcode-dev', { rootDir: root });

    await expect(stat(join(root, 'profiles', 'zcode-dev'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to remove a profile while its runtime lock is active', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode', 'zcode-dev']);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'zcode-dev' });

    await withProfileAndAppLocks(appPaths, 'cli_zcode_dev', 'zcode', async () => {
      await expect(runProfileRemove('zcode-dev', { rootDir: root })).rejects.toThrow(/locked|running/i);
    });

    await expect(stat(join(root, 'profiles', 'zcode-dev'))).resolves.toBeDefined();
  });

  it('archives inactive profiles by default and preserves root config on archive failure', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode', 'zcode-dev']);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:34:56.000Z'));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line));

    await runProfileRemove('zcode-dev', { rootDir: root });

    const archived = join(root, '.trash', 'zcode-dev-20260525T123456Z');
    await expect(stat(archived)).resolves.toBeDefined();
    await expect(stat(join(root, 'profiles', 'zcode-dev'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Object.keys(await readRoot(root))).toContain('profiles');
    expect((await readRoot(root)).profiles['zcode-dev']).toBeUndefined();
    expect(logs.join('\n')).toContain('已归档 profile');

    const failRoot = await makeRoot();
    await writeProfiles(failRoot, 'zcode', ['zcode', 'zcode-dev']);
    await writeFile(join(failRoot, '.trash'), 'not a directory');
    await expect(runProfileRemove('zcode-dev', { rootDir: failRoot })).rejects.toThrow();
    expect((await readRoot(failRoot)).profiles['zcode-dev']).toBeDefined();
    await expect(stat(join(failRoot, 'profiles', 'zcode-dev'))).resolves.toBeDefined();
  });

  it('archives the active profile and switches to another configured profile', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode-dev', ['zcode', 'zcode-dev']);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:34:56.000Z'));

    await runProfileRemove('zcode-dev', { rootDir: root });

    const config = await readRoot(root);
    expect(config.activeProfile).toBe('zcode');
    expect(config.profiles['zcode-dev']).toBeUndefined();
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('zcode\n');
    await expect(stat(join(root, '.trash', 'zcode-dev-20260525T123456Z'))).resolves.toBeDefined();
  });

  it('refuses removal when active-profile points at a missing profile', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode', 'zcode-dev']);
    await writeFile(join(root, 'active-profile'), 'missing\n', 'utf8');

    await expect(runProfileRemove('zcode-dev', { rootDir: root })).rejects.toThrow(
      /active profile not found: missing/,
    );
  });

  it('archives the last active profile and clears root config so the name can be recreated', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode']);
    const runtime = await writeVersionExecutable(root, 'zcode.cjs', 'zcode 0.16.3');
    const oldRuntime = process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
    process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = runtime;

    try {
      await runProfileRemove('zcode', { rootDir: root });

      await expect(stat(join(root, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(root, 'active-profile'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(root, 'profiles', 'zcode'))).rejects.toMatchObject({ code: 'ENOENT' });
      await runProfileCreate('zcode', {
        rootDir: root,
        agent: 'zcode',
        appId: 'cli_recreated',
        appSecret: 'manual-secret',
        tenant: 'feishu',
      });
    } finally {
      if (oldRuntime === undefined) {
        delete process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
      } else {
        process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = oldRuntime;
      }
    }
    const config = await readRoot(root);
    expect(config.activeProfile).toBe('zcode');
    expect(config.profiles.zcode?.agentKind).toBe('zcode');
  });

  it('adds a suffix when archive names collide', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode', 'zcode-dev']);
    await mkdir(join(root, '.trash', 'zcode-dev-20260525T123456Z'), { recursive: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T12:34:56.000Z'));

    await runProfileRemove('zcode-dev', { rootDir: root });

    await expect(stat(join(root, '.trash', 'zcode-dev-20260525T123456Z-1'))).resolves.toBeDefined();
  });

  it('purges only with --purge --yes', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode', 'zcode-dev']);

    await expect(runProfileRemove('zcode-dev', { rootDir: root, purge: true })).rejects.toThrow(/--yes/);
    await runProfileRemove('zcode-dev', { rootDir: root, purge: true, yes: true });

    await expect(stat(join(root, 'profiles', 'zcode-dev'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(root, '.trash'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exports profiles without secrets by default and requires --yes for secrets', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode']);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));

    await runProfileExport('zcode', { rootDir: root });
    const exported = JSON.parse(lines.join('\n')) as RootConfig;

    expect(JSON.stringify(exported)).not.toContain('plain-secret');
    expect(exported.profiles.zcode?.accounts.app.secret).toBe('[REDACTED]');
    await expect(
      runProfileExport('zcode', { rootDir: root, includeSecrets: true }),
    ).rejects.toThrow(/--yes/);
  });

  it('materializes keystore app secret only when exporting with secrets', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode']);
    const appId = 'cli_zcode';
    const exportedSecret = 'test-export-secret-from-keystore';
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'zcode' });
    const rootConfig = await readRoot(root);
    rootConfig.secrets = {
      providers: {
        bridge: {
          source: 'exec',
          command: process.execPath,
          args: ['secrets', 'get'],
        },
      },
    };
    rootConfig.profiles.zcode!.accounts.app.secret = {
      source: 'exec',
      provider: 'bridge',
      id: secretKeyForApp(appId),
    };
    await writeJson(join(root, 'config.json'), rootConfig);
    await setSecret(secretKeyForApp(appId), exportedSecret, appPaths);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));

    await runProfileExport('zcode', { rootDir: root });
    const safeExport = JSON.parse(lines.pop() ?? '') as RootConfig;
    await runProfileExport('zcode', { rootDir: root, includeSecrets: true, yes: true });
    const secretExport = JSON.parse(lines.pop() ?? '') as RootConfig;

    expect(JSON.stringify(safeExport)).not.toContain(exportedSecret);
    expect(safeExport.profiles.zcode?.accounts.app.secret).toBe('[REDACTED]');
    expect(secretExport.profiles.zcode?.accounts.app.secret).toBe(exportedSecret);
  });

  it('materializes file app secret only when exporting with secrets', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode']);
    const exportedSecret = 'test-export-secret-from-file';
    const secretFile = join(root, 'app-secret.txt');
    await writeFile(secretFile, `${exportedSecret}\n`, 'utf8');
    const rootConfig = await readRoot(root);
    rootConfig.profiles.zcode!.accounts.app.secret = {
      source: 'file',
      id: secretFile,
    };
    await writeJson(join(root, 'config.json'), rootConfig);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));

    await runProfileExport('zcode', { rootDir: root });
    const safeExport = JSON.parse(lines.pop() ?? '') as RootConfig;
    await runProfileExport('zcode', { rootDir: root, includeSecrets: true, yes: true });
    const secretExport = JSON.parse(lines.pop() ?? '') as RootConfig;

    expect(JSON.stringify(safeExport)).not.toContain(exportedSecret);
    expect(safeExport.profiles.zcode?.accounts.app.secret).toBe('[REDACTED]');
    expect(secretExport.profiles.zcode?.accounts.app.secret).toBe(exportedSecret);
  });

  it('writes exports to a new output file and requires --force when it already exists', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode']);
    const output = join(root, 'profile-export.json');

    await runProfileExport('zcode', { rootDir: root, output });
    await expect(readFile(output, 'utf8')).resolves.toContain('"activeProfile": "zcode"');
    await expect(runProfileExport('zcode', { rootDir: root, output })).rejects.toThrow(/--force/);
    await runProfileExport('zcode', { rootDir: root, output, force: true });
  });

  it('exports profile permissions with migration markers and without runtime-only fields', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode']);
    const rootConfig = await readRoot(root);
    rootConfig.migrations = { permissionDefaultsV1: ['zcode'] };
    const profile = rootConfig.profiles.zcode!;
    profile.permissions = {
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    };
    profile.sandbox = {
      default: 'workspace-write',
      max: 'workspace-write',
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    };
    (profile as typeof profile & { permissionSource?: string }).permissionSource = 'permissions';
    await writeJson(join(root, 'config.json'), rootConfig);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));

    await runProfileExport('zcode', { rootDir: root });

    const exported = JSON.parse(lines.pop() ?? '') as RootConfig & {
      profiles: Record<string, Record<string, unknown>>;
    };
    expect(exported.migrations).toEqual({ permissionDefaultsV1: ['zcode'] });
    expect(exported.profiles.zcode?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(exported.profiles.zcode).not.toHaveProperty('sandbox');
    expect(exported.profiles.zcode).not.toHaveProperty('permissionSource');
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-retention-'));
  roots.push(root);
  return root;
}

async function writeProfiles(root: string, activeProfile: string, names: string[]): Promise<void> {
  const profiles: RootConfig['profiles'] = {};
  for (const name of names) {
    profiles[name] = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: {
        app: {
          id: `cli_${name.replace(/[^A-Za-z0-9]/g, '_')}`,
          secret: 'plain-secret',
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

async function readRoot(root: string): Promise<RootConfig> {
  return JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as RootConfig;
}

function processEntry(overrides: Partial<ProcessEntry>): ProcessEntry {
  return {
    id: 'id',
    pid: process.pid,
    appId: 'cli_test',
    tenant: 'feishu',
    profileName: 'zcode',
    agentKind: 'zcode',
    configPath: '/tmp/config.json',
    startedAt: new Date().toISOString(),
    version: '0.1.32',
    ...overrides,
  };
}

async function writeRegistry(root: string, entries: ProcessEntry[]): Promise<void> {
  await writeJson(resolveAppPaths({ rootDir: root }).userRegistryFile, { entries });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
