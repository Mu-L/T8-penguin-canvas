# v3.1.9 Creator 设置可靠性发布

日期：2026-09-18。用户明确授权版本升级、正式 Electron 打包、GitHub 新版本与自动更新 Release；外部证据后补，Mac 仅在 GitHub 额度不足时延期。

## 范围与发布前验证

- 仅纳入 [Creator 事件生命周期修复与 Issues 审计](github-issues-20260918.md)，不改变 Provider、模型、默认值、端口、数据库或旧画布。
- 真实处理器修复前复现、修复后 3/3 与锁定 Electron 五套回归 99/99 通过；TypeScript 在 BelowNormal / 2 GiB 堆上限通过，首次人为 768 MiB 堆上限 OOM 未记通过。
- 授权后补的证据门仅对当前 `3.1.9` / `owner-approved-post-release-v3.1.9` 且缺失证据清单生效；错误版本、旧授权、异常/伪造清单不得延期。正式技术门和 Windows 更新链不变。
- 锁定 Electron 串行执行发布延期门、Windows/Mac 打包合同与新增 Creator 处理器四套测试 29/29 通过；worktree inspect/development/core、RH 工具箱、JSON/上下文预算、归档完整性与 diff 门通过。两份保护文件散列保持原值，私有构建 sidecar 齐全。
- GitHub billing 两个接口均因当前 CLI 缺少 user scope 返回 404，不能据此认定额度不足；仓库为 public，Mac 应提交标准 runner 任务并记录真实结果，不修改 CLI 授权或杜撰账单。

## 当前发布状态

- 固定源码/Tag：`adec4754cee4ccbcd44f0063fe8b7858bf3e6944` / `v3.1.9`；已推送 origin/main 与当前分支。后续发布事实提交不移动 Tag、不重建产物。
- Windows 唯一正式 `dist:release` 已完成：BelowNormal / 单核 / Node 2 GiB / builder compression level 0；前端编译、Electron 字节码加密、双归档、原生模块、NSIS、7文件 app.asar、私有双侧和全部 post-build 门通过；provenance/recovery 封印后上传。
- 三资产发布前完整回下载通过大小/SHA-256 与安装包 SHA-512；稳定非草稿、非预发布 [Latest Release](https://github.com/T8mars/T8-penguin-canvas/releases/tag/v3.1.9) 于 `2026-09-18T14:11:33Z` 发布，最终元数据通过，recovery 已清除。
- 同源 [Mac workflow 35354742555](https://github.com/T8mars/T8-penguin-canvas/actions/runs/35354742555) 在真实 macos-15 arm64 上成功完成构建、ad-hoc 签名、三资产追加上传和 runner 完整回下载，于 `2026-09-18T14:19:05Z` 收尾。没有额度不足提示，Mac 未延期；仍无 Apple Developer ID、公证，技术预览边界不变。
- 本机独立完整回下载 Mac 三资产通过大小/SHA-256、ZIP SHA-512 与 macSource 绑定；Mac 追加后的 Windows 三资产再次完整回下载通过，Windows bytes/SHA-256、安装包 SHA-512、Latest、固定 Release target/Tag 保持一致。两平台验证器最终退出码 0。
- GitHub 公开页面复核 Latest 与固定源码一致；[Issue #29 已回复 v3.1.9 补丁与复验请求](https://github.com/T8mars/T8-penguin-canvas/issues/29#issuecomment-5731345665)，仍保持 OPEN。

本机独立 Mac 复核首次走 CLI 默认下载链路，连续观测约 170–260 KB/s，未完成也未记通过；只终止其所属 gh 下载子进程，由验证器 finally 清理该次临时部分文件，保留失败日志。只读 Range 探测确认本机已启用的 loopback 系统代理可用后，仅在复核子进程设置 HTTP(S)_PROXY，使用原 Mac/Windows 验证器重新完整下载并全部通过；未改全局代理、源码、Tag、Release 或构建产物。日志保留在本机 ignored 目录，不公开原始过程日志。

| 发布资产 | 字节数 | SHA-256 |
| --- | ---: | --- |
| T8-PenguinCanvas-Setup-3.1.9.exe | 1375853074 | `2d39f91baf788ded3d2a84bb3217b34e54c2f7d761fb8763c248d7470f2e8e38` |
| T8-PenguinCanvas-Setup-3.1.9.exe.blockmap | 1434362 | `1e4c0227078f3684e59a502981ba7c832aa6ea8c350fe7802a8b15ee36c5f268` |
| latest.yml | 362 | `548febff374e039318bbfb2ca360d7c0400b0faa625614eb8668318399a5a77b` |
| T8-PenguinCanvas-3.1.9-mac-arm64.dmg | 514347610 | `addc8270600a1e28389b4589bd9740e705ad1600e9a00a2672be9be2be5e8c77` |
| T8-PenguinCanvas-3.1.9-mac-arm64.zip | 506437985 | `da036f4f1313b73fd8970ca93e926a981efca1f392c27b69fcbaa45ace1da60b` |
| latest-mac.yml | 536 | `47752e9b3945115d5295e5cc12dc65ba86d848b15423af463c2436218f50983b` |

## 验收边界

真实 Mac 受影响用户“仅打开面板”、安装升级、外部设备与 F8–F10 按当前授权后补，未计通过。#24 / #25 / #29 保持开放；正式包的构建通过也不替代受影响用户复验。
