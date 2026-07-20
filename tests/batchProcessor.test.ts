import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  buildBatchOutputName,
  classifyBatchFile,
  createExclusiveBatchProcessorOperationPatch,
  normalizeBatchConcurrency,
  resolveBatchProcessorOperation,
  normalizeBatchRetrySettings,
  runBatchWorkPool,
  summarizeBatchProgress,
  type BatchProcessorItem,
} from '../src/utils/batchProcessor.ts';
import { copyFileToOutput, openOutputFolder } from '../src/services/imageOps.ts';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

const require = createRequire(import.meta.url);

function read(rel: string) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

test('batch processor naming keeps originals or applies a deterministic rename pattern', () => {
  const item: BatchProcessorItem = {
    id: 'item-1',
    kind: 'image',
    url: '/files/input/up_demo.png',
    name: '头像 原图.png',
    relativePath: '角色/头像 原图.png',
    size: 100,
    mime: 'image/png',
    status: 'pending',
  };

  assert.equal(
    buildBatchOutputName(item, 4, {
      mode: 'original',
      pattern: '{name}',
      sequenceStart: 1,
      indexPadding: 3,
      outputFormat: 'keep',
    }),
    '头像_原图.png',
  );

  assert.equal(
    buildBatchOutputName(item, 4, {
      mode: 'rename',
      pattern: 'batch-{index}-{folder}-{name}',
      sequenceStart: 10,
      indexPadding: 4,
      outputFormat: 'webp',
    }),
    'batch-0014-角色-头像_原图.webp',
  );
});

test('batch processor classifies common media files and summarizes node-local progress', () => {
  assert.equal(classifyBatchFile('demo.PNG', 'image/png'), 'image');
  assert.equal(classifyBatchFile('clip.mov', ''), 'video');
  assert.equal(classifyBatchFile('voice.wav', ''), 'audio');
  assert.equal(classifyBatchFile('model.glb', ''), 'model3d');
  assert.equal(classifyBatchFile('notes.txt', 'text/plain'), null);

  const summary = summarizeBatchProgress([
    { id: 'a', kind: 'image', url: '/a.png', name: 'a.png', status: 'success' },
    { id: 'b', kind: 'image', url: '/b.png', name: 'b.png', status: 'error' },
    { id: 'c', kind: 'image', url: '/c.png', name: 'c.png', status: 'running' },
    { id: 'd', kind: 'image', url: '/d.png', name: 'd.png', status: 'pending' },
  ]);

  assert.deepEqual(summary, {
    total: 4,
    done: 2,
    ok: 1,
    fail: 1,
    running: 1,
    pending: 1,
    percent: 50,
    status: 'running',
  });
});

test('batch processor operation flags are exclusive and normalize legacy multi-select data', () => {
  assert.equal(resolveBatchProcessorOperation({
    batchProcessorTrimBlackBars: true,
    batchProcessorRemoveBg: true,
    batchProcessorExpandCanvas: true,
  }), 'trim');
  assert.equal(resolveBatchProcessorOperation({
    batchProcessorOperation: 'upscale',
    batchProcessorTrimBlackBars: true,
    batchProcessorRemoveBg: true,
  }), 'upscale');

  assert.deepEqual(createExclusiveBatchProcessorOperationPatch('expand'), {
    batchProcessorOperation: 'expand',
    batchProcessorTrimBlackBars: false,
    batchProcessorRemoveBg: false,
    batchProcessorExpandCanvas: true,
    batchProcessorUpscale: false,
  });
  assert.deepEqual(createExclusiveBatchProcessorOperationPatch(null), {
    batchProcessorOperation: '',
    batchProcessorTrimBlackBars: false,
    batchProcessorRemoveBg: false,
    batchProcessorExpandCanvas: false,
    batchProcessorUpscale: false,
  });
});

