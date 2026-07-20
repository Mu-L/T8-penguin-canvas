import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('RunningHub local upload conversion accepts both input and output file URLs', () => {
  const proxy = read('../backend/src/routes/proxy.js');
  const runninghub = read('../src/components/nodes/RunningHubNode.tsx');

  assert.match(proxy, /url\.startsWith\('\/files\/output\/'\)/);
  assert.match(proxy, /url\.startsWith\('\/files\/input\/'\)/);
  assert.match(proxy, /path\.join\(config\.OUTPUT_DIR/);
  assert.match(proxy, /path\.join\(config\.INPUT_DIR/);
  assert.match(runninghub, /v\.startsWith\('\/files\/output\/'\)/);
  assert.match(runninghub, /v\.startsWith\('\/files\/input\/'\)/);
});

test('material context menu lets saved prompt templates choose or create categories', () => {
  const menu = read('../src/components/MaterialContextMenu.tsx');

  assert.match(menu, /getPromptTemplateCategories/);
  assert.match(menu, /getPromptTemplateCategoryLabel/);
  assert.match(menu, /promptCategoryId/);
  assert.match(menu, /createPromptTemplateCategory/);
  assert.match(menu, /新建模板分类/);
  assert.match(menu, /categoryId:\s*selectedPromptCategoryId/);
});

test('canvas exposes Figma send, placement shelf, and external file drag protocols', () => {
  const canvas = read('../src/components/Canvas.tsx');
  const styles = read('../src/styles/index.css');
  const radialSettingsModal = read('../src/components/RadialMenuSettingsModal.tsx');
  const modal = read('../src/components/SendMaterialsModal.tsx');
  const api = read('../src/services/api.ts');
  const preload = read('../electron/preload.cjs');
  const electronMain = read('../electron/main.cjs');
  const viteEnv = read('../src/vite-env.d.ts');
  const materialThumbnail = read('../src/components/nodes/MaterialThumbnail.tsx');
  const server = read('../backend/src/server.js');
  const figma = read('../backend/src/routes/figma.js');
  const figmaBridgeUtil = read('../backend/src/utils/figmaBridge.js');
  const figmaBridge = read('../tools/figma-bridge/server.cjs');
  const figmaStart = read('../tools/figma-bridge/start-figma-bridge.cmd');
  const figmaManifest = read('../tools/figma-bridge/plugin/manifest.json');
  const figmaUi = read('../tools/figma-bridge/plugin/ui.html');
  const figmaPlugin = read('../tools/figma-bridge/plugin/code.js');

  assert.match(server, /const figmaRouter = require\('\.\/routes\/figma'\)/);
  assert.match(server, /app\.use\('\/api\/figma', figmaRouter\)/);
  assert.match(server, /startFigmaBridgeOnAppStart/);
  assert.match(server, /T8_FIGMA_BRIDGE_AUTOSTART=0/);
  assert.match(api, /sendToFigma/);
  assert.match(modal, /onSendToFigma/);
  assert.match(modal, /发送到 Figma/);
  assert.match(modal, /画布会自动启动本机桥接/);
  assert.match(modal, /FIGMA_PLUGIN_IMPORT_HINT/);
  assert.match(modal, /Figma 桌面软件/);
  assert.match(modal, /Import plugin from manifest/);
  assert.match(modal, /tools\\\\figma-bridge\\\\plugin\\\\manifest\.json/);
  assert.match(modal, /resources\\\\tools\\\\figma-bridge\\\\plugin\\\\manifest\.json/);
  assert.doesNotMatch(modal, /先运行 npm run figma:bridge/);
  assert.match(modal, /actionNotice/);
  assert.match(modal, /setActionNotice\(\{ kind: 'error'/);
  assert.match(modal, /CheckCircle2/);
  assert.match(modal, /AlertTriangle/);
  assert.match(canvas, /handleSendMaterialsToFigma/);
  assert.match(canvas, /throw new Error\(message\)/);
  assert.match(canvas, /Figma Bridge 队列/);
  assert.match(canvas, /保持 Figma 插件窗口打开会自动导入/);
  assert.match(canvas, /bridgeJobId/);
  assert.match(canvas, /<PlacementShelf/);
  assert.ok(canvas.lastIndexOf('<PlacementShelf') > canvas.indexOf('className="t8-control-rail'));
  assert.doesNotMatch(canvas, /if \(items\.length === 0\) return null/);
  assert.match(canvas, /placementShelfItemsFromCanvasNodes/);
  assert.match(canvas, /placementShelfClearedCanvasIdsRef\.current\.has\(requestedCanvasId\)\s*\?\s*\[\]\s*:\s*placementShelfItemsFromCanvasNodes\(fixedNs, '画布'\)/);
  assert.match(canvas, /暂无素材/);
  assert.doesNotMatch(canvas, /fixed bottom-4 left-4/);
  assert.match(canvas, /t8-control-stack/);
  assert.match(canvas, /RadialMenuSettingsModal/);
  assert.match(canvas, /data-canvas-floating-ui="radial-settings-toggle"/);
  const controlStackIndex = canvas.indexOf('className="t8-control-stack"');
  assert.ok(
    canvas.indexOf('data-canvas-floating-ui="radial-settings-toggle"', controlStackIndex) <
      canvas.indexOf('data-canvas-floating-ui="model-help-toggle"', controlStackIndex),
  );
  assert.match(styles, /\.t8-control-rail[\s\S]*flex-direction:\s*row/);
  assert.match(styles, /\.t8-placement-shelf/);
  assert.match(styles, /\.t8-radial-settings-panel/);
  assert.match(styles, /\.t8-radial-settings-grid/);
  assert.match(radialSettingsModal, /visibleRadialMenuNodeOptions\(NODE_REGISTRY\)/);
  assert.match(radialSettingsModal, /setSlotNodeType/);
  assert.match(radialSettingsModal, /setSlotEnabled/);
  assert.match(radialSettingsModal, /moveSlot/);
  assert.match(radialSettingsModal, /draggable/);
  assert.match(radialSettingsModal, /resetRadialMenu/);
  assert.match(radialSettingsModal, /setLongPressMs/);
  assert.match(canvas, /DownloadURL/);
  assert.match(canvas, /canUseNativeDragOut/);
  assert.match(canvas, /isLeftRightMouseChord/);
  assert.match(canvas, /FILE_DRAG_OUT_MOVE_TOLERANCE/);
  assert.match(canvas, /startNativeDragOut/);
  assert.match(canvas, /canvasPanLocked/);
  assert.match(canvas, /memoPanOnDrag/);
  assert.match(canvas, /canvasPanLocked \? false : \[\.\.\.CANVAS_PAN_MOUSE_BUTTONS\]/);
  assert.match(canvas, /stopRadialPointerEvent/);
  assert.match(canvas, /window\.addEventListener\('mousemove', onMouseMove, true\)/);
  assert.match(canvas, /Let the real paste event fire first/);
  assert.match(canvas, /screenshots\/files must win/);
  assert.match(canvas, /internalClipboardCopiedAtRef\.current = Date\.now\(\)/);
  assert.match(canvas, /mediaSignature/);
  assert.match(canvas, /shouldReleaseConsumedExternalMedia/);
  assert.match(canvas, /internalClipboardCopiedAtRef\.current > last\.at/);
  assert.match(canvas, /internalClipboardCopiedAtRef\.current <= lastExternalPaste\.at/);
  const externalPasteBranch = canvas.slice(
    canvas.indexOf('const onPaste = (e: ClipboardEvent)'),
    canvas.indexOf("window.addEventListener('paste', onPaste, true)"),
  );
  assert.ok(
    externalPasteBranch.indexOf('shouldReleaseConsumedExternalMedia') <
      externalPasteBranch.indexOf('window.clearTimeout(internalPasteTimerRef.current)'),
    'consumed external clipboard media must release before cancelling internal node paste',
  );
  assert.match(canvas, /if \(internalPasteTimerRef\.current\) \{\s*window\.clearTimeout\(internalPasteTimerRef\.current\);/);
  const pasteShortcutBranch = canvas.slice(
    canvas.indexOf("matchesAnyShortcut(shortcuts['canvas.paste'], e)"),
    canvas.indexOf("matchesAnyShortcut(shortcuts['canvas.duplicate'], e)"),
  );
  assert.equal(pasteShortcutBranch.includes('e.preventDefault()'), false);
  assert.match(canvas, /window\.t8pc\?\.dragFileOut/);
  assert.match(canvas, /file-drag-out-feedback/);
  assert.match(canvas, /findDragOutSourceAtPoint/);
  assert.match(canvas, /document\.elementsFromPoint/);
  assert.match(canvas, /className="t8-file-drag-out-feedback/);
  assert.match(styles, /\.t8-file-drag-out-feedback\s*\{/);
  assert.match(styles, /\.t8-file-drag-out-feedback__detail/);
  assert.doesNotMatch(canvas, /text-white\/86/);
  assert.match(canvas, /检测到左键\+右键/);
  assert.match(canvas, /普通浏览器限制/);
  assert.match(canvas, /Electron 原生拖出桥接/);
  assert.match(preload, /dragFileOut/);
  assert.match(preload, /onDragFileOutStatus/);
  assert.match(preload, /ipcRenderer\.send\('t8pc:drag-file-out'/);
  assert.match(preload, /t8pc:drag-file-out-status/);
  assert.match(electronMain, /ipcMain\.on\('t8pc:drag-file-out'/);
  assert.match(electronMain, /sendDragOutStatus/);
  assert.match(electronMain, /event\.sender\.startDrag/);
  assert.match(electronMain, /resolveMountedDragOutFile/);
  assert.match(styles, /t8-file-drag-out-active/);
  assert.match(viteEnv, /onDragFileOutStatus\?:/);
  assert.match(viteEnv, /dragFileOut\?:/);
  assert.match(materialThumbnail, /data-drag-source/);
  assert.match(materialThumbnail, /draggable=\{material\.kind !== 'text' && draggable\}/);
  assert.match(canvas, /registerPlacementShelfNodes/);
  assert.match(canvas, /movePlacementShelfNode/);
  assert.match(figma, /DEFAULT_FIGMA_BRIDGE_BASE/);
  assert.match(figma, /FIGMA_BRIDGE_TIMEOUT_MS/);
  assert.match(figma, /ensureFigmaBridgeRunning/);
  assert.match(figma, /画布会自动启动本机 Figma bridge/);
  assert.match(figma, /AbortController/);
  assert.match(figma, /localhost:3845/);
  assert.match(figma, /127\.0\.0\.1/);
  assert.match(figmaBridgeUtil, /function ensureFigmaBridgeRunning/);
  assert.match(figmaBridgeUtil, /function startFigmaBridgeOnAppStart/);
  assert.match(figmaBridgeUtil, /T8_FIGMA_BRIDGE_AUTOSTART/);
  assert.match(figmaBridgeUtil, /ELECTRON_RUN_AS_NODE/);
  assert.match(figmaBridgeUtil, /tools['"], ['"]figma-bridge['"], ['"]server\.cjs/);
  assert.match(figmaBridge, /T8 Penguin Canvas Bridge/);
  assert.match(figmaBridge, /T8_FIGMA_BRIDGE_HOST \|\| '127\.0\.0\.1'/);
  assert.match(figmaBridge, /BRIDGE_VERSION = 2/);
  assert.match(figmaBridge, /PUBLIC_BASE = `http:\/\/localhost:\$\{PORT\}`/);
  assert.match(figmaBridge, /assetBase: PUBLIC_BASE/);
  assert.match(figmaBridge, /EADDRINUSE/);
  assert.match(figmaBridge, /already running/);
  assert.match(figmaBridge, /found an older bridge/);
  assert.match(figmaBridge, /T8_FIGMA_BRIDGE_KEEP_ALIVE_ON_EXISTING/);
  assert.match(figmaBridge, /\/import/);
  assert.match(figmaBridge, /\/claim/);
  assert.match(figmaBridge, /\/asset\//);
  assert.match(figmaStart, /T8_FIGMA_BRIDGE_KEEP_ALIVE_ON_EXISTING=1/);
  assert.match(figmaStart, /if not "%EXIT_CODE%"=="0"/);
  assert.match(figmaStart, /if "%EXIT_CODE%"=="0"/);
  assert.match(figmaStart, /桥接进程已正常退出/);
  assert.doesNotMatch(figmaStart, /node tools\\figma-bridge\\server\.cjs\r?\n\s*echo\.\r?\n\s*pause/);
  assert.match(figmaManifest, /localhost:3845/);
  assert.doesNotMatch(figmaManifest, /127\.0\.0\.1:3845/);
  assert.match(figmaManifest, /networkAccess/);
  assert.match(figmaManifest, /documentAccess/);
  assert.doesNotMatch(figmaManifest, /containsWidget/);
  assert.doesNotMatch(figmaManifest, /widgetApi/);
  assert.match(read('../tools/figma-bridge/README.md'), /Import plugin from manifest/);
  assert.match(read('../tools/figma-bridge/README.md'), /Import widget from manifest/);
  assert.match(figmaUi, /Old bridge detected/);
  assert.match(figmaUi, /bridgeReady/);
  assert.match(figmaUi, /unhandledrejection/);
  assert.match(figmaPlugin, /figma\.createImageAsync/);
  assert.match(figmaPlugin, /figma\.createImage\(bytes\)/);
  assert.match(figmaPlugin, /function isLocalAssetUrl/);
  assert.match(figmaPlugin, /function loadImageFromBytesUrl/);
  assert.match(figmaPlugin, /function imageSizeFromBytes/);
  assert.match(figmaPlugin, /figma\.currentPage\.selection/);
  assert.match(figmaPlugin, /function showBridgeUi/);
  assert.match(figmaPlugin, /function inlineBridgeUiHtml/);
  assert.match(figmaPlugin, /Import next job/);
  assert.match(figmaPlugin, /typeof __html__ === 'string'/);
  assert.match(figmaPlugin, /function notifyError/);
  assert.doesNotMatch(figmaPlugin, /Plugin UI was not bundled/);
  assert.doesNotMatch(figmaPlugin, /\{\s*\.\.\./);
  assert.doesNotMatch(figmaPlugin, /`/);
});

test('LLM node defaults to the second built-in model', () => {
  const models = read('../src/providers/models.ts');
  const canvas = read('../src/components/Canvas.tsx');
  const llm = read('../src/components/nodes/LLMNode.tsx');
  const features = read('../features.json');

  assert.match(models, /export const DEFAULT_LLM_MODEL = 'gemini-3\.5-flash'/);
  assert.match(canvas, /llm:\s*\{[\s\S]*model:\s*'gemini-3\.5-flash'/);
  assert.match(llm, /gemini-3\.5-flash\(默认\)/);
  assert.match(features, /gemini-3\.5-flash 默认/);
});

test('topbar canvas tutorial panel replaces RH ApiKey shortcut in latest apps', () => {
  const app = read('../src/App.tsx');
  const features = read('../features.json');

  assert.match(app, /CANVAS_TUTORIALS/);
  assert.match(app, /画布教程/);
  assert.match(app, /基础功能教程第一弹1\.2\.3版/);
  assert.match(app, /BV18sG76AE9Y/);
  assert.match(app, /V8oCBhemmCQ/);
  assert.match(app, /BV1gSEA6GEDQ/);
  assert.match(app, /-nmX9oB-MX/);
  assert.match(app, /教程第十弹/);
  assert.match(app, /BV1N9Eg6QEHs/);
  assert.match(app, /zIW7PbEWQAs/);
  assert.match(app, /教程第十一弹/);
  assert.match(app, /BV1gGEz6VEDA/);
  assert.match(app, /oRT59Qf65KY/);
  assert.match(app, /教程第十二弹/);
  assert.match(app, /BV1phJs6oE2g/);
  assert.match(app, /BKV8YA-kKK4/);
  assert.match(app, /教程第十三弹/);
  assert.match(app, /牧场物语主题/);
  assert.match(app, /agens apikey多模态模型免费使用/);
  assert.match(app, /BV1tYjy6jEuG/);
  assert.match(app, /AH24lGHA9E0/);
  assert.match(app, /教程第十四弹/);
  assert.match(app, /VibeX联动发送功能及节点/);
  assert.match(app, /增强chrome反推插件/);
  assert.match(app, /目标框节点/);
  assert.match(app, /批量素材节点完善扩图/);
  assert.match(app, /BV1mj7h6CEYx/);
  assert.match(app, /wCOoTtuxQPM/);
  assert.match(app, /教程第十五弹/);
  assert.match(app, /新增植物大战僵尸主题/);
  assert.match(app, /新增PS插件支持Photoshop和画布发送及生成/);
  assert.match(app, /新增批量打标节点/);
  assert.match(app, /视频类素材左侧新增首尾帧/);
  assert.match(app, /BV1RoN76RE9m/);
  assert.match(app, /K65BqvSTfh4/);
  assert.match(app, /教程第十六弹/);
  assert.match(app, /支持贞贞的平价AI小屋/);
  assert.match(app, /全国内站模型比海外站便宜5-7\.5折/);
  assert.match(app, /RH API分离设置/);
  assert.match(app, /BV11zNM6jEQR/);
  assert.match(app, /_G9xLFd0DN0/);
  assert.ok(app.indexOf('画布教程') < app.indexOf('最新应用'));
  assert.doesNotMatch(app, /获取 RH ApiKey/);
  assert.doesNotMatch(app, /enterprise-api\/consumerApi/);
  assert.match(features, /canvasTutorialTopbarPanel/);
  assert.match(features, /教程第十三弹/);
  assert.match(features, /agens apikey多模态模型免费使用/);
  assert.match(features, /BV1tYjy6jEuG/);
  assert.match(features, /AH24lGHA9E0/);
  assert.match(features, /教程第十四弹/);
  assert.match(features, /VibeX联动发送功能及节点/);
  assert.match(features, /BV1mj7h6CEYx/);
  assert.match(features, /wCOoTtuxQPM/);
  assert.match(features, /教程第十五弹/);
  assert.match(features, /新增植物大战僵尸主题/);
  assert.match(features, /新增PS插件支持Photoshop和画布发送及生成/);
  assert.match(features, /新增批量打标节点/);
  assert.match(features, /视频类素材左侧新增首尾帧/);
  assert.match(features, /BV1RoN76RE9m/);
  assert.match(features, /K65BqvSTfh4/);
  assert.match(features, /教程第十六弹/);
  assert.match(features, /支持贞贞的平价AI小屋/);
  assert.match(features, /全国内站模型比海外站便宜5-7\.5折/);
  assert.match(features, /RH API分离设置/);
  assert.match(features, /BV11zNM6jEQR/);
  assert.match(features, /_G9xLFd0DN0/);
});
