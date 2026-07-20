'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

function totalChanges(database) {
  return Number(database.db.prepare('SELECT total_changes() AS value').get().value);
}

function availabilityBody(snapshot) {
  return {
    projectId: snapshot.projectId,
    expectedCatalogRevision: snapshot.catalogRevision,
    entityUid: snapshot.entityUid,
    contentRevision: snapshot.contentRevision,
    organizationRevision: snapshot.organizationRevision,
    contentHash: snapshot.contentHash,
  };
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: options.headers,
    ...(Object.hasOwn(options, 'body')
      ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }
      : {}),
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null, text };
}

function requestRawJson(port, pathname, options = {}) {
  const serialized = Object.hasOwn(options, 'body')
    ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
    : '';
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/project-assets${pathname}`,
      method: options.method || 'GET',
      headers: {
        ...(options.headers || {}),
        ...(serialized ? { 'Content-Length': Buffer.byteLength(serialized) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ response, payload: text ? JSON.parse(text) : null, text });
      });
    });
    request.once('error', reject);
    if (serialized) request.write(serialized);
    request.end();
  });
}

test('B2 media GET/HEAD stay pure while availability repair is one explicit trusted CAS POST', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-availability-http-'));
  const previousPackaged = process.env.T8PC_PACKAGED;
  const previousUserData = process.env.T8PC_USER_DATA;
  const previousManagementToken = process.env.T8_COLLAB_MANAGEMENT_TOKEN;
  const previousDevPort = process.env.T8_DEV_FRONTEND_PORT;
  process.env.T8PC_PACKAGED = '1';
  process.env.T8PC_USER_DATA = directory;
  process.env.T8_COLLAB_MANAGEMENT_TOKEN = 'A'.repeat(43);
  process.env.T8_DEV_FRONTEND_PORT = '11422';

  const config = require('../backend/src/config');
  const originalConfigPackaged = config.IS_PACKAGED;
  const router = require('../backend/src/routes/projectAssets');
  const { getProjectDatabase } = require('../backend/src/services/projectDatabase');
  const database = getProjectDatabase(config);
  const linkedPath = path.join(directory, 'private-linked-source.txt');
  const originalBytes = 'linked payload frozen at index time';
  fs.writeFileSync(linkedPath, originalBytes);

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/project-assets', router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/project-assets`;
  const requestOrigin = new URL(baseUrl).origin;

  const originalSync = database.syncAssetAvailabilityObservations;
  let syncCalls = 0;
  database.syncAssetAvailabilityObservations = function instrumentedSync(...args) {
    syncCalls += 1;
    return originalSync.apply(this, args);
  };

  try {
    const projectId = 'project/availability-http';
    const asset = await router.indexer.indexLinkedFile(linkedPath, { projectId });
    const initial = database.getAssetAvailabilitySnapshot(asset.id);
    const initialBody = availabilityBody(initial);
    const endpoint = `/${encodeURIComponent(asset.id)}/availability/refresh`;

    const mutableMediaUrl = `${baseUrl}/${encodeURIComponent(asset.id)}/media`;
    const mediaChangesBeforeMutation = totalChanges(database);
    database.db.pragma('query_only = ON');
    try {
      const verifiedGet = await fetch(mutableMediaUrl);
      assert.equal(verifiedGet.status, 200);
      assert.equal(await verifiedGet.text(), originalBytes);

      const frozenStat = fs.statSync(linkedPath);
      fs.writeFileSync(linkedPath, 'x'.repeat(Buffer.byteLength(originalBytes)));
      fs.utimesSync(linkedPath, frozenStat.atime, frozenStat.mtime);

      const replacedGet = await fetch(mutableMediaUrl);
      assert.equal(replacedGet.status, 404, 'unobserved replacement bytes must not be served under an old content hash');
      assert.equal(replacedGet.headers.get('cache-control'), 'no-store');
      assert.equal((await replacedGet.arrayBuffer()).byteLength, 0);

      const replacedHead = await fetch(mutableMediaUrl, { method: 'HEAD' });
      assert.equal(replacedHead.status, 404, 'HEAD must use the same frozen-hash verification gate');
      assert.equal(replacedHead.headers.get('cache-control'), 'no-store');
      assert.equal((await replacedHead.arrayBuffer()).byteLength, 0);
      assert.equal(totalChanges(database), mediaChangesBeforeMutation);
    } finally {
      database.db.pragma('query_only = OFF');
      fs.writeFileSync(linkedPath, originalBytes);
    }
    assert.deepEqual(database.getAssetAvailabilitySnapshot(asset.id), initial);

    const uuidV7EntityUid = '0190f23a-6c9d-7a31-8b4c-2d5e6f708192';
    const uuidV7Path = path.join(directory, 'uuid-v7-linked-source.txt');
    const uuidV7Bytes = Buffer.from('uuid-v7 availability payload');
    fs.writeFileSync(uuidV7Path, uuidV7Bytes);
    const uuidV7Asset = database.upsertAsset({
      id: 'asset-availability-uuid-v7',
      projectId: 'project/availability-uuid-v7',
      entityUid: uuidV7EntityUid,
      contentHash: crypto.createHash('sha256').update(uuidV7Bytes).digest('hex'),
      sourceLocator: 'availability-uuid-v7-linked-source',
      kind: 'text',
      mimeType: 'text/plain',
      filename: path.basename(uuidV7Path),
      managedPath: uuidV7Path,
      sourceUrl: '/api/project-assets/asset-availability-uuid-v7/media',
      storageMode: 'linked',
      availability: 'available',
      metadata: { health: 'ok' },
    });
    const uuidV7Snapshot = database.getAssetAvailabilitySnapshot(uuidV7Asset.id);
    assert.equal(uuidV7Snapshot.entityUid, uuidV7EntityUid);
    assert.equal(uuidV7Snapshot.entityUid[14], '7');
    fs.unlinkSync(uuidV7Path);
    const uuidV7Refresh = await requestJson(baseUrl, `/${uuidV7Asset.id}/availability/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: requestOrigin,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: availabilityBody(uuidV7Snapshot),
    });
    assert.equal(uuidV7Refresh.response.status, 200, 'canonical UUID validation must accept UUIDv7');
    assert.equal(uuidV7Refresh.payload.data.state, 'missing');
    assert.equal(uuidV7Refresh.payload.data.changed, true);
    assert.equal(uuidV7Refresh.payload.data.availability, 'missing');
    assert.equal(syncCalls, 1);
    syncCalls = 0;

    const hostileHost = await requestRawJson(server.address().port, endpoint, {
      method: 'POST',
      headers: { Host: 'evil.example', 'Content-Type': 'application/json' },
      body: initialBody,
    });
    assert.equal(hostileHost.response.statusCode, 403);
    assert.equal(hostileHost.payload.code, 'trusted_loopback_required');

    const hostileOrigin = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: initialBody,
    });
    assert.equal(hostileOrigin.response.status, 403);
    assert.equal(hostileOrigin.payload.code, 'trusted_loopback_required');

    const hostileLoopbackOrigin = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:59999',
        'Sec-Fetch-Site': 'same-site',
      },
      body: initialBody,
    });
    assert.equal(hostileLoopbackOrigin.response.status, 403);
    assert.equal(hostileLoopbackOrigin.payload.code, 'trusted_loopback_required');

    const crossSite = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: requestOrigin,
        'Sec-Fetch-Site': 'cross-site',
      },
      body: initialBody,
    });
    assert.equal(crossSite.response.status, 403);
    assert.equal(crossSite.payload.code, 'trusted_loopback_required');

    const packagedDevOrigin = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:11422',
        'Sec-Fetch-Site': 'same-site',
      },
      body: initialBody,
    });
    assert.equal(packagedDevOrigin.response.status, 403);
    assert.equal(packagedDevOrigin.payload.code, 'trusted_loopback_required');
    assert.equal(syncCalls, 0, 'rejected Host/Origin/Fetch-Site requests must not reach the writer');

    config.IS_PACKAGED = false;
    const configuredDevOrigin = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:11422',
        'Sec-Fetch-Site': 'same-site',
      },
      body: initialBody,
    });
    config.IS_PACKAGED = originalConfigPackaged;
    assert.equal(configuredDevOrigin.response.status, 200);
    assert.equal(configuredDevOrigin.payload.data.state, 'available');
    assert.equal(configuredDevOrigin.payload.data.changed, false);
    assert.equal(syncCalls, 1, 'configured Vite origin is accepted only in development mode');
    assert.deepEqual(database.getAssetAvailabilitySnapshot(asset.id), initial);

    fs.unlinkSync(linkedPath);
    const beforeMedia = database.getAssetAvailabilitySnapshot(asset.id);
    const changesBeforeMedia = totalChanges(database);
    database.db.pragma('query_only = ON');
    let afterMedia;
    try {
      const mediaUrl = `${baseUrl}/${encodeURIComponent(asset.id)}/media`;
      const missingGet = await fetch(mediaUrl);
      assert.equal(missingGet.status, 404);
      assert.equal(missingGet.headers.get('cache-control'), 'no-store');
      assert.equal((await missingGet.arrayBuffer()).byteLength, 0);

      const missingHead = await fetch(mediaUrl, { method: 'HEAD' });
      assert.equal(missingHead.status, 404);
      assert.equal(missingHead.headers.get('cache-control'), 'no-store');
      assert.equal((await missingHead.arrayBuffer()).byteLength, 0);
      afterMedia = database.getAssetAvailabilitySnapshot(asset.id);
      assert.equal(totalChanges(database), changesBeforeMedia);
    } finally {
      database.db.pragma('query_only = OFF');
    }
    assert.deepEqual(afterMedia, beforeMedia, 'media reads must not repair availability or bump revisions');

    const missing = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: requestOrigin,
        'Sec-Fetch-Site': 'same-origin',
      },
      body: initialBody,
    });
    assert.equal(missing.response.status, 200);
    assert.deepEqual(
      {
        state: missing.payload.data.state,
        reason: missing.payload.data.reason,
        changed: missing.payload.data.changed,
        availability: missing.payload.data.availability,
      },
      { state: 'missing', reason: 'source-missing', changed: true, availability: 'missing' },
    );
    assert.equal(missing.payload.data.organizationRevision, initial.organizationRevision + 1);
    assert.equal(missing.payload.data.catalogRevision, initial.catalogRevision + 1);
    assert.equal(syncCalls, 2);

    const afterMissing = database.getAssetAvailabilitySnapshot(asset.id);
    assert.equal(afterMissing.availability, 'missing');
    assert.equal(afterMissing.metadata.health, 'missing');
    assert.equal(afterMissing.organizationRevision, initial.organizationRevision + 1);
    assert.equal(afterMissing.catalogRevision, initial.catalogRevision + 1);

    const staleReplay = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: initialBody,
    });
    assert.equal(staleReplay.response.status, 409);
    assert.match(staleReplay.payload.code, /^asset_(?:catalog_revision|availability_identity)_conflict$/);
    assert.equal(syncCalls, 2, 'the HTTP boundary must not replay a stale availability observation');
    assert.doesNotMatch(JSON.stringify(staleReplay.payload), /private-linked-source|linked payload|[a-f0-9]{64}/i);

    const missingNoop = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: availabilityBody(afterMissing),
    });
    assert.equal(missingNoop.response.status, 200);
    assert.equal(missingNoop.payload.data.state, 'missing');
    assert.equal(missingNoop.payload.data.changed, false);
    assert.equal(missingNoop.payload.data.organizationRevision, afterMissing.organizationRevision);
    assert.equal(missingNoop.payload.data.catalogRevision, afterMissing.catalogRevision);
    assert.equal(syncCalls, 3);
    assert.deepEqual(database.getAssetAvailabilitySnapshot(asset.id), afterMissing);

    fs.writeFileSync(linkedPath, 'different bytes at the same linked path');
    const sourceChanged = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: availabilityBody(afterMissing),
    });
    assert.equal(sourceChanged.response.status, 200);
    assert.deepEqual(
      {
        state: sourceChanged.payload.data.state,
        reason: sourceChanged.payload.data.reason,
        changed: sourceChanged.payload.data.changed,
        availability: sourceChanged.payload.data.availability,
      },
      {
        state: 'source-changed',
        reason: 'source-content-changed',
        changed: true,
        availability: 'missing',
      },
    );
    assert.equal(syncCalls, 4);
    const afterSourceChanged = database.getAssetAvailabilitySnapshot(asset.id);
    assert.equal(afterSourceChanged.availability, 'missing');
    assert.equal(afterSourceChanged.metadata.health, 'source-changed');
    assert.equal(afterSourceChanged.metadata.availabilityNeedsReindex, true);

    const sourceChangedMediaChanges = totalChanges(database);
    database.db.pragma('query_only = ON');
    try {
      const mediaUrl = `${baseUrl}/${encodeURIComponent(asset.id)}/media`;
      const changedGet = await fetch(mediaUrl);
      assert.equal(changedGet.status, 404, 'changed bytes must not be served under the frozen asset identity');
      assert.equal(changedGet.headers.get('cache-control'), 'no-store');
      assert.equal((await changedGet.arrayBuffer()).byteLength, 0);

      const changedHead = await fetch(mediaUrl, { method: 'HEAD' });
      assert.equal(changedHead.status, 404, 'HEAD must fail closed for a source-changed asset too');
      assert.equal(changedHead.headers.get('cache-control'), 'no-store');
      assert.equal((await changedHead.arrayBuffer()).byteLength, 0);
      assert.equal(totalChanges(database), sourceChangedMediaChanges);
    } finally {
      database.db.pragma('query_only = OFF');
    }
    assert.deepEqual(
      database.getAssetAvailabilitySnapshot(asset.id),
      afterSourceChanged,
      'failed-closed media reads must not repair or rewrite source-changed state',
    );

    fs.writeFileSync(linkedPath, originalBytes);
    const restored = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: availabilityBody(afterSourceChanged),
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.payload.data.state, 'available');
    assert.equal(restored.payload.data.reason, 'source-content-verified');
    assert.equal(restored.payload.data.changed, true);
    assert.equal(restored.payload.data.availability, 'available');
    assert.equal(syncCalls, 5);
    const afterRestore = database.getAssetAvailabilitySnapshot(asset.id);
    assert.equal(afterRestore.availability, 'available');
    assert.equal(afterRestore.metadata.health, 'ok');
    assert.equal(Object.hasOwn(afterRestore.metadata, 'availabilityNeedsReindex'), false);
    assert.equal(Object.hasOwn(afterRestore.metadata, 'observedContentHash'), false);

    const callsBeforeInvalidRequests = syncCalls;
    const extraField = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { ...availabilityBody(afterRestore), managedPath: linkedPath },
    });
    assert.equal(extraField.response.status, 400);
    assert.equal(extraField.payload.code, 'asset_availability_refresh_body_invalid');
    assert.doesNotMatch(JSON.stringify(extraField.payload), /private-linked-source/);

    const form = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'projectId=project%2Favailability-http',
    });
    assert.equal(form.response.status, 415);
    assert.equal(form.payload.code, 'asset_availability_refresh_json_required');

    for (const method of ['GET', 'PUT', 'DELETE']) {
      const wrongMethod = await requestJson(baseUrl, endpoint, { method });
      assert.equal(wrongMethod.response.status, 405);
      assert.equal(wrongMethod.response.headers.get('allow'), 'POST');
      assert.equal(wrongMethod.payload.code, 'method_not_allowed');
    }
    assert.equal(syncCalls, callsBeforeInvalidRequests);

    fs.unlinkSync(linkedPath);
    const beforeFull = database.getAssetAvailabilitySnapshot(asset.id);
    database.syncAssetAvailabilityObservations = function failWithFull() {
      syncCalls += 1;
      throw Object.assign(
        new Error(`${linkedPath} C:\\private\\availability.sqlite3 token=never-expose`),
        { code: 'SQLITE_FULL' },
      );
    };
    const full = await requestJson(baseUrl, endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: availabilityBody(beforeFull),
    });
    assert.equal(full.response.status, 507);
    assert.equal(full.payload.code, 'project_database_storage_capacity_exceeded');
    assert.equal(syncCalls, callsBeforeInvalidRequests + 1, 'capacity failure must not replay the POST');
    assert.doesNotMatch(JSON.stringify(full.payload), /private|availability\.sqlite3|token|linked-source/i);
    assert.deepEqual(database.getAssetAvailabilitySnapshot(asset.id), beforeFull);
  } finally {
    config.IS_PACKAGED = originalConfigPackaged;
    database.syncAssetAvailabilityObservations = originalSync;
    await new Promise((resolve) => server.close(resolve));
    router.previewPipeline.close();
    if (database?.db?.open) await database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    if (previousPackaged == null) delete process.env.T8PC_PACKAGED;
    else process.env.T8PC_PACKAGED = previousPackaged;
    if (previousUserData == null) delete process.env.T8PC_USER_DATA;
    else process.env.T8PC_USER_DATA = previousUserData;
    if (previousManagementToken == null) delete process.env.T8_COLLAB_MANAGEMENT_TOKEN;
    else process.env.T8_COLLAB_MANAGEMENT_TOKEN = previousManagementToken;
    if (previousDevPort == null) delete process.env.T8_DEV_FRONTEND_PORT;
    else process.env.T8_DEV_FRONTEND_PORT = previousDevPort;
  }
});
