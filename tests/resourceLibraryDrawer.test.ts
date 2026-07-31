import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const drawer = readFileSync(new URL('../src/components/ResourceLibraryDrawer.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/services/api.ts', import.meta.url), 'utf8');

test('resource library category add and rename use an in-app dialog instead of native prompt', () => {
  assert.doesNotMatch(drawer, /window\.prompt/);
  assert.match(drawer, /categoryDialog/);
  assert.match(drawer, /data-resource-category-dialog="true"/);
  assert.match(drawer, /data-resource-category-dialog-input/);
  assert.match(drawer, /data-resource-category-dialog-confirm/);
  assert.match(drawer, /itemRenameDialog/);
  assert.match(drawer, /data-resource-item-rename-dialog="true"/);
  assert.match(drawer, /data-resource-item-rename-dialog-input/);
  assert.match(drawer, /data-resource-item-rename-dialog-confirm/);
});

test('resource library drawer uploads local files into the selected category', () => {
  assert.match(drawer, /data-resource-local-upload-button/);
  assert.match(drawer, /data-resource-local-upload-input/);
  assert.match(drawer, /localUploadSupported/);
  assert.match(drawer, /localUploadCategoryId/);
  assert.match(drawer, /categoryId !== 'all'/);
  assert.match(drawer, /accept=\{localUploadAccept\}/);
  assert.match(drawer, /multiple/);
  assert.match(drawer, /api\.uploadResourceLocalFile\(file\)/);
  assert.match(drawer, /api\.addResourceItem\(\{[\s\S]*categoryId:\s*localUploadCategoryId/);
  assert.match(drawer, /请先选择一个分类再上传本地资产/);
});

test('resource upload api helper stages local files through the existing file upload endpoint', () => {
  assert.match(api, /export interface UploadedResourceLocalFile/);
  assert.match(
    api,
    /export (?:async )?function uploadResourceLocalFile\(\s*file: File,\s*context: UploadResourceLocalFileContext = \{\},\s*options: UploadResourceLocalFileOptions = \{\},\s*\)/,
  );
  assert.match(api, /new FormData\(\)/);
  assert.match(api, /fd\.append\('file', file\)/);
  assert.match(api, /fetch\(`\$\{BASE\}\/files\/upload`/);
});
