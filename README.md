# dsh-qq-bot

A DeepSeek Harness bundle that bridges a QQ bot (OneBot v11 / NapCat) into DSH sessions: **one persistent session per QQ private chat or group**, with an agent preset, tool approvals answered in QQ, image/file intake, and an owner account.

```
QQ <-> NapCat (OneBot v11 forward WebSocket) <-> dsh-qq-bot <-> DSH agent + session
```

## Features

- **One session per chat** — `qq-private-<QQ号>` / `qq-group-<群号>`, resumed from disk after a restart, idle agents disposed after 30 minutes.
- **Owner (`主人`)** — private chat and admin commands belong to one QQ number; `/owner <QQ号>` sets it from private chat.
- **Open group Q&A** — any member may @ the bot; group sessions are limited to read-only tools so strangers cannot write files or run commands.
- **One-click NapCat install** — the `qqbot_install_napcat` tool and `安装NapCat.cmd` download NapCat, write the OneBot config, register the logon scheduled task, and start it.
- **Approvals in chat** — `/y` allows one tool call, `/n` rejects it; unanswered requests fail closed.
- **Images and files** — downloaded into `<workdir>/qq-media/` and handed to the model as paths.
- **Commands** — `/help`, `/owner`, `/new`, `/status`, `/reload`, `/stop`, `/id`, `/y`, `/n`.

## Install

From a local directory:

```powershell
# DSH → Settings → Plugins → Add plugin, or:
# plugin_manager install_bundle  target: "C:\path\to\qq-bot"
```

From the plugin market, add this index in **Settings → Plugins → Discover**:

```
https://cdn.jsdelivr.net/gh/chen7911012012-code/dsh-qq-bot@main/market-index.json
```

Then install `dsh-qq-bot` from Discover.

## Set up NapCat

Run the bundled installer (or ask the Harness to call `qqbot_install_napcat`):

```powershell
.\安装NapCat.cmd -Account <机器人QQ号>
```

It installs NapCat Shell, writes `config\onebot11.json` (forward WebSocket on `127.0.0.1:3001`), registers the `NapCat-Bridge` scheduled task with a logon trigger, and starts it. Sign in with the bot account by QR code the first time; afterwards the task quick-logs-in with `-Account`.

Without the installer: install NapCat yourself and add a **WebSocket server** entry on port `3001`.

## Configure

Defaults live in `cordis.patch.yml`; a profile patch row replaces the whole config. `~/.dsh/profiles/<profile>/.qq-bot/override.json` overrides individual keys without restarting the Harness.

| Field | Default | Meaning |
|---|---|---|
| `wsUrl` | `ws://127.0.0.1:3001` | OneBot v11 forward WebSocket endpoint |
| `owner` | `''` | Owner QQ number; empty falls back to `allowedUsers` |
| `allowedGroups` | `[]` | Groups the bot answers in; empty allows all |
| `groupAnyone` | `true` | Let any group member ask |
| `groupSessionTools` | read-only set | Tool allowlist for group sessions |
| `approvalMode` | `ask-qq` | `ask-qq`, `allow-all`, `deny-all` |

Full tables and failure modes: [docs/DETAIL.md](docs/DETAIL.md).

## Publishing updates

```powershell
$env:GITHUB_TOKEN = '<token with repo scope>'
node tools/publish-github.mjs --repo owner/dsh-qq-bot --message "release: 1.1.0"
```

Uploads changed files through the GitHub REST API (no git needed) and re-pins `market-index.json` to the produced commit.

## Limitations

- Windows-oriented: the one-click installer and scheduled task are Windows-only; the bridge itself runs anywhere Node does.
- The forward WebSocket is the only transport (no reverse WS, HTTP, or Satori).
- The Harness must be running for replies; NapCat alone does not answer.
- Session write ownership: opening a bot session in the Web UI can fail with `session/writer-held` until the agent is disposed.

MIT licensed. See [CHANGELOG.md](CHANGELOG.md).
