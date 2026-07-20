'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');

function errorCode(code) {
  return (error) => error?.code === code;
}

test('internal mutation assertion distinguishes coordinator and existing transaction contexts', async (t) => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  t.after(async () => database.close());

  assert.throws(
    () => database._assertProjectDatabaseMutationTransaction('unknown'),
    errorCode('project_database_mutation_context_invalid'),
  );
  assert.throws(
    () => database._assertProjectDatabaseMutationTransaction('existing-transaction'),
    errorCode('project_database_mutation_transaction_required'),
  );
  assert.throws(
    () => database._assertProjectDatabaseMutationTransaction('coordinator'),
    errorCode('project_database_mutation_transaction_required'),
  );

  database.db.transaction(() => {
    assert.equal(
      database._assertProjectDatabaseMutationTransaction('existing-transaction'),
      true,
    );
    assert.throws(
      () => database._assertProjectDatabaseMutationTransaction('coordinator'),
      errorCode('project_database_write_coordinator_required'),
    );
  }).immediate();

  database.withProjectDatabaseWrite('b2.internal-transaction-assertion', () => {
    assert.equal(database._assertProjectDatabaseMutationTransaction('coordinator'), true);
    assert.equal(
      database._assertProjectDatabaseMutationTransaction('existing-transaction'),
      true,
    );
  });
});

test('coordinator-asserted internal writer cannot mutate from an uncoordinated caller', async (t) => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  t.after(async () => database.close());

  assert.throws(
    () => database._bumpAssetCatalogRevision('b2-internal-assertion-project'),
    errorCode('project_database_mutation_transaction_required'),
  );
  database.db.transaction(() => {
    assert.throws(
      () => database._bumpAssetCatalogRevision('b2-internal-assertion-project'),
      errorCode('project_database_write_coordinator_required'),
    );
  }).immediate();

  const revision = database.withProjectDatabaseWrite(
    'b2.internal-transaction-writer',
    () => database._bumpAssetCatalogRevision('b2-internal-assertion-project'),
  );
  assert.equal(revision, 2);
  assert.equal(database.getAssetCatalogRevision('b2-internal-assertion-project'), 2);
});

test('ledger ensure and orphan cleanup helpers fail closed outside their exact transaction domains', async (t) => {
  const database = new ProjectDatabase(':memory:', { autoBackup: false });
  t.after(async () => database.close());

  assert.throws(
    () => database._ensureProjectDurableLedgerState('b2-internal-ledger-project'),
    errorCode('project_database_mutation_transaction_required'),
  );
  database.db.transaction(() => {
    database._ensureProjectDurableLedgerState('b2-internal-ledger-project');
  }).immediate();
  assert.equal(Number(database.db.prepare(`
    SELECT COUNT(*) AS count FROM project_durable_ledger_policies WHERE project_id = ?
  `).get('b2-internal-ledger-project').count), 1);

  assert.throws(
    () => database._cleanupOrphanAssetBlob('missing-b2-blob'),
    errorCode('project_database_mutation_transaction_required'),
  );
  assert.equal(database.withProjectDatabaseWrite(
    'b2.internal-orphan-cleanup',
    () => database._cleanupOrphanAssetBlob('missing-b2-blob'),
  ), false);
});
