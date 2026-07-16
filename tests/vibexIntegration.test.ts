import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

function projectFile(file: string) {
  return path.resolve(process.cwd(), file);
}

function read(file: string) {
  return fs.readFileSync(projectFile(file), 'utf8');
}

function exists(file: string) {
  return fs.existsSync(projectFile(file));
}

test('VibeX integration has a dedicated bridge contract and node registration', () => {
  assert.ok(exists('src/utils/vibexBridge.ts'), 'missing VibeX bridge utility');
  const bridge = read('src/utils/vibexBridge.ts');
  assert.match(bridge, /VIBEX_APP_ID\s*=\s*['"]app-bcbdf4c87cbc4a1eae20733de3ce40e4['"]/);
  assert.match(bridge, /VIBEX_INVITE_CODE\s*=\s*['"]rh-v1121['"]/);
  assert.match(bridge, /VIBEX_ONLINE_URL/);
  assert.match(bridge, /https:\/\/vibex\.runninghub\.cn\/p\/\$\{VIBEX_APP_ID\}\/\?inviteCode=\$\{VIBEX_INVITE_CODE\}/);
  assert.match(bridge, /RUNNINGHUB_INVITE_URL\s*=\s*`https:\/\/www\.runninghub\.cn\/\?inviteCode=\$\{VIBEX_INVITE_CODE\}`/);
  assert.doesNotMatch(bridge, /userPost/);
  assert.doesNotMatch(bridge, /VIBEX_LOCAL_PATH/);
  assert.doesNotMatch(bridge, /\/vibex\//);
  assert.match(bridge, /VIBEX_MESSAGE_CONTRACT/);
  assert.match(bridge, /['"]t8:vibex-result['"]/);
  assert.match(bridge, /normalizeVibeXResultPayload/);
  assert.match(bridge, /buildVibeXSendNodeSpecs/);

  const types = read('src/types/canvas.ts');
  assert.match(types, /\|\s*['"]vibex['"]/, 'NodeType must include vibex');

  assertProductionNodeSchema('vibex', {
    label: 'VibeX工作台',
    category: 'rh',
    inputs: ['text', 'image', 'video', 'audio'],
    outputs: ['text', 'image', 'video', 'audio'],
    executable: false,
    icon: 'Clapperboard',
  });
});

test('Canvas exposes VibeX as a toolbar workflow, canvas node, and postMessage receiver', () => {
  assert.ok(exists('src/components/nodes/VibeXNode.tsx'), 'missing VibeXNode component');
  const node = read('src/components/nodes/VibeXNode.tsx');
  assert.match(node, /VIBEX_ONLINE_URL/);
  assert.match(node, /RUNNINGHUB_INVITE_URL/);
  assert.match(node, /iframe/);
  assert.match(node, /allow-same-origin/);
  assert.match(node, /allow-scripts/);
  assert.match(node, /allow-forms/);
  assert.match(node, /allow-popups/);
  assert.match(node, /allow-popups-to-escape-sandbox/);
  assert.match(node, /allow-top-navigation-by-user-activation/);
  assert.match(node, /allow-downloads/);
  assert.match(node, /新窗口/);
  assert.match(node, /注册 RH/);
  assert.match(node, /resources\/extension\/web-image-reverse\//);
  assert.match(node, /Chrome 扩展程序/);
  assert.match(node, /加载已解压/);
  assert.match(node, /openUrl\(RUNNINGHUB_INVITE_URL\)/);
  assert.match(node, /isFrameMode\(data\?\.vibexFrameMode\)\s*\?\s*data\.vibexFrameMode\s*:\s*['"]online['"]/);
  assert.match(node, /\(\['online',\s*'custom'\]\s*as\s*VibeXFrameMode\[\]\)/);
  assert.doesNotMatch(node, /'local'/);
  assert.doesNotMatch(node, /本地 \/vibex/);
  assert.doesNotMatch(node, /本地模式路径/);
  assert.doesNotMatch(node, /userPost/);

  const toolbar = read('src/components/CanvasToolbar.tsx');
  assert.match(toolbar, /onOpenVibeXWorkbench:\s*\(\)\s*=>\s*void/);
  assert.match(toolbar, /onCreateVibeXNode:\s*\(\)\s*=>\s*void/);
  assert.match(toolbar, /aria-label=['"]打开 VibeX 工作台['"]/);
  assert.match(toolbar, /aria-label=['"]创建 VibeX 节点['"]/);

  const canvas = read('src/components/Canvas.tsx');
  assert.match(canvas, /lazyCanvasNode\(\(\)\s*=>\s*import\(['"]\.\/nodes\/VibeXNode['"]\)/);
  assert.match(canvas, /vibex:\s*VibeXNode/);
  assert.match(canvas, /handleCreateVibeXNode/);
  assert.match(canvas, /handleOpenVibeXWorkbench/);
  assert.match(canvas, /handleVibeXMessage/);
  assert.match(canvas, /VIBEX_MESSAGE_CONTRACT/);
  assert.match(canvas, /buildVibeXSendNodeSpecs/);
  assert.match(canvas, /addEventListener\(['"]message['"],\s*handleVibeXMessage\)/);
  assert.match(canvas, /materialNodesFromSpecs\(specs, nodesRef\.current, base/);
});

test('VibeX canvas node uses adaptive persisted dimensions and manual resizing', () => {
  const node = read('src/components/nodes/VibeXNode.tsx');
  assert.doesNotMatch(node, /const\s+NODE_WIDTH\s*=\s*720/);
  assert.doesNotMatch(node, /const\s+FRAME_HEIGHT\s*=\s*520/);
  assert.match(node, /DEFAULT_VIBEX_NODE_WIDTH\s*=\s*1080/);
  assert.match(node, /DEFAULT_VIBEX_NODE_HEIGHT\s*=\s*820/);
  assert.match(node, /getAdaptiveVibeXSize/);
  assert.match(node, /vibexNodeWidth/);
  assert.match(node, /vibexNodeHeight/);
  assert.match(node, /ResizableCorners/);
  assert.match(node, /keepAspectRatio=\{false\}/);
  assert.match(node, /onResize=\{handleResize\}/);
  assert.match(node, /onResizeEnd=\{handleResize\}/);
  assert.match(node, /适配窗口/);
  assert.match(node, /getVibeXFrameHeight/);
  assert.match(node, /style=\{\{\s*height:\s*frameHeight,\s*background:\s*['"]#fff['"]\s*\}\}/s);
  assert.doesNotMatch(node, /className="block min-h-\[360px\] w-full flex-1"/);

  const canvas = read('src/components/Canvas.tsx');
  assert.match(canvas, /vibexNodeWidth:\s*1080/);
  assert.match(canvas, /vibexNodeHeight:\s*820/);
  assert.match(canvas, /vibexFrameMode:\s*['"]online['"]/);
  assert.doesNotMatch(canvas, /vibexFrameMode:\s*['"]local['"]/);

  const placement = read('src/utils/nodePlacement.ts');
  assert.match(placement, /vibex:\s*\{\s*w:\s*1080,\s*h:\s*820\s*\}/);
});

test('packaged app keeps VibeX online-only and verifies the web-image extension bridge', () => {
  const pkg = JSON.parse(read('package.json'));
  const resources = JSON.stringify(pkg.build?.extraResources || []);
  assert.doesNotMatch(resources, /vibex\/dist/);
  assert.match(resources, /extension\/web-image-reverse/);

  const postBuild = read('electron/_post_build.cjs');
  assert.doesNotMatch(postBuild, /checkVibeXResources/);
  assert.match(postBuild, /checkWebImageExtensionResources/);
  assert.match(postBuild, /runninghub-bridge\.js/);

  const server = read('backend/src/server.js');
  assert.match(server, /\/api\/vibex-bridge/);
  assert.doesNotMatch(server, /app\.use\(['"]\/vibex['"]/);
  assert.doesNotMatch(server, /app\.get\(\/\^\\\/vibex/);
  assert.doesNotMatch(server, /\/__pb/);
  assert.doesNotMatch(server, /\/uc/);
  assert.doesNotMatch(server, /VIBEX_DIST/);

  const config = read('backend/src/config.js');
  assert.doesNotMatch(config, /VIBEX_DIST/);

  const vite = read('vite.config.ts');
  assert.doesNotMatch(vite, /['"]\/vibex['"]/);
  assert.doesNotMatch(vite, /['"]\/__pb['"]/);
  assert.doesNotMatch(vite, /['"]\/uc['"]/);
});
