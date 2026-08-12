# lark-channel-bridge

A lightweight bot that bridges Feishu / Lark messenger with your local Claude Code, Codex CLI, or Kimi Code CLI. Run one command, scan a QR code to bind a PersonalAgent app, and talk to your local coding agent from chat.

[中文 README](./README.zh.md)

For a product walkthrough, see the [Feishu document](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e).

## What it does

- Forwards Feishu / Lark messages to local Claude Code, Codex CLI, or Kimi Code CLI. Send a DM directly, or `@bot` in a group.
- **Streaming card**: text replies and tool calls update on one Lark card in real time.
- **Global completion summary**: every successful streamed run ends with one separate, bounded plain-text result summary for all profiles; plain-text reply mode is not duplicated.
- **Session continuity**: each chat, topic, or document comment thread keeps its own session.
- **Queueing and batching**: messages sent in quick succession are handled together; messages sent during a run are queued for the next turn, while commands like `/new`, `/cd`, `/ws use`, and `/stop` can interrupt the current task.
- **Multiple workspaces**: use `/cd` to switch the current project, and `/ws` to save and reuse common project directories.
- **Images and files**: send them to the bot directly, and the bridge downloads them locally for the agent.
- **Interactive cards**: `/help`, `/ws list`, and `/status` return cards with clickable buttons.

## Prerequisites

- Node.js **>= 20.12.0**
- At least one local agent installed and authenticated as described for that agent:
  - Claude Code: `claude`, see https://docs.anthropic.com/en/docs/claude-code/quickstart
  - Codex CLI: `codex`, see https://developers.openai.com/codex/cli
  - Kimi Code CLI: `kimi`, see https://moonshotai.github.io/kimi-code/. Do not use the global `kimi login` for a bridge bot; log in the isolated profile after creating it, as shown below.
- A Feishu / Lark **PersonalAgent** app. The first-run QR wizard can create and bind one for you.

## Install

```bash
npm i -g lark-channel-bridge
# or
pnpm add -g lark-channel-bridge
```

## First run

```bash
lark-channel-bridge run
```

The first run opens a QR-code wizard:

1. A QR code renders in your terminal.
2. Scan it with the Feishu / Lark app.
3. Pick or create a PersonalAgent app.
4. If prompted, choose which agent to initialize.
5. Config is written to `~/.lark-channel/config.json`.

You do not need to choose a project directory up front. The bridge creates a profile-managed default working directory; after startup, send `/cd <path>` in Feishu / Lark to switch to a real project.

If you already have a PersonalAgent app, pass `--app-id` during initialization to skip app creation. The command prompts for the App Secret.

```bash
lark-channel-bridge run --app-id cli_xxx
# or initialize and start the background service directly
lark-channel-bridge start --app-id cli_xxx
```

For Lark global apps, add `--tenant lark`.

## Background service

Use `run` for first-run setup and foreground debugging. After the bot can send and receive messages, stop the foreground process with `Ctrl-C`, then use an OS-managed service for background operation:

```bash
lark-channel-bridge start
lark-channel-bridge status
lark-channel-bridge stop
```

Install globally before using service commands. The daemon's launchd plist / systemd unit / Windows task records the bridge CLI path; if that path comes from an npm temp cache through `npx`, the daemon can break when the cache is cleaned. `run` is fine through `npx` as a one-shot foreground process.

Service commands install a per-profile service:

```bash
lark-channel-bridge start [--profile <name>]
lark-channel-bridge stop [--profile <name>]
lark-channel-bridge restart [--profile <name>]
lark-channel-bridge status [--profile <name>]
lark-channel-bridge unregister [--profile <name>]
```

Platform mapping:
- **macOS**: launchd user agent `ai.lark-channel-bridge.bot.<profile>`
- **Linux**: systemd user unit `lark-channel-bridge.bot.<profile>.service`
- **Windows**: Task Scheduler task `LarkChannelBridge.Bot.<profile>`, launched through a `.cmd` wrapper

Daemon logs are under `~/.lark-channel/profiles/<profile>/logs/daemon/`.

### Multiple profiles: Claude, Codex, and Kimi

