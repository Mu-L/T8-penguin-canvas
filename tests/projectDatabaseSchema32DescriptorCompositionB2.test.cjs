const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');

const {
  ProjectDatabase,
} = require('../backend/src/services/projectDatabase');
const {
  PROJECT_DATABASE_MIGRATION_32_UP_SQL,
  PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES,
  PROJECT_DATABASE_SCHEMA_32_EXTENSION_FINGERPRINT,
  PROJECT_DATABASE_SCHEMA_32_FINGERPRINT_MAPPINGS,
  composeProjectDatabaseSchema32TargetManifest,
} = require('../backend/src/services/projectDatabaseMigration32');
const {
  PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
} = require('../backend/src/services/projectDatabaseMigration23');
const {
  inspectProjectDatabaseSchemaManifest,
  stableJson,
} = require('./helpers/projectDatabaseSchemaManifest.cjs');
const {
  stripSchema32ForSyntheticSchema31,
} = require('./helpers/projectDatabaseVersion.cjs');

const EXTENSION_FINGERPRINT =
  'bae4f62ab94effb8bafe3027c7bd037ab51e7c13f28bbdda5dcf80f8dce85276';

const KNOWN_FINGERPRINT_MAPPINGS = Object.freeze([
  Object.freeze({
    fromFingerprint: '4280e3554a8291a8292fe06c48ca2538349ac44e416d57755cddbee5a208f2d3',
    toFingerprint: '1a96058cf4f2be5a1f50aacefaa6db568b744f736f04f099922831197b238cc3',
  }),
  Object.freeze({
    fromFingerprint: '5c9f3300794458131265551331b9cce9b7b1eaf7dd6f3bd00e12c83ad1e6f29e',
    toFingerprint: 'd7b7ce892af6d7fd7a28c175912c3e77485b33fa05b93d02d4c7f1e34dd219ec',
  }),
  Object.freeze({
    fromFingerprint: '632f46888c88c6fb572404984b6125ca218c3a9ca734e6730eb96be6b001466d',
    toFingerprint: '2f8d6ea2d730680d99ab32800aabb0ec4aabbe86509443e70f68ac2ac501248b',
  }),
  Object.freeze({
    fromFingerprint: '7d36855db4254c3190060bbd4247cd8b1a1bb1902d2c2c7941918c4dc3ea44a6',
    toFingerprint: 'a8501c5d2ecc5c884326c34b52af0c06140daff9ab83fdb12fcc3f7d5695e4b9',
  }),
  Object.freeze({
    fromFingerprint: '7e926272b0d4cbd120d8e1c49bea496392fb24fd858205b15afddc49bedf5f71',
    toFingerprint: '008d4858e684f0defff378054557ba8cf1465743fcee4322bfb2802fe2d8de23',
  }),
  Object.freeze({
    fromFingerprint: 'a7322cdf1a82412cf35acbdb9b4ba03815eaf0f4f51068faf2781c7212315858',
    toFingerprint: '0d2e8bd0fc2ff308c8ec2a02ecc1098ef6510af81c8bf0042a0a3dacbc7ca873',
  }),
  Object.freeze({
    fromFingerprint: 'bd34241e06f5aca3cde5c5055587cdd78ce618d9d33d26754bc7d9555ffa0c5d',
    toFingerprint: '8beea0ab7330440639bbc5759aa43e10b8e2e74039e3eff484aaa9eadb7dafa3',
  }),
  Object.freeze({
    fromFingerprint: 'd74d841fe60332a51968e90b24636ef6f0efc524a2309924a3de4082eecef91d',
    toFingerprint: 'a69b7f2bf1c60b0949e3840b5609b1e894903f77feec3101cfaf3587d5fbf74e',
  }),
  Object.freeze({
    fromFingerprint: 'd930bf64a047d0e7246c3ab1ad1630958656303f708f489f0c71e2ba37aabf8a',
    toFingerprint: '3b072d4c4a23e98453f7a5657f46bc68388c08f0dd85fe3c78f9f94602cdbb49',
  }),
]);

function descriptorFingerprint(descriptor) {
  return crypto.createHash('sha256').update(stableJson(descriptor), 'utf8').digest('hex');
}

function cloneManifest(manifest) {
  return {
    descriptor: structuredClone(manifest.descriptor),
    fingerprint: manifest.fingerprint,
    counts: structuredClone(manifest.counts),
  };
}

