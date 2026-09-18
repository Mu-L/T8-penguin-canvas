# GitHub Issues 复核与 Creator 事件生命周期修复

日期：2026-09-18。首次审计范围：Issue #29 的可复现源码缺陷，以及 #24 / #25 的当前状态回复；当时不是新版本发布。用户随后明确授权 v3.1.9 发布，后续状态统一见[发布专题](release-v3.1.9.md)，下方未发布描述保留首次审计的事实时间点。

## #29：确认的缺陷与修复

`CreatorAgentPanelV2.tsx` 的渠道选择在函数式 `setSettingsDraft` 回调内读取 `event.currentTarget.value`。React 在事件分发结束后清空 `currentTarget`；排队或重放的更新因此可能在渲染时抛出 `Cannot read properties of null (reading 'value')`。

现在在事件处理期间先读取 `providerId` 字符串，状态更新只闭包捕获该字符串；保持不可变更新、渠道切换清空三种模型和其他设置字段不变。不清理或迁移用户数据库、画布和草稿，不改 Provider 请求。

新测试 `tests/creatorAgentSettingsEventLifetime.test.cjs` 使用 TypeScript AST 提取并执行生产 JSX 的真实处理器，刻意将更新排队到事件被清空之后。旧代码三项全部失败，其中两项复现同名 `null.value`；修复后三项通过，覆盖事件清空、连续切换后 DOM 值变化、更新重放及新状态字段保留。

这是确认的事件生命周期缺陷，不等于已证明用户报告的全部症状同根因。用户报告使用基于 v3.1.2 的定制 Mac 构建，且包括“仅打开面板”；未发生渠道 change 的首次打开不能仅由这条回调解释，需要对应构建的未压缩堆栈及真实 Mac 复验。Issue 保持开放。

## 验证

- 系统 Node 的新增专项：3/3 通过。
- 项目锁定 Electron / TypeScript loader 串行运行事件生命周期、Creator V2 前端、Creator UI、i18n 和 Electron i18n 五套测试：99/99 通过。
- 全项目 TypeScript `--noEmit` 在 BelowNormal、2 GiB 堆上限下通过。首轮人为设定的 768 MiB 上限导致进程 OOM，未作为通过证据。
- 回归发现既有测试漂移：Creator UI 仍断言旧按钮文案和旧的无幂等字段请求体，现对齐“采用并发送”、审阅/操作门及稳定 `clientRequestId`；i18n 测试改用显式 index 文件导入，避免 ESM 目录导入失败。未回退生产行为或放宽测试目标。
- 无生产 build、Electron 打包、Git 提交/推送、Tag 或 Release；未读取保留数据库，未调用付费 Provider；真实 Mac 用户环境尚未验证。

## #24 / #25 的处理边界

- [#24 性能优化](https://github.com/T8mars/T8-penguin-canvas/issues/24)：已有性能档位、离屏冷壳、轻量连线和启动优化；仍缺受影响用户真实重画布、五分钟资源回落和双平台安装版证据。不重复实现已有能力、不进行压力测试，不关闭 Issue。
- [#25 英文支持](https://github.com/T8mars/T8-penguin-canvas/issues/25)：主要双语界面和语言独立性已实现；本轮目录和 Electron 语言回归通过，但完整 Provider 英文金路径、全部边缘浮层、缩放及读屏未完成。不关闭 Issue。
- [#29 Mac Creator 崩溃](https://github.com/T8mars/T8-penguin-canvas/issues/29)：向用户提供最小源码修复和测试事实，明确当前安装包尚不含此次本地补丁；请求首次打开是否会复现及脱敏调用堆栈，不建议删除全部 App 数据。

## 已发布的用户回复

- [#29 最小修复与 Mac 复验请求](https://github.com/T8mars/T8-penguin-canvas/issues/29#issuecomment-5730960646)。
- [#24 当前性能进展与脱敏复现场景请求](https://github.com/T8mars/T8-penguin-canvas/issues/24#issuecomment-5730960624)。
- [#25 中英文进展与剩余验收边界](https://github.com/T8mars/T8-penguin-canvas/issues/25#issuecomment-5730960620)。
- [#29 v3.1.9 双平台补丁已发布，请求区分渠道切换和仅打开面板复验](https://github.com/T8mars/T8-penguin-canvas/issues/29#issuecomment-5731345665)；Issue 仍为 OPEN，正式发布事实见发布专题。
