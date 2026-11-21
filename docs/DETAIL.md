# QQ 机器人桥接

把 QQ 机器人接到 DeepSeek Harness：通过 **OneBot v11**（NapCat / go-cqhttp / Lagrange），每个 QQ 私聊或群聊对应一个独立的、可持久化的 DSH 会话。QQ 里的对话就是普通 DSH 会话，网页端也能看到同一份记录。

## 它做什么

- 连接 OneBot v11 **正向 WebSocket**（默认 `ws://127.0.0.1:3001`），断线自动重连、退避。
- 每个聊天映射到一个 DSH 会话：`qq-private-<QQ号>-<时间戳>` 或 `qq-group-<群号>-<时间戳>`，映射关系存在 profile 目录的 `.qq-bot/state.json`。
- 首条消息建会话，重启或空闲超时后从磁盘恢复；默认空闲 30 分钟释放代理，历史仍在磁盘上。
- 为机器人会话挂载 DSH **代理预设**（默认使用 profile 的默认预设，通常是 `standard`），工具能力与网页端会话一致。
- 回复只取本轮最后一段助手文本，按 `replyChunkSize`（默认 1500 字）分条发送；群聊会 @ 提问者。
- 把 NapCat 提供的图片和文件下载到 `<工作目录>/qq-media/`，并把本地路径交给模型读取。
- 工具授权转发到 QQ：`/y` 允许本次调用，`/n` 拒绝；`approvalMode` 也支持 `allow-all` 与 `deny-all`。
- 一轮超过 `progressNoticeSeconds`（默认 12 秒）时先发一条「正在处理」提示。

## 命令

| 命令 | 作用 |
|---|---|
| `/help` | 列出命令。 |
| `/owner` | 查看当前主人。 |
| `/owner <QQ号>` | 设置主人；仅限私聊，且只有当前主人能更换。 |
| `/new` | 开新会话，旧会话保留在 DSH 列表。仅主人。 |
| `/status` | 连接、工作目录、会话 id、忙碌状态、模型、预设、授权模式、主人。仅主人。 |
| `/reload` | 释放并重新从磁盘加载当前会话。仅主人。 |
| `/stop` | 打断当前回合。仅主人。 |
| `/id` | 查看当前 DSH 会话 id。 |
| `/y`、`/n` | 同意或拒绝待处理的工具授权。 |

## 主人

设置 `owner`（或私聊发 `/owner <QQ号>`）后，该账号拥有机器人：

- 私聊只回应主人，其他人私聊直接忽略。
- 管理命令（`/new`、`/status`、`/reload`、`/stop`）只有主人能用，其他人会收到拒绝提示。
- 开启 `groupAnyone` 时群聊仍对所有人开放，但群会话只给只读工具，陌生人无法写文件或执行命令。

`owner` 为空时退回 `allowedUsers`（为空表示所有人可用），与 1.1 之前的行为一致。

## 一键安装 NapCat

两个入口跑同一套安装逻辑：

| 入口 | 用法 |
|---|---|
| 代理工具 `qqbot_install_napcat` | 让 Harness 安装或修复 NapCat；参数 `port`、`account`、`installDir`、`force`。 |
| 包内 `安装NapCat.cmd` | Windows 双击运行，自动请求提权。 |

安装脚本会：下载 NapCat Shell、解压（默认 `%USERPROFILE%\NapCat`）、写入 OneBot v11 正向 WebSocket 配置、注册 `NapCat-Bridge` 计划任务（登录触发、延迟 45 秒、最高权限）、删除会抢占登录的普通 QQ 自启项、并启动 NapCat。重复运行会复用已有安装，除非指定 `force`。

## 手动配置 NapCat

1. 安装并启动 NapCat，用要当机器人的 QQ 号登录。
2. 在网络配置里添加端口 `3001` 的 **WebSocket 服务器**（OneBot v11 正向 WebSocket：NapCat 监听，插件连接）。若设置了 token，把它填进 `accessToken`。
3. 保持 Harness 运行。桥接日志出现 `connected` 后，给机器人发消息即可。

不支持反向 WebSocket、纯 HTTP 和 Satori；本插件只作为 WebSocket 客户端。

## 配置

