'use strict';

const { createHash } = require('node:crypto');

const VERSION = 23;
const FROM_VERSION = 22;
const NAME = 'room-resource-scope';
const DOWN_POLICY = 'backup-only';
const CHECKSUM_CANONICALIZATION = 't8-project-database-migration-v2';

const lineageContract = Object.freeze({
  format: 't8-project-database-migration-23-lineage-v1',
  provenance: Object.freeze([
    Object.freeze({
      tag: 'v2.5.6',
      commit: 'affdaa07c04262746a4b65af96af7835d8d6744e',
      sourcePath: 'backend/src/services/projectDatabase.js',
      sourceBlob: 'ecb279b2a012b11790b86c5bbed72a72e99925e6',
    }),
    Object.freeze({
      tag: 'v2.5.7',
      commit: 'a0934fb761cb725c53dbd4c704a0c4013005e778',
      sourcePath: 'backend/src/services/projectDatabase.js',
      sourceBlob: 'af00452ea459867bf616d3ea6a9d376109158be9',
    }),
    Object.freeze({
      tag: 'v2.5.8',
      commit: '5aba6f7fdfeeca9f313afee3b9846f3958ed64f0',
      sourcePath: 'backend/src/services/projectDatabase.js',
      sourceBlob: '8147dbe9fa218552d4d1164252e8918a1480e51e',
    }),
  ]),
  from: Object.freeze({
    version: FROM_VERSION,
    fingerprint: '912a9d8633ccf9c52de9bcd39d94e15ad2f055a6bfc21496be09aa5f6c21e140',
    counts: Object.freeze({ tables: 54, indexes: 68, triggers: 36, views: 0 }),
  }),
  target: Object.freeze({
    version: VERSION,
    fingerprint: '9507c7c9d50ed8df6bc1d8bbf33cd9a4b941abc49cf3b40885a5091a241b7c45',
    counts: Object.freeze({ tables: 56, indexes: 72, triggers: 36, views: 0 }),
  }),
  releasedFreshSibling: Object.freeze({
    version: VERSION,
    fingerprint: 'cafa68be976c92bb89958b6832e46062d0009c0e4b9a05403660279a6ee6bd85',
  }),
  receiptExtensionFingerprint: '20d4eef57234d90639c0b3083193b7d333171ac9c65a04f6e1d356f34418d4b8',
  downstream: Object.freeze({
    version: 28,
    fingerprint: '51f63a4ab1cdb07945e2b6975d78f7a718a4004dc1bf17ad03f7e82060e673b9',
  }),
});

// This contract is reconstructed only from the released v2.5.6/v2.5.7
// schema-22 source and the released v2.5.8 schema-23 source. Earlier and later
// legacy versions remain explicitly outside this executable migration.
const imperativeContract = Object.freeze({
  format: 't8-project-database-migration-23-imperative-v2',
  lineage: lineageContract,
  phases: Object.freeze([
    Object.freeze({
      id: 'locked-schema22-gate',
      algorithmVersion: 'released-full-fingerprint-data-version-v2',
      invariants: Object.freeze([
        'acquire-immediate-before-ddl',
        'disk-database-requires-a-verified-noncolliding-schema22-backup',
        'backup-data-version-must-match-under-lock',
        'released-schema22-full-fingerprint-must-remain-exact',
      ]),
    }),
    Object.freeze({
      id: 'canvas-scope-schema',
      algorithmVersion: 'released-v2.5.8-ddl-v1',
      invariants: Object.freeze([
        'append-canvas-id-to-invites-members-and-sessions',
        'create-resource-grant-state-and-resource-grants',
        'create-the-four-released-scope-indexes',
      ]),
    }),
    Object.freeze({
      id: 'single-canvas-scope-backfill',
      algorithmVersion: 'released-single-canvas-min-count-v1',
      invariants: Object.freeze([
        'invite-and-member-scope-is-inferred-only-for-exactly-one-project-canvas',
        'session-scope-is-copied-only-from-its-project-bound-member',
      ]),
    }),
    Object.freeze({
      id: 'invalid-scope-credential-revocation',
      algorithmVersion: 'released-invalid-scope-revocation-v1',
      invariants: Object.freeze([
        'invalid-or-unresolved-invites-and-sessions-are-revoked',
        'preexisting-revocation-timestamps-are-preserved',
      ]),
    }),
    Object.freeze({
      id: 'run-intent-scope-stale-audit',
      algorithmVersion: 'released-requester-canvas-scope-v1',
      invariants: Object.freeze([
        'pending-or-accepted-unbound-intents-become-stale',
        'each-transition-appends-the-released-bounded-audit-payload',
      ]),
    }),
    Object.freeze({
      id: 'untrusted-resource-state-and-final-credential-revocation',
      algorithmVersion: 'released-resource-state-zero-v1',
      invariants: Object.freeze([
        'legacy-resource-state-is-initialized-untrusted',
        'no-resource-grants-are-inferred-from-legacy-canvas-content',
        'all-active-invites-and-sessions-over-untrusted-state-are-revoked',
      ]),
    }),
    Object.freeze({
      id: 'post-migration-integrity',
      algorithmVersion: 'historical-receipt-fk-quick-v1',
      invariants: Object.freeze([
        'schema23-base-fingerprint-matches-the-released-upgrade-lineage',
        'foreign-key-check-is-empty-and-quick-check-is-ok',
      ]),
    }),
    Object.freeze({
      id: 'lineage-receipt-commit',
      algorithmVersion: 'separate-historical-receipt-v2',
      invariants: Object.freeze([
        'version-ledger-and-checksummed-historical-receipt-commit-together',
        'present-receipt-owned-name-type-and-schema23-to-schema28-lineage-are-fail-closed',
        'down-is-backup-only-because-revocation-and-stale-transitions-are-lossy',
      ]),
    }),
  ]),
});

