import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { Node } from '@xyflow/react';
import { EXECUTABLE_NODE_TYPES } from '../src/config/executableNodeTypes.ts';
import { prepareRunAction } from '../src/utils/runPreflight.ts';
import {
  CANVAS_NODE_RUN_REQUEST_EVENT,
  createCanvasNodeRunRequestId,
  requestCanvasNodeRun,
} from '../src/utils/canvasRunRequest.ts';

type ComponentAudit = {
  file: string;
  types: string[];
  requestBoundaryCalls: number;
  directClickHandlers: string[];
  directSubmitHandlers?: string[];
};

// Every production executable type is deliberately classified here. Shared
// renderers list every type they own; requestBoundaryCalls counts source call
// sites into the shared boundary (several mode buttons may share one safe helper).
const CANVAS_REQUEST_COMPONENTS: ComponentAudit[] = [
  { file: 'FeishuBitableInputNode.tsx', types: ['feishu-bitable-input'], requestBoundaryCalls: 1, directClickHandlers: ['fetchRecords'] },
  { file: 'FeishuBitableOutputNode.tsx', types: ['feishu-bitable-output'], requestBoundaryCalls: 1, directClickHandlers: ['writeRecords'] },
  { file: 'ImageNode.tsx', types: ['image', 'edit'], requestBoundaryCalls: 1, directClickHandlers: ['handleGenerate'] },
  { file: 'VideoNode.tsx', types: ['video'], requestBoundaryCalls: 1, directClickHandlers: ['handleGenerate'] },
  { file: 'SeedanceNode.tsx', types: ['seedance'], requestBoundaryCalls: 1, directClickHandlers: ['handleGenerate'] },
  { file: 'AudioNode.tsx', types: ['audio'], requestBoundaryCalls: 1, directClickHandlers: ['handleGenerate'] },
  { file: 'LLMNode.tsx', types: ['llm'], requestBoundaryCalls: 1, directClickHandlers: ['handleSend'] },
  { file: 'RunningHubNode.tsx', types: ['runninghub', 'runninghub-wallet'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'RHToolsNode.tsx', types: ['rh-tools'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'RHToolboxNode.tsx', types: ['rh-toolbox'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'FalToolboxNode.tsx', types: ['fal-toolbox'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  // Quick/studio prompt submits persist their surface and latest prompt before
  // entering Canvas, so neither the button nor Enter may call the provider.
  { file: 'GrokOAuthAgentNode.tsx', types: ['grok-oauth-agent'], requestBoundaryCalls: 1, directClickHandlers: ['handleQuickRun'] },
  { file: 'CodexCliAgentNode.tsx', types: ['codex-cli-agent'], requestBoundaryCalls: 4, directClickHandlers: ['handleQuickRun'], directSubmitHandlers: ['handleQuickRun'] },
  { file: 'CodexImageConjureNode.tsx', types: ['codex-image-conjure'], requestBoundaryCalls: 3, directClickHandlers: ['handleGenerate'], directSubmitHandlers: ['handleGenerate'] },
  { file: 'ComfyUIStoreNode.tsx', types: ['comfyui-store'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'DirectorStoryboardNode.tsx', types: ['director-storyboard'], requestBoundaryCalls: 1, directClickHandlers: ['runStoryboard', 'runBridge', 'refreshStoryboardOutputs'] },
  { file: 'ArtistStyleMasterNode.tsx', types: ['artist-style-master'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun', 'runArtistStyleOutput'] },
  { file: 'AnimeTagMasterNode.tsx', types: ['anime-tag-master'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun', 'runAnimeTagOutput'] },
  { file: 'PresetImageNode.tsx', types: ['multi-angle-3d', 'panorama-720', 'penguin-portrait'], requestBoundaryCalls: 1, directClickHandlers: ['handleGenerate'] },
  { file: 'DrawingBoardNode.tsx', types: ['drawing-board'], requestBoundaryCalls: 2, directClickHandlers: ['exportBoard'] },
  { file: 'ImageCompareNode.tsx', types: ['image-compare'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'FrameExtractorNode.tsx', types: ['frame-extractor'], requestBoundaryCalls: 1, directClickHandlers: ['handleExtract'] },
  { file: 'FramePairNode.tsx', types: ['frame-pair'], requestBoundaryCalls: 1, directClickHandlers: ['handleExtract'] },
  { file: 'LoopNode.tsx', types: ['loop'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'SubflowNode.tsx', types: ['subflow'], requestBoundaryCalls: 1, directClickHandlers: ['triggerRun'] },
  { file: 'PickFromSetNode.tsx', types: ['pick-from-set'], requestBoundaryCalls: 1, directClickHandlers: ['handlePick'] },
  { file: 'ImageOpFrame.tsx', types: ['resize', 'remove-bg', 'upscale', 'grid-crop'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'CombineNode.tsx', types: ['combine'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'GridEditorNode.tsx', types: ['grid-editor'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'RemoveAiWatermarkNode.tsx', types: ['remove-ai-watermark'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'ToolboxParamNode.tsx', types: ['cinematic', 'video-motion', 'multi-angle-visual'], requestBoundaryCalls: 3, directClickHandlers: ['handleRun'] },
  { file: 'PortraitMasterNode.tsx', types: ['portrait-master'], requestBoundaryCalls: 2, directClickHandlers: ['handleRun'] },
  { file: 'PoseMasterNode.tsx', types: ['pose-master'], requestBoundaryCalls: 1, directClickHandlers: ['runPose'] },
  { file: 'AggregateParserNode.tsx', types: ['aggregate-parser'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'BatchProcessorNode.tsx', types: ['batch-processor'], requestBoundaryCalls: 1, directClickHandlers: ['runBatch'] },
  { file: 'BatchTaggerNode.tsx', types: ['batch-tagger'], requestBoundaryCalls: 1, directClickHandlers: ['runBatch'] },
  { file: 'TopazImageUpscaleNode.tsx', types: ['topaz-image-upscale'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'TopazVideoUpscaleNode.tsx', types: ['topaz-video-upscale'], requestBoundaryCalls: 1, directClickHandlers: ['handleRun'] },
  { file: 'FaceExpression3DNode.tsx', types: ['face-expression-3d'], requestBoundaryCalls: 1, directClickHandlers: ['runSingle'] },
  { file: 'Panorama3DNode.tsx', types: ['panorama-3d'], requestBoundaryCalls: 1, directClickHandlers: ['generatePanorama'] },
];

const NO_NODE_PRIMARY_COMPONENTS: ComponentAudit[] = [
  { file: 'UploadNode.tsx', types: ['upload'], requestBoundaryCalls: 0, directClickHandlers: ['handleRun'] },
  // RandomRoute is scheduled by a root/group run and has no rendered run button;
  // its internal branch trigger remains part of the already-authorized root Run.
  { file: 'RandomRouteNode.tsx', types: ['random-route'], requestBoundaryCalls: 0, directClickHandlers: ['handleRun', 'triggerRun'] },
];

function readNode(file: string): string {
  return readFileSync(new URL(`../src/components/nodes/${file}`, import.meta.url), 'utf8');
}

function jsxHandlerTexts(source: string, file: string, attributeName: 'onClick' | 'onSubmit'): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const texts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(parsed) === attributeName && node.initializer) {
      texts.push(node.initializer.getText(parsed));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return texts;
}

function containsIdentifier(source: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(source);
}

test('primary node run audit classifies every shared executable type exactly once', () => {
  assert.equal(containsIdentifier('{handleRun}', 'handleRun'), true, 'handler audit must detect exact identifiers');
  assert.equal(containsIdentifier('{handleRunner}', 'handleRun'), false, 'handler audit must not match identifier prefixes');
  const audited = [...CANVAS_REQUEST_COMPONENTS, ...NO_NODE_PRIMARY_COMPONENTS].flatMap((entry) => entry.types);
  assert.equal(audited.length, 51, 'shared executable audit count changed; classify every new or removed type explicitly');
  assert.equal(new Set(audited).size, audited.length, 'audit matrix must not classify an executable type twice');
  assert.deepEqual([...audited].sort(), [...EXECUTABLE_NODE_TYPES].sort());
});

test('every audited primary idle entry requests the Canvas run pipeline', () => {
  for (const entry of CANVAS_REQUEST_COMPONENTS) {
    const source = readNode(entry.file);
    assert.match(source, /import \{[^}]*\brequestCanvasNodeRun\b[^}]*\} from '\.\.\/\.\.\/utils\/canvasRunRequest';/,
      `${entry.file} must import the Canvas request boundary`);
    const requestCalls = source.match(/\brequestCanvasNodeRun\s*\(/g)?.length || 0;
    assert.equal(requestCalls, entry.requestBoundaryCalls, `${entry.file} request boundary count changed; audit the rendered entries`);

    const clickHandlers = jsxHandlerTexts(source, entry.file, 'onClick');
    for (const handler of entry.directClickHandlers) {
      assert.equal(clickHandlers.some((text) => containsIdentifier(text, handler)), false,
        `${entry.file} primary onClick must not invoke ${handler} directly`);
    }
    const submitHandlers = jsxHandlerTexts(source, entry.file, 'onSubmit');
    for (const handler of entry.directSubmitHandlers || []) {
      assert.equal(submitHandlers.some((text) => containsIdentifier(text, handler)), false,
        `${entry.file} primary onSubmit must not invoke ${handler} directly`);
    }
  }

  const batchTagger = readNode('BatchTaggerNode.tsx');
  assert.doesNotMatch(batchTagger, /onClick=\{\(\) => void runBatch\(false\)\}/,
    'BatchTagger full run must use Canvas');
  assert.doesNotMatch(batchTagger, /onClick=\{\(\) => void runBatch\(true\)\}/,
    'BatchTagger retry-failed must use Canvas');
  assert.match(batchTagger, /const requestBatchTagRun = \(runMode: BatchTagRunMode\) => \{[\s\S]*?createCanvasNodeRunRequestId\(id, 'batch-tag-retry'\)[\s\S]*?batchTagRunRequestId: requestId[\s\S]*?requestCanvasNodeRun\(id, requestId \? \{ requestId \} : \{\}\)/);
  assert.match(batchTagger, /reporter\.runContext\?\.requestId === liveData\?\.batchTagRunRequestId[\s\S]*?liveData\?\.batchTagRunMode === 'retry-failed'[\s\S]*?await runBatch\(retryOnly\)[\s\S]*?batchTagRunRequestId: ''/);

  const director = readNode('DirectorStoryboardNode.tsx');
  assert.doesNotMatch(director, /onClick=\{\(\) => runStoryboard\(\)\}/,
    'complete storyboard execution must not bypass the Canvas pipeline');
  assert.doesNotMatch(director, /onClick=\{\(\) => runStoryboard\(activeShot\.id\)\}/,
    'per-shot rerun must not bypass the Canvas pipeline');
  assert.match(director, /const requestStoryboardRun = \(mode: DirectorStoryboardRunMode, targetId = ''\) => \{[\s\S]*?createCanvasNodeRunRequestId\(id, DIRECTOR_STORYBOARD_RUN_PURPOSE\[mode\]\)[\s\S]*?directorStoryboardRunTargetId: normalizedTargetId[\s\S]*?directorStoryboardRunRequestId: requestId[\s\S]*?requestCanvasNodeRun\(id, \{ requestId \}\)/);
  assert.match(director, /const contextRequestId = String\(reporter\.runContext\?\.requestId[\s\S]*?contextRequestId !== persistedRequestId[\s\S]*?switch \(requestedMode\)[\s\S]*?case 'shot':[\s\S]*?await runStoryboard\(requestedTargetId, reporter\)[\s\S]*?directorStoryboardRunRequestId: ''/);
  assert.match(director, /onClick=\{\(\) => requestStoryboardRun\('shot', activeShot\.id\)\}/);
  assert.match(director, /onClick=\{\(\) => requestStoryboardRun\('all'\)\}/);
  assert.match(director, /onClick=\{\(\) => requestStoryboardRun\('bridge-one', activeBridge\.id\)\}/);
  assert.match(director, /onClick=\{\(\) => requestStoryboardRun\('bridge-all'\)\}/);
  assert.match(director, /onClick=\{\(\) => requestStoryboardRun\('refresh-bridge-one', activeBridge\.id\)\}/);
  assert.match(director, /onClick=\{\(\) => requestStoryboardRun\('refresh-all'\)\}/);

  const codex = readNode('CodexImageConjureNode.tsx');
  assert.match(codex, /createCanvasNodeRunRequestId\(id, 'codex-queue'\)[\s\S]*?codexConjureRunMode: 'queue'[\s\S]*?codexConjureRunRequestId: requestId[\s\S]*?requestCanvasNodeRun\(id, \{ requestId \}\)/);
  assert.match(codex, /const persistedRequestId = String\(liveData\?\.codexConjureRunRequestId[\s\S]*?contextRequestId !== persistedRequestId[\s\S]*?requestedMode !== 'queue'[\s\S]*?await runQueue\(reporter\)[\s\S]*?codexConjureRunRequestId: ''/);

  const batchProcessor = readNode('BatchProcessorNode.tsx');
  assert.doesNotMatch(batchProcessor, /onClick=\{retryFailed\}/,
    'BatchProcessor retry-failed must not bypass the Canvas pipeline');
  assert.match(batchProcessor, /const requestBatchProcessorRun = \(mode: BatchProcessorRunMode\) => \{[\s\S]*?createCanvasNodeRunRequestId\(id, 'batch-processor-retry'\)[\s\S]*?batchProcessorRunRequestId: requestId[\s\S]*?requestCanvasNodeRun\(id, requestId \? \{ requestId \} : \{\}\)/);
  assert.match(batchProcessor, /reporter\.runContext\?\.requestId === liveData\?\.batchProcessorRunRequestId[\s\S]*?liveData\?\.batchProcessorRunMode === 'retry-failed'[\s\S]*?await runBatch\(retryOnly\)[\s\S]*?batchProcessorRunRequestId: ''/);
  assert.match(batchProcessor, /onClick=\{\(\) => requestBatchProcessorRun\('all'\)\}/);
  assert.match(batchProcessor, /onClick=\{\(\) => requestBatchProcessorRun\('retry-failed'\)\}/);

  const artist = readNode('ArtistStyleMasterNode.tsx');
  assert.match(artist, /const requestArtistStyleRun = useCallback\(\(mode: ArtistStyleOutputMode\) => \{[\s\S]*?artistStyleOutputMode: mode,[\s\S]*?requestCanvasNodeRun\(id\);/);
  assert.match(artist, /const liveData = rf\.getNode\(id\)\?\.data[\s\S]*?liveData\?\.artistStyleOutputMode[\s\S]*?runArtistStyleOutput\(mode\)/);

  const anime = readNode('AnimeTagMasterNode.tsx');
  assert.match(anime, /const requestAnimeTagRun = useCallback\(\(mode: AnimeTagOutputMode\) => \{[\s\S]*?animeTagOutputMode: mode,[\s\S]*?requestCanvasNodeRun\(id\);/);
  assert.match(anime, /const liveData = rf\.getNode\(id\)\?\.data[\s\S]*?liveData\?\.animeTagOutputMode[\s\S]*?runAnimeTagOutput\(mode\)/);
});

test('components without a rendered primary action keep provider execution off onClick', () => {
  for (const entry of NO_NODE_PRIMARY_COMPONENTS) {
    const source = readNode(entry.file);
    assert.doesNotMatch(source, /\brequestCanvasNodeRun\s*\(/,
      `${entry.file} gained a primary entry; move it to the request matrix and audit it`);
    const clickHandlers = jsxHandlerTexts(source, entry.file, 'onClick');
    for (const handler of entry.directClickHandlers) {
      assert.equal(clickHandlers.some((text) => containsIdentifier(text, handler)), false,
        `${entry.file} must not add a direct ${handler} run button`);
    }
  }
});

test('secondary run modes and targets participate in the execution graph digest', () => {
  const fullNodes: Node[] = [
    {
      id: 'director', type: 'director-storyboard', position: { x: 0, y: 0 },
      data: { directorStoryboardRunMode: 'all', directorStoryboardRunTargetId: '' },
    },
    {
      id: 'processor', type: 'batch-processor', position: { x: 100, y: 0 },
      data: { batchProcessorRunMode: 'all' },
    },
    {
      id: 'tagger', type: 'batch-tagger', position: { x: 200, y: 0 },
      data: { batchTagRunMode: 'all' },
    },
    {
      id: 'codex', type: 'codex-image-conjure', position: { x: 300, y: 0 },
      data: { codexConjureRunMode: 'single' },
    },
  ];
  const preview = (nodes: Node[]) => prepareRunAction({
    actionKind: 'run-group',
    projectId: 'project-e4',
    canvasId: 'canvas-e4',
    currentRevision: 9,
    expectedRevision: 9,
    nodes,
    edges: [],
    selectedNodeIds: nodes.map((node) => node.id),
    diagnostics: { structure: [], capability: [], asset: [], policy: [] },
    cost: { known: true, amount: 1, currency: 'USD' },
    hostContextDigest: `sha256:${'a'.repeat(64)}`,
  });
  const full = preview(fullNodes);
  const variants = [
    fullNodes.map((node) => node.id === 'director'
      ? { ...node, data: { ...node.data, directorStoryboardRunMode: 'shot', directorStoryboardRunTargetId: 'shot-7' } }
      : node),
    fullNodes.map((node) => node.id === 'director'
      ? { ...node, data: { ...node.data, directorStoryboardRunMode: 'bridge-one', directorStoryboardRunTargetId: 'bridge-3' } }
      : node),
    fullNodes.map((node) => node.id === 'director'
      ? { ...node, data: { ...node.data, directorStoryboardRunMode: 'refresh-bridge-one', directorStoryboardRunTargetId: 'bridge-3' } }
      : node),
    fullNodes.map((node) => node.id === 'processor'
      ? { ...node, data: { ...node.data, batchProcessorRunMode: 'retry-failed' } }
      : node),
    fullNodes.map((node) => node.id === 'tagger'
      ? { ...node, data: { ...node.data, batchTagRunMode: 'retry-failed' } }
      : node),
    fullNodes.map((node) => node.id === 'codex'
      ? { ...node, data: { ...node.data, codexConjureRunMode: 'queue' } }
      : node),
  ];
  for (const nodes of variants) {
    const secondary = preview(nodes);
    assert.notEqual(secondary.scope.executionGraphDigest, full.scope.executionGraphDigest);
    assert.notEqual(secondary.digest, full.digest);
  }
});

test('canvas node request is bounded to one normalized node id and optional exact request id', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const dispatched: Event[] = [];
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent: (event: Event) => { dispatched.push(event); return true; } },
    });
    assert.equal(requestCanvasNodeRun('  node-7  '), true);
    const requestId = createCanvasNodeRunRequestId('node-7', 'retry-failed');
    assert.match(requestId, /^[a-zA-Z0-9._:-]{8,160}$/);
    assert.equal(requestCanvasNodeRun('node-7', { requestId }), true);
    assert.equal(requestCanvasNodeRun('node-7', { requestId: 'bad id' }), false);
    assert.equal(requestCanvasNodeRun('   '), false);
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].type, CANVAS_NODE_RUN_REQUEST_EVENT);
    assert.deepEqual((dispatched[0] as CustomEvent).detail, { nodeId: 'node-7' });
    assert.deepEqual((dispatched[1] as CustomEvent).detail, { nodeId: 'node-7', requestId });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete (globalThis as { window?: unknown }).window;
  }
});
