# lark-zcode-bridge

把飞书 / Lark 消息和本地 **ZCode CLI**（[ZCode](https://zcode.ai/) 桌面版内置的 headless 运行时，走 GLM Coding Plan）打通的轻量 bot。一条命令启动，扫码绑定 PersonalAgent 应用，然后在飞书里直接指挥 ZCode 读图、处理文件、改代码。

[English README](./README.md)

> 社区项目，非飞书/Lark 或 ZCode 官方产品。fork 自 [lark-channel-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge)（MIT），裁剪为只服务 ZCode 的单 agent bridge。平台支持：**macOS**（运行时在 macOS 版 ZCode 应用包内）；其它平台未验证。

## 主要功能

- 把飞书 / Lark 消息转发给本地 ZCode CLI。私聊直接发，群里 `@bot` 即可。
- **流式卡片**：回复在一张卡片上实时更新，每次运行结束再补一条有长度上限的纯文本结果摘要。
- **会话连续**：每个私聊、话题、文档评论线程各自维护独立的 ZCode session（`--resume sess_<id>`）。
- **排队与合批**：连发的消息合并处理；运行中发来的消息排队到下一轮，`/new`、`/cd`、`/stop` 等命令可打断当前任务。
- **多工作区**：`/cd` 切换当前项目，`/ws` 保存和复用常用目录。
- **图片和文件**：直接发给 bot，bridge 下载到本地后通过 `--attach` 传给 ZCode。
- **交互卡片**：`/help`、`/ws list`、`/status` 返回可点击按钮的卡片。

## 前置条件

- Node.js **>= 20.12.0**
- macOS 已安装 **ZCode 桌面版**。bridge 驱动的是应用内置运行时 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`；非标准安装路径用 `LARK_ZCODE_BRIDGE_RUNTIME_PATH` 覆盖。
- **GLM Coding Plan** API Key（BigModel 或 z.ai）。
- 一个飞书 / Lark **PersonalAgent** 应用。首次运行的扫码向导可以帮你创建并绑定。

## 安装

```bash
npm i -g lark-zcode-bridge
# 或
pnpm add -g lark-zcode-bridge
```

## 首次运行

```bash
lark-zcode-bridge run
```

向导会引导你扫码创建/绑定 PersonalAgent 应用，随后以前台方式启动 bridge。要让它常驻（重启后自动拉起），用 `lark-zcode-bridge start` 安装 per-profile service（macOS 上走 launchd）；`lark-zcode-bridge stop` / `restart` 管理服务。

### 配置模型 API Key

每个 profile 都有**独立的 ZCode home**（`~/.lark-zcode-bridge/profiles/<name>/zcode-home`）——bridge 不会读写你真实的 `~/.zcode`。每个 profile 填一次 Key：

```bash
lark-zcode-bridge profile login zcode      # 交互式输入 API Key
# 或非交互：
ZCODE_API_KEY=<key> lark-zcode-bridge profile login zcode
```

生成的模型配置默认走 BigModel Coding Plan（主模型 `glm-5.2`，轻量模型 `glm-5-turbo`）。聊天里用 `/model glm-5-turbo` 切换主模型；要自定义 provider、z.ai baseURL 等，直接编辑 `zcode-home/.zcode/cli/config.json`。

## 权限

新建 ZCode profile 默认是**完整权限**：每次运行带 `--mode yolo`，agent 可以读写任意目录、免逐条审批执行命令——不受所选工作区限制。这与上游 bridge 的 `bypassPermissions` 姿态一致，对个人 bot 是有意为之：bridge 自己的访问控制（`allowedUsers` / `allowedChats`）决定**谁**能用 bot。

要降低上限，编辑 profile 配置（`~/.lark-zcode-bridge/config.json`）：

```json
{
  "profiles": {
    "zcode": {
      "permissions": {
        "defaultAccess": "full",
        "maxAccess": "full"
      }
    }
  }
}
```

两个值都改成 `"workspace"` 即 `--mode build`（工作区读写），改成 `"read-only"` 即 `--mode plan`（只读规划）。旧版 `sandbox` 字段由 `permissions` 推导，不要直接配置。

## 访问控制

默认只有 owner 能用。owner 可以在聊天里开放：

- `/invite user @某人` — 加入用户白名单；`/remove user @某人` — 移出
- `/invite group` — 把当前群加入响应群名单；`/remove group` — 移出
- `/invite all group` — 把 bot 所在的所有群一键加入

群聊命令不能扩大白名单（只有 owner 的 `/invite` 生效），重启后以配置文件为准。云文档评论按文档权限生效：任何能在文档里评论并 @ 到 bot 的人都能触发运行，分享文档时注意。

## 工作区

单次运行只会拿到当前选中的一个规范化工作目录。`/cd <路径>` 切换；`/ws save|use|list|remove` 管理常用目录。profile 的兜底目录是配置里的 `workspaces.default`（首次运行自动建在 `~/.lark-zcode-bridge-workspaces/<profile>/default`）。

## 多 profile

多个 bot 应用可以作为命名 profile 并行运行，各自有独立的配置、会话、密钥和常驻服务：

- `lark-zcode-bridge profile list|create|use <name>` — 管理 profile
- `lark-zcode-bridge profile export <name>` — 导出 profile；`--include-secrets --yes` 会连应用密钥和 secret provider 配置一起导出（导出文件按密钥对待）
- `lark-zcode-bridge profile remove <name>` — 归档 profile 状态；`--purge --yes` 彻底删除

### lark-cli 身份策略

bridge 会为每个 profile 投影一个当前 profile 的 lark-cli 目录（`profiles/<name>/lark-cli/`），让 agent 运行时可以以 bot 自己的身份回调飞书。lark-cli 身份策略（strict-mode / default-as）只作用在这个目录里，绝不碰用户个人的 lark-cli 配置。

## 聊天内命令

- `/new` — 开新会话
- `/cd <路径>` — 切换工作区；`/ws list|use|save` — 管理已存工作区
- `/status` — 查看当前会话、目录、权限模式
- `/model <id>` — 切换本 profile 的主模型
- `/resume` — 恢复当前 catalog 记录的会话
- `/stop` — 打断正在运行的任务
- `/help` — 完整命令卡片

## 配置目录

所有状态存放在 `~/.lark-zcode-bridge/`（可用 `LARK_ZCODE_BRIDGE_HOME` 覆盖）。特意与 `lark-channel-bridge` 的 `~/.lark-channel/` 分开，两个 bridge 可以并行运行、互不覆盖配置。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest：unit + integration + process
pnpm build       # tsup → dist/
```

## 致谢

基于 zarazhangrui 及贡献者的 [lark-channel-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge)（MIT）构建；同样参考了姊妹 fork lark-kimi-bridge 对 Kimi Code CLI 的单 agent 改造。

## License

MIT — 见 [LICENSE](./LICENSE)。
