import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseZcodeHeadlessResult,
  ZcodeAdapter,
  zcodePermissionMode,
} from '../../../src/agent/zcode/adapter.js';
import type { AgentEvent } from '../../../src/agent/types.js';

describe('zcodePermissionMode', () => {
  it('maps bridge sandbox modes to zcode headless modes', () => {
    expect(zcodePermissionMode('read-only')).toBe('plan');
    expect(zcodePermissionMode('workspace-write')).toBe('build');
    expect(zcodePermissionMode('danger-full-access')).toBe('yolo');
  });

  it('defaults to full access (yolo) when no sandbox is set', () => {
    expect(zcodePermissionMode(undefined)).toBe('yolo');
  });
});

describe('parseZcodeHeadlessResult', () => {
  it('parses a whole-stdout JSON payload', () => {
    const parsed = parseZcodeHeadlessResult(
      JSON.stringify({
        sessionId: 'sess_1',
        response: 'done',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
      }),
    );
    expect(parsed).toEqual({
      sessionId: 'sess_1',
      response: 'done',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
    });
  });

  it('scans from the end when runtime warnings precede the payload', () => {
    const stdout = [
      'Warning: something noisy',
      '{"sessionId":"sess_2","response":"ok"}',
      '',
    ].join('\n');
    expect(parseZcodeHeadlessResult(stdout)).toEqual({
      sessionId: 'sess_2',
      response: 'ok',
    });
  });

  it('returns undefined for non-JSON output', () => {
    expect(parseZcodeHeadlessResult('plain text\nmore text')).toBeUndefined();
    expect(parseZcodeHeadlessResult('')).toBeUndefined();
  });

  it('returns undefined when neither sessionId nor response is present', () => {
    expect(parseZcodeHeadlessResult('{"usage":{"inputTokens":1}}')).toBeUndefined();
    expect(parseZcodeHeadlessResult('{"sessionId":""}')).toBeUndefined();
  });

  it('keeps only numeric usage fields', () => {
    const parsed = parseZcodeHeadlessResult(
      '{"sessionId":"s","usage":{"inputTokens":"x","outputTokens":7}}',
    );
    expect(parsed?.usage).toEqual({ outputTokens: 7 });
  });
});

describe('ZcodeAdapter.run', () => {
  let stateDir: string;
  let runtimePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'zcode-adapter-test-'));
    // A fake runtime: prints the payload the real zcode.cjs prints, and
    // records argv + HOME so tests can assert the adapter's spawn contract.
    runtimePath = join(stateDir, 'fake-zcode.cjs');
    writeFileSync(
      runtimePath,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify({ args, home: process.env.HOME }));
const resume = args.includes('--resume') ? 'sess_resumed' : 'sess_fresh';
console.log(JSON.stringify({
  sessionId: resume,
  response: 'fake answer',
  usage: { inputTokens: 1, outputTokens: 2 },
}));
`,
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ARGV_CAPTURE;
    delete process.env.ZCODE_API_KEY;
  });

  function makeAdapter(): ZcodeAdapter {
    return new ZcodeAdapter({ runtimePath, profileStateDir: stateDir });
  }

  async function collect(run: ReturnType<ZcodeAdapter['run']>): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of run.events) events.push(event);
    return events;
  }

  it('emits system/final_text/usage/done from the JSON payload', async () => {
    process.env.ARGV_CAPTURE = join(stateDir, 'argv.json');
    process.env.ZCODE_API_KEY = 'test-key';
    const adapter = makeAdapter();
    const events = await collect(
      adapter.run({ runId: 'r1', prompt: 'hello', cwd: stateDir }),
    );
    const types = events.map((e) => e.type);
    expect(types).toEqual(['system', 'final_text', 'usage', 'done']);
    expect(events[0]).toMatchObject({ sessionId: 'sess_fresh' });
    expect(events[1]).toMatchObject({ content: 'fake answer' });
    expect(events[3]).toMatchObject({ terminationReason: 'normal', sessionId: 'sess_fresh' });
  });

  it('spawns with --json --mode yolo --cwd and redirects HOME to the isolated profile home', async () => {
    process.env.ARGV_CAPTURE = join(stateDir, 'argv.json');
    process.env.ZCODE_API_KEY = 'test-key';
    const adapter = makeAdapter();
    await collect(adapter.run({ runId: 'r2', prompt: 'hi', cwd: stateDir }));
    const captured = JSON.parse(readFileSync(process.env.ARGV_CAPTURE, 'utf8')) as {
      args: string[];
      home: string;
    };
    expect(captured.args).toContain('--json');
    expect(captured.args).toContain('--mode');
    expect(captured.args[captured.args.indexOf('--mode') + 1]).toBe('yolo');
    expect(captured.args[captured.args.indexOf('--cwd') + 1]).toBe(stateDir);
    expect(captured.home).toBe(join(stateDir, 'zcode-home'));
    expect(captured.home).not.toBe(process.env.HOME);
  });

  it('passes --resume and --attach, and maps read-only to plan mode', async () => {
    process.env.ARGV_CAPTURE = join(stateDir, 'argv.json');
    process.env.ZCODE_API_KEY = 'test-key';
    const adapter = makeAdapter();
    await collect(
      adapter.run({
        runId: 'r3',
        prompt: 'hi',
        cwd: stateDir,
        sessionId: 'sess_prev',
        images: ['/tmp/a.png'],
        sandbox: 'read-only',
      }),
    );
    const captured = JSON.parse(readFileSync(process.env.ARGV_CAPTURE, 'utf8')) as {
      args: string[];
    };
    expect(captured.args[captured.args.indexOf('--resume') + 1]).toBe('sess_prev');
    expect(captured.args[captured.args.indexOf('--attach') + 1]).toBe('/tmp/a.png');
    expect(captured.args[captured.args.indexOf('--mode') + 1]).toBe('plan');
  });

  it('emits a clean failure when the model config has no API key', async () => {
    // No ZCODE_API_KEY: prepareZcodeProfileHome writes a config with an empty
    // key, and run() must fail fast instead of spawning the runtime.
    const adapter = makeAdapter();
    const events = await collect(
      adapter.run({ runId: 'r4', prompt: 'hi', cwd: stateDir }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
  });
});
