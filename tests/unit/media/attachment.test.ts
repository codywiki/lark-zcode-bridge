import { describe, expect, it } from 'vitest';
import {
  extensionFromFileName,
  normalizeAttachments,
  safeExtensionForMime,
  toPromptAttachment,
  type AttachmentCandidate,
} from '../../../src/media/attachment.js';

describe('attachment policy normalization', () => {
  it('accepts allowed images and ordinary files with hash paths', () => {
    const out = normalizeAttachments([
      candidate({ kind: 'image', mime: 'image/png', hash: 'abc', absPath: '/media/abc.png' }),
      candidate({ kind: 'file', mime: 'application/zip', hash: 'def', absPath: '/media/def.zip' }),
    ]);

    expect(out).toMatchObject([
      {
        kind: 'image',
        absPath: '/media/abc.png',
        path: '/media/abc.png',
        mime: 'image/png',
        hash: 'abc',
        decision: 'accepted',
        requiredness: 'optional',
      },
      {
        kind: 'file',
        absPath: '/media/def.zip',
        decision: 'accepted',
      },
    ]);
  });

  it('rejects SVG and unknown images while skipping sticker/audio/video by default', () => {
    const out = normalizeAttachments([
      candidate({ kind: 'image', mime: 'image/svg+xml', hash: 'svg' }),
      candidate({ kind: 'image', mime: 'application/octet-stream', hash: 'unknown' }),
      candidate({ kind: 'sticker', mime: 'image/webp', hash: 'sticker' }),
      candidate({ kind: 'audio', mime: 'audio/ogg', hash: 'audio' }),
      candidate({ kind: 'video', mime: 'video/mp4', hash: 'video' }),
    ]);

    expect(out.map((item) => [item.kind, item.decision, item.rejectionReason])).toEqual([
      ['image', 'rejected', 'unsupported-image-mime'],
      ['image', 'rejected', 'unsupported-image-mime'],
      ['sticker', 'skipped', 'sticker'],
      ['audio', 'skipped', 'unsupported-kind'],
      ['video', 'skipped', 'unsupported-kind'],
    ]);
  });

  it('enforces max count, per-file bytes, run bytes, and image bytes', () => {
    const out = normalizeAttachments(
      [
        candidate({ hash: '1', size: 5 }),
        candidate({ kind: 'file', mime: 'text/plain', hash: '2', size: 5 }),
        candidate({ kind: 'file', mime: 'text/plain', hash: '3', size: 5 }),
        candidate({ kind: 'file', mime: 'text/plain', hash: '4', size: 1 }),
        candidate({ kind: 'file', mime: 'text/plain', hash: '5', size: 1 }),
      ],
      {
        maxCount: 3,
        maxBytes: 12,
        maxFileBytes: 10,
        imageMaxBytes: 4,
      },
    );

    expect(out.map((item) => item.decision)).toEqual([
      'rejected',
      'accepted',
      'accepted',
      'accepted',
      'rejected',
    ]);
    expect(out.map((item) => item.rejectionReason ?? '')).toEqual([
      'image-too-large',
      '',
      '',
      '',
      'too-many-attachments',
    ]);
  });

  it('recovers a conservative extension from filenames only as a bin fallback', () => {
    expect(extensionFromFileName('aifuye-demo.html')).toBe('html');
    expect(extensionFromFileName('季度报告.docx')).toBe('docx');
    expect(extensionFromFileName('archive.TAR.GZ')).toBe('gz');
    expect(extensionFromFileName('no-extension')).toBeUndefined();
    expect(extensionFromFileName('trailing.')).toBeUndefined();
    expect(extensionFromFileName('../../etc/passwd')).toBeUndefined();
    expect(extensionFromFileName('weird name!.exe ')).toBe('exe');
    // Way over the 10-char cap — not an extension.
    expect(extensionFromFileName('x.superlongextension')).toBeUndefined();
  });

  it('passes the original filename through to prompt attachments', () => {
    const [normalized] = normalizeAttachments([
      candidate({ kind: 'file', mime: 'text/html', hash: 'h1', originalName: 'aifuye-demo.html' }),
    ]);
    const prompt = toPromptAttachment(normalized!);
    expect(prompt.originalName).toBe('aifuye-demo.html');
    // The on-disk path still carries no trace of the original name.
    expect(prompt.path).not.toContain('aifuye');
  });

  it('uses MIME-derived safe extensions and never original names', () => {
    expect(safeExtensionForMime('image/jpeg')).toBe('jpg');
    expect(safeExtensionForMime('image/png')).toBe('png');
    expect(safeExtensionForMime('image/webp')).toBe('webp');
    expect(safeExtensionForMime('image/gif')).toBe('gif');
    expect(safeExtensionForMime('application/zip')).toBe('zip');
    expect(safeExtensionForMime('application/x-sh')).toBe('bin');
  });
});

function candidate(overrides: Partial<AttachmentCandidate> = {}): AttachmentCandidate {
  return {
    absPath: overrides.absPath ?? `/media/${overrides.hash ?? 'hash'}.png`,
    kind: overrides.kind ?? 'image',
    size: overrides.size ?? 100,
    mime: overrides.mime ?? 'image/png',
    hash: overrides.hash ?? 'hash',
    source: 'lark',
    sourceMessageId: 'om_1',
    sourceFileKey: 'file_key',
    originalName: overrides.originalName ?? 'secret original name.png',
  };
}
