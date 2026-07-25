import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanImageUrlList,
  isImageLongEdgeCacheReady,
  normalizeImageLongEdgeLimit,
} from '../src/utils/imageLongEdge.ts';

function read(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('image long-edge settings accept only off, 1K and 2K', () => {
  assert.equal(normalizeImageLongEdgeLimit(1024), 1024);
  assert.equal(normalizeImageLongEdgeLimit(2048), 2048);
  assert.equal(normalizeImageLongEdgeLimit(0), 0);
  assert.equal(normalizeImageLongEdgeLimit(4096), 0);
  assert.equal(normalizeImageLongEdgeLimit('1024'), 0);
});

test('image long-edge cache is valid only for the same ordered sources and limit', () => {
  const sourceUrls = ['/files/input/a.png', '/files/input/b.png'];
  assert.equal(isImageLongEdgeCacheReady({
    limit: 1024,
    sourceUrls,
    cachedLimit: 1024,
    cachedSourceUrls: sourceUrls,
    cachedOutputUrls: ['/files/output/a.png', '/files/output/b.png'],
  }), true);
  assert.equal(isImageLongEdgeCacheReady({
    limit: 2048,
    sourceUrls,
    cachedLimit: 1024,
    cachedSourceUrls: sourceUrls,
    cachedOutputUrls: ['/files/output/a.png', '/files/output/b.png'],
  }), false);
  assert.equal(isImageLongEdgeCacheReady({
    limit: 1024,
    sourceUrls,
    cachedLimit: 1024,
    cachedSourceUrls: [...sourceUrls].reverse(),
    cachedOutputUrls: ['/files/output/a.png', '/files/output/b.png'],
  }), false);
  assert.deepEqual(cleanImageUrlList([' a ', '', 'a', 'b']), ['a', 'b']);
});

test('upload and output image sections expose shared 1K and 2K long-edge controls', () => {
  const buttons = read('../src/components/ImageLongEdgeButtons.tsx');
  const upload = read('../src/components/nodes/UploadNode.tsx');
  const output = read('../src/components/nodes/OutputNode.tsx');
  const hook = read('../src/hooks/useImageLongEdgeOutputs.ts');
  const service = read('../src/services/imageOps.ts');
  const route = read('../backend/src/routes/imageOps.js');

  assert.match(buttons, /\[1024,\s*2048\]/);
  assert.match(buttons, /active \? 0 : limit/);
  assert.match(buttons, /保持原始宽高比，不裁剪/);
  assert.match(upload, /<ImageLongEdgeButtons/);
  assert.match(output, /<ImageLongEdgeButtons/);
  assert.match(upload, /runMediaItems/);
  assert.match(output, /publishedImageUrls/);
  assert.match(upload, /data-drag-source=\{imageLongEdge\.limit === 0 \|\| imageLongEdge\.ready \? true : undefined\}/);
  assert.match(output, /data-drag-source=\{imageLongEdge\.limit === 0 \|\| imageLongEdge\.ready \? true : undefined\}/);
  assert.match(hook, /for \(const sourceUrl of cleanSources\)/);
  assert.match(service, /'resize-long-edge'/);
  assert.match(route, /router\.post\('\/resize-long-edge'/);
  assert.match(route, /withoutEnlargement:\s*true/);
  assert.match(route, /fit:\s*'fill'/);
  assert.match(route, /quality:\s*100/);
  assert.match(route, /lossless:\s*true/);
});
