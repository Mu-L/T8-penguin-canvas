# T8 Penguin Canvas 主题设计规范

本文件是公开文档，用来帮助用户和贡献者制作更好看的主题画布。它只描述主题模板、视觉规范和可公开的实现约定，不包含本地密钥、充值配置或私有部署信息。

## 快速开始

普通用户不需要改代码：

1. 打开应用右上角设置。
2. 进入主题模板管理。
3. 选择一套内置主题，点击复制。
4. 修改名称、颜色、圆角、阴影、字体、视觉风格、音乐。
5. 分别检查浅色模式和深色模式。
6. 保存后应用，也可以导出 JSON 分享给其他用户。

自定义主题默认保存到：

```text
Windows: D:\zhenzhen\theme-templates
macOS / Linux: ~/zhenzhen/theme-templates
```

如果目录不存在，应用会自动创建。用户也可以在设置里改成自己的主题目录，换版本后继续读取同一目录即可。

## 主题的两层能力

主题系统分成两层：

1. **模板层**：通过 JSON 控制颜色、字体、圆角、阴影、端口颜色、明暗模式、音乐和已有视觉风格。普通用户主要使用这一层。
2. **视觉皮肤层**：通过代码和 CSS 新增一套真正不同的 UI 语言，例如 OP 风格的海图背景、悬赏令节点、草帽水印、特殊端口和 MiniMap。贡献者新增完整风格时使用这一层。

当前无需改代码即可选择的视觉风格是：

| style | 适合方向 | 说明 |
|---|---|---|
| `plain` | 极简、低装饰 | 最安全的基础语义风格。 |
| `tech` | 科技、玻璃、霓虹 | 适合深色仪表盘、AI 工具感。 |
| `pixel` | 糖果、贴纸、像素 | 适合活泼、可爱、强描边。 |
| `op` | 航海、冒险、悬赏令 | 带更强主题皮肤，需要注意不要遮挡节点内容。 |
| `rh` | 工作台、黑绿、云工作流 | RunningHub 亲和风格，强调无边框卡片、荧光运行态和高对比。 |
| `naruto` | 热血、忍者、战斗感 | 火影忍者风格，强调木叶护额、卷轴节点、火焰查克拉和斜切控件。 |
| `eva` | 指挥所、同步、警戒 | EVA 风格，强调初号机紫、荧光同步绿、MAGI 雷达、AT Field 几何和装甲面板。 |
| `yyh` | 灵界侦探、霓虹街区、战斗卡 | 幽游白书风格，强调灵丸能量、暗紫青绿终端、REI MAP 机械小地图和灵界符号水印。 |
| `slamdunk` | 热血篮球馆、漫画分镜、战术板 | 灌篮高手风格，强调木地板球场、红黑球衣、计分牌节点、传球弧线和半场战术 MiniMap。 |
| `soccer-hero` | 绿茵热血、比分牌、传球轨迹 | 足球小将风格，强调整场球场、蓝白球衣、比赛卡片、传球轨迹和球场 MiniMap。 |
| `dragon-ball` | 热血冒险、胶囊设备、神龙雷达 | 七龙珠风格，强调胶囊公司设备面板、神龙雷达画布、七颗龙珠徽章、气功波连线和原创合成音乐。 |
| `saint-seiya` | 圣域、星座、小宇宙 | 圣斗士风格，强调十二宫、黄金圣衣、星图、水晶感 UI 和冥界篇隐藏模式。 |
| `tetris` | 方块、街机、消行 | 俄罗斯方块主题，强调方块拼接画布、方块节点框、方块 MiniMap 和可玩的右上角小游戏。 |
| `farm-story` | 牧场、种植、建造、手账 | 牧场物语主题，强调木牌节点、牧场地图底纹、农具端口、麻绳 / 水渠 / 田埂连线、镰刀剪线、牧场 HUD 和全画布养成层。 |
| `garden-defense` | 庭院、防线、植物卡牌 | 庭院守卫主题，强调木质藤蔓 HUD、草坪路径、种子卡牌、原创植物与入侵者，并在 ReactFlow 世界坐标中提供可玩的 1280×720 大画布塔防。 |

