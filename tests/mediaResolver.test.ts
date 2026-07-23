import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  mediaRefToAbsoluteUrl,
  normalizeT8LocalMediaRef,
  resolveMediaRef,
  resolveT8LocalMediaPath,
} = require('../backend/src/providers/mediaResolver.js');

test('mediaRefToAbsoluteUrl converts T8 local and resource URLs to backend absolute URLs', () => {
  assert.equal(
    mediaRefToAbsoluteUrl('/files/input/example.png', { baseUrl: 'http://127.0.0.1:18766' }),
    'http://127.0.0.1:18766/files/input/example.png',
  );
  assert.equal(
    mediaRefToAbsoluteUrl('/api/resources/file/res_123', { baseUrl: 'http://127.0.0.1:18766' }),
    'http://127.0.0.1:18766/api/resources/file/res_123',
  );
  assert.equal(
    mediaRefToAbsoluteUrl('https://cdn.example.com/a.png'),
    'https://cdn.example.com/a.png',
  );
});

test('resolveMediaRef returns data URLs unchanged for base64-oriented providers', async () => {
  const dataUrl = 'data:image/png;base64,QUJD';
  const resolved = await resolveMediaRef(dataUrl, { target: 'data-url' });

  assert.equal(resolved.kind, 'data-url');
  assert.equal(resolved.dataUrl, dataUrl);
  assert.equal(resolved.mime, 'image/png');
  assert.equal(resolved.base64, 'QUJD');
});

test('normalizeT8LocalMediaRef recognizes only controlled loopback media mounts', () => {
  assert.equal(
    normalizeT8LocalMediaRef('http://127.0.0.1:18766/files/output/example.png?cache=1'),
    '/files/output/example.png?cache=1',
  );
  assert.equal(
    normalizeT8LocalMediaRef('http://localhost:11422/api/resources/file/res_123'),
    '/api/resources/file/res_123',
  );
  assert.equal(
    normalizeT8LocalMediaRef('http://[::1]:18766/files/input/example.png'),
    '/files/input/example.png',
  );
  assert.equal(
    normalizeT8LocalMediaRef('http://127.0.0.1:9/files/output/example.png', { allowedPorts: [18766, 11422] }),
    'http://127.0.0.1:9/files/output/example.png',
  );
  assert.equal(
    normalizeT8LocalMediaRef('http://192.168.1.20/files/output/example.png'),
    'http://192.168.1.20/files/output/example.png',
  );
  assert.equal(
    normalizeT8LocalMediaRef('http://127.0.0.1:18766/api/files/thumbnail?url=%2Ffiles%2Foutput%2Fa.png'),
    'http://127.0.0.1:18766/api/files/thumbnail?url=%2Ffiles%2Foutput%2Fa.png',
  );
});

test('resolveMediaRef converts local file paths to data URLs and local paths when requested', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-media-resolver-'));
  const filePath = path.join(tmpDir, 'ref.png');
  fs.writeFileSync(filePath, Buffer.from('ABC'));

  try {
    const asData = await resolveMediaRef(filePath, { target: 'data-url' });
    assert.equal(asData.kind, 'data-url');
    assert.equal(asData.mime, 'image/png');
    assert.equal(asData.base64, 'QUJD');

    const asLocal = await resolveMediaRef(filePath, { target: 'local-path' });
    assert.equal(asLocal.kind, 'local-path');
    assert.equal(asLocal.path, filePath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveMediaRef maps resource library file URLs to local paths', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-resource-library-'));
  const imageDir = path.join(tmpDir, 'image');
  fs.mkdirSync(imageDir, { recursive: true });
  const filePath = path.join(imageDir, 'res_1.png');
  fs.writeFileSync(filePath, Buffer.from('ABC'));
  fs.writeFileSync(path.join(tmpDir, 'resource_library.json'), JSON.stringify({
    schema: 't8-resource-library',
    version: 1,
    categories: [],
    items: [{
      id: 'res_1',
      kind: 'image',
      fileRel: 'image/res_1.png',
      originalName: 'res_1.png',
      mime: 'image/png',
    }],
  }));

  try {
    const resolved = await resolveMediaRef('/api/resources/file/res_1', {
      target: 'local-path',
      resourceLibraryPath: tmpDir,
    });

    assert.equal(resolved.kind, 'local-path');
    assert.equal(resolved.path, filePath);
    assert.equal(resolved.mime, 'image/png');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveT8LocalMediaPath maps /files/input and /files/output to configured directories', () => {
  const config = require('../backend/src/config.js');
  const oldInput = config.INPUT_DIR;
  const oldOutput = config.OUTPUT_DIR;
  config.INPUT_DIR = 'C:\\t8\\input';
  config.OUTPUT_DIR = 'C:\\t8\\output';

  try {
    assert.equal(resolveT8LocalMediaPath('/files/input/a.png'), path.join('C:\\t8\\input', 'a.png'));
    assert.equal(resolveT8LocalMediaPath('/files/output/sub/b.mp4'), path.join('C:\\t8\\output', 'sub', 'b.mp4'));
    assert.equal(
      resolveT8LocalMediaPath('http://127.0.0.1:18766/files/output/sub/b.mp4?cache=1'),
      path.join('C:\\t8\\output', 'sub', 'b.mp4'),
    );
    assert.equal(resolveT8LocalMediaPath('/api/resources/file/res_123'), '');
  } finally {
    config.INPUT_DIR = oldInput;
    config.OUTPUT_DIR = oldOutput;
  }
});
