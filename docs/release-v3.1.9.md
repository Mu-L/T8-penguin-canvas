# v3.1.9 Creator 设置可靠性发布

日期：2026-09-18。用户明确授权版本升级、正式 Electron 打包、GitHub 新版本与自动更新 Release；外部证据后补，Mac 仅在 GitHub 额度不足时延期。

## 范围与发布前验证

- 仅纳入 [Creator 事件生命周期修复与 Issues 审计](github-issues-20260918.md)，不改变 Provider、模型、默认值、端口、数据库或旧画布。
- 真实处理器修复前复现、修复后 3/3 与锁定 Electron 五套回归 99/99 通过；TypeScript 在 BelowNormal / 2 GiB 堆上限通过，首次人为 768 MiB 堆上限 OOM 未记通过。
- 授权后补的证据门仅对当前 `3.1.9` / `owner-approved-post-release-v3.1.9` 且缺失证据清单生效；错误版本、旧授权、异常/伪造清单不得延期。正式技术门和 Windows 更新链不变。
- 锁定 Electron 串行执行发布延期门、Windows/Mac 打包合同与新增 Creator 处理器四套测试 29/29 通过；worktree inspect/development/core、RH 工具箱、JSON/上下文预算、归档完整性与 diff 门通过。两份保护文件散列保持原值，私有构建 sidecar 齐全。
- GitHub billing 两个接口均因当前 CLI 缺少 user scope 返回 404，不能据此认定额度不足；仓库为 public，Mac 应提交标准 runner 任务并记录真实结果，不修改 CLI 授权或杜撰账单。

## 当前发布状态

版本与文档已准备；固定源码提交、Tag、唯一 Windows 构建、上传、Latest、完整回下载和 Mac 任务尚未执行。完成后在此集中记录源码、工作流和资产散列，features 仅保留短摘要/索引。

## 验收边界

真实 Mac 受影响用户“仅打开面板”、安装升级、外部设备与 F8–F10 按当前授权后补，未计通过。#24 / #25 / #29 保持开放；正式包的构建通过也不替代受影响用户复验。
