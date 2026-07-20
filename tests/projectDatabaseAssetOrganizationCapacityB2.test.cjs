'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');

const PROJECT_ID = 'project-asset-organization-capacity-b2';
const OUTER_OPERATION = 'asset.organization.atomic-batch';

function addAsset(database, id) {
  return database.upsertAsset({
    id,
    projectId: PROJECT_ID,
    kind: 'image',
    mimeType: 'image/png',
    filename: `${id}.png`,
  });
}

function organizationState(database) {
  return {
    assets: database.db.prepare(`
      SELECT id, organization_revision, updated_at
      FROM assets
      WHERE project_id = ?
      ORDER BY id
    `).all(PROJECT_ID),
    tags: database.db.prepare(`
      SELECT t.asset_id, t.tag, t.created_at
      FROM asset_tags t
      JOIN assets a ON a.id = t.asset_id
      WHERE a.project_id = ?
      ORDER BY t.asset_id, t.tag
    `).all(PROJECT_ID),
    collections: database.db.prepare(`
      SELECT id, name, description, revision, updated_at
      FROM asset_collections
      WHERE project_id = ?
      ORDER BY id
    `).all(PROJECT_ID),
    members: database.db.prepare(`
      SELECT m.collection_id, m.asset_id, m.added_at
      FROM asset_collection_members m
      JOIN asset_collections c ON c.id = m.collection_id
      WHERE c.project_id = ?
      ORDER BY m.collection_id, m.asset_id
    `).all(PROJECT_ID),
    catalog: database.db.prepare(`
      SELECT project_id, revision, updated_at
      FROM asset_catalog_revisions
      WHERE project_id = ?
    `).get(PROJECT_ID) || null,
  };
}

function catalogRevision(database) {
  return database.getAssetCatalogRevision(PROJECT_ID);
}

function collectionMemberIds(database, collectionId) {
  return database.db.prepare(`
    SELECT asset_id
    FROM asset_collection_members
    WHERE collection_id = ?
    ORDER BY asset_id
  `).all(collectionId).map((row) => row.asset_id);
}

function installLateCatalogCapacityFault(database) {
  const original = database._bumpAssetCatalogRevision.bind(database);
  let armed = false;
  let failNext = false;
  const observations = [];

  database._bumpAssetCatalogRevision = (projectId, ...args) => {
    if (armed && String(projectId) === PROJECT_ID) {
      observations.push({
        coordinatorActive: database.isProjectDatabaseWriteCoordinatorActive(),
        inTransaction: database.db.inTransaction,
      });
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('controlled asset organization ENOSPC'), { code: 'ENOSPC' });
      }
      armed = false;
    }
    return original(projectId, ...args);
  };

  return {
    arm() {
      armed = true;
      failNext = true;
      observations.length = 0;
    },
    observations,
  };
}

function isCapacityErrorForOperation(error, operation) {
  return error instanceof ProjectDatabaseStorageCapacityError
    && error.code === 'project_database_storage_capacity_exceeded'
    && error.status === 507
    && error.reason === 'filesystem-reserve'
    && error.details?.operation === operation;
}

function assertCoordinatedFailureAndRetry(fault) {
  assert.deepEqual(fault.observations, [
    { coordinatorActive: true, inTransaction: true },
    { coordinatorActive: true, inTransaction: true },
  ]);
}

function tagWriterFixture(database) {
  const asset = addAsset(database, 'organization-tags-asset');
  database.setAssetTags(asset.id, ['seed'], { expectedRevision: asset.organizationRevision });
  const prepare = (tag) => {
    const before = database.getAsset(asset.id);
    const beforeCatalog = catalogRevision(database);
    return {
      invoke: () => database.setAssetTags(asset.id, [tag], {
        expectedRevision: before.organizationRevision,
      }),
      verify() {
        const updated = database.getAsset(asset.id);
        assert.deepEqual(updated.tags, [tag]);
        assert.equal(updated.organizationRevision, before.organizationRevision + 1);
        assert.equal(catalogRevision(database), beforeCatalog + 1);
      },
    };
  };
  return {
    standalone: () => prepare('standalone'),
    nested: () => prepare('nested'),
  };
}

function collectionCreateFixture(database) {
  const prepare = (suffix) => {
    const id = `organization-create-${suffix}`;
    const beforeCatalog = catalogRevision(database);
    return {
      invoke: () => database.createAssetCollection({
        id,
        projectId: PROJECT_ID,
        name: `Created ${suffix}`,
      }),
      verify() {
        const created = database.getAssetCollection(id, PROJECT_ID);
        assert.equal(created.name, `Created ${suffix}`);
        assert.equal(created.revision, 1);
        assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM asset_collections WHERE id = ?').get(id).count, 1);
        assert.equal(catalogRevision(database), beforeCatalog + 1);
      },
    };
  };
  return {
    standalone: () => prepare('standalone'),
    nested: () => prepare('nested'),
  };
}