如果你只导入 JSON，不应该写新的 `style` 字符串。后端会过滤未知枚举，未知值会回退到现有风格。

## 设计目标

一个好主题不能只换颜色。至少要让这些地方形成同一套语言：

- 应用背景和画布背景。
- 顶部工具栏、左侧栏、设置弹窗、资源库抽屉。
- 节点外壳、节点标题、节点内输入框、按钮和状态条。
- 连接线、选中态、框选区域、端口颜色。
- MiniMap、缩放控制条、音乐按钮、右键菜单等浮层。
- GroupBox 打组后的组边框、背景、水印和输出口。

主题识别度来自重复出现的“视觉母题”，例如 OP 风格使用海图、悬赏令、草帽、赤红、海蓝、金币金；RH 风格使用黑绿工作台、荧光运行态、云工作流网格和无边框卡片；火影忍者风格使用木叶护额、卷轴纸、查克拉蓝、火焰橙红和忍术阵纹理；EVA 风格使用初号机紫、荧光同步绿、警戒橙红、MAGI 雷达、AT Field 几何和装甲面板；幽游白书风格使用灵丸能量、霓虹灵界地图、暗紫青绿终端、REI MAP 小地图和战斗卡片；灌篮高手风格使用木地板球场、红黑球衣、计分牌、传球弧线、战术板和篮球橙；足球小将风格使用绿茵球场、蓝白球衣、比分牌和传球轨迹；七龙珠风格使用胶囊公司设备、神龙雷达、七颗龙珠徽章、橙金气功波和深蓝科技反差；圣斗士风格使用十二宫、星图、水晶边框和小宇宙；俄罗斯方块主题使用方块井、像素街机、彩块和消行反馈；牧场物语主题使用草地格、耕地、木牌、农具、麦穗、麻绳、水渠、牧场手账和季节徽章；庭院守卫主题使用草坪路径、木质藤蔓 HUD、种子卡牌、阳光徽章和原创植物防线；像素糖果风使用硬描边、贴纸卡片、糖果色、圆胶囊和硬阴影。

SHIFT 划线断连也是主题的一部分。新增官方主题时，除了节点、端口和背景，也要为 `--t8-cut-cursor`、`--t8-cut-button-mask`、`--t8-cut-color` 提供主题化切断符号，例如 OP 用弯刀、RH 用断链、火影用手里剑、EVA 用 Prog Knife、幽游白书用灵剑、灌篮高手用篮球 / 哨子、足球小将用足球 / 哨子、七龙珠用四星球 / 能量星、俄罗斯方块用像素断块、牧场物语用镰刀 / 剪枝剪、庭院守卫用园艺剪 / 藤蔓，避免所有主题都显示默认剪刀。

浅色模式不能只检查外壳颜色。很多历史节点内部仍可能带有 `text-white/*`、`bg-white/*`、`border-white/*`、cyan/violet 标签、状态色或旧 Tailwind 工具类。新增官方主题时必须为这些 legacy internal controls 做适配层，并分别检查节点标题、字段名、参数标签、实际发送、错误提示、按钮和表单在 light/dark 两种模式下的可读性。EVA 浅色模式就是通过这一层把老节点内部暗色工具类重新映射到主题主文字、弱文字、同步绿/警戒红和浅面板背景。

原生 `<select>` 要单独检查。浏览器弹出的 `option` 菜单不等同于普通 `div`，旧节点里常见的 `option.bg-zinc-900` 会绕过外层 legacy adapter。`theme-core.css` 会提供基于 `--t8-*` 的基础兜底，官方强风格主题仍必须同时覆盖 `select`、`.t8-select`、`select option`、`option:checked`，并在 light/dark 设置合适的 `color-scheme`，否则会出现浅色主题里黑底黑字或白底白字的下拉项。

