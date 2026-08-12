import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureLogger,
  closeLogger,
  flushLogger,
  log,
  sanitizeLogsForDoctor,
} from '../../../src/core/logger.js';

let logsDir = '';

describe('logger redaction', () => {
  beforeEach(async () => {
    logsDir = await mkdtemp(join(tmpdir(), 'logger-redaction-'));
    configureLogger({
      logsDir,
      now: () => new Date('2026-05-25T12:00:00.000Z'),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeLogger();
    await rm(logsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  });

  it('redacts sensitive substrings inside arbitrary string fields before writing logs', async () => {
    log.warn('agent', 'stderr', {
      line:
        'Authorization: Bearer secret-token-123 ' +
        'url=https://open.feishu.cn/open-apis?a=1&tenant_access_token=t-tenant-secret ' +
        'cwd=/Users/example/private/project',
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('secret-token-123');
    expect(text).not.toContain('t-tenant-secret');
    expect(text).not.toContain('/Users/example/private/project');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('[REDACTED_PATH]');
  });

  it('redacts nested sdk args after stringify-style recursion', async () => {
    log.warn('sdk', 'error', {
      args: [
        'POST https://open.feishu.cn/open-apis/drive?access_token=drive-token',
        {
          headers: { authorization: 'Bearer nested-token' },
          body: { file_token: 'doc-token-secret' },
          path: '/tmp/lark-channel/secret/file.txt',
        },
      ],
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('drive-token');
    expect(text).not.toContain('nested-token');
    expect(text).not.toContain('doc-token-secret');
    expect(text).not.toContain('/tmp/lark-channel/secret/file.txt');
  });

  it('records circular SDK response data without crashing or leaking credentials', async () => {
    const apiData: Record<string, unknown> = {
      code: 400,
      token: 'nested-secret-token',
    };
    apiData.socket = apiData;
    const err = Object.assign(new Error('resource download failed'), {
      response: { status: 400, data: apiData },
    });

    expect(() => log.fail('media', err, { fileKey: 'file_v3_secret' })).not.toThrow();
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('nested-secret-token');
    expect(text).not.toContain('file_v3_secret');
    expect(JSON.parse(text.trim())).toMatchObject({
      phase: 'media',
      event: 'fail',
      apiStatus: 400,
      apiData: {
        code: 400,
        token: '[REDACTED]',
        socket: '[Circular]',
      },
    });
  });

  it('isolates an SDK response getter that throws while preserving safe fields', async () => {
    const apiData: Record<string, unknown> = {
      code: 400,
      token: 'getter-secret-token',
    };
    Object.defineProperty(apiData, 'socket', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });
    const err = Object.assign(new Error('resource download failed'), {
      response: { status: 400, data: apiData },
    });

    expect(() => log.fail('media', err)).not.toThrow();
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('getter-secret-token');
    expect(text).not.toContain('getter exploded');
    expect(JSON.parse(text.trim())).toMatchObject({
      apiData: {
        code: 400,
        token: '[REDACTED]',
        socket: '[Unserializable]',
      },
    });
  });

  it('bounds deeply nested SDK response data before the call stack is exhausted', async () => {
    let apiData: Record<string, unknown> = { token: 'deep-secret-token' };
    for (let depth = 0; depth < 10_000; depth++) {
      apiData = { child: apiData };
    }
    const err = Object.assign(new Error('resource download failed'), {
      response: { status: 400, data: apiData },
    });

    expect(() => log.fail('media', err)).not.toThrow();
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('deep-secret-token');
    expect(text).toContain('[MaxDepth]');
  });

  it('redacts credentials inside stringified JSON sdk args', async () => {
    log.warn('sdk', 'error', {
      args: [
        '{"app_secret":"json-secret","tenant_access_token":"tenant-secret","token":"plain-token"}',
        '{\\"app_secret\\":\\"escaped-secret\\",\\"authorization\\":\\"Bearer escaped-token\\"}',
      ],
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('json-secret');
    expect(text).not.toContain('tenant-secret');
    expect(text).not.toContain('plain-token');
    expect(text).not.toContain('escaped-secret');
    expect(text).not.toContain('escaped-token');
  });

  it('redacts Lark resource keys and attachment tags from arbitrary previews', async () => {
    log.info('intake', 'enter', {
      preview:
        'please read <file key="file_v2_abc123rawsecret" name="secret.pdf" /> and ' +
        '{"fileKey":"file_v2_jsonrawsecret","sourceFileKey":"file_v2_sourcerawsecret"}',
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('file_v2_abc123rawsecret');
    expect(text).not.toContain('file_v2_jsonrawsecret');
    expect(text).not.toContain('file_v2_sourcerawsecret');
    expect(text).toContain('[REDACTED_RESOURCE]');
  });

  it('redacts home-relative local paths inside arbitrary strings', async () => {
    log.warn('agent', 'stderr', {
      line: 'artifact saved to ~/.lark-channel/profiles/claude/media/private.bin',
    });
    await flushLogger();

    const text = await readTodayLog();
    expect(text).not.toContain('~/.lark-channel/profiles/claude/media/private.bin');
    expect(text).toContain('[REDACTED_PATH]');
  });

  it('sanitizes doctor log buffers with stderr urls and absolute paths', () => {
    const out = sanitizeLogsForDoctor(
      '{"stderr":"failed /Users/example/work/repo?app_access_token=app-secret","cwd":"/opt/private/repo","authorization":"Bearer raw-token"}',
    );

    expect(out).not.toContain('/Users/example/work/repo');
    expect(out).not.toContain('/opt/private/repo');
    expect(out).not.toContain('app-secret');
    expect(out).not.toContain('raw-token');
    expect(out).toContain('[REDACTED]');
  });

  it('sanitizes stringified JSON credentials in doctor log buffers', () => {
    const out = sanitizeLogsForDoctor(
      '{"args":["{\\"app_secret\\":\\"doctor-secret\\",\\"token\\":\\"doctor-token\\"}"]}',
    );

    expect(out).not.toContain('doctor-secret');
    expect(out).not.toContain('doctor-token');
    expect(out).toContain('[REDACTED]');
  });
});

async function readTodayLog(): Promise<string> {
  return readFile(join(logsDir, 'bridge-20260525.jsonl'), 'utf8');
}
