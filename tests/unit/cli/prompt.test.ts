import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { promptPassword } from '../../../src/cli/prompt';

describe('promptPassword', () => {
  it('forces raw mode for TTY input and never writes the secret', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode: (mode: boolean) => unknown;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = vi.fn((mode: boolean) => {
      input.isRaw = mode;
      return input;
    });

    const output = new PassThrough();
    output.setEncoding('utf8');
    let visible = '';
    output.on('data', (chunk: string) => {
      visible += chunk;
    });

    const answer = promptPassword('App Secret: ', { input, output });
    input.end('do-not-echo-this\n');

    await expect(answer).resolves.toBe('do-not-echo-this');
    expect(visible).toBe('App Secret: \n');
    const rawModeCalls = vi.mocked(input.setRawMode).mock.calls.map(([mode]) => mode);
    expect(rawModeCalls[0]).toBe(true);
    expect(rawModeCalls.at(-1)).toBe(false);
  });
});