function collectionUpdateFixture(database) {
  const collection = database.createAssetCollection({
    id: 'organization-update-collection',
    projectId: PROJECT_ID,
    name: 'Before update',
  });
  const prepare = (suffix) => {
    const before = database.getAssetCollection(collection.id, PROJECT_ID);
    const beforeCatalog = catalogRevision(database);
    return {
      invoke: () => database.updateAssetCollection(collection.id, {
        name: `Updated ${suffix}`,
        expectedRevision: before.revision,
      }, { projectId: PROJECT_ID }),
      verify() {
        const updated = database.getAssetCollection(collection.id, PROJECT_ID);
        assert.equal(updated.name, `Updated ${suffix}`);
        assert.equal(updated.revision, before.revision + 1);
        assert.equal(catalogRevision(database), beforeCatalog + 1);
      },
    };
  };
  return {
    standalone: () => prepare('standalone'),
    nested: () => prepare('nested'),
  };
}

function collectionDeleteFixture(database) {
  const firstAsset = addAsset(database, 'organization-delete-asset-a');
  const secondAsset = addAsset(database, 'organization-delete-asset-b');
  const first = database.createAssetCollection({
    id: 'organization-delete-collection-a',
    projectId: PROJECT_ID,
    name: 'Delete standalone',
  });
  const second = database.createAssetCollection({
    id: 'organization-delete-collection-b',
    projectId: PROJECT_ID,
    name: 'Delete nested',
  });
  database.addAssetCollectionMember(first.id, firstAsset.id, { expectedRevision: first.revision });
  database.addAssetCollectionMember(second.id, secondAsset.id, { expectedRevision: second.revision });

  const prepare = (collectionId, assetId) => {
    const beforeCollection = database.getAssetCollection(collectionId, PROJECT_ID);
    const beforeAsset = database.getAsset(assetId);
    const beforeCatalog = catalogRevision(database);
    return {
      invoke: () => database.deleteAssetCollection(collectionId, {
        projectId: PROJECT_ID,
        expectedRevision: beforeCollection.revision,
      }),
      verify() {
        assert.equal(database.getAssetCollection(collectionId, PROJECT_ID), null);
        assert.equal(database.getAsset(assetId).organizationRevision, beforeAsset.organizationRevision + 1);
        assert.equal(catalogRevision(database), beforeCatalog + 1);
      },
    };
  };
  return {
    standalone: () => prepare(first.id, firstAsset.id),
    nested: () => prepare(second.id, secondAsset.id),
  };
}

function collectionMembersReplaceFixture(database) {
  const first = addAsset(database, 'organization-replace-asset-a');
  const second = addAsset(database, 'organization-replace-asset-b');
  const collection = database.createAssetCollection({
    id: 'organization-replace-collection',
    projectId: PROJECT_ID,
    name: 'Replace members',
  });
  const prepare = (assetId) => {
    const beforeCollection = database.getAssetCollection(collection.id, PROJECT_ID);
    const beforeAssets = new Map([first.id, second.id].map((id) => [id, database.getAsset(id)]));
    const previousIds = collectionMemberIds(database, collection.id);
    const beforeCatalog = catalogRevision(database);
    return {
      invoke: () => database.setAssetCollectionMembers(collection.id, [assetId], {
        expectedRevision: beforeCollection.revision,
      }),
      verify() {
        assert.deepEqual(collectionMemberIds(database, collection.id), [assetId]);
        assert.equal(database.getAssetCollection(collection.id, PROJECT_ID).revision, beforeCollection.revision + 1);
        for (const changedId of new Set([...previousIds, assetId])) {
          assert.equal(
            database.getAsset(changedId).organizationRevision,
            beforeAssets.get(changedId).organizationRevision + 1,
          );
        }
        assert.equal(catalogRevision(database), beforeCatalog + 1);
      },
    };
  };
  return {
    standalone: () => prepare(first.id),
    nested: () => prepare(second.id),
  };
}

