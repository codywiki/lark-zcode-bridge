# lark-zcode-bridge

A lightweight bot that bridges Feishu / Lark messenger with your local **ZCode CLI** (the bundled headless runtime inside the [ZCode](https://zcode.ai/) desktop app, powered by GLM Coding Plan). Run one command, scan a QR code to bind a PersonalAgent app, and talk to ZCode from chat.

[中文 README](./README.zh.md)

> Community project — not an official Feishu/Lark or ZCode product. Forked from [lark-channel-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) (MIT), trimmed to a single-agent bridge dedicated to ZCode. Platform support: **macOS, Windows, and Linux** — the bridge locates the ZCode desktop app's bundled runtime on each OS (override with `LARK_ZCODE_BRIDGE_RUNTIME_PATH`).

## What it does

- Forwards Feishu / Lark messages to the local ZCode CLI. Send a DM directly, or `@bot` in a group.
- **Cross-platform**: runs on macOS, Windows, and Linux — the bridge auto-detects the ZCode app's bundled runtime on each OS and manages a per-profile background service (launchd / systemd / Task Scheduler).
- **Streaming card**: replies update on one Lark card in real time, with a bounded plain-text completion summary at the end of every run.
- **Session continuity**: each chat, topic, or document comment thread keeps its own ZCode session (`--resume sess_<id>`).
- **Queueing and batching**: messages sent in quick succession are handled together; messages sent during a run are queued, while commands like `/new`, `/cd`, and `/stop` can interrupt the current task.
- **Multiple workspaces**: use `/cd` to switch the current project, and `/ws` to save and reuse common project directories.
- **Images and files**: send them to the bot directly; the bridge downloads them locally and passes them to ZCode via `--attach`. Attachments inside quoted and merged-forward messages are resolved too.
- **Cloud-doc comments**: `@bot` in a document comment thread and the bridge answers with the document fetched in as context, posting the reply back into the thread.
- **Model and reasoning control**: switch the main model with `/model` and the per-request reasoning effort with `/effort`.
- **Isolated ZCode home**: every profile runs with its own `HOME` (`~/.lark-zcode-bridge/profiles/<name>/zcode-home`), so the bridge never touches your real `~/.zcode` or live API key.
- **Interactive cards**: `/help`, `/ws list`, and `/status` return cards with clickable buttons.

## Prerequisites

- Node.js **>= 20.12.0**
- The **ZCode desktop app** installed. The bridge drives the app's bundled runtime, located automatically per platform — `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` on macOS, `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs` (or a `Program Files` install) on Windows, and `/opt/ZCode/resources/glm/zcode.cjs` on Linux. Set `LARK_ZCODE_BRIDGE_RUNTIME_PATH` for non-standard installs.
- A **GLM Coding Plan** API key (BigModel or z.ai).
- A Feishu / Lark **PersonalAgent** app. The first-run QR wizard can create and bind one for you.

## Install

```bash
npm i -g lark-zcode-bridge
# or
pnpm add -g lark-zcode-bridge
```

## First run

```bash
lark-zcode-bridge run
```

The wizard walks you through creating/binding the PersonalAgent app (QR scan), then starts the bridge in the foreground. To keep it running across logouts, install the per-profile service with `lark-zcode-bridge start` (launchd on macOS, a systemd user unit on Linux, Task Scheduler on Windows); `lark-zcode-bridge stop` / `restart` manage it.

### Configure the model API key

Each profile gets an **isolated ZCode home** (`~/.lark-zcode-bridge/profiles/<name>/zcode-home`) — the bridge never reads or writes your real `~/.zcode`. Fill the key once per profile:

```bash
lark-zcode-bridge profile login zcode      # prompts for the API key
# or non-interactively:
ZCODE_API_KEY=<key> lark-zcode-bridge profile login zcode
```

The generated model config targets BigModel Coding Plan (`glm-5.2` main, `glm-5-turbo` lite). Switch the main model in chat with `/model glm-5-turbo` and the reasoning effort with `/effort high` (`max`/`high`/`nothink`, default `max`), or edit `zcode-home/.zcode/cli/config.json` for full control (custom providers, z.ai base URL, etc.).

## Permissions

ZCode profiles default to **full access**: every run passes `--mode yolo`, so the agent can read and write any directory and execute commands without per-action approval — it is not restricted to the selected workspace. This mirrors the upstream bridge's `bypassPermissions` posture and is deliberate for a personal bot: the bridge-level access control (`allowedUsers` / `allowedChats`) decides *who* can run the bot at all.

To lower the ceiling, edit the profile config (`~/.lark-zcode-bridge/config.json`):

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

Set both to `"workspace"` for `--mode build` (workspace read/write) or `"read-only"` for `--mode plan` (read-only planning). The legacy `sandbox` field is derived from `permissions`; do not configure it directly.

## Access control

The bot is owner-only by default. The owner can open access from chat:

- `/invite user @someone` — allow a user; `/remove user @someone` — revoke
- `/invite group` — allow the current group; `/remove group` — revoke
- `/invite all group` — allow every group the bot is in

Chat commands cannot expand this allowlist beyond owner-driven changes, and config-file edits win on restart. Cloud-doc comments are document-scoped: anyone who can comment on the document and @-mentions the bot can start a run there, so share bots' documents accordingly.

## Workspaces

Each run resolves exactly one canonical working directory — the currently selected one. `/cd <path>` switches it; `/ws save|use|list|remove` manages named shortcuts. The profile's fallback is `workspaces.default` in the config (created under `~/.lark-zcode-bridge-workspaces/<profile>/default` on first run).

## Profiles

Multiple bot apps can run side by side as named profiles, each with its own config, sessions, secrets, and service:

- `lark-zcode-bridge profile list|create|use <name>` — manage profiles
- `lark-zcode-bridge profile export <name>` — export a profile; `--include-secrets --yes` also exports the app secret and secret-provider configuration (handle the export as a secret)
- `lark-zcode-bridge profile remove <name>` — archive a profile's state; `--purge --yes` deletes it permanently

### lark-cli identity policy

The bridge projects a profile-local lark-cli directory (`profiles/<name>/lark-cli/`) so agent runs can call `lark-cli` back into Feishu under the bridge's own bot identity. The lark-cli identity policy (strict-mode / default-as) is applied inside that directory; the user's personal lark-cli config is never touched.

## Commands in chat

- `/new` (or `/reset`) — start a fresh session
- `/cd <path>` — switch workspace; `/ws list|use|save` — manage saved workspaces
- `/status` — current session, cwd, permission mode
- `/model <id>` — switch the profile's main model (`/model <id> <max|high|nothink>` also sets reasoning effort)
- `/effort <max|high|nothink>` — switch the session's reasoning effort (per-request; does not reset the session)
- `/resume` — resume the current catalog-tracked session
- `/stop` — interrupt the running task
- `/timeout <minutes>` — set the per-run timeout
- `/doctor` — run a self-check of the profile's runtime and config
- `/ps` — list running tasks
- `/help` — full command card

## Configuration root

All state lives under `~/.lark-zcode-bridge/` (override with `LARK_ZCODE_BRIDGE_HOME`). This is deliberately separate from `lark-channel-bridge`'s `~/.lark-channel/` so the two bridges can run side by side without clobbering each other's config.

## Development

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest: unit + integration + process
pnpm build       # tsup → dist/
```

## Acknowledgements

Built on [lark-channel-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) by zarazhangrui and contributors (MIT), and modeled after the sibling fork lark-kimi-bridge, which applied the same single-agent treatment to Kimi Code CLI.

## License

MIT — see [LICENSE](./LICENSE).
