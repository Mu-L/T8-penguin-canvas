'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-read-purity-b2';

function count(database, table, where = '', ...values) {
  return Number(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get(...values)?.count || 0);
}

function totalChanges(database) {
  return Number(database.db.prepare('SELECT total_changes() AS value').get().value);
}

function createAsset(database, id = 'asset-read-purity-b2') {
  return database.upsertAsset({
    id,
    projectId: PROJECT_ID,
    kind: 'image',
    mimeType: 'image/png',
    filename: `${id}.png`,
    contentHash: 'a'.repeat(64),
    contentHashVerification: 'verified',
    createdBy: 'read-purity-owner',
  });
}

function removeDefaultMetadataRows(database, assetId) {
  database.db.prepare('DELETE FROM asset_access_policies WHERE project_id = ? AND asset_id = ?')
    .run(PROJECT_ID, assetId);
  database.db.prepare('DELETE FROM asset_catalog_revisions WHERE project_id = ?').run(PROJECT_ID);
}

function assertStorageCapacity(error) {
  assert.ok(error instanceof ProjectDatabaseStorageCapacityError);
  assert.equal(error.code, 'project_database_storage_capacity_exceeded');
  assert.equal(error.status, 507);
  assert.equal(error.reason, 'filesystem-reserve');
  assert.deepEqual(error.details, {
    reason: 'filesystem-reserve',
    retryable: false,
    operation: 'asset.permissions.update',
  });
  return true;
}

test('B2 catalog, permissions, semantic search and exact-duplicate reads stay pure when default rows are absent', async () => {
  const database = new ProjectDatabase(':memory:');
  let queryOnly = false;
  try {
    const asset = createAsset(database);
    removeDefaultMetadataRows(database, asset.id);
    database.db.prepare(`
      INSERT INTO asset_access_grants(
        project_id, asset_id, principal_type, principal_id, permission, granted_by, created_at
      ) VALUES (?, ?, 'member', 'legacy-member', 'view', 'legacy-owner', 1234)
    `).run(PROJECT_ID, asset.id);
    const changesBeforeReads = totalChanges(database);

    database.db.pragma('query_only = ON');
    queryOnly = true;

    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), 1);
    assert.deepEqual(database.getAssetAccessPolicy(PROJECT_ID, asset.id), {
      projectId: PROJECT_ID,
      assetId: asset.id,
      scope: 'project',
      revision: 1,
      grants: [{
        principalType: 'member',
        principalId: 'legacy-member',
        permissions: ['view'],
        grantedBy: 'legacy-owner',
        createdAt: 1234,
      }],
      updatedBy: 'system-default',
      updatedAt: asset.updatedAt,
    });

    const semantic = database.searchAssetSemantics(PROJECT_ID, { limit: 10 });
    assert.equal(semantic.catalogRevision, 1);
    assert.equal(semantic.items.some((item) => item.asset.id === asset.id), true);
    assert.deepEqual(database.listExactDuplicateGroups(PROJECT_ID), {
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    assert.equal(database.getExactDuplicateGroup(PROJECT_ID, `exact_${'a'.repeat(64)}`), null);

    assert.equal(totalChanges(database), changesBeforeReads);
    assert.equal(count(database, 'asset_access_policies', ' WHERE project_id = ?', PROJECT_ID), 0);
    assert.equal(count(database, 'asset_access_grants', ' WHERE project_id = ?', PROJECT_ID), 1);
    assert.equal(count(database, 'asset_catalog_revisions', ' WHERE project_id = ?', PROJECT_ID), 0);
  } finally {
    if (queryOnly) database.db.pragma('query_only = OFF');
    await database.close();
  }
});

test('B2 explicit permissions writer initializes a missing policy atomically and stale initialization rolls back', async () => {
  const database = new ProjectDatabase(':memory:');
  try {
    const asset = createAsset(database, 'asset-read-purity-explicit-writer');
    removeDefaultMetadataRows(database, asset.id);

    assert.throws(() => database.setAssetAccessPolicy(PROJECT_ID, asset.id, {
      scope: 'restricted',
      expectedRevision: 2,
      grants: [],
    }, { actorId: 'stale-writer' }), (error) => {
      assert.equal(error.code, 'asset_access_revision_conflict');
      assert.equal(error.current.revision, 1);
      return true;
    });
    assert.equal(count(database, 'asset_access_policies', ' WHERE asset_id = ?', asset.id), 0);
    assert.equal(count(database, 'asset_catalog_revisions', ' WHERE project_id = ?', PROJECT_ID), 0);

    const updated = database.setAssetAccessPolicy(PROJECT_ID, asset.id, {
      scope: 'restricted',
      expectedRevision: 1,
      grants: [{ principalType: 'member', principalId: 'member-read-purity', permissions: ['view'] }],
    }, { actorId: 'explicit-writer' });

    assert.equal(updated.scope, 'restricted');
    assert.equal(updated.revision, 2);
    assert.equal(updated.updatedBy, 'explicit-writer');
    assert.deepEqual(updated.grants.map((grant) => ({
      principalType: grant.principalType,
      principalId: grant.principalId,
      permissions: grant.permissions,
    })), [{
      principalType: 'member',
      principalId: 'member-read-purity',
      permissions: ['view'],
    }]);
    assert.equal(count(database, 'asset_access_policies', ' WHERE asset_id = ?', asset.id), 1);
    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), 2);
  } finally {
    await database.close();
  }
});

test('B2 explicit permissions initialization translates a late ENOSPC only after the whole write rolls back', async () => {
  const database = new ProjectDatabase(':memory:');
  const state = { enabled: true };
  const assetId = 'asset-read-purity-capacity';
  try {
    const asset = createAsset(database, assetId);
    removeDefaultMetadataRows(database, asset.id);
    const beforeOrganizationRevision = database.getAsset(asset.id).organizationRevision;

    database.db.function('asset_read_purity_b2_enospc', () => {
      if (!state.enabled) return 1;
      const error = new Error('controlled ENOSPC permissions initialization');
      error.code = 'ENOSPC';
      throw error;
    });
    database.db.exec(`
      CREATE TRIGGER asset_read_purity_b2_permissions_enospc
      BEFORE INSERT ON asset_catalog_revisions
      WHEN NEW.project_id = '${PROJECT_ID}'
      BEGIN
        SELECT asset_read_purity_b2_enospc();
      END;
    `);

    const request = {
      scope: 'restricted',
      expectedRevision: 1,
      grants: [{ principalType: 'member', principalId: 'member-capacity', permissions: ['view'] }],
    };
    assert.throws(
      () => database.setAssetAccessPolicy(PROJECT_ID, asset.id, request, { actorId: 'capacity-writer' }),
      assertStorageCapacity,
    );
    assert.equal(count(database, 'asset_access_policies', ' WHERE asset_id = ?', asset.id), 0);
    assert.equal(count(database, 'asset_access_grants', ' WHERE asset_id = ?', asset.id), 0);
    assert.equal(count(database, 'asset_catalog_revisions', ' WHERE project_id = ?', PROJECT_ID), 0);
    assert.equal(database.getAsset(asset.id).organizationRevision, beforeOrganizationRevision);

    state.enabled = false;
    const updated = database.setAssetAccessPolicy(PROJECT_ID, asset.id, request, { actorId: 'capacity-writer' });
    assert.equal(updated.revision, 2);
    assert.equal(updated.scope, 'restricted');
    assert.equal(database.getAsset(asset.id).organizationRevision, beforeOrganizationRevision + 1);
    assert.equal(database.getAssetCatalogRevision(PROJECT_ID), 2);
  } finally {
    await database.close();
  }
});
