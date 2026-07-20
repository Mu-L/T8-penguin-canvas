import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const maker = fs.readFileSync('src/components/nodes/ComfyUIAppMakerNode.tsx', 'utf8');
const store = fs.readFileSync('src/components/nodes/ComfyUIStoreNode.tsx', 'utf8');

test('ComfyUI app nodes keep the node shell draggable while controls remain protected', () => {
  assert.match(maker, /<div style=\{rootStyle\} className="relative nowheel">/);
  assert.doesNotMatch(maker, /<div style=\{rootStyle\} className="relative nodrag nowheel">/);
  assert.match(maker, /px-input nodrag nopan nowheel/);
  assert.match(maker, /px-btn nodrag nopan nowheel/);

  assert.match(store, /<div className="t8-comfyui-store-node relative flex flex-col nowheel" style=\{rootStyle\}>/);
  assert.match(store, /overflow: 'visible'/);
  assert.match(store, /<div className="flex min-h-0 flex-1 flex-col overflow-hidden" style=\{\{ borderRadius: isPixel \? 6 : 12 \}\}>/);
  assert.doesNotMatch(store, /<div className="relative flex flex-col nodrag nowheel" style=\{rootStyle\}>/);
  assert.doesNotMatch(store, /overflow: 'hidden',\s*boxShadow/);
  assert.match(store, /px-input nodrag nopan nowheel/);
  assert.match(store, /px-btn nodrag nopan nowheel/);
});

test('ComfyUI maker and store expose local library management controls', () => {
  assert.match(maker, /comfyMakerHiddenParamKeys/);
  assert.match(maker, /移除此参数/);
  assert.match(maker, /恢复全部已移除参数/);
  assert.match(maker, /comfyMakerExcludeRules/);
  assert.match(maker, /自动映射排除规则（可选）/);
  assert.match(maker, /排除采样器参数/);
  assert.match(maker, /applySampleWorkflow/);
  assert.match(maker, /载入样例/);
  assert.match(maker, /buildComfyWorkflowImportChecklist/);

  assert.match(store, /comfyuiStoreManageCategories/);
  assert.match(store, /新建分类/);
  assert.match(store, /导出本地自定义应用和分类/);
  assert.match(store, /设置应用分类/);
  assert.match(store, /删除应用/);
  assert.match(store, /missingRequirements/);
  assert.match(store, /当前应用需要更多上游素材/);
});

test('ComfyUI maker and store controls stop canvas and parent-card gesture hijacking', () => {
  assert.match(maker, /className="nodrag nopan nowheel inline-flex h-5 w-5/);
  assert.match(store, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(store, /onKeyDown=\{\(event\) => \{[\s\S]*event\.preventDefault\(\);[\s\S]*selectApp\(app\);[\s\S]*\}\}/);
  assert.match(store, /type="checkbox"[\s\S]*className="nodrag nopan nowheel"/);
});

test('ComfyUI store renders and propagates all output kinds through one aggregate output', () => {
  assert.match(store, /videoUrls/);
  assert.match(store, /audioUrls/);
  assert.match(store, /outputKinds/);
  assert.match(store, /primaryKind/);
  assert.match(store, /<video[\s\S]*controls/);
  assert.match(store, /<audio[\s\S]*controls/);
  assert.match(store, /ComfyUI 应用完成:[\s\S]*视频/);

  const canvas = fs.readFileSync('src/components/Canvas.tsx', 'utf8');
  assert.match(canvas, /t === ['"]comfyui-store['"]/);
  assert.match(canvas, /aggregateSource:\s*['"]comfyui-store['"]/);
  assert.match(canvas, /placement:auto-comfyui-output/);
  assert.match(canvas, /output-auto-\$\{n\.id\}[^\n]*aggregate/);
});
