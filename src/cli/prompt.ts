import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

interface PasswordPromptInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

interface PasswordPromptIO {
  input?: PasswordPromptInput;
  output?: NodeJS.WritableStream;
}

export async function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function promptPassword(
  prompt: string,
  io: PasswordPromptIO = {},
): Promise<string> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const isTTY = Boolean(input.isTTY);
  const canSetRawMode = isTTY && typeof input.setRawMode === 'function';
  const previousRawMode = Boolean(input.isRaw);
  return new Promise((resolve) => {
    const muted = new Writable({
      write(_chunk: Buffer | string, _enc, cb) {
        cb();
      },
    });
    output.write(prompt);
    // readline does not reliably disable the terminal driver's local echo
    // when its output is a muted stream (notably under pseudo-terminals).
    // Enter raw mode explicitly before accepting a secret, then restore the
    // caller's original mode after readline closes.
    if (canSetRawMode) input.setRawMode?.(true);
    const rl = createInterface({
      input,
      output: isTTY ? muted : output,
      terminal: isTTY,
    });
    rl.question('', (answer) => {
      rl.close();
      if (canSetRawMode) input.setRawMode?.(previousRawMode);
      output.write('\n');
      resolve(answer.trim());
    });
  });
}
