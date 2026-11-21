# Changelog

## 1.1.0 — 2026-11-21

- **One-click NapCat install**: `qqbot_install_napcat` tool and `安装NapCat.cmd` download NapCat Shell, write the OneBot v11 config, register the logon scheduled task, drop the conflicting QQ autostart entry, and start it.
- **Owner (`主人`)**: `owner` config plus `/owner [QQ号]`; private chat is owner-only once set, admin commands (`/new`, `/status`, `/reload`, `/stop`) are owner-only, and `/status` reports the owner.
- **GitHub publishing**: `tools/publish-github.mjs` uploads the bundle through the GitHub REST API with no git installation, so later edits can be synced with one command.
- Group behaviour unchanged: any member may @ the bot; group sessions stay read-only.

## 1.0.0 — 2026-11-18

First release: OneBot v11 forward WebSocket bridge, one persistent DSH session per QQ chat, resume after restart, image/file download, approval forwarding (`/y`, `/n`), `/help`, `/new`, `/status`, `/reload`, `/stop`, `/id`, group @ handling, and read-only group tool policy.
