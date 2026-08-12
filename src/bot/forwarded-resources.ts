import type {
  ApiMessageItem,
  LarkChannel,
  ResourceDescriptor,
} from '@larksuite/channel';
import { log } from '../core/logger';
import type { ResourceRequest } from '../media/cache';

/**
 * Resource extraction for message trees the SDK normalizer flattens to text.
 *
 * Why this exists: the SDK's `convertMergeForward` renders sub-messages into
 * the `<forwarded_messages>` text block but returns `resources: []` — a file
 * inside a merged forward therefore reached the agent as a bare
 * `<file key="…"/>` reference with no bytes behind it, and the Kimi
 * text-only gate (which keys off `msg.resources`) was silently bypassed.
 *
 * `im.v1.message.get` on a merge_forward returns the parent followed by its
 * full descendant list as flat `ApiMessageItem`s, so we re-fetch the tree and
 * pair every resource with the *owning* sub-message id — that id is what
 * `im.v1.messageResource.get` (via MediaCache) needs to download the bytes.
 */

/** Mirror the SDK's merge_forward text cap so we never download attachments
 * the agent cannot see referenced in the `<forwarded_messages>` block. */
const MAX_FORWARDED_ITEMS = 50;

/** Upper bound on resources collected from one message tree. Matches the
 * default attachment policy's maxCount — anything beyond it would be
 * downloaded and then policy-rejected, pure waste (a 50-sub-message forward
 * of image-heavy posts would otherwise fan out into hundreds of sequential
 * downloads before any policy check runs). Callers with a configured
 * maxCount should pass it explicitly. */
const DEFAULT_MAX_RESOURCES = 10;

/** Cap the JSON deep-walk for post bodies — pathological cards/posts should
 * not turn resource extraction into unbounded recursion. */
const MAX_WALK_DEPTH = 24;

export interface ResourceCollectOptions {
  maxResources?: number;
}

/** Extract every downloadable resource a single API message item carries.
 * Handles the direct media types (file / image / audio / video / sticker)
 * plus `img` / `media` elements buried anywhere inside a rich-text `post`
 * body (locale wrapping included — we walk the tree rather than reproduce
 * the post schema). */
export function resourcesFromApiItem(item: ApiMessageItem): ResourceDescriptor[] {
  const msgType = item.msg_type ?? 'text';
  const raw = item.body?.content;
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const parsed = safeParse(raw);
  if (!parsed) return [];

  switch (msgType) {
    case 'file':
      return stringProp(parsed, 'file_key')
        ? [{
            type: 'file',
            fileKey: parsed.file_key as string,
            ...(stringProp(parsed, 'file_name')
              ? { fileName: parsed.file_name as string }
              : {}),
          }]
        : [];
    case 'image':
      return stringProp(parsed, 'image_key')
        ? [{ type: 'image', fileKey: parsed.image_key as string }]
        : [];
    case 'audio':
      return stringProp(parsed, 'file_key')
        ? [{
            type: 'audio',
            fileKey: parsed.file_key as string,
            ...(typeof parsed.duration === 'number'
              ? { durationMs: parsed.duration }
              : {}),
          }]
        : [];
    case 'video':
    case 'media':
      return stringProp(parsed, 'file_key')
        ? [{
            type: 'video',
            fileKey: parsed.file_key as string,
            ...(stringProp(parsed, 'file_name')
              ? { fileName: parsed.file_name as string }
              : {}),
            ...(typeof parsed.duration === 'number'
              ? { durationMs: parsed.duration }
              : {}),
            ...(stringProp(parsed, 'image_key')
              ? { coverImageKey: parsed.image_key as string }
              : {}),
          }]
        : [];
    case 'sticker':
      return stringProp(parsed, 'file_key')
        ? [{ type: 'sticker', fileKey: parsed.file_key as string }]
        : [];
    case 'post':
      return resourcesFromPostBody(parsed);
    default:
      return [];
  }
}

/**
 * Fetch a merge_forward tree and return every resource in it, each paired
 * with the sub-message id that owns the file. The parent container itself is
 * skipped (it carries no body resources). Failures degrade to an empty list:
 * the run then proceeds text-only, exactly as before this fix.
 */
export async function collectForwardedResources(
  channel: LarkChannel,
  rootMessageId: string,
  options: ResourceCollectOptions = {},
): Promise<ResourceRequest[]> {
  let items: ApiMessageItem[];
  try {
    items = await channel.fetchRawMessage(rootMessageId);
  } catch (err) {
    log.warn('media', 'forwarded-fetch-failed', {
      messageId: rootMessageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  return collectFromItems(
    items.filter((item) => item.message_id && item.message_id !== rootMessageId),
    options,
  );
}

/** Same extraction as {@link collectForwardedResources} but for an item list
 * the caller already fetched (quote path) — no extra API call. The parent is
 * included here: quoting a plain `file` message should surface its bytes too. */
export function resourcesFromFetchedItems(
  items: ApiMessageItem[],
  options: ResourceCollectOptions = {},
): ResourceRequest[] {
  return collectFromItems(
    items.filter((item) => item.message_id),
    options,
  );
}

/** Shared collector: walk items in order, dedupe by fileKey (the same file
 * re-forwarded in N sub-messages is one download, not N), and stop at
 * maxResources so a fat tree can't fan out into unbounded downloads before
 * the attachment policy gets a say. */
function collectFromItems(
  items: ApiMessageItem[],
  options: ResourceCollectOptions,
): ResourceRequest[] {
  const maxResources = options.maxResources ?? DEFAULT_MAX_RESOURCES;
  const seen = new Set<string>();
  const out: ResourceRequest[] = [];
  for (const item of items.slice(0, MAX_FORWARDED_ITEMS)) {
    if (out.length >= maxResources) break;
    for (const resource of resourcesFromApiItem(item)) {
      if (seen.has(resource.fileKey)) continue;
      seen.add(resource.fileKey);
      out.push({ messageId: item.message_id!, resource });
      if (out.length >= maxResources) break;
    }
  }
  return out;
}

function resourcesFromPostBody(root: Record<string, unknown>): ResourceDescriptor[] {
  const out: ResourceDescriptor[] = [];
  const seen = new Set<string>();
  const pushImage = (fileKey: string): void => {
    if (seen.has(fileKey)) return;
    seen.add(fileKey);
    out.push({ type: 'image', fileKey });
  };
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.tag === 'img' && stringProp(record, 'image_key')) {
      pushImage(record.image_key as string);
    } else if (record.tag === 'media' && stringProp(record, 'file_key')) {
      const fileKey = record.file_key as string;
      if (!seen.has(fileKey)) {
        seen.add(fileKey);
        out.push({
          type: 'file',
          fileKey,
          ...(stringProp(record, 'file_name')
            ? { fileName: record.file_name as string }
            : {}),
        });
      }
    } else if (record.tag === 'md' && typeof record.text === 'string') {
      // Inline markdown images carry their keys in the text, not as fields —
      // same shape the SDK's post converter extracts from md elements.
      for (const match of record.text.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
        if (match[1]) pushImage(match[1]);
      }
    }
    for (const value of Object.values(record)) {
      if (value !== null && typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function stringProp(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string' && (record[key] as string).length > 0;
}

function safeParse(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
