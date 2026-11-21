# 工作区约定

## qq-bot 插件（`C:\Users\Administrator\.dsh\profiles\desktop\qq-bot`）

这个目录是 **dsh-qq-bot** 插件的源码，GitHub 仓库为 `chen7911012012-code/dsh-qq-bot`。

**每次改动这个插件（代码、文档、配置模板、安装脚本）之后，都必须同步发布到 GitHub，不需要再问用户。**

一条命令完成：升版本 → 更新 CHANGELOG 与市场索引 → 提交 → 打 release。

```powershell
cd C:\Users\Administrator\.dsh\profiles\desktop\qq-bot
node tools/release.mjs --repo chen7911012012-code/dsh-qq-bot --bump patch --note "一句话说明这次改了什么"
```

- 只改文档、不改行为：`--bump patch` 仍然可以，或者 `--no-release` 只提交不打 tag。
- 大改动用 `--bump minor`，破坏性改动用 `--bump major`。
- CHANGELOG 用中文；市场索引里的 commit 由脚本自动钉到本次提交，不要手写。
- token 读取顺序：`--token` → `GITHUB_TOKEN` / `GH_TOKEN` → `%USERPROFILE%\.dsh-qq-bot-token`。

发布前必须做的检查：

1. `node --check` 语法检查改动过的 `.js`；
2. 插件已在本机加载并跑通（必要时禁用/启用插件重载）；
3. 发布后看脚本输出，确认「pinned market-index.json to …」和「release created: vX.Y.Z」都出现。

## 本机运行环境（仅供参考）

- 插件目录：`C:\Users\Administrator\.dsh\profiles\desktop\qq-bot`
- 运行日志：`C:\Users\Administrator\.dsh\profiles\desktop\.qq-bot\bridge.log`
- 配置覆盖：`C:\Users\Administrator\.dsh\profiles\desktop\.qq-bot\override.json`
- NapCat：`C:\Users\Administrator\NapCat`，计划任务 `NapCat-Bridge`
