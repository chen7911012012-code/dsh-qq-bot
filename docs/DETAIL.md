# QQ bot bridge

Connects a QQ bot to DeepSeek Harness through **OneBot v11** (NapCat, go-cqhttp, Lagrange). Every QQ private chat or group gets its own persistent DSH session, so a conversation in QQ is an ordinary session that also appears in the Harness session list.

## What it does

- Connects to a OneBot v11 **forward WebSocket** endpoint (default `ws://127.0.0.1:3001`) and reconnects automatically with backoff.
- Maps each chat to a DSH session: `qq-private-<QQ号>-<时间戳>` or `qq-group-<群号>-<时间戳>`. The mapping is stored in `.qq-bot/state.json` in the profile directory.
- Creates the session on the first message, resumes it from disk after a restart or after the idle timeout, and disposes idle agents (default 30 minutes) so memory is freed while history stays on disk.
- Mounts a DSH **agent preset** for the bot's sessions (default: the profile's default preset, normally `standard`), so the bot has the same tools a Web session has.
- Replies with the assistant's final text of the turn, split into chat-sized chunks (default 1500 characters), and @-mentions the sender in groups.
- Downloads images and files that NapCat serves into `<workdir>/qq-media/` and tells the assistant the local path, so it can read them with its own tools.
- Forwards tool approval requests to the QQ chat: `/y` allows the call once, `/n` rejects it. Group and private chats are handled the same way.
- Sends a progress notice when a turn runs longer than `progressNoticeSeconds` (default 12 seconds).

## Commands

| Command | Effect |
|---|---|
| `/help` | List the commands. |
| `/owner` | Show the current owner. |
| `/owner <QQ号>` | Set the owner; private chat only, and only the current owner may replace one. |
| `/new` | Start a new conversation; the previous session stays in the Harness session list. Owner only. |
| `/status` | Connection, workdir, session id, busy state, model, preset, approval mode, owner. Owner only. |
| `/reload` | Dispose the live agent and reload the session from disk. Owner only. |
| `/stop` | Cancel the turn that is currently running. Owner only. |
| `/id` | Show the current DSH session id. |
| `/y`, `/n` | Answer a pending tool approval request. |

## Owner

Once `owner` is set (or `/owner <QQ号>` is used in private chat), that account owns the bot:

- Private chat answers only the owner; every other private sender is ignored.
- Admin commands (`/new`, `/status`, `/reload`, `/stop`) accept the owner only; other users get a refusal.
- Groups keep working for everyone when `groupAnyone` is on, but their sessions stay read-only, so a stranger cannot write files or run commands.

With `owner` empty, the plugin falls back to `allowedUsers` (empty means everyone), which is the pre-1.1 behaviour.

## One-click NapCat install

Two entry points run the same installer:

| Entry point | Use |
|---|---|
| Agent tool `qqbot_install_napcat` | Ask the Harness to install or repair NapCat; arguments: `port`, `account`, `installDir`, `force`. |
| `安装NapCat.cmd` in the package | Double-click on Windows; prompts for elevation. |

The installer downloads NapCat Shell, extracts it (default `%USERPROFILE%\NapCat`), writes the OneBot v11 forward WebSocket config, registers the `NapCat-Bridge` scheduled task (logon trigger, 45 s delay, highest privileges), removes the conflicting plain-QQ autostart entry, and starts NapCat. Re-running it reuses an existing installation unless `force` is set.

## Setting up NapCat manually

1. Install and start NapCat, then log in with the QQ account that should act as the bot.
2. In NapCat's network settings add a **WebSocket server** entry on port `3001` (this is the OneBot v11 *forward* WebSocket: NapCat listens and the bridge connects to it). If you enable a token, put the same token in `accessToken`.
3. Keep the Harness running. The bridge log reports `connected`, and a message to the bot then produces a reply.

Reverse WebSocket, HTTP-only and Satori transports are not implemented; the bridge is a WebSocket client only.

## Configuration

The plugin row `qq-bot` carries its configuration. The bundle's own default lives in its `cordis.patch.yml`; to change a value, add a row to the profile's `cordis.patch.yml` and restart the Harness:

```yaml
- id: qq-bot
  name: '@local/dsh-qq-bot'
  config:
    wsUrl: 'ws://127.0.0.1:3001'
    accessToken: ''
    workdir: ''
    allowedUsers: ['123456789']
    allowedGroups: ['987654321']
    groupMentionRequired: true
    approvalMode: ask-qq
    idleTimeoutMinutes: 30
    progressNoticeSeconds: 12
    replyChunkSize: 1500
    allowedTools: []
    groupAnyone: true
    owner: '123456789'
    napcatInstallDir: ''
    napcatPort: 3001
    provider: ''
    model: ''
    preset: ''
```

