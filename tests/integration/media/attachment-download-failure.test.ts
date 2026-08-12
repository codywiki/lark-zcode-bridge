import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeLogger } from '../../../src/core/logger.js';
import { MediaCache } from '../../../src/media/cache.js';

const cleanups: Array<() => Promise<void>> = [];

describe('media attachment download failures', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeLogger();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('skips a failed attachment when the SDK error contains circular response data', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), 'attachment-failure-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const responseData: Record<string, unknown> = { code: 400 };
    responseData.socket = responseData;
    const downloadError = Object.assign(new Error('resource download failed'), {
      response: { status: 400, data: responseData },
    });
    const channel = {
      async downloadResourceToFile(): Promise<never> {
        throw downloadError;
      },
    };
    const cache = new MediaCache(channel as never, root);

    await expect(
      cache.resolve([
        {
          messageId: 'om_forwarded_child',
          resource: { type: 'file', fileKey: 'file_v3_unavailable' },
        },
      ]),
    ).resolves.toEqual([]);
  });

  it('continues resolving later attachments after one circular SDK error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), 'attachment-partial-failure-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const responseData: Record<string, unknown> = { code: 400 };
    responseData.socket = responseData;
    const downloadError = Object.assign(new Error('resource download failed'), {
      response: { status: 400, data: responseData },
    });
    const channel = {
      async downloadResourceToFile(
        _messageId: string,
        fileKey: string,
        _type: string,
        destPath: string,
      ) {
        if (fileKey === 'file_v3_unavailable') throw downloadError;
        await writeFile(destPath, 'available');
        return { contentType: 'text/plain', bytesWritten: 9 };
      },
    };
    const cache = new MediaCache(channel as never, root);

    const attachments = await cache.resolve([
      {
        messageId: 'om_forwarded_failed',
        resource: { type: 'file', fileKey: 'file_v3_unavailable' },
      },
      {
        messageId: 'om_forwarded_available',
        resource: { type: 'file', fileKey: 'file_v3_available', fileName: 'notes.txt' },
      },
    ]);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      originalName: 'notes.txt',
      sourceMessageId: 'om_forwarded_available',
      sourceFileKey: 'file_v3_available',
      decision: 'accepted',
    });
  });
});
