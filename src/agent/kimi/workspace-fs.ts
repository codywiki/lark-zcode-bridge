import { constants, realpathSync, statSync } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import {
  RequestError,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/**
 * AcpKaos currently fetches a whole text file for both preview and line reads.
 * Keep that unavoidable buffering bounded below the model/tool output limits.
 */
export const KIMI_MAX_TEXT_FILE_BYTES = 1024 * 1024;

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.envrc',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '_netrc',
  'credentials',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);
const SENSITIVE_DIRECTORIES = new Set([
  '.aws',
  '.azure',
  '.git',
  '.gcp',
  '.gnupg',
  '.hg',
  '.kube',
  '.ssh',
  '.svn',
]);
const ENV_EXEMPTIONS = new Set(['.env.example', '.env.sample', '.env.template']);
const PUBLIC_KEY_EXEMPTIONS = new Set(['id_ecdsa.pub', 'id_ed25519.pub', 'id_rsa.pub']);
const SENSITIVE_PREFIXES = ['credentials', 'id_ecdsa', 'id_ed25519', 'id_rsa'] as const;
const SENSITIVE_VARIANT_SUFFIXES = new Set([
  '.bak',
  '.backup',
  '.copy',
  '.disabled',
  '.key',
  '.old',
  '.orig',
  '.pem',
  '.save',
  '.tmp',
]);
const PRIVATE_KEY_SUFFIXES = ['.key', '.p12', '.pem', '.pfx'] as const;

export interface KimiWorkspaceFsOptions {
  cwd: string;
  /** Runtime/profile directories that must stay invisible even if nested in cwd. */
  deniedRoots?: readonly string[];
  maxBytes?: number;
  /** Allow ACP text writes inside cwd. Defaults to read-only. */
  writable?: boolean;
  /** Remove cwd, denied-root, and sensitive-path bounds for explicit full access. */
  unrestricted?: boolean;
}

/**
 * Client-side ACP filesystem boundary for one Kimi process/run.
 *
 * New Kimi sessions mint their ID inside `session/new` and may issue reverse
 * reads before returning it. The first request therefore claims a provisional
 * ID; `bindSessionId` verifies that the server later returned the same value.
 */
export class KimiWorkspaceFs {
  private readonly workspacePath: string;
  private readonly workspaceRoot: string;
  private readonly deniedRoots: readonly string[];
  private readonly maxBytes: number;
  private readonly writable: boolean;
  private readonly unrestricted: boolean;
  private claimedSessionId: string | undefined;
  private boundSessionId: string | undefined;