配置由 profile 中 `qq-bot` 这一行承载，默认值在本包的 `cordis.patch.yml`。修改方式是在 profile 的 `cordis.patch.yml` 里加一行再重启 Harness：

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

行覆盖会整体替换 `config`，要保留的字段都得重写一遍。

### 无需重启的覆盖

profile 补丁改动要重启 Harness 才生效。插件另外读取 `<profile>/.qq-bot/override.json`，其中的字段优先于行配置：

```json
{ "allowedUsers": ["3645411938"], "allowedGroups": [], "groupAnyone": true, "owner": "3645411938" }
```

保存后在「插件」里把该插件关掉再打开即可生效。文件可缺省，缺失或格式错误时回退到行配置。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `wsUrl` | `ws://127.0.0.1:3001` | OneBot v11 正向 WebSocket 地址。 |
| `accessToken` | `''` | 以 `access_token` 查询参数发送的 token。 |
| `workdir` | `<profile>/qq-workspace` | 会话工作目录，不存在时创建。 |
| `allowedUsers` | `[]` | 未设置 `owner` 时允许的 QQ 号；为空表示所有人。 |
| `allowedGroups` | `[]` | 允许应答的群号；为空表示所有群。 |
| `groupAnyone` | `true` | `true` 时任何群成员 @ 即可提问；`false` 时仅主人可问。 |
| `owner` | `''` | 机器人主人 QQ 号：私聊与管理命令。为空时退回 `allowedUsers`。 |
| `groupSessionTools` | 只读工具集 | 群会话的工具白名单，避免开放群里写文件、执行命令；为空则不做限制。 |
| `groupMentionRequired` | `true` | 群聊必须 @ 机器人才应答。 |
| `approvalMode` | `ask-qq` | `ask-qq` 在 QQ 里询问，`allow-all` 全放行，`deny-all` 全拒绝。 |
| `idleTimeoutMinutes` | `30` | 空闲多少分钟释放代理。 |
| `progressNoticeSeconds` | `12` | 多久后发「正在处理」提示；`0` 关闭。 |
| `replyChunkSize` | `1500` | 单条 QQ 消息最大字数。 |
| `allowedTools` | `[]` | 机器人代理的工具白名单；为空表示全部。 |
| `provider`、`model` | `''` | 固定模型路由；为空跟随 DSH 默认。 |
| `preset` | `''` | 机器人会话使用的代理预设；为空用默认预设。 |
| `approvalTimeoutSeconds` | `180` | 授权请求的有效期。 |
| `napcatInstallDir` | `''` | 一键安装的目标目录；为空表示 `%USERPROFILE%\NapCat`。 |
| `napcatPort` | `3001` | 一键安装写入 NapCat 配置的端口。 |

## 发布与更新

仓库镜像本包。**每次改动都要同步发布**，一条命令完成升版本、写更新记录、更新市场索引、提交并打 release：

```powershell
node tools/release.mjs --repo chen7911012012-code/dsh-qq-bot --bump patch --note "本次改了什么"
```

底层是 [tools/publish-github.mjs](../tools/publish-github.mjs)：通过 GitHub REST API 上传改动文件（无需安装 git），创建仓库、按需删除已移除文件（`--delete`），并且只把**当前版本**的市场索引钉到本次提交，旧版本保持各自的发布快照。token 读取顺序：`--token` → `GITHUB_TOKEN` → `%USERPROFILE%\.dsh-qq-bot-token`。

把发布后的 `market-index.json` 地址（或 jsDelivr 镜像 `https://cdn.jsdelivr.net/gh/owner/dsh-qq-bot@main/market-index.json`）加到 **设置 → 插件 → Discover** 的索引里，其他用户就能在市场里安装。

## 限制

- 需要运行中的 OneBot v11 实现；插件本身不登录 QQ。
- Harness 必须在运行；关闭期间 QQ 消息不会排队。
- 机器人代理持有会话写锁，网页端打开同一会话可能报 `session/writer-held`，需等代理释放（`/new`、`/reload` 或空闲超时）。
- 授权请求无人应答时，超时后按拒绝处理。
- 语音不转写；视频、卡片、XML/JSON 消息会变成文字占位。
- 开启 `groupMentionRequired` 时，群里不带 @ 的消息会被忽略，也不会存入任何地方。
- 诊断日志写在 profile 目录的 `.qq-bot/bridge.log`。
