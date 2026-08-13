import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZcodeAdapter } from '../../src/agent/zcode/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

/**
 * Live smoke against the real ZCode.app runtime. Never runs by default:
 * requires LARK_ZCODE_LIVE_SMOKE=1 and ZCODE_API_KEY in the environment.
 * Uses a throwaway profile state dir, so the real ~/.zcode is untouched.
 */
const LIVE = process.env.LARK_ZCODE_LIVE_SMOKE === '1' && Boolean(process.env.ZCODE_API_KEY);

describe('zcode real runtime smoke', { skip: !LIVE, timeout: 180_000 }, () => {
  it('runs a prompt and resumes the session', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'zcode-live-smoke-'));
    try {
      const adapter = new ZcodeAdapter({ profileStateDir: stateDir });
      expect(await adapter.isAvailable()).toBe(true);

      const collect = async (run: ReturnType<ZcodeAdapter['run']>): Promise<AgentEvent[]> => {
        const events: AgentEvent[] = [];
        for await (const event of run.events) events.push(event);
        return events;
      };

      const first = await collect(
        adapter.run({ runId: 'live-1', prompt: '只回复两个字：你好', cwd: stateDir }),
      );
      const firstDone = first.find((e) => e.type === 'done');
      expect(firstDone).toMatchObject({ terminationReason: 'normal' });
      const sessionId = (first.find((e) => e.type === 'system') as { sessionId?: string })
        ?.sessionId;
      expect(sessionId).toMatch(/^sess_/);

      const second = await collect(
        adapter.run({
          runId: 'live-2',
          prompt: '再回复两个字：好的',
          cwd: stateDir,
          sessionId,
        }),
      );
      expect(second.find((e) => e.type === 'done')).toMatchObject({
        terminationReason: 'normal',
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
