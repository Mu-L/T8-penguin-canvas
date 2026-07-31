import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('../backend/src/config.js');
const proxy = require('../backend/src/routes/proxy.js');
const seedanceNz = require('../backend/src/providers/seedanceNz.js');

function tinyPng(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

function tinyWav(): Buffer {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(16_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(0, 40);
  return buffer;
}

function createResourceLibraryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-resource-upstream-'));
  fs.mkdirSync(path.join(root, 'image'), { recursive: true });
  fs.mkdirSync(path.join(root, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(root, 'image', 'library-image.png'), tinyPng());
  fs.writeFileSync(path.join(root, 'audio', 'library-audio.wav'), tinyWav());
  fs.writeFileSync(path.join(root, 'resource_library.json'), JSON.stringify({
    schema: 't8-resource-library',
    version: 1,
    categories: [],
    items: [
      {
        id: 'resource-image',
        kind: 'image',
        fileRel: 'image/library-image.png',
        originalName: '参考图片.png',
        // Simulate a stale same-kind subtype from an older library row.
        mime: 'image/jpeg',
      },
      {
        id: 'resource-audio',
        kind: 'audio',
        fileRel: 'audio/library-audio.wav',
        originalName: '参考音频.wav',
        // Simulate an older row without a useful MIME.
        mime: 'application/octet-stream',
      },
    ],
  }));
  return root;
}

async function withResourceLibrary<T>(run: (root: string) => Promise<T> | T): Promise<T> {
  const root = createResourceLibraryFixture();
  const previousSettingsFile = config.SETTINGS_FILE;
  const previousDefaultRoot = config.DEFAULT_RESOURCE_LIBRARY_DIR;
  config.SETTINGS_FILE = path.join(root, 'missing-settings.json');
  config.DEFAULT_RESOURCE_LIBRARY_DIR = root;
  try {
    return await run(root);
  } finally {
    config.SETTINGS_FILE = previousSettingsFile;
    config.DEFAULT_RESOURCE_LIBRARY_DIR = previousDefaultRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('resource-library upstream reader accepts real image and audio bytes instead of forcing image-only MIME', async () => {
  await withResourceLibrary(() => {
    const image = proxy._test.readResourceMediaRefBuffer('/api/resources/file/resource-image');
    assert.ok(image);
    assert.equal(image.detectedKind, 'image');
    assert.equal(image.mime, 'image/png');
    assert.equal(image.ext, 'png');
    assert.equal(image.originalName, '参考图片.png');

    const audio = proxy._test.readResourceMediaRefBuffer('/api/resources/file/resource-audio');
    assert.ok(audio);
    assert.equal(audio.detectedKind, 'audio');
    assert.equal(audio.mime, 'audio/wav');
    assert.equal(audio.ext, 'wav');
    assert.equal(audio.originalName, '参考音频.wav');

    assert.equal(
      proxy._test.readResourceImageRefBuffer('/api/resources/file/resource-audio'),
      null,
      'image-only conversion must continue rejecting audio resources',
    );
  });
});

test('seedance.nz uploads resource-library image and audio with their real names and MIME types', async () => {
  await withResourceLibrary(async () => {
    seedanceNz.resetCachesForTests();
    const uploaded: Array<{ name: string; type: string; bytes: Buffer }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      assert.match(url, /\/v1\/files\/upload$/);
      assert.ok(init?.body instanceof FormData);
      const file = init.body.get('file');
      assert.ok(file instanceof Blob);
      uploaded.push({
        name: String((file as File).name || ''),
        type: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      });
      return new Response(JSON.stringify({
        url: `https://cdn.example.com/upload-${uploaded.length}`,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const imageUrl = await seedanceNz.uploadMedia(
      '/api/resources/file/resource-image',
      'image',
      'resource-upstream-test-key',
      { uploadIntervalMs: 0, fetchImpl },
    );
    const audioUrl = await seedanceNz.uploadMedia(
      '/api/resources/file/resource-audio',
      'audio',
      'resource-upstream-test-key',
      { uploadIntervalMs: 0, fetchImpl },
    );

    assert.equal(imageUrl, 'https://cdn.example.com/upload-1');
    assert.equal(audioUrl, 'https://cdn.example.com/upload-2');
    assert.deepEqual(
      uploaded.map(({ name, type }) => ({ name, type })),
      [
        { name: '参考图片.png', type: 'image/png' },
        { name: '参考音频.wav', type: 'audio/wav' },
      ],
    );
    assert.deepEqual(uploaded[0].bytes, tinyPng());
    assert.deepEqual(uploaded[1].bytes, tinyWav());
  });
});

test('resource drag keeps filename and MIME metadata for extensionless resource URLs', () => {
  const drawer = fs.readFileSync(
    new URL('../src/components/ResourceLibraryDrawer.tsx', import.meta.url),
    'utf8',
  );
  const overlay = fs.readFileSync(
    new URL('../src/components/MaterialDragOverlay.tsx', import.meta.url),
    'utf8',
  );
  const audioNode = fs.readFileSync(
    new URL('../src/components/nodes/AudioNode.tsx', import.meta.url),
    'utf8',
  );

  assert.match(drawer, /'data-drag-name': item\.originalName \|\| item\.title/);
  assert.match(drawer, /'data-drag-mime': item\.mime \|\| ''/);
  assert.match(overlay, /getAttribute\('data-drag-name'\)/);
  assert.match(overlay, /getAttribute\('data-drag-mime'\)/);
  assert.match(audioNode, /uploadedFilename:\s*payload\.name \|\| ''/);
  assert.match(audioNode, /audioUploadExtension\(blob\.type,\s*preferredName,\s*url\)/);
});

test('shared workshop upload path no longer forces resource-library references through image-only validation', () => {
  const proxySource = fs.readFileSync(
    new URL('../backend/src/routes/proxy.js', import.meta.url),
    'utf8',
  );
  const helperStart = proxySource.indexOf('async function uploadRefToZhenzhen');
  const helperEnd = proxySource.indexOf('\n// ========================================================================', helperStart);
  const uploadHelper = helperStart >= 0 && helperEnd > helperStart
    ? proxySource.slice(helperStart, helperEnd)
    : '';

  assert.match(uploadHelper, /readResourceMediaRefBuffer\(trimmed/);
  assert.match(uploadHelper, /allowedKinds:\s*\['image', 'video', 'audio'\]/);
  assert.doesNotMatch(uploadHelper, /readResourceImageRefBuffer\(trimmed/);
});
