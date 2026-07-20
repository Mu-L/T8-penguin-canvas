'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const Module = require('node:module');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const sessionRoot = 'C:\\Users\\Administrator\\.codex\\sessions\\2026\\07\\17';
const targetFile = 'E:\\PenguinPravite\\T8-penguin-canvas-release-2.5.7\\backend\\src\\services\\projectDatabase.js';
const cutoffArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const cutoff = Date.parse(cutoffArgument || '2026-07-17T22:14:39.928Z');

function parseHunks(diff) {
  const lines = String(diff).replace(/\r\n?/g, '\n').split('\n');
  const hunks = [];
  let current = null;
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      current = {
        oldStart: Number(match[1]),
        newStart: Number(match[3]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current && /^[ +\-]/.test(line)) current.lines.push(line);
  }
  return hunks;
}

function arraysEqualAt(lines, expected, index) {
  if (index < 0 || index + expected.length > lines.length) return false;
  for (let offset = 0; offset < expected.length; offset += 1) {
    if (lines[index + offset] !== expected[offset]) return false;
  }
  return true;
}

function locate(lines, expected, hint) {
  if (arraysEqualAt(lines, expected, hint)) return hint;
  const maxDistance = Math.max(lines.length, hint);
  for (let distance = 1; distance <= maxDistance; distance += 1) {
    if (arraysEqualAt(lines, expected, hint - distance)) return hint - distance;
    if (arraysEqualAt(lines, expected, hint + distance)) return hint + distance;
  }
  return -1;
}

function applyUnifiedDiff(source, diff) {
  const hadTrailingNewline = source.endsWith('\n');
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (hadTrailingNewline) lines.pop();
  let delta = 0;
  let appliedHunks = 0;
  let skippedHunks = 0;
  for (const hunk of parseHunks(diff)) {
    const oldLines = hunk.lines.filter((line) => line[0] !== '+').map((line) => line.slice(1));
    const newLines = hunk.lines.filter((line) => line[0] !== '-').map((line) => line.slice(1));
    const hint = Math.max(0, hunk.oldStart - 1 + delta);
    const index = locate(lines, oldLines, hint);
    if (index < 0) {
      skippedHunks += 1;
      continue;
    }
    lines.splice(index, oldLines.length, ...newLines);
    delta += newLines.length - oldLines.length;
    appliedHunks += 1;
  }
  return {
    source: `${lines.join('\n')}${hadTrailingNewline ? '\n' : ''}`,
    appliedHunks,
    skippedHunks,
  };
}

const base = childProcess.execFileSync(
  'git',
  [
    '-c',
    'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7',
    'show',
    '9b6f6a43bc407a3c47a32dd9c0536afa879f256b:backend/src/services/projectDatabase.js',
  ],
  { cwd: root, encoding: 'utf8', windowsHide: true },
);
const events = [];
for (const name of fs.readdirSync(sessionRoot)) {
  if (!name.endsWith('.jsonl')) continue;
  const filename = path.join(sessionRoot, name);
  const content = fs.readFileSync(filename, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.includes('patch_apply_end') || !rawLine.includes('projectDatabase.js')) continue;
    let entry;
    try { entry = JSON.parse(rawLine); } catch (_) { continue; }
    if (entry.type !== 'event_msg' || entry.payload?.type !== 'patch_apply_end'
      || entry.payload?.success !== true) continue;
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp) || timestamp > cutoff) continue;
    const changes = entry.payload?.changes || {};
    const key = Object.keys(changes).find((candidate) => (
      candidate.toLowerCase() === targetFile.toLowerCase()
    ));
    if (!key || !changes[key]?.unified_diff) continue;
    events.push({
      timestamp,
      timestampText: entry.timestamp,
      callId: String(entry.payload.call_id || ''),
      session: name,
      diff: changes[key].unified_diff,
    });
  }
}
events.sort((left, right) => left.timestamp - right.timestamp
  || left.session.localeCompare(right.session));

let source = base;
const seen = new Set();
const seenDiffs = new Set();
const failures = [];
const partials = [];
const applied = [];
for (const event of events) {
  const identity = event.callId || `${event.timestampText}\0${event.diff}`;
  if (seen.has(identity)) continue;
  seen.add(identity);
  const diffIdentity = crypto.createHash('sha256').update(event.diff).digest('hex');
  if (seenDiffs.has(diffIdentity)) continue;
  seenDiffs.add(diffIdentity);
  const result = applyUnifiedDiff(source, event.diff);
  if (result.appliedHunks === 0) {
    failures.push(event);
    continue;
  }
  source = result.source;
  if (result.skippedHunks > 0) partials.push({ event, ...result });
  applied.push(event);
}

