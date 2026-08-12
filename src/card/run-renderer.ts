import type { Block, FooterStatus, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';
import { isSignificantTool } from './tool-significance';

const REASONING_MAX = 1500;
const COMPACT_PROCESS_MAX = 6000;
const COLLAPSE_TOOL_THRESHOLD = 3;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
  compactProcess?: boolean;
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = [];

  if (options.compactProcess) {
    const panel = compactProcessPanel(state);
    if (panel) elements.push(panel);
  } else {
    if (state.reasoning.content) {
      elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
    }

    for (const group of groupBlocks(state.blocks)) {
      if (group.kind === 'text') {
        if (group.content.trim()) {
          elements.push(markdown(group.content));
        }
      } else {
        elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
      }
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.liveStatus) elements.push(noteMd(liveStatusLine(state.liveStatus)));
    if (state.footer) elements.push(footerStatus(state.footer));
    elements.push(stopButton(options));
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
}

function compactProcessPanel(state: RunState): object | undefined {
  const progress = state.blocks
    .filter((block): block is Extract<Block, { kind: 'text' }> => block.kind === 'text')
    .map((block) => block.content.trim())
    .filter(Boolean);
  const tools = state.blocks
    .filter((block): block is Extract<Block, { kind: 'tool' }> => block.kind === 'tool')
    .map((block) => block.tool);
  if (progress.length === 0 && tools.length === 0) return undefined;

  // Inside the panel there is room to list more than the transcript shows, but
  // listing every read still buries the ones that changed something — so the
  // significant calls are named and the rest are counted.
  const notable = tools.filter(isSignificantTool);
  const suppressed = tools.length - notable.length;

  const bodyParts: string[] = [];
  if (progress.length > 0) bodyParts.push(`**进度**\n${progress.join('\n\n')}`);
  if (notable.length > 0) {
    bodyParts.push(`**工具调用**\n${notable.map((tool) => `- ${toolHeaderText(tool)}`).join('\n')}`);
  }
  if (suppressed > 0) {
    bodyParts.push(`_另有 ${suppressed} 次读取/检索，未逐条列出。_`);
  }
  const counts = [
    progress.length > 0 ? `${progress.length} 条进度` : '',
    tools.length > 0 ? `${tools.length} 个工具` : '',
  ].filter(Boolean);

  return collapsiblePanel({
    title: `☕ **执行过程 · ${counts.join(' · ')}**`,
    expanded: false,
    border: 'blue',
    body: truncate(bodyParts.join('\n\n'), COMPACT_PROCESS_MAX),
  });
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * Render N tool calls as a single collapsed panel. **Body content is dropped**
 * — only the per-tool header line (icon + name + short summary) is kept.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : '✍️ 正在输出';
  return noteMd(text);
}

function liveStatusLine(status: NonNullable<RunState['liveStatus']>): string {
  if (status.elapsedSeconds < 60) return '_⏱ 已受理，任务正在运行_';
  const elapsedMinutes = Math.max(1, Math.floor(status.elapsedSeconds / 60));
  if (status.idleSeconds < 60) return `_⏱ 已运行 ${elapsedMinutes} 分钟 · 刚刚有活动_`;
  const idleMinutes = Math.floor(status.idleSeconds / 60);
  return `_⏱ 已运行 ${elapsedMinutes} 分钟 · 最近活动 ${idleMinutes} 分钟前_`;
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
