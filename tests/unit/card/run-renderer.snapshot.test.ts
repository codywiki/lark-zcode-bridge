import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { normalizeCard } from '../../helpers/card-normalize.js';

describe('run card renderer snapshots', () => {
  it('renders initial running state', () => {
    expectCard(initialState).toMatchSnapshot();
  });

  it('shows accepted liveness in a running card', () => {
    const card = renderCard({
      ...initialState,
      liveStatus: { elapsedSeconds: 2, idleSeconds: 2 },
    });

    expect(JSON.stringify(card)).toContain('已受理，任务正在运行');
  });

  it('shows elapsed and idle minutes in a running card heartbeat', () => {
    const card = renderCard({
      ...initialState,
      liveStatus: { elapsedSeconds: 125, idleSeconds: 65 },
    });

    expect(JSON.stringify(card)).toContain('已运行 2 分钟 · 最近活动 1 分钟前');
  });

  it('shows activity under one minute ago as just now', () => {
    const state = {
      ...initialState,
      liveStatus: { elapsedSeconds: 125, idleSeconds: 5 },
    };

    expect(JSON.stringify(renderCard(state))).toContain('已运行 2 分钟 · 刚刚有活动');
    expect(renderText(state)).toContain('已运行 2 分钟 · 刚刚有活动');
  });

  it('renders active and completed thinking', () => {
    expectCard(stateFrom([{ type: 'thinking', delta: 'checking options' }])).toMatchSnapshot();
    expectCard(stateFrom([
      { type: 'thinking', delta: 'checking options' },
      { type: 'text', delta: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders tool running, done, and error states', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/missing.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'ENOENT', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('collapses consecutive tools while preserving the latest running tool', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders done, error, interrupted, and idle-timeout terminal states', () => {
    expectCard(stateFrom([{ type: 'done', terminationReason: 'normal' }])).toMatchSnapshot();
    expectCard(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }])).toMatchSnapshot();
    expectCard(markInterrupted(stateFrom([{ type: 'text', delta: 'partial' }]))).toMatchSnapshot();
    expectCard(markIdleTimeout(stateFrom([{ type: 'text', delta: 'partial' }]), 15)).toMatchSnapshot();
  });

  it('renders markdown text mode without card-only controls', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'hidden reasoning' },
      { type: 'text', delta: 'Answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'Done' },
    ]);

    expect(renderText(state)).toMatchSnapshot();
    expect(renderText(markInterrupted(state))).toMatchSnapshot();
    expect(renderText(markIdleTimeout(state, 10))).toMatchSnapshot();
    expect(renderText(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }]))).toMatchSnapshot();
  });

  it('groups consecutive tool calls into one blockquote', () => {
    const text = renderText(stateFrom([
      { type: 'text', delta: 'Starting' },
      { type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: 'a.ts' } },
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Write', input: { file_path: 'b.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'ok', isError: false },
      { type: 'text', delta: 'Done' },
      { type: 'done', terminationReason: 'normal' },
    ]));

    // One quote block, single-newline separated — not a blank line (and so a
    // separate quote) per call.
    expect(text).toContain('> **Edit** — a.ts\n> **Write** — b.ts');
    expect(text).not.toContain('a.ts\n\n> **Write**');
  });

  it('reports hidden lookups where they happened, not at the end', () => {
    const text = renderText(stateFrom([
      { type: 'text', delta: 'Looking' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_result', id: 'tool-1', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Edit', input: { file_path: 'a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'ok', isError: false },
      { type: 'text', delta: 'Fixed' },
      { type: 'tool_use', id: 'tool-3', name: 'Read', input: { file_path: 'b.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'b', isError: false },
      { type: 'text', delta: 'Confirmed' },
      { type: 'done', terminationReason: 'normal' },
    ]));

    // Each group carries its own tally, and the run still ends on the answer.
    expect(text).toContain('> **Edit** — a.ts\n> _…另有 1 次读取/检索_');
    expect(text.trimEnd().endsWith('Confirmed')).toBe(true);
    // The lone hidden read between "Fixed" and "Confirmed" is its own note.
    expect(text).toContain('> _…1 次读取/检索_');
  });

  it('keeps inspection tools out of the text transcript', () => {
    const state = stateFrom([
      { type: 'text', delta: 'Looking into it' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-1', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'grep -rn foo src/' } },
      { type: 'tool_result', id: 'tool-2', output: 'hit', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'ok', isError: false },
      { type: 'text', delta: 'Fixed it' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const text = renderText(state);
    expect(text).toContain('**Edit** — /repo/a.ts');
    expect(text).not.toContain('Read');
    expect(text).not.toContain('grep');
    expect(text).toContain('另有 2 次');
    expect(text).not.toContain('✅');
    expect(text).not.toContain('⏳');
  });

  it('marks a failed tool even when its kind is normally hidden', () => {
    const text = renderText(stateFrom([
      { type: 'text', delta: 'Checking' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/missing.ts' } },
      { type: 'tool_result', id: 'tool-1', output: 'ENOENT', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ]));

    expect(text).toContain('⚠️ **Read** — /missing.ts');
    expect(text).not.toContain('另有');
  });

  it('suppresses the tool count when no other content is visible', () => {
    // renderText() returning '' is how callers detect "no progress worth
    // posting"; a lone "另有 N 次" line would defeat that and post noise.
    const state = stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-1', output: 'a', isError: false },
    ]);

    expect(renderText({ ...state, footer: null }).trim()).toBe('');
  });

  it('injects signed bridge callback values for managed run controls', () => {
    const card = renderCard(initialState, {
      signCallback: (action) => `token-for-${action}`,
    }) as {
      body?: { elements?: Array<{ tag?: string; behaviors?: Array<{ value?: Record<string, unknown> }> }> };
    };
    const button = card.body?.elements?.find((element) => element.tag === 'button');

    expect(button?.behaviors?.[0]?.value).toEqual({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: 'token-for-stop',
    });
  });

  it('folds progress text and tool summaries into one collapsed process panel', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'private reasoning summary' },
      { type: 'text', delta: 'progress update' },
      { type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'final_text', content: 'FINAL_SENTINEL' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = renderCard(state, { compactProcess: true }) as {
      body?: {
        elements?: Array<{
          tag?: string;
          expanded?: boolean;
          header?: { title?: { content?: string } };
          elements?: unknown[];
        }>;
      };
    };
    const elements = card.body?.elements ?? [];
    const panel = elements[0];
    const panelJson = JSON.stringify(panel);

    expect(state.finalText).toBe('FINAL_SENTINEL');
    expect(elements).toHaveLength(1);
    expect(panel?.tag).toBe('collapsible_panel');
    expect(panel?.expanded).toBe(false);
    expect(panel?.header?.title?.content).toContain('执行过程');
    expect(panelJson).toContain('progress update');
    expect(panelJson).toContain('Edit');
    expect(panelJson).not.toContain('/repo/a.ts\\n\\n**Output**');
    expect(JSON.stringify(card)).not.toContain('FINAL_SENTINEL');
  });

  it('counts inspection tools in the process panel instead of naming them', () => {
    const state = stateFrom([
      { type: 'text', delta: 'progress update' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-1', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'ls -la' } },
      { type: 'tool_result', id: 'tool-2', output: 'a.ts', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Write', input: { file_path: '/repo/b.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const panelJson = JSON.stringify(renderCard(state, { compactProcess: true }));

    // The mutation is named; the two lookups collapse into a count.
    expect(panelJson).toContain('Write');
    expect(panelJson).not.toContain('Read');
    expect(panelJson).not.toContain('ls -la');
    expect(panelJson).toContain('另有 2 次');
    // The header still reports the true total, so nothing looks skipped.
    expect(panelJson).toContain('3 个工具');
  });

  it('keeps terminal failures visible outside the collapsed process panel', () => {
    const state = stateFrom([
      { type: 'text', delta: 'progress update' },
      { type: 'error', message: 'process failed', terminationReason: 'failed' },
    ]);

    const card = renderCard(state, { compactProcess: true }) as {
      body?: { elements?: Array<{ tag?: string; content?: string }> };
    };
    const elements = card.body?.elements ?? [];

    expect(elements[0]?.tag).toBe('collapsible_panel');
    expect(elements.at(-1)).toMatchObject({
      tag: 'markdown',
      content: expect.stringContaining('process failed'),
    });
  });

  it('keeps local paths in user-visible cards and text fallbacks', () => {
    const sensitivePath = '/Users/example/private/customer/repo/secret.txt';
    const state = stateFrom([
      { type: 'text', delta: `I read ${sensitivePath}` },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: sensitivePath } },
      { type: 'tool_result', id: 'tool-1', output: `content from ${sensitivePath}`, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);
    expect(card).toContain(sensitivePath);
    expect(text).toContain(sensitivePath);
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

function expectCard(state: RunState) {
  return expect(normalizeCard(renderCard(state)));
}
