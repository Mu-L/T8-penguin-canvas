# T8-penguin-canvas 工作约束

在修改代码、架构、配置、测试、UI、部署、GitHub 或技术文档前，完整阅读本文件、`SKILL.md`、`features.json`、`roadmap.md`、`package.json`、相关源码/测试，以及当前交接记录。项目没有 `meta.json`。

## 当前权威开发与核心采用点

- 当前继续开发的权威工作树是 `E:\PenguinPravite\T8-penguin-canvas-dev-integration-f2-core-20260720`，分支 `codex/integration-f2-core-20260720`；其双父语义 merge commit 是 `68b5f72526a7272cc9787f6fda8b27a6f2fb54c8`。
- merge commit 的第一父提交是 core checkpoint `4e3061094014b5dc2720d52ed178a62e8469a9d3`，第二父提交是 release/F2 checkpoint `e0c6679b5a22539dd5b4983165ecc3f9d5c790e1`。
- 用户已于 2026-07-20 明确授权核心采用；`E:\PenguinPravite\T8-penguin-canvas` 的 `codex/vibex-workbench-node` 已通过 `git merge --ff-only` 采用上述语义合并及后续工作流记录，没有复制或覆盖工作树。canonical core 是稳定集成落点，不是日常功能开发目录。
- `E:\PenguinPravite\T8-penguin-canvas-release-2.5.7` 继续冻结。不得继续在 release 命名路径开发；后续功能继续在当前 integration 开发工作树，或新建 `T8-penguin-canvas-dev-*` 工作树，经验证后再由用户授权推进 core。
- release/F2 的旧 `T8_ALLOW_LEGACY_F2_WORKTREE=1` 例外已随 HEAD 从 `9b6f6a4...` 移动到 checkpoint 而永久失效。后续功能只能位于 `T8-penguin-canvas-dev-*` 开发工作树。
- canonical core 现已包含集成后的 role 脚本与 `predev` 系列门禁：`npm run worktree:core` 应通过，`npm run worktree:development` 必须拒绝 core 路径；开发工作树的结果相反。

## 永久保护

- 禁止 `reset`、`clean`、checkout 覆盖、整树复制、整树 ours/theirs 或任何丢弃本地修改的操作。
- 不得编辑或暂存源/core 工作树中的 `tools/ffmpeg-runtime/ffmpeg.exe`（143,314,432 bytes，SHA-256 `754A10CE2FC4A8C974FF492B351F58C02D35124D1D602FCF30F561FB1BD0F579`）。
- 不得编辑或暂存源/core 工作树中的 `tools/remove-ai-watermarks-runtime/README.md`（2,298 bytes，SHA-256 `04F13F0ADBB8593372FB9DDFA297A0DFB90D9EAD0325DE0CD340FCFE8B7CED56`）。
- 不得读取 retained/historical 项目数据库；数据库测试只能创建在系统临时目录并在测试后清理。
- 除非用户重新明确授权，不升级版本、不生产 build/打包、不暂存/提交/推送、不创建 tag 或 GitHub Release。未来正式包只构建一次。

## 已完成的无损集成

- 两边已分别制作显式 allowlist checkpoint；第三工作树完成 127 个冲突文件、1486 个冲突块的逐域语义合并，没有使用目录覆盖或整树 ours/theirs。
- 固定依赖顺序为 F2/F3 → B1 → B2/B3 → F4/F5 → F6 → F7 → Provider/媒体 → F9/F10/配置。
- 集成后的 193 个 TS 与 186 个 CJS 测试文件共 2872 项：2865 通过、7 个预期跳过、0 个遗留失败；type-check、public/rh-toolbox、writer/lifecycle、语法、JSON、worktree 和 diff 门通过。
- 集成树相对 release/F2 checkpoint 的产品语义仅增加 core 的 `nodemap.md`、`update.md`，以及记录集成事实的 `features.json` 更新。

## 当前剩余边界

- B1、F2-F7、schema32、全节点 RunEvent、B3 权限/安全清单、F9/F10 本地机制已经闭合；不得为了制造进度重复实现。
- 严格进度保持 27/32。B2/B3 仍缺真实历史端点、Windows 物理磁盘/安装升级回退、Provider 实网与资源负载证据。
- F8 必须由至少三个隔离客户端、两台真实 Windows 设备与 Electron 安装版完成；F9 必须使用真实域名、公共 DNS、证书、TLS/SNI 和反向代理；F10 必须完成真实公网红队与负载。
- 单机 localhost、mock、重复本地测试或手写汇总不能替代这些证据。没有对应环境时只维护失败关闭的采集/验证工具与事实记录，不勾选轮次。

## 防止再次跑错工作树

- 新功能开始前先执行 `npm run worktree:check` 与 `npm run worktree:development`，并记录绝对路径、branch、HEAD、common dir。
- development 只接受 `T8-penguin-canvas-dev-*`；release 目录只用于发布，canonical core 只用于用户授权后的已验证集成落点。
- 不通过复制目录同步分支；只允许 checkpoint、第三开发工作树、显式依赖切片和可复核 merge commit。
- `predev`、`predev:vite`、`predev:backend`、`preelectron:dev` 必须保留 worktree role 门，新增开发入口也必须接入同一门。
- 任一保护文件漂移、unmerged、角色/common dir/merge base 不符、或外部证据缺失时，必须失败关闭并停止扩大结论。