By default, the bridge starts with the currently selected profile. Use `profile use <name>` to change it. Each profile keeps its own app credentials, sessions, working directories, and logs. Create multiple profiles only when you need to connect multiple PersonalAgent apps, or run Claude, Codex, and Kimi as separate bots:

```bash
lark-channel-bridge profile create kimi --agent kimi --workspace /path/to/a/narrow/project
lark-channel-bridge profile login kimi
lark-channel-bridge start --profile kimi
```

`profile login kimi` keeps Kimi credentials under `~/.lark-channel/profiles/kimi/kimi-home`; a normal global `kimi login` does not authorize this isolated bot profile. Claude and Codex profiles can continue to be created and started in the usual way.

The Kimi adapter uses `kimi acp` and is currently a macOS-only, text-only pilot pinned to Kimi Code **0.29.2**; other versions fail closed. New Kimi profiles default to read-only. In that mode, every bot ACP run and its pre-run Kimi config validation is wrapped in macOS Seatbelt. Direct workspace file data is denied to the Kimi process; text reads go through a bridge-owned ACP handler that enforces realpath containment, sensitive-path checks, regular UTF-8 files, and a 1 MiB limit. The bridge enables only known-path `Read` and metadata checks; directory listing and Glob/Grep are unavailable. It forces the `default`/manual session mode, denies approvals, and disables writes, process execution, attachments, MCP, subagents, skills, hooks, and plugins. The read-only boundary is enforced independently by tool deny rules, the reverse ACP file handler, and Seatbelt rather than by session mode. It also refuses workspaces that expose Kimi bootstrap extension files such as `AGENTS.md`, MCP config, local Kimi config, or project skill directories. Read-only runs fail closed when macOS Seatbelt is unavailable. Kimi `workspace` mode keeps Seatbelt, allows local Shell/process execution, and limits project-data reads and writes to the active current working directory. Its additional read exceptions are the Apple `system.sb` runtime baseline, the Kimi installation directory, and the isolated profile home; only the isolated profile home is also writable. Explicitly setting both Kimi permission values to `full` opts into local Shell and file read/write/edit tools without Seatbelt. Full mode runs with the bridge OS user's permissions and is not restricted to the selected workspace: it can execute arbitrary commands and read, change, delete, or expose any local file or credential that user can access. Use it only with a dedicated, trusted profile and OS account. Cloud-document comments are not handled. Kimi reasoning is never shown, and answer text is buffered up to 20 KB until the turn finishes and then path-sanitized before reaching a card, so this pilot does not stream Kimi answer text chunk by chunk. Read tool panels expose only a bounded path/line summary and completion status, never raw file output. For team use, create a separate PersonalAgent app and profile for Kimi instead of reusing Claude or Codex bot credentials.

For example, to restart only the Codex bot:

```bash
lark-channel-bridge restart --profile codex
lark-channel-bridge status --profile codex
```

## Commands

### Host CLI

```text
lark-channel-bridge run [--profile <name>] [--agent claude|codex|kimi] [--workspace <path>] [-c <config>]
lark-channel-bridge migrate [--profile <name>] [--agent claude|codex|kimi]
lark-channel-bridge ps
lark-channel-bridge kill <id|#>
lark-channel-bridge --help
```

`profile use <name>` changes the profile used by later default starts. Use these profile management commands when running separate Claude / Codex / Kimi bots, connecting multiple PersonalAgent apps, or doing scripted deployment:

```bash
lark-channel-bridge profile create claude --agent claude
lark-channel-bridge profile create codex --agent codex
lark-channel-bridge profile create kimi --agent kimi
lark-channel-bridge profile login kimi
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
lark-channel-bridge profile export <name> [--output ./profile.json] [--force]
lark-channel-bridge profile export <name> --include-secrets --yes
```

`profile remove` archives local state by default, including the active profile. If other profiles remain, the bridge switches to the next one; if it was the last profile, the root config is cleared so the same name can be created again. `--purge --yes` permanently deletes local state. `profile export` redacts app secrets by default; `--include-secrets --yes` includes sensitive config.

If a profile was created with the wrong agent kind, stop or unregister any matching background service first, then run `profile remove <name>` and recreate it with the intended `--agent`.

### Slash commands inside Feishu / Lark

