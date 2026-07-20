# 网站：[https://ai.t8star.org](https://ai.t8star.org/register?aff=dP7j)
# 致谢企鹅-企鹅的在线画布：[https://art.pebbling.cn](https://art.pebbling.cn/?invite=T8STAR)
# Online workflow overseas：
https://www.runninghub.ai/?inviteCode=rh-v1121
# 在线工作流国内版：
https://www.runninghub.cn/?inviteCode=rh-v1121
# 👋🏻 Welcome to Zhenzhen

<img src="https://github.com/T8mars/Comfyui-zhenzhen/blob/main/pic/1.png" width="30%" alt="My favorite girl">
My favorite girl Go YounJung
# 🐧 贞贞的无限画布（企鹅共创版） · T8-penguin-canvas

> AI 节点画布工作流工具 · Web + Electron 桌面端｜v2.5.4
>
> GitHub：<https://github.com/T8mars/T8-penguin-canvas>

一个面向 AI 创作的 **节点式画布**：拖拽节点、连线编排、生成图像 / 视频 / 音频、调用 LLM、串接 RunningHub 工作流，叠加批量执行、智能对齐、打组、主题模板与终端日志。Web 浏览器和桌面端均可使用。

![status](https://img.shields.io/badge/version-v2.5.4-brightgreen) ![node](https://img.shields.io/badge/node-56-blue) ![react](https://img.shields.io/badge/react-19-61dafb) ![electron](https://img.shields.io/badge/electron-33-47848f) ![license](https://img.shields.io/badge/license-MIT-yellow)

---

## 📺 基础功能教程

从 0 到 1 上手，推荐初次使用者先过一遍视频教程了解整体节点拖拽、连线、API Key 配置、批量运行、组合与终端日志等核心能力：

| 平台 | 链接 |
|---|---|
| 🅱️ B 站教程 | <https://www.bilibili.com/video/BV1tYjy6jEuG/> |
| ▶️ Youtube 教程 | <https://www.youtube.com/watch?v=AH24lGHA9E0> |

> 如果你是首次上手，建议先跳转视频看一遍再动手，可避免在 API Key / 节点连线语义 / 模型选择上走弯路。

---

## ✨ 功能亮点

- 🎨 **56 个节点**，覆盖文本 / 图像 / 视频 / 音频 / LLM / RunningHub / ComfyUI / 3D / 工具 / 辅助 / 工具箱 / 输出预览 / 上传素材 / 素材集 / 批量打标 / 随机路由
- 🧺 **画布级批量导入 + 素材合集打散**：上传节点支持一次选择多张图 / 多个视频 / 多段音频；也可直接把剪贴板或文件拖到画布，同类型多素材自动形成合集，上传和输出合集都可一键打散为多个独立素材节点
- 🐎 **v2.5.4 Happy Horse / Seed Audio / 3D 白模自动更新版**：视频节点新增 Happy Horse 文生视频、单图生视频和多参考图生视频，音频节点新增 Doubao Seed Audio；3D 表情编辑器使用离线 ICT FaceKit 中性人类白模和 52 通道，支持照片比例校准及精确图片输出；教程同步新增第十六弹，贞贞国内/海外平台名称统一。
- 🌐 **v2.5.3 双站 API 与网页素材采集自动更新版**：RunningHub 国内/海外双 Key 与站点路由、贞贞 SD2 的 Seedance/Seedream、ComfyUI 多类型聚合输出、Chrome 网页素材 Popup/Side Panel 批量采集和顶部 API 获取入口正式发布；Electron 发布新增必需私有 sidecar 强制校验，缺失即阻断。
- 🌻 **v2.5.2 庭院守卫沉浸大屏自动更新版**：植物大战僵尸主题的庭院守卫新增类似俄罗斯方块主题的沉浸大屏按钮，战局不重载、按视口自适应放大并支持 Esc 退出；顶部“画布教程”同步新增教程第十五弹 Bilibili / YouTube 链接。
- 🌻 **v2.5.1 庭院守卫 + Seedream 自动更新版**：新增第 14 套庭院守卫主题和按需加载的 Phaser 塔防面板，支持阳光、植物冷却、15 关、升级、局面恢复、鼠标离开自动暂停与主题默认音乐；图像节点新增 Seedream V5 Pro，支持文生图、多图编辑、PNG/JPEG、预设及自定义尺寸和最多 10 张参考图。
- 🧭 **v2.5.0 随机路由 / 即梦 CLI / PS 与打标自动更新版**：随机路由新增“并发生成 / 顺序生成”模式，默认并发触发本次随机命中的多路下游；即梦 CLI 适配 v1.4.10，图像生成支持 `generate_num` 1-10，视频补齐 `seedance2.0mini`、`seedance2.0_vip` 4K 和 Seedance 1.x 新命名兼容；批量打标补齐图图打标器入口、最近打标文件定位和全部绝对路径查看；画布发送到 Photoshop 改为带状态确认的队列，PS 插件可正确打开前端地址并渲染资产缩略图。
- 🌻 **庭院守卫主题 + 大画布塔防**：新增第 14 套强识别主题，使用原创植物、入侵者、战场和木质藤蔓 UI 覆盖顶栏、侧栏、节点、连线、MiniMap 与上下文菜单；1280×720 Phaser 战场直接位于无限画布世界坐标中，包含 5×9 草坪、阳光、8 种植物、8 种入侵者、15 关、清道器、昼夜波次、叶章升级、图鉴、局面恢复和原创音效。Phaser 按主题懒加载，普通主题不承担运行时体积。
- 🎬 **v2.4.9 视频剪辑音频与导演分镜 mini 自动更新版**：视频剪辑合成在拖动片段并加入转场后，源视频音频会跟随 xfade / acrossfade 时间线压缩，不再按旧位置二次混音导致声音重叠、位移或最后一段无声；独立音频仍会叠加到保留的原声上。导演分镜台同步补齐 `seedance-2.0-mini` 模型选项，和 SD2.0 节点保持一致；本版继续校验 Photoshop 插件随 Electron 安装包分发。
- 🧩 **v2.4.8 插件安装与素材工作流自动更新版**：顶部在“画布教程”左侧新增独立“插件安装”入口，集中说明 Photoshop UXP、Figma Bridge 和网页图片反推插件安装路径；批量打标补齐单项删除、LLM/Vision 预设、自定义模型、TXT/JSON 互斥、原素材目录保存和 Ideogram-4 JSON；上传 / 输出视频素材新增首尾帧获取、英伟达极速超分和 FlashVsr 质量超分；PS 插件升级到 0.1.3，增加启动诊断、资产分页和 UXP 面板尺寸护栏，并随 Electron 包一并校验打包。
- 🖌️ **v2.4.7 Photoshop 联动 UI 热修自动更新版**：修复 `T8 Photoshop Link` 面板紧凑宽度下 `刷新 / 连接` 按钮文字被挤成竖排的问题，并补强插件 UI 自动化，覆盖资产库、生成、设置、PS 当前画面上传回 T8、画布发送到 PS 命令置入和生成后置入 PS。
- 🖌️ **v2.4.6 Photoshop 联动热修自动更新版**：修复 `T8 Photoshop Link` 在 Photoshop UXP Manifest v5 下访问 `http://127.0.0.1:18766` 被 `Permission denied / Manifest entry not found` 拦截的问题，插件 manifest 改为带协议和端口的本机白名单；同时支持 18766-18776 本机端口 fallback，避免旧后端占用 18766 时新版桌面端退到后续端口后插件仍连错。
- 🖌️ **v2.4.5 Photoshop 联动自动更新版**：新增 `T8 Photoshop Link` UXP 插件与 `/api/photoshop-bridge` 本机桥接，PS 图层可发送回当前画布，画布图像素材也可排队置入当前 PS 文档；插件内支持浏览 T8 最近输出 / 上传 / 资源库图像，并复用扩展 API 图像模型做生成或参考图编辑。Electron 打包会携带 `resources\tools\photoshop-bridge\plugin` 并校验 `photoshopBridge.t8c`，同时修复随机路由透传素材时误自动生成独立输出素材节点的问题。
- 🎲 **v2.4.4 随机路由与输入体验自动更新版**：新增“随机路由”工具节点，支持 `total_outputs` 1-100 动态输出口和 `random_pass_count` 精确随机命中，未命中分支不会进入运行队列；上传多视频合集的打散按钮保持常显；图像等节点的富文本 Prompt 针对微信输入法组合输入清理泄漏拼音，避免多出字母。
- 📦 **v2.4.3 上传素材无限制自动更新版**：上传素材节点移除 20MB 应用层大小限制，后端 `/api/files/upload` 不再给 multer 设置 `fileSize`，大体积本地素材上传只受磁盘、系统和运行环境约束；节点不再提示“文件超过上传上限 20MB，请压缩后重试”。
- 👁️ **上传 / 输出图像原图悬停预览**（v1.8.7）：上传素材与输出素材的图像卡片在 hover 时显示小眼睛按钮，鼠标停在按钮上可按 100% 原尺寸预览，超出视口时自动等比收进可见区域，输出素材入口位于图像对比按钮下方
- 🧾 **提示词模板库媒体套件**（v2.1.2）：图像 / 视频 / 音频 / 文本素材可从节点右键直接保存到提示词模板库，连同原 Prompt、标题、标签和配套媒体一起沉淀；右键保存时可选择或新建模板分类，模板库支持分类新增 / 删除 / 重命名，预览采用懒加载并支持图像 100% 查看
- 🏷️ **v2.4.2 批量打标节点自动更新版**：工具箱新增“批量打标”节点，支持图像 / 视频多文件、文件夹、拖拽和上游素材批量进入队列，调用贞贞 LLM 独立 Key或扩展 API 视觉模型生成 TAG、自然语言、短句或 JSON，并按原素材文件名前缀保存 `.txt` / `.json` 到 `output/batch-tags`；ModelScope 推荐并实测 `Qwen/Qwen3-VL-235B-A22B-Instruct`。
- 🧩 **v2.4.1 Agnes 专用图像编辑热修自动更新版**：扩展 API 平台里的 Agnes AI 专用适配器按官方文生图 / 图生图文档保持 `/v1/images/generations` JSON，图像编辑参考图统一写入 `extra_body.image`，`imageUrls` / `imageUrl` / `image` 等入口别名都会正确传给上游，避免专用 Agnes 图像编辑 503 或退化为无参考图生成。
- 🧩 **v2.4.0 Agnes 图像编辑与生成停止自动更新版**：Agnes 在扩展 OpenAI 兼容配置下的图像编辑按官方文档改走 `/v1/images/generations` JSON 与 `extra_body.image`，避免误打 `/v1/images/edits` multipart 导致 503；提示词库和素材右键分类新增 / 重命名改为 Electron 内联表单；图像、视频、SD2.0 节点生成中可停止本地轮询并立即重新发起新任务。
- 🍌 **v2.3.9 Gemini 官方图像与完整剪辑台自动更新版**：图像节点新增 `gemini-3.1-flash-lite-image` 与 `gemini-3-pro-image`，两者走 Gemini 官方 `generateContent` 图像格式并兼容异步任务返回；OpenAI 兼容扩展支持 `/v1/images/edits` 参考图编辑；资源库“我的资产”支持先选分类再上传本地文件；完整视频剪辑台补齐宽屏实底布局、63 个转场、ffprobe/xfade 打包校验与任务异常反馈。
- 🎬 **v2.3.8 视频剪辑与创作者工作流自动更新版**：新增核心「视频剪辑」节点，支持多视频上传/上游导入/跨画布追加、缩略图时间线、裁剪排序、片段拆分、转场滤镜、音频策略、异步 ffmpeg 合成、取消任务、下载成片和输出给下游；批量素材处理 RH 并发扩展到 1-10，并同步第十四弹教程、Gemini 正式模型名和左下角模型说明。
- 🧩 **v2.3.7 网页反推 Electron 回传修复版**：Chrome 网页图片反推插件在 Electron 安装包场景下会优先通过本地桥接把提示词 / 图片 / 图文结果送回正在运行的桌面画布，不再误开 `127.0.0.1` 错误页；同时保留发送到当前选中生成目标框的回填逻辑。
- 🧩 **v2.3.6 工作台与批量处理体验自动更新版**：VibeX 工作台顶部补充 Chrome 插件安装目录和说明，插件 manifest 升级到 1.1.0；批量素材处理改成一次只启用一种策略，并在并发执行时显示每个素材的等待 / 处理 / 完成 / 失败状态；左下角模型注意事项补充 Seedance2.0 mini、原生4K 和预扣退补说明。Electron 安装包继续带上网页图片反推插件目录 `resources/extension/web-image-reverse/`。
- 🧩 **v2.3.5 VibeX 与大画布性能自动更新版**：新增 VibeX 工作台节点，支持线上嵌入、RunningHub 登录适配、结果回传画布和 Chrome 插件桥接；批量素材处理的抠图、扩图、高清放大全部走 RH 工具箱能力层并支持并发/重试；100+ 节点画布增加生成历史懒收集、拖拽时隐藏非焦点端口/操作条和暂停非焦点动画等性能护栏。Electron 安装包会带上网页图片反推插件目录 `resources/extension/web-image-reverse/`。
- 🧩 **v2.3.4 画布创作流自动更新版**：补齐 Cowart 启发工作流第二段，图像编辑画板可直接“标注改图”，输出/上传素材会保留干净原图与标注图并自动生成干净改图结果；当前画布资源包导出加入资源库索引、缩略图引用和生成历史摘要，网页图片反推 Chrome 插件继续随公开源码发布。
- 🧩 **v2.3.3 画布创作流自动更新版**：新增“生成目标框”，用户可先在画布上摆好 AI 结果位置，再由上游文本/图像、网页图片反推或选区生成把结果准确填入；选区右键可整理提示词和参考图创建图像节点，当前画布资源包可导出轻量 manifest，网页图片反推 Chrome 插件继续随公开源码发布。
- 🧩 **v2.3.2 网页反推与画布体验自动更新版**：网页图片反推插件支持只发提示词、只发图片、图文一起发送，并可在浮层里直接用修改后的提示词重新生成图片；ModelScope 反推固定使用 qwen-web 同款 VL 模型并拦截不可读图片；画板节点和图像编辑弹窗新增 RH 自动抠图，结果直接替换选中图像；放置栏可隐藏/恢复，牧场物语和圣斗士主题折叠侧栏不再遮挡顶部主题栏。
- 🧩 **v2.3.1 体验修复 Electron 自动更新版**：补齐 Agnes AI 扩展平台的 LLM / 图像 / 视频链路、ModelScope 网页图片右键反推、生成历史记录抽屉、牧场物语面板/公告栏/画板布局、图像编辑与画板常用实心图形、界面字体设置、复制粘贴左上角落点和跨画布完成提醒；本次打包 Electron 并发布 GitHub Release / `latest.yml` 自动更新资产。
- 🌾 **v2.3.0 牧场物语主题 Electron 自动更新版**：新增第 13 套强识别 Farm Story Canvas 主题和全画布养成层，支持开垦、播种、浇水、收获、订单、建筑、装饰、动物、NPC、天气、节庆、惊喜事件、漂亮度、每日总结和成就摘要；上方监控看板、右侧可折叠控制台、顶部快捷工具和真实浏览器浅/深色截图验收已完成；本次打包 Electron 并发布 GitHub Release / `latest.yml` 自动更新资产。
- 🎬 **v2.2.9 Electron 自动更新版**：导演分镜台补齐分镜输入一键复用、首尾帧桥接默认折叠启用、50 条桥接提示词预设和自定义导入/导出，并继续稳住桥接输出和分镜输出的独立绑定；RH 工具箱改为持久化应用清单，上传/输出图像能力轨新增扩图和消除主体，扩图分辨率选择可正确传入；Codex 生图工作台新增登录入口；左下角模型注意事项更新到 2026.06.17；本次打包 Electron 并发布 GitHub Release / `latest.yml` 自动更新资产。
- 🎬 **v2.2.8 Electron 自动更新版**：继续收口导演分镜台，修复时间线拖拽调时长、桥接片段并发、重新获取和分镜输出对应关系；补齐资源库图像/视频/音频导入、素材排序、`@` 紧贴文字触发，以及 3D 全景分镜提示板实时白字预览和回车换行；画板自由尺寸支持小尺寸和保持原图像素；本次打包 Electron 并发布 GitHub Release / `latest.yml` 自动更新资产。
- 🎬 **v2.2.7 Electron 自动更新版**：新增导演分镜台，支持 4-15 秒分镜时长、单镜头提示词和多参考素材；补齐侧边栏 H 隐藏、放置栏清空与右键入栏、上传/输出素材删除和复制到剪贴板、3D 全景分镜提示板、宫格编辑拖拽入格和宫格剪裁去重修复；本次打包 Electron 并发布 GitHub Release / `latest.yml` 自动更新资产。
- 🧩 **v2.2.6 Electron 自动更新版**：动漫标签大师和艺术风格大师接入 `--t8-*` 主题语义变量，强主题、模板主题和样式主题下的节点、弹窗、卡片、输入框、按钮与预览层会跟随当前皮肤，不再在灌篮高手等主题里露出默认绿/青色风格；本次打包 Electron 并发布 GitHub Release / `latest.yml` 自动更新资产。
- 🧩 **v2.2.5 Electron 自动更新版**：创作台背景层改为“完成态只读展示层 + 编辑态可操作层”，修复完成后背景消失、编辑时不能选中/拖动的问题；补齐导入导出、50 款边框与按 Delete 删除；RH 工具箱图像能力中间层继续收口，上传 / 输出素材左侧能力轨支持抠图与 4K 放大，RH 任务停止会同步取消 RunningHub 后台任务；本次打包 Electron 并发布 GitHub Release / `latest.yml` 自动更新资产。
- 🏷️ **动漫标签大师在线图库**（v2.2.3）：继续完善 Danbooru / Gelbooru 在线图库，修复在线热门排序被前端名称排序覆盖、分类搜索串回画师、回车搜索、分页返回、预览重试、占位图和紧凑 UI 细节
- 🧭 **Figma / 云上传 / 画布教程可用化**（v2.1.4）：Figma Bridge 随后端自动启动，发送弹窗提示插件导入位置，Figma 插件改为二进制导入本机图片；腾讯云 COS / 阿里云 OSS 配置检查使用真实 signed location 连通测试；顶部新增“画布教程”入口并移除 RunningHub 弹窗里的 RH ApiKey 快捷项
- 🧲 **放置栏 + 外拖文件夹**（v2.1.2）：发送、粘贴和自动输出的素材节点会进入左下角放置栏映射，折叠显示最近 5 个、展开显示最近 20 个；拖动放置栏卡片会移动原节点到落点而不是复制；生成好的图像 / 视频 / 音频素材也可直接拖到浏览器外的文件夹
- 🧩 **LLM / 文本 / 画布交互修复**（v2.1.2）：LLM 多轮流式结果可单条删除且不会在下次生成时复活；文本节点支持上游图像 / 视频 / 音频 `@` 提及预览，文本分割输入框接入提示词模板与放大编辑；复杂大画布框选用屏幕拖拽矩形复核，降低漂移误选
- 🧭 **New API 分组令牌高级模式**（v2.1.1）：公开版新增本地扩展插槽与节点级 `providerParams` 透传，私有分组令牌能力可在 API Key 设置页默认关闭、按需启用；FAL 模型继续固定使用通用贞贞 Key，避免新手被分组配置打扰
- 🌱 **即梦 CLI 模型补齐**（v2.1.3）：按新版 `dreamina -h` / 子命令 help 验证，外部平台即梦 CLI 图像模型新增 `seedream-4.7`，生成时会传入 `--model_version=4.7`；视频模型补齐 `seedance2.0fast_vip / seedance2.0_vip / seedance2.0fast / seedance2.0`
- 🍌 **Nano Banana 2 映射修复**（v2.1.1）：UI 仍保留「香蕉2 / nano-banana-2 (Flash)」入口，真实上游模型修正为 `gemini-3.1-flash-image`，旧画布保存的旧模型值会自动兼容
- 🧹 **生成节点上游素材单项排除**（v1.8.8）：图像 / 视频 / SD2.0 / 音频 / LLM / RunningHub / RH 工具节点的上游素材缩略图右下角可点 X，从当前节点排除单个传入素材但不切断连线，并可用“恢复N”一键恢复
- 🗂️ **素材集节点 + 资源库整套复用**：可把同类型文本 / 图像 / 视频 / 音频合并为素材集，支持拖拽排序、反转 / 文件名 / 随机排序、导入素材集 / 导出素材集、保存到资源库、从资源库整套插入画布；未选中节点时按 `R` 可快速打开 / 关闭资源库
- 🚚 **跨画布节点 / 素材发送 + 本机工具入库**：框选多个带连线节点可用“节点片段”发送到其他画布并保留内部连线；上传素材、输出素材或素材集仍支持智能保持 / 合并素材集 / 上传素材 / 拆分上传 / 输出素材，发送弹窗提供最近画布、发送历史和重复素材提示，发送后可自动切换并定位到新内容，资源库素材也可一键发送，Eagle 与 Figma 桥接均只允许本机 localhost 接口
- 🔢 **画布 NodeID 快速连线 / 查找**（v1.8.9）：每个画布内节点都会显示独立递增的 `NodeID`，删除不回退；角标按真实可见节点卡片右上角锚定，避免因节点外层测量框变化漂离节点；拖线菜单顶部可用“发送到ID”输入编号自动连线，顶部工具栏可按 ID 查找并居中定位节点，复制 / 发送 / 导入到其他画布时按目标画布继续编号
- ⌨️ **自定义快捷键设置**（v1.9.1）：顶部工具栏 `?` 打开快捷键设置，可录制组合键、清空单项、单项 / 全部恢复默认；撤销、重做、复制粘贴、打组、画布定位、资源库和连线导航都走统一配置并本地持久化，冲突与浏览器保留键会即时提示
- 🔔 **任务完成提示音**：顶部工具条可独立开关，默认开启；图像 / 视频 / SD2.0 / 音频 / LLM 任务成功完成后播放轻提示音，5 秒内最多响一次，和主题音乐通道分开，主题音乐静音时仍可提示
- 📁 **跨平台本地路径默认值**：Windows 继续默认 `D:\zhenzhen`，macOS / Linux 默认 `~/zhenzhen`；旧版非 Windows 配置若仍是硬编码默认值会自动迁移，自定义路径不会被覆盖
- 🏷️ **生成提示词 @ 素材提及 + 大编辑器**：图像 / 视频 / SD2.0 / 音频 / LLM / RunningHub / RH 钱包应用 / RH 超市文本参数可输入 `@` 选择当前上游素材，输入框内显示统一对齐的小预览 chip，提交时稳定解析为 `@image1` / `@video1` / `@audio1`；聚焦提示词框按 `Alt+Enter` 或点击放大按钮可打开全局大编辑器，`Ctrl+Enter` 完成、`Esc` 取消。
- 🏅 **主题成就与有效时长**：按主题记录有效使用时长、特色节点事件、资源保存与工作流保存，解锁勋章和影片馆占位奖励；奖励影片素材未提供前会显示“待解锁 / 影片素材待提供”，不写入提示词、短链、Cookie 或资源 URL 等敏感内容。
- 🧱 **俄罗斯方块主题 + 小游戏**：新增第 12 套强识别 Tetris Canvas 主题，浅色为奶白彩块，深色为街机霓虹；右上角快捷栏默认展开 10×20 俄罗斯方块小游戏，支持 7-bag、公平出块、幽灵落点、暂存、硬降、99 级递增、最高分保存，鼠标离开 / 窗口失焦 / 画布拖动时自动暂停，键盘只在游戏区域 hover 或 focus 时接管。
- 🌾 **牧场物语主题 + 全画布养成层**：新增第 13 套强识别 Farm Story Canvas 主题，作为牧场物语主题十三套内置模板中的完整养成主题，包含木牌节点、牧场地图底纹、农具端口、麻绳 / 水渠 / 田埂连线、镰刀剪线、牧场 MiniMap 标记和左侧牧场 HUD；当前按 roadmap 分阶段开发，已接入开垦、播种、浇水、收获、订单、建筑、装饰、动物、NPC、天气、节庆、惊喜事件、漂亮度和成就摘要。
- 🌻 **庭院守卫主题 + 大画布战斗层**：新增第 14 套强识别 Garden Defense 主题，战斗区域随无限画布一起平移缩放，不占用右下角小地图；支持阳光经济、植物冷却、8+8 单位、15 关战役、昼夜、特殊能力、首领、5 级升级、长期档案与每画布战局存档。
- 🧰 **ComfyUI / RH 工具箱 / 云上传增强**：ComfyUI 内置基础文生图样例和导入检查清单，后端把缺模型、缺节点、未启动、workflow 校验失败等错误转成可执行提示；默认只允许本机 ComfyUI，可信远端可通过单实例高危开关或 `T8_COMFYUI_ALLOW_REMOTE=1` 开启；RH 工具箱生成图像 / 视频 / 文本 / 音频快捷接入位；COS / OSS 上传失败会返回签名、权限、Bucket / Region、网络等结构化排查建议。
- 📝 **文本节点自由缩放**：文本节点四角拖拽可独立调整宽高，输出端口固定贴合右侧中点，并在尺寸变化后刷新 ReactFlow internals，避免连线和端口脱离
- 🔗 **RH 文本 NodeID 绑定**（v1.9.0）：文本节点可填写 RH 节点序号，RunningHub / RH 钱包应用 / RH 超市会按应用参数里的 RH nodeId 自动匹配上游文本；节点内也能手动选择绑定文本，冲突和错误序号会保留清晰状态提示
- 🧩 **xyflow 12** 画布引擎：缩放、平移、连线、迷你地图、控制条、SPA 兜底
- 📐 **对齐 / 整理防堆叠**（v1.9.6）：框选多个节点后使用左 / 中 / 右 / 上 / 中 / 下对齐时，会在节点原本同排或同列重叠严重的情况下自动沿垂直或水平轴排开；等距分布在空间不足时会扩展排布，混选组框时只整理普通节点，避免节点直接叠成一摞
- 🔑 **四套独立 API Key 隔离**：贞贞工坊 / RunningHub / RH 钱包应用 / LLM —— 全部经后端代理脱敏，前端永远拿不到明文
- 📈 **一键批量运行**：Kahn 拓扑排序串行触发可执行节点，进度可视化，支持中断
- 🖼️ **图像编辑模态·五模式**：裁剪 / 蒙版 / 笔刷 / 网格 / 组合；非组合模式会按弹窗舞台真实可视尺寸完整显示原图，避免双击上传 / 输出素材编辑时上下被工具栏遮住；组合模式支持多图层拖拽 / 4 角同比缩放 + Shift 自由比例 + Alt 中心缩放 + 旋转 15° 吸附 + 50 深独立撤销栈
- ✂️ **宫格剪裁去缝预览**：独立宫格剪裁节点支持 gap 去缝、常用宫格预设、指定序号导出、输出顺序和上游合集批量拆分；批量拆分兼容上传多图与资源库素材集，并在节点内直接预览切线与被裁掉的缝隙区域
- 🧱 **宫格编辑拼版节点**（v1.9.2）：工具节点新增宫格编辑，可接收上游图像或本地上传，按 2×2 / 3×3 / 3×4 / 4×3 / 1×4 / 4×1 与自定义宽高生成分镜拼版图；支持 adaptive 完整显示、拖拽排序、单格删除、序号叠加、字幕条、单格字幕输入、拆分输出和 `/api/image/grid-compose` 生成 PNG
- 🎬 **电影感组合器**：电影感节点支持成片风格、镜头、光影、调色、质感各 50 项，带中英文 prompt、强度控制、收藏复用、JSON 导入/导出和一键运行输出
- 🎥 **视频运镜组合器**：视频运镜节点支持成片场景、运镜动作、路径、节奏、稳定和主体约束各 50 项，带可响应 50 项动作 / 50 项路径的路线示意、中英文 prompt、收藏复用、JSON 导入/导出和一键运行输出
- 🌐 **3D 全景节点**：新增 3D 分类与全景预览节点，使用项目依赖按需加载 Three.js，支持全景贴图拖拽旋转、FOV、缩放、比例控制和当前视角导出；图片预览采用 lazy loading 与 async decoding，降低大画布首屏压力
- 🔗 **聚合解析节点**：工具箱新增聚合解析，基于 ParseHub bridge 支持 17+ 社媒分享短链 / 分享码解析，前端强制合规确认，后端同样校验 `acceptedCompliance`；默认保存到本地输出目录，远端地址解析作为高级模式保留，避免平台临时 CDN 链接直接打开 403

### Figma Bridge 本机联动

`发送到 Figma` 会由 T8 后端自动启动本机 bridge，用户通常不需要再手动打开脚本：

1. 打开 Figma Desktop，在 `插件 / Plugins -> Development -> Import plugin from manifest...` 导入 `tools\figma-bridge\plugin\manifest.json`。不要走 `Widgets / 小组件 -> Import widget from manifest...`；如果看到 `manifest.containsWidget` 报错，说明当前选的是小组件导入入口。
2. 在 Figma 当前文件里运行插件 `T8 Penguin Canvas Bridge`，保持插件窗口打开。
3. 回到 T8 画布点击 `发送到 Figma`，素材会先进本机队列，再由 Figma 插件自动导入。

`npm run figma:bridge` 和 `tools\figma-bridge\start-figma-bridge.cmd` 仍保留为排障入口；只有设置了 `T8_FIGMA_BRIDGE_AUTOSTART=0` 禁用自动启动时，才需要手动运行。

图像会以 Figma 图片图层插入，文本会以文本图层插入；视频和音频会以引用卡片形式插入，方便保留素材地址。

### Photoshop Bridge 本机联动

`发送到 Photoshop` 和 `T8 Photoshop Link` 面板通过 T8 后端本机队列通信，不需要把素材发到第三方中转：

1. 打开 Adobe UXP Developer Tool，点击 Add Plugin，选择 `tools\photoshop-bridge\plugin\manifest.json`；打包版位置是应用目录 `resources\tools\photoshop-bridge\plugin\manifest.json`。
2. 在 Photoshop 中运行 `T8 Photoshop Link` 面板，并保持 T8 后端 / 桌面端打开。
3. 从 T8 的发送素材弹窗点击 `发送到 Photoshop`，图像会进入 PS 队列并自动置入当前文档；也可以在 PS 面板里导出当前图层 / 文档回到当前画布。

PS 面板包含 `资产 / 生成 / 设置` 三个页签：资产页可浏览最近输出、上传素材和资源库图像；生成页复用 T8 扩展 API 图像模型，支持文生图和带当前图层参考图的图像编辑，结果可自动回传画布。
- 🧍 **肖像大师**：工具箱新增捏人 Prompt 设计器，内置 9 大类词库，每个小参数 100 个可选词条，支持不选、锁定、权重、自定义补充、Avatar 分层方向预览、角色库收藏、JSON 导入导出、资源库角色分类、跨画布发送配置 / Prompt、高级随机、风格随机包、种子复现和批量输出文本节点 / 文本素材集
- 🧍‍♂️ **姿势大师**：支持 100 种常用姿势、多人骨架、MediaPipe 识别、手部控制、A/B 关键帧、姿势库、批量分镜，并可在节点内切换线稿 / OpenPose / COCO 预览与运行输出；OpenPose/COCO keypoints JSON 可单独导出给 ComfyUI / ControlNet 复用
- 🧪 **Grok Image / Sora2 FAL / Grok Video FAL / 即梦 CLI Seedance**：图像节点新增 Grok Image TAB；视频节点模型类型默认 `Grok Video → Veo → Sora2`，Veo 分类默认 `veo-omni-10s`，Grok Video TAB 默认 `Grok Video 1.5 (FAL)`，图像传入默认 base64，最多 1 张参考图且不发送比例参数；选择即梦 CLI Seedance 时支持 9 张图像、3 个视频、3 段音频参考，旧版 Grok FAL / Sora2 FAL 仍保留兼容入口
- 🧾 **文本分割二版**：文本分割节点支持段落 / 行 / 自定义分隔 / Markdown / 序号 / 智能分镜 / 正则高级 / 字数切块；按段落严格以至少一个空行切段，按行才逐行切分，内置模式说明、中文输入稳定编辑、双列预览布局、分段收藏、JSON 导入导出，并一键创建前置文本循环器链路；循环器执行完成后可自动打散为多个文本节点
- 🖌️ **图层画板节点**（v1.9.0 增强）：工具分类开放画板节点，支持 16:9 / 9:16 等画布比例、空白图层、图层组折叠、可见 / 锁定状态、载入上游或本地图片、手绘 / 文字 / 图形 / 箭头、缩放旋转、套索 / 钢笔非破坏式抠图、放大编辑窗口、导入导出画板 JSON 与运行输出 PNG；放大窗口复用完整图层面板并按设备像素比重绘，避免图片被低清预览二次放大
- 🔑 **分类独立 API Key 可选 · 默认折叠**（v1.2.6）：gpt-image / nano-banana / mj / veo / grok / seedance / suno 七个分类 Key 未填自动 fallback 贞贞通用 Key，新手默认折叠不被干扰
- 🧭 **扩展 API 平台高级入口**（v1.9.5 强化）：API 设置页默认折叠的「扩展 API 平台【高级/可选】」可配置 OpenAI 兼容、ModelScope、火山引擎、ComfyUI、即梦 CLI；ModelScope 图像生成新增 LoRA 管理与节点内多选，默认带 Infinite-Canvas 同步的 LoRA 列表，LLM 继续走稳定 `/v1/chat/completions`，火山 / ModelScope 会自动合并默认模型列表，即梦 CLI 支持只返回 submit_id 后继续查询下载图像 / 视频；ComfyUI 字段映射会清理非 fixed 的旧 value，保证 Prompt、上游图片、宽高等运行时输入真正生效
- 🧽 **去AI水印辅助节点**（已适配上游 0.11.0）：桥接 `wiltodelta/remove-ai-watermarks`，支持 Gemini / 豆包 / 即梦 / Samsung 可见水印识别去除、框选擦除（cv2 / LaMA）、来源自适应隐形水印、默认 ControlNet 结构保留、ESRGAN 小图预放大、模型 / CFG 调参、官方 all 完整清理、AI 元数据检查 / 清理（含 HEIC / HEIF / JXL / Opus 等容器）和来源鉴别
- 🧲 **智能对齐辅助线 + snap-to-grid**：拖动时检测同列 / 同行 / 居中对齐并弱吸附
- 📦 **GroupBox 打组**：框选 ≥2 节点一键套色框容器，可拖拽联动、整体执行、12 色调色板
- 🖱️ **右键画布快速添加节点**：菜单列出 7 个高频节点（upload / text / image / video / seedance / audio / llm）
- 🎯 **框选自动菜单**：≥2 节点框选后自动弹出操作面板（组执行 / 复制 / 快复制 / 删除 / 打组）
- ⏪ **Undo / Redo / 复制粘贴 / 导入导出 / 工作流模板** 完整画布交互
- 🌗 **主题模板系统**：科技风 / 像素糖果风 / OP 风格 / RH 风格 / 火影忍者风格 / EVA 风格 / 幽游白书风格 / 灌篮高手风格 / 足球小将风格 / 七龙珠风格 / 圣斗士风格 / 俄罗斯方块主题 / 牧场物语主题 / 庭院守卫主题十四套内置模板，支持浅色 / 深色、导入导出、编辑保存、自定义路径与默认静音主题音乐；庭院守卫把 1280×720 塔防战场放入大画布世界坐标，牧场物语提供全画布种植经营层，俄罗斯方块提供可玩的右上角小游戏，圣斗士风格提供十二宫 / 冥界篇双主题
- 🧭 **主题悬浮控件统一**：小图标按钮使用固定语义类，避免 OP / 像素等强风格按钮膨胀；火影小地图、控制条和音乐按钮对齐到与 RH 一致的底部悬浮体验
- 🎭 **公开主题设计规范**：见 [`docs/theme-design-guide.md`](docs/theme-design-guide.md)，用户可按规范制作、导入和分享更好看的主题画布
- 🖥️ **终端日志面板**：底部抽屉式实时日志，对齐主项目 logBus 协议
- 🛡️ **防空数据覆盖**：双层防护（前端 + 后端）保护已保存画布数据
---

## 🚀 快速开始

### 环境要求

- **Node.js ≥ 18**
- Windows / macOS / Linux 浏览器（推荐 Chromium 内核）

### 安装

```bash
git clone https://github.com/T8mars/T8-penguin-canvas.git
cd T8-penguin-canvas
npm install
cd backend && npm install && cd ..
```

### 启动开发模式

```bash
npm run dev
```

`concurrently` 会同时拉起：

- 后端：<http://127.0.0.1:18766>
- 前端：<http://127.0.0.1:11422>

浏览器自动打开前端地址即可使用。Windows 下也可以双击 `start-dev.bat` 一键启动。

### 配置 API Key

首次进入点击右上角 ⚙️ 打开设置弹窗，按需填入：

| Key | 用途 | 默认 BaseUrl |
|---|---|---|
| 贞贞工坊 API Key | image / video / audio | `https://ai.t8star.org` |
| LLM 独立 API Key | llm / vision（额度隔离） | OpenAI 兼容协议任意上游 |
| RunningHub API Key | RunningHub 个人工作流 | `https://www.runninghub.cn` |
| RH 钱包应用 APIKEY | RH 企业级共享 APIKEY（钱包应用专用） | `https://www.runninghub.cn` |
| 扩展平台 API Key / Token | OpenAI 兼容、ModelScope、火山引擎、即梦 CLI 等高级来源 | 在「扩展 API 平台【高级/可选】」里按平台填写 Base URL / Token / AK/SK / CLI 路径 |
| ComfyUI | ComfyUI 工作流、ComfyUI 超市、ComfyUI 应用制作工具 | 默认 `http://127.0.0.1:8188`，需先启动 ComfyUI |

传统 Key、扩展平台密钥和 ComfyUI 配置都会保存到 `data/settings.json`；前端 GET 接口仅返回 `****xxxx` 脱敏值或可用状态，明文仅供后端代理本地使用，永不泄露。ComfyUI 默认只允许连接本机 `localhost / 127.0.0.1` 服务；如需接入其他可信地址，可以在 API 设置里为该 ComfyUI 配置开启“允许远端地址”高危开关，也可以在后端运行环境中设置 `T8_COMFYUI_ALLOW_REMOTE=1`。随附的 Docker Compose 部署已启用该变量，便于容器后端连接其他主机或容器中的 ComfyUI。

> **不需要全部配置**：只填需要使用的那一类即可，其它节点会在运行时友好提示「未配置 XXX API Key」。

---

## 🐳 Docker 部署（Web + 后端）

Docker 部署只运行 Web 前端和 Express 后端，不包含 Electron 桌面端。默认对外暴露 `18766` 端口，数据保存在挂载的 `userdata` 目录。

```bash
docker compose up -d --build
```

启动后访问：

- Web：<http://127.0.0.1:18766>
- 健康检查：<http://127.0.0.1:18766/api/status>

随附的 `docker-compose.yml` 已启用远端 ComfyUI 访问，便于容器内后端连接其他主机或容器中的 ComfyUI：

```yml
T8_COMFYUI_ALLOW_REMOTE: "1"
```

注意：Docker 容器里的 `localhost` 指容器自身，不是宿主机。ComfyUI 地址必须从容器网络视角可访问；如需连接宿主机或其他网络中的 ComfyUI，请填写容器能访问到的地址，并只在可信网络中开启远端访问。不需要全局远端 ComfyUI 时，可移除或设为 `T8_COMFYUI_ALLOW_REMOTE: "0"`，再在 API 设置里按单个 ComfyUI 配置手动开启高危开关。

致谢：感谢 [@fm9394](https://github.com/fm9394) 在 [PR #11](https://github.com/T8mars/T8-penguin-canvas/pull/11) 中提供 Remote ComfyUI 与 Docker 部署方向。本版在保留默认本机安全策略的基础上，将远端访问收口为显式高危开关，并补齐 Web + 后端 Docker 部署说明。

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 前端框架 | React 19 · TypeScript 5 · Vite 6 |
| 样式 | Tailwind CSS 3 · CSS Modules · 主题模板（科技风 / 像素糖果风 / OP 风格 / RH 风格 / 火影忍者风格 / EVA 风格 / 幽游白书风格 / 灌篮高手风格 / 足球小将风格 / 七龙珠风格 / 圣斗士风格 / 俄罗斯方块主题 / 牧场物语主题 / 庭院守卫主题） |
| 画布引擎 | @xyflow/react 12 · Phaser 3（庭院守卫按需加载）· zustand 5 · lucide-react |
| 后端 | Node.js · Express · sharp（图像处理） · multer（上传） |
| 桌面端 | Electron 33 |
| AI 上游 | 贞贞工坊（图像/视频/Suno）· RunningHub · 任意 OpenAI 兼容 LLM |

---

## 📁 目录结构

```
T8-penguin-canvas/
├── backend/                 # Express 后端（端口 18766）
│   └── src/
│       ├── server.js        # 入口，挂载 5 类路由 + SPA 兜底
│       ├── config.js        # 端口 / 目录 / 上游 baseUrl
│       └── routes/          # canvas / settings / files / imageOps / proxy
├── src/                     # 前端
│   ├── App.tsx              # 三栏布局 + 状态栏
│   ├── components/
│   │   ├── Canvas.tsx       # 画布主体 + 批量运行 + 对齐辅助 + GroupBox
│   │   ├── CanvasToolbar.tsx
│   │   ├── TerminalPanel.tsx
│   │   ├── CanvasManager.tsx
│   │   ├── Sidebar.tsx
│   │   ├── ApiSettings.tsx
│   │   └── nodes/           # 节点组件
│   ├── stores/              # canvas / apiKeys / theme / runBus / logs
│   ├── hooks/               # useCanvasHistory / useRunTrigger
│   ├── services/            # api / generation / imageOps
│   ├── config/              # nodeRegistry / canvasTemplates / portTypes
│   ├── providers/           # 模型注册表
│   ├── utils/               # topologicalSort / wheelBlock
│   └── types/canvas.ts
├── electron/                # 桌面端主进程与 preload
│   ├── main.cjs             # 主进程 + 后端拉起 + IPC
│   └── preload.cjs          # IPC 桥接
├── features.json            # 节点防丢失锁 + 接口快照
├── skill.md                 # 本地私有手册（不提交 GitHub）
├── vite.config.ts           # 前端 11422 + /api → 18766 代理
├── start-dev.bat            # Windows 一键启动
└── package.json
```

详细字段见本地私有 `skill.md`。

---

## 🎛️ 画布快捷键

默认快捷键如下；可在顶部工具栏 `?` →「快捷键设置」里自定义、清空单项或恢复默认，配置会保存在本机浏览器 / Electron 用户数据中。

| 快捷键 | 作用 |
|---|---|
| `Ctrl + Z` | 撤销 |
| `Ctrl + Shift + Z` / `Ctrl + Y` | 重做 |
| `Ctrl + C` / `Ctrl + V` / `Ctrl + D` | 复制 / 粘贴 / 快速复制 |
| `Delete` / `Backspace` | 删除选中节点或连线 |
| `Ctrl + A` | 全选节点 |
| `Z` | 画布空白处缩放到全貌 |
| `G` | 画布空白处定位当前视野最近节点 |
| 拖线中 `Space` | 开启 / 关闭连线导航模式，远距离连线时可松开鼠标拖动画布后再点目标接口 |
| `空格 + 拖拽` | 平移画布 |
| `滚轮 / 触控板` | 缩放画布 |

工具栏图标：▶ 批量运行 · 🧲 网格吸附 · ↶↷ 历史 · ⧉ 复制 · 📋 粘贴 · 🗑️ 删除 · ⬆️ 导入 · ⬇️ 导出 · ✨ 模板 · ❓ 快捷键设置

---

## ⚙️ 批量执行（拓扑串行）

工具栏 ▶ 按钮一键运行画布上所有 **可执行节点**：

1. `topologicalSort()` 在「仅含可执行节点」的子图上做 Kahn 排序
2. 串行 `triggerRun(id)` → 等待运行总线 `lastDone.id === id` 推进
3. 进度徽标 `done/total` 实时显示，再次点击（■）中断

可执行节点包含：image / edit / multi-angle-3d / panorama-720 / penguin-portrait / video / seedance / audio / llm / runninghub / runninghub-wallet / rh-tools / resize / upscale / grid-crop / remove-bg / combine / image-compare / frame-extractor / frame-pair / upload / loop / pick-from-set / drawing-board / cinematic / video-motion / multi-angle-visual。

---

## 🧲 节点对齐辅助

- **snap-to-grid**：xyflow 原生 20×20 网格吸附
- **智能辅助线**：拖动时检测每对节点的 6 条边（左/中/右、上/中/下），距离 < 6px 触发：
  - SVG 橙色虚线在世界坐标系（随视口缩放）渲染
  - 自动取差值最小者做弱吸附

工具栏「磁铁」按钮统一控制开关。

---

## 🛠️ 后端接口速览

完整接口表见本地私有 `skill.md` 的后端接口章节。

| 分组 | 主要路径 |
|---|---|
| 健康 | `GET /api/status` |
| 画布 | `GET/POST /api/canvas`、`GET/PUT/DELETE /api/canvas/:id`、`PATCH /api/canvas/:id/name` |
| 设置 | `GET/POST /api/settings`、`GET /api/settings/raw`（内部） |
| 文件 | `POST /api/files/upload`、`GET /api/files/list`、`POST /api/files/upload-base64` |
| 图像处理 | `/api/image/{resize,upscale,grid-crop,combine,remove-bg}` |
| 上游代理 | `/api/proxy/image`、`/api/proxy/llm`、`/api/proxy/video/{submit,query}`、`/api/proxy/audio/{submit,query}`、`/api/proxy/runninghub/{submit,query,app-info}` |

代理层会 **自动转存** 上游图像 / 视频 / 音频到 `output/`，前端永远拿到稳定的本地 `/files/output/*` URL。

---

## 📦 构建 / 部署

```powershell
npm run type-check    # tsc --noEmit
npm run build         # tsc -b && vite build
npm run preview       # 本地预览构建产物
```

后端为纯 Node 服务，部署时直接 `node backend/src/server.js` 即可，注意：

- `data/` 持久化设置和画布
- `input/ output/ thumbnails/` 持久化用户素材与生成产物（首次自动创建）

---

## 📋 节点清单（39 个，可见 + 隐藏）

| 分组 | 节点 |
|---|---|
| 素材资源 (3) | upload（上传素材） · material-set（素材集） · output（输出素材终端预览） |
| 核心 (6) | text · image · video · seedance · audio · llm |
| RunningHub (4) | runninghub · runninghub-wallet（RH 钱包应用） · rh-config（隐藏） · rh-tools（RH 超市） |
| 特殊 (5, 隐藏) | multi-angle-3d · panorama-720 · penguin-portrait · portrait-metadata · storyboard-grid |
| 工具 (13) | drawing-board · browser · image-compare · frame-extractor · frame-pair · loop · pick-from-set · text-split · resize · combine · remove-bg · upscale · grid-crop |
| 辅助 (5) | edit（隐藏） · idea · bp · relay · video-output（隐藏） |
| 工具箱 (3) | cinematic · video-motion · multi-angle-visual |

> 任何节点的删减都需在 [features.json](./features.json) 中说明，并同步本地私有 `skill.md`。

---

## 🤝 贡献

欢迎 Issue / PR ！

- 提交 Issue 前请先搜索是否已存在；附上复现步骤、期望与实际行为、截图（如有）
- 提交 PR 前请保证：
  - `npm run type-check` 通过
  - `npm run build` 通过
  - 涉及节点变动需同步 [features.json](./features.json) 与本地私有 `skill.md`
  - Commit 信息使用 [Conventional Commits](https://www.conventionalcommits.org/) 风格（`feat:` `fix:` `chore:` `docs:` 等）

---

## 📜 License

MIT License © T8mars

本项目以 MIT 协议开源。允许在保留版权与许可声明的前提下自由使用、复制、修改、合并、出版、分发、再授权及销售本软件副本。详见 [LICENSE](./LICENSE)（如未单独提供，请参考 [MIT 协议全文](https://opensource.org/licenses/MIT)）。

---

## 🐧 Credits

- 主作者：[T8mars](https://github.com/T8mars)
- 灵感来源：PenguinPravite · Infinite Canvas · zhenzhen-web
- 致谢上游服务：贞贞工坊（T8star）· RunningHub · OpenAI 兼容生态
- 去AI水印辅助节点桥接 [wiltodelta/remove-ai-watermarks](https://github.com/wiltodelta/remove-ai-watermarks)（Apache-2.0 License），算法能力由上游 Python 包 / CLI 提供

如果这个项目对你有帮助，欢迎给一个 ⭐ Star！
