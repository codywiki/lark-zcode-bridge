import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZcodeAdapter } from '../../src/agent/zcode/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

/**
 * Process-level contract for the ZCode adapter: real child processes are
 * spawned and killed here (no mocks), covering the isolation and teardown
 * behavior the bridge relies on.
 */
describe('zcode adapter process behavior', { timeout: 30_000 }, () => {
  let stateDir: string;
  let runtimePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'zcode-process-test-'));
    process.env.ZCODE_API_KEY = 'test-key';
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ZCODE_API_KEY;
  });

  function writeRuntime(body: string): void {
    runtimePath = join(stateDir, 'fake-zcode.cjs');
    writeFileSync(runtimePath, body, 'utf8');
  }

  async function collect(run: ReturnType<ZcodeAdapter['run']>): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    return events;
  }

  it('stop() terminates a hung runtime and ends the event stream as interrupted', async () => {
    writeRuntime(`setInterval(() => {}, 1000);`);
    const adapter = new ZcodeAdapter({ runtimePath, profileStateDir: stateDir, stopGraceMs: 300 });
    const run = adapter.run({ runId: 'p1', prompt: 'hi', cwd: stateDir });
    expect(run.pid).toBeGreaterThan(0);
    await run.stop();
    const events = await collect(run);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    // SIGKILL fallback path exercised: the fake runtime ignores nothing, so
    // SIGTERM alone ends it; either way the child must be gone.
    await expect(run.waitForExit(1000)).resolves.toBe(true);
  });

  it('a crashing runtime yields a sanitized error event, not a rejection', async () => {
    writeRuntime(`console.error('boom at /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs:1'); process.exit(2);`);
    const adapter = new ZcodeAdapter({ runtimePath, profileStateDir: stateDir });
    const events = await collect(adapter.run({ runId: 'p2', prompt: 'hi', cwd: stateDir }));
    expect(events).toHaveLength(1);
    const error = events[0];
    expect(error).toMatchObject({ type: 'error', terminationReason: 'failed' });
    if (error?.type === 'error') {
      expect(error.message).toContain('code 2');
      expect(error.message).toContain('boom');
      // App-bundle path noise is stripped from user-visible errors.
      expect(error.message).not.toContain('/Applications/ZCode.app');
    }
  });

  it('runtime exiting 0 without a JSON payload is a clean failure', async () => {
    writeRuntime(`console.log('no json here');`);
    const adapter = new ZcodeAdapter({ runtimePath, profileStateDir: stateDir });
    const events = await collect(adapter.run({ runId: 'p3', prompt: 'hi', cwd: stateDir }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });

  it('the child runs with the isolated HOME and never the real one', async () => {
    writeRuntime(`console.log(JSON.stringify({ sessionId: 's', response: process.env.HOME }));`);
    const adapter = new ZcodeAdapter({ runtimePath, profileStateDir: stateDir });
    const events = await collect(adapter.run({ runId: 'p4', prompt: 'hi', cwd: stateDir }));
    const finalText = events.find((e) => e.type === 'final_text');
    expect(finalText).toMatchObject({ content: join(stateDir, 'zcode-home') });
  });
});
