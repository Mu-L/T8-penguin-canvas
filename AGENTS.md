# T8-penguin-canvas 工作约束

在修改代码、架构、配置、测试、UI、部署、GitHub 或技术文档前，完整阅读本文件、`SKILL.md`、`features.json`、`roadmap.md`、`package.json`、相关源码/测试，以及当前交接记录。项目没有 `meta.json`。

## 当前 legacy F2 工作树

- 当前续接源是 `E:\PenguinPravite\T8-penguin-canvas-release-2.5.7`、分支 `codex/f2-reconnect-sync`、冻结基准 HEAD `9b6f6a43bc407a3c47a32dd9c0536afa879f256b`。
- 该路径名称属于 release 角色；它仅因历史未提交叠层而允许临时续接。不得把此布局复制给新功能。后续开发工作树必须命名为 `T8-penguin-canvas-dev-<topic>`。
- 运行 development 入口时，只有上述精确路径/分支/HEAD 可以显式设置 `T8_ALLOW_LEGACY_F2_WORKTREE=1`。HEAD 一旦移动，该例外永久失效。
- `E:\PenguinPravite\T8-penguin-canvas` 是 canonical core 和未来集成目标；未获明确授权前只读，不得在其中合并、切分支或覆盖文件。

## 永久保护

- 保留整个未提交工作区；禁止 `reset`、`clean`、`checkout`、整树复制、整树 ours/theirs 或任何丢弃本地修改的操作。
- 不得编辑或暂存 `tools/ffmpeg-runtime/ffmpeg.exe`（143,314,432 bytes，SHA-256 `754A10CE2FC4A8C974FF492B351F58C02D35124D1D602FCF30F561FB1BD0F579`）。
- 不得编辑或暂存 `tools/remove-ai-watermarks-runtime/README.md`（2,298 bytes，SHA-256 `04F13F0ADBB8593372FB9DDFA297A0DFB90D9EAD0325DE0CD340FCFE8B7CED56`）。
- 不得读取 retained/historical 项目数据库；数据库测试只能创建在系统临时目录并在测试后清理。
- 除非用户重新明确授权，不升级版本、不生产 build/打包、不暂存/提交/推送、不创建 tag 或 GitHub Release。未来正式包只构建一次。

## 无损集成

- 先读 `artifacts/f2-core-integration-readiness-2026-07-20.md`，再运行只读审计：`npm run worktree:integration-audit -- --source <F2源路径> --target <核心路径> --check`。
- 集成前必须分别冻结源叠层与核心叠层；禁止 `git add -A`。两边 checkpoint、第三个干净 integration worktree 和逐域语义三方合并均需要用户明确 Git 授权。
- 任一保护文件内容或 staged 状态不符、任一 unmerged、工作树角色/common dir/merge base 不符、legacy 源未 checkpoint、或任一 collision 未显式解决时，必须停止集成。
- 依赖顺序固定为 F2/F3 → B1 → B2/B3 → F4/F5 → F6 → F7 → F9/F10 本地机制；集成后重算全部 schema/writer/lifecycle/permission/node coverage 契约并运行同 ABI 回归。
