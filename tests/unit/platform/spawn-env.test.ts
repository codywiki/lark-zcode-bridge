import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { mergeProcessEnv } from '../../../src/platform/spawn.js';

describe('platform spawn env', () => {
  it('overrides env keys case-insensitively for Windows-compatible CODEX_HOME handling', () => {
    const env = mergeProcessEnv(
      {
        Path: '/bin',
        Codex_Home: '/old-codex-home',
        LARK_CHANNEL: '0',
      },
      {
        CODEX_HOME: '/new-codex-home',
        LARK_CHANNEL: '1',
      },
    );

    expect(env.CODEX_HOME).toBe('/new-codex-home');
    expect(env.LARK_CHANNEL).toBe('1');
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'codex_home')).toEqual([
      'CODEX_HOME',
    ]);
  });

  it('the zcode adapter uses cross-spawn without shell invocation', async () => {
    const zcodeSource = await readFile(
      new URL('../../../src/agent/zcode/adapter.ts', import.meta.url),
      'utf8',
    );

    expect(zcodeSource).toContain("from '../../platform/spawn'");
    expect(zcodeSource).not.toContain("from 'node:child_process'");
    expect(zcodeSource).not.toContain('shell: true');
  });
});