function collectionMemberAddFixture(database) {
  const first = addAsset(database, 'organization-add-asset-a');
  const second = addAsset(database, 'organization-add-asset-b');
  const collection = database.createAssetCollection({
    id: 'organization-add-collection',
    projectId: PROJECT_ID,
    name: 'Add members',
  });
  const prepare = (assetId) => {
    const beforeCollection = database.getAssetCollection(collection.id, PROJECT_ID);
    const beforeAsset = database.getAsset(assetId);
    const beforeCatalog = catalogRevision(database);
    return {
      invoke: () => database.addAssetCollectionMember(collection.id, assetId, {
        expectedRevision: beforeCollection.revision,
      }),
      verify() {
        assert.ok(collectionMemberIds(database, collection.id).includes(assetId));
        assert.equal(database.getAssetCollection(collection.id, PROJECT_ID).revision, beforeCollection.revision + 1);
        assert.equal(database.getAsset(assetId).organizationRevision, beforeAsset.organizationRevision + 1);
        assert.equal(catalogRevision(database), beforeCatalog + 1);
      },
    };
  };
  return {
    standalone: () => prepare(first.id),
    nested: () => prepare(second.id),
  };
}

function collectionMemberRemoveFixture(database) {
  const first = addAsset(database, 'organization-remove-asset-a');
  const second = addAsset(database, 'organization-remove-asset-b');
  const collection = database.createAssetCollection({
    id: 'organization-remove-collection',
    projectId: PROJECT_ID,
    name: 'Remove members',
  });
  const withFirst = database.addAssetCollectionMember(collection.id, first.id, {
    expectedRevision: collection.revision,
  });
  database.addAssetCollectionMember(collection.id, second.id, {
    expectedRevision: database.getAssetCollection(collection.id, PROJECT_ID).revision,
  });
  assert.equal(withFirst.id, first.id);

  const prepare = (assetId) => {
    const beforeCollection = database.getAssetCollection(collection.id, PROJECT_ID);
    const beforeAsset = database.getAsset(assetId);
    const beforeCatalog = catalogRevision(database);
    return {
      invoke: () => database.removeAssetCollectionMember(collection.id, assetId, {
        expectedRevision: beforeCollection.revision,
      }),
      verify() {
        assert.equal(collectionMemberIds(database, collection.id).includes(assetId), false);
        assert.equal(database.getAssetCollection(collection.id, PROJECT_ID).revision, beforeCollection.revision + 1);
        assert.equal(database.getAsset(assetId).organizationRevision, beforeAsset.organizationRevision + 1);
        assert.equal(catalogRevision(database), beforeCatalog + 1);
      },
    };
  };
  return {
    standalone: () => prepare(first.id),
    nested: () => prepare(second.id),
  };
}

const WRITER_CASES = [
  ['setAssetTags', 'asset.tags.update', tagWriterFixture],
  ['createAssetCollection', 'asset.collection.create', collectionCreateFixture],
  ['updateAssetCollection', 'asset.collection.update', collectionUpdateFixture],
  ['deleteAssetCollection', 'asset.collection.delete', collectionDeleteFixture],
  ['setAssetCollectionMembers', 'asset.collection.members.replace', collectionMembersReplaceFixture],
  ['addAssetCollectionMember', 'asset.collection.members.add', collectionMemberAddFixture],
  ['removeAssetCollectionMember', 'asset.collection.members.remove', collectionMemberRemoveFixture],
];

test('B2 asset organization writers coordinate late ENOSPC rollback, exact operations, retry, and nested ownership', async (t) => {
  for (const [methodName, operation, makeFixture] of WRITER_CASES) {
    await t.test(methodName, async () => {
      const database = new ProjectDatabase(':memory:', { autoBackup: false });
      try {
        const fixture = makeFixture(database);
        const fault = installLateCatalogCapacityFault(database);

        const standalone = fixture.standalone();
        const beforeStandalone = organizationState(database);
        fault.arm();
        let standaloneError = null;
        try {
          standalone.invoke();
        } catch (error) {
          standaloneError = error;
        }
        assert.ok(standaloneError, `${methodName} must surface the controlled ENOSPC`);
        assert.equal(database.db.inTransaction, false);
        assert.deepEqual(organizationState(database), beforeStandalone);
        standalone.invoke();
        standalone.verify();
        const standaloneObservations = structuredClone(fault.observations);

        const nested = fixture.nested();
        const beforeNested = organizationState(database);
        const invokeNested = () => database.withProjectDatabaseWrite(
          OUTER_OPERATION,
          nested.invoke,
        );
        fault.arm();
        assert.throws(invokeNested, (error) => isCapacityErrorForOperation(error, OUTER_OPERATION));
        assert.equal(database.db.inTransaction, false);
        assert.deepEqual(organizationState(database), beforeNested);
        invokeNested();
        nested.verify();
        assertCoordinatedFailureAndRetry(fault);

        assert.ok(
          isCapacityErrorForOperation(standaloneError, operation),
          `${methodName} must translate standalone ENOSPC with exact operation ${operation}`,
        );
        assert.deepEqual(standaloneObservations, [
          { coordinatorActive: true, inTransaction: true },
          { coordinatorActive: true, inTransaction: true },
        ]);
      } finally {
        await database.close();
      }
    });
  }
});
