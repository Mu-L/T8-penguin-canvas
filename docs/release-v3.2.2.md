# v3.2.2 数据目录迁移发布

日期：2026-09-30。用户已明确授权版本升级、正式 Electron 构建、源码推送和 Latest 自动更新 Release；外部证据后补，Mac 只允许额度不足时延期。状态：发布准备中，不能视为构建或上传通过。

范围与本地验证见[数据目录专题](desktop-data-storage.md)；保留 v3.2.1 全部保护。正式 Windows 仅构建一次，同源 Mac 使用相同固定 Tag。后续实际资产、下载校验和 workflow 事实集中写本页。

仓库为公开仓库，标准 macos-15 runner 的运行分钟按 [GitHub 规则](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 免费；账单接口当前权限不足不能读取，不冒称已读取账号余额。本轮按标准 runner 发布 Mac，并以实际 workflow 结果核对。

真实安装升级、跨物理盘、大容量断电及 F8–F10 仍未验收，按 `owner-approved-post-release-v3.2.2` 延后；不能用临时目录测试替代。
