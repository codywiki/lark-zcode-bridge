import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertReconnectAgentKindUnchanged,
  createRuntimeAgent,
} from '../../../src/cli/commands/start.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { createRuntimeProfileConfig } from '../../../src/runtime/profile-runtime.js';

describe('start runtime agent factory', () => {
  it('keeps ZCode as the default runtime agent', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'zcode',
        accounts: appAccount(),
        zcode: zcodeConfig(),
      }),
      { profileDir: tmpdir() },
    );

    expect(agent.id).toBe('zcode');
    expect(agent.displayName).toBe('ZCode CLI');
  });

  it('creates ZcodeAdapter from canonical workspace permissions', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'zcode',
      accounts: appAccount(),
      zcode: zcodeConfig(),
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    });
    const agent = createRuntimeAgent(profile, {
      profileDir: '/tmp/lark-zcode-bridge/profiles/zcode-e2e',
    });

    expect(agent.id).toBe('zcode');
    expect(agent.displayName).toBe('ZCode CLI');
    expect(profile.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(profile.sandbox).toMatchObject({
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    });
  });

  it('creates a ZCode runtime agent when a profile has only a runtime path', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'zcode',
        accounts: appAccount(),
        zcode: { runtimePath: '/opt/zcode/zcode.cjs' },
      }),
      { profileDir: '/tmp/lark-zcode-bridge/profiles/zcode-e2e' },
    );

    expect(agent.id).toBe('zcode');
    expect(agent.displayName).toBe('ZCode CLI');
  });

  it('seeds a default ZCode runtime path when bootstrapping a new ZCode profile', () => {
    const profile = createRuntimeProfileConfig({
      agentKind: 'zcode',
      accounts: appAccount(),
    });

    expect(profile.zcode?.runtimePath).toBeTruthy();
  });

  it('seeds the configured ZCode runtime path with full-access defaults', () => {
    const previous = process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH;
    process.env.LARK_ZCODE_BRIDGE_RUNTIME_PATH = '/opt/zcode/bin/zcode.cjs';
    try {
      const profile = createRuntimeProfileConfig({
        agentKind: 'zcode',
        accounts: appAccount(),
      });

      expect(profile.zcode?.runtimePath).toBe('/opt/zcode/bin/zcode.cjs');
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

  it('updates the process registry before releasing the old app lock during reconnect', async () => {
    const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const restartStart = source.indexOf('async restart()');
    const updateIndex = source.indexOf('await updateEntry(entry.id', restartStart);
    const releaseIndex = source.indexOf('await oldAppLock?.release()', restartStart);

    expect(restartStart).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeLessThan(releaseIndex);
  });

  it('releases the current runtime locks during graceful shutdown', async () => {
    const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
    const stopStart = source.indexOf('const stop = async');
    const releaseIndex = source.indexOf('await releaseRuntimeLocks(runtimeLocks)', stopStart);
    const exitIndex = source.indexOf('process.exit(0)', stopStart);

    expect(stopStart).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeLessThan(exitIndex);
  });

  it('accepts reconnect when the profile keeps the same agent kind', () => {
    expect(() => assertReconnectAgentKindUnchanged('zcode', 'zcode')).not.toThrow();
    expect(() => assertReconnectAgentKindUnchanged(undefined, undefined)).not.toThrow();
  });
});

function appAccount() {
  return {
    app: {
      id: 'cli_xxx',
      secret: '${APP_SECRET}',
      tenant: 'feishu' as const,
    },
  };
}

function zcodeConfig() {
  return {
    runtimePath: '/opt/zcode/zcode.cjs',
    realpath: '/opt/zcode/zcode.cjs',
    version: '0.16.3',
  };
}
