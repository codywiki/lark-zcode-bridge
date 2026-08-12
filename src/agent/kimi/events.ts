import type {
  SessionNotification,
  Usage,
} from '@agentclientprotocol/sdk';
import { isAbsolute, relative, sep } from 'node:path';
import type { AccessMode } from '../../config/permissions';
import { redactDiagnosticText } from '../../core/logger';
import type { AgentEvent } from '../types';

export interface KimiAcpEventTranslatorOptions {
  cwd: string;
  accessMode?: AccessMode;
  now?: () => number;
}

export const KIMI_MAX_BUFFERED_ANSWER_BYTES = 20_000;
export const KIMI_OVERSIZED_ANSWER_MESSAGE = 'Kimi 回答超过安全输出上限，内容已隐藏。';
const KIMI_PROGRESS_INTERVAL_MS = 5_000;
const LOCAL_FILE_URI_RE = /\bfile:\/\/[^\r\n]*/gimu;
const LOCAL_REDUNDANT_SLASH_POSIX_PATH_RE =
  /(^|[^A-Za-z0-9/.:])\/{2,}(?:Applications|Library|System|Network|Users|Volumes|app|bin|cores|data|dev|etc|home|mnt|opt|private|root|sbin|srv|tmp|usr|var|workspace|workspaces)(?=$|\/|[^A-Za-z0-9._-])[^\r\n]*/gmu;
const LOCAL_POSIX_PATH_RE =
  /(^|[^A-Za-z0-9/.])\/(?:Applications|Library|System|Network|Users|Volumes|app|bin|cores|data|dev|etc|home|mnt|opt|private|root|sbin|srv|tmp|usr|var|workspace|workspaces)(?=$|\/|[^A-Za-z0-9._-])[^\r\n]*/gmu;