const UP_SQL = String.raw`
ALTER TABLE collaboration_invites ADD COLUMN canvas_id TEXT;
ALTER TABLE collaboration_members ADD COLUMN canvas_id TEXT;
ALTER TABLE collaboration_sessions ADD COLUMN canvas_id TEXT;

CREATE TABLE canvas_resource_grant_state (
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  trusted_revision INTEGER NOT NULL,
  initialized_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, canvas_id)
);

CREATE TABLE canvas_resource_grants (
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(project_id, canvas_id, resource_type, resource_id, resource_version, source)
);

CREATE INDEX idx_canvas_resource_grants_scope
  ON canvas_resource_grants(project_id, canvas_id, resource_type, resource_id, resource_version);
CREATE INDEX idx_collaboration_invites_scope
  ON collaboration_invites(project_id, canvas_id, created_at DESC);
CREATE INDEX idx_collaboration_members_scope
  ON collaboration_members(project_id, canvas_id, created_at ASC);
CREATE INDEX idx_collaboration_sessions_scope
  ON collaboration_sessions(project_id, canvas_id, created_at DESC);

CREATE TABLE schema_historical_migration_receipts (
  version INTEGER PRIMARY KEY CHECK(version BETWEEN 1 AND 28),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  checksum TEXT NOT NULL
    CHECK(length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  from_fingerprint TEXT NOT NULL
    CHECK(length(from_fingerprint) = 64 AND from_fingerprint NOT GLOB '*[^0-9a-f]*'),
  to_fingerprint TEXT NOT NULL
    CHECK(length(to_fingerprint) = 64 AND to_fingerprint NOT GLOB '*[^0-9a-f]*'),
  down_policy TEXT NOT NULL CHECK(length(down_policy) BETWEEN 1 AND 80),
  applied_at INTEGER NOT NULL CHECK(applied_at >= 1),
  FOREIGN KEY(version) REFERENCES schema_migrations(version) ON DELETE RESTRICT
) WITHOUT ROWID;
`;

// The released migration revokes credentials and stales unverifiable intents.
// There is no truthful in-place inverse; restore the verified v22 backup.
const DOWN_SQL = '';

const ownedObjects = Object.freeze({
  tables: Object.freeze(['schema_historical_migration_receipts']),
  indexes: Object.freeze([]),
  views: Object.freeze([]),
  triggers: Object.freeze([]),
});

const ownedObjectNames = Object.freeze([
  ...ownedObjects.tables,
  ...ownedObjects.indexes,
  ...ownedObjects.views,
  ...ownedObjects.triggers,
]);

function normalizeSql(sql) {
  return String(sql).replace(/\r\n?/g, '\n').trim();
}

const canonicalChecksumInput = JSON.stringify({
  format: CHECKSUM_CANONICALIZATION,
  version: VERSION,
  fromVersion: FROM_VERSION,
  name: NAME,
  downPolicy: DOWN_POLICY,
  UP_SQL: normalizeSql(UP_SQL),
  DOWN_SQL: normalizeSql(DOWN_SQL),
  ownedObjectNames,
  imperativeContract,
});

const checksum = createHash('sha256')
  .update(canonicalChecksumInput, 'utf8')
  .digest('hex');

const definition = Object.freeze({
  version: VERSION,
  fromVersion: FROM_VERSION,
  name: NAME,
  downPolicy: DOWN_POLICY,
  checksumAlgorithm: 'sha256',
  checksumCanonicalization: CHECKSUM_CANONICALIZATION,
  checksum,
  UP_SQL,
  DOWN_SQL,
  ownedObjects,
  ownedObjectNames,
  imperativeContract,
});

module.exports = Object.freeze({
  PROJECT_DATABASE_MIGRATION_23: definition,
  PROJECT_DATABASE_MIGRATION_23_UP_SQL: UP_SQL,
  PROJECT_DATABASE_MIGRATION_23_DOWN_SQL: DOWN_SQL,
  PROJECT_DATABASE_MIGRATION_23_IMPERATIVE_CONTRACT: imperativeContract,
  PROJECT_DATABASE_MIGRATION_23_LINEAGE_CONTRACT: lineageContract,
  PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES: ownedObjectNames,
});
