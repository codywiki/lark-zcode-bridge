import type { ToolEntry } from './run-state';

const HEADER_SUMMARY_MAX = 80;
/**
 * Paths get a tighter budget than free text: they are the most common summary
 * and the least informative per character, so a full repo path would crowd out
 * everything else on the line.
 */
const PATH_SUMMARY_MAX = 44;
const BODY_FIELD_MAX = 600;
const OUTPUT_MAX = 1200;
/**
 * Cumulative cap on a tool's full body markdown (input + output + code fences
 * + headers). Even with per-field caps, pathological tools (many input
 * fields + maxed-out output) can stack to multi-KB bodies which, multiplied
 * across panels, push the card past Feishu's per-element size limit. This
 * is the last belt across the whole rendered body string.
 */
const BODY_TOTAL_MAX = 2500;

/**
 * Header line for a tool call.
 *
 * Only failure is marked. A per-tool ✅/⏳ carries no information the user acts
 * on — success is the default and "running" is already implied by the card's
 * own footer — while a column of glyphs is what makes a long run read as
 * noise. Errors keep a marker because they are the one status worth spotting
 * at a glance.
 */
export function toolHeaderText(tool: ToolEntry): string {
  const prefix = tool.status === 'error' ? '⚠️ ' : '';
  const summary = summarizeInput(tool.name, tool.input);
  return summary ? `${prefix}**${tool.name}** — ${summary}` : `${prefix}**${tool.name}**`;
}

export function toolBodyMd(tool: ToolEntry): string {
  const parts: string[] = [];
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);

  if (tool.output) {
    const truncated = truncate(tool.output, OUTPUT_MAX);
    if (tool.status === 'error') {
      parts.push(`**Error**\n\`\`\`\n${truncated}\n\`\`\``);
    } else if (tool.name === 'Bash') {
      parts.push(renderBashOutput(truncated));
    } else {
      parts.push(`**Output**\n\`\`\`\n${truncated}\n\`\`\``);
    }
  } else if (tool.status === 'running') {
    parts.push('_运行中…_');
  }

  const body = parts.join('\n\n');
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}…\n\n_（body 已截断,完整内容查 \`/doctor\` 或日志）_`;
}

function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const raw = (key: string): string => {
    const v = rec[key];
    return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  };
  const pick = (key: string, max = HEADER_SUMMARY_MAX): string => truncate(raw(key), max);
  // Paths are shortened before the length cap, not after: truncating first
  // would cut the filename off the end and leave only the shared prefix.
  const path = (key: string): string => truncate(shortenPath(raw(key)), HEADER_SUMMARY_MAX);

  switch (name) {
    case 'Bash':
    case 'command_execution':
      return truncate(summarizeCommand(raw('command')), HEADER_SUMMARY_MAX);
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return path('file_path');
    case 'Grep': {
      const pat = pick('pattern', 40);
      const where = path('path');
      return where ? `${pat} in ${where}` : pat;
    }
    case 'Glob':
      return pick('pattern');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query', 60);
    case 'Agent':
    case 'Task':
      return pick('description') || pick('subagent_type');
    default:
      return pick('command') || path('file_path') || path('path') || pick('query');
  }
}

/**
 * The informative part of a shell command line.
 *
 * Real commands arrive wrapped in navigation and noise — `cd /long/path &&
 * grep …`, `echo "=== header ===" ; ls`. The wrapper is identical across
 * calls, so showing it spends the line on the one part that never varies.
 * This drops leading `cd`, and prefers the first segment that isn't just an
 * `echo` banner, falling back to the original when every segment is noise.
 */
function summarizeCommand(command: string): string {
  if (!command) return '';
  const segments = command.split(/&&|[;\n]/).map((s) => s.trim()).filter(Boolean);
  const meaningful = segments.filter((segment) => {
    const program = segment.split(/\s+/)[0] ?? '';
    return program !== 'cd' && program !== 'echo';
  });
  const chosen = meaningful[0] ?? segments[0] ?? command;
  // Trailing "…" means a real command was left out. Dropped `cd`/`echo`
  // boilerplate does not count: it carried nothing, so flagging it would imply
  // hidden work that never happened.
  return meaningful.length > 1 ? `${chosen} …` : chosen;
}

function renderInput(tool: ToolEntry): string {
  const input = tool.input;
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const str = (k: string): string => (typeof rec[k] === 'string' ? rec[k] as string : '');

  switch (tool.name) {
    case 'Bash': {
      const cmd = str('command');
      return cmd ? `**Command**\n\`\`\`bash\n${truncate(cmd, BODY_FIELD_MAX)}\n\`\`\`` : '';
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const fp = str('file_path');
      return fp ? `**File** \`${fp}\`` : '';
    }
    case 'Grep': {
      const lines: string[] = [];
      if (str('pattern')) lines.push(`**Pattern** \`${str('pattern')}\``);
      if (str('path')) lines.push(`**Path** \`${str('path')}\``);
      return lines.join('\n');
    }
    case 'WebFetch':
      return str('url') ? `**URL** ${str('url')}` : '';
    case 'WebSearch':
      return str('query') ? `**Query** \`${truncate(str('query'), BODY_FIELD_MAX)}\`` : '';
    default:
      return '';
  }
}

function renderBashOutput(out: string): string {
  // Some agents wrap stdout/stderr in xml-like tags; keep simple and just dump.
  return `**Output**\n\`\`\`\n${out}\n\`\`\``;
}

/**
 * Shorten a path for a one-line header, keeping the part that identifies the
 * file. An absolute path into a deep repo is mostly prefix the reader already
 * knows; the filename and its immediate parent are what distinguish this call
 * from the next one, so long paths keep the tail and lose the middle.
 *
 * The home directory collapses to `~` because that prefix is on nearly every
 * path here. Full paths remain in the tool body and the file log — this only
 * governs the summary line.
 */
function shortenPath(p: string): string {
  if (!p) return p;
  const home = process.env.HOME;
  const withTilde = home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
  if (withTilde.length <= PATH_SUMMARY_MAX) return withTilde;

  const segments = withTilde.split('/');
  const tail = segments.slice(-2).join('/');
  const head = segments[0] === '~' || segments[0] === '' ? segments[0] || '' : '';
  const shortened = head ? `${head}/…/${tail}` : `…/${tail}`;
  // A single very long segment (no separators to cut on) still needs bounding.
  return shortened.length <= PATH_SUMMARY_MAX
    ? shortened
    : `…${withTilde.slice(-(PATH_SUMMARY_MAX - 1))}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
