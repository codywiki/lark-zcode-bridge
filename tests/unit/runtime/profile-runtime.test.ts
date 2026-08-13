import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  materializeEnvSecretForService,
  resolveProfileRuntime,
} from '../../../src/runtime/profile-runtime';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret } from '../../../src/config/keystore';
import { secretKeyForApp } from '../../../src/config/schema';
import { legacyLarkCliSourceOverlayPaths } from '../../../src/lark-cli/legacy-source-overlay';
import { writeLarkCliSourceProjection } from '../../../src/lark-cli/profile-projection';

const wizard = vi.hoisted(() => ({
  next: {
    accounts: {
      app: {
        id: 'cli_wizard',
        secret: 'wizard-secret',
        tenant: 'feishu' as const,
      },
    },
    preferences: {},
  },
}));

const auth = vi.hoisted(() => {
  type ValidationMockResult = { ok: boolean; botName?: string; reason?: string };
  return {
    validateAppCredentials: vi.fn(
      async (): Promise<ValidationMockResult> => ({ ok: true, botName: 'Bridge Bot' }),
    ),
  };
});

vi.mock('../../../src/bot/wizard', () => ({
  runRegistrationWizard: vi.fn(async () => wizard.next),
}));

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: auth.validateAppCredentials,
}));

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

const ZCODE_RUNTIME_ENV = 'LARK_ZCODE_BRIDGE_RUNTIME_PATH';
const BRIDGE_HOME_ENV = 'LARK_ZCODE_BRIDGE_HOME';
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    delete savedEnv[key];
  }
});

/** Point the bootstrap zcode-runtime probe at a readable fake file. */
async function useFakeZcodeRuntime(root: string): Promise<string> {
  const file = join(root, 'zcode-runtime.cjs');
  await writeFile(file, '// fake zcode runtime for tests\n', { mode: 0o600 });
  setEnv(ZCODE_RUNTIME_ENV, file);
  return file;
}