| Command | Effect |
|---|---|
| `/new`, `/reset` | Clear the current session |
| `/cd <path>` | Switch working directory and reset the session |
| `/ws list` | List named workspaces |
| `/ws save <name>` | Save the current working directory as a named workspace |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Delete a named workspace |
| `/resume` | Resume compatible history for the same agent, working directory, and permission mode |
| `/status` | Show profile, agent, working directory, session, lark-cli identity, and run state |
| `/config` | Adjust presentation preferences, access settings, and lark-cli identity policy |
| `/invite user @name` | Allow a user to use the bot in DMs |
| `/invite admin @name` | Add an access-control admin |
| `/invite group` | Allow the current group to use the bot |
| `/invite all group` | Allow all groups the bot has joined (disabled for Kimi profiles) |
| `/remove user @name`, `/remove admin @name`, `/remove group` | Remove access entries |
| `/stop` | Stop the current run, including the card stop button |
| `/timeout [N\|off\|default]` | Set or clear the current session idle watchdog |
| `/ps` | List local bridge processes |
| `/exit <id\|#>` | Stop a bridge process |
| `/reconnect` | Force a WebSocket reconnect |
| `/doctor [description]` | Run low-sensitive diagnostics |
| `/help` | Help card |

DMs do not require an @ mention. Groups and topic groups require `@bot` by default; `@all` is ignored. Cloud-doc comments in supported document types run when the bot is mentioned.

## lark-cli identity policy

Each profile uses a profile-local lark-cli directory at `~/.lark-channel/profiles/<profile>/lark-cli`. The agent process receives `LARKSUITE_CLI_CONFIG_DIR` for that directory, so personal authorization in one profile is not shared with another profile.

The default policy is `bot-only`: lark-cli uses the app/bot identity and does not access personal resources. When a user authorizes personal resources such as calendar, mail, or drive, the current profile can switch to `user-default`, which keeps app identity available and also allows the authorized user identity. Owner/admin users can inspect or change this policy in `/config`; `/status` shows the current summary as `lark-cli: app` or `lark-cli: user-ready`.

## Working directories

Each profile may define a default working directory through `workspaces.default`. New profiles may be created with `--workspace <path>`; if omitted, the bridge creates a profile-managed default working directory. A Kimi profile may also define additional selectable roots with `workspaces.allowedRoots`; the default directory is always an implicit authorized root.

This is a profile-field snippet. Do not replace the whole `config.json` with it; edit the matching profile's `workspaces` field.

```json
{
  "workspaces": {
    "default": "/Users/me/Kimi Code",
    "allowedRoots": [
      "/Users/me/Kimi Projects/client-a",
      "/Volumes/Work/Kimi Projects/client-b"
    ]
  }
}
```

The bridge checks that every configured root and selected directory exists, is a directory, resolves inside an authorized root, and is not an overly broad location such as `/`, the home root, a system directory, or a temp root. For Kimi, `/cd` and `/ws use` may select the default or any additional root (or one of their descendants), but each run receives only its one active canonical working directory. Adding a root requires editing the local profile and restarting the profile service; chat commands cannot expand this allowlist. The working directory is not a filesystem sandbox for unsandboxed permission modes; actual file access still depends on the local agent process and its permission mode.

## Permission modes

The recommended user-facing profile config is `permissions.defaultAccess` and `permissions.maxAccess`. New Claude and Codex profiles default to `full` for both values so the bridge can keep local tools, authorization flows, file writes, and other agent features fully usable. New Kimi profiles still default both values to `read-only`, which keeps the Seatbelt and ACP-controlled read boundary. Kimi `workspace` keeps Seatbelt while enabling local Shell/process execution and project-data file read/write/edit access inside the active current working directory, subject to the narrow runtime exceptions above. Setting both Kimi values explicitly to `full` enables those local tools without Seatbelt. To tighten a Claude or Codex profile, set one or both values to `workspace` or `read-only`; stricter modes can limit local tool execution, login/authorization flows, file writes, and similar capabilities.

This is a profile-field snippet. Do not replace the whole `config.json` with it; edit the matching profile's `permissions` field.

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

Mode mapping:

