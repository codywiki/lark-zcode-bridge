# 项目约定 — lark-channel-bridge-src

> 通用版约定，适用于 Codex CLI、Kimi Code 等任何读取根目录 AGENTS.md 的 agent。
> 本文件（AGENTS.md）为所有 agent 的通用约定真值；Claude Code 的 `.claude/CLAUDE.md` 由本文件派生。

## 项目定位
飞书/Lark 与本地 Claude Code、Codex CLI、Kimi Code CLI 的 bridge。转发消息、流式卡片、会话连续性、队列/批处理、多 workspace、图片/文件、交互卡片。

## 技术栈
- TypeScript
- tsup
- Vitest（unit / integration / process）
- pnpm
- Node.js

## 目录约定
- `src/`：核心 bridge 逻辑
- `tests/unit/`：单元测试
- `tests/integration/`：集成测试
- `tests/process/`：进程/安全相关测试

## 修改后必跑验证
每次修改文件后，按顺序执行：
1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm build`

改消息转发、流式卡片、会话管理、workspace 切换、文件处理时，必须跑完整 `pnpm test`（含 integration）。
改子进程/安全隔离逻辑时，必须跑 `pnpm test:process`。

## 红线
- bridge 身份模型、飞书 OAuth 流程、默认安全策略不可随意修改
- 不要把用户会话数据泄露到日志或错误信息
- 不要绕过权限检查让非 owner 执行危险操作
- 涉及子进程启动、文件访问、workspace 隔离的改动必须经过 process 测试
- 不要改 `prepare` / `prepublishOnly` 里的基础验证流程
- 任何 outward-facing 行为（消息格式、卡片 schema、命令解析）的破坏性格式变化都要谨慎

## 复杂任务提示
涉及改消息协议、改流式卡片、改会话管理、改 workspace/文件隔离、改部署/发布时：
1. 拆成 3-5 个步骤（方案 → 核心逻辑 → 测试 → 集成验证 → 评审）
2. 每步完成跑 `pnpm typecheck && pnpm test && pnpm build`
3. 改默认安全策略、改 OAuth 流程、改子进程行为、改发布流程前必须向用户确认

## 维护说明
- 本文件是 Codex/Kimi/Claude 等所有 agent 的通用约定真值。
- `.claude/CLAUDE.md` 由本文件派生，用于 Claude Code 的 skill 自动触发等增强能力。
- 更新项目约定时，**先改本文件（AGENTS.md）**，再同步更新 `.claude/CLAUDE.md`。
