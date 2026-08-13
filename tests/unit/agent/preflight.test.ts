import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentPreflightError,
  checkAgentVersion,
  formatAgentPreflightError,
  getAgentPreflightDiagnostic,
} from '../../../src/agent/preflight.js';

describe('agent preflight diagnostics', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/platform/spawn');
    vi.resetModules();
  });

  it('classifies version checks killed by a signal without exposing code null', async () => {
    vi.resetModules();
    vi.doMock('../../../src/platform/spawn', () => ({
      spawnProcess: vi.fn(() => fakeSignaledChild()),
    }));
    const { checkAgentVersion } = await import('../../../src/agent/preflight.js');

    await expect(
      checkAgentVersion({
        agentId: 'zcode',
        agentName: 'ZCode CLI',
        command: 'zcode',
        binaryPath: '/virtual/zcode',
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-version-check-signaled',
        agentId: 'zcode',
        agentName: 'ZCode CLI',
        command: 'zcode',
        binaryPath: '/virtual/zcode',
        args: ['--version'],
        exitCode: null,
        signal: 'SIGTERM',
      },
    });
  });

  it('renders a concise user-facing message for signaled version checks', () => {
    const err = new AgentPreflightError({
      code: 'agent-version-check-signaled',
      agentId: 'zcode',
      agentName: 'ZCode CLI',
      command: 'zcode',
      binaryPath: '/opt/homebrew/bin/zcode',
      args: ['--version'],
      exitCode: null,
      signal: 'SIGKILL',
    });

    expect(formatAgentPreflightError(err)).toBe(
      [
        '✗ 本地 ZCode CLI 不可用：执行 `zcode --version` 时被系统终止（SIGKILL）。',
        '',
        '请先在终端确认：',
        '  zcode --version',
        '',
        '修复本地 ZCode CLI 后，再重新运行 bridge。',
        '错误码：agent-version-check-signaled',
      ].join('\n'),
    );
    expect(formatAgentPreflightError(err)).not.toContain('code null');
  });

  it('classifies non-zero, empty, and missing version checks', async () => {
    const missing = join(tmpdir(), `missing-agent-${Date.now()}`);

    await expect(
      checkAgentVersion({
        agentId: 'zcode',
        agentName: 'ZCode CLI',
        command: 'zcode',
        binaryPath: process.execPath,
        args: ['-e', 'process.stderr.write("boom\\n"); process.exit(42);'],
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-version-check-nonzero-exit',
        exitCode: 42,
        stderrExcerpt: 'boom',
      },
    });

    await expect(
      checkAgentVersion({
        agentId: 'zcode',
        agentName: 'ZCode CLI',
        command: 'zcode',
        binaryPath: process.execPath,
        args: ['-e', 'process.exit(0);'],
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-version-check-empty-output',
        agentId: 'zcode',
      },
    });

    await expect(
      checkAgentVersion({
        agentId: 'zcode',
        agentName: 'ZCode CLI',
        command: 'zcode',
        binaryPath: missing,
      }),
    ).rejects.toMatchObject({
      diagnostic: {
        code: 'agent-binary-not-found',
        errno: 'ENOENT',
      },
    });
  });

  it('renders concise messages for each diagnostic category', () => {
    const cases = [
      ['agent-binary-not-found', '✗ 未找到本地 ZCode CLI。'],
      ['agent-binary-not-executable', '✗ 本地 ZCode CLI 不可执行。'],
      ['agent-binary-resolve-failed', '✗ 本地 ZCode CLI 路径解析失败。'],
      ['agent-binary-not-readable', '✗ 本地 ZCode CLI 二进制不可读取。'],
      ['agent-version-check-spawn-failed', '✗ 本地 ZCode CLI 不可用：无法执行 `zcode --version`。'],
      ['agent-version-check-timeout', '✗ 本地 ZCode CLI 不可用：`zcode --version` 超时未返回。'],
      ['agent-version-check-nonzero-exit', '✗ 本地 ZCode CLI 不可用：`zcode --version` 退出码为 42。'],
      ['agent-version-check-empty-output', '✗ 本地 ZCode CLI 不可用：`zcode --version` 没有返回版本信息。'],
      ['agent-version-check-unsupported-version', '✗ 本地 ZCode CLI 版本不在当前安全试点允许范围内。'],
    ] as const;

    for (const [code, firstLine] of cases) {
      const err = new AgentPreflightError({
        code,
        agentId: 'zcode',
        agentName: 'ZCode CLI',
        command: 'zcode',
        binaryPath: '/opt/homebrew/bin/zcode',
        args: ['--version'],
        exitCode: 42,
        signal: 'SIGKILL',
      });
      const message = formatAgentPreflightError(err);

      expect(message.split('\n')[0]).toBe(firstLine);
      expect(message).toContain(`错误码：${code}`);
      expect(message).not.toContain('/opt/homebrew');
    }
  });

  it('shows administrators the allowed and actual ZCode versions', () => {
    const message = formatAgentPreflightError(
      new AgentPreflightError({
        code: 'agent-version-check-unsupported-version',
        agentId: 'zcode',
        agentName: 'ZCode CLI',
        command: 'zcode',
        binaryPath: '/private/path/zcode',
        args: ['--version'],
        expected: '0.16.3',
        actual: '0.17.0',
      }),
    );

    expect(message).toContain('当前版本：0.17.0');
    expect(message).toContain('允许版本：0.16.3');
    expect(message).not.toContain('/private/path');
  });

  it('recognizes nested ZCode preflight diagnostics', () => {
    expect(getAgentPreflightDiagnostic({
      cause: new AgentPreflightError({
        code: 'agent-binary-not-found',
        agentId: 'zcode',
        agentName: 'ZCode CLI',
        command: 'zcode',
        binaryPath: '/opt/zcode/bin/zcode',
      }),
    })).toMatchObject({
      code: 'agent-binary-not-found',
      agentId: 'zcode',
      agentName: 'ZCode CLI',
      command: 'zcode',
    });
  });
});

function fakeSignaledChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
  return child;
}