| Bridge access | Claude permission mode | Codex mode | Kimi ACP mode |
|---|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` | No Seatbelt; local Shell + file read/write/edit with OS-user access |
| `workspace` | `acceptEdits` | `workspace-write` | Seatbelt; local Shell/process execution + project-data file read/write/edit limited to active cwd |
| `read-only` | `plan` | `read-only` | Seatbelt + ACP read-only; forced `default`/manual; approvals denied |

For Kimi, `full` is an explicit high-risk opt-in: the configured workspace is only the process working directory, not a filesystem boundary. The process can run arbitrary local commands and access anything available to the bridge OS user. Use a dedicated OS account and profile, and keep `read-only` unless that exposure is acceptable. Attachments are still rejected before download and do not enter the prompt.

The legacy `sandbox` field is still readable for old configs. After the bridge saves the profile, it migrates that setting to canonical `permissions`.

## Data directories

| Path | Content |
|---|---|
| `~/.lark-channel/config.json` | Root config with profiles and active profile |
| `~/.lark-channel/active-profile` | Last selected profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | Session state |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | Agent-aware session catalog |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | Current and named workspace bindings |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | Profile-local encrypted secrets |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | Profile-local lark-cli directory |
| `~/.lark-channel/profiles/<profile>/media/` | Attachment cache |
| `~/.lark-channel/profiles/<profile>/logs/` | Structured run logs |
| `~/.lark-channel/registry/processes.json` | Local process registry |
| `~/.lark-channel/registry/locks/` | Profile and app locks |

Set `LARK_CHANNEL_HOME=/path/to/state` to move all local bridge state. `LARK_CHANNEL_LOG_DAYS` overrides log retention.

## Access control

**Chat access is private by default: out of the box, only *you* can use the bot in DMs and groups.** "You" = whoever created / owns the Feishu app (the person who scanned the QR to set it up). The bot figures out who the app owner is automatically from Feishu, so **solo chat use needs zero configuration** — you can DM it and `@`-mention it in any group, and everyone else's chat messages are silently ignored (no "permission denied" reply, which would only confirm the bot exists). Cloud-doc comments are document-scoped; see below.

To let other people or groups in, add them to one of three lists:

| List | Controls | Add | Remove |
|------|----------|-----|--------|
| **Allowed users** | who can DM the bot | `/invite user @them` | `/remove user @them` |
| **Allowed chats** | which groups the bot answers in (for **everyone** in them) | `/invite group` (current group) / `/invite all group` (every group the bot is in) | `/remove group` (current group) |
| **Admins** | who can change settings, and use the bot in any group | `/invite admin @them` | `/remove admin @them` |

> `/invite` and `/remove` can only be run by **you (the creator) and admins**. The `@` in the command points at the *target person* (not the bot) — the bot resolves the mention to their identity, so you never deal with raw IDs.

### Two identities that bypass everything

- **You (the creator)**: subject to no list at all — DMs, any group, every command. You **can never lock yourself out**: even if the lists get messed up, DM the bot and send `/config` to get back in. Transfer the app's ownership in the Feishu console and the bot follows the new owner automatically.
- **Admins**: can DM, run management commands like `/config`, and **bypass the allowed-chats list** — the bot answers them in any group, listed or not. Good for teammates who co-maintain the bot.

### Common setups

- **Just me** → nothing to do; this is the default.
- **Let a teammate DM the bot** → `/invite user @them`
- **Open a work group to everyone in it** → send `/invite group` inside that group
- **First-time Claude/Codex setup, onboard every group the bot is already in** → `/invite all group` pulls them all into the list at once; trim with `/remove group` afterwards. Kimi profiles reject this command.
- **Add a co-admin** → `/invite admin @them`

### Worth knowing

- Changes take effect on the **next message** — no restart needed.
- **In groups you must `@` the bot first** (DMs don't need it). That's a separate toggle (`/config` → "require @ in groups"), independent of the lists above.
- Strangers get pure silence — no reply at all. The one exception: if someone `@`-mentions the bot in a group that hasn't been opened up, the bot posts a friendly one-liner telling them an admin can run `/invite group` to enable it.
- Cloud-doc comments are document-scoped: anyone who can comment in a supported document and mention the bot can trigger a reply.

### Recommended Kimi group pilot

Pilot Kimi only in selected groups or topic groups. Open groups individually with `/invite group`, keep “require @ in groups” enabled, and use a dedicated, sanitized workspace copy containing only material approved for every pilot-group member; do not point it at a broad production repository. Kimi profiles fail closed on `/invite all group`. Once a chat is in `allowedChats`, every member of that chat can invoke the bot through one shared local service account. The bridge does not currently perform an additional tenant-membership check, enforce source-level authorization, or provide per-user quotas. Topic groups isolate sessions by thread, while regular groups share a chat-level session, so topic groups are safer for concurrent pilots.

Keep this pilot at low concurrency: Kimi config validation currently runs synchronously before each ACP turn and can pause the bot while validation is in progress. Install any console/telemetry instrumentation before starting the Kimi profile; do not hot-load or hot-reload instrumentation that replaces `console.error` during an active Kimi run. Restart the profile after changing instrumentation.

### Advanced: editing the config file directly

If you'd rather not do it inside Feishu, `/invite` and `/config` write the matching profile's `access` field in `~/.lark-channel/config.json`. Empty lists mean nobody from that list, not open access. This is a profile-field snippet; do not replace the whole `config.json` with it:

```json
{
  "schemaVersion": 2,
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "access": {
        "allowedUsers": ["ou_xxxxxxxxxxxxx"],
        "allowedChats": ["oc_xxxxxxxxxxxxx"],
        "admins": ["ou_xxxxxxxxxxxxx"],
        "requireMentionInGroup": true
      }
    }
  }
}
```

`allowedUsers` / `admins` take user `open_id`s; `allowedChats` takes group `chat_id`s. The easiest way to find an ID by hand: have the person message the bot (or `@` it in the group), then check the active profile's log:

```bash
grep '"event":"enter"' ~/.lark-channel/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

