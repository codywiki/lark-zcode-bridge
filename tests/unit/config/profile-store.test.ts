import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import {
  agentKindFromString,
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';

const roots: string[] = [];

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-profile-store-'));
  roots.push(root);
  return root;
}

describe('profile store canonical serialization', () => {
  it('accepts zcode as an agent kind and rejects removed upstream kinds', () => {
    expect(agentKindFromString('zcode')).toBe('zcode');
    expect(agentKindFromString(undefined)).toBeUndefined();
    expect(() => agentKindFromString('claude')).toThrow(/unsupported agent/i);
    expect(() => agentKindFromString('kimi')).toThrow(/unsupported agent/i);
  });

  it('saves stored root and profile config without unknown root fields or runtime-only profile fields', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const rootSecrets = {
      providers: {
        rootEnv: {
          source: 'env' as const,
          allowlist: ['APP_SECRET'],
        },
      },
      defaults: { env: 'rootEnv' },
    };
    const profile = {
      ...createDefaultProfileConfig({
        agentKind: 'zcode',
        accounts: { app },
        secrets: { defaults: { env: 'profileEnv' } },
        preferences: {
          messageReply: 'markdown',
          showToolCalls: false,
        },
        access: {
          allowedUsers: ['ou_user'],
          allowedChats: ['oc_chat'],
          admins: ['ou_admin'],
          requireMentionInGroup: false,
        },
        zcode: {
          runtimePath: '/opt/zcode/zcode.cjs',
          realpath: '/opt/zcode/zcode.cjs',
          version: '0.16.3',
        },
        permissions: {
          defaultAccess: 'workspace',
          maxAccess: 'full',
        },
      }),
      workspaces: { default: '/repo' },
      attachments: {
        maxCount: 2,
        maxBytes: 1024,
        maxFileBytes: 512,
        imageMaxBytes: 256,
        cacheTtlMs: 60_000,
        cacheMaxBytes: 2048,
      },
      comments: {},
      larkCli: {
        identityPreset: 'user-default' as const,
        localUserImport: {
          status: 'imported' as const,
          attemptedAt: '2026-06-04T01:02:03.000Z',
          importedAt: '2026-06-04T01:03:03.000Z',
          reason: 'same-app-local-user',
        },
      },
      runtimeOnlyFutureField: true,
    };

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'zcode',
      preferences: { messageReply: 'text' },
      secrets: rootSecrets,
      migrations: {
        permissionDefaultsV1: [
          'zcode',
          'zcode',
          '  dev  ',
          'dev',
          'dev ',
          '',
          42 as unknown as string,
        ],
      },
      profiles: { zcode: profile },
      extra: true,
    } as unknown as RootConfig & { extra?: true; preferences: any }, configPath);

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.schemaVersion).toBe(2);
    expect(saved.activeProfile).toBe('zcode');
    expect(saved.secrets).toEqual(rootSecrets);
    expect(saved.preferences).toEqual({});
    expect(saved.migrations).toEqual({ permissionDefaultsV1: ['dev', 'zcode'] });
    expect(saved).not.toHaveProperty('extra');

    const savedProfile = saved.profiles.zcode;
    expect(savedProfile.accounts).toEqual(profile.accounts);
    expect(savedProfile.secrets).toEqual(profile.secrets);
    expect(savedProfile.preferences).toEqual(profile.preferences);
    expect(savedProfile.access).toEqual(profile.access);
    expect(savedProfile.workspaces).toEqual(profile.workspaces);
    expect(savedProfile.zcode).toEqual(profile.zcode);
    expect(savedProfile.attachments).toEqual(profile.attachments);
    expect(savedProfile.comments).toEqual(profile.comments);
    expect(savedProfile.larkCli).toEqual(profile.larkCli);
    expect(savedProfile.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'full',
    });
    expect(savedProfile).not.toHaveProperty('runtimeOnlyFutureField');
    expect(savedProfile).not.toHaveProperty('permissionSource');
    expect(savedProfile).not.toHaveProperty('sandbox');
  });

  it('loads canonical-only saved config and re-derives runtime sandbox', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
    });

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'zcode',
      preferences: {},
      profiles: { zcode: profile },
    }, configPath);

    const loaded = await loadRootConfig(configPath);
    expect(loaded?.profiles.zcode?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(loaded?.profiles.zcode?.sandbox).toMatchObject({
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    });
  });

  it('round-trips ZCode runtime configuration', async () => {
    const root = await tmpRoot();
    const configPath = join(root, 'config.json');
    const profile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs', defaultModel: 'bigmodel/glm-5.2' },
    });
    profile.workspaces = {
      default: '/repo/zcode',
    };

    await saveRootConfig({
      schemaVersion: 2,
      activeProfile: 'zcode',
      preferences: {},
      profiles: { zcode: profile },
    }, configPath);

    const stored = JSON.parse(await readFile(configPath, 'utf8')) as {
      profiles: Record<string, { zcode?: { runtimePath?: string; defaultModel?: string } }>;
    };
    const loaded = await loadRootConfig(configPath);
    expect(stored.profiles.zcode?.zcode).toEqual({
      runtimePath: '/opt/zcode/zcode.cjs',
      defaultModel: 'bigmodel/glm-5.2',
    });
    expect(loaded?.profiles.zcode?.zcode).toEqual({
      runtimePath: '/opt/zcode/zcode.cjs',
      defaultModel: 'bigmodel/glm-5.2',
    });
    expect(loaded?.profiles.zcode?.workspaces).toEqual({
      default: '/repo/zcode',
    });
  });

  it('marks newly created roots as already evaluated for permission default migration', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: { app },
      zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
    });

    const root = createRootConfig('zcode', profile);

    expect(root.migrations?.permissionDefaultsV1).toEqual(['zcode']);
  });
});
