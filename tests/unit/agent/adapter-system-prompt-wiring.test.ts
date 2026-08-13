import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { prefixBridgeSystemPrompt } from '../../../src/agent/bridge-system-prompt';
import { ZcodeAdapter } from '../../../src/agent/zcode/adapter';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

describe('ZcodeAdapter system prompt wiring', () => {
  let profileStateDir = '';
  let previousApiKey: string | undefined;

  beforeEach(async () => {
    spawnMock.spawnProcess.mockReset();
    profileStateDir = await mkdtemp(join(tmpdir(), 'zcode-wiring-'));
    previousApiKey = process.env.ZCODE_API_KEY;
    process.env.ZCODE_API_KEY = 'test-key';
  });

  afterEach(async () => {
    if (previousApiKey === undefined) {
      delete process.env.ZCODE_API_KEY;
    } else {
      process.env.ZCODE_API_KEY = previousApiKey;
    }
    await rm(profileStateDir, { recursive: true, force: true });
  });

  function zcodeAdapter(): ZcodeAdapter {
    return new ZcodeAdapter({
      runtimePath: '/opt/zcode/zcode.cjs',
      profileStateDir,
    });
  }

  function promptArg(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--prompt');
    expect(flagIndex).toBeGreaterThan(-1);
    return args[flagIndex + 1]!;
  }

  it('passes the identity-aware bridge system prompt with the headless prompt after setBotIdentity', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    const adapter = zcodeAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(promptArg()).toBe(
      prefixBridgeSystemPrompt('hi', { openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', () => {
    spawnMock.spawnProcess.mockReturnValue(fakeChild());
    const adapter = zcodeAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(promptArg()).toBe(prefixBridgeSystemPrompt('hi', undefined));
  });
});
