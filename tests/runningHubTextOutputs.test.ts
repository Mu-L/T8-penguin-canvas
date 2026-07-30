import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const proxyRouter = require('../backend/src/routes/proxy.js');
const {
  decodeRunningHubTextOutput,
  isRunningHubTextOutputItem,
  normalizedRunningHubOutputType,
  runningHubTextOutputExtension,
} = proxyRouter._test;

test('RunningHub AI app txt outputs are terminal text artifacts, not media files', () => {
  const actualShape = {
    fileUrl: 'https://example.invalid/output/result.txt?signature=opaque',
    fileType: 'txt',
    taskCostTime: '26',
    nodeId: '23',
  };

  assert.equal(normalizedRunningHubOutputType(actualShape), 'txt');
  assert.equal(isRunningHubTextOutputItem(actualShape), true);
  assert.equal(runningHubTextOutputExtension(actualShape), 'txt');
  assert.equal(isRunningHubTextOutputItem({
    fileUrl: 'https://example.invalid/output/result.flac',
    fileType: 'flac',
  }), false);
});

test('RunningHub text outputs support declared MIME types and signed URL extensions', () => {
  assert.equal(isRunningHubTextOutputItem({
    fileUrl: 'https://example.invalid/output/no-extension',
    fileType: 'text/plain; charset=utf-8',
  }), true);
  assert.equal(isRunningHubTextOutputItem({
    fileUrl: 'https://example.invalid/output/result.json?signature=opaque',
  }), true);
  assert.equal(runningHubTextOutputExtension({
    fileUrl: 'https://example.invalid/output/result.md?signature=opaque',
  }), 'md');
});

test('RunningHub text output decoder accepts UTF-8 and UTF-16 while rejecting HTML and binary payloads', () => {
  assert.equal(
    decodeRunningHubTextOutput(Buffer.from('\uFEFF第一行\r\n第二行', 'utf8'), 'text/plain'),
    '第一行\n第二行',
  );

  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('RunningHub 文本结果', 'utf16le'),
  ]);
  assert.equal(decodeRunningHubTextOutput(utf16, 'application/octet-stream'), 'RunningHub 文本结果');

  assert.throws(
    () => decodeRunningHubTextOutput(Buffer.from('<!doctype html><html></html>'), 'text/html'),
    /HTML/,
  );
  assert.throws(
    () => decodeRunningHubTextOutput(Buffer.from([0x41, 0, 0x42]), 'application/octet-stream'),
    /二进制/,
  );
});

test('all RunningHub frontend consumers persist returned text for downstream canvas nodes', () => {
  const generation = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8');
  const runningHubNode = readFileSync(new URL('../src/components/nodes/RunningHubNode.tsx', import.meta.url), 'utf8');
  const rhToolsNode = readFileSync(new URL('../src/components/nodes/RHToolsNode.tsx', import.meta.url), 'utf8');
  const rhToolboxService = readFileSync(new URL('../src/services/rhToolbox.ts', import.meta.url), 'utf8');

  assert.match(generation, /texts\?: string\[\]/);
  assert.match(generation, /textUrls\?: string\[\]/);
  for (const source of [runningHubNode, rhToolsNode]) {
    assert.match(source, /patch\.outputText = textValue/);
    assert.match(source, /patch\.textSegments = textOutputs/);
  }
  assert.match(rhToolboxService, /\.\.\.\(Array\.isArray\(query\.texts\) \? query\.texts : \[\]\)/);
});
