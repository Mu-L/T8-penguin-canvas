import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  CREATIVE_DESK_FRAMES,
  CREATIVE_DESK_FRAME_COLORS,
  createCreativeDeskImageItem,
  exportCreativeDeskBackup,
  migrateCreativeDeskToViewportCoordinates,
  parseCreativeDeskBackup,
  resourceItemToCreativeDeskItem,
} from '../src/utils/creativeDesk.ts';

const require = createRequire(import.meta.url);

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

function creativeDeskFixture() {
  return {
    version: 1,
    defaultOpacity: 0.42,
    items: [
      {
        id: 'desk-image-1',
        kind: 'image',
        url: '/files/input/slamdunk-card.png',
        title: '球场贴纸',
        resourceId: 'res-image-1',
        x: 120,
        y: 80,
        width: 360,
        height: 220,
        scale: 1.15,
        rotation: -8,
        opacity: 0.42,
        frameId: 'poster-card',
        frameColorId: 'cream',
        zIndex: 3,
        locked: false,
        visible: true,
        createdAt: 1781452800000,
      },
    ],
  };
}

function assertRatioClose(actualWidth: number, actualHeight: number, sourceWidth: number, sourceHeight: number) {
  assert.ok(Math.abs((actualWidth / actualHeight) - (sourceWidth / sourceHeight)) < 0.003);
}

test('canvas route persists creative desk background state with normal saves and auto-save mirrors', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-creative-desk-canvas-'));
  const dataDir = path.join(tmpDir, 'data');
  const autoRoot = path.join(tmpDir, 'auto');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ canvasAutoSavePath: autoRoot }), 'utf8');

  const config = require('../backend/src/config.js');
  const oldConfig = {
    DATA_DIR: config.DATA_DIR,
    CANVAS_FILE: config.CANVAS_FILE,
    SETTINGS_FILE: config.SETTINGS_FILE,
    DEFAULT_CANVAS_AUTO_SAVE_DIR: config.DEFAULT_CANVAS_AUTO_SAVE_DIR,
    PROJECT_DB_FILE: config.PROJECT_DB_FILE,
    PROJECT_DB_BACKUP_FILE: config.PROJECT_DB_BACKUP_FILE,
  };
  t.after(async () => {
    await require('../backend/src/services/projectDatabase.js').getProjectDatabase(config).close();
    Object.assign(config, oldConfig);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  config.DATA_DIR = dataDir;
  config.CANVAS_FILE = path.join(dataDir, 'canvas_list.json');
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.DEFAULT_CANVAS_AUTO_SAVE_DIR = autoRoot;
  config.PROJECT_DB_FILE = path.join(dataDir, 'projects.sqlite3');
  config.PROJECT_DB_BACKUP_FILE = path.join(dataDir, 'projects.sqlite3.backup');
  fs.writeFileSync(
    config.CANVAS_FILE,
    JSON.stringify([{ id: 'canvas-creative-desk-test', name: '创作台', nodeCount: 0, createdAt: 1, updatedAt: 1 }]),
    'utf8',
  );

  const express = require('express');
  const canvasRouter = require('../backend/src/routes/canvas.js');
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/canvas', canvasRouter);

  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    server.closeAllConnections?.();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => (error ? reject(error) : resolve()));
    });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const body = {
    nodes: [],
    edges: [],
    viewport: { x: -80, y: 40, zoom: 0.75 },
    nextNodeSerialId: 9,
    creativeDesk: creativeDeskFixture(),
    theme: { id: 'legacy-theme', customTokens: { '--legacy-accent': '#123456' } },
    legacyPluginState: { providerSpecific: { enabled: true, nested: ['keep', 7] } },
    actorId: 'request-only-actor',
    baseRevision: 0,
  };

  const saved = await fetch(`${base}/api/canvas/canvas-creative-desk-test?allowEmpty=1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json());
  assert.equal(saved.success, true, saved.error);

  const loaded = await fetch(`${base}/api/canvas/canvas-creative-desk-test`).then((res) => res.json());
  assert.equal(loaded.success, true);
  assert.deepEqual(loaded.data.creativeDesk, body.creativeDesk);
  assert.deepEqual(loaded.data.theme, body.theme);
  assert.deepEqual(loaded.data.legacyPluginState, body.legacyPluginState);
  assert.equal(Object.hasOwn(loaded.data, 'actorId'), false);
  assert.equal(Object.hasOwn(loaded.data, 'baseRevision'), false);

  const mirrored = await fetch(`${base}/api/canvas/canvas-creative-desk-test/auto-save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json());
  assert.equal(mirrored.success, true, mirrored.error);
  const mirrorPayload = JSON.parse(fs.readFileSync(mirrored.data.path, 'utf8'));
  assert.deepEqual(mirrorPayload.creativeDesk, body.creativeDesk);
  assert.deepEqual(mirrorPayload.theme, body.theme);
  assert.deepEqual(mirrorPayload.legacyPluginState, body.legacyPluginState);
  assert.equal(Object.hasOwn(mirrorPayload, 'actorId'), false);
});