A row override replaces the whole `config`, so repeat every field you want to keep.

### Live overrides without a restart

A profile patch change only takes effect after the Harness restarts. For faster edits, the plugin also reads `<profile>/.qq-bot/override.json`, whose fields win over the row config for every key it names:

```json
{ "allowedUsers": ["3645411938"], "allowedGroups": [], "groupAnyone": true }
```

Save the file, then disable and re-enable the plugin row in the Plugin Manager to apply it. The file is optional; a missing or malformed file falls back to the row config.


| Field | Default | Meaning |
|---|---|---|
| `wsUrl` | `ws://127.0.0.1:3001` | OneBot v11 forward WebSocket endpoint. |
| `accessToken` | `''` | Token sent as `access_token` in the query string. |
| `workdir` | `<profile>/qq-workspace` | Session working directory, created when missing. |
| `allowedUsers` | `[]` | QQ numbers allowed when no `owner` is set; empty allows everyone. |
| `allowedGroups` | `[]` | Group numbers the bot answers in; empty allows every group. |
| `groupAnyone` | `true` | `true` lets any group member @ the bot and get an answer; `false` limits group questions to the owner. |
| `owner` | `''` | QQ number that owns the bot: private chat, admin commands. Empty falls back to `allowedUsers`. |
| `napcatInstallDir` | `''` | Installer target; empty means `%USERPROFILE%\NapCat`. |
| `groupSessionTools` | read-only set | Tool allowlist for group sessions, so open group questions cannot write files or run commands. Empty keeps every tool. |
| `groupMentionRequired` | `true` | Only answer group messages that @ the bot. |
| `approvalMode` | `ask-qq` | `ask-qq` asks in the chat, `allow-all` allows every request, `deny-all` rejects every request. |
| `idleTimeoutMinutes` | `30` | Idle minutes before the agent is disposed. |
| `progressNoticeSeconds` | `12` | Delay before a "working" notice; `0` disables it. |
| `replyChunkSize` | `1500` | Maximum characters per outgoing QQ message. |
| `allowedTools` | `[]` | Tool allowlist for bot agents; empty keeps every tool. |
| `provider`, `model` | `''` | Pin a route; empty follows the DSH default model. |
| `preset` | `''` | Agent preset for bot sessions; empty uses the profile default. |
| `approvalTimeoutSeconds` | `180` | How long an approval question stays open. |
| `napcatPort` | `3001` | Port the one-click installer writes into NapCat's OneBot config. |

## Publishing and updates

The repository mirrors this bundle, and `tools/publish-github.mjs` keeps it in sync through the GitHub REST API — no git installation needed:

```powershell
$env:GITHUB_TOKEN = '<personal access token with repo scope>'
node tools/publish-github.mjs --repo owner/dsh-qq-bot --message "release: 1.1.0"
```

It creates the repository when missing, uploads only changed files, optionally deletes files that are gone (`--delete`), and re-pins every Git entry in `market-index.json` to the commit it just produced. The token is read from `--token`, `GITHUB_TOKEN`, or `%USERPROFILE%\.dsh-qq-bot-token`.

Add the published `market-index.json` URL (or its jsDelivr mirror, `https://cdn.jsdelivr.net/gh/owner/dsh-qq-bot@main/market-index.json`) as an index in **Settings → Plugins → Discover** so other users can install the plugin from the market. The same file documents the only required step for an update: bump `version` in `package.json`, add a `versions` entry, run the publish script.

## Requirements and limitations

- A running OneBot v11 implementation is required; the plugin never logs in to QQ itself.
- The Harness Host must be running. Messages sent while it is closed are not queued by QQ.
- The bot agent holds the session's write handle, so opening that session in the Web UI can fail with `session/writer-held` until the agent is disposed (`/new`, `/reload`, or the idle timeout).
- Approval requests that nobody answers are rejected after `approvalTimeoutSeconds`.
- Voice messages are not transcribed; video, card, and XML/JSON messages become text placeholders.
- A group message with no @ is ignored when `groupMentionRequired` is on, but it is still not stored anywhere.
- Diagnostic output is appended to `.qq-bot/bridge.log` in the profile directory.
