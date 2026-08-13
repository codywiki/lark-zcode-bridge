import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeLockConflictError, type RuntimeLockMeta } from '../../../src/runtime/locks';

const mocks = vi.hoisted(() => ({
  resolveProfileRuntime: vi.fn(),
  preFlightChecks: vi.fn(),
  withProfileAndAppLocks: vi.fn(),
}));

vi.mock('../../../src/runtime/profile-runtime', () => ({
  resolveProfileRuntime: mocks.resolveProfileRuntime,
}));

vi.mock('../../../src/cli/preflight', () => ({
  preFlightChecks: mocks.preFlightChecks,
}));

vi.mock('../../../src/runtime/locks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtime/locks')>();
  return {
    ...actual,
    withProfileAndAppLocks: mocks.withProfileAndAppLocks,
  };
});

vi.mock('../../../src/agent/zcode/adapter', () => ({
  ZcodeAdapter: class {
    id = 'zcode';
    displayName = 'ZCode CLI';
    async isAvailable() {
      return true;
    }
    async checkAvailability() {
      return { ok: true };
    }
  },
}));

const { runStart } = await import('../../../src/cli/commands/start');

describe('run runtime lock conflict handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProfileRuntime.mockResolvedValue({
      profile: 'zcode',
      configPath: '/tmp/lark-zcode-home/config.json',
      appPaths: {
        profile: 'zcode',
        rootDir: '/tmp/lark-zcode-home',
        profileDir: '/tmp/lark-zcode-home/profiles/zcode',
        logsDir: '/tmp/lark-zcode-home/profiles/zcode/logs',
        mediaDir: '/tmp/lark-zcode-home/profiles/zcode/media',
        sessionsFile: '/tmp/lark-zcode-home/profiles/zcode/sessions.json',
        workspacesFile: '/tmp/lark-zcode-home/profiles/zcode/workspaces.json',
        userRegistryFile: '/tmp/lark-zcode-home/registry/processes.json',
        larkCliConfigDir: '/tmp/lark-zcode-home/profiles/zcode/lark-cli',
        larkCliSourceConfigFile: '/tmp/lark-zcode-home/profiles/zcode/lark-cli-source/config.json',
        profileLockFile: '/tmp/lark-zcode-home/registry/locks/profile/zcode.lock',
        appLockFile: (appId: string) => `/tmp/lark-zcode-home/registry/locks/app/${appId}.lock`,
      },
      cfg: {
        accounts: {
          app: {
            id: 'cli_zcode',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        agentKind: 'zcode',
      },
      profileConfig: {
        agentKind: 'zcode',
        accounts: {
          app: {
            id: 'cli_zcode',
            secret: '${APP_SECRET}',
            tenant: 'feishu',
          },
        },
        zcode: {
          runtimePath: '/opt/zcode/zcode.cjs',
          realpath: '/opt/zcode/zcode.cjs',
          version: '0.16.3',
        },
        sandbox: { defaultMode: 'danger-full-access', maxMode: 'danger-full-access' },
        workspaces: {},
      },
    });
  });

  it('stops the current profile lock holder and retries foreground run after confirmation', async () => {
    const holder: RuntimeLockMeta = {
      kind: 'profile',
      target: '/tmp/lark-zcode-home/registry/locks/profile/zcode.lock',
      profile: 'zcode',
      agentKind: 'zcode',
      pid: 83130,
      startedAt: '2026-05-28T12:50:39.072Z',
    };
    mocks.withProfileAndAppLocks
      .mockRejectedValueOnce(new RuntimeLockConflictError('profile', holder.target, holder, new Error('locked')))
      .mockResolvedValueOnce(undefined);
    const stopped: RuntimeLockMeta[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    });

    await expect(
      runStart({
        profile: 'zcode',
        skipCheckLarkCli: true,
        confirmStopRuntimeLockProcess: async () => true,
        stopRuntimeLockProcess: async (meta) => {
          stopped.push(meta);
          return 'terminated' as const;
        },
      }),
    ).resolves.toBeUndefined();

    expect(mocks.withProfileAndAppLocks).toHaveBeenCalledTimes(2);
    expect(stopped).toEqual([holder]);
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
