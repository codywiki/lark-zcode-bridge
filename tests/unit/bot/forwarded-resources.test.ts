import type { ApiMessageItem, LarkChannel } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import {
  collectForwardedResources,
  resourcesFromApiItem,
  resourcesFromFetchedItems,
} from '../../../src/bot/forwarded-resources.js';

describe('resourcesFromApiItem', () => {
  it('extracts a file resource with its original name', () => {
    const item = apiItem('om_1', 'file', {
      file_key: 'file_v3_abc',
      file_name: 'aifuye-demo.html',
    });
    expect(resourcesFromApiItem(item)).toEqual([
      { type: 'file', fileKey: 'file_v3_abc', fileName: 'aifuye-demo.html' },
    ]);
  });

  it('extracts image / audio / video / sticker resources', () => {
    expect(resourcesFromApiItem(apiItem('om_1', 'image', { image_key: 'img_v3_1' }))).toEqual([
      { type: 'image', fileKey: 'img_v3_1' },
    ]);
    expect(
      resourcesFromApiItem(apiItem('om_1', 'audio', { file_key: 'aud_1', duration: 1200 })),
    ).toEqual([{ type: 'audio', fileKey: 'aud_1', durationMs: 1200 }]);
    expect(
      resourcesFromApiItem(
        apiItem('om_1', 'video', {
          file_key: 'vid_1',
          file_name: 'clip.mp4',
          duration: 3000,
          image_key: 'cover_1',
        }),
      ),
    ).toEqual([
      {
        type: 'video',
        fileKey: 'vid_1',
        fileName: 'clip.mp4',
        durationMs: 3000,
        coverImageKey: 'cover_1',
      },
    ]);
    // Legacy msg_type for video.
    expect(resourcesFromApiItem(apiItem('om_1', 'media', { file_key: 'vid_2' }))).toEqual([
      { type: 'video', fileKey: 'vid_2' },
    ]);
    expect(resourcesFromApiItem(apiItem('om_1', 'sticker', { file_key: 'stk_1' }))).toEqual([
      { type: 'sticker', fileKey: 'stk_1' },
    ]);
  });

  it('walks post bodies for img/media elements, locale wrapping included', () => {
    const item = apiItem('om_1', 'post', {
      zh_cn: {
        title: 'demo',
        content: [
          [
            { tag: 'text', text: 'see ' },
            { tag: 'img', image_key: 'img_in_post' },
          ],
          [{ tag: 'media', file_key: 'file_in_post', file_name: 'spec.pdf' }],
          // Duplicate keys collapse.
          [{ tag: 'img', image_key: 'img_in_post' }],
          // Inline-markdown elements carry image keys in the text itself.
          [{ tag: 'md', text: 'shot ![demo](img_md_key) and ![](img_md_key)' }],
        ],
      },
    });
    expect(resourcesFromApiItem(item)).toEqual([
      { type: 'image', fileKey: 'img_in_post' },
      { type: 'file', fileKey: 'file_in_post', fileName: 'spec.pdf' },
      { type: 'image', fileKey: 'img_md_key' },
    ]);
  });

  it('returns nothing for text, merge_forward containers, and broken bodies', () => {
    expect(resourcesFromApiItem(apiItem('om_1', 'text', { text: 'hi' }))).toEqual([]);
    expect(resourcesFromApiItem(apiItem('om_1', 'merge_forward', {}))).toEqual([]);
    expect(resourcesFromApiItem({ message_id: 'om_1', msg_type: 'file' })).toEqual([]);
    expect(
      resourcesFromApiItem({ message_id: 'om_1', msg_type: 'file', body: { content: '{oops' } }),
    ).toEqual([]);
    expect(resourcesFromApiItem(apiItem('om_1', 'file', { file_name: 'no-key.bin' }))).toEqual([]);
  });
});

describe('collectForwardedResources', () => {
  it('pairs each sub-message resource with the owning sub-message id', async () => {
    const channel = fakeChannel([
      apiItem('om_root', 'merge_forward', {}),
      apiItem('om_sub_1', 'text', { text: 'look at this' }),
      apiItem('om_sub_2', 'file', { file_key: 'file_v3_html', file_name: 'aifuye-demo.html' }),
      apiItem('om_sub_3', 'image', { image_key: 'img_v3_shot' }),
    ]);

    const out = await collectForwardedResources(channel, 'om_root');

    expect(out).toEqual([
      {
        messageId: 'om_sub_2',
        resource: { type: 'file', fileKey: 'file_v3_html', fileName: 'aifuye-demo.html' },
      },
      { messageId: 'om_sub_3', resource: { type: 'image', fileKey: 'img_v3_shot' } },
    ]);
  });

  it('caps collected resources so a fat tree cannot fan out into unbounded downloads', async () => {
    const items = [apiItem('om_root', 'merge_forward', {})];
    for (let i = 1; i <= 60; i++) {
      items.push(apiItem(`om_sub_${i}`, 'file', { file_key: `key_${i}` }));
    }
    const out = await collectForwardedResources(fakeChannel(items), 'om_root');
    // Default cap mirrors the attachment policy's maxCount — anything beyond
    // would be downloaded and then policy-rejected anyway.
    expect(out).toHaveLength(10);
    expect(out.at(-1)).toMatchObject({ messageId: 'om_sub_10' });

    const raised = await collectForwardedResources(fakeChannel(items), 'om_root', {
      maxResources: 49,
    });
    // 50-item slice (parent included) leaves 49 sub-resources.
    expect(raised).toHaveLength(49);
  });

  it('dedupes the same file re-forwarded in multiple sub-messages', async () => {
    const items = [
      apiItem('om_root', 'merge_forward', {}),
      apiItem('om_sub_1', 'file', { file_key: 'same_key', file_name: 'a.html' }),
      apiItem('om_sub_2', 'file', { file_key: 'same_key', file_name: 'a.html' }),
      apiItem('om_sub_3', 'image', { image_key: 'other_key' }),
    ];
    const out = await collectForwardedResources(fakeChannel(items), 'om_root');
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.resource.fileKey)).toEqual(['same_key', 'other_key']);
  });

  it('degrades to an empty list when the fetch fails', async () => {
    const channel = {
      async fetchRawMessage(): Promise<ApiMessageItem[]> {
        throw new Error('boom');
      },
    } as unknown as LarkChannel;
    await expect(collectForwardedResources(channel, 'om_root')).resolves.toEqual([]);
  });
});

describe('resourcesFromFetchedItems', () => {
  it('includes the parent item (quoted plain file message)', () => {
    const out = resourcesFromFetchedItems([
      apiItem('om_parent', 'file', { file_key: 'k', file_name: 'report.pdf' }),
    ]);
    expect(out).toEqual([
      { messageId: 'om_parent', resource: { type: 'file', fileKey: 'k', fileName: 'report.pdf' } },
    ]);
  });
});

function apiItem(messageId: string, msgType: string, content: unknown): ApiMessageItem {
  return {
    message_id: messageId,
    msg_type: msgType,
    body: { content: JSON.stringify(content) },
    create_time: '1760000000000',
    sender: { id: 'ou_sender' },
  };
}

function fakeChannel(items: ApiMessageItem[]): LarkChannel {
  return {
    async fetchRawMessage(): Promise<ApiMessageItem[]> {
      return items;
    },
  } as unknown as LarkChannel;
}