主题音乐按钮和 ReactFlow 缩放控制条必须作为同一个浮动控件组处理。代码中应把 `ThemeMusicToggle` 与 `Controls` 放进 `.t8-control-rail`，由全局变量统一控制左下角位置、间距和堆叠；主题 CSS 只覆盖尺寸、颜色、边框和阴影，不要再分别给喇叭或控制条写 `left/top/bottom`，否则不同主题很容易漂移或重叠。

画布水印、组水印和装饰性伪元素必须永远在内容下层。画布级水印只能放在 `.t8-canvas-shell::before/::after`，并保持 `z-index: 0`、`pointer-events: none`；ReactFlow 节点、边、浮层、画板内容和素材预览必须盖住水印。新增主题时需要分别检查浅色/深色模式下的主画布、GroupBox、画板节点和普通素材节点，避免水印穿透到图片或文字上方。浅色和深色不必强行复用同一张水印：如果深色水印依赖黑底终端、警告面板或厚重贴片，浅色模式应单独提供透明底线稿 / 印章 / HUD 版本，避免浅色画布底部出现突兀的深色块。

## 模板 JSON 结构

主题模板必须是一个 JSON 对象，核心结构如下：

```json
{
  "schema": "t8-theme-template",
  "version": 2,
  "id": "my-theme",
  "name": "我的主题",
  "description": "一句话描述主题气质",
  "author": "Your Name",
  "legacyStyle": "pixel",
  "visuals": {
    "style": "pixel",
    "intensity": "medium",
    "iconPack": "default",
    "canvasPattern": "dots",
    "nodeFrame": "sticker",
    "headerMark": "MY THEME"
  },
  "music": {
    "title": "My Theme Loop",
    "preset": "pixel-pop",
    "source": "synth",
    "url": "",
    "volume": 0.15,
    "bpm": 128,
    "copyrightNote": "请只使用原创或已授权音乐。"
  },
  "modes": {
    "light": {
      "tokens": {}
    },
    "dark": {
      "tokens": {}
    }
  }
}
```

