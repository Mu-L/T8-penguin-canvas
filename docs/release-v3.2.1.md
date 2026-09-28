# v3.2.1 schema32 画布恢复发布

日期：2026-09-29。已从固定源码 `2dc205dfe6dc743195eeb5aa57db27c0da1fa29f` / `v3.2.1` 完成 [GitHub Latest Release](https://github.com/T8mars/T8-penguin-canvas/releases/tag/v3.2.1)。修复同一数据库的可验证旧 canonical backup 因写入水位或恢复代次落后导致的只读加载阻断；Tag 不移动。

## 固定范围

- 画布加载失败时提供有期限的一次性恢复方案，明确提示可能舍弃的已确认数据库写入次数；必须由用户确认。
- 后端只接受服务端持有的精确恢复授权，重新核验 UUID、收据、ACK、代次与水位，保留故障主库证据并推进 ACK。
- 保留 v3.2.0 及更早功能。无法验证的备份和异库数据仍停止恢复。

## 发布前证据

- schema32 恢复 20/20、物理故障矩阵 7/7、owner guard 8/8、Canvas 加载与 freshness 11/11、真实 HTTP 恢复确认 1/1；TypeScript、公开目录、能力同步与开发态生产构建通过。
- 数据库用例只使用并清理系统临时夹具；真实受影响用户旧库、安装升级与 F8–F10 证据按 `owner-approved-post-release-v3.2.1` 后补，不视为通过。

## 正式发布结果

- Windows 固定源码的正式链完成生产构建、后端加密、两份离线运行时、Electron 原生模块重编、NSIS、7 文件 `app.asar` 启动合同、私有扩展检查、provenance、sealed recovery、上传和发布前完整回下载。首次高压缩 NSIS 的旧 `7za` 访问冲突未生成正式包；沿用同一未封印恢复记录，以 `ELECTRON_BUILDER_COMPRESSION_LEVEL=0` 完成唯一有效正式包。恢复记录已清除。
- 真实 Apple Silicon [workflow 36477586509](https://github.com/T8mars/T8-penguin-canvas/actions/runs/36477586509) 于 `2026-09-28T20:19:48Z` 成功：同 Tag/源码、私有源恢复、原生依赖、ad-hoc 签名技术预览、DMG/ZIP/`latest-mac.yml`、追加上传和 runner 完整回下载。本机独立 Mac 三资产完整回下载，以及 Mac 追加后的 Windows 三资产再次完整回下载均通过。GitHub 额度足够，没有延期 Mac。
- Release 非草稿、非预发布且为 Latest；Windows 与 Mac 均绑定上述同一 40 位源码提交。Mac 未使用 Apple Developer ID 签名或公证，不能称为 Apple 已认证版本；真实受影响用户旧库、安装升级与 F8–F10 仍按授权后补，不视为通过。

| 资产 | 字节 | SHA-256 |
| --- | ---: | --- |
| `T8-PenguinCanvas-Setup-3.2.1.exe` | 1,378,626,592 | `31894c1da71167d6bfda2961bbce5fef37d5a188207aaaab07fc1aa941cbede3` |
| `T8-PenguinCanvas-Setup-3.2.1.exe.blockmap` | 1,437,813 | `09c6cabf58ac403cda45a6b7698228ef132f921872646215c21a08d07911daf8` |
| `latest.yml` | 362 | `a650479da6a53d7250e58e8c90924c2c61c5f342c1a6246380b15aa0d5975eef` |
| `T8-PenguinCanvas-3.2.1-mac-arm64.dmg` | 514,400,308 | `f105f9cd530a981db8c986fbec46f3b4b8b2a838de9d3e4ad1ffa9ddb54dc398` |
| `T8-PenguinCanvas-3.2.1-mac-arm64.zip` | 506,469,502 | `5bd4a1db9d8aa218e2f254b2e20d195d4972dbc6aac7ab96d9c1ca1d189eb63f` |
| `latest-mac.yml` | 536 | `31eb50335a47098e9f35e1296f9b9fd82fad4ef5001b9eda9dccee7d7c6df72d` |
