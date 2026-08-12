import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('README runtime contract', () => {
  it('documents maintained runtime surfaces in user-visible docs', async () => {
    const docs = await readDocs();

    for (const phrase of [
      'per-profile service',
      'workspaces.default',
      'workspaces.allowedRoots',
      '/invite user',
      '/remove user',
      '/invite group',
      '/remove group',
      '/invite all group',
      'Windows',
      '.cmd',
      'profile export',
      'profile remove',
      '--purge --yes',
      '--include-secrets --yes',
      'lark-cli identity policy',
      'profile-local lark-cli directory',
      'lark-cli 身份策略',
      '当前 profile 的 lark-cli 目录',
      'pnpm test',
      'pnpm typecheck',
      'pnpm build',
    ]) {
      expect(docs).toContain(phrase);
    }
  });

  it('keeps CLI help aligned with profile-aware service and first-run workspace flags', async () => {
    const [cli, help, configCard] = await Promise.all([
      readFile(new URL('../../../src/cli/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/templates.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../src/card/config-card.ts', import.meta.url), 'utf8'),
    ]);

    expect(cli).toContain('--workspace <path>');
    expect(cli).toContain('profile name (defaults to active profile)');
    expect(cli).toContain('Archive a profile and its local state');
    expect(help).not.toContain('/doc ws');
    expect(configCard).not.toContain('`/doc`');
  });

  it('documents local profile root authorization without remote expansion commands', async () => {
    const docs = await readDocs();

    for (const phrase of [
      '可信目录',
      '安全目录',
      'trustedRoots',
      '/ws add',
      '/ws remove --root',
      'trusted directory',
      'safe directory',
    ]) {
      expect(docs).not.toContain(phrase);
    }
    expect(docs).toContain('群聊命令不能扩大白名单');
    expect(docs).toContain('chat commands cannot expand this allowlist');
    expect(docs).toContain('单次运行只会拿到当前选中的一个规范化工作目录');
  });

  it('documents access control commands instead of config-only access management', async () => {
    const docs = await readDocs();

    expect(docs).not.toContain('`/config` only adjusts presentation preferences. Manage access in the profile config.');
    expect(docs).not.toContain('`/config` 只调整展示偏好，不再维护访问名单。请在 profile config 里维护。');
  });

  it('documents cloud-doc comments as document-scoped instead of access-gated', async () => {
    const docs = await readDocs();

    expect(docs).toContain('Cloud-doc comments are document-scoped');
    expect(docs).toContain('云文档评论按文档权限生效');
    expect(docs).not.toContain('comments.enabled');
    expect(docs).not.toContain('comments.rateLimit');
    expect(docs).not.toContain('/doc ws bind');
  });

  it('documents canonical permissions instead of recommending legacy sandbox config', async () => {
    const docs = await readDocs();

    expect(docs).toContain('"permissions"');
    expect(docs).toContain('"defaultAccess": "full"');
    expect(docs).toContain('"maxAccess": "full"');
    expect(docs).toContain('legacy `sandbox`');
    expect(docs).toContain('旧版 `sandbox`');
    expect(docs).not.toContain('"sandbox"');
  });

  it('documents Kimi read-only defaults and the explicit unsandboxed full-access risk', async () => {
    const docs = await readDocs();

    expect(docs).toContain('New Kimi profiles default to read-only');
    expect(docs).toContain('every bot ACP run and its pre-run Kimi config validation is wrapped in macOS Seatbelt');
    expect(docs).toContain('Direct workspace file data is denied to the Kimi process');
    expect(docs).toContain('disables writes, process execution, attachments, MCP, subagents, skills, hooks, and plugins');
    expect(docs).toContain('Explicitly setting both Kimi permission values to `full` opts into local Shell and file read/write/edit tools without Seatbelt');
    expect(docs).toContain('Full mode runs with the bridge OS user\'s permissions and is not restricted to the selected workspace');
    expect(docs).toContain('Kimi `workspace` mode keeps Seatbelt, allows local Shell/process execution, and limits project-data reads and writes to the active current working directory');
    expect(docs).toContain('新建 Kimi profile 默认仍是只读模式');
    expect(docs).toContain('在该模式下，每次 bot ACP 运行及其运行前 Kimi 配置校验都会进入 macOS Seatbelt');
    expect(docs).toContain('Kimi 子进程不能直接读取工作区正文');
    expect(docs).toContain('禁用写入、进程执行、附件、MCP、子 Agent、Skill、hook 和 plugin');
    expect(docs).toContain('只有将 Kimi 的两个权限值都显式设为 `full`，才会不启用 Seatbelt');
    expect(docs).toContain('full 模式拥有 bridge 操作系统用户的权限，不受所选工作区限制');
    expect(docs).toContain('Kimi 的 `workspace` 模式保留 Seatbelt，允许本机 Shell/进程执行，并将项目数据的读写限制在当前激活工作目录内');
    expect(docs).not.toContain('all three stored access values collapse');
    expect(docs).not.toContain('三个配置值都会收敛到同一套');
  });
});

async function readDocs(): Promise<string> {
  const [en, zh] = await Promise.all([
    readFile(new URL('../../../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../../README.zh.md', import.meta.url), 'utf8'),
  ]);
  return `${en}\n${zh}`;
}