test('creative desk is wired through types, canvas UI, layer styles, and resource library references', () => {
  const types = read('../src/types/canvas.ts');
  const canvas = read('../src/components/Canvas.tsx');
  const layer = read('../src/components/CreativeDeskLayer.tsx');
  const css = read('../src/styles/index.css');

  assert.match(types, /export interface CreativeDeskItem/);
  assert.match(types, /export interface CreativeDeskState/);
  assert.match(types, /coordinateMode\?: 'viewport' \| 'flow'/);
  assert.match(types, /creativeDesk\?: CreativeDeskState/);
  assert.match(types, /frameColorId\?: CreativeDeskFrameColorId \| string/);

  assert.match(canvas, /import CreativeDeskLayer from '\.\/CreativeDeskLayer'/);
  assert.match(canvas, /const \[creativeDesk, rawSetCreativeDesk\] = useState<CreativeDeskState>/);
  assert.match(canvas, /const setCreativeDesk = useCallback\([\s\S]{0,420}?rawSetCreativeDesk\(next\.value\)/);
  assert.match(canvas, /data\.creativeDesk/);
  assert.match(canvas, /migrateCreativeDeskToViewportCoordinates\(data\.creativeDesk,\s*data\.viewport\)/);
  assert.match(canvas, /payload = \{ nodes: persistNodes, edges: persistEdges, viewport: getViewport\(\), nextNodeSerialId, creativeDesk/);
  assert.match(canvas, /nextNodeSerialId: nextNodeSerialIdRef\.current,\s*creativeDesk,/);
  assert.match(canvas, /setCreativeDesk\(migrateCreativeDeskToViewportCoordinates\(source\.creativeDesk,\s*source\.viewport\)\)/);
  assert.match(canvas, /\{!creativeDeskEditing && \(\s*<CreativeDeskLayer[\s\S]*creativeDesk=\{creativeDesk\}[\s\S]*editing=\{false\}/);
  assert.match(canvas, /const floatingControlRail = \(/);
  assert.match(canvas, /<\/ReactFlow>\s*\{creativeDeskEditing && \(\s*<CreativeDeskLayer[\s\S]*creativeDesk=\{creativeDesk\}[\s\S]*editing=\{creativeDeskEditing\}/);
  assert.match(canvas, /\{creativeDeskEditing && \([\s\S]*<CreativeDeskLayer[\s\S]*\/>\s*\)\}\s*\{floatingControlRail\}/);
  assert.match(canvas, /data-canvas-floating-ui="creative-desk-toggle"/);
  assert.match(canvas, /t8-control-rail-creative-desk/);
  assert.match(canvas, /getResourceItems\(\{ kind: 'image'/);
  assert.match(canvas, /addResourceItem\(\{[\s\S]*kind:\s*'image'/);

  assert.match(css, /\.t8-control-rail\s*\{[\s\S]*z-index:\s*78/);
  assert.match(css, /\.t8-creative-desk-layer/);
  assert.match(css, /\.t8-creative-desk-layer\s*\{[\s\S]*pointer-events:\s*none/);
  assert.match(css, /\.t8-creative-desk-layer\.is-editing\s*\{[\s\S]*pointer-events:\s*auto/);
  assert.match(css, /\.t8-creative-desk-layer\.is-editing\s*\{[\s\S]*z-index:\s*64/);
  assert.match(css, /\.t8-creative-desk-layer:not\(\.is-editing\)\s*\{[\s\S]*z-index:\s*1/);
  assert.match(css, /\.t8-creative-desk-panel/);
  assert.match(css, /\.t8-creative-desk-frame--poster-card/);
  assert.match(css, /\.t8-creative-desk-frame--glass-card/);
  assert.match(css, /\.t8-creative-desk-frame--sticker/);
  assert.match(css, /--t8-creative-desk-frame-color/);
  assert.match(css, /\.t8-creative-desk-color-grid/);
  assert.match(css, /--t8-placement-shelf-clearance:\s*128px/);

  assert.match(layer, /window\.addEventListener\('keydown', handleCreativeDeskKeyDown/);
  assert.match(layer, /event\.key !== 'Delete' && event\.key !== 'Backspace'/);
  assert.match(layer, /t8-creative-desk-hidden-list/);
  assert.match(layer, /onActiveItemChange\(null\)/);
});

test('creative desk editing gestures are shielded from ReactFlow capture panning', () => {
  const layer = read('../src/components/CreativeDeskLayer.tsx');

  assert.match(layer, /const stopCreativeDeskPointerEvent = \(/);
  assert.match(layer, /nativeEvent\.stopImmediatePropagation\?\.\(\)/);
  assert.match(layer, /const startItemDragFromNativeEvent = \(/);
  assert.match(layer, /document\.addEventListener\('pointerdown', handleCreativeDeskNativePointerDown, true\)/);
  assert.match(layer, /document\.addEventListener\('mousedown', handleCreativeDeskNativePointerDown, true\)/);
  assert.match(layer, /}, \[editing\]\);/);
  assert.match(layer, /event\.target instanceof Element/);
  assert.match(layer, /closest\('\[data-creative-desk-action\]'\)/);
  assert.match(layer, /dataset\.creativeDeskAction/);
  assert.match(layer, /className=\{`t8-creative-desk-item nodrag nopan nowheel/);
  assert.match(layer, /className="t8-creative-desk-handle t8-creative-desk-handle--rotate nodrag nopan nowheel"/);
  assert.match(layer, /className="t8-creative-desk-handle t8-creative-desk-handle--scale nodrag nopan nowheel"/);
  assert.match(layer, /data-creative-desk-action="move"/);
  assert.match(layer, /data-creative-desk-action="rotate"/);
  assert.match(layer, /data-creative-desk-action="scale"/);
  assert.match(layer, /onPointerDownCapture=\{stopCreativeDeskPointerEvent\}/);
  assert.match(layer, /onMouseDownCapture=\{stopCreativeDeskPointerEvent\}/);
  assert.match(layer, /window\.addEventListener\('pointermove', handleWindowPointerMove, true\)/);
  assert.match(layer, /window\.addEventListener\('pointerup', handleWindowPointerUp, \{ capture: true, once: true \}\)/);
});

test('creative desk backups export and import sanitized viewport background state', () => {
  const backup = exportCreativeDeskBackup(creativeDeskFixture());
  assert.equal(backup.schema, 't8-creative-desk-background');
  assert.equal(backup.version, 1);
  assert.equal(backup.creativeDesk.coordinateMode, 'viewport');
  assert.equal(backup.creativeDesk.items.length, 1);
  assert.ok(backup.exportedAt);

  const imported = parseCreativeDeskBackup(JSON.stringify({
    schema: 't8-creative-desk-background',
    version: 1,
    creativeDesk: {
      ...creativeDeskFixture(),
      items: [
        ...creativeDeskFixture().items,
        {
          ...creativeDeskFixture().items[0],
          id: 'bad-data-url',
          url: 'data:image/png;base64,abc',
        },
      ],
    },
  }));
  assert.equal(imported.items.length, 1);
  assert.equal(imported.items[0].id, 'desk-image-1');
  assert.equal((imported.items[0] as any).coordinateMode, undefined);
  assert.equal(imported.coordinateMode, 'viewport');

  assert.throws(() => parseCreativeDeskBackup('{"schema":"wrong"}'), /不是创作台背景备份/);
});

test('creative desk exposes 50 distinct designed frame styles with CSS coverage', () => {
  const css = read('../src/styles/index.css');
  const frameIds = CREATIVE_DESK_FRAMES.map((frame) => frame.id);
  const designedFrameIds = frameIds.filter((id) => id !== 'none');
  assert.equal(designedFrameIds.length, 50);
  assert.equal(new Set(frameIds).size, frameIds.length);
  assert.equal(new Set(CREATIVE_DESK_FRAMES.map((frame) => frame.label)).size, CREATIVE_DESK_FRAMES.length);
  for (const id of frameIds) {
    assert.match(css, new RegExp(`\\.t8-creative-desk-frame--${id}\\b`));
  }
});

test('creative desk background uses fixed viewport-local coordinates instead of ReactFlow world coordinates', () => {
  const canvas = read('../src/components/Canvas.tsx');
  const layer = read('../src/components/CreativeDeskLayer.tsx');
  const centerBlock = canvas.slice(
    canvas.indexOf('const getCreativeDeskCenter = useCallback(() => {'),
    canvas.indexOf('const loadCreativeDeskResources = useCallback(async () => {'),
  );
  const dragBlock = layer.slice(
    layer.indexOf('const startItemDrag ='),
    layer.indexOf('const handleWindowPointerUp ='),
  );

  assert.doesNotMatch(layer, /ViewportPortal/);
  assert.doesNotMatch(layer, /useReactFlow/);
  assert.doesNotMatch(layer, /getViewport/);
  assert.doesNotMatch(dragBlock, /viewport\.zoom/);
  assert.doesNotMatch(dragBlock, /\/ zoom/);
  assert.doesNotMatch(centerBlock, /screenToFlowPosition/);
  assert.match(centerBlock, /rect\s*\?\s*\{\s*x:\s*rect\.width\s*\/\s*2,\s*y:\s*rect\.height\s*\/\s*2\s*\}/);
  assert.match(layer, /centerX\s*=\s*rect\.left\s*\+\s*item\.x/);
  assert.match(layer, /centerY\s*=\s*rect\.top\s*\+\s*item\.y/);
  assert.match(dragBlock, /dx\s*=\s*event\.clientX\s*-\s*drag\.startX/);
  assert.match(dragBlock, /dy\s*=\s*event\.clientY\s*-\s*drag\.startY/);
});

test('creative desk migrates old flow-coordinate background data into fixed viewport coordinates once', () => {
  const migrated = migrateCreativeDeskToViewportCoordinates(creativeDeskFixture(), {
    x: -80,
    y: 40,
    zoom: 0.75,
  });
  assert.equal(migrated.coordinateMode, 'viewport');
  assert.equal(migrated.items[0].x, 10);
  assert.equal(migrated.items[0].y, 100);
  assert.ok(Math.abs(migrated.items[0].scale - 0.8625) < 0.00001);

  const stable = migrateCreativeDeskToViewportCoordinates(migrated, {
    x: -999,
    y: 999,
    zoom: 3,
  });
  assert.deepEqual(stable, migrated);
});

test('creative desk image items preserve source aspect ratio and expose frame colors', () => {
  const portrait = createCreativeDeskImageItem({
    url: '/files/input/portrait.png',
    title: '竖图',
    width: 1080,
    height: 1920,
  });
  assert.ok(portrait.height > portrait.width);
  assertRatioClose(portrait.width, portrait.height, 1080, 1920);

  const landscape = createCreativeDeskImageItem({
    url: '/files/input/wide.png',
    title: '横图',
    width: 1920,
    height: 1080,
  });
  assert.ok(landscape.width > landscape.height);
  assertRatioClose(landscape.width, landscape.height, 1920, 1080);

  const resource = resourceItemToCreativeDeskItem({
    id: 'res-portrait',
    kind: 'image',
    categoryId: 'image_uncategorized',
    title: '资源库竖图',
    originalName: 'portrait.png',
    fileUrl: '/api/resources/file/res-portrait',
    size: 1,
    tags: [],
    favorite: false,
    width: 900,
    height: 1350,
    createdAt: 1,
    updatedAt: 1,
  }, { x: 0, y: 0 });
  assert.ok(resource);
  assert.ok(resource.height > resource.width);
  assert.equal(resource.frameColorId, 'cream');

  assert.ok(CREATIVE_DESK_FRAME_COLORS.length >= 6);
  assert.ok(CREATIVE_DESK_FRAME_COLORS.some((color) => color.id === 'black'));
  assert.ok(CREATIVE_DESK_FRAME_COLORS.some((color) => color.id === 'rose'));
});
