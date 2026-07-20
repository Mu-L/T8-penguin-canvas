import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUploadDataFromItems } from '../src/utils/mediaCollection.ts';

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

function functionBody(source: string, name: string) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('upload image nodes expose stable image fields for downstream reference generation', () => {
  const uploadData = createUploadDataFromItems('image', [
    { kind: 'image', url: '/files/input/ref-a.png', name: 'ref-a.png', size: 1024, mime: 'image/png' },
  ]);
  const upstream = read('../src/components/nodes/useUpstreamMaterials.ts');
  const imageNode = read('../src/components/nodes/ImageNode.tsx');

  assert.equal(uploadData.imageUrl, '/files/input/ref-a.png');
  assert.deepEqual(uploadData.imageUrls, ['/files/input/ref-a.png']);
  assert.match(upstream, /pushMediaMaterial\(buckets, seen, sourceId, 'image', data\.imageUrl/);
  assert.match(upstream, /\['imageUrls', 'urls', 'generatedImages', 'directImageUrls', 'resultUrls'\]/);
  assert.match(imageNode, /const allRefs = upstreamImages\.slice\(0,\s*maxRefs\)/);
  assert.match(imageNode, /images:\s*allRefs/);
});

test('upload image nodes preserve resource-library image references for downstream generation', () => {
  const uploadData = createUploadDataFromItems('image', [
    { kind: 'image', url: '/api/resources/file/resource_1', name: '资源库图片', size: 4096, mime: 'image/png' },
  ]);
  assert.equal(uploadData.imageUrl, '/api/resources/file/resource_1');
  assert.deepEqual(uploadData.imageUrls, ['/api/resources/file/resource_1']);
  assert.equal(uploadData.mime, 'image/png');
});

test('image proxy refuses to silently submit without converted references', () => {
  const proxy = read('../backend/src/routes/proxy.js');

  assert.match(proxy, /collectConvertedImageRefs/);
  assert.match(proxy, /appendConvertedImagesToForm/);
  assert.match(proxy, /readLocalImageRefBuffer/);
  assert.match(proxy, /if\s*\(local\)\s*return local/);
  assert.match(proxy, /参考图读取失败/);
  assert.match(proxy, /requested:\s*refs\.length/);
  assert.match(proxy, /converted:\s*convertedRefs\.length/);
  assert.match(proxy, /if\s*\(refs\.length\s*>\s*0\s*&&\s*convertedRefs\.length\s*===\s*0\)/);
});

test('image proxy resolves resource-library image references before upstream submit', () => {
  const proxy = read('../backend/src/routes/proxy.js');
  const resources = read('../backend/src/routes/resources.js');

  assert.match(resources, /\/api\/resources\/file\/\$\{encodeURIComponent\(item\.id\)\}/);
  assert.match(resources, /\/api\/resources\/set-file\/\$\{encodeURIComponent\(parentId\)\}\/\$\{index\}/);
  assert.match(proxy, /resolveResourceImageRef/);
  assert.ok(proxy.includes('^\\/api\\/resources\\/file\\/([^/?#]+)'));
  assert.ok(proxy.includes('^\\/api\\/resources\\/set-file\\/([^/?#]+)\\/(\\d+)'));
  assert.match(proxy, /readResourceImageRefBuffer/);
});

test('legacy base64 image converters accept resource-library references', () => {
  const proxy = read('../backend/src/routes/proxy.js');
  const banana = functionBody(proxy, 'refToBananaImage');
  const grok = functionBody(proxy, 'refToGrokImage');

  assert.match(banana, /ref\.startsWith\('\/api\/resources\/file\/'\)/);
  assert.match(banana, /ref\.startsWith\('\/api\/resources\/set-file\/'\)/);
  assert.match(grok, /ref\.startsWith\('\/api\/resources\/file\/'\)/);
  assert.match(grok, /ref\.startsWith\('\/api\/resources\/set-file\/'\)/);
});
