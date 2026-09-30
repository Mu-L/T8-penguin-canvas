# v3.2.2 数据目录迁移发布

日期：2026-09-30。固定源码/Tag：`beadec0a151cd03048b96d0f0e6c4eb1a45c0399` / `v3.2.2`。Windows 唯一正式构建及 [Latest 发布](https://github.com/T8mars/T8-penguin-canvas/releases/tag/v3.2.2)、Mac [同源 workflow 36689980893](https://github.com/T8mars/T8-penguin-canvas/actions/runs/36689980893) 均成功，非草稿、非预发布。六资产齐全，本机独立 Mac 三资产和追加后的 Windows 三资产完整回下载通过，两个更新清单 SHA-512 一致；外部证据按授权后补。

范围与本地验证见[数据目录专题](desktop-data-storage.md)；保留 v3.2.1 全部保护。Windows 正式链完成构建、加密、运行时、native rebuild、NSIS、8 项 asar 启动合同、安全与私有扩展检查、provenance、sealed recovery。三资产完整回下载与更新清单 SHA-512 通过，发布恢复记录已清除；源/core 两份保护文件散列不变。后续事实提交不得移动 Tag 或重建包。

| Windows 资产 | 字节 | SHA-256 |
| --- | ---: | --- |
| `T8-PenguinCanvas-Setup-3.2.2.exe` | 1,375,888,997 | `3e1013fd37482311fa4640774b81f5f4eb5bc45e4229b16d0f72fb895fd89f11` |
| `T8-PenguinCanvas-Setup-3.2.2.exe.blockmap` | 1,434,964 | `35eae736bcdd14de5ad3aec09739042b08c29e59dc4f475d5ac19b75d221c6da` |
| `latest.yml` | 362 | `067d3b111cf05a1cb56b92dd339984e53a9a8a0c20576b65f2a9f7894f2d760f` |

Mac runner 已完成同源原生构建、ad-hoc 签名、DMG/ZIP/更新清单、追加上传与完整回下载；本机独立复核再次完整下载三资产并核对 ZIP size/SHA-512。Windows 追加前后字节与散列不变。Mac 未使用 Apple Developer ID，未公证，不冒称 Apple 已认证版本。

| Mac 资产 | 字节 | SHA-256 |
| --- | ---: | --- |
| `T8-PenguinCanvas-3.2.2-mac-arm64.dmg` | 514,587,300 | `7388b3d223d6289993dd56e6d83b67cd862e5c08b6f68f9f330bf4d3928030ee` |
| `T8-PenguinCanvas-3.2.2-mac-arm64.zip` | 506,474,932 | `f554afd84bb8a396b2719804d50f5210f756df5f50228ac0cc521fd86164dad5` |
| `latest-mac.yml` | 536 | `f4bd9193f114fa4c3cb9db2a32209d5f74c8b3672976cf39c2928ef577d0fe2c` |

仓库为公开仓库，标准 macos-15 runner 的运行分钟按 [GitHub 规则](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 免费；账单接口当前权限不足不能读取，不冒称已读取账号余额。实际 workflow 成功，本轮未因额度延期 Mac。

发布后补充机制检查：在系统临时目录新建真实 schema32 SQLite 库、画布和备份，关闭后由正式迁移模块复制到另一目录并重新打开，画布文档与恢复代次完全相同。临时夹具已清理；该检查不等同于真实用户旧库或物理跨盘安装版验收。

真实安装升级、跨物理盘、大容量断电及 F8–F10 仍未验收，按 `owner-approved-post-release-v3.2.2` 延后；不能用临时目录测试替代。
