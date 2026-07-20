const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { CollaborationGateway } = require('../backend/src/collaboration/gateway');

test('F9 real collaboration gateway completes five ephemeral probes without creating durable records', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-f9-gateway-'));
  const database = new ProjectDatabase(':memory:');
  const config = {
    COLLAB_HOST: '127.0.0.1',
    COLLAB_PORT: 0,
    COLLAB_PUBLIC_BASE_URL: 'https://environment.example/collab',
    COLLAB_PUBLIC_EXPOSURE_FILE: path.join(directory, 'collaboration-public-exposure.json'),
    FRONTEND_DIST: '',
    INPUT_DIR: path.join(directory, 'input'),
    OUTPUT_DIR: path.join(directory, 'output'),
    THUMBNAILS_DIR: path.join(directory, 'thumbnails'),
    ASSET_BLOB_DIR: path.join(directory, 'blobs'),
    COLLAB_UPLOAD_TEMP_DIR: path.join(directory, 'uploads'),
  };
  const gateway = new CollaborationGateway(config, database);
  let restarted = null;
  let restartedDatabase = null;
  let corruptRestart = null;
  let corruptRestartDatabase = null;
  try {
    for (const child of ['input', 'output', 'thumbnails', 'blobs', 'uploads']) {
      fs.mkdirSync(path.join(directory, child), { recursive: true });
    }
    const status = await gateway.start({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${status.port}/collab`;
    const before = {
      invites: database.listInvites('project-local').length,
      members: database.listMembers('project-local').length,
      sessions: database.listCollaborationSessions('project-local').length,
      assets: database.listAssets({ projectId: 'project-local', limit: 100 }).length,
    };
    const result = await gateway.checkPublicBaseUrl(baseUrl, { timeoutMs: 3_000 });
    assert.equal(result.status, 'passed');
    assert.equal(result.allChecksPassed, true);
    assert.equal(result.checks.length, 5);
    assert.equal(result.checks.every((entry) => entry.status === 'passed'), true);
    assert.deepEqual({
      invites: database.listInvites('project-local').length,
      members: database.listMembers('project-local').length,
      sessions: database.listCollaborationSessions('project-local').length,
      assets: database.listAssets({ projectId: 'project-local', limit: 100 }).length,
    }, before);
    assert.equal(gateway.managementStatus().publicBaseUrl, baseUrl);
    assert.equal(gateway.managementStatus().publicExposureConfiguration?.source, 'persisted');
    assert.equal(gateway.managementStatus().publicExposureConfiguration?.durable, true);
    assert.equal(gateway.managementStatus().lastPublicSelfCheck?.allChecksPassed, true);
    assert.equal(gateway.publicSelfCheckChallenges.entries.size, 0);

    await gateway.stop();
    restartedDatabase = new ProjectDatabase(':memory:');
    restarted = new CollaborationGateway(config, restartedDatabase);
    assert.equal(restarted.managementStatus().publicBaseUrl, baseUrl, 'persisted URL survives backend restart');
    assert.equal(restarted.managementStatus().publicExposureConfiguration?.source, 'persisted');
    assert.equal(restarted.managementStatus().lastPublicSelfCheck, null, 'ephemeral evidence is not replayed after restart');

    const corruptedRecord = JSON.parse(fs.readFileSync(config.COLLAB_PUBLIC_EXPOSURE_FILE, 'utf8'));
    corruptedRecord.checksum = corruptedRecord.checksum === '0'.repeat(64)
      ? '1'.repeat(64)
      : '0'.repeat(64);
    fs.writeFileSync(config.COLLAB_PUBLIC_EXPOSURE_FILE, `${JSON.stringify(corruptedRecord)}\n`, 'utf8');
    corruptRestartDatabase = new ProjectDatabase(':memory:');
    corruptRestart = new CollaborationGateway(config, corruptRestartDatabase);
    const corruptStatus = corruptRestart.managementStatus();
    assert.equal(corruptStatus.publicBaseUrl, null, 'corrupt persisted URL is never applied after restart');
    assert.equal(corruptStatus.publicExposureConfiguration?.status, 'invalid');
    assert.equal(corruptStatus.publicExposureConfiguration?.source, 'persisted');
    assert.equal(corruptStatus.publicExposureConfiguration?.failClosed, true);
    assert.equal(
      corruptStatus.publicExposureConfiguration?.errorCode,
      'collaboration_public_exposure_store_invalid',
    );
    assert.equal(corruptStatus.lastPublicSelfCheck, null, 'corrupt sidecar cannot replay ephemeral evidence');

    const cleared = restarted.clearPublicBaseUrl();
    assert.equal(cleared.publicBaseUrl, config.COLLAB_PUBLIC_BASE_URL);
    assert.equal(cleared.publicExposureConfiguration?.source, 'environment');
    assert.equal(fs.existsSync(config.COLLAB_PUBLIC_EXPOSURE_FILE), false);
  } finally {
    if (corruptRestart) await corruptRestart.stop();
    corruptRestartDatabase?.close();
    if (restarted) await restarted.stop();
    restartedDatabase?.close();
    await gateway.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
