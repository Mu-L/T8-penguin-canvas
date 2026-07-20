'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  mapProjectDatabaseStorageCapacityPublicError,
  sendProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabasePublicError');

test('B2 public storage mapper translates raw FULL without exposing source error details', () => {
  const source = Object.assign(
    new Error('C:\\Users\\private\\project.sqlite3 token=never-expose'),
    { code: 'SQLITE_FULL', path: 'C:\\Users\\private\\project.sqlite3' },
  );
  const mapped = mapProjectDatabaseStorageCapacityPublicError(source, {
    operation: 'run.terminal',
    secret: 'never-expose',
  });

  assert.deepEqual(mapped, {
    status: 507,
    body: {
      success: false,
      code: 'project_database_storage_capacity_exceeded',
      error: '项目数据库或 SQLite 临时存储空间不足，本次写入已回滚',
      reason: 'sqlite-full',
      retryable: false,
    },
  });
  assert.doesNotMatch(JSON.stringify(mapped), /Users|private|token|never-expose/i);
});

test('B2 public storage mapper is non-intercepting for unrelated failures', () => {
  const unrelated = Object.assign(new Error('permission denied'), { code: 'EACCES', status: 403 });
  assert.equal(mapProjectDatabaseStorageCapacityPublicError(unrelated), null);

  const calls = [];
  const response = {
    status(value) {
      calls.push(['status', value]);
      return this;
    },
    json(value) {
      calls.push(['json', value]);
      return this;
    },
  };
  assert.equal(sendProjectDatabaseStorageCapacityError(response, unrelated), false);
  assert.deepEqual(calls, []);
});

test('B2 public storage sender emits stable 507 and a whitelisted reason only', () => {
  const calls = [];
  const response = {
    status(value) {
      calls.push(['status', value]);
      return this;
    },
    json(value) {
      calls.push(['json', value]);
      return this;
    },
  };
  const source = Object.assign(new Error('quota path must stay private'), { code: 'EDQUOT' });

  assert.equal(sendProjectDatabaseStorageCapacityError(response, source, {
    operation: 'backup',
  }), true);
  assert.deepEqual(calls, [
    ['status', 507],
    ['json', {
      success: false,
      code: 'project_database_storage_capacity_exceeded',
      error: '项目数据库所在文件系统空间或配额不足，本次操作未完成',
      reason: 'backup-storage-full',
      retryable: false,
    }],
  ]);
});