test('batch processor work pool bounds concurrency, retries failures, and preserves result order', async () => {
  assert.equal(normalizeBatchConcurrency(0, 4), 4);
  assert.equal(normalizeBatchConcurrency(99, 2, 1, 6), 6);
  assert.deepEqual(normalizeBatchRetrySettings({ retryCount: 3, continueOnError: false }), {
    retryCount: 3,
    continueOnError: false,
  });

  let active = 0;
  let maxActive = 0;
  const events: string[] = [];
  const results = await runBatchWorkPool({
    items: [0, 1, 2, 3, 4],
    concurrency: 2,
    retryCount: 1,
    retryDelayMs: 1,
    continueOnError: true,
    onItemStatus: (event) => {
      events.push(`${event.index}:${event.status}:${event.attempt}`);
    },
    worker: async (item, index, attempt) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (item === 2 && attempt === 1) throw new Error('transient');
        if (item === 4) throw new Error('permanent');
        return `ok-${index}-${attempt}`;
      } finally {
        active -= 1;
      }
    },
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(results.map((item) => item.status), ['success', 'success', 'success', 'success', 'error']);
  assert.equal(results[2].attempts, 2);
  assert.equal(results[4].attempts, 2);
  assert.equal(results[2].value, 'ok-2-2');
  assert.match(results[4].error || '', /permanent/);
  assert.ok(events.includes('2:retry:1'));
  assert.ok(events.includes('4:error:2'));
});