// The historical agent sessions include two overlapping F6 method-body
// patches that are irrelevant to schema construction. Keep the replay probe
// parseable without changing any migration DDL.
source = source.replace(
  /      const references = this\._insertReviewReferences\(\n        comment,\n        thread,\n        options\.mentions,\n        options\.attachments,\n        comment\.createdAt,\n      \);\n/,
  '',
);
const actorDeclaration = "      const actorId = String(options.actorId || input.createdBy || 'local-owner');\n";
const reviewCommentReferenceStart = source.indexOf(
  'const references = this._insertReviewReferences(\n        comment,\n        thread,\n        input.mentions',
);
const firstActorDeclaration = source.indexOf(actorDeclaration, reviewCommentReferenceStart);
if (firstActorDeclaration >= 0) {
  const secondActorDeclaration = source.indexOf(actorDeclaration, firstActorDeclaration + actorDeclaration.length);
  if (secondActorDeclaration >= 0 && secondActorDeclaration - firstActorDeclaration < 4_000) {
    source = `${source.slice(0, secondActorDeclaration)}${source.slice(secondActorDeclaration + actorDeclaration.length)}`;
  }
}
const sourceOperationDeclaration = '      const sourceOperationId = String(options.sourceOperationId || comment.entityUid);\n';
const firstSourceOperationDeclaration = source.indexOf(
  sourceOperationDeclaration,
  reviewCommentReferenceStart,
);
if (firstSourceOperationDeclaration >= 0) {
  const secondSourceOperationDeclaration = source.indexOf(
    sourceOperationDeclaration,
    firstSourceOperationDeclaration + sourceOperationDeclaration.length,
  );
  if (secondSourceOperationDeclaration >= 0
    && secondSourceOperationDeclaration - firstSourceOperationDeclaration < 4_000) {
    source = `${source.slice(0, secondSourceOperationDeclaration)}${source.slice(
      secondSourceOperationDeclaration + sourceOperationDeclaration.length,
    )}`;
  }
}
const mentionRecipientsMarker = '      const mentionRecipientIds = [\n';
const firstMentionRecipients = source.indexOf(mentionRecipientsMarker, reviewCommentReferenceStart);
if (firstMentionRecipients >= 0) {
  const secondMentionRecipients = source.indexOf(
    mentionRecipientsMarker,
    firstMentionRecipients + mentionRecipientsMarker.length,
  );
  if (secondMentionRecipients >= 0 && secondMentionRecipients - firstMentionRecipients < 5_000) {
    const secondNotificationStart = source.indexOf(
      '      const notifications = this._createReviewOperationNotifications({\n',
      secondMentionRecipients,
    );
    const secondNotificationEnd = source.indexOf('      });\n', secondNotificationStart);
    if (secondNotificationStart >= 0 && secondNotificationEnd >= 0
      && secondNotificationEnd - secondMentionRecipients < 3_000) {
      source = `${source.slice(0, secondMentionRecipients)}${source.slice(
        secondNotificationEnd + '      });\n'.length,
      )}`;
    }
  }
}
if (!/class OperationBatchConflictError\b/.test(source)) {
  source = source.replace(
    "const PROJECT_DATABASE_SCHEMA_VERSION = 28;\n",
    "class OperationBatchConflictError extends Error {}\n\nconst PROJECT_DATABASE_SCHEMA_VERSION = 28;\n",
  );
}

// One historical apply_patch call updated projectDatabase.js five times. The
// session's patch_apply_end event retained only its final hunk, so replay the
// schema-bearing hunk explicitly for this TEMP-only lineage reconstruction.
if (!source.includes('CREATE TABLE IF NOT EXISTS canvas_operation_batches (')) {
  source = source.replace(
    '      CREATE TABLE IF NOT EXISTS audit_events (',
    `      CREATE TABLE IF NOT EXISTS canvas_operation_batches (
        request_digest TEXT PRIMARY KEY
          CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
        project_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        base_revision INTEGER CHECK(base_revision IS NULL OR base_revision >= 0),
        actor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp_identity INTEGER NOT NULL CHECK(timestamp_identity IN (0, 1)),
        operation_count INTEGER NOT NULL CHECK(operation_count BETWEEN 1 AND 500),
        operation_ids_json TEXT NOT NULL,
        first_revision INTEGER NOT NULL CHECK(first_revision >= 1),
        last_revision INTEGER NOT NULL CHECK(last_revision >= first_revision),
        created_at INTEGER NOT NULL,
        CHECK(last_revision = first_revision + operation_count - 1),
        FOREIGN KEY(canvas_id) REFERENCES canvas_documents(canvas_id) ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_canvas_operation_batches_canvas_revision
        ON canvas_operation_batches(project_id, canvas_id, last_revision DESC);
      CREATE TRIGGER IF NOT EXISTS trg_canvas_operation_batches_project_insert
      BEFORE INSERT ON canvas_operation_batches BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM canvas_documents d
          WHERE d.canvas_id = NEW.canvas_id AND d.project_id = NEW.project_id
        ) THEN RAISE(ABORT, 'canvas_operation_batches project mismatch') END;
      END;

      CREATE TABLE IF NOT EXISTS audit_events (`,
  );
}

const version = /const PROJECT_DATABASE_SCHEMA_VERSION = (\d+);/.exec(source)?.[1] || null;
process.stdout.write(`${JSON.stringify({
  cutoff: new Date(cutoff).toISOString(),
  candidates: events.length,
  deduped: seen.size,
  applied: applied.length,
  failures: failures.length,
  partials: partials.length,
  version,
  firstFailure: failures.slice(0, 20).map(({ timestampText, callId, session }) => ({
    timestampText,
    callId,
    session,
  })),
}, null, 2)}\n`);

