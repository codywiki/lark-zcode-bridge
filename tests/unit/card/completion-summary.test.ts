import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types.js';
import {
  COMPLETION_SUMMARY_MAX_CHARS,
  renderCompletionSummary,
  SUMMARY_MIN_FINAL_TEXT_CHARS,
  SUMMARY_MIN_TOOL_CALLS,
  SUMMARY_MIN_TOTAL_TEXT_CHARS,
} from '../../../src/card/completion-summary.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';

describe('completion summary', () => {
  it('uses only the last assistant text block and excludes tool details', () => {
    const state = stateFrom([
      { type: 'text', delta: '我先检查配置。' },
      ...toolEvents(SUMMARY_MIN_TOOL_CALLS),
      { type: 'text', delta: '已修复邀请命令，相关测试全部通过。' },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const summary = renderCompletionSummary(state);
    expect(summary).toContain('已修复邀请命令，相关测试全部通过。');
    expect(summary).not.toContain('我先检查配置');
    expect(summary).not.toContain('secret command');
    expect(summary).not.toContain('secret output');
  });

  it('skips the follow-up for a short run whose card already shows everything', () => {
    expect(renderCompletionSummary(stateFrom([
      { type: 'text', delta: '你好！有什么可以帮你的？' },
      { type: 'done', terminationReason: 'normal' },
    ]))).toBeUndefined();

    expect(renderCompletionSummary(stateFrom([
      { type: 'text', delta: '改好了，测试通过。' },
      ...toolEvents(SUMMARY_MIN_TOOL_CALLS - 1),
      { type: 'done', terminationReason: 'normal' },
    ]))).toBeUndefined();
  });

  it('sends the follow-up once the run is long enough to bury the conclusion', () => {
    const manyTools = renderCompletionSummary(stateFrom([
      ...toolEvents(SUMMARY_MIN_TOOL_CALLS),
      { type: 'text', delta: '改好了，测试通过。' },
      { type: 'done', terminationReason: 'normal' },
    ]));
    expect(manyTools).toContain('改好了，测试通过。');

    const longConclusion = renderCompletionSummary(stateFrom([
      { type: 'text', delta: '结论。'.repeat(SUMMARY_MIN_FINAL_TEXT_CHARS) },
      { type: 'done', terminationReason: 'normal' },
    ]));
    expect(longConclusion).toContain('结果摘要');

    const chattyProcess = renderCompletionSummary(stateFrom([
      { type: 'text', delta: '中间进展说明。'.repeat(SUMMARY_MIN_TOTAL_TEXT_CHARS) },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', delta: '搞定。' },
      { type: 'done', terminationReason: 'normal' },
    ]));
    expect(chattyProcess).toContain('搞定。');
  });

  it('bounds long final text and points to the process message', () => {
    const content = `${'结果已经确认。'.repeat(100)}尾部不应完整出现`;
    const summary = renderCompletionSummary(stateFrom([
      { type: 'text', delta: content },
      { type: 'done', terminationReason: 'normal' },
    ]));

    expect(summary).toContain('完整内容见上方过程消息');
    expect(summary).not.toContain('尾部不应完整出现');
    // The cap covers the whole message — title and footer included, not just
    // the body — so the follow-up stays glanceable.
    expect(summary!.length).toBeLessThanOrEqual(COMPLETION_SUMMARY_MAX_CHARS);
  });

  it('keeps every truncated summary within the cap, whatever the text shape', () => {
    // Shapes that stress the sentence-boundary search: no punctuation at all,
    // one boundary too early to use, and boundaries throughout. Each is long
    // enough to clear SUMMARY_MIN_FINAL_TEXT_CHARS so a summary is produced.
    const long = SUMMARY_MIN_FINAL_TEXT_CHARS;
    const shapes = [
      '无标点的长文本'.repeat(long),
      `短句。${'后面是很长的一段没有断句的内容'.repeat(long)}`,
      '确认。'.repeat(long),
      'A'.repeat(long * 2),
    ];

    for (const shape of shapes) {
      const label = shape.slice(0, 12);
      const summary = renderCompletionSummary(stateFrom([
        { type: 'text', delta: shape },
        { type: 'done', terminationReason: 'normal' },
      ]));
      expect(summary, label).toBeDefined();
      expect(summary!.length, label).toBeLessThanOrEqual(COMPLETION_SUMMARY_MAX_CHARS);
    }
  });

  it('leaves a summary that already fits completely untouched', () => {
    const conclusion = '改好了，测试全部通过，已重启三个 bridge。';
    const summary = renderCompletionSummary(stateFrom([
      ...toolEvents(SUMMARY_MIN_TOOL_CALLS),
      { type: 'text', delta: conclusion },
      { type: 'done', terminationReason: 'normal' },
    ]));

    expect(summary).toBe(`✅ 结果摘要\n\n${conclusion}`);
    expect(summary).not.toContain('…');
    expect(summary).not.toContain('完整内容见上方');
  });

  it('sends a completion marker when a long silent run produced no text', () => {
    expect(renderCompletionSummary(stateFrom([
      ...toolEvents(SUMMARY_MIN_TOOL_CALLS),
      { type: 'done', terminationReason: 'normal' },
    ]))).toBe('✅ 任务已完成');
  });

  it('stays silent when a successful run produced nothing at all', () => {
    expect(renderCompletionSummary(stateFrom([
      { type: 'done', terminationReason: 'normal' },
    ]))).toBeUndefined();
  });

  it('strips common markdown markers from the plain-text follow-up', () => {
    const summary = renderCompletionSummary(stateFrom([
      ...toolEvents(SUMMARY_MIN_TOOL_CALLS),
      { type: 'text', delta: '## **完成**\n\n- 已修改 `channel.ts`\n- 测试通过' },
      { type: 'done', terminationReason: 'normal' },
    ]));

    expect(summary).toContain('完成\n\n已修改 channel.ts\n测试通过');
    expect(summary).not.toMatch(/[*#`]/);
  });

  it('does not create a success summary for non-success terminal states', () => {
    expect(renderCompletionSummary(initialState)).toBeUndefined();
    expect(renderCompletionSummary(stateFrom([
      { type: 'error', message: 'failed', terminationReason: 'failed' },
    ]))).toBeUndefined();
    expect(renderCompletionSummary(stateFrom([
      { type: 'done', terminationReason: 'interrupted' },
    ]))).toBeUndefined();
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

/** N completed tool calls, enough to push a run over the long-run threshold. */
function toolEvents(count: number): AgentEvent[] {
  return Array.from({ length: count }, (_, i) => [
    {
      type: 'tool_use',
      id: `tool-${i}`,
      name: 'Bash',
      input: { command: 'secret command' },
    } satisfies AgentEvent,
    { type: 'tool_result', id: `tool-${i}`, output: 'secret output', isError: false } satisfies AgentEvent,
  ]).flat();
}
