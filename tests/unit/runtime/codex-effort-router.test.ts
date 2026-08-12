import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../../src/platform/spawn.js', () => ({
  spawnProcess: vi.fn(),
}));

import { spawnProcess } from '../../../src/platform/spawn.js';
import {
  classifyCodexEffort,
  isCodexModelRouterEnabled,
  resolveCodexRunPolicy,
  subAgentOverrideArgs,
  subAgentPlanForEffort,
} from '../../../src/runtime/codex-effort-router.js';

const mockSpawn = vi.mocked(spawnProcess);

function jsonl(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/** Build a fake child process that emits a scripted close. */
function fakeChild(script: {
  stdout?: string;
  stderr?: string;
  code?: number;
  spawnError?: Error;
  closeDelayMs?: number;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { on: (ev: string, fn: () => void) => void; end: (d: string, enc: string) => void };
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on: () => undefined, end: () => undefined };
  child.kill = () => undefined;
  process.nextTick(() => {
    if (script.spawnError) {
      child.emit('error', script.spawnError);
      return;
    }
    if (script.stdout) child.stdout.emit('data', Buffer.from(script.stdout));
    if (script.stderr) child.stderr.emit('data', Buffer.from(script.stderr));
    setTimeout(() => child.emit('close', script.code ?? 0), script.closeDelayMs ?? 0);
  });
  return child;
}

describe('codex effort router', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('is disabled unless explicitly enabled', () => {
    expect(isCodexModelRouterEnabled(undefined)).toBe(false);
    expect(isCodexModelRouterEnabled({})).toBe(false);
    expect(isCodexModelRouterEnabled({ enabled: false })).toBe(false);
    expect(isCodexModelRouterEnabled({ enabled: true })).toBe(true);
  });

  it('returns undefined when disabled, without spawning', async () => {
    const effort = await classifyCodexEffort('hello', { binary: '/bin/codex' });
    expect(effort).toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('parses the agent_message text from a JSONL stream', async () => {
    mockSpawn.mockReturnValue(fakeChild({
      stdout: jsonl([
        { type: 'thread.started', thread_id: 't1' },
        { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'high' } },
        { type: 'turn.completed', usage: {} },
      ]),
    }) as never);
    const effort = await classifyCodexEffort('重构整个鉴权模块', {
      binary: '/bin/codex',
      model: 'gpt-5.6-sol',
      router: { enabled: true },
    });
    expect(effort).toBe('high');
  });

  it('uses the last agent_message when there are several', async () => {
    mockSpawn.mockReturnValue(fakeChild({
      stdout: jsonl([
        { type: 'item.completed', item: { type: 'agent_message', text: 'low' } },
        { type: 'item.completed', item: { type: 'agent_message', text: 'xhigh' } },
      ]),
    }) as never);
    expect(
      await classifyCodexEffort('m', { binary: '/bin/codex', router: { enabled: true } }),
    ).toBe('xhigh');
  });

  it('strips punctuation and case from the classified token', async () => {
    mockSpawn.mockReturnValue(fakeChild({
      stdout: jsonl([{ type: 'item.completed', item: { type: 'agent_message', text: 'Medium.' } }]),
    }) as never);
    expect(
      await classifyCodexEffort('m', { binary: '/bin/codex', router: { enabled: true } }),
    ).toBe('medium');
  });

  it('fails closed at ultra on non-zero classifier exit', async () => {
    mockSpawn.mockReturnValue(fakeChild({ code: 1, stderr: 'boom' }) as never);
    const effort = await classifyCodexEffort('m', {
      binary: '/bin/codex',
      router: { enabled: true },
    });
    expect(effort).toBe('ultra');
    expect(subAgentPlanForEffort(effort!)).toEqual({
      maxConcurrentThreads: 3,
      effort: 'ultra',
      model: 'gpt-5.6-sol',
    });
  });

  it('does not let a configured fallback weaken classifier failure safety', async () => {
    mockSpawn.mockReturnValue(fakeChild({ spawnError: new Error('ENOENT') }) as never);
    expect(
      await classifyCodexEffort('m', {
        binary: '/bin/codex',
        router: { enabled: true, fallbackEffort: 'xhigh' },
      }),
    ).toBe('ultra');
  });

  it('fails closed at ultra on unparseable output', async () => {
    mockSpawn.mockReturnValue(fakeChild({
      stdout: jsonl([{ type: 'item.completed', item: { type: 'agent_message', text: 'I cannot decide' } }]),
    }) as never);
    expect(
      await classifyCodexEffort('m', { binary: '/bin/codex', router: { enabled: true } }),
    ).toBe('ultra');
  });

  it('fails closed at ultra on timeout', async () => {
    mockSpawn.mockReturnValue(fakeChild({ code: 0, closeDelayMs: 50 }) as never);
    const effort = await classifyCodexEffort('m', {
      binary: '/bin/codex',
      router: { enabled: true, timeoutMs: 20 },
    });
    expect(effort).toBe('ultra');
  });

  it('never rejects the promise, even when spawn throws synchronously', async () => {
    // vitest records any throw inside a mock as an unhandled error even when
    // the SUT catches it; verified out-of-band instead. Here we assert the
    // resolved-value contract using a deferred-rejection child.
    const child = fakeChild({}) as never;
    mockSpawn.mockReturnValue(child);
    let result: string | undefined = 'sentinel';
    let caught: unknown;
    try {
      result = await classifyCodexEffort('m', { binary: '/bin/codex', router: { enabled: true, timeoutMs: 5 } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUndefined();
    expect(result).toBe('ultra');
  });

  it('honors classifierModel/classifierEffort/timeout overrides', async () => {
    mockSpawn.mockReturnValue(fakeChild({
      stdout: jsonl([{ type: 'item.completed', item: { type: 'agent_message', text: 'low' } }]),
    }) as never);
    await classifyCodexEffort('m', {
      binary: '/bin/codex',
      model: 'main-model',
      router: { enabled: true, classifierModel: 'fast-model', classifierEffort: 'low', timeoutMs: 9000 },
    });
    const call = mockSpawn.mock.calls[0]!;
    const args = call[1] as string[];
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('fast-model');
    expect(args).toContain('model_reasoning_effort="low"');
  });

  it('uses the configured shared local classifier instead of starting Codex', async () => {
    mockSpawn.mockReturnValue(fakeChild({ stdout: 'medium\n' }) as never);

    const effort = await classifyCodexEffort('修复这个单文件 bug', {
      binary: '/bin/codex',
      model: 'main-model',
      router: {
        enabled: true,
        classifierCommand: '/opt/policy/codex-classify-effort',
        classifierArgs: ['--plain'],
        timeoutMs: 500,
      },
    });

    expect(effort).toBe('medium');
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn.mock.calls[0]?.[0]).toBe('/opt/policy/codex-classify-effort');
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual(['--plain']);
  });
});

describe('sub-agent plan', () => {
  it('treats automatic F2 as a hard floor for main effort and model', () => {
    expect(resolveCodexRunPolicy('low', 'ultra', 'gpt-5.6-terra')).toEqual({
      effort: 'ultra',
      subAgentEffort: 'ultra',
      model: 'gpt-5.6-sol',
    });
  });

  it('keeps a valid session override for non-F2 routing', () => {
    expect(resolveCodexRunPolicy('medium', 'high', 'gpt-5.6-terra')).toEqual({
      effort: 'medium',
      subAgentEffort: 'medium',
      model: 'gpt-5.6-terra',
    });
  });

  it('preserves the supported minimal main-run override without weakening F2', () => {
    expect(resolveCodexRunPolicy('minimal', 'high', 'gpt-5.6-terra')).toEqual({
      effort: 'minimal',
      subAgentEffort: 'low',
      model: 'gpt-5.6-terra',
    });
    expect(resolveCodexRunPolicy('minimal', 'ultra', 'gpt-5.6-terra')).toEqual({
      effort: 'ultra',
      subAgentEffort: 'ultra',
      model: 'gpt-5.6-sol',
    });
  });

  it('maps each difficulty tier to a sub-agent budget', () => {
    expect(subAgentPlanForEffort('low')).toEqual({ maxConcurrentThreads: 1, effort: 'low' });
    expect(subAgentPlanForEffort('medium')).toEqual({ maxConcurrentThreads: 1, effort: 'medium' });
    expect(subAgentPlanForEffort('high')).toEqual({ maxConcurrentThreads: 2, effort: 'high' });
    expect(subAgentPlanForEffort('xhigh')).toEqual({ maxConcurrentThreads: 3, effort: 'high' });
    expect(subAgentPlanForEffort('ultra')).toEqual({
      maxConcurrentThreads: 3,
      effort: 'ultra',
      model: 'gpt-5.6-sol',
    });
  });

  it('never sets a thread count below 1 (codex minimum)', () => {
    for (const tier of ['low', 'medium', 'high', 'xhigh', 'ultra'] as const) {
      expect(subAgentPlanForEffort(tier).maxConcurrentThreads).toBeGreaterThanOrEqual(1);
    }
  });

  it('renders the plan as codex -c override values (no -c prefix)', () => {
    expect(subAgentOverrideArgs({ maxConcurrentThreads: 2, effort: 'high' })).toEqual([
      'agents.max_concurrent_threads_per_session=2',
      'agents.default_subagent_reasoning_effort="high"',
    ]);
  });

  it('pins F2 sub-agents to sol plus ultra', () => {
    expect(
      subAgentOverrideArgs({
        maxConcurrentThreads: 3,
        effort: 'ultra',
        model: 'gpt-5.6-sol',
      }),
    ).toEqual([
      'agents.max_concurrent_threads_per_session=3',
      'agents.default_subagent_model="gpt-5.6-sol"',
      'agents.default_subagent_reasoning_effort="ultra"',
    ]);
  });

  it('omits the count override at the default count but still sets effort', () => {
    expect(subAgentOverrideArgs({ maxConcurrentThreads: 1, effort: 'medium' })).toEqual([
      'agents.default_subagent_reasoning_effort="medium"',
    ]);
    expect(subAgentOverrideArgs({ maxConcurrentThreads: 1, effort: 'low' })).toEqual([
      'agents.default_subagent_reasoning_effort="low"',
    ]);
  });
});