if (process.argv.includes('--print-source')) process.stdout.write(source);
if (process.argv.includes('--print-reference-snippets')) {
  const sourceLines = source.split('\n');
  sourceLines.forEach((line, index) => {
    if (!line.includes('const references = this._insertReviewReferences')) return;
    process.stdout.write(`--- source line ${index + 1} ---\n`);
    process.stdout.write(`${sourceLines.slice(Math.max(0, index - 15), index + 22).join('\n')}\n`);
  });
}

async function closeDatabase(database) {
  const result = database?.close();
  if (result && typeof result.then === 'function') await result;
}

function compileProjectDatabase(sourceText, suffix) {
  const filename = path.join(root, 'backend', 'src', 'services', 'projectDatabase.js');
  const loaded = new Module(`${filename}#${suffix}`, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(sourceText, filename);
  return loaded.exports;
}

async function probe() {
  const BetterSqlite3 = require('better-sqlite3');
  const { inspectProjectDatabaseSchemaManifest } = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');
  const { PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES } = require('../backend/src/services/projectDatabaseMigration23');
  const { PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES } = require('../backend/src/services/projectDatabaseMigration29');
  const { PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES } = require('../backend/src/services/projectDatabaseMigration30');
  const { PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES } = require('../backend/src/services/projectDatabaseMigration31');
  const {
    PROJECT_DATABASE_MIGRATION_32_UP_SQL,
    PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES,
  } = require('../backend/src/services/projectDatabaseMigration32');
  const historicalSource = childProcess.execFileSync(
    'git',
    [
      '-c',
      'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7',
      'show',
      'v2.5.8:backend/src/services/projectDatabase.js',
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  const historical = compileProjectDatabase(historicalSource, 'v2.5.8');
  const replay = compileProjectDatabase(source, 'replayed-schema28');
  const current = require('../backend/src/services/projectDatabase');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema-lineage-replay-'));
  const filename = path.join(directory, 'project.sqlite3');
  let database = null;
  try {
    database = new historical.ProjectDatabase(filename, { autoBackup: false });
    await closeDatabase(database);
    database = null;
    database = new replay.ProjectDatabase(filename, { autoBackup: false });
    await closeDatabase(database);
    database = null;
    let raw = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
    try {
      const schema28 = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 28,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      const replayNames = raw.prepare(`
        SELECT name FROM sqlite_master
        WHERE type IN ('table', 'index', 'trigger', 'view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map((row) => String(row.name));
      const comparisonFilename = path.join(directory, 'current.sqlite3');
      const comparison = new current.ProjectDatabase(comparisonFilename, { autoBackup: false });
      await closeDatabase(comparison);
      const comparisonRaw = new BetterSqlite3(comparisonFilename, { readonly: true, fileMustExist: true });
      let expectedNames;
      try {
        const excluded = new Set([
          ...PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
          ...PROJECT_DATABASE_SCHEMA_29_OWNED_OBJECT_NAMES,
          ...PROJECT_DATABASE_SCHEMA_30_OWNED_OBJECT_NAMES,
          ...PROJECT_DATABASE_SCHEMA_31_OWNED_OBJECT_NAMES,
        ]);
        expectedNames = comparisonRaw.prepare(`
          SELECT name FROM sqlite_master
          WHERE type IN ('table', 'index', 'trigger', 'view')
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `).all().map((row) => String(row.name)).filter((name) => !excluded.has(name));
      } finally {
        comparisonRaw.close();
      }
      const replayNameSet = new Set(replayNames);
      const expectedNameSet = new Set(expectedNames);
      process.stdout.write(`${JSON.stringify({
        replayVersion: replay.PROJECT_DATABASE_SCHEMA_VERSION,
        schema28Fingerprint: schema28.fingerprint,
        schema28Counts: schema28.counts,
        missingNames: expectedNames.filter((name) => !replayNameSet.has(name)),
        extraNames: replayNames.filter((name) => !expectedNameSet.has(name)
          && !PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES.includes(name)),
      }, null, 2)}\n`);
    } finally {
      raw.close();
    }
    database = new current.ProjectDatabase(filename, { autoBackup: false });
    await closeDatabase(database);
    database = null;
    raw = new BetterSqlite3(filename);
    try {
      const sourceManifest = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 31,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      raw.exec(PROJECT_DATABASE_MIGRATION_32_UP_SQL);
      const targetManifest = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 32,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      const extensionManifest = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 32,
        includedObjectNames: PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES,
      });
      process.stdout.write(`${JSON.stringify({
        sourceFingerprint: sourceManifest.fingerprint,
        targetFingerprint: targetManifest.fingerprint,
        extensionFingerprint: extensionManifest.fingerprint,
      }, null, 2)}\n`);
    } finally {
      raw.close();
    }
  } finally {
    await closeDatabase(database);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv.includes('--probe')) {
  probe().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
