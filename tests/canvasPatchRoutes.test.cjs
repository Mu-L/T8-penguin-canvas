const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function scopedPatchAssertions(patch, canvasId, projectId, actorId, sessionId) {
  assert.deepEqual(Object.keys(patch).sort(), [
    'baseRevision', 'diagnosticsResolved', 'id', 'operations', 'requiresConfirmation', 'schema', 'summary',
  ]);
  for (const key of ['canvasId', 'projectId', 'actorId', 'sessionId']) assert.equal(Object.hasOwn(patch, key), false);
  for (const operation of patch.operations || []) {
    assert.equal(operation.canvasId, canvasId);
    assert.equal(operation.projectId, projectId);
    assert.equal(operation.actorId, actorId);
    assert.equal(operation.sessionId, sessionId);
  }
}

test('local canvas patch routes pin identity, persist authoritative documents, and preserve safe patch errors', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-patch-routes-'));
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const canvasFile = path.join(dataDir, 'canvas_canvas-a.json');
  const listFile = path.join(dataDir, 'canvas_list.json');
  const initial = {
    schema: 't8-canvas-document', schemaVersion: 2, projectId: 'project-local', canvasId: 'canvas-a',
    revision: 4, updatedAt: 40,
    nodes: [{ id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'hello' } }],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  };
  fs.writeFileSync(canvasFile, JSON.stringify(initial), 'utf8');
  fs.writeFileSync(listFile, JSON.stringify([{ id: 'canvas-a', name: 'Patch QA', nodeCount: 1, revision: 4, createdAt: 1, updatedAt: 40 }]), 'utf8');

  const calls = [];
  const appliedDocument = {
    ...clone(initial), revision: 5, updatedAt: 50,
    nodes: [{ ...clone(initial.nodes[0]), position: { x: 80, y: 80 } }],
  };
  const revertedDocument = {
    ...clone(initial), revision: 6, updatedAt: 60,
    nodes: [...clone(initial.nodes), { id: 'node-b', type: 'text', position: { x: 10, y: 10 }, data: {} }],
  };
  const mirrorFailureDocument = {
    ...clone(revertedDocument), revision: 7, updatedAt: 70,
    nodes: revertedDocument.nodes.map((node) => node.id === 'node-a' ? { ...clone(node), position: { x: 160, y: 160 } } : clone(node)),
  };
  let currentDocument = clone(initial);
  const database = {
    getCanvas(canvasId) {
      return canvasId === 'canvas-a' ? clone(currentDocument) : null;
    },
    ensureCanvas(canvasId) {
      return this.getCanvas(canvasId);
    },
    saveCanvasSnapshot() {
      throw Object.assign(new Error(
        'snapshot save conflict token=saveTokenStandalone123 access_token=saveAccessStandalone456',
      ), {
        code: 'revision_conflict',
        current: {
          revision: 6,
          nodes: [{ data: { refresh_token: 'saveCurrentDocumentSecret987' } }],
        },
      });
    },
    previewCanvasPatch(canvasId, patch, options) {
      calls.push({ method: 'preview', canvasId, patch: clone(patch), options: clone(options) });
      const unknown = Object.keys(patch).filter((key) => ![
        'schema', 'id', 'baseRevision', 'summary', 'operations', 'diagnosticsResolved', 'requiresConfirmation',
      ].includes(key));
      if (unknown.length) {
        throw Object.assign(new Error(`未知 CanvasPatch 字段: ${unknown.join(', ')}`), { code: 'canvas_patch_invalid' });
      }
      if (patch.id === 'conflict') {
        throw Object.assign(new Error('Patch 预览已过期'), { code: 'canvas_patch_revision_conflict', currentRevision: 9 });
      }
      if (patch.id === 'forbidden') {
        throw Object.assign(new Error('无权预览 Patch'), { code: 'canvas_patch_forbidden' });
      }
      if (patch.id === 'leaky') {
        throw Object.assign(new Error(`node C:\\Users\\alice\\private\\input.png /home/alice/private.txt C%3A%5CUsers%5Cencoded-user%5Cprivate.png %252Fhome%252Fencoded-user%252Fprivate.txt path=%2Froot%2Fprivate%2Fsecret.txt api_key%3DencodedCredentialValue123456 ${['sk-', 'test-secret-123456'].join('')} ${['ghp_', 'A'.repeat(36)].join('')} ${['eyJAAAAAA', 'BBBBBBBB', 'CCCCCCCC'].join('.')} apiKey=super-secret-value data:image/png;base64,\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=`), { code: 'canvas_patch_invalid' });
      }
      return {
        patchId: patch.id,
        baseRevision: patch.baseRevision,
        currentRevision: currentDocument.revision,
        previewDigest: 'digest-1',
        summary: patch.summary,
        diagnosticsResolved: patch.diagnosticsResolved,
        affectedNodeIds: ['node-a'],
        affectedEdgeIds: [],
        changes: [],
        warnings: [],
      };
    },
    applyCanvasPatch(canvasId, patch, options) {
      calls.push({ method: 'apply', canvasId, patch: clone(patch), options: clone(options) });
      currentDocument = clone(patch.id === 'mirror-fail' ? mirrorFailureDocument : appliedDocument);
      return {
        patchId: patch.id,
        status: 'applied',
        duplicate: false,
        baseRevision: patch.baseRevision,
        revision: currentDocument.revision,
        document: clone(currentDocument),
      };
    },
    listCanvasPatches(canvasId, options) {
      calls.push({ method: 'list', canvasId, options: clone(options) });
      return [{
        patchId: 'patch-1',
        summary: '修复坐标',
        diagnosticsResolved: ['layout.invalid-position'],
        baseRevision: 4,
        appliedRevision: 5,
        revertedRevision: null,
        actorId: 'local-owner',
        status: 'applied',
        operationCount: 1,
        createdAt: 50,
        revertedAt: null,
        canRevert: true,
      }];
    },
    revertCanvasPatch(canvasId, patchId, options) {
      calls.push({ method: 'revert', canvasId, patchId, options: clone(options) });
      if (patchId === 'missing') throw Object.assign(new Error('Patch 不存在'), { code: 'canvas_patch_not_found' });
      currentDocument = clone(revertedDocument);
      return {
        patchId,
        status: 'reverted',
        duplicate: false,
        revision: revertedDocument.revision,
        document: clone(revertedDocument),
      };
    },
    applyOperations() {
      throw Object.assign(new Error(
        'operation collision token=routeTokenStandalone123 access_token=routeAccessStandalone456 refresh_token=routeRefreshStandalone789 id_token=routeIdStandalone012',
      ), {
        code: 'operation_id_conflict',
        status: 409,
        current: {
          revision: 6,
          nodes: [{ data: { access_token: 'routeCurrentDocumentSecret987', localPath: 'C:\\Users\\alice\\private.json' } }],
        },
      });
    },
    restoreCanvasSnapshot() {
      throw Object.assign(new Error(
        'restore rejected token=restoreTokenStandalone123 access_token=restoreAccessStandalone456 refresh_token=restoreRefreshStandalone789 id_token=restoreIdStandalone012',
      ), {
        code: 'snapshot_restore_invalid',
        status: 400,
        current: {
          revision: 6,
          nodes: [{ data: { token: 'restoreCurrentDocumentSecret987' } }],
        },
      });
    },
  };

  class FakeRevisionConflictError extends Error {}
  const servicePath = require.resolve('../backend/src/services/projectDatabase.js');
  const routePath = require.resolve('../backend/src/routes/canvas.js');
  const previousServiceModule = require.cache[servicePath];
  const previousRouteModule = require.cache[routePath];
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: {
      RevisionConflictError: FakeRevisionConflictError,
      getProjectDatabase: () => database,
    },
  };
  delete require.cache[routePath];

  const config = require('../backend/src/config.js');
  const previousConfig = {
    DATA_DIR: config.DATA_DIR,
    CANVAS_FILE: config.CANVAS_FILE,
    SETTINGS_FILE: config.SETTINGS_FILE,
  };
  config.DATA_DIR = dataDir;
  config.CANVAS_FILE = listFile;
  config.SETTINGS_FILE = path.join(directory, 'settings.json');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/canvas', require(routePath));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/canvas/canvas-a/patches`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(config, previousConfig);
    delete require.cache[routePath];
    if (previousRouteModule) require.cache[routePath] = previousRouteModule;
    if (previousServiceModule) require.cache[servicePath] = previousServiceModule;
    else delete require.cache[servicePath];
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const maliciousPatch = {
    schema: 't8-canvas-patch-v1',
    id: 'patch-1', baseRevision: 4, summary: '修复坐标', diagnosticsResolved: ['layout.invalid-position'], requiresConfirmation: true,
    projectId: 'project-evil', canvasId: 'canvas-evil', actorId: 'actor-evil', sessionId: 'session-evil',
    operations: [{
      opId: 'patch-1:0', projectId: 'project-evil', canvasId: 'canvas-evil', actorId: 'actor-evil', sessionId: 'session-evil',
      clientSeq: 7, timestamp: 1, baseRevision: 4, type: 'node.move', payload: { nodeId: 'node-a', position: { x: 80, y: 80 } },
    }],
  };

  const previewResponse = await fetch(`${baseUrl}/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: maliciousPatch, actorId: 'body-actor', sessionId: 'body-session' }),
  });
  assert.equal(previewResponse.status, 200, await previewResponse.text());
  const previewCall = calls.find((entry) => entry.method === 'preview');
  assert.deepEqual(previewCall.options, {
    actorId: 'local-owner', sessionId: 'local-session', projectId: 'project-local',
    authority: { source: 'local-owner', role: 'owner', capabilities: ['manageProviders'] },
  });
  scopedPatchAssertions(previewCall.patch, 'canvas-a', 'project-local', 'local-owner', 'local-session');

  const unknownFieldResponse = await fetch(`${baseUrl}/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { ...maliciousPatch, unknownTopLevel: true } }),
  });
  assert.equal(unknownFieldResponse.status, 400);
  assert.equal((await unknownFieldResponse.json()).code, 'canvas_patch_invalid');

  const applyResponse = await fetch(baseUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: maliciousPatch, previewDigest: 'digest-1', confirmed: true, actorId: 'body-actor' }),
  });
  assert.equal(applyResponse.status, 200, await applyResponse.text());
  const applyCall = calls.find((entry) => entry.method === 'apply');
  assert.deepEqual(applyCall.options, {
    previewDigest: 'digest-1', confirmed: true,
    actorId: 'local-owner', sessionId: 'local-session', projectId: 'project-local',
    authority: { source: 'local-owner', role: 'owner', capabilities: ['manageProviders'] },
  });
  scopedPatchAssertions(applyCall.patch, 'canvas-a', 'project-local', 'local-owner', 'local-session');
  assert.deepEqual(JSON.parse(fs.readFileSync(canvasFile, 'utf8')), appliedDocument);
  assert.equal(fs.existsSync(`${canvasFile}.tmp`), false);
  let listItem = JSON.parse(fs.readFileSync(listFile, 'utf8'))[0];
  assert.deepEqual({ nodeCount: listItem.nodeCount, revision: listItem.revision, updatedAt: listItem.updatedAt }, { nodeCount: 1, revision: 5, updatedAt: 50 });

  const listResponse = await fetch(`${baseUrl}?limit=7`);
  assert.equal(listResponse.status, 200);
  assert.deepEqual((await listResponse.json()).data, [{
    patchId: 'patch-1',
    summary: '修复坐标',
    diagnosticsResolved: ['layout.invalid-position'],
    baseRevision: 4,
    appliedRevision: 5,
    revertedRevision: null,
    actorId: 'local-owner',
    status: 'applied',
    operationCount: 1,
    createdAt: 50,
    revertedAt: null,
    canRevert: true,
  }]);
  assert.deepEqual(calls.find((entry) => entry.method === 'list').options, { actorId: 'local-owner', limit: 7 });

  const revertResponse = await fetch(`${baseUrl}/patch-1/revert`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 5, actorId: 'body-actor', sessionId: 'body-session', projectId: 'project-evil' }),
  });
  assert.equal(revertResponse.status, 200, await revertResponse.text());
  assert.deepEqual(calls.find((entry) => entry.method === 'revert').options, {
    expectedRevision: 5, actorId: 'local-owner', sessionId: 'local-session', projectId: 'project-local',
    authority: { source: 'local-owner', role: 'owner', capabilities: ['manageProviders'] },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(canvasFile, 'utf8')), revertedDocument);
  listItem = JSON.parse(fs.readFileSync(listFile, 'utf8'))[0];
  assert.deepEqual({ nodeCount: listItem.nodeCount, revision: listItem.revision, updatedAt: listItem.updatedAt }, { nodeCount: 2, revision: 6, updatedAt: 60 });

  const conflictResponse = await fetch(`${baseUrl}/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { ...maliciousPatch, id: 'conflict' } }),
  });
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual(await conflictResponse.json(), {
    success: false, code: 'canvas_patch_revision_conflict', error: 'Patch 预览已过期', currentRevision: 9,
  });

  const forbiddenResponse = await fetch(`${baseUrl}/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { ...maliciousPatch, id: 'forbidden' } }),
  });
  assert.equal(forbiddenResponse.status, 403);
  assert.equal((await forbiddenResponse.json()).code, 'canvas_patch_forbidden');

  const leakyResponse = await fetch(`${baseUrl}/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { ...maliciousPatch, id: 'leaky' } }),
  });
  assert.equal(leakyResponse.status, 400);
  const leakyPayload = await leakyResponse.json();
  assert.equal(leakyPayload.code, 'canvas_patch_invalid');
  assert.doesNotMatch(JSON.stringify(leakyPayload), /Users|alice|encoded-user|%3A|%5C|%2Fhome|%2Froot|encodedCredentialValue123456|sk-test|ghp_|eyJAAAAAA|super-secret|QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=/i);
  assert.match(leakyPayload.error, /\[(?:local-path|redacted|binary)\]/);

  const operationConflictResponse = await fetch(baseUrl.replace(/\/patches$/, '/operations'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: 6, operations: [{ opId: 'collision' }] }),
  });
  const operationConflictPayload = await operationConflictResponse.json();
  assert.equal(operationConflictResponse.status, 409, JSON.stringify(operationConflictPayload));
  assert.equal(operationConflictPayload.code, 'operation_id_conflict');
  assert.equal(operationConflictPayload.currentRevision, 6);
  assert.equal(operationConflictPayload.data, undefined);
  assert.doesNotMatch(JSON.stringify(operationConflictPayload), /route(?:Token|Access|Refresh|Id)Standalone|routeCurrentDocumentSecret987|Users/i);

  const restoreErrorResponse = await fetch(baseUrl.replace(/\/patches$/, '/history/4/restore'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision: 6 }),
  });
  const restoreErrorPayload = await restoreErrorResponse.json();
  assert.equal(restoreErrorResponse.status, 400, JSON.stringify(restoreErrorPayload));
  assert.equal(restoreErrorPayload.code, 'snapshot_restore_invalid');
  assert.equal(restoreErrorPayload.currentRevision, 6);
  assert.equal(restoreErrorPayload.data, undefined);
  assert.doesNotMatch(JSON.stringify(restoreErrorPayload), /restore(?:Token|Access|Refresh|Id)Standalone|restoreCurrentDocumentSecret987/i);

  const snapshotSaveErrorResponse = await fetch(baseUrl.replace(/\/patches$/, ''), {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseRevision: 6,
      nodes: clone(revertedDocument.nodes),
      edges: clone(revertedDocument.edges),
      viewport: clone(revertedDocument.viewport),
    }),
  });
  const snapshotSaveErrorPayload = await snapshotSaveErrorResponse.json();
  assert.equal(snapshotSaveErrorResponse.status, 409, JSON.stringify(snapshotSaveErrorPayload));
  assert.equal(snapshotSaveErrorPayload.code, 'revision_conflict');
  assert.equal(snapshotSaveErrorPayload.currentRevision, 6);
  assert.equal(snapshotSaveErrorPayload.data, undefined);
  assert.doesNotMatch(JSON.stringify(snapshotSaveErrorPayload), /save(?:Token|Access)Standalone|saveCurrentDocumentSecret987/i);

  const missingResponse = await fetch(`${baseUrl}/missing/revert`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 6 }),
  });
  assert.equal(missingResponse.status, 404);
  assert.equal((await missingResponse.json()).code, 'canvas_patch_not_found');

  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (path.resolve(String(target)) === path.resolve(canvasFile)) throw new Error(`EACCES: ${canvasFile}`);
    return originalRenameSync(source, target);
  };
  let mirrorFailureResponse;
  try {
    mirrorFailureResponse = await fetch(baseUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { ...maliciousPatch, id: 'mirror-fail', baseRevision: 6 }, previewDigest: 'digest-mirror', confirmed: true }),
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  const mirrorPayload = await mirrorFailureResponse.json();
  assert.equal(mirrorFailureResponse.status, 200, JSON.stringify(mirrorPayload));
  assert.deepEqual(mirrorPayload.warnings, [{
    code: 'legacy_canvas_mirror_failed',
    message: 'Patch 已由 SQLite 成功提交，但兼容画布镜像暂未同步；后续读取会重试修复。',
  }]);
  assert.equal(JSON.stringify(mirrorPayload).includes(directory), false);
  assert.equal(calls.filter((entry) => entry.method === 'apply' && entry.patch.id === 'mirror-fail').length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(canvasFile, 'utf8')), revertedDocument, 'failed mirror must not masquerade as a rolled back SQLite transaction');

  const authoritativeRead = await fetch(baseUrl.replace(/\/patches$/, ''));
  assert.equal(authoritativeRead.status, 200);
  assert.deepEqual((await authoritativeRead.json()).data, mirrorFailureDocument);
  assert.deepEqual(JSON.parse(fs.readFileSync(canvasFile, 'utf8')), mirrorFailureDocument, 'authoritative GET repairs the stale compatibility mirror');
});

test('local patch HTTP routes complete a real SQLite lifecycle and keep SQLite authoritative on mirror failure', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-canvas-patch-routes-real-'));
  const dataDir = path.join(directory, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const canvasFile = path.join(dataDir, 'canvas_canvas-real.json');
  const listFile = path.join(dataDir, 'canvas_list.json');
  const settingsFile = path.join(directory, 'settings.json');
  const autoSaveRoot = path.join(directory, 'auto-save');
  const autoSaveFile = path.join(autoSaveRoot, 'T8-penguin-canvas', 'canvases', 'Real_Patch_QA-real.json');
  const initial = {
    projectId: 'project-local',
    nodes: [{ id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: { text: 'before' } }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  fs.writeFileSync(canvasFile, JSON.stringify(initial), 'utf8');
  fs.writeFileSync(listFile, JSON.stringify([{
    id: 'canvas-real', name: 'Real Patch QA', nodeCount: 1, revision: 1, createdAt: 1, updatedAt: 1,
  }]), 'utf8');
  fs.writeFileSync(settingsFile, JSON.stringify({ canvasAutoSavePath: autoSaveRoot }), 'utf8');

  const config = require('../backend/src/config.js');
  const previousConfig = {
    DATA_DIR: config.DATA_DIR,
    CANVAS_FILE: config.CANVAS_FILE,
    SETTINGS_FILE: config.SETTINGS_FILE,
    PROJECT_DB_FILE: config.PROJECT_DB_FILE,
    PROJECT_DB_BACKUP_FILE: config.PROJECT_DB_BACKUP_FILE,
  };
  Object.assign(config, {
    DATA_DIR: dataDir,
    CANVAS_FILE: listFile,
    SETTINGS_FILE: settingsFile,
    PROJECT_DB_FILE: path.join(dataDir, 'projects.sqlite3'),
    PROJECT_DB_BACKUP_FILE: path.join(dataDir, 'projects.sqlite3.backup'),
  });

  const servicePath = require.resolve('../backend/src/services/projectDatabase.js');
  const routePath = require.resolve('../backend/src/routes/canvas.js');
  delete require.cache[servicePath];
  delete require.cache[routePath];
  const { getProjectDatabase } = require(servicePath);
  const database = getProjectDatabase(config);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/canvas', require(routePath));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const canvasUrl = `http://127.0.0.1:${server.address().port}/api/canvas/canvas-real`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    Object.assign(config, previousConfig);
    delete require.cache[routePath];
    delete require.cache[servicePath];
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const patch = {
    schema: 't8-canvas-patch-v1',
    id: 'real-local-patch-1',
    baseRevision: 1,
    summary: '真实本机 Patch',
    diagnosticsResolved: ['content.empty-text'],
    requiresConfirmation: true,
    projectId: 'forged-project',
    canvasId: 'forged-canvas',
    actorId: 'forged-actor',
    sessionId: 'forged-session',
    operations: [{
      opId: 'forged-op', projectId: 'forged-project', canvasId: 'forged-canvas',
      actorId: 'forged-actor', sessionId: 'forged-session', clientSeq: 88, timestamp: 1,
      type: 'node.patch', payload: { nodeId: 'node-a', dataPatch: { text: 'after' } },
    }],
  };

  const strictResponse = await fetch(`${canvasUrl}/patches/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { ...patch, id: 'real-local-unknown', unknownTopLevel: true } }),
  });
  const strictPayload = await strictResponse.json();
  assert.equal(strictResponse.status, 400, JSON.stringify(strictPayload));
  assert.equal(strictPayload.code, 'canvas_patch_invalid');

  const normalAgentPatch = {
    ...patch,
    id: 'agent-plan-route-normal-prompt',
    operations: [{
      ...patch.operations[0],
      payload: { nodeId: 'node-a', dataPatch: { text: 'agent ordinary prompt', maxTokens: 256 } },
    }],
  };
  const normalAgentPreviewResponse = await fetch(`${canvasUrl}/patches/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: normalAgentPatch }),
  });
  assert.equal(normalAgentPreviewResponse.status, 200, await normalAgentPreviewResponse.text());

  const sensitiveAgentPatch = {
    ...patch,
    id: 'agent-plan-route-sensitive',
    summary: 'Agent 受限字段',
    operations: [{
      ...patch.operations[0],
      payload: { nodeId: 'node-a', dataPatch: { provider: { credentials: { 'a%70i%4Bey': 'route-agent-private-value' } } } },
    }],
  };
  const sensitiveAgentPreviewResponse = await fetch(`${canvasUrl}/patches/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: sensitiveAgentPatch }),
  });
  const sensitiveAgentPreviewPayload = await sensitiveAgentPreviewResponse.json();
  assert.equal(sensitiveAgentPreviewResponse.status, 403, JSON.stringify(sensitiveAgentPreviewPayload));
  assert.equal(sensitiveAgentPreviewPayload.code, 'canvas_patch_host_credentials_forbidden');
  assert.doesNotMatch(JSON.stringify(sensitiveAgentPreviewPayload), /a%70|api.?key|route-agent-private-value/i);
  const sensitiveAgentApplyResponse = await fetch(`${canvasUrl}/patches`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: sensitiveAgentPatch, previewDigest: 'a'.repeat(64), confirmed: true }),
  });
  const sensitiveAgentApplyPayload = await sensitiveAgentApplyResponse.json();
  assert.equal(sensitiveAgentApplyResponse.status, 403, JSON.stringify(sensitiveAgentApplyPayload));
  assert.equal(sensitiveAgentApplyPayload.code, 'canvas_patch_host_credentials_forbidden');
  assert.doesNotMatch(JSON.stringify(sensitiveAgentApplyPayload), /a%70|api.?key|route-agent-private-value/i);
  assert.equal(database.getCanvas('canvas-real').revision, 1);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications').get().count, 0);

  const previewResponse = await fetch(`${canvasUrl}/patches/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch }),
  });
  const previewPayload = await previewResponse.json();
  assert.equal(previewResponse.status, 200, JSON.stringify(previewPayload));
  assert.equal(previewPayload.data.currentRevision, 1);
  assert.match(previewPayload.data.previewDigest, /^[a-f0-9]{64}$/);

  const unconfirmedResponse = await fetch(`${canvasUrl}/patches`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch, previewDigest: previewPayload.data.previewDigest, confirmed: false }),
  });
  assert.equal(unconfirmedResponse.status, 400);
  assert.equal((await unconfirmedResponse.json()).code, 'canvas_patch_confirmation_required');

  const applyResponse = await fetch(`${canvasUrl}/patches`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch, previewDigest: previewPayload.data.previewDigest, confirmed: true }),
  });
  const applyPayload = await applyResponse.json();
  assert.equal(applyResponse.status, 200, JSON.stringify(applyPayload));
  assert.deepEqual({
    patchId: applyPayload.data.patchId,
    status: applyPayload.data.status,
    duplicate: applyPayload.data.duplicate,
    revision: applyPayload.data.revision,
  }, { patchId: patch.id, status: 'applied', duplicate: false, revision: 2 });
  assert.equal(applyPayload.data.document.nodes[0].data.text, 'after');
  assert.equal(JSON.parse(fs.readFileSync(canvasFile, 'utf8')).revision, 2);

  const operation = database.db.prepare(`
    SELECT op_id, project_id, canvas_id, actor_id, session_id, revision
    FROM canvas_operations WHERE canvas_id = ? AND revision = 2
  `).get('canvas-real');
  assert.deepEqual({
    projectId: operation.project_id,
    canvasId: operation.canvas_id,
    actorId: operation.actor_id,
    sessionId: operation.session_id,
    revision: operation.revision,
  }, {
    projectId: 'project-local', canvasId: 'canvas-real',
    actorId: 'local-owner', sessionId: 'local-session', revision: 2,
  });
  assert.notEqual(operation.op_id, 'forged-op');

  const listResponse = await fetch(`${canvasUrl}/patches?limit=10`);
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200, JSON.stringify(listPayload));
  assert.equal(listPayload.data.length, 1);
  assert.equal(listPayload.data[0].actorId, 'local-owner');
  assert.equal(listPayload.data[0].canRevert, true);
  assert.doesNotMatch(JSON.stringify(listPayload), /forged-session|forward_ops|inverse_ops|payload_json/);

  const staleRevertResponse = await fetch(`${canvasUrl}/patches/${encodeURIComponent(patch.id)}/revert`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: 1 }),
  });
  const staleRevertPayload = await staleRevertResponse.json();
  assert.equal(staleRevertResponse.status, 409, JSON.stringify(staleRevertPayload));
  assert.equal(staleRevertPayload.code, 'revision_conflict');
  assert.equal(staleRevertPayload.currentRevision, 2);

  const revertResponse = await fetch(`${canvasUrl}/patches/${encodeURIComponent(patch.id)}/revert`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseRevision: 2 }),
  });
  const revertPayload = await revertResponse.json();
  assert.equal(revertResponse.status, 200, JSON.stringify(revertPayload));
  assert.equal(revertPayload.data.status, 'reverted');
  assert.equal(revertPayload.data.revision, 3);
  assert.equal(revertPayload.data.document.nodes[0].data.text, 'before');

  const mirrorPatch = {
    ...patch,
    id: 'real-local-patch-mirror',
    baseRevision: 3,
    summary: '镜像失败仍以 SQLite 为准',
    operations: [{
      ...patch.operations[0],
      payload: { nodeId: 'node-a', dataPatch: { text: 'sqlite-authoritative' } },
    }],
  };
  const mirrorPreviewResponse = await fetch(`${canvasUrl}/patches/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patch: mirrorPatch }),
  });
  const mirrorPreviewPayload = await mirrorPreviewResponse.json();
  assert.equal(mirrorPreviewResponse.status, 200, JSON.stringify(mirrorPreviewPayload));

  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (path.resolve(String(target)) === path.resolve(canvasFile)) throw new Error(`EACCES: ${canvasFile}`);
    return originalRenameSync(source, target);
  };
  let mirrorApplyResponse;
  try {
    mirrorApplyResponse = await fetch(`${canvasUrl}/patches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        patch: mirrorPatch,
        previewDigest: mirrorPreviewPayload.data.previewDigest,
        confirmed: true,
      }),
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  const mirrorApplyPayload = await mirrorApplyResponse.json();
  assert.equal(mirrorApplyResponse.status, 200, JSON.stringify(mirrorApplyPayload));
  assert.equal(mirrorApplyPayload.data.revision, 4);
  assert.deepEqual(mirrorApplyPayload.warnings, [{
    code: 'legacy_canvas_mirror_failed',
    message: 'Patch 已由 SQLite 成功提交，但兼容画布镜像暂未同步；后续读取会重试修复。',
  }]);
  assert.equal(database.getCanvas('canvas-real').revision, 4);
  assert.equal(JSON.parse(fs.readFileSync(canvasFile, 'utf8')).revision, 3);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications WHERE patch_id = ?').get(mirrorPatch.id).count, 1);

  const repairedResponse = await fetch(canvasUrl);
  const repairedPayload = await repairedResponse.json();
  assert.equal(repairedResponse.status, 200, JSON.stringify(repairedPayload));
  assert.equal(repairedPayload.data.revision, 4);
  assert.equal(repairedPayload.data.nodes[0].data.text, 'sqlite-authoritative');
  assert.equal(JSON.parse(fs.readFileSync(canvasFile, 'utf8')).revision, 4);

  const laterDocument = database.applyOperations('canvas-real', [{
    opId: 'later-unrelated-operation',
    actorId: 'local-owner',
    sessionId: 'local-session',
    type: 'node.patch',
    payload: { nodeId: 'node-a', dataPatch: { unrelated: 'keep-current' } },
  }], { expectedRevision: 4 }).document;
  assert.equal(laterDocument.revision, 5);
  const duplicateResponse = await fetch(`${canvasUrl}/patches`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      patch: mirrorPatch,
      previewDigest: mirrorPreviewPayload.data.previewDigest,
      confirmed: true,
    }),
  });
  const duplicatePayload = await duplicateResponse.json();
  assert.equal(duplicateResponse.status, 200, JSON.stringify(duplicatePayload));
  assert.equal(duplicatePayload.data.duplicate, true);
  assert.equal(duplicatePayload.data.revision, 4, 'idempotent response retains the original application revision');
  const duplicateMirror = JSON.parse(fs.readFileSync(canvasFile, 'utf8'));
  assert.equal(duplicateMirror.revision, 5, 'compatibility mirror must use the current SQLite document, not an old idempotent snapshot');
  assert.equal(duplicateMirror.nodes[0].data.unrelated, 'keep-current');
  assert.equal(JSON.parse(fs.readFileSync(listFile, 'utf8'))[0].revision, 5);
  assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM canvas_patch_applications WHERE patch_id = ?').get(mirrorPatch.id).count, 1);

  const futureAutoSaveResponse = await fetch(`${canvasUrl}/auto-save`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 6, nodes: [{ id: 'future-forged' }], edges: [] }),
  });
  const futureAutoSavePayload = await futureAutoSaveResponse.json();
  assert.equal(futureAutoSaveResponse.status, 409, JSON.stringify(futureAutoSavePayload));
  assert.equal(futureAutoSavePayload.code, 'canvas_auto_save_revision_conflict');
  assert.equal(futureAutoSavePayload.currentRevision, 5);
  assert.equal(fs.existsSync(autoSaveFile), false);

  const currentAutoSaveResponse = await fetch(`${canvasUrl}/auto-save`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: 5,
      nodes: [{ id: 'request-body-must-not-win', data: { text: 'stale request body' } }],
      edges: [],
    }),
  });
  const currentAutoSavePayload = await currentAutoSaveResponse.json();
  assert.equal(currentAutoSaveResponse.status, 200, JSON.stringify(currentAutoSavePayload));
  assert.equal(currentAutoSavePayload.data.revision, 5);
  assert.equal(currentAutoSavePayload.data.idempotent, false);
  let autoSaveMirror = JSON.parse(fs.readFileSync(autoSaveFile, 'utf8'));
  assert.equal(autoSaveMirror.revision, 5);
  assert.equal(autoSaveMirror.nodes[0].id, 'node-a');
  assert.equal(autoSaveMirror.nodes[0].data.unrelated, 'keep-current');
  assert.doesNotMatch(JSON.stringify(autoSaveMirror), /request-body-must-not-win|stale request body/);
  const firstAutoSaveRaw = fs.readFileSync(autoSaveFile, 'utf8');

  const equalAutoSaveResponse = await fetch(`${canvasUrl}/auto-save`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 5, nodes: [{ id: 'another-forged-body' }], edges: [] }),
  });
  const equalAutoSavePayload = await equalAutoSaveResponse.json();
  assert.equal(equalAutoSaveResponse.status, 200, JSON.stringify(equalAutoSavePayload));
  assert.equal(equalAutoSavePayload.data.idempotent, true);
  assert.equal(fs.readFileSync(autoSaveFile, 'utf8'), firstAutoSaveRaw, 'equal revision must be idempotent');

  const newestDocument = database.applyOperations('canvas-real', [{
    opId: 'auto-save-current-operation',
    actorId: 'local-owner',
    sessionId: 'local-session',
    type: 'node.patch',
    payload: { nodeId: 'node-a', dataPatch: { autoSaveCurrent: 'revision-6' } },
  }], { expectedRevision: 5 }).document;
  assert.equal(newestDocument.revision, 6);
  const lateAutoSaveResponse = await fetch(`${canvasUrl}/auto-save`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 5, nodes: [{ id: 'late-revision-5' }], edges: [] }),
  });
  const lateAutoSavePayload = await lateAutoSaveResponse.json();
  assert.equal(lateAutoSaveResponse.status, 200, JSON.stringify(lateAutoSavePayload));
  assert.equal(lateAutoSavePayload.data.revision, 6);
  assert.equal(lateAutoSavePayload.data.staleIgnored, true);
  autoSaveMirror = JSON.parse(fs.readFileSync(autoSaveFile, 'utf8'));
  assert.equal(autoSaveMirror.revision, 6);
  assert.equal(autoSaveMirror.nodes[0].data.autoSaveCurrent, 'revision-6');
  assert.doesNotMatch(JSON.stringify(autoSaveMirror), /late-revision-5/);

  const revisionSixRaw = fs.readFileSync(autoSaveFile, 'utf8');
  const legacyAutoSaveResponse = await fetch(`${canvasUrl}/auto-save`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodes: [{ id: 'legacy-without-revision' }], edges: [] }),
  });
  const legacyAutoSavePayload = await legacyAutoSaveResponse.json();
  assert.equal(legacyAutoSaveResponse.status, 200, JSON.stringify(legacyAutoSavePayload));
  assert.equal(legacyAutoSavePayload.data.revision, 6);
  assert.equal(legacyAutoSavePayload.data.idempotent, true);
  assert.equal(fs.readFileSync(autoSaveFile, 'utf8'), revisionSixRaw, 'legacy requests bind to the current DB revision');

  const aheadMirror = { ...autoSaveMirror, revision: 7 };
  fs.writeFileSync(autoSaveFile, JSON.stringify(aheadMirror, null, 2), 'utf8');
  const mirrorAheadResponse = await fetch(`${canvasUrl}/auto-save`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 6, nodes: newestDocument.nodes, edges: newestDocument.edges }),
  });
  const mirrorAheadPayload = await mirrorAheadResponse.json();
  assert.equal(mirrorAheadResponse.status, 409, JSON.stringify(mirrorAheadPayload));
  assert.equal(mirrorAheadPayload.code, 'canvas_auto_save_mirror_ahead');
  assert.equal(mirrorAheadPayload.currentRevision, 6);
  assert.equal(JSON.parse(fs.readFileSync(autoSaveFile, 'utf8')).revision, 7, 'a lower authoritative revision must not overwrite a higher mirror');

  assert.equal(database.listAuditEvents({
    projectId: 'project-local', canvasId: 'canvas-real', action: 'canvas.patch.apply',
  }).length, 2);
  assert.equal(database.listAuditEvents({
    projectId: 'project-local', canvasId: 'canvas-real', action: 'canvas.patch.revert',
  }).length, 1);
});
