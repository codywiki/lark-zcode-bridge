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
  it('keeps Claude as the default runtime agent', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: appAccount(),
      }),
      { profileDir: tmpdir() },
    );

    expect(agent.id).toBe('claude');
    expect(agent.displayName).toBe('Claude Code');
  });

  it('creates CodexAdapter from canonical workspace permissions', () => {
    const profile = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: appAccount(),
      codex: codexConfig(),
      permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    });
    const agent = createRuntimeAgent(profile, {
      profileDir: '/tmp/lark-channel-bridge/profiles/codex-e2e',
    });

    expect(agent.id).toBe('codex');
    expect(agent.displayName).toBe('Codex CLI');
    expect(profile.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(profile.sandbox).toMatchObject({
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    });
  });

  it('creates a Codex runtime agent when an older profile has only a binary path', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: appAccount(),
        codex: { binaryPath: '/usr/local/bin/codex' },
      }),
      { profileDir: '/tmp/lark-channel-bridge/profiles/codex-e2e' },
    );

    expect(agent.id).toBe('codex');
    expect(agent.displayName).toBe('Codex CLI');
  });

  it('seeds a default Codex binary when bootstrapping a new Codex profile', () => {
    const profile = createRuntimeProfileConfig({
      agentKind: 'codex',
      accounts: appAccount(),
    });

    expect(profile.codex?.binaryPath).toBe('codex');
  });

  it('creates KimiAdapter from a Kimi profile', () => {
    const agent = createRuntimeAgent(
      createDefaultProfileConfig({
        agentKind: 'kimi',
        accounts: appAccount(),
        kimi: { binaryPath: '/usr/local/bin/kimi' },
      }),
      { profileDir: '/tmp/lark-channel-bridge/profiles/kimi-pilot' },
    );

    expect(agent.id).toBe('kimi');
    expect(agent.displayName).toBe('Kimi Code CLI');
  });

  it('seeds the configured Kimi command with read-only defaults', () => {
    const previous = process.env.LARK_CHANNEL_KIMI_BIN;
    process.env.LARK_CHANNEL_KIMI_BIN = '/opt/kimi/bin/kimi';
    try {
      const profile = createRuntimeProfileConfig({
        agentKind: 'kimi',
        accounts: appAccount(),
      });

      expect(profile.kimi?.binaryPath).toBe('/opt/kimi/bin/kimi');
      expect(profile.permissions).toEqual({
        defaultAccess: 'read-only',
        maxAccess: 'read-only',
      });
    } finally {
      if (previous === undefined) {
        delete process.env.LARK_CHANNEL_KIMI_BIN;
      } else {
        process.env.LARK_CHANNEL_KIMI_BIN = previous;
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

  it('rejects reconnect when a profile changes agent kind in place', () => {
    expect(() => assertReconnectAgentKindUnchanged('claude', 'codex')).toThrow(/agent kind/i);
    expect(() => assertReconnectAgentKindUnchanged('codex', 'codex')).not.toThrow();
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

function codexConfig() {
  return {
    binaryPath: '/usr/local/bin/codex',
    realpath: '/usr/local/bin/codex',
    version: 'codex 1.2.3',
    sha256: '0'.repeat(64),
    owner: 501,
    mode: 0o755,
  };
}
