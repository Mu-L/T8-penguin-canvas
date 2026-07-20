'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const videoOpsRouter = require('../backend/src/routes/videoOps');

function listenVideoOps() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/video-ops', videoOpsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function legacyAsyncBody() {
  return {
    async: true,
    clips: [{ id: 'capacity-clip', url: '/files/input/capacity.mp4', trimStart: 0, trimEnd: 1 }],
    settings: { aspect: '16:9', resolution: '720p', transition: 'none', audio: 'mute' },
  };
}

async function postCompose(baseUrl) {
  const response = await fetch(`${baseUrl}/api/video-ops/compose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(legacyAsyncBody()),
  });
  return { response, body: await response.json() };
}

test('video durable writers use the unified synchronous ProjectDatabase boundary without raw route transactions', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'backend', 'src', 'routes', 'videoOps.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /database\.db\.transaction\s*\(/);
  assert.match(source, /database\.withProjectDatabaseWrite\(operation, callback\)/);

  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const originalWrite = database.withProjectDatabaseWrite.bind(database);
  const operations = [];
  database.withProjectDatabaseWrite = (operation, callback) => {
    operations.push(operation);
    return originalWrite(operation, callback);
  };
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.clearJobsForTests();
  try {
    const synthetic = videoOpsRouter._test.createSyntheticVideoOperationExecution(legacyAsyncBody());
    const job = videoOpsRouter._test.makeJob('compose', synthetic.evidence, {
      requireExecutionEvidence: true,
      syntheticExecution: true,
    });
    job.status = 'failed';
    job.message = 'injected fallback status';
    job.error = job.message;
    videoOpsRouter._test.finalizeSyntheticVideoOperationExecution(job, new Error('injected evidence failure'));

    assert.deepEqual(operations, [
      'video.execution.synthetic-create',
      'run.create',
      'run.node-create',
      'run.attempt-create',
      'video.execution.event-persist',
      'run.event-create',
      'run.attempt-update',
      'video.execution.synthetic-finalize',
      'run.attempt-update',
      'run.node-update',
      'run.update',
      'video.execution.synthetic-fallback-event',
      'run.event-create',
    ]);
    assert.equal(database.getRun(synthetic.evidence.runId).status, 'failed');
    assert.equal(database.getNodeRun(synthetic.evidence.nodeRunId).status, 'failed');
    assert.equal(database.getAttempt(synthetic.evidence.attemptId).status, 'failed');
  } finally {
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('raw SQLITE_FULL from the unified video write boundary is a redacted HTTP 507 and never schedules ffmpeg', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  const operations = [];
  let executorCalls = 0;
  database.withProjectDatabaseWrite = (operation) => {
    operations.push(operation);
    const error = new Error('SQLITE_FULL at C:\\private-project.db while INSERT token=secret');
    error.code = 'SQLITE_FULL';
    throw error;
  };
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setAsyncComposeExecutorForTests(async () => { executorCalls += 1; });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const result = await postCompose(baseUrl);
    assert.equal(result.response.status, 507);
    assert.deepEqual(result.body, {
      success: false,
      code: 'project_database_storage_capacity_exceeded',
      error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
      reason: 'sqlite-full',
      retryable: false,
    });
    assert.doesNotMatch(JSON.stringify(result.body), /private-project|INSERT|secret/i);
    assert.deepEqual(operations, ['video.execution.synthetic-create']);
    assert.equal(executorCalls, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM node_runs').get().count, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM run_attempts').get().count, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetAsyncComposeExecutorForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('typed WAL-pressure capacity failures keep the stable video HTTP 507 ABI', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  database.withProjectDatabaseWrite = () => {
    throw new ProjectDatabaseStorageCapacityError('wal-pressure', {
      operation: 'video.execution.synthetic-create',
    });
  };
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const result = await postCompose(baseUrl);
    assert.equal(result.response.status, 507);
    assert.equal(result.body.code, 'project_database_storage_capacity_exceeded');
    assert.equal(result.body.reason, 'wal-pressure');
    assert.equal(result.body.retryable, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('ordinary synthetic video write failures keep the existing HTTP 503 semantics', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  let executorCalls = 0;
  database.withProjectDatabaseWrite = () => {
    throw new Error('ordinary injected attempt persistence failure');
  };
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.setAsyncComposeExecutorForTests(async () => { executorCalls += 1; });
  videoOpsRouter._test.clearJobsForTests();
  const { server, baseUrl } = await listenVideoOps();
  try {
    const result = await postCompose(baseUrl);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.success, false);
    assert.equal('code' in result.body, false);
    assert.match(result.body.error, /原子建立.*Run\/NodeRun\/Attempt.*停止 ffmpeg/);
    assert.match(result.body.error, /ordinary injected attempt persistence failure/);
    assert.equal(executorCalls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetAsyncComposeExecutorForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});

test('post-commit fallback-event capacity failure is a safe warning and never misreports the durable terminal state as rolled back', () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  videoOpsRouter._test.setExecutionDatabaseForTests(database);
  videoOpsRouter._test.clearJobsForTests();
  try {
    const synthetic = videoOpsRouter._test.createSyntheticVideoOperationExecution(legacyAsyncBody());
    const job = videoOpsRouter._test.makeJob('compose', synthetic.evidence, {
      requireExecutionEvidence: true,
      syntheticExecution: true,
    });
    job.status = 'failed';
    job.message = 'terminal result already decided';
    job.error = job.message;
    const rawMessage = 'SQLITE_FULL at C:\\private\\video.sqlite INSERT run_events token=secret';
    database.appendRunEvent = () => {
      throw Object.assign(new Error(rawMessage), { code: 'SQLITE_FULL' });
    };

    const result = videoOpsRouter._test.finalizeSyntheticVideoOperationExecution(
      job,
      new Error('first terminal evidence transaction failed'),
    );
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.eventPersistence, {
      ok: false,
      code: 'project_database_storage_capacity_exceeded',
      reason: 'sqlite-full',
      retryable: false,
    });
    assert.deepEqual(job.persistenceWarning, result.eventPersistence);
    assert.equal(database.getRun(synthetic.evidence.runId).status, 'failed');
    assert.equal(database.getNodeRun(synthetic.evidence.nodeRunId).status, 'failed');
    assert.equal(database.getAttempt(synthetic.evidence.attemptId).status, 'failed');
    assert.equal(JSON.stringify({ result, warning: job.persistenceWarning }).includes('private'), false);
    assert.equal(JSON.stringify({ result, warning: job.persistenceWarning }).includes('secret'), false);
  } finally {
    videoOpsRouter._test.clearJobsForTests();
    videoOpsRouter._test.resetExecutionDatabaseForTests();
    database.close();
  }
});
