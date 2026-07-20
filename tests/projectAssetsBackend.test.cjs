const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

test('project asset API keeps host paths private and separates index deletion from managed-file deletion', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-project-assets-api-'));
  const previousManagementToken = process.env.T8_COLLAB_MANAGEMENT_TOKEN;
  process.env.T8PC_PACKAGED = '1';
  process.env.T8PC_USER_DATA = directory;
  process.env.T8_COLLAB_MANAGEMENT_TOKEN = 'A'.repeat(43);
  fs.mkdirSync(path.join(directory, 'input'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'output'), { recursive: true });
  const linkedPath = path.join(directory, 'linked-source.txt');
  fs.writeFileSync(linkedPath, 'linked payload');
  const config = require('../backend/src/config');
  const router = require('../backend/src/routes/projectAssets');
  const filesRouter = require('../backend/src/routes/files');
  const { getProjectDatabase } = require('../backend/src/services/projectDatabase');
  const database = getProjectDatabase(config);
  database.ensureCanvas('canvas-upload-lineage', { nodes: [], edges: [] }, 'project-local');
  database.ensureCanvas('canvas-assets', { nodes: [], edges: [] }, 'project-local');
  const app = express();
  app.use(express.json());
  app.use('/api/project-assets', router);
  app.use('/api/files', filesRouter);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/project-assets`;
  const deleteBody = (asset, confirmFilename = asset.filename) => ({
    deleteFile: true,
    confirmFilename,
    expectedEntityUid: asset.entityUid,
    expectedContentRevision: asset.contentRevision,
    expectedContentHash: asset.contentHash,
  });
  try {
    assert.equal(router.previewPipeline, filesRouter.previewPipeline);
    assert.equal(router.indexer, filesRouter.assetIndexer);
    const initialStatus = await (await fetch(`${baseUrl}/status`)).json();
    assert.deepEqual(Object.keys(initialStatus.data).sort(), ['previews', 'projectId', 'scan']);
    assert.equal(initialStatus.data.projectId, 'project-local');
    assert.equal(initialStatus.data.scan.projectId, 'project-local');
    assert.equal(initialStatus.data.scan.running, false);
    assert.equal(initialStatus.data.scan.lastResult, null);
    assert.deepEqual(Object.keys(initialStatus.data.previews.counts).sort(), ['failed', 'queued', 'retrying', 'running', 'succeeded']);
    assert.equal(initialStatus.data.previews.projectId, 'project-local');
    assert.equal(typeof initialStatus.data.previews.active, 'number');
    assert.equal(typeof initialStatus.data.previews.concurrency, 'number');
    assert.equal(initialStatus.data.previews.concurrencyScope, 'global');
    const uploadForm = new FormData();
    uploadForm.append('canvasId', 'canvas-upload-lineage');
    uploadForm.append('sourceNodeId', 'upload-node-a');
    uploadForm.append('sourceNodeType', 'upload');
    uploadForm.append('creatorId', 'alice');
    uploadForm.append('file', new Blob(['uploaded payload'], { type: 'text/plain' }), 'uploaded.txt');
    const uploadResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/files/upload`, { method: 'POST', body: uploadForm });
    assert.equal(uploadResponse.status, 200);
    const upload = (await uploadResponse.json()).data;
    const uploadedAsset = database.getAsset(upload.assetId);
    const uploadLineage = database.getAssetLineage(upload.assetId);
    assert.equal(uploadedAsset.storageMode, 'managed');
    assert.equal(uploadedAsset.availability, 'available');
    assert.equal(uploadLineage[0].sourceType, 'upload-node');
    assert.equal(uploadLineage[0].sourceNodeId, 'upload-node-a');
    assert.equal(uploadLineage[0].sourceNodeType, 'upload');
    assert.equal(uploadLineage[0].canvasId, 'canvas-upload-lineage');
    assert.equal(uploadLineage[0].creatorId, 'alice');

    const beforeGhostLink = database.countAssets({ projectId: 'project-local' });
    const ghostLinkResponse = await fetch(`${baseUrl}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [linkedPath], canvasId: 'ghost-canvas' }),
    });
    assert.equal(ghostLinkResponse.status, 400);
    assert.equal((await ghostLinkResponse.json()).code, 'invalid_canvas_reference');
    assert.equal(database.countAssets({ projectId: 'project-local' }), beforeGhostLink);

    const linkedResponse = await fetch(`${baseUrl}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [linkedPath], canvasId: 'canvas-assets' }),
    });
    assert.equal(linkedResponse.status, 201);
    const linked = (await linkedResponse.json()).data[0];
    assert.equal(linked.storageMode, 'linked');
    assert.equal(Object.hasOwn(linked, 'managedPath'), false);
    assert.equal(JSON.stringify(linked).includes(linkedPath), false);
    assert.equal(JSON.stringify(linked).includes(linkedPath.replace(/\\/g, '/')), false);
    assert.equal(linked.metadata.relativePath, path.basename(linkedPath));
    const missingLinkedPath = path.join(directory, 'private-missing-source.obj');
    const missingLinkResponse = await fetch(`${baseUrl}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [missingLinkedPath] }),
    });
    const missingLinkPayload = await missingLinkResponse.json();
    assert.equal(missingLinkResponse.status, 400);
    assert.equal(JSON.stringify(missingLinkPayload).includes(missingLinkedPath), false);
    assert.equal(JSON.stringify(missingLinkPayload).includes(missingLinkedPath.replace(/\\/g, '/')), false);
    const listedLinked = (await (await fetch(`${baseUrl}/?projectId=project-local&query=linked-source`)).json()).data[0];
    assert.equal(JSON.stringify(listedLinked).includes(path.dirname(linkedPath).replace(/\\/g, '/')), false);
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}${linked.sourceUrl}`)).text(), 'linked payload');
    const ranged = await fetch(`http://127.0.0.1:${server.address().port}${linked.sourceUrl}`, { headers: { Range: 'bytes=0-5' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
    assert.equal(ranged.headers.get('content-range'), 'bytes 0-5/14');
    assert.equal(ranged.headers.get('content-length'), '6');
    assert.equal((await ranged.arrayBuffer()).byteLength, 6);
    const unsatisfiable = await fetch(`http://127.0.0.1:${server.address().port}${linked.sourceUrl}`, { headers: { Range: 'bytes=999-' } });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */14');

    const linkedDelete = await fetch(`${baseUrl}/${linked.id}/file`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deleteBody(linked)),
    });
    assert.equal(linkedDelete.status, 400);
    assert.equal(fs.existsSync(linkedPath), true);

    const removeIndex = await fetch(`${baseUrl}/${linked.id}/index`, { method: 'DELETE' });
    assert.equal(removeIndex.status, 200);
    assert.equal(fs.existsSync(linkedPath), true);
    assert.equal(database.getAsset(linked.id), null);

    const managedPath = path.join(config.INPUT_DIR, 'managed.txt');
    fs.writeFileSync(managedPath, 'managed payload');
    const scan = await fetch(`${baseUrl}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-local' }),
    });
    assert.equal(scan.status, 200);
    const scanPayload = await scan.json();
    assert.equal(scanPayload.data.projectId, 'project-local');
    assert.equal(Number.isSafeInteger(scanPayload.data.catalogRevision), true);
    const statusAfterScan = await (await fetch(`${baseUrl}/status?projectId=project-local`)).json();
    assert.equal(statusAfterScan.data.scan.projectId, 'project-local');
    assert.equal(statusAfterScan.data.scan.running, false);
    assert.equal(statusAfterScan.data.scan.lastResult.projectId, 'project-local');
    assert.equal(statusAfterScan.data.scan.lastResult.catalogRevision, scanPayload.data.catalogRevision);
    const managed = database.findAssetBySourceUrl('project-local', '/files/input/managed.txt');
    assert.equal(managed.storageMode, 'managed');
    const wrongConfirm = await fetch(`${baseUrl}/${managed.id}/file`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(deleteBody(managed, 'wrong.txt')),
    });
    assert.equal(wrongConfirm.status, 400);
    assert.equal(fs.existsSync(managedPath), true);
    const deleteManaged = await fetch(`${baseUrl}/${managed.id}/file`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(deleteBody(managed)),
    });
    assert.equal(deleteManaged.status, 200);
    assert.equal(fs.existsSync(managedPath), false);
    assert.equal(database.getAsset(managed.id), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    delete process.env.T8PC_PACKAGED;
    delete process.env.T8PC_USER_DATA;
    if (previousManagementToken == null) delete process.env.T8_COLLAB_MANAGEMENT_TOKEN;
    else process.env.T8_COLLAB_MANAGEMENT_TOKEN = previousManagementToken;
  }
});