function createExtensionManifest(database) {
  return inspectProjectDatabaseSchemaManifest(database, {
    descriptorVersion: 32,
    includedObjectNames: PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES,
  });
}

test('B2 schema32 descriptor composition freezes exact vectors and fails closed on partition tampering', async () => {
  assert.equal(PROJECT_DATABASE_SCHEMA_32_EXTENSION_FINGERPRINT, EXTENSION_FINGERPRINT);
  assert.deepEqual(PROJECT_DATABASE_SCHEMA_32_FINGERPRINT_MAPPINGS, KNOWN_FINGERPRINT_MAPPINGS);
  assert.equal(Object.isFrozen(PROJECT_DATABASE_SCHEMA_32_FINGERPRINT_MAPPINGS), true);
  assert.equal(
    PROJECT_DATABASE_SCHEMA_32_FINGERPRINT_MAPPINGS.every((entry) => Object.isFrozen(entry)),
    true,
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-b2-schema32-compose-'));
  const filename = path.join(directory, 'project.sqlite3');
  let projectDatabase = null;
  let database = null;
  try {
    projectDatabase = new ProjectDatabase(filename, { autoBackup: false });
    await projectDatabase.close();
    projectDatabase = null;

    database = new BetterSqlite3(filename);
    stripSchema32ForSyntheticSchema31(database);
    const sourceManifest = inspectProjectDatabaseSchemaManifest(database, {
      descriptorVersion: 31,
      excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
    });
    const knownMapping = KNOWN_FINGERPRINT_MAPPINGS.find(
      (entry) => entry.fromFingerprint === sourceManifest.fingerprint,
    );
    assert.ok(knownMapping, `generated source ${sourceManifest.fingerprint} must be a frozen vector`);

    database.exec(PROJECT_DATABASE_MIGRATION_32_UP_SQL);
    const extensionManifest = createExtensionManifest(database);
    const actualTargetManifest = inspectProjectDatabaseSchemaManifest(database, {
      descriptorVersion: 32,
      excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
    });
    assert.equal(extensionManifest.fingerprint, EXTENSION_FINGERPRINT);

    const composed = composeProjectDatabaseSchema32TargetManifest(
      sourceManifest,
      extensionManifest,
    );
    assert.deepEqual(composed, actualTargetManifest);
    assert.equal(composed.fingerprint, knownMapping.toFingerprint);
    assert.equal(Object.isFrozen(composed), true);
    assert.equal(Object.isFrozen(composed.descriptor), true);

    const countTamper = cloneManifest(sourceManifest);
    countTamper.counts.tables += 1;
    assert.throws(
      () => composeProjectDatabaseSchema32TargetManifest(countTamper, extensionManifest),
      /count|descriptor|manifest/i,
    );

    const conflict = cloneManifest(sourceManifest);
    conflict.descriptor.tables.push(structuredClone(extensionManifest.descriptor.tables[0]));
    conflict.descriptor.counts.tables += 1;
    conflict.counts.tables += 1;
    conflict.fingerprint = descriptorFingerprint(conflict.descriptor);
    assert.throws(
      () => composeProjectDatabaseSchema32TargetManifest(conflict, extensionManifest),
      /conflict|collision|overlap|owned|source|fingerprint/i,
    );

    const unacceptedDescriptor = {
      version: 31,
      counts: { tables: 1, indexes: 0, triggers: 0, views: 0 },
      tables: [{
        name: 'unaccepted_schema31_probe',
        kind: 'table',
        withoutRowid: 0,
        strict: 1,
        definition: '( id integer primary key ) strict',
        columns: [],
        foreignKeys: [],
        indexes: [],
        checks: [],
        autoincrement: false,
        virtualDefinition: null,
      }],
      triggers: [],
      views: [],
    };
    const unacceptedManifest = {
      descriptor: unacceptedDescriptor,
      counts: unacceptedDescriptor.counts,
      fingerprint: descriptorFingerprint(unacceptedDescriptor),
    };
    assert.throws(
      () => composeProjectDatabaseSchema32TargetManifest(unacceptedManifest, extensionManifest),
      /accepted|allowlist|source|fingerprint/i,
    );
  } finally {
    try { database?.close(); } catch (_) {}
    try { await projectDatabase?.close(); } catch (_) {}
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
