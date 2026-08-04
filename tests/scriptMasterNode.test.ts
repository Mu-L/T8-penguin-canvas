import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('script master is registered as a passive professional workbench node', () => {
  assertProductionNodeSchema('script-master', {
    label: '剧本大师',
    category: 'core',
    inputs: ['text', 'image', 'video', 'audio'],
    outputs: ['text', 'metadata'],
    executable: false,
    icon: 'ScrollText',
    description: /剧本解析.*多轨时间线.*PromptPack/,
  });
  const canvas = read('src/components/Canvas.tsx');
  const types = read('src/types/canvas.ts');
  const placement = read('src/utils/nodePlacement.ts');
  assert.match(canvas, /ScriptMasterNode/);
  assert.match(canvas, /'script-master': ScriptMasterNode/);
  assert.match(canvas, /scriptMasterProject: null/);
  assert.match(types, /\| 'script-master'/);
  assert.match(placement, /'script-master': \{ w: 390, h: 360 \}/);
});

test('script master workbench exposes the frozen information architecture and multi-track promise', () => {
  const node = read('src/components/nodes/ScriptMasterNode.tsx');
  for (const text of ['全局设置', '原始剧本', '素材与引用轨', '镜头检查器', '多轨时间线', '当前编译提示词']) {
    assert.match(node, new RegExp(text));
  }
  assert.match(node, /patchScriptMasterProjectSettings/);
  assert.match(node, /每个参考图\/音频都有独立稳定别名与轨道/);
  assert.match(node, /分析剧本/);
  assert.match(node, /LLM 候选审阅/);
  assert.match(node, /候选与采纳分离/);
  assert.match(node, /打开工作台不会自动分析或生成/);
  assert.match(node, /Provider 调用 0/);
  assert.match(node, /accept="image\/\*,video\/\*"/);
  assert.match(node, /accept="audio\/\*"/);
  for (const text of ['选择', '修剪', '切刀', '平移', '框选', '平均分配', 'Shift/Ctrl 多选']) {
    assert.match(node, new RegExp(text));
  }
  assert.match(node, /applyVideoEditTimelineControllerCommand/);
  assert.match(node, /moveScriptMasterTimelineItems/);
  assert.match(node, /trimScriptMasterTimelineItem/);
  assert.match(node, /splitScriptMasterTimelineItem/);
  assert.match(node, /undoWorkbenchChange/);
  assert.match(node, /patchScriptMasterTimelineTrack/);
  assert.match(node, /SCRIPT_MASTER_TIMELINE_VERTICAL_OVERSCAN/);
  assert.match(node, /visibleTimelineTracks/);
  assert.match(node, /SCRIPT_MASTER_ASSET_OVERSCAN/);
  assert.match(node, /visibleAssets/);
  assert.match(node, /sampleScriptMasterWaveform/);
  assert.match(node, /mediaProbeAbortRef\.current\?\.abort/);
  assert.match(node, /t8-script-master-history-v1/);
  assert.match(node, /loadPersistedScriptMasterHistory/);
  assert.match(node, /restoreScriptMasterProjectSnapshot/);
  assert.match(node, /mergeScriptMasterTimelineItems/);
  assert.match(node, /role="grid"/);
  assert.match(node, /aria-rowcount/);
  assert.match(node, /aria-live="polite"/);
  assert.match(node, /aria-modal="true"/);
});

test('script master workbench keeps desktop typography readable without crowding panels or timeline rows', () => {
  const node = read('src/components/nodes/ScriptMasterNode.tsx');
  const styles = read('src/styles/index.css');
  assert.match(node, /SCRIPT_MASTER_TIMELINE_RULER_HEIGHT = 36/);
  assert.match(node, /SCRIPT_MASTER_TIMELINE_ROW_HEIGHT = 48/);
  assert.match(node, /SCRIPT_MASTER_TIMELINE_LABEL_WIDTH = 240/);
  assert.match(node, /SCRIPT_MASTER_ASSET_ROW_HEIGHT = 124/);
  assert.match(node, /grid-rows-\[minmax\(0,1fr\)_minmax\(320px,38vh\)\]/);
  assert.match(node, /2xl:grid-cols-\[330px_minmax\(640px,1fr\)_420px\]/);
  assert.match(node, /overflow-x-auto whitespace-nowrap/);
  assert.match(node, /grid-cols-\[240px_minmax\(900px,1fr\)\]/);
  assert.match(styles, /\[data-script-master-workbench="true"\] \[class~="text-\[8px\]"\][\s\S]*font-size: 12px/);
  assert.match(styles, /\[data-script-master-workbench="true"\] \[class~="text-\[10px\]"\][\s\S]*font-size: 14px/);
  assert.match(styles, /\[data-script-master-workbench="true"\] :is\(button, input, select, textarea\)\[class\][\s\S]*font-size: 14px/);
});

test('script master downstream writes require an exact CanvasPatch preview and explicit confirmation', () => {
  const node = read('src/components/nodes/ScriptMasterNode.tsx');
  const canvas = read('src/components/Canvas.tsx');
  const bridge = read('src/utils/scriptMasterCanvasBridge.ts');
  assert.match(node, /previewScriptMasterCanvasPatch/);
  assert.match(node, /确认写入画布/);
  assert.match(node, /不会自动启动任何生成任务/);
  assert.match(node, /recordScriptMasterDownstreamApply/);
  assert.match(canvas, /SCRIPT_MASTER_CANVAS_PATCH_REQUEST_EVENT/);
  assert.match(canvas, /handlePreviewCanvasPatch\(detail\.draft\)/);
  assert.match(canvas, /handleApplyCanvasPatch\(detail\.patch, detail\.preview\)/);
  assert.match(bridge, /action: 'preview'/);
  assert.match(bridge, /action: 'apply'/);
});

test('feature facts include the owner-approved v2.7.6 release scope without claiming provider generation evidence', () => {
  const features = JSON.parse(read('features.json'));
  assert.equal(features.totalNodes, 57);
  assert.equal(features.categories.core.count, 9);
  assert.equal(features.categories.core.nodes.some((node: any) => node.type === 'script-master'), true);
  assert.equal(features.nonExecutableNodeTypes.nodes.includes('script-master'), true);
  assert.equal(features.scriptMasterNodeDev.status, 'released-v2.7.6');
  assert.equal(features.scriptMasterNodeDev.releaseIncluded, true);
  assert.equal(features.scriptMasterNodeDev.schema, 't8-script-master-project-v1');
});
