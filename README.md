# dsh-qq-bot

DeepSeek Harness 的 QQ 机器人桥接插件：通过 OneBot v11（NapCat）接入 QQ，**每个 QQ 私聊 / 群聊对应一个独立且可持久化的 DSH 会话**，支持预设工具、在 QQ 里完成工具授权、图片与文件接收，以及主人账号。

```
QQ <-> NapCat（OneBot v11 正向 WebSocket）<-> dsh-qq-bot <-> DSH 代理 + 会话
```

## 功能

- **一会话一聊天** —— `qq-private-<QQ号>` / `qq-group-<群号>`，重启后从磁盘恢复，空闲 30 分钟释放代理。
- **主人（owner）** —— 私聊与管理员命令归属一个 QQ 号，私聊发 `/owner <QQ号>` 设置。
- **群聊开放问答** —— 任何群成员 @ 机器人都能提问；群会话只给只读工具，陌生人无法写文件或执行命令。
- **一键安装 NapCat** —— 代理工具 `qqbot_install_napcat` 或双击 `安装NapCat.cmd`：下载 NapCat、写入 OneBot 配置、注册登录自启计划任务并启动。
- **在 QQ 里授权** —— `/y` 允许本次工具调用，`/n` 拒绝；超时无人应答按拒绝处理。
- **图片与文件** —— 自动下载到 `<工作目录>/qq-media/`，把路径交给模型读取。
- **命令** —— `/help`、`/owner`、`/new`、`/status`、`/reload`、`/stop`、`/id`、`/y`、`/n`。

## 安装

本地目录安装：

```powershell
# DSH → 设置 → 插件 → 添加插件，或：
# plugin_manager install_bundle  target: "C:\path\to\qq-bot"
```

从插件市场安装，在 **设置 → 插件 → Discover** 里添加索引：

```
https://cdn.jsdelivr.net/gh/chen7911012012-code/dsh-qq-bot@main/market-index.json
```

然后在 Discover 中安装 `dsh-qq-bot`。

## 配置 NapCat

运行插件自带的安装脚本（或者让代理调用 `qqbot_install_napcat`）：

```powershell
.\安装NapCat.cmd -Account <机器人QQ号>
```

脚本会安装 NapCat Shell、写入 `config\onebot11.json`（正向 WebSocket，`127.0.0.1:3001`）、注册登录时自启的 `NapCat-Bridge` 计划任务并启动。首次需要扫码登录机器人账号，之后任务会用 `-Account` 快速登录。

不使用脚本也可以：自行安装 NapCat，在网络配置里添加端口 `3001` 的 **WebSocket 服务器**。

## 配置项

默认值在 `cordis.patch.yml` 中；profile 的补丁行会整体替换配置。`~/.dsh/profiles/<profile>/.qq-bot/override.json` 可以单独覆盖某些字段，无需重启 Harness。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `wsUrl` | `ws://127.0.0.1:3001` | OneBot v11 正向 WebSocket 地址 |
| `owner` | `''` | 主人 QQ 号；留空时退回 `allowedUsers` |
| `allowedGroups` | `[]` | 允许应答的群号；留空表示全部群 |
| `groupAnyone` | `true` | 是否允许任意群成员提问 |
| `groupSessionTools` | 只读工具集 | 群会话可用的工具白名单 |
| `approvalMode` | `ask-qq` | `ask-qq`、`allow-all`、`deny-all` |

完整配置表与故障说明见 [docs/DETAIL.md](docs/DETAIL.md)。

## 发布更新

**每次改动这个插件都要同步发布到 GitHub**（约定见 [AGENTS.md](AGENTS.md)）。一条命令完成升版本、写 CHANGELOG、更新市场索引、提交并打 release：

```powershell
cd qq-bot
node tools/release.mjs --repo chen7911012012-code/dsh-qq-bot --bump patch --note "本次改了什么"
```

- `--bump patch|minor|major`：语义化版本；不写 `--bump` 则发布当前版本（只改文档时用）。
- `--no-release`：只提交、不打 tag。
- token 读取顺序：`--token` → `GITHUB_TOKEN` / `GH_TOKEN` → `%USERPROFILE%\.dsh-qq-bot-token`。

底层工具是 [tools/publish-github.mjs](tools/publish-github.mjs)：通过 GitHub REST API 上传改动过的文件（无需安装 git），只把**当前版本**的市场索引钉到本次提交，旧版本保持各自的发布快照。

## 已知限制

- 一键安装与计划任务仅支持 Windows；桥接本身在任何 Node 环境都能运行。
- 只支持正向 WebSocket（不支持反向 WS、纯 HTTP、Satori）。
- DSH 必须处于运行状态，只有 NapCat 不会回复消息。
- 会话写锁：在网页端打开机器人占用的会话可能报 `session/writer-held`，需要等代理释放。

MIT 许可，更新记录见 [CHANGELOG.md](CHANGELOG.md)。