  constructor(options: KimiWorkspaceFsOptions) {
    this.workspacePath = resolve(options.cwd);
    this.workspaceRoot = canonicalDirectory(this.workspacePath, 'Kimi workspace');
    this.deniedRoots = (options.deniedRoots ?? []).map((path) =>
      canonicalDirectory(path, 'Kimi denied runtime root'),
    );
    this.maxBytes = options.maxBytes ?? KIMI_MAX_TEXT_FILE_BYTES;
    this.writable = options.writable ?? false;
    this.unrestricted = options.unrestricted ?? false;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error('Kimi ACP text file limit must be a positive safe integer');
    }
  }

  bindSessionId(sessionId: string): void {
    assertValidSessionId(sessionId);
    if (this.claimedSessionId !== undefined && this.claimedSessionId !== sessionId) {
      throw new Error('Kimi ACP session/new returned a different sessionId than its file request');
    }
    if (this.boundSessionId !== undefined && this.boundSessionId !== sessionId) {
      throw new Error('Kimi ACP attempted to replace the bound filesystem sessionId');
    }
    this.claimedSessionId = sessionId;
    this.boundSessionId = sessionId;
  }

  async readTextFile(request: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    try {
      this.assertAndClaimSession(request.sessionId);
      const target = await this.resolveReadableTarget(request.path);
      const bytes = await readBoundedRegularFile(target, this.maxBytes);
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw deniedRequest('Kimi ACP refused a file that is not valid UTF-8 text');
      }
      return { content: selectLines(content, request.line, request.limit) };
    } catch (err) {
      // ACP SDK 0.23 logs the whole rejected request with console.error.
      // Redact the same params object in place before the rejection reaches
      // the SDK so absolute paths and session identifiers never hit stderr.
      redactRejectedFsRequest(request);
      throw err;
    }
  }

  async writeTextFile(request: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    try {
      this.assertAndClaimSession(request.sessionId);
      if (!this.writable) throw deniedRequest('Kimi ACP filesystem writes are disabled');
      if (typeof request.content !== 'string') {
        throw deniedRequest('Kimi ACP can only write UTF-8 text');
      }
      const target = await this.resolveWritableTarget(request.path);
      await writeRegularTextFile(target, request.content);
      return {};
    } catch (err) {
      redactRejectedFsRequest(request);
      throw err;
    }
  }

  private assertAndClaimSession(sessionId: string): void {
    assertValidSessionId(sessionId);
    const expected = this.boundSessionId ?? this.claimedSessionId;
    if (expected !== undefined && expected !== sessionId) {
      throw deniedRequest('Kimi ACP filesystem request used the wrong sessionId');
    }
    this.claimedSessionId ??= sessionId;
  }

  private async resolveReadableTarget(path: string): Promise<string> {
    if (!isAbsolute(path) || path.includes('\0')) {
      throw deniedRequest('Kimi ACP file reads require an absolute path');
    }

    let target: string;
    try {
      target = await realpath(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw RequestError.resourceNotFound('[redacted]');
      }
      throw deniedRequest('Kimi ACP could not resolve the requested file');
    }

    if (this.unrestricted) return target;
    if (!containsPath(this.workspaceRoot, target)) {
      throw deniedRequest('Kimi ACP refused a file outside the configured workspace');
    }
    if (this.deniedRoots.some((root) => containsPath(root, target))) {
      throw deniedRequest('Kimi ACP refused a bridge runtime or credential path');
    }
    if (isSensitivePath(relative(this.workspaceRoot, target))) {
      throw deniedRequest('Kimi ACP refused a sensitive file path');
    }
    return target;
  }

  private async resolveWritableTarget(path: string): Promise<string> {
    if (!isAbsolute(path) || path.includes('\0')) {
      throw deniedRequest('Kimi ACP file writes require an absolute path');
    }

    const lexicalTarget = resolve(path);
    const workspaceBase = this.unrestricted
      ? parse(lexicalTarget).root
      : containsPath(this.workspacePath, lexicalTarget)
        ? this.workspacePath
        : containsPath(this.workspaceRoot, lexicalTarget)
          ? this.workspaceRoot
          : undefined;
    if (workspaceBase === undefined) {
      throw deniedRequest('Kimi ACP refused a file outside the configured workspace');
    }
    const workspaceRelativeTarget = relative(workspaceBase, lexicalTarget);
    if (!this.unrestricted && isSensitivePath(workspaceRelativeTarget)) {
      throw deniedRequest('Kimi ACP refused a sensitive file path');
    }
    if (workspaceRelativeTarget === '') {
      throw deniedRequest('Kimi ACP can only write regular files');
    }

    const parts = workspaceRelativeTarget.split(sep);
    const filename = parts.pop();
    if (!filename) throw deniedRequest('Kimi ACP could not resolve the write target');

    // Resolve each existing component before creating the next one. This keeps
    // an in-workspace directory symlink usable while preventing mkdir from
    // following a parent symlink that escapes the workspace.
    let parent = this.unrestricted ? workspaceBase : this.workspaceRoot;
    for (const part of parts) {
      const candidate = resolve(parent, part);
      await ensureDirectory(candidate);
      try {
        parent = await realpath(candidate);
        const info = await stat(parent);
        if (!info.isDirectory()) {
          throw deniedRequest('Kimi ACP write parent is not a directory');
        }
      } catch (err) {
        if (err instanceof RequestError) throw err;
        throw deniedRequest('Kimi ACP could not resolve a write parent safely');
      }
      this.assertWritablePathAllowed(parent);
    }

    const target = resolve(parent, filename);
    this.assertWritablePathAllowed(target);
    return target;
  }

  private assertWritablePathAllowed(path: string): void {
    if (this.unrestricted) return;
    if (!containsPath(this.workspaceRoot, path)) {
      throw deniedRequest('Kimi ACP refused a file outside the configured workspace');
    }
    if (this.deniedRoots.some((root) => containsPath(root, path))) {
      throw deniedRequest('Kimi ACP refused a bridge runtime or credential path');
    }
    if (isSensitivePath(relative(this.workspaceRoot, path))) {
      throw deniedRequest('Kimi ACP refused a sensitive file path');
    }
  }
}

function canonicalDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  try {
    const canonical = realpathSync(absolute);
    const info = statSync(canonical);
    if (!info.isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch (err) {
    throw new Error(`${label} is not a readable directory: ${absolute}`, { cause: err });
  }
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Uint8Array> {
  let before;
  try {
    before = await stat(path);
  } catch {
    throw deniedRequest('Kimi ACP could not inspect the requested file');
  }
  if (!before.isFile()) throw deniedRequest('Kimi ACP can only read regular files');
  if (before.size > maxBytes) throw deniedRequest('Kimi ACP refused an oversized text file');

  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const nonBlock = 'O_NONBLOCK' in constants ? constants.O_NONBLOCK : 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
  } catch {
    throw deniedRequest('Kimi ACP could not open the requested file safely');
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw deniedRequest('Kimi ACP can only read regular files');
    if (opened.size > maxBytes) throw deniedRequest('Kimi ACP refused an oversized text file');

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, offset, maxBytes + 1 - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw deniedRequest('Kimi ACP refused an oversized text file');
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function ensureDirectory(path: string): Promise<void> {
  let existing;
  try {
    existing = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw deniedRequest('Kimi ACP could not inspect a write parent safely');
    }
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) return;
    if (!existing.isDirectory()) throw deniedRequest('Kimi ACP write parent is not a directory');
    return;
  }

  try {
    await mkdir(path);
  } catch (err) {
    // Another process may have created this component after the lstat. Inspect
    // it below instead of treating the harmless race as a failed write.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw deniedRequest('Kimi ACP could not create a write parent safely');
    }
  }

  let info;
  try {
    info = await lstat(path);
  } catch {
    throw deniedRequest('Kimi ACP could not inspect a write parent safely');
  }
  if (!info.isDirectory() && !info.isSymbolicLink()) {
    throw deniedRequest('Kimi ACP write parent is not a directory');
  }
}

async function writeRegularTextFile(path: string, content: string): Promise<void> {
  let before;
  try {
    before = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw deniedRequest('Kimi ACP could not inspect the write target safely');
    }
  }
  if (before !== undefined) {
    if (before.isSymbolicLink()) {
      throw deniedRequest('Kimi ACP refused a symlink write target');
    }
    if (!before.isFile()) throw deniedRequest('Kimi ACP can only write regular files');
  }

  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const nonBlock = 'O_NONBLOCK' in constants ? constants.O_NONBLOCK : 0;
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | noFollow | nonBlock, 0o666);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw deniedRequest('Kimi ACP refused a symlink write target');
    }
    throw deniedRequest('Kimi ACP could not open the write target safely');
  }

  let failure: unknown;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw deniedRequest('Kimi ACP can only write regular files');

    const current = await lstat(path);
    if (current.isSymbolicLink()) throw deniedRequest('Kimi ACP refused a symlink write target');
    if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw deniedRequest('Kimi ACP write target changed while it was being opened');
    }

    // Do not truncate until the no-follow handle has been verified as a file.
    await handle.truncate(0);
    await handle.writeFile(content, { encoding: 'utf8' });
  } catch (err) {
    failure =
      err instanceof RequestError
        ? err
        : deniedRequest('Kimi ACP could not write the target safely');
  }
  try {
    await handle.close();
  } catch {
    failure ??= deniedRequest('Kimi ACP could not close the write target safely');
  }
  if (failure !== undefined) throw failure;
}

function selectLines(content: string, line: number | null | undefined, limit: number | null | undefined): string {
  if (line === undefined && limit === undefined) return content;
  const startLine = line ?? 1;
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw deniedRequest('Kimi ACP read line must be a positive integer');
  }
  if (limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw deniedRequest('Kimi ACP read limit must be a non-negative integer');
  }
  if (limit === 0) return '';

  const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const end = limit === undefined || limit === null ? undefined : startLine - 1 + limit;
  return lines.slice(startLine - 1, end).join('');
}

function isSensitivePath(workspaceRelativePath: string): boolean {
  const parts = workspaceRelativePath
    .split(sep)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  if (parts.some((part) => SENSITIVE_DIRECTORIES.has(part))) return true;

  const name = parts.at(-1) ?? '';
  if (ENV_EXEMPTIONS.has(name) || PUBLIC_KEY_EXEMPTIONS.has(name)) return false;
  if (SENSITIVE_BASENAMES.has(name) || name.startsWith('.env.')) return true;
  if (PRIVATE_KEY_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (/^(?:credentials?|secrets?|tokens?)(?:\.(?:json|toml|ya?ml))?$/u.test(name)) return true;
  for (const prefix of SENSITIVE_PREFIXES) {
    if (!name.startsWith(prefix) || name.length === prefix.length) continue;
    const suffix = name.slice(prefix.length);
    if (suffix.startsWith('-') || suffix.startsWith('_')) return true;
    if (SENSITIVE_VARIANT_SUFFIXES.has(suffix)) return true;
  }
  return false;
}

function containsPath(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return (
    fromParent === '' ||
    (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  );
}

function assertValidSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
    throw deniedRequest('Kimi ACP filesystem request has an invalid sessionId');
  }
}

function deniedRequest(message: string): RequestError {
  return RequestError.invalidParams(undefined, message);
}

function redactRejectedFsRequest(
  request: ReadTextFileRequest | WriteTextFileRequest,
): void {
  const mutable = request as {
    sessionId: string;
    path: string;
    content?: string;
  };
  mutable.sessionId = '[redacted]';
  mutable.path = '[redacted]';
  if ('content' in mutable) mutable.content = '[redacted]';
}
