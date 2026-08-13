> 本文件由项目根目录 `AGENTS.md` 派生，用于 Claude Code 的 skill 自动触发等增强能力。
> 通用项目约定（技术栈、命令、红线）请以 `AGENTS.md` 为真值；冲突时以 `AGENTS.md` 为准。

# 项目约定 — lark-zcode-bridge

## 项目定位
飞书/Lark 与本地 **ZCode CLI** 的 bridge（zcode-only fork，上游 lark-channel-bridge）。转发消息、流式卡片、会话连续性、队列/批处理、多 workspace、图片/文件、交互卡片。唯一 agent 是 `src/agent/zcode/` 的 ZcodeAdapter；默认完整权限（yolo）；独立配置根 `~/.lark-zcode-bridge/`，绝不与 `~/.lark-channel/` 共享。

## 技术栈
- 语言：TypeScript
- 构建：tsup
- 测试：Vitest，分 unit / integration / process 三套
- 包管理：pnpm
- 运行环境：Node.js

## 目录约定
- `src/`：核心 bridge 逻辑
- `tests/unit/`：单元测试
- `tests/integration/`：集成测试
- `tests/process/`：进程/安全相关测试

## 常用命令
- 开发（watch）：`pnpm dev`
- 构建：`pnpm build`
- 类型检查：`pnpm typecheck`
- 全部测试：`pnpm test`
- 单元测试：`pnpm test:unit`
- 集成测试：`pnpm test:integration`
- 进程测试：`pnpm test:process`
- 本地 CI：`pnpm ci:local`
- 平台 CI：`pnpm ci:platform`

## 修改后必跑验证
> 每次修改文件后，按顺序执行以下命令，全部通过再继续：
1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm build`

如改动了消息转发、流式卡片、会话管理、workspace 切换、文件处理，必须跑完整 `pnpm test`（含 integration）。
如改动了子进程/安全隔离逻辑，必须跑 `pnpm test:process`。

## 红线
- bridge 身份模型、飞书 OAuth 流程、默认安全策略不可随意修改
- 不要把用户会话数据泄露到日志或错误信息
- 不要绕过权限检查让非 owner 执行危险操作
- 涉及子进程启动、文件访问、workspace 隔离的改动必须经过 process 测试
- 不要改 `prepare` / `prepublishOnly` 里的基础验证流程
- 任何 outward-facing 行为（消息格式、卡片 schema、命令解析）的破坏性格式变化都要谨慎

## Skill 自动触发规则
> 以下情况无需用户手动输入 /review 或 /plan-review，Claude Code 应自动调用对应 skill：

### 自动调用 /review
- 用户明确说「评审一下」、「review 一下」、「看看有没有问题」等
- 单次改动文件数 ≥ 5 个
- 改动涉及核心配置文件（package.json、tsconfig.json、go.mod、Dockerfile、Makefile 等）
- 改动涉及测试文件、CI/CD 配置、安全相关代码

### 自动调用 /plan-review
- 用户要求做「复杂任务」、「大改动」、「重构」、「新增功能」等
- 改动涉及数据库 schema / D1 表结构 / GORM 模型
- 改动涉及公共接口 / OpenAPI / gRPC proto / REST API
- 改动涉及鉴权 / 安全 / 权限 / 隔离逻辑
- 改动涉及部署 / CI/CD / Cloudflare / Docker / K8s 配置
- 改动涉及 monorepo 依赖关系或 workspace 配置
- 改动影响范围跨多个 package / service / app

### 执行方式
- 自动触发时，先告知用户「检测到 X 条件，自动启动 /review（或 /plan-review）」
- 然后按对应 skill 文件里的流程执行
- 不要把 skill 内容原样打印给用户，只输出结论和必须确认的事项

## 复杂任务工作流
涉及改消息协议、改流式卡片、改会话管理、改 workspace/文件隔离、改部署/发布时：
1. 用 `TaskCreate` 拆成 3-5 个步骤（方案 → 核心逻辑 → 测试 → 集成验证 → 评审）
2. 每步完成自动跑 `pnpm typecheck && pnpm test && pnpm build`
3. 改安全/隔离/子进程逻辑时 spawn reviewer agent 做 adversarial review
4. 改默认安全策略、改 OAuth 流程、改子进程行为、改发布流程前必须向用户确认

## 常见踩坑
- 流式卡片更新频繁，测试时要验证中间状态与最终状态
- `/cd`、`/ws`、`/new`、`/stop` 等命令有中断语义，改动时要检查会话生命周期
- 文件下载/上传涉及本地路径与飞书 URL，权限处理要一致
- 多 workspace 切换时，环境变量与当前目录状态要正确传递
- `prepare` 会在 install 时自动 build，确保 build 不依赖未打包文件
