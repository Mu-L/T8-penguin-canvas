'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ProjectDatabase } = require('../backend/src/services/projectDatabase');

function assertSnapshotShape(snapshot) {
  for (const key of [
    'pageSize', 'pageCount', 'freelistCount', 'maxPageCount',
    'allocatedPageBytes', 'reusablePageBytes', 'mainBytes', 'walBytes',
    'shmBytes', 'journalBytes', 'databaseFootprintBytes', 'backupFileCount',
    'canonicalBackupBytes', 'migrationBackupFileCount', 'migrationBackupBytes',
    'backupBytes', 'knownTotalBytes', 'retentionAllocatedBytes',
  ]) {
    assert.equal(Number.isSafeInteger(snapshot[key]), true, key);
    assert.ok(snapshot[key] >= 0, key);
  }
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.unmeasured, [
    'sqlite-temp-files',
    'in-flight-backup-temp-files',
    'recovery-evidence-copies',
    'other-process-file-handles',
  ]);
  assert.equal(JSON.stringify(snapshot).includes('filename'), false);
}

test('B2 in-memory storage snapshot is structured and preserves the legacy retention estimate', async () => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  try {
    database.ensureCanvas('canvas-storage-snapshot-memory', {
      projectId: 'project-storage-snapshot',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, 'project-storage-snapshot');
    const snapshot = database.databaseStorageSnapshot();

    assertSnapshotShape(snapshot);
    assert.equal(snapshot.memory, true);
    assert.equal(snapshot.mainBytes, 0);
    assert.equal(snapshot.walBytes, 0);
    assert.equal(snapshot.shmBytes, 0);
    assert.equal(snapshot.journalBytes, 0);
    assert.equal(snapshot.databaseFootprintBytes, 0);
    assert.equal(snapshot.backupBytes, 0);
    assert.equal(snapshot.filesystemFreeBytes, null);
    assert.equal(snapshot.allocatedPageBytes, snapshot.pageCount * snapshot.pageSize);
    assert.equal(snapshot.retentionAllocatedBytes, snapshot.allocatedPageBytes);
    assert.equal(database.databaseAllocatedBytes(), snapshot.retentionAllocatedBytes);
  } finally {
    await database.close();
  }
});

test('B2 disk storage snapshot separates main/WAL/SHM/backup bytes without exposing paths', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-storage-snapshot-b2-'));
  const filename = path.join(directory, 'projects.sqlite3');
  const backupFilename = path.join(directory, 'projects.sqlite3.backup');
  let database = null;
  try {
    database = new ProjectDatabase(filename, {
      autoBackup: false,
      backupFilename,
    });
    database.ensureCanvas('canvas-storage-snapshot-disk', {
      projectId: 'project-storage-snapshot',
      nodes: [{
        id: 'node-storage-snapshot',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { text: 'structured storage evidence' },
      }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    }, 'project-storage-snapshot');
    await database.createBackup();
    const snapshot = database.databaseStorageSnapshot();

    assertSnapshotShape(snapshot);
    assert.equal(snapshot.memory, false);
    assert.equal(snapshot.journalMode, 'wal');
    assert.ok(snapshot.mainBytes > 0);
    assert.ok(snapshot.backupBytes > 0);
    assert.ok(snapshot.canonicalBackupBytes > 0);
    assert.ok(snapshot.backupFileCount >= 1);
    assert.equal(
      snapshot.backupFileCount,
      1 + snapshot.migrationBackupFileCount,
    );
    assert.equal(
      snapshot.backupBytes,
      snapshot.canonicalBackupBytes + snapshot.migrationBackupBytes,
    );
    assert.equal(
      snapshot.databaseFootprintBytes,
      snapshot.mainBytes + snapshot.walBytes + snapshot.shmBytes + snapshot.journalBytes,
    );
    assert.equal(snapshot.knownTotalBytes, snapshot.databaseFootprintBytes + snapshot.backupBytes);
    assert.equal(
      snapshot.retentionAllocatedBytes,
      Math.max(snapshot.allocatedPageBytes, snapshot.mainBytes + snapshot.walBytes),
    );
    assert.equal(database.databaseAllocatedBytes(), snapshot.retentionAllocatedBytes);
    assert.equal(
      snapshot.filesystemFreeBytes == null || Number.isSafeInteger(snapshot.filesystemFreeBytes),
      true,
    );
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /projects\.sqlite3|storage-snapshot-b2|Users|PenguinPravite/i);
  } finally {
    try { await database?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
