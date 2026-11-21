# 更新记录

## 1.1.0 — 2026-11-21

- **一键安装 NapCat**：新增代理工具 `qqbot_install_napcat` 与 `安装NapCat.cmd`，可自动下载 NapCat Shell、写入 OneBot v11 配置、注册登录自启计划任务、清理抢占登录的普通 QQ 自启项并启动。
- **主人（owner）**：新增 `owner` 配置与 `/owner [QQ号]` 命令；设置后私聊只回应主人，`/new`、`/status`、`/reload`、`/stop` 仅主人可用，`/status` 会显示当前主人。
- **GitHub 同步**：新增 `tools/publish-github.mjs`，通过 GitHub REST API 上传插件（无需安装 git），后续改动一条命令即可同步，并自动把市场索引钉到对应提交。
- 群聊行为不变：任何成员都可 @ 机器人提问，群会话仍为只读工具。

## 1.0.0 — 2026-11-18

首个版本：OneBot v11 正向 WebSocket 桥接，每个 QQ 聊天对应一个持久化 DSH 会话，支持重启恢复、图片与文件下载、在 QQ 内转发工具授权（`/y`、`/n`），以及 `/help`、`/new`、`/status`、`/reload`、`/stop`、`/id` 命令、群聊 @ 应答与只读工具策略。
