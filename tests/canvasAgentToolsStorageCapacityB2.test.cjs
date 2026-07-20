'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const projectRoot = path.resolve(__dirname, '..');
const projectDatabaseModulePath = require.resolve('../backend/src/services/projectDatabase');
const routeModulePath = path.join(projectRoot, 'backend', 'src', 'routes', 'canvasAgentTools.js');
const projectDatabaseService = require(projectDatabaseModulePath);
const { CanvasAgentToolError } = require('../backend/src/services/canvasAgentTools');
const { ProjectDatabaseStorageCapacityError } = projectDatabaseService;

function throwingDatabase(error) {
  return {
    getCanvas() {
      throw error;
    },
  };
}

// Loading the route also constructs its production router. Keep that module-load
// side effect on an inert adapter so this test never opens the retained database;
// restore the real module before requests so raw SQLite errors use the real mapper.
const previousProjectDatabaseModule = require.cache[projectDatabaseModulePath];
require.cache[projectDatabaseModulePath] = {
  id: projectDatabaseModulePath,
  filename: projectDatabaseModulePath,
  loaded: true,
  exports: { getProjectDatabase: () => throwingDatabase(new Error('inert')) },
};
const { createCanvasAgentToolsRouter } = require(routeModulePath);
require.cache[projectDatabaseModulePath] = previousProjectDatabaseModule;

function agentRequest() {
  return {
    tool: 'inspectCanvas',
    requestId: 'request-storage-capacity',
    projectId: 'project-a',
    canvasId: 'canvas-a',
    input: {},
  };
}

async function startRoute(database) {
  const app = express();
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use('/api/canvas-agent', createCanvasAgentToolsRouter({ database }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/api/canvas-agent/tools`,
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function post(database) {
  const { server, url } = await startRoute(database);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(agentRequest()),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await closeServer(server);
  }
}

test('B2 Agent tool HTTP maps raw SQLITE_FULL to a redacted stable 507', async () => {
  const source = Object.assign(
    new Error('INSERT failed at C:\\Users\\private\\project.sqlite3 token=never-expose'),
    { code: 'SQLITE_FULL', sql: 'INSERT INTO private_table VALUES (?)' },
  );
  const result = await post(throwingDatabase(source));

  assert.deepEqual(result, {
    status: 507,
    body: {
      success: false,
      code: 'project_database_storage_capacity_exceeded',
      error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
      reason: 'sqlite-full',
      retryable: false,
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /Users|private_table|token|never-expose|INSERT/i);
});

test('B2 Agent tool HTTP preserves typed storage pressure as a redacted retryable 507', async () => {
  const source = new ProjectDatabaseStorageCapacityError('wal-pressure', {
    operation: 'writer.private-operation',
  });
  source.message = 'checkpoint failed at C:\\Users\\private\\project.sqlite3 token=never-expose';
  const result = await post(throwingDatabase(source));

  assert.deepEqual(result, {
    status: 507,
    body: {
      success: false,
      code: 'project_database_storage_capacity_exceeded',
      error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
      reason: 'wal-pressure',
      retryable: true,
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /Users|private-operation|token|never-expose|checkpoint failed/i);
});

test('B2 Agent tool HTTP leaves non-capacity CanvasAgentToolError behavior unchanged', async () => {
  const source = new CanvasAgentToolError(
    'agent_snapshot_changed',
    '画布在只读工具执行期间已变化，请重试',
    409,
  );
  const result = await post(throwingDatabase(source));

  assert.deepEqual(result, {
    status: 409,
    body: {
      success: false,
      code: 'agent_snapshot_changed',
      error: '画布在只读工具执行期间已变化,请重试',
    },
  });
});
