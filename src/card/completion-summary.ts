import type { RunState } from './run-state';

/**
 * Hard cap on the whole rendered follow-up, title and footer included. This
 * message exists to be *read at a glance* — it is the conclusion rescued from a
 * long process card, not a second copy of it. Past a couple of sentences it
 * stops being a summary and becomes another wall of text to scroll, so the cap
 * is deliberately tight and the full answer stays one scroll up in the process
 * message.
 */
export const COMPLETION_SUMMARY_MAX_CHARS = 200;

const SUMMARY_TITLE = '✅ 结果摘要';
const SUMMARY_MORE_HINT = '完整内容见上方过程消息。';

/**
 * Chars the body may use, once the title, the blank lines around it, the
 * ellipsis and the "see above" hint have taken their share. Derived rather
 * than hardcoded so {@link COMPLETION_SUMMARY_MAX_CHARS} stays the single
 * number to tune.
 */
const BODY_MAX_CHARS =
  COMPLETION_SUMMARY_MAX_CHARS - SUMMARY_TITLE.length - SUMMARY_MORE_HINT.length - '\n\n'.length * 2 - '…'.length;

/**
 * Thresholds above which a run counts as long. The follow-up summary only
 * exists because a long process card can clip or bury the conclusion — a short
 * turn (a greeting, a one-line answer, a quick lookup) renders in full, so a
 * second copy of it is pure noise and gets skipped.
 */
export const SUMMARY_MIN_FINAL_TEXT_CHARS = 700;
export const SUMMARY_MIN_TOTAL_TEXT_CHARS = 1500;
export const SUMMARY_MIN_TOOL_CALLS = 6;

/**
 * Build the small, separate completion message sent after a long streamed run.
 *
 * Only the last assistant text block is considered. Tool inputs/outputs and
 * earlier progress commentary stay in the process card, so this follow-up is
 * bounded, cheap, and cannot accidentally turn the full trace into a second
 * long message.
 */
export function renderCompletionSummary(state: RunState): string | undefined {
  if (state.terminal !== 'done') return undefined;

  const finalText = [...state.blocks]
    .reverse()
    .find((block) => block.kind === 'text' && block.content.trim());
  const plainText =
    finalText?.kind === 'text' ? stripMarkdown(finalText.content).trim() : '';

  if (!isLongRun(state, plainText)) return undefined;
  if (!plainText) return '✅ 任务已完成';
  return `${SUMMARY_TITLE}\n\n${truncateSummary(plainText)}`;
}

/**
 * Whether the run is long enough for the follow-up to earn its place: a long
 * conclusion (which the card may clip), a lot of intermediate commentary, or
 * many tool calls (which push the conclusion out of view).
 */
function isLongRun(state: RunState, finalText: string): boolean {
  if (finalText.length >= SUMMARY_MIN_FINAL_TEXT_CHARS) return true;

  let totalTextChars = 0;
  let toolCalls = 0;
  for (const block of state.blocks) {
    if (block.kind === 'text') totalTextChars += block.content.length;
    else toolCalls += 1;
  }
  return totalTextChars >= SUMMARY_MIN_TOTAL_TEXT_CHARS || toolCalls >= SUMMARY_MIN_TOOL_CALLS;
}

function truncateSummary(content: string): string {
  if (content.length <= BODY_MAX_CHARS) return content;

  const head = content.slice(0, BODY_MAX_CHARS);
  // Prefer ending on a sentence, but only if that keeps most of the budget —
  // at this cap, honouring an early boundary would throw away half the summary.
  const minBoundary = Math.floor(BODY_MAX_CHARS * 0.6);
  let boundary = -1;
  for (const marker of ['\n', '。', '！', '？', '.', '!', '?', '；', ';']) {
    boundary = Math.max(boundary, head.lastIndexOf(marker));
  }
  const clipped = head.slice(0, boundary >= minBoundary ? boundary + 1 : head.length).trimEnd();
  return `${clipped}…\n\n${SUMMARY_MORE_HINT}`;
}

function stripMarkdown(content: string): string {
  return content
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1')
    .replace(/(?<![_\w])_([^_\n]+)_(?!\w)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '');
}