const LOCAL_GENERIC_POSIX_PATH_RE =
  /(^|[^A-Za-z0-9/.])\/(?!\/|\s|(?:clear|config|cwd|doctor|help|history|invite|model|new|permissions|reasoning|reset|resume|session|status|stop|timeout)(?=$|\s|["'`,;:!?)}\]>*|~<>]|\.(?=$|\s)))[^\r\n/]+\/[^\r\n]*/gmu;
const LOCAL_SINGLE_POSIX_PATH_RE =
  /(^|[^A-Za-z0-9/.])\/(?!\/?(?:clear|config|cwd|doctor|help|history|invite|model|new|permissions|reasoning|reset|resume|session|status|stop|timeout)(?=$|\s|["'`,;:!?)}\]>*|~<>]|\.(?=$|\s)))[^\/\s]+[^\r\n]*/gmu;
const LOCAL_HOME_PATH_RE = /(^|[^A-Za-z0-9/.])~\/[^\r\n]*/gmu;
const LOCAL_WINDOWS_PATH_RE = /(^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*/gmu;

/** Translate ACP session notifications into the bridge's normalized event stream. */
export class KimiAcpEventTranslator {
  private readonly finishedToolCalls = new Set<string>();
  private readonly toolNames = new Map<string, string>();
  private readonly cwd: string;
  private readonly accessMode: AccessMode;
  private readonly now: () => number;
  private answerChunks: string[] = [];
  private answerBytes = 0;
  private answerOversized = false;
  private lastProgressAt = Number.NEGATIVE_INFINITY;

  constructor(opts: KimiAcpEventTranslatorOptions) {
    this.cwd = opts.cwd;
    this.accessMode = opts.accessMode ?? 'read-only';
    this.now = opts.now ?? Date.now;
  }

  translate(notification: SessionNotification): AgentEvent[] {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        // Do not sanitize individual streaming chunks. A provider can split an
        // absolute path across chunk boundaries (for example "/Us" +
        // "ers/alice/secret"), so buffer one complete answer and scrub it only
        // after session/prompt has finished.
        if (update.content.type !== 'text' || update.content.text.length === 0) return [];
        if (!this.answerOversized) {
          const chunkBytes = Buffer.byteLength(update.content.text, 'utf8');
          if (this.answerBytes + chunkBytes > KIMI_MAX_BUFFERED_ANSWER_BYTES) {
            this.answerChunks = [];
            this.answerBytes = 0;
            this.answerOversized = true;
          } else {
            this.answerChunks.push(update.content.text);
            this.answerBytes += chunkBytes;
          }
        }
        return this.maybeProgress();
      case 'agent_thought_chunk':
        // Reasoning is not part of the user answer and can contain raw local
        // paths or provider diagnostics. Keep it entirely out of group chat.
        return update.content.type === 'text' && update.content.text.length > 0
          ? this.maybeProgress()
          : [];
      case 'tool_call': {
        const name =
          this.accessMode === 'read-only' ? 'Read' : kimiToolName(update.kind);
        this.toolNames.set(update.toolCallId, name);
        const events: AgentEvent[] = [
          {
            type: 'tool_use',
            id: update.toolCallId,
            // Read is the only enabled Kimi pilot tool. Do not surface a
            // provider-supplied title because it can embed an absolute path.
            name,
            input:
              this.accessMode === 'read-only'
                ? sanitizeReadToolInput(update.rawInput, this.cwd)
                : sanitizeKimiToolInput(update.rawInput, this.cwd),
          },
        ];
        const result = this.toolResult(update.toolCallId, update.status);
        if (result) events.push(result);
        return events;
      }
      case 'tool_call_update': {
        const result = this.toolResult(update.toolCallId, update.status ?? undefined);
        return result ? [result] : [];
      }
      case 'usage_update':
        return update.cost?.currency.toUpperCase() === 'USD'
          ? [{ type: 'usage', costUsd: update.cost.amount }]
          : [];
      case 'user_message_chunk':
      case 'plan':
      case 'plan_update':
      case 'plan_removed':
      case 'available_commands_update':
      case 'current_mode_update':
      case 'config_option_update':
      case 'session_info_update':
        return [];
    }
  }

  flushAnswer(): AgentEvent[] {
    if (this.answerOversized) {
      this.answerOversized = false;
      return [{ type: 'text', delta: KIMI_OVERSIZED_ANSWER_MESSAGE }];
    }
    if (this.answerChunks.length === 0) return [];
    const answer = sanitizeKimiVisibleText(this.answerChunks.join(''), this.cwd);
    this.answerChunks = [];
    this.answerBytes = 0;
    return answer ? [{ type: 'text', delta: answer }] : [];
  }

  usage(usage: Usage | null | undefined): AgentEvent[] {
    if (!usage) return [];
    return [
      {
        type: 'usage',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cachedReadTokens != null
          ? { cachedInputTokens: usage.cachedReadTokens }
          : {}),
        ...(usage.thoughtTokens != null
          ? { reasoningOutputTokens: usage.thoughtTokens }
          : {}),
      },
    ];
  }

  private maybeProgress(): AgentEvent[] {
    const now = this.now();
    if (now - this.lastProgressAt < KIMI_PROGRESS_INTERVAL_MS) return [];
    this.lastProgressAt = now;
    return [{ type: 'progress' }];
  }

  private toolResult(
    id: string,
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | undefined,
  ): AgentEvent | undefined {
    if ((status !== 'completed' && status !== 'failed') || this.finishedToolCalls.has(id)) {
      return undefined;
    }
    this.finishedToolCalls.add(id);
    const toolName = this.toolNames.get(id) ?? 'Tool';
    return {
      type: 'tool_result',
      id,
      output:
        status === 'failed'
          ? `Kimi ${toolName} failed.`
          : `Kimi ${toolName} completed.`,
      isError: status === 'failed',
    };
  }
}

function kimiToolName(kind: string | undefined): string {
  switch (kind) {
    case 'read':
      return 'Read';
    case 'edit':
      return 'Edit';
    case 'delete':
      return 'Delete';
    case 'move':
      return 'Move';
    case 'search':
      return 'Search';
    case 'execute':
      return 'Bash';
    case 'think':
      return 'Think';
    case 'fetch':
      return 'Fetch';
    case 'switch_mode':
      return 'Mode';
    default:
      return 'Tool';
  }
}

function sanitizeKimiToolInput(value: unknown, cwd: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const key of [
    'path',
    'file_path',
    'command',
    'pattern',
    'query',
    'glob',
    'line',
    'limit',
  ]) {
    const item = input[key];
    if (typeof item === 'string') {
      sanitized[key] = key === 'path' || key === 'file_path'
        ? sanitizePathValue(item, cwd)
        : sanitizeKimiVisibleText(item, cwd);
    } else if (typeof item === 'number' && Number.isSafeInteger(item)) {
      sanitized[key] = item;
    }
  }
  return sanitized;
}

function sanitizeReadToolInput(value: unknown, cwd: string): unknown {
  if (typeof value === 'string') return { path: sanitizePathValue(value, cwd) };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  if (typeof input.path === 'string') sanitized.path = sanitizePathValue(input.path, cwd);
  for (const key of ['line', 'limit'] as const) {
    if (typeof input[key] === 'number' && Number.isSafeInteger(input[key])) {
      sanitized[key] = input[key];
    }
  }
  return sanitized;
}

function sanitizePathValue(value: string, cwd: string): string {
  if (isAbsolute(value)) {
    const within = relative(cwd, value);
    if (within === '') return '.';
    if (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within)) return within;
    return '[redacted]';
  }
  return sanitizeKimiVisibleText(value, cwd);
}

/**
 * Scrub every string that can reach a Kimi chat card.
 *
 * Workspace paths stay useful as relative paths. Other common host absolute
 * paths and credential-shaped diagnostics are removed. The caller must pass a
 * complete answer rather than individual streaming chunks.
 */
export function sanitizeKimiVisibleText(value: string, cwd: string): string {
  const normalizedSlashes = value.replaceAll('\\/', '/');
  const relativeWorkspacePaths = replaceWorkspaceRoot(normalizedSlashes, cwd);
  const withoutLocalPaths = relativeWorkspacePaths
    .replace(LOCAL_FILE_URI_RE, '[redacted]')
    .replace(LOCAL_REDUNDANT_SLASH_POSIX_PATH_RE, '$1[redacted]')
    .replace(LOCAL_POSIX_PATH_RE, '$1[redacted]')
    .replace(LOCAL_GENERIC_POSIX_PATH_RE, '$1[redacted]')
    .replace(LOCAL_SINGLE_POSIX_PATH_RE, '$1[redacted]')
    .replace(LOCAL_HOME_PATH_RE, '$1[redacted]')
    .replace(LOCAL_WINDOWS_PATH_RE, '$1[redacted]');
  return redactDiagnosticText(withoutLocalPaths).replaceAll(
    '[REDACTED_PATH]',
    '[redacted]',
  );
}

function replaceWorkspaceRoot(value: string, cwd: string): string {
  if (!cwd) return value;
  const escaped = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(
    new RegExp(`${escaped}(?=$|[\\/\\s"'\\x60,;:)}\\]])`, 'gu'),
    '.',
  );
}