字段规则：

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema` | 是 | 固定为 `t8-theme-template`。 |
| `version` | 是 | 当前为 `2`。 |
| `id` | 是 | 小写英文、数字、`-`、`_`，建议不超过 48 个字符。 |
| `name` | 是 | 显示在主题管理器里的名称。 |
| `description` | 否 | 简短描述主题气质和适用场景。 |
| `author` | 否 | 作者名。 |
| `legacyStyle` | 是 | `tech` 或 `pixel`，用于兼容旧组件。OP 风格通常用 `pixel`。 |
| `visuals` | 建议 | 控制主题皮肤、节点框、图标包和画布纹理。 |
| `music` | 建议 | 控制主题音乐，默认静音，用户主动点击才播放。 |
| `modes.light.tokens` | 是 | 浅色模式全部 token。 |
| `modes.dark.tokens` | 是 | 深色模式全部 token。 |

## Token 分组

每个主题必须同时提供 `light` 和 `dark` 两套 tokens。不要只做浅色或只做深色，否则用户切换模式时容易看不清字。

### 背景与面板

| token | 用途 |
|---|---|
| `appBg` | 应用外层背景，影响顶部栏和整体氛围。 |
| `canvasBg` | 画布主背景。 |
| `panelBg` | 侧边栏、弹窗、抽屉等主要面板。 |
| `panelBgElevated` | 浮层、下拉、卡片高一级背景。 |
| `panelBgMuted` | 弱背景、分组区域、参数表底色。 |
| `nodeBg` | 节点主体背景。 |
| `nodeHeaderBg` | 节点标题区域背景。 |

建议：`appBg` 和 `canvasBg` 可以接近，但不要完全一样；节点背景要能从画布中跳出来。

### 文字

| token | 用途 |
|---|---|
| `textMain` | 主文字。 |
| `textMuted` | 次级文字。 |
| `textDim` | 弱提示、说明、占位文字。 |
| `accentText` | 主按钮上的文字。 |

建议：主文字与面板背景、节点背景的对比度至少达到 `4.5:1`。主题管理器会对部分组合给出对比度警告。

### 边框、阴影与圆角

| token | 用途 |
|---|---|
| `border` | 普通边框。 |
| `borderStrong` | 强边框、选中边框、重点边框。 |
| `shadowPanel` | 面板阴影。 |
| `shadowButton` | 按钮阴影。 |
| `shadowStrong` | 强阴影或选中态阴影。 |
| `radiusPanel` | 面板圆角。 |
| `radiusButton` | 按钮圆角。 |
| `radiusNode` | 节点圆角。 |

建议：圆角和阴影决定主题性格。科技风通常小圆角、柔阴影；像素风可以大圆角、硬阴影；严肃工具不要过度装饰。

### 品牌色与状态色

| token | 用途 |
|---|---|
| `accent` | 主色，按钮、重点状态、当前选择。 |
| `accentHover` | 主色悬停。 |
| `secondary` | 副色，用于第二层强调。 |
| `warning` | 警告、提示、徽章。 |
| `danger` | 错误、删除、危险操作。 |
| `success` | 成功、完成、已连接。 |

建议：不要让主题只由同一色相的深浅组成。至少准备一个主色、一个副色、一个暖色或冷色对比。

### 画布与连接

| token | 用途 |
|---|---|
| `gridDot` | 画布网格点或网格线。 |
| `edge` | 普通连线。 |
| `edgeSelected` | 选中连线。 |
| `selectionBg` | 框选背景。 |
| `selectionBorder` | 框选边框。 |

建议：连线要比背景更清楚，但不要比节点本体更抢眼。选中连线必须一眼能看出来。

### 端口颜色

| token | 用途 |
|---|---|
| `portText` | 文本端口。 |
| `portImage` | 图片端口。 |
| `portVideo` | 视频端口。 |
| `portAudio` | 音频端口。 |

建议：端口颜色在所有主题中都要保持类型辨识度。不要把四种端口改成非常接近的颜色。

### 字体

| token | 用途 |
|---|---|
| `fontFamily` | 正文字体。 |
| `displayFont` | 标题、品牌、节点标题可用字体。 |

建议：中文用户优先保证中文可读。字体可以有风格，但不要牺牲节点内长文本、参数和日志的可读性。

## Visuals 字段

`visuals` 决定主题使用哪套视觉皮肤。

```json
{
  "style": "pixel",
  "intensity": "medium",
  "iconPack": "default",
  "canvasPattern": "dots",
  "nodeFrame": "sticker",
  "headerMark": "像素"
}
```

| 字段 | 可选值 | 说明 |
|---|---|---|
| `style` | `plain` / `tech` / `pixel` / `op` / `rh` / `naruto` / `eva` / `yyh` / `slamdunk` / `soccer-hero` / `dragon-ball` / `saint-seiya` / `tetris` / `farm-story` / `garden-defense` | 选择视觉皮肤。 |
| `intensity` | `subtle` / `medium` / `strong` | 装饰强度。不是所有皮肤都会用满三档。 |
| `iconPack` | `default` / `op` / `naruto` / `eva` / `yyh` / `slamdunk` / `soccer` / `dragon-ball` / `saint-seiya` / `tetromino-well` / `farm-tools` / `garden-guard` | 图标包。庭院守卫使用 `garden-guard`。 |
| `canvasPattern` | `none` / `dots` / `map` / `circuit` / `confetti` / `hub` / `chakra` / `eva-grid` / `spirit-map` / `court` / `pitch` / `dragon-radar` / `sanctuary-zodiac` / `tetris-stack` / `pasture-map` / `defense-lawn` | 画布纹理倾向。庭院守卫使用 `defense-lawn`。 |
| `nodeFrame` | `plain` / `glass` / `sticker` / `wanted` / `hub-card` / `shinobi-scroll` / `eva-panel` / `spirit-case` / `scoreboard-card` / `match-card` / `capsule-card` / `cloth-box-card` / `arcade-cabinet-card` / `farm-sign-card` / `garden-card` | 节点外框倾向。庭院守卫使用 `garden-card`。 |
| `headerMark` | 任意短文本 | 标题装饰字，后端会截断到 40 字符。 |

推荐组合：

| 方向 | `legacyStyle` | `style` | `canvasPattern` | `nodeFrame` |
|---|---|---|---|---|
| 干净科技 | `tech` | `tech` | `circuit` | `glass` |
| 轻量工具 | `tech` | `plain` | `none` | `plain` |
| 可爱贴纸 | `pixel` | `pixel` | `dots` | `sticker` |
| 冒险航海 | `pixel` | `op` | `map` | `wanted` |
| RH 工作台 | `tech` | `rh` | `hub` | `hub-card` |
| 忍者战斗 | `pixel` | `naruto` | `chakra` | `shinobi-scroll` |
| 同步指挥 | `tech` | `eva` | `eva-grid` | `eva-panel` |
| 灵界侦探 | `tech` | `yyh` | `spirit-map` | `spirit-case` |
| 热血篮球馆 | `pixel` | `slamdunk` | `court` | `scoreboard-card` |
| 绿茵热血 | `pixel` | `soccer-hero` | `pitch` | `match-card` |
| 胶囊雷达 | `pixel` | `dragon-ball` | `dragon-radar` | `capsule-card` |
| 星座圣域 | `pixel` | `saint-seiya` | `sanctuary-zodiac` | `cloth-box-card` |
| 方块街机 | `pixel` | `tetris` | `tetris-stack` | `arcade-cabinet-card` |
| 牧场手账 | `pixel` | `farm-story` | `pasture-map` | `farm-sign-card` |
| 庭院防线 | `pixel` | `garden-defense` | `defense-lawn` | `garden-card` |

## 音乐规范

主题音乐默认静音，只有用户点击音乐按钮后才播放。

内置官方主题可以使用项目内 `src/assets/theme-music/*.mp3`，打包脚本需要同步校验对应文件；公开模板 JSON 则不要内嵌未授权音乐。

| 字段 | 可选值或范围 | 说明 |
|---|---|---|
| `title` | 文本 | 音乐名。 |
| `preset` | `tech-pulse` / `pixel-pop` / `grand-line-adventure` / `rh-pulse` / `shinobi-flame` / `eva-sync` / `spirit-gun` / `buzzer-beater` / `golden-goal` / `ki-burst` / `shenron-aura` / `pegasus-cosmos` / `hades-eclipse` / `block-drop` / `farm-breeze` | 合成音乐预设或音乐气质。 |
| `source` | `synth` / `url` / `upload` | 音乐来源。 |
| `url` | `http(s)://...` 或 `data:audio/...` | 上传音乐会导出为 data URL。 |
| `volume` | `0` 到 `0.5` | 默认不要太大，建议 `0.12` 到 `0.18`。 |
| `bpm` | `40` 到 `220` | 节奏信息。 |
| `copyrightNote` | 文本 | 版权说明。 |

公开分享主题时，请只使用原创、已授权、可商用或明确允许分发的音乐。不要把未授权音乐嵌入导出的 JSON。

## 好看主题的制作流程

1. 先写一句主题描述：例如“海风、旧纸地图、悬赏令、红蓝金”。
2. 选一个基础视觉：`tech`、`pixel`、`op`、`rh`、`naruto`、`eva`、`yyh`、`slamdunk`、`soccer-hero`、`dragon-ball`、`saint-seiya`、`tetris`、`farm-story`、`garden-defense` 或 `plain`。
3. 定义 3 个核心色：背景色、主强调色、副强调色。
4. 定义文字颜色，先保证可读性。
5. 定义节点背景和节点标题背景，让节点从画布里立起来。
6. 定义端口颜色，保证文本/图片/视频/音频能区分。
7. 定义选中态和连线颜色，保证操作反馈明确。
8. 做浅色模式。
9. 基于浅色模式反推深色模式，不要只把颜色整体压暗。
10. 在真实画布上检查：大节点、小节点、输出素材、GroupBox、MiniMap、右键菜单、设置弹窗、资源库抽屉。

## 明暗模式检查清单

每个主题发布前至少检查：

- 节点标题、节点正文、输入框文字都清楚。
- 按钮文字与按钮背景对比足够。
- 右键菜单和弹窗没有被画布层遮住。
- MiniMap 不遮挡主题装饰，也不被装饰遮挡。
- GroupBox 内的节点能盖住组背景水印。
- 端口没有因为 hover、选中或缩放发生位置偏移。
- 选中节点、选中边、框选区域在浅色和深色都明显。
- 搜索框、下拉框、长文本不会溢出容器。
- 资源库图片、音频、视频卡片在主题下仍然易读。
- 音乐默认静音，点击后音量不过大。

## 不建议这样做

- 只改背景色，不改节点、端口、连线和浮层。
- 浅色模式可读，深色模式文字消失。
- 把所有颜色都做成同一色相的深浅变化。
- 给节点正文加重描边，长文本会很难读。
- 把装饰图案放到最上层，挡住节点、端口或右键菜单。
- 让 MiniMap、控制条、音乐按钮和主题水印互相遮挡。
- 在导出的主题 JSON 里塞入很大的未授权音频。

## 代码贡献者：新增完整视觉皮肤

如果你想新增一种真正的视觉风格，而不是只用现有 `plain/tech/pixel/op/rh/naruto/eva/yyh/slamdunk/soccer-hero/dragon-ball/saint-seiya/tetris/farm-story/garden-defense` 调色，需要改代码。

至少需要同步这些位置：

| 文件 | 需要做什么 |
|---|---|
| `src/theme/types.ts` | 给 `ThemeVisualStyle`、图标包、纹理或节点框补新枚举。 |
| `backend/src/routes/themes.js` | 同步白名单，否则导入模板时会被过滤。 |
| `src/theme/defaultTemplates.ts` | 增加内置模板或示例 token。 |
| `src/theme/applyTheme.ts` | 确认会写入需要的 `data-theme-*` 属性和 CSS 变量。 |
| `src/styles/theme-xxx.css` | 编写视觉皮肤 CSS。 |
| `src/styles/index.css` | 引入新的 CSS 文件。 |
| `src/components/ThemeTemplateManager.tsx` | 如果新增枚举，需要让编辑器能选择。 |
| `features.json` | 记录新增主题能力和注意事项。 |

视觉皮肤 CSS 应遵守：

- 不要用过宽选择器改坏全局浮层，例如不要对 `.t8-canvas-shell > *` 强制改 `position` 或 `z-index`。
- 画布装饰、水印、伪元素必须 `pointer-events: none`。
- 浮层类 UI 必须高于 ReactFlow 主画布层，例如右键菜单、拖线候选、弹窗、下拉。
- 节点本体必须盖住主题水印，不能让装饰穿透到素材预览上方。
- OP 风格这类强主题可以有明显元素，但仍要服务于创作效率。
- 新增节点不要单独写死某个主题分支，优先使用 `--t8-*` 变量和通用 `t8-*` 类。
- 主题连线动效必须走 scoped 规范：普通连线只做静态主题化；只有选中边、悬停边、或与选中节点相连的边才能加 `.t8-edge-theme-active` 并启用虚线流动、运动球、气功波等动画。
- `.t8-edge-theme-active` 也必须受 `html[data-t8-edge-motion="reduced"]`、`.t8-viewport-moving`、`.t8-node-dragging` 和 `prefers-reduced-motion` 控制；拖动画布、拖节点、系统减少动态效果时不得继续播放 `animateMotion`、filter 或无限动画。
- 如果一次选中导致大量连线同时满足条件，应按 `DeletableEdge.tsx` 的 `DECORATIVE_EDGE_MOTION_LIMIT` 降级，只保留直接选中/悬停边的动效，不允许 36+ 条边一起跑。

## 最小模板示例

下面是一个可以导入后继续编辑的简化模板。实际使用时请补齐所有 token，最简单的做法是复制内置主题再修改。

```json
{
  "schema": "t8-theme-template",
  "version": 2,
  "id": "sunset-studio",
  "name": "日落工作室",
  "description": "暖色工作室主题，适合轻松创作。",
  "author": "T8 user",
  "legacyStyle": "pixel",
  "visuals": {
    "style": "pixel",
    "intensity": "medium",
    "iconPack": "default",
    "canvasPattern": "confetti",
    "nodeFrame": "sticker",
    "headerMark": "SUNSET"
  },
  "music": {
    "title": "Sunset Loop",
    "preset": "pixel-pop",
    "source": "synth",
    "url": "",
    "volume": 0.14,
    "bpm": 118,
    "copyrightNote": "原创或已授权音乐。"
  },
  "modes": {
    "light": {
      "tokens": {
        "appBg": "#f8ead2",
        "canvasBg": "#f5d8a8",
        "panelBg": "#fff7e6",
        "panelBgElevated": "#ffffff",
        "panelBgMuted": "#efd8b4",
        "nodeBg": "#fff7e6",
        "nodeHeaderBg": "#ffb86c",
        "textMain": "#24140b",
        "textMuted": "#68452c",
        "textDim": "#94745a",
        "border": "#24140b",
        "borderStrong": "#24140b",
        "accent": "#2bb3a3",
        "accentHover": "#8ee6d8",
        "accentText": "#24140b",
        "secondary": "#ff7a90",
        "warning": "#ffd36e",
        "danger": "#d94a4a",
        "success": "#2f9c68",
        "shadowPanel": "3px 3px 0 #24140b",
        "shadowButton": "3px 3px 0 #24140b",
        "shadowStrong": "5px 5px 0 #24140b",
        "radiusPanel": "16px",
        "radiusButton": "9999px",
        "radiusNode": "16px",
        "gridDot": "#bd9a68",
        "edge": "#3a2a1e",
        "edgeSelected": "#ff6f61",
        "selectionBg": "rgba(43,179,163,0.18)",
        "selectionBorder": "#24140b",
        "portText": "#5ab8ff",
        "portImage": "#f6c85f",
        "portVideo": "#ff7a90",
        "portAudio": "#a78bfa",
        "fontFamily": "'M PLUS Rounded 1c', 'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif",
        "displayFont": "'M PLUS Rounded 1c', 'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif"
      }
    },
    "dark": {
      "tokens": {
        "appBg": "#211713",
        "canvasBg": "#251a15",
        "panelBg": "#32241b",
        "panelBgElevated": "#3d2d22",
        "panelBgMuted": "#493527",
        "nodeBg": "#32241b",
        "nodeHeaderBg": "#8f5a2b",
        "textMain": "#fff1d8",
        "textMuted": "#d7bb96",
        "textDim": "#a88d6c",
        "border": "#fff1d8",
        "borderStrong": "#fff1d8",
        "accent": "#5ed8c7",
        "accentHover": "#9bf3e7",
        "accentText": "#211713",
        "secondary": "#ff8aa0",
        "warning": "#6f4f20",
        "danger": "#8c2d2d",
        "success": "#24764e",
        "shadowPanel": "3px 3px 0 #fff1d8",
        "shadowButton": "3px 3px 0 #fff1d8",
        "shadowStrong": "5px 5px 0 #fff1d8",
        "radiusPanel": "16px",
        "radiusButton": "9999px",
        "radiusNode": "16px",
        "gridDot": "#6e5140",
        "edge": "#fff1d8",
        "edgeSelected": "#ff8aa0",
        "selectionBg": "rgba(94,216,199,0.18)",
        "selectionBorder": "#fff1d8",
        "portText": "#75c7ff",
        "portImage": "#f6c85f",
        "portVideo": "#ff8aa0",
        "portAudio": "#b9a6ff",
        "fontFamily": "'M PLUS Rounded 1c', 'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif",
        "displayFont": "'M PLUS Rounded 1c', 'Noto Sans SC', 'Microsoft YaHei', system-ui, sans-serif"
      }
    }
  }
}
```
