import type { Block, RunState, ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';
import { isSignificantTool } from './tool-significance';

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Only significant tool calls get a line; the rest collapse to a count
 *     placed where they happened (see tool-significance.ts)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState): string {
  const sections: string[] = [];
  // Counts are only worth showing next to real content; on their own they are
  // the noise the filter exists to remove, and callers read a blank render as
  // "no progress worth posting". So they are collected and only kept if some
  // prose or named tool made it into the transcript.
  let hasContent = false;

  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      const content = group.content.trim();
      if (!content) continue;
      sections.push(content);
      hasContent = true;
      continue;
    }

    const named = group.tools.filter(isSignificantTool);
    const hidden = group.tools.length - named.length;
    if (named.length > 0) hasContent = true;

    const quote = toolQuote(named, hidden);
    if (quote) sections.push(quote);
  }

  const parts = hasContent ? sections : [];

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running') {
    if (state.liveStatus) parts.push(liveStatusLine(state.liveStatus));
    if (state.footer) parts.push(footerLine(state.footer));
  }

  return parts.join('\n\n');
}

/**
 * One run of consecutive tool calls, as a single blockquote:
 *
 * ```
 * > **Edit** — ~/repo/a.ts
 * > ⚠️ **Write** — ~/repo/b.ts
 * > _…另有 6 次读取/检索_
 * ```
 *
 * Kept as one quote with single newlines so the calls read as one step of the
 * run. Blank lines between them would make markdown emit a separate quote per
 * call — the sparse, stretched-out look this replaces.
 */
function toolQuote(named: ToolEntry[], hidden: number): string {
  const lines = named.map((tool) => `> ${toolHeaderText(tool)}`);
  if (hidden > 0) {
    // Placed in the group where the lookups actually happened, so the
    // transcript still reads as a sequence rather than ending on a tally.
    lines.push(named.length > 0 ? `> _…另有 ${hidden} 次读取/检索_` : `> _…${hidden} 次读取/检索_`);
  }
  return lines.join('\n');
}

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}

/** Runs of consecutive tool calls, split by the prose between them. */
function* groupBlocks(blocks: Block[]): Generator<ToolGroup | TextGroup> {
  let buffered: ToolEntry[] = [];
  for (const block of blocks) {
    if (block.kind === 'tool') {
      buffered.push(block.tool);
      continue;
    }
    if (buffered.length > 0) {
      yield { kind: 'tools', tools: buffered };
      buffered = [];
    }
    yield { kind: 'text', content: block.content };
  }
  if (buffered.length > 0) yield { kind: 'tools', tools: buffered };
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming'): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}

function liveStatusLine(status: NonNullable<RunState['liveStatus']>): string {
  if (status.elapsedSeconds < 60) return '_⏱ 已受理，任务正在运行_';
  const elapsedMinutes = Math.max(1, Math.floor(status.elapsedSeconds / 60));
  if (status.idleSeconds < 60) return `_⏱ 已运行 ${elapsedMinutes} 分钟 · 刚刚有活动_`;
  const idleMinutes = Math.floor(status.idleSeconds / 60);
  return `_⏱ 已运行 ${elapsedMinutes} 分钟 · 最近活动 ${idleMinutes} 分钟前_`;
}