describe('profile runtime resolver', () => {
  it('recovers a crashed legacy lark-cli source overlay before loading the root config', async () => {
    const root = await tmpRoot();
    const configFile = join(root, 'config.json');
    const { backupFile, markerFile } = legacyLarkCliSourceOverlayPaths(configFile);
    const original = `${JSON.stringify({
      schemaVersion: 2,
      activeProfile: 'zcode',
      profiles: {
        zcode: createDefaultProfileConfig({
          agentKind: 'zcode',
          accounts: { app },
          zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
        }),
      },
    }, null, 2)}\n`;
    const overlay = `${JSON.stringify({ accounts: { app: { id: 'cli_overlay' } } }, null, 2)}\n`;
    await writeFile(backupFile, original, { mode: 0o600 });
    await writeFile(markerFile, `${JSON.stringify({ hadConfig: true, profile: 'zcode' })}\n`, {
      mode: 0o600,
    });
    await writeFile(configFile, overlay, { mode: 0o600 });

    const runtime = await resolveProfileRuntime({
      config: configFile,
      profile: 'zcode',
      allowBootstrap: false,
    });

    expect(runtime.profile).toBe('zcode');
    const recovered = JSON.parse(await readFile(configFile, 'utf8')) as {
      schemaVersion?: number;
      profiles?: Record<string, unknown>;
      accounts?: unknown;
    };
    expect(recovered.schemaVersion).toBe(2);
    expect(recovered.profiles?.zcode).toBeTruthy();
    expect(recovered.accounts).toBeUndefined();
    await expect(readFile(backupFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(markerFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bootstraps first-run profile from existing app credentials without QR registration', async () => {
    const root = await tmpRoot();
    await useFakeZcodeRuntime(root);
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'zcode',
      workspace,
      allowBootstrap: true,
      appId: 'cli_existing',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    });

    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      activeProfile: string;
      profiles: Record<string, { accounts: { app: { id: string; secret: unknown } } }>;
      secrets?: { providers?: Record<string, { command?: string }> };
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'zcode' });
    const secret = await getSecret(secretKeyForApp('cli_existing'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(auth.validateAppCredentials).toHaveBeenCalledWith(
      'cli_existing',
      'manual-secret',
      'feishu',
    );
    expect(runtime.profile).toBe('zcode');
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
    expect(saved.activeProfile).toBe('zcode');
    expect(saved.profiles.zcode?.accounts.app.id).toBe('cli_existing');
    expect(saved.profiles.zcode?.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_existing',
    });
    expect(saved.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(savedText).not.toContain('manual-secret');
    expect(secret).toBe('manual-secret');
  });

  it('bootstraps and persists an explicit zcode profile', async () => {
    const root = await tmpRoot();
    const runtimePath = await useFakeZcodeRuntime(root);

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'zcode-pilot',
      agent: 'zcode',
      allowBootstrap: true,
      appId: 'cli_zcode',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        agentKind?: string;
        zcode?: { runtimePath?: string };
        permissions?: { defaultAccess?: string; maxAccess?: string };
      }>;
    };

    expect(runtime.profile).toBe('zcode-pilot');
    expect(runtime.profileConfig.zcode).toEqual({ runtimePath });
    expect(saved.profiles['zcode-pilot']).toMatchObject({
      agentKind: 'zcode',
      zcode: { runtimePath },
      permissions: { defaultAccess: 'full', maxAccess: 'full' },
    });
  });

  it('rejects existing app bootstrap without writing config when credentials are invalid', async () => {
    const root = await tmpRoot();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    auth.validateAppCredentials.mockResolvedValueOnce({ ok: false, reason: 'code=999' });

    await expect(
      resolveProfileRuntime({
        config: join(root, 'config.json'),
        agent: 'zcode',
        workspace,
        allowBootstrap: true,
        appId: 'cli_bad',
        appSecret: 'bad-secret',
        tenant: 'feishu',
      }),
    ).rejects.toThrow(/code=999/);
    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails clearly instead of opening the QR wizard during non-interactive first run', async () => {
    const root = await tmpRoot();

    await withTty(false, false, async () => {
      await expect(
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          agent: 'zcode',
          allowBootstrap: true,
        }),
      ).rejects.toThrow(/非交互模式无法完成扫码创建应用/);
    });

    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails clearly when non-interactive existing-app bootstrap omits the app secret', async () => {
    const root = await tmpRoot();

    await withTty(false, false, async () => {
      await expect(
        resolveProfileRuntime({
          config: join(root, 'config.json'),
          agent: 'zcode',
          allowBootstrap: true,
          appId: 'cli_missing_secret',
          tenant: 'feishu',
        }),
      ).rejects.toThrow(/非交互模式缺少 App Secret/);
    });

    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('bootstraps a managed default workspace when no workspace is provided', async () => {
    const root = await tmpRoot();
    await useFakeZcodeRuntime(root);

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'zcode',
      allowBootstrap: true,
      appId: 'cli_existing',
      appSecret: 'manual-secret',
      tenant: 'feishu',
    });

    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'zcode' }).defaultWorkspaceDir);
    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      profiles: Record<string, { workspaces?: { default?: string } }>;
    };
    expect(runtime.profileConfig.workspaces.default).toBe(managed);
    expect(saved.profiles.zcode?.workspaces?.default).toBe(managed);
  });

  it('fails first-run bootstrap when no ZCode runtime is installed', async () => {
    const root = await tmpRoot();
    setEnv(ZCODE_RUNTIME_ENV, join(root, 'missing-zcode-runtime.cjs'));

    await expect(
      resolveProfileRuntime({
        config: join(root, 'config.json'),
        allowBootstrap: true,
      }),
    ).rejects.toThrow(/no supported local agent found/i);

    await expect(readFile(join(root, 'config.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('adds a managed default workspace when converting an explicit legacy config', async () => {
    const root = await tmpRoot();
    await useFakeZcodeRuntime(root);
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'zcode',
      allowBootstrap: true,
    });

    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'zcode' }).defaultWorkspaceDir);
    const savedText = await readFile(join(root, 'config.json'), 'utf8');
    const saved = JSON.parse(savedText) as {
      profiles: Record<string, { workspaces?: { default?: string } }>;
    };
    expect(runtime.profileConfig.workspaces.default).toBe(managed);
    expect(saved.profiles.zcode?.workspaces?.default).toBe(managed);
  });

  it('uses a requested workspace when converting an explicit legacy config', async () => {
    const root = await tmpRoot();
    await useFakeZcodeRuntime(root);
    const workspace = join(root, 'requested-workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'zcode',
      workspace,
      allowBootstrap: true,
    });

    const workspaceRealpath = await realpath(workspace);
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
  });

  it('migrates an origin-main v1 config to canonical profile permissions without stored sandbox', async () => {
    const root = await tmpRoot();
    await useFakeZcodeRuntime(root);
    const workspace = join(root, 'requested-workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {
          messageReply: 'card',
          showToolCalls: false,
          maxConcurrentRuns: 3,
          requireMentionInGroup: false,
          access: {
            allowedUsers: ['ou_allowed'],
            allowedChats: ['oc_allowed'],
            admins: ['ou_admin'],
          },
        },
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'zcode',
      workspace,
      allowBootstrap: false,
    });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        access?: unknown;
        preferences?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(runtime.profileConfig.access).toEqual({
      allowedUsers: ['ou_allowed'],
      allowedChats: ['oc_allowed'],
      admins: ['ou_admin'],
      requireMentionInGroup: false,
    });
    expect(runtime.profileConfig.preferences).toMatchObject({
      messageReply: 'card',
      showToolCalls: false,
      maxConcurrentRuns: 3,
    });
    expect(saved.profiles.zcode?.permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(saved.profiles.zcode).not.toHaveProperty('sandbox');
    expect(saved.profiles.zcode?.access).toEqual({
      allowedUsers: ['ou_allowed'],
      allowedChats: ['oc_allowed'],
      admins: ['ou_admin'],
      requireMentionInGroup: false,
    });
    expect(saved.profiles.zcode?.preferences).toMatchObject({
      messageReply: 'card',
      showToolCalls: false,
      maxConcurrentRuns: 3,
    });
  });

  it('uses the requested agent when migrating a legacy config into an explicit profile', async () => {
    const root = await tmpRoot();
    const runtimePath = await useFakeZcodeRuntime(root);
    setEnv(BRIDGE_HOME_ENV, root);
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      profile: 'zcode',
      agent: 'zcode',
      allowBootstrap: true,
    });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, { agentKind: string; zcode?: { runtimePath?: string } }>;
    };

    expect(runtime.profile).toBe('zcode');
    expect(runtime.profileConfig.agentKind).toBe('zcode');
    expect(runtime.profileConfig.zcode?.runtimePath).toBe(runtimePath);
    expect(saved.profiles.zcode?.agentKind).toBe('zcode');
    expect(saved.profiles.zcode?.zcode?.runtimePath).toBe(runtimePath);
  });

  it('runs the same v2 migration for explicit config paths', async () => {
    const root = await tmpRoot();
    const runtimePath = await useFakeZcodeRuntime(root);
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );
    await writeFile(
      join(root, 'sessions.json'),
      `${JSON.stringify({ chat_a: { sessionId: 'sess-1' } }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'zcode',
      agent: 'zcode',
      allowBootstrap: true,
    });

    expect(runtime.profileConfig.agentKind).toBe('zcode');
    expect(runtime.profileConfig.zcode).toMatchObject({
      runtimePath,
    });
    expect(runtime.profileConfig.zcode?.realpath).toBeUndefined();
    expect(runtime.profileConfig.zcode?.version).toBeUndefined();
    await expect(readFile(join(root, 'profiles', 'zcode', 'sessions.json'), 'utf8')).resolves
      .toContain('sess-1');
    await expect(readFile(join(root, 'sessions.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('imports a valid legacy workspace when converting an explicit legacy config', async () => {
    const root = await tmpRoot();
    await useFakeZcodeRuntime(root);
    const workspace = join(root, 'legacy-workspace');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(root, 'config.json'),
      `${JSON.stringify({
        accounts: { app },
        preferences: {},
      }, null, 2)}\n`,
    );
    await writeFile(
      join(root, 'workspaces.json'),
      `${JSON.stringify({
        chats: { chat_a: { cwd: workspace } },
        named: {},
      }, null, 2)}\n`,
    );

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      agent: 'zcode',
      allowBootstrap: true,
    });

    const workspaceRealpath = await realpath(workspace);
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
  });

  it('resolves the active zcode profile from a v2 root config', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'zcode-dev', {
      zcode: createDefaultProfileConfig({
        agentKind: 'zcode',
        accounts: { app },
        zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      }),
      'zcode-dev': createDefaultProfileConfig({
        agentKind: 'zcode',
        accounts: { app: { ...app, id: 'cli_zcode_dev' } },
        zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      }),
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    expect(runtime.profile).toBe('zcode-dev');
    expect(runtime.profileConfig.agentKind).toBe('zcode');
    expect(runtime.appPaths.profileDir).toBe(join(root, 'profiles', 'zcode-dev'));
  });

  it('canonicalizes legacy sandbox-only zcode permissions without widening access', async () => {
    const root = await tmpRoot();
    const legacy = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
    }) as unknown as Record<string, unknown>;
    legacy.sandbox = {
      default: 'workspace-write',
      max: 'workspace-write',
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    };
    delete legacy.permissions;
    delete legacy.permissionSource;
    await writeProfileRoot(root, 'zcode', { zcode: legacy });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        permissionSource?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(runtime.profileConfig.sandbox).toMatchObject({
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    });
    expect(saved.profiles.zcode?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.zcode).not.toHaveProperty('sandbox');
    expect(saved.profiles.zcode).not.toHaveProperty('permissionSource');
    expect(saved.migrations?.permissionDefaultsV1).toContain('zcode');
  });

  it('canonicalizes legacy read-only sandbox without widening permissions', async () => {
    const root = await tmpRoot();
    const legacy = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
    }) as unknown as Record<string, unknown>;
    legacy.sandbox = {
      default: 'read-only',
      max: 'read-only',
      defaultMode: 'read-only',
      maxMode: 'read-only',
    };
    delete legacy.permissions;
    delete legacy.permissionSource;
    await writeProfileRoot(root, 'zcode', { zcode: legacy });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        permissionSource?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(runtime.profileConfig.sandbox).toMatchObject({
      defaultMode: 'read-only',
      maxMode: 'read-only',
    });
    expect(saved.profiles.zcode?.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(saved.profiles.zcode).not.toHaveProperty('sandbox');
    expect(saved.profiles.zcode).not.toHaveProperty('permissionSource');
  });

  it('marks unmarked canonical workspace permissions as migrated without widening', async () => {
    const root = await tmpRoot();
    const zcodeProfile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });
    await writeProfileRoot(root, 'zcode', { zcode: zcodeProfile });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, { permissions?: unknown; sandbox?: unknown }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.zcode?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.zcode).not.toHaveProperty('sandbox');
    expect(saved.migrations?.permissionDefaultsV1).toContain('zcode');
  });

  it('keeps marked canonical workspace permissions for users who lower access after migration', async () => {
    const root = await tmpRoot();
    const zcodeProfile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });
    await writeProfileRoot(root, 'zcode', { zcode: zcodeProfile }, {
      migrations: { permissionDefaultsV1: ['zcode'] },
    });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, { permissions?: unknown; sandbox?: unknown }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.zcode?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.zcode).not.toHaveProperty('sandbox');
    expect(saved.migrations?.permissionDefaultsV1).toContain('zcode');
  });

  it('keeps unmarked canonical workspace override as explicit lower access', async () => {
    const root = await tmpRoot();
    const zcodeProfile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
        claude: {
          permissionMode: 'acceptEdits',
        },
      },
    });
    await writeProfileRoot(root, 'zcode', { zcode: zcodeProfile });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      migrations?: { permissionDefaultsV1?: string[] };
      profiles: Record<string, { permissions?: unknown; sandbox?: unknown }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
      claude: {
        permissionMode: 'acceptEdits',
      },
    });
    expect(saved.profiles.zcode?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
      claude: {
        permissionMode: 'acceptEdits',
      },
    });
    expect(saved.profiles.zcode).not.toHaveProperty('sandbox');
    expect(saved.migrations?.permissionDefaultsV1).toContain('zcode');
  });

  it('keeps legacy mixed lower sandbox permissions when resolving an existing profile', async () => {
    const root = await tmpRoot();
    const legacy = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
    }) as unknown as Record<string, unknown>;
    legacy.sandbox = {
      default: 'read-only',
      max: 'workspace-write',
      defaultMode: 'read-only',
      maxMode: 'workspace-write',
    };
    delete legacy.permissions;
    delete legacy.permissionSource;
    await writeProfileRoot(root, 'zcode', { zcode: legacy });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        permissionSource?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'workspace',
    });
    expect(runtime.profileConfig.sandbox).toMatchObject({
      defaultMode: 'read-only',
      maxMode: 'workspace-write',
    });
    expect(saved.profiles.zcode?.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'workspace',
    });
    expect(saved.profiles.zcode).not.toHaveProperty('sandbox');
    expect(saved.profiles.zcode).not.toHaveProperty('permissionSource');
  });

  it('keeps explicit canonical lower permissions when resolving an existing profile', async () => {
    const root = await tmpRoot();
    const zcodeProfile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      },
    });
    await writeProfileRoot(root, 'zcode', { zcode: zcodeProfile });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, {
        permissions?: unknown;
        sandbox?: unknown;
        permissionSource?: unknown;
      }>;
    };

    expect(runtime.profileConfig.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(runtime.profileConfig.sandbox).toMatchObject({
      defaultMode: 'read-only',
      maxMode: 'read-only',
    });
    expect(saved.profiles.zcode?.permissions).toEqual({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
    });
    expect(saved.profiles.zcode).not.toHaveProperty('sandbox');
    expect(saved.profiles.zcode).not.toHaveProperty('permissionSource');
  });

  it('creates a managed default workspace for profiles without a default', async () => {
    const root = await tmpRoot();
    const profile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
    });
    profile.workspaces = {};
    await writeProfileRoot(root, 'zcode', { zcode: profile });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    const managed = await realpath(resolveAppPaths({ rootDir: root, profile: 'zcode' }).defaultWorkspaceDir);
    expect(runtime.profileConfig.workspaces.default).toBe(managed);
  });

  it('lets an explicit profile override active-profile', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'zcode-dev', {
      zcode: createDefaultProfileConfig({
        agentKind: 'zcode',
        accounts: { app },
        zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      }),
      'zcode-dev': createDefaultProfileConfig({
        agentKind: 'zcode',
        accounts: { app: { ...app, id: 'cli_zcode_dev' } },
        zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      }),
    });

    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'zcode',
    });

    expect(runtime.profile).toBe('zcode');
    expect(runtime.profileConfig.agentKind).toBe('zcode');
  });

  it('fails when active-profile points at a missing profile instead of falling back', async () => {
    const root = await tmpRoot();
    await writeProfileRoot(root, 'missing-profile', {
      zcode: createDefaultProfileConfig({
        agentKind: 'zcode',
        accounts: { app },
        zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      }),
    });

    await expect(
      resolveProfileRuntime({ config: join(root, 'config.json') }),
    ).rejects.toThrow(/profile not found/i);
  });

  it('bootstraps an explicit missing profile into an existing v2 root config', async () => {
    const root = await tmpRoot();
    await useFakeZcodeRuntime(root);
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await writeProfileRoot(root, 'zcode-dev', {
      'zcode-dev': createDefaultProfileConfig({
        agentKind: 'zcode',
        accounts: { app: { ...app, id: 'cli_zcode_dev' } },
        zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      }),
    });
    wizard.next = {
      accounts: {
        app: {
          id: 'cli_zcode_regression',
          secret: 'new-profile-secret',
          tenant: 'feishu',
        },
      },
      preferences: {},
    };

    const runtime = await withTty(true, true, () =>
      resolveProfileRuntime({
        config: join(root, 'config.json'),
        profile: 'zcode-regression',
        agent: 'zcode',
        workspace,
        allowBootstrap: true,
      }),
    );
    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      activeProfile: string;
      profiles: Record<string, { agentKind: string; accounts: { app: { id: string } } }>;
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'zcode-regression' });
    const secret = await getSecret(secretKeyForApp('cli_zcode_regression'), appPaths);
    const workspaceRealpath = await realpath(workspace);

    expect(runtime.profile).toBe('zcode-regression');
    expect(runtime.profileConfig.agentKind).toBe('zcode');
    expect(runtime.profileConfig.workspaces.default).toBe(workspaceRealpath);
    expect(saved.activeProfile).toBe('zcode-dev');
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('zcode-dev\n');
    expect(saved.profiles['zcode-dev']?.agentKind).toBe('zcode');
    expect(saved.profiles['zcode-regression']?.agentKind).toBe('zcode');
    expect(saved.profiles['zcode-regression']?.accounts.app.id).toBe('cli_zcode_regression');
    expect(secret).toBe('new-profile-secret');
  });

  it('normalizes stored v2 profiles before exposing runtime config', async () => {
    const root = await tmpRoot();
    const zcodeProfile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
    }) as unknown as Record<string, unknown>;
    zcodeProfile.zcode = {
      ...(zcodeProfile.zcode as Record<string, unknown>),
      flags: ['--danger-full-access'],
    };
    zcodeProfile.workspaces = {
      default: '/repo/project',
      trustedRoots: ['/repo'],
    };
    await writeProfileRoot(root, 'zcode-dev', { 'zcode-dev': zcodeProfile });

    const runtime = await resolveProfileRuntime({ config: join(root, 'config.json') });

    expect(runtime.profileConfig.workspaces.default).toBe('/repo/project');
    expect(runtime.profileConfig.zcode).not.toHaveProperty('flags');
  });

  it('materializes env-backed secrets into encrypted profile storage for service mode', async () => {
    const root = await tmpRoot();
    process.env.BRIDGE_TEST_APP_SECRET = 'service-mode-secret';
    await writeProfileRoot(root, 'zcode-dev', {
      'zcode-dev': createDefaultProfileConfig({
        agentKind: 'zcode',
        accounts: {
          app: {
            id: 'cli_zcode',
            secret: { source: 'env', id: 'BRIDGE_TEST_APP_SECRET' },
            tenant: 'feishu',
          },
        },
        zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      }),
    });

    const changed = await materializeEnvSecretForService({
      config: join(root, 'config.json'),
      profile: 'zcode-dev',
    });

    const saved = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
      profiles: Record<string, { accounts: { app: { secret: unknown } } }>;
      secrets?: { providers?: Record<string, { command?: string }> };
    };
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'zcode-dev' });
    const secret = await getSecret(secretKeyForApp('cli_zcode'), appPaths);
    const runtime = await resolveProfileRuntime({
      config: join(root, 'config.json'),
      profile: 'zcode-dev',
      allowBootstrap: false,
    });
    const projectionPath = await writeLarkCliSourceProjection(runtime.cfg, appPaths);
    const projectionText = await readFile(projectionPath, 'utf8');
    const projection = JSON.parse(projectionText) as {
      accounts: { app: { secret: unknown } };
      secrets?: { providers?: Record<string, { command?: string; env?: Record<string, string> }> };
    };

    expect(changed).toBe(true);
    expect(saved.profiles['zcode-dev']?.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_zcode',
    });
    expect(saved.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(secret).toBe('service-mode-secret');
    expect(projectionText).not.toContain('${BRIDGE_TEST_APP_SECRET}');
    expect(projection.accounts.app.secret).toEqual({
      source: 'exec',
      provider: 'bridge',
      id: 'app-cli_zcode',
    });
    expect(projection.secrets?.providers?.bridge?.command).toBe(expectedSecretsGetter(root));
    expect(projection.secrets?.providers?.bridge?.env).toMatchObject({
      LARK_CHANNEL_HOME: root,
      LARK_CHANNEL_PROFILE: 'zcode-dev',
    });
  });
});

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bridge-profile-runtime-'));
}

function expectedSecretsGetter(root: string): string {
  const script = join(root, 'secrets-getter');
  return process.platform === 'win32' ? `${script}.cmd` : script;
}

async function writeProfileRoot(
  root: string,
  activeProfile: string,
  profiles: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'config.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      activeProfile,
      preferences: {},
      ...extra,
      profiles,
    }, null, 2)}\n`,
  );
  await writeFile(join(root, 'active-profile'), `${activeProfile}\n`);
}

async function withTty<T>(
  stdinTTY: boolean,
  stdoutTTY: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTTY });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdoutTTY });
  try {
    return await fn();
  } finally {
    restoreDescriptor(process.stdin, 'isTTY', stdinDesc);
    restoreDescriptor(process.stdout, 'isTTY', stdoutDesc);
  }
}

function restoreDescriptor(
  target: NodeJS.ReadStream | NodeJS.WriteStream,
  key: 'isTTY',
  desc: PropertyDescriptor | undefined,
): void {
  if (desc) {
    Object.defineProperty(target, key, desc);
  } else {
    delete (target as unknown as Record<string, unknown>)[key];
  }
}