test('batch processor node is a toolbox executable that does not auto-output to the canvas', () => {
  const types = read('src/types/canvas.ts');
  const canvas = read('src/components/Canvas.tsx');
  const loop = read('src/components/nodes/LoopNode.tsx');
  const placement = read('src/utils/nodePlacement.ts');
  const node = read('src/components/nodes/BatchProcessorNode.tsx');
  const features = read('features.json');

  assertProductionNodeSchema('batch-processor', {
    label: '批量素材处理',
    category: 'toolbox',
    inputs: ['image', 'video', 'audio', 'model3d'],
    outputs: [],
    executable: true,
  });
  assert.match(types, /\|\s*'batch-processor'/);
  assert.match(canvas, /const BatchProcessorNode = lazyCanvasNode\(\(\) => import\('\.\/nodes\/BatchProcessorNode'\)/);
  assert.match(canvas, /'batch-processor':\s*BatchProcessorNode/);
  assert.match(canvas, /'batch-processor':\s*\{[\s\S]*batchProcessorNameMode:\s*'original'/);
  assert.match(loop, /topologicalSort\(routePlanned\.nodes, routePlanned\.edges, EXECUTABLE_NODE_TYPES\)/);
  assert.match(placement, /'batch-processor':\s*\{\s*w:\s*640,\s*h:\s*560\s*\}/);
  assert.match(features, /"nodeType":\s*"batch-processor"/);
  assert.match(features, /"totalNodes":\s*54/);
  assert.match(node, /batchProcessorItems/);
  assert.match(node, /batchProcessorResults/);
  assert.match(node, /copy-to-output/);
  assert.match(node, /已启用/);
  assert.match(node, /未启用/);
  assert.match(node, /开启后点击开始批处理/);
  assert.match(node, /批量扩图已启用，将调用 RH AI扩图/);
  assert.match(node, /仅图像素材可用/);
  assert.match(node, /批量抠图、批量扩图和高清放大统一调用 RH 工具箱能力层/);
  assert.match(node, /batchProcessorLocalConcurrency/);
  assert.match(node, /batchProcessorRhConcurrency/);
  assert.match(node, /batchProcessorRetryCount/);
  assert.match(node, /batchProcessorContinueOnError/);
  assert.match(node, /batchProcessorCutoutOutputRatio/);
  assert.match(node, /batchProcessorExpandPresetId/);
  assert.match(node, /resolveBatchProcessorOperation/);
  assert.match(node, /createExclusiveBatchProcessorOperationPatch/);
  assert.match(node, /data-batch-status/);
  assert.match(node, /正在处理/);
  assert.match(node, /runBatchWorkPool/);
  assert.match(node, /runRhImageCapability/);
  assert.match(node, /RH_IMAGE_CAPABILITY_PRESETS/);
  assert.match(node, /RH高清/);
  assert.match(node, /RH 4K/);
  assert.match(node, /并发/);
  assert.match(node, /重试失败/);
  assert.match(node, /normalizeBatchConcurrency\(d\.batchProcessorRhConcurrency,\s*2,\s*1,\s*10\)/);
  assert.match(node, /\[1,\s*2,\s*3,\s*4,\s*5,\s*6,\s*7,\s*8,\s*9,\s*10\]\.map\(\(item\) => <option key=\{item\} value=\{item\}>\{item\}<\/option>\)/);
  assert.doesNotMatch(node, /imageUrls:\s*result/);
  assert.doesNotMatch(node, /videoUrls:\s*result/);
  assert.doesNotMatch(node, /audioUrls:\s*result/);
});

test('batch processor routes cutout, expand, and upscale through RH toolbox only', () => {
  const node = read('src/components/nodes/BatchProcessorNode.tsx');

  assert.match(node, /runRhStep\('RH高清抠图',\s*'image\.cutout'/);
  assert.match(node, /runRhStep\('RH AI扩图',\s*'image\.expand'/);
  assert.match(node, /runRhStep\('RH 4K高清放大',\s*'image\.upscale'/);
  assert.match(node, /const selectedOperation = resolveBatchProcessorOperation\(d\)/);
  assert.match(node, /const hasRhSteps = cutoutSelected \|\| expandSelected \|\| upscaleSelected/);
  assert.match(node, /const activeConcurrency = hasRhSteps \? rhConcurrency : localConcurrency/);
  assert.match(node, /抠图后比例/);
  assert.match(node, /batchProcessorCutoutOutputRatio/);
  assert.match(node, /RH并发/);

  assert.doesNotMatch(node, /opRemoveBg/);
  assert.doesNotMatch(node, /opUpscale/);
  assert.doesNotMatch(node, /本地抠图/);
  assert.doesNotMatch(node, /本地扩图/);
  assert.doesNotMatch(node, /本地快速/);
  assert.doesNotMatch(node, /本地扩画布/);
  assert.doesNotMatch(node, /本地倍数/);
  assert.doesNotMatch(node, /普通放大/);
  assert.doesNotMatch(node, /batchProcessorCutoutEngine/);
  assert.doesNotMatch(node, /batchProcessorExpandEngine/);
  assert.doesNotMatch(node, /batchProcessorUpscaleEngine/);
});

test('batch processor services report missing backend routes clearly', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('<html><body>Cannot POST /api/files/copy-to-output</body></html>', {
    status: 404,
    headers: { 'Content-Type': 'text/html' },
  })) as typeof fetch;
  try {
    await assert.rejects(
      () => copyFileToOutput('/files/input/a.png', 'a.png'),
      /批处理归档接口未就绪|重启后端服务/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('batch processor exposes a safe output folder shortcut without clipping the right column', () => {
  const node = read('src/components/nodes/BatchProcessorNode.tsx');
  const service = read('src/services/imageOps.ts');
  const filesRoute = read('backend/src/routes/files.js');
  const electronMain = read('electron/main.cjs');
  const electronPreload = read('electron/preload.cjs');
  const viteEnv = read('src/vite-env.d.ts');
  const features = read('features.json');

  assert.match(node, /openOutputFolder/);
  assert.match(node, /打开输出文件夹/);
  assert.match(node, /grid-cols-\[minmax\(0,\s*1\.05fr\)_minmax\(0,\s*\.95fr\)\]/);
  assert.match(node, /className="min-w-0 space-y-2"/);
  assert.match(service, /export async function openOutputFolder/);
  assert.match(service, /window\.t8pc\?\.openPath/);
  assert.match(filesRoute, /router\.post\('\/open-output-folder'/);
  assert.match(filesRoute, /spawn\(/);
  assert.match(filesRoute, /shell:\s*false/);
  assert.match(filesRoute, /windowsHide:\s*false/);
  assert.match(electronMain, /ipcMain\.handle\('t8pc:open-path'/);
  assert.match(electronPreload, /openPath:\s*\(targetPath\)\s*=>\s*ipcRenderer\.invoke\('t8pc:open-path'/);
  assert.match(viteEnv, /openPath:\s*\(targetPath:\s*string\)/);
  assert.match(features, /打开 output\/batch 文件夹/);
});

test('batch processor output folder service reports missing route clearly', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('<html><body>Cannot POST /api/files/open-output-folder</body></html>', {
    status: 404,
    headers: { 'Content-Type': 'text/html' },
  })) as typeof fetch;
  try {
    await assert.rejects(
      () => openOutputFolder('batch'),
      /打开输出文件夹接口未就绪|重启后端服务/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('batch processor backend routes process every local image step and final archive', async () => {
  const express = require('express');
  const sharp = require('sharp');
  const config = require('../backend/src/config.js');
  const imageOpsRouter = require('../backend/src/routes/imageOps.js');
  const filesRouter = require('../backend/src/routes/files.js');

  const oldConfig = {
    INPUT_DIR: config.INPUT_DIR,
    OUTPUT_DIR: config.OUTPUT_DIR,
    THUMBNAILS_DIR: config.THUMBNAILS_DIR,
  };
  const root = mkdtempSync(join(tmpdir(), 't8-batch-'));
  config.INPUT_DIR = join(root, 'input');
  config.OUTPUT_DIR = join(root, 'output');
  config.THUMBNAILS_DIR = join(root, 'thumbs');
  mkdirSync(config.INPUT_DIR, { recursive: true });
  mkdirSync(config.OUTPUT_DIR, { recursive: true });
  mkdirSync(config.THUMBNAILS_DIR, { recursive: true });

  const sourcePath = join(config.INPUT_DIR, 'bars.png');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="black"/><rect x="0" y="3" width="10" height="4" fill="#ff3355"/></svg>`;
  writeFileSync(sourcePath, await sharp(Buffer.from(svg)).png().toBuffer());

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/image', imageOpsRouter);
  app.use('/api/files', filesRouter);
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path: string, body: any) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    assert.equal(res.ok, true, `${path} failed: ${JSON.stringify(json)}`);
    assert.equal(json.success, true, `${path} returned success=false`);
    return json.data;
  };

  try {
    const trim = await post('/api/image/trim-border', { imageUrl: '/files/input/bars.png', mode: 'black', axis: 'vertical' });
    assert.equal(trim.crop.h, 4);
    assert.deepEqual(trim.crop.removed, { top: 3, right: 0, bottom: 3, left: 0 });
    const removeBg = await post('/api/image/remove-bg', { imageUrl: trim.imageUrl });
    const pad = await post('/api/image/pad-canvas', { imageUrl: removeBg.imageUrl, ratio: '1:1' });
    assert.equal(pad.width, pad.height);
    const up = await post('/api/image/upscale', { imageUrl: pad.imageUrl, scale: 2 });
    assert.equal(up.scale, 2);
    const converted = await post('/api/image/convert', { imageUrl: up.imageUrl, format: 'webp', quality: 80 });
    assert.match(converted.imageUrl, /\.webp$/);
    const copied = await post('/api/files/copy-to-output', { url: converted.imageUrl, filename: 'final.webp', subdir: 'batch' });
    assert.equal(copied.filename, 'final.webp');
    assert.match(copied.url, /\/files\/output\/batch\/final\.webp$/);
    const opened = await post('/api/files/open-output-folder', { subdir: 'batch', dryRun: true });
    assert.equal(opened.subdir, 'batch');
    assert.equal(opened.opened, false);
    assert.match(opened.path, /output[\\/]batch$/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    config.INPUT_DIR = oldConfig.INPUT_DIR;
    config.OUTPUT_DIR = oldConfig.OUTPUT_DIR;
    config.THUMBNAILS_DIR = oldConfig.THUMBNAILS_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

test('trim-border supports white, transparent, four-side auto, and manual pixels with crop feedback', async () => {
  const express = require('express');
  const sharp = require('sharp');
  const config = require('../backend/src/config.js');
  const imageOpsRouter = require('../backend/src/routes/imageOps.js');

  const oldConfig = {
    INPUT_DIR: config.INPUT_DIR,
    OUTPUT_DIR: config.OUTPUT_DIR,
    THUMBNAILS_DIR: config.THUMBNAILS_DIR,
  };
  const root = mkdtempSync(join(tmpdir(), 't8-batch-trim-'));
  config.INPUT_DIR = join(root, 'input');
  config.OUTPUT_DIR = join(root, 'output');
  config.THUMBNAILS_DIR = join(root, 'thumbs');
  mkdirSync(config.INPUT_DIR, { recursive: true });
  mkdirSync(config.OUTPUT_DIR, { recursive: true });
  mkdirSync(config.THUMBNAILS_DIR, { recursive: true });

  writeFileSync(
    join(config.INPUT_DIR, 'white-bars.png'),
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#fff"/><rect x="2" y="1" width="4" height="6" fill="#223344"/></svg>`)).png().toBuffer(),
  );
  writeFileSync(
    join(config.INPUT_DIR, 'alpha-bars.png'),
    await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="none"/><rect x="1" y="2" width="6" height="4" fill="#dd3366"/></svg>`)).png().toBuffer(),
  );

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/image', imageOpsRouter);
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body: any) => {
    const res = await fetch(`${base}/api/image/trim-border`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    assert.equal(res.ok, true, JSON.stringify(json));
    assert.equal(json.success, true);
    return json.data;
  };

  try {
    const white = await post({ imageUrl: '/files/input/white-bars.png', mode: 'white', axis: 'all', threshold: 8 });
    assert.deepEqual(white.crop.removed, { top: 1, right: 2, bottom: 1, left: 2 });
    assert.equal(white.crop.w, 4);
    assert.equal(white.crop.h, 6);

    const alpha = await post({ imageUrl: '/files/input/alpha-bars.png', mode: 'transparent', axis: 'all', threshold: 8 });
    assert.deepEqual(alpha.crop.removed, { top: 2, right: 1, bottom: 2, left: 1 });
    assert.equal(alpha.crop.w, 6);
    assert.equal(alpha.crop.h, 4);

    const manual = await post({
      imageUrl: '/files/input/white-bars.png',
      strategy: 'manual',
      axis: 'all',
      manual: { top: 1, right: 1, bottom: 2, left: 2 },
    });
    assert.deepEqual(manual.crop.removed, { top: 1, right: 1, bottom: 2, left: 2 });
    assert.equal(manual.crop.w, 5);
    assert.equal(manual.crop.h, 5);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    config.INPUT_DIR = oldConfig.INPUT_DIR;
    config.OUTPUT_DIR = oldConfig.OUTPUT_DIR;
    config.THUMBNAILS_DIR = oldConfig.THUMBNAILS_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

test('batch processor remove-bg has a visible local effect on simple solid backgrounds', async () => {
  const express = require('express');
  const sharp = require('sharp');
  const config = require('../backend/src/config.js');
  const imageOpsRouter = require('../backend/src/routes/imageOps.js');

  const oldConfig = {
    INPUT_DIR: config.INPUT_DIR,
    OUTPUT_DIR: config.OUTPUT_DIR,
    THUMBNAILS_DIR: config.THUMBNAILS_DIR,
  };
  const root = mkdtempSync(join(tmpdir(), 't8-batch-rmbg-'));
  config.INPUT_DIR = join(root, 'input');
  config.OUTPUT_DIR = join(root, 'output');
  config.THUMBNAILS_DIR = join(root, 'thumbs');
  mkdirSync(config.INPUT_DIR, { recursive: true });
  mkdirSync(config.OUTPUT_DIR, { recursive: true });
  mkdirSync(config.THUMBNAILS_DIR, { recursive: true });

  const sourcePath = join(config.INPUT_DIR, 'solid-bg.png');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#ffffff"/><circle cx="6" cy="6" r="3" fill="#ff3355"/></svg>`;
  writeFileSync(sourcePath, await sharp(Buffer.from(svg)).png().toBuffer());

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/image', imageOpsRouter);
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/api/image/remove-bg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: '/files/input/solid-bg.png' }),
    });
    const json = await res.json();
    assert.equal(res.ok, true, JSON.stringify(json));
    assert.equal(json.success, true);
    assert.doesNotMatch(String(json.data.warning || ''), /占位/);

    const file = join(config.OUTPUT_DIR, decodeURIComponent(String(json.data.imageUrl).replace('/files/output/', '')));
    const raw = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => raw.data[(y * raw.info.width + x) * 4 + 3];
    assert.ok(alphaAt(0, 0) < 30, `corner should be transparent, alpha=${alphaAt(0, 0)}`);
    assert.ok(alphaAt(6, 6) > 200, `subject should stay opaque, alpha=${alphaAt(6, 6)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    config.INPUT_DIR = oldConfig.INPUT_DIR;
    config.OUTPUT_DIR = oldConfig.OUTPUT_DIR;
    config.THUMBNAILS_DIR = oldConfig.THUMBNAILS_DIR;
    rmSync(root, { recursive: true, force: true });
  }
});

test('batch processor roadmap records no canvas output and common batch operations', () => {
  const roadmap = read('roadmap.md');

  assert.match(roadmap, /批量素材处理/);
  assert.match(roadmap, /完成后不自动生成输出素材节点/);
  assert.match(roadmap, /节点内显示进度、完成反馈和失败报告/);
  assert.match(roadmap, /原名字/);
  assert.match(roadmap, /改名字/);
  assert.match(roadmap, /去除上下黑边/);
  assert.match(roadmap, /批量抠图/);
  assert.match(roadmap, /批量扩图/);
  assert.match(roadmap, /批量高清放大/);
  assert.match(roadmap, /R512 批量素材处理 RH 能力层升级/);
  assert.match(roadmap, /并发队列/);
  assert.match(roadmap, /RH 4K/);
});
