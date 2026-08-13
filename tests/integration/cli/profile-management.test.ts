import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import {
  runProfileList,
  runProfileLogin,
  runProfileUse,
} from '../../../src/cli/commands/profile';
import type { ProcessEntry } from '../../../src/runtime/registry';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-management-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile management commands', () => {
  it('lists active profile first with running pid and agent identity', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode-dev', ['alpha', 'beta', 'zcode-dev']);
    await writeRegistry(root, [
      processEntry({
        id: 'run1',
        pid: 12345,
        profileName: 'zcode-dev',
        agentKind: 'zcode',
        appId: 'cli_zcode',
      }),
    ]);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });

    await runProfileList({ rootDir: root });

    expect(lines).toEqual([
      'ACTIVE  PROFILE    AGENT  STATUS',
      '*       zcode-dev  zcode  pid=12345 agent=zcode',
      '        alpha      zcode  -',
      '        beta       zcode  -',
    ]);
  });

  it('switches active profile atomically without rewriting running process entries', async () => {
    const root = await makeRoot();
    await writeProfiles(root, 'zcode', ['zcode', 'zcode-dev']);
    const registryFile = resolveAppPaths({ rootDir: root }).userRegistryFile;
    const registry = {
      entries: [
        processEntry({
          id: 'run1',
          pid: 12345,
          profileName: 'zcode',
          agentKind: 'zcode',
          appId: 'cli_zcode',
        }),
      ],
    };
    await writeJson(registryFile, registry);
    const beforeRegistry = await readFile(registryFile, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runProfileUse('zcode-dev', { rootDir: root });

    const rootConfig = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as RootConfig;
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('zcode-dev\n');
    expect(rootConfig.activeProfile).toBe('zcode-dev');
    expect(await readFile(registryFile, 'utf8')).toBe(beforeRegistry);
  });

  it('writes the ZCode API key into the selected profile home on login', async () => {
    const root = await makeRoot();
    const profileDir = join(root, 'profiles', 'zcode');
    await mkdir(profileDir, { recursive: true });
    const config: RootConfig = {
      schemaVersion: 2,
      activeProfile: 'zcode',
      preferences: {},
      profiles: {
        zcode: createDefaultProfileConfig({
          agentKind: 'zcode',
          accounts: {
            app: { id: 'cli_zcode', secret: '${APP_SECRET}', tenant: 'feishu' },
          },
          zcode: { runtimePath: join(root, 'zcode.cjs') },
        }),
      },
    };
    await writeJson(join(root, 'config.json'), config);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousKey = process.env.ZCODE_API_KEY;
    process.env.ZCODE_API_KEY = 'test-zcode-api-key';

    try {
      await runProfileLogin('zcode', { rootDir: root });
    } finally {
      if (previousKey === undefined) {
        delete process.env.ZCODE_API_KEY;
      } else {
        process.env.ZCODE_API_KEY = previousKey;
      }
    }

    const zcodeHome = join(profileDir, 'zcode-home');
    const configFile = join(zcodeHome, '.zcode', 'cli', 'config.json');
    const written = JSON.parse(await readFile(configFile, 'utf8')) as {
      provider: Record<string, { options?: { apiKey?: string } }>;
    };
    expect(written.provider.bigmodel?.options?.apiKey).toBe('test-zcode-api-key');
    // The key file must be private to the profile home owner.
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
  });
});

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
  await writeFile(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'active-profile'), `${activeProfile}\n`, 'utf8');
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