Each line carries `chatId` (group / DM id) and `senderId` (user `open_id`). After a manual edit, **restart the bridge** or send `/reconnect` from an allowed admin context to apply it. For day-to-day tweaks `/invite` / `/config` are easier; direct edits are mainly for deployment scripts that pre-seed access.

## Cloud-doc comments

Cloud-doc comments do not need a separate workspace binding or document allowlist. In supported document comments, mention the bot and the bridge replies in the same thread. Comment runs reuse the document session key and fall back to the user home directory when no document cwd was previously recorded. The Kimi ACP pilot does not process cloud-document comments.

## FAQ

**The bot stays silent or the local CLI never replies.** Usually the local `claude`, `codex`, or `kimi` CLI is not logged in, or the current session points to a working directory that no longer exists. Send `/status` to inspect; `/new` often fixes it by starting a fresh session.

**The agent subprocess looks frozen (card stuck on the last frame).** The bridge enables a 20-minute idle watchdog by default: if the agent emits no event during that window, the run is stopped and the card is annotated with the auto-termination reason. Tool calls are covered too, so a missing tool result cannot suspend the watchdog forever. Change the global value with `/config`, override the current session with `/timeout N`, use `/timeout off` for an exceptional long-silence run, or `/timeout default` to clear that override.

**The agent says it cannot see an image I sent.** Upgrade to the latest version. Releases before 0.1.0 had a filename-dedup bug.

## Testing and CI

Local checks:

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` includes unit, integration, and process-level adapter tests. CI runs on macOS, Ubuntu, and Windows with `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.

## Optional telemetry

By default the bridge reports **nothing**: no metrics, no logs leave your machine, and it pulls in zero telemetry dependencies. The hook below is inert unless you opt in.

To wire up your own monitoring, point an environment variable at a module that default-exports (or exports `createAdapter`) an `AdapterFactory`:

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package lark-channel-bridge start
```

That module receives every `log.*` event plus error/metric hooks and forwards them wherever you like. The interface is exported from the package root:

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from 'lark-channel-bridge';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* ship event */},
  recordError(err, ctx) {/* ship exception */},
  recordMetric(name, value, tags) {/* ship metric */},
  flush(timeoutMs) {/* drain buffered events */},
});
export default createAdapter;
```

A missing module, a bad factory, or a throwing adapter all degrade to noop — telemetry can never stop the bridge from starting or break logging.

## License

[MIT](./LICENSE)

<img src="./assets/feedback-group-qr.png" alt="Feedback group QR code" width="360">
