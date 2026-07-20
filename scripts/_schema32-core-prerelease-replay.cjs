'use strict';

// Reconstruct the core schema-11 -> schema-22 prerelease source history from
// Git plus Codex source-patch events, then replay it only into a TEMP database.
// No retained database is opened or copied.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const archive = 'C:\\Users\\Administrator\\.codex\\archived_sessions';
const coreFile = 'E:\\PenguinPravite\\T8-penguin-canvas\\backend\\src\\services\\projectDatabase.js';
const firstSchema12Patch = '4d9544e948a263aeb13e5e983d45715a179eae5f308344a96b38540e9eec3d60';
const firstSchema15Patch = '6d01ef934b929429a8d780aa35dbb6d0eae042354855c1d4095bc304f9090ca1';
const firstSchema4Patch = '5d3cae9bea642a4432e60ac5d06244298cefdfd0056d613bb68321bd7b3bcc2f';
const schema3VersionPatch = 'dc8576976d9a6da8d427fea013352b4f3f98e0511740db472c8aea66240e2a05';
const migrationPattern = /PROJECT_DATABASE_SCHEMA_VERSION|ensureColumn|ALTER TABLE|CREATE TABLE|CREATE (?:UNIQUE )?INDEX|CREATE TRIGGER|beforeMigrationCommit/i;

function parseHunks(diff) {
  const lines = String(diff).replace(/\r\n?/g, '\n').split('\n');
  const hunks = [];
  let current = null;
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match || line.startsWith('@@')) {
      current = {
        oldStart: match ? Number(match[1]) : 1,
        newStart: match ? Number(match[3]) : 1,
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
  return expected.every((line, offset) => lines[index + offset] === line);
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

function applyUnifiedDiff(source, diff, reverse = false) {
  const hadTrailingNewline = source.endsWith('\n');
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  if (hadTrailingNewline) lines.pop();
  let delta = 0;
  let appliedHunks = 0;
  let skippedHunks = 0;
  for (const hunk of parseHunks(diff)) {
    const oldLines = hunk.lines.filter((line) => line[0] !== '+').map((line) => line.slice(1));
    const newLines = hunk.lines.filter((line) => line[0] !== '-').map((line) => line.slice(1));
    const expected = reverse ? newLines : oldLines;
    const replacement = reverse ? oldLines : newLines;
    const sourceStart = reverse ? hunk.newStart : hunk.oldStart;
    const hint = Math.max(0, sourceStart - 1 + delta);
    const index = locate(lines, expected, hint);
    if (index < 0) {
      skippedHunks += 1;
      continue;
    }
    lines.splice(index, expected.length, ...replacement);
    delta += replacement.length - expected.length;
    appliedHunks += 1;
  }
  return {
    source: `${lines.join('\n')}${hadTrailingNewline ? '\n' : ''}`,
    appliedHunks,
    skippedHunks,
  };
}

function collectEvents() {
  const output = childProcess.execFileSync('rg', [
    '--json',
    '-g', 'rollout-2026-07-0[4-9]*.jsonl',
    '-g', 'rollout-2026-07-1[0-6]*.jsonl',
    'patch_apply_end.*projectDatabase\\.js',
    archive,
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const byDiff = new Map();
  for (const line of output.split(/\r?\n/)) {
    let rgEvent;
    try { rgEvent = JSON.parse(line); } catch (_) { continue; }
    if (rgEvent.type !== 'match') continue;
    let event;
    try { event = JSON.parse(rgEvent.data?.lines?.text); } catch (_) { continue; }
    if (event.type !== 'event_msg'
      || event.payload?.type !== 'patch_apply_end'
      || event.payload?.success !== true) continue;
    for (const [filename, change] of Object.entries(event.payload?.changes || {})) {
      if (filename.toLowerCase() !== coreFile.toLowerCase()) continue;
      const diff = String(change?.unified_diff || '');
      if (!diff) continue;
      const sha256 = crypto.createHash('sha256').update(diff).digest('hex');
      const candidate = {
        timestamp: String(event.timestamp),
        callId: String(event.payload?.call_id || ''),
        sha256,
        diff,
        migrationBearing: migrationPattern.test(diff),
      };
      const previous = byDiff.get(sha256);
      if (!previous || candidate.timestamp < previous.timestamp) byDiff.set(sha256, candidate);
    }
  }
  const embeddedOutput = childProcess.execFileSync('rg', [
    '--json',
    '-g', 'rollout-2026-07-0[4-9]*.jsonl',
    '-g', 'rollout-2026-07-1[0-6]*.jsonl',
    'projectDatabase\\.js',
    archive,
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  for (const line of embeddedOutput.split(/\r?\n/)) {
    let rgEvent;
    try { rgEvent = JSON.parse(line); } catch (_) { continue; }
    if (rgEvent.type !== 'match') continue;
    let event;
    try { event = JSON.parse(rgEvent.data?.lines?.text); } catch (_) { continue; }
    if (event.type !== 'response_item' || event.payload?.type !== 'custom_tool_call') continue;
    const input = String(event.payload?.input || '');
    const stringLiterals = input.match(/"(?:\\.|[^"\\])*"/gs) || [];
    for (const literal of stringLiterals) {
      let patch;
      try { patch = JSON.parse(literal); } catch (_) { continue; }
      if (!patch.includes('*** Begin Patch') || !/projectDatabase\.js/i.test(patch)) continue;
      const selected = [];
      let active = false;
      for (const patchLine of patch.replace(/\r\n?/g, '\n').split('\n')) {
        const fileMarker = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(patchLine);
        if (fileMarker) {
          const normalized = fileMarker[1].replace(/\\/g, '/').toLowerCase();
          active = normalized === coreFile.replace(/\\/g, '/').toLowerCase();
          if (active) selected.push(patchLine);
          continue;
        }
        if (/^\*\*\* (?:Add|Update|Delete) File:/.test(patchLine)) {
          active = false;
          continue;
        }
        if (active && patchLine !== '*** End Patch') selected.push(patchLine);
      }
      if (!selected.length) continue;
      const diff = `${selected.join('\n')}\n`;
      const isMissingVersionBridge = (
        diff.includes('-const PROJECT_DATABASE_SCHEMA_VERSION = 10;')
          && diff.includes('+const PROJECT_DATABASE_SCHEMA_VERSION = 11;')
      ) || (
        diff.includes('-const PROJECT_DATABASE_SCHEMA_VERSION = 13;')
          && diff.includes('+const PROJECT_DATABASE_SCHEMA_VERSION = 14;')
      );
      if (!isMissingVersionBridge) continue;
      const sha256 = crypto.createHash('sha256').update(diff).digest('hex');
      const key = `embedded:${event.timestamp}:${sha256}`;
      byDiff.set(key, {
        timestamp: String(event.timestamp),
        callId: String(event.payload?.call_id || ''),
        sha256,
        diff,
        migrationBearing: migrationPattern.test(diff),
        embedded: true,
      });
    }
  }
  return [...byDiff.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp)
    || Number(Boolean(left.embedded)) - Number(Boolean(right.embedded))
    || left.sha256.localeCompare(right.sha256));
}

function schemaVersion(source) {
  return Number(/const PROJECT_DATABASE_SCHEMA_VERSION = (\d+);/.exec(source)?.[1] || 0);
}

function compileProjectDatabase(source, suffix) {
  const filename = path.join(root, 'backend', 'src', 'services', 'projectDatabase.js');
  const loaded = new Module(`${filename}#${suffix}`, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  if (process.env.T8_NATIVE_MODULE_ROOT) {
    loaded.paths.unshift(path.join(process.env.T8_NATIVE_MODULE_ROOT, 'node_modules'));
  }
  const migrationEndMarker = '\n    migrateTransaction();\n  }\n';
  const migrationEnd = source.indexOf(migrationEndMarker);
  const migrationOnlySource = migrationEnd >= 0
    ? `${source.slice(0, migrationEnd + migrationEndMarker.length)}\n}\nmodule.exports = { ProjectDatabase, PROJECT_DATABASE_SCHEMA_VERSION };\n`
    : source;
  const guardedSource = process.env.T8_EXACT_ENSURE_COLUMN === '1'
    ? migrationOnlySource
    : migrationOnlySource.replace(
      '        if (!columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);',
      '        if (columns.size > 0 && !columns.has(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);',
    );
  const replaySource = guardedSource.replace(
    '    this.lastInterruptedRecovery = this.recoverInterruptedRuns();',
    "    this.lastInterruptedRecovery = typeof this.recoverInterruptedRuns === 'function' ? this.recoverInterruptedRuns() : null;",
  );
  loaded._compile(replaySource, filename);
  return loaded.exports;
}

async function closeDatabase(database) {
  if (typeof database?.close !== 'function') {
    if (database?.db?.open) database.db.close();
    return;
  }
  const result = database?.close();
  if (result && typeof result.then === 'function') await result;
}

async function openWithSource(source, filename, suffix) {
  const implementation = compileProjectDatabase(source, suffix);
  const database = new implementation.ProjectDatabase(filename, { autoBackup: false });
  await closeDatabase(database);
  return implementation.PROJECT_DATABASE_SCHEMA_VERSION;
}

function replaceRequired(source, needle, replacement, label) {
  if (!source.includes(needle)) throw new Error(`missing source marker for ${label}`);
  return source.replace(needle, replacement);
}

function applyExactMissingVersionBridge(source, event) {
  if (event.diff.includes('-const PROJECT_DATABASE_SCHEMA_VERSION = 10;')) {
    let next = replaceRequired(
      source,
      'const PROJECT_DATABASE_SCHEMA_VERSION = 10;',
      'const PROJECT_DATABASE_SCHEMA_VERSION = 11;',
      'schema10-to-11 version',
    );
    const marker = `      CREATE INDEX IF NOT EXISTS idx_subflow_definitions_project_created
        ON subflow_definitions(project_id, created_at DESC);`;
    const addition = `${marker}

      CREATE TABLE IF NOT EXISTS subflow_definition_heads (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        latest_version INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_subflow_definition_heads_updated
        ON subflow_definition_heads(project_id, updated_at DESC);`;
    next = replaceRequired(next, marker, addition, 'schema11 subflow heads');
    return next;
  }
  if (event.diff.includes('-const PROJECT_DATABASE_SCHEMA_VERSION = 13;')) {
    let next = replaceRequired(
      source,
      'const PROJECT_DATABASE_SCHEMA_VERSION = 13;',
      'const PROJECT_DATABASE_SCHEMA_VERSION = 14;',
      'schema13-to-14 version',
    );
    const assetColumns = `        managed_path TEXT,
        source_url TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',`;
    next = replaceRequired(next, assetColumns, `        managed_path TEXT,
        source_url TEXT,
        storage_mode TEXT NOT NULL DEFAULT 'linked',
        availability TEXT NOT NULL DEFAULT 'available',
        metadata_json TEXT NOT NULL DEFAULT '{}',`, 'schema14 asset base columns');
    const lineageMarker = '      CREATE INDEX IF NOT EXISTS idx_asset_lineage_parent ON asset_lineage(parent_asset_id, created_at DESC);';
    next = replaceRequired(next, lineageMarker, `${lineageMarker}

      CREATE TABLE IF NOT EXISTS asset_lineage_events (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        parent_asset_id TEXT,
        source_type TEXT NOT NULL,
        source_node_id TEXT,
        source_node_type TEXT,
        run_id TEXT,
        node_run_id TEXT,
        attempt_id TEXT,
        canvas_id TEXT,
        creator_id TEXT NOT NULL,
        prompt_summary TEXT,
        prompt_digest TEXT,
        derived_operation TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_asset_id) REFERENCES assets(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_asset_lineage_events_asset ON asset_lineage_events(asset_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_asset_lineage_events_parent ON asset_lineage_events(parent_asset_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_asset_lineage_events_run ON asset_lineage_events(run_id, node_run_id, attempt_id);`, 'schema14 lineage events');
    const ensureMarker = "      ensureColumn('assets', 'perceptual_hash', 'perceptual_hash TEXT');";
    next = replaceRequired(next, ensureMarker, `${ensureMarker}
      ensureColumn('assets', 'storage_mode', "storage_mode TEXT NOT NULL DEFAULT 'linked'");
      ensureColumn('assets', 'availability', "availability TEXT NOT NULL DEFAULT 'available'");`, 'schema14 asset ensure columns');
    const indexMarker = '        CREATE INDEX IF NOT EXISTS idx_assets_perceptual_hash ON assets(project_id, kind, perceptual_hash);';
    next = replaceRequired(next, indexMarker, `${indexMarker}
        CREATE INDEX IF NOT EXISTS idx_assets_storage_state ON assets(project_id, storage_mode, availability, created_at DESC);`, 'schema14 storage index');
    return next;
  }
  throw new Error(`unexpected embedded source bridge ${event.sha256}`);
}

function reconstructPreSchema3Source() {
  const sourceOutput = process.env.T8_PRE_SCHEMA3_SOURCE_OUTPUT;
  if (!sourceOutput) throw new Error('T8_PRE_SCHEMA3_SOURCE_OUTPUT is required');
  const numbered = new Map();
  for (const line of fs.readFileSync(sourceOutput, 'utf8').replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^(\d+):(.*)$/.exec(line);
    if (match) numbered.set(Number(match[1]), match[2]);
  }
  const prefix = [];
  for (let line = 1; line <= 280; line += 1) {
    if (!numbered.has(line)) throw new Error(`pre-schema3 source line ${line} missing`);
    prefix.push(numbered.get(line));
  }
  return `${prefix.join('\n')}\n}\nmodule.exports = { ProjectDatabase };\n`;
}

function reconstructSchema1Source(schema2Source) {
  let source = replaceRequired(
    schema2Source,
    '        parent_id TEXT,\n',
    '',
    'schema1 review_comments parent_id base column',
  );
  source = replaceRequired(
    source,
    "    const reviewCommentColumns = new Set(this.db.pragma('table_info(review_comments)').map((column) => column.name));\n",
    '',
    'schema1 review_comments column inspection',
  );
  source = replaceRequired(
    source,
    "    if (!reviewCommentColumns.has('parent_id')) this.db.exec('ALTER TABLE review_comments ADD COLUMN parent_id TEXT');\n",
    '',
    'schema1 review_comments parent_id migration',
  );
  source = replaceRequired(
    source,
    "    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, Date.now());\n",
    '',
    'schema1 migration ledger version 2',
  );
  return source;
}

async function runActualCoreTimeline(events) {
  const schema10Opens = [
    { at: '2026-07-14T06:31:19.180Z', expectedVersion: 10, stage: 'actual-schema10-open-0631' },
    { at: '2026-07-14T06:52:22.555Z', expectedVersion: 10, stage: 'actual-schema10-open-0652' },
    { at: '2026-07-14T07:57:35.695Z', expectedVersion: 10, stage: 'actual-schema10-open-0757' },
  ];
  const schema19Open = { at: '2026-07-15T20:53:47.509Z', expectedVersion: 19, stage: 'actual-schema19-open' };
  const schema22Open = { at: '2026-07-16T08:20:08.461Z', expectedVersion: 22, stage: 'actual-schema22-open' };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-core-actual-timeline-'));
  const filename = path.join(directory, 'project.sqlite3');
  const opened = [];
  const sourceEvents = [];
  try {
    let source = reconstructPreSchema3Source();
    if (!process.env.T8_SKIP_SCHEMA1_OPEN) {
      const schema1Source = reconstructSchema1Source(source);
      await openWithSource(schema1Source, filename, 'actual-schema1-open');
      opened.push({ stage: 'actual-schema1-open', version: 1 });
    }
    let schema2OpenSource = source;
    const schema2OpenAt = '2026-07-13T07:31:58.176Z';
    const schema3Index = events.findIndex((event) => event.sha256 === schema3VersionPatch);
    if (schema3Index < 0) throw new Error('schema3 source patch not found');
    const schema2CutoffReverse = [];
    for (let index = schema3Index - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.timestamp <= schema2OpenAt || event.embedded) continue;
      const result = applyUnifiedDiff(schema2OpenSource, event.diff, true);
      if (result.appliedHunks === 0) continue;
      schema2OpenSource = result.source;
      schema2CutoffReverse.push({
        timestamp: event.timestamp,
        sha256: event.sha256.slice(0, 12),
        appliedHunks: result.appliedHunks,
        skippedHunks: result.skippedHunks,
      });
    }
    sourceEvents.push({ stage: 'actual-schema2-open', reverse: schema2CutoffReverse });
    await openWithSource(schema2OpenSource, filename, 'actual-pre-schema3-open');
    opened.push({ stage: 'actual-pre-schema3-open', version: 2 });
    let preSchema10ReplayVersion = 2;
    for (let index = schema3Index; index < events.length; index += 1) {
      const event = events[index];
      if (event.timestamp > schema10Opens[0].at) break;
      if (event.embedded) continue;
      const result = applyUnifiedDiff(source, event.diff, false);
      if (result.appliedHunks === 0) continue;
      source = result.source;
      sourceEvents.push({
        timestamp: event.timestamp,
        sha256: event.sha256.slice(0, 12),
        embedded: Boolean(event.embedded),
        appliedHunks: result.appliedHunks,
        skippedHunks: result.skippedHunks,
        version: schemaVersion(source),
      });
      if (process.env.T8_REPLAY_ALL_PRE_SCHEMA10) {
        const strategy = String(process.env.T8_REPLAY_PRE_SCHEMA10_STRATEGY || 'version-only');
        const version = schemaVersion(source);
        const shouldOpen = strategy === 'every-parseable'
          || (strategy === 'migration-only' && event.migrationBearing)
          || (strategy === 'version-only' && version > preSchema10ReplayVersion);
        if (shouldOpen) {
          try {
            const openedVersion = await openWithSource(
              source,
              filename,
              `actual-pre10-${event.sha256.slice(0, 12)}`,
            );
            opened.push({
              stage: `actual-pre10-${event.sha256.slice(0, 12)}`,
              version: openedVersion,
              at: event.timestamp,
              migrationBearing: event.migrationBearing,
            });
            preSchema10ReplayVersion = Math.max(preSchema10ReplayVersion, openedVersion);
          } catch (error) {
            sourceEvents.push({
              stage: `actual-pre10-${event.sha256.slice(0, 12)}`,
              version,
              compileError: String(error?.message || error).slice(0, 500),
            });
          }
        }
      }
    }
    if (schemaVersion(source) !== schema10Opens[0].expectedVersion) {
      throw new Error(`expected exact schema10 source, got ${schemaVersion(source)}`);
    }
    if (process.env.T8_ACTUAL_SOURCE_DUMP_DIR) {
      fs.writeFileSync(path.join(process.env.T8_ACTUAL_SOURCE_DUMP_DIR, `${schema10Opens[0].stage}.js`), source);
    }
    await openWithSource(source, filename, schema10Opens[0].stage);
    opened.push({ stage: schema10Opens[0].stage, version: 10, at: schema10Opens[0].at });

    for (const open of schema10Opens.slice(1)) {
      let snapshot = reconstructPreSchema3Source();
      for (let index = schema3Index; index < events.length; index += 1) {
        const event = events[index];
        if (event.timestamp > open.at) break;
        if (event.embedded) continue;
        const result = applyUnifiedDiff(snapshot, event.diff, false);
        if (result.appliedHunks > 0) snapshot = result.source;
      }
      if (schemaVersion(snapshot) !== open.expectedVersion) {
        throw new Error(`expected ${open.stage} source version ${open.expectedVersion}, got ${schemaVersion(snapshot)}`);
      }
      if (process.env.T8_ACTUAL_SOURCE_DUMP_DIR) {
        fs.writeFileSync(path.join(process.env.T8_ACTUAL_SOURCE_DUMP_DIR, `${open.stage}.js`), snapshot);
      }
      await openWithSource(snapshot, filename, open.stage);
      opened.push({ stage: open.stage, version: open.expectedVersion, at: open.at });
    }

    if (process.env.T8_REPLAY_ALL_PRERELEASE) {
      const strategy = String(process.env.T8_REPLAY_OPEN_STRATEGY || 'version-only');
      let replayVersion = schemaVersion(source);
      for (const event of events) {
        if (event.timestamp <= schema10Opens[0].at || event.timestamp > schema22Open.at) continue;
        let result;
        if (event.embedded) {
          source = applyExactMissingVersionBridge(source, event);
          result = { appliedHunks: 1, skippedHunks: 0 };
        } else {
          result = applyUnifiedDiff(source, event.diff, false);
          if (result.appliedHunks === 0) continue;
          source = result.source;
        }
        const version = schemaVersion(source);
        const shouldOpen = strategy === 'every-parseable'
          || (strategy === 'migration-only' && event.migrationBearing)
          || (strategy === 'version-only' && version > replayVersion);
        if (!shouldOpen) continue;
        try {
          const openedVersion = await openWithSource(
            source,
            filename,
            `actual-full-${event.sha256.slice(0, 12)}`,
          );
          opened.push({
            stage: `actual-full-${event.sha256.slice(0, 12)}`,
            version: openedVersion,
            at: event.timestamp,
            migrationBearing: event.migrationBearing,
          });
          replayVersion = Math.max(replayVersion, openedVersion);
        } catch (error) {
          sourceEvents.push({
            stage: `actual-full-${event.sha256.slice(0, 12)}`,
            version,
            compileError: String(error?.message || error).slice(0, 500),
          });
        }
      }
      sourceEvents.push({
        stage: 'actual-full-prerelease-replay',
        strategy,
        finalVersion: schemaVersion(source),
      });
    }

    const finalSource = childProcess.execFileSync('git', [
      '-c', 'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7',
      'show',
      'v2.5.6:backend/src/services/projectDatabase.js',
    ], { cwd: root, encoding: 'utf8', windowsHide: true });
    const reconstructSnapshot = (at, expectedVersion, stage) => {
      let snapshot = finalSource;
      const reverse = [];
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.embedded || event.timestamp <= at) continue;
        const result = applyUnifiedDiff(snapshot, event.diff, true);
        if (result.appliedHunks === 0) continue;
        snapshot = result.source;
        reverse.push({
          timestamp: event.timestamp,
          sha256: event.sha256.slice(0, 12),
          appliedHunks: result.appliedHunks,
          skippedHunks: result.skippedHunks,
          version: schemaVersion(snapshot),
        });
      }
      if (schemaVersion(snapshot) !== expectedVersion) {
        throw new Error(`expected ${stage} source version ${expectedVersion}, got ${schemaVersion(snapshot)}; reverse: ${JSON.stringify(reverse.slice(-20))}`);
      }
      sourceEvents.push({ stage, reverse });
      return snapshot;
    };

    const schema19Source = reconstructSnapshot(schema19Open.at, 19, schema19Open.stage);
    if (process.env.T8_ACTUAL_SOURCE_DUMP_DIR) {
      fs.writeFileSync(path.join(process.env.T8_ACTUAL_SOURCE_DUMP_DIR, `${schema19Open.stage}.js`), schema19Source);
    }
    await openWithSource(schema19Source, filename, schema19Open.stage);
    opened.push({ stage: schema19Open.stage, version: 19, at: schema19Open.at });

    const schema22Source = reconstructSnapshot(schema22Open.at, 22, schema22Open.stage);
    if (process.env.T8_ACTUAL_SOURCE_DUMP_DIR) {
      fs.writeFileSync(path.join(process.env.T8_ACTUAL_SOURCE_DUMP_DIR, `${schema22Open.stage}.js`), schema22Source);
    }
    await openWithSource(schema22Source, filename, schema22Open.stage);
    opened.push({ stage: schema22Open.stage, version: 22, at: schema22Open.at });

    if (!process.env.T8_SKIP_SCHEMA23_OPEN) {
      const historical23 = childProcess.execFileSync('git', [
        '-c', 'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7',
        'show',
        'v2.5.8:backend/src/services/projectDatabase.js',
      ], { cwd: root, encoding: 'utf8', windowsHide: true });
      await openWithSource(historical23, filename, 'actual-schema23-open');
      opened.push({ stage: 'actual-schema23-open', version: 23 });
    }

    const current = compileProjectDatabase(
      fs.readFileSync(path.join(root, 'backend', 'src', 'services', 'projectDatabase.js'), 'utf8')
        .replace(
          "      assertProjectDatabaseSchema28(this.db, 'legacy-bridge-result');",
          '      void 0; // source-only probe: commit TEMP legacy bridge',
        ),
      'actual-current-manual-lineage-bridge',
    );
    let migrationError = null;
    let database;
    try {
      database = new current.ProjectDatabase(filename, { autoBackup: false });
      await closeDatabase(database);
      database = null;
    } catch (error) {
      migrationError = {
        name: error?.name,
        code: error?.code,
        message: error?.message,
        details: error?.details,
      };
      if (database) await closeDatabase(database);
      database = null;
    }

    const BetterSqlite3 = process.env.T8_NATIVE_MODULE_ROOT
      ? require(path.join(process.env.T8_NATIVE_MODULE_ROOT, 'node_modules', 'better-sqlite3'))
      : require('better-sqlite3');
    const { inspectProjectDatabaseSchemaManifest } = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');
    const { PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES } = require('../backend/src/services/projectDatabaseMigration23');
    const { PROJECT_DATABASE_MIGRATION_29_UP_SQL } = require('../backend/src/services/projectDatabaseMigration29');
    const { PROJECT_DATABASE_MIGRATION_30_UP_SQL } = require('../backend/src/services/projectDatabaseMigration30');
    const { PROJECT_DATABASE_MIGRATION_31_UP_SQL } = require('../backend/src/services/projectDatabaseMigration31');
    const raw = new BetterSqlite3(filename);
    try {
      const schema28 = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 28,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      raw.exec(PROJECT_DATABASE_MIGRATION_29_UP_SQL);
      raw.exec(PROJECT_DATABASE_MIGRATION_30_UP_SQL);
      raw.exec(PROJECT_DATABASE_MIGRATION_31_UP_SQL);
      const schema31 = inspectProjectDatabaseSchemaManifest(raw, {
        descriptorVersion: 31,
        excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
      });
      const result = {
        strategy: 'actual-core-open-timeline',
        opened,
        sourceEvents,
        migrationError,
        schema28Fingerprint: schema28.fingerprint,
        schema31Fingerprint: schema31.fingerprint,
        schema31Descriptor: schema31.descriptor,
      };
      const descriptorOutput = process.env.T8_SCHEMA_DESCRIPTOR_OUTPUT;
      if (descriptorOutput) {
        fs.writeFileSync(descriptorOutput, `${JSON.stringify(result)}\n`);
        result.schema31Descriptor = { descriptorOutput };
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      raw.close();
    }
  } finally {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'EBUSY') throw error;
    }
  }
}

async function main() {
  const events = collectEvents();
  if (process.argv.includes('--debug-collected-events')) {
    for (const event of events) {
      if (!/PROJECT_DATABASE_SCHEMA_VERSION/.test(event.diff)) continue;
      process.stdout.write(`${JSON.stringify({
        timestamp: event.timestamp,
        sha256: event.sha256,
        embedded: Boolean(event.embedded),
        versionLines: event.diff.split(/\r?\n/).filter((line) => line.includes('PROJECT_DATABASE_SCHEMA_VERSION')),
      })}\n`);
    }
    return;
  }
  if (process.argv.includes('--actual-core-timeline')) {
    await runActualCoreTimeline(events);
    return;
  }
  const requestedStart = process.argv.includes('--start3')
    ? 3
    : process.argv.includes('--start11') ? 11 : 14;
  const firstPatch = requestedStart === 3
    ? firstSchema4Patch
    : requestedStart === 11 ? firstSchema12Patch : firstSchema15Patch;
  const firstPatchIndex = events.findIndex((event) => event.sha256 === firstPatch);
  if (firstPatchIndex < 0) throw new Error(`schema-${requestedStart + 1} source patch not found`);
  const finalSource = childProcess.execFileSync('git', [
    '-c', 'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7',
    'show',
    'v2.5.6:backend/src/services/projectDatabase.js',
  ], { cwd: root, encoding: 'utf8', windowsHide: true });

  let source = finalSource;
  let schema14JumpSource = null;
  const reverseFailures = [];
  const reversePartials = [];
  const reverseVersions = [];
  const reverseStartIndex = requestedStart === 3
    ? events.findIndex((event) => event.sha256 === firstSchema15Patch)
    : firstPatchIndex;
  for (let index = events.length - 1; index >= reverseStartIndex; index -= 1) {
    const event = events[index];
    let result = applyUnifiedDiff(source, event.diff, true);
    if (result.appliedHunks === 0
      && event.sha256 === '5dc3067839bd5956ddc3e670a254a33f5a8393b0bf6b7af4d63d74d9be7b6e2a') {
      const marker = '\n      // Schema 16 keeps lineage identity after an asset index is removed.';
      const start = source.indexOf(marker);
      const end = source.indexOf('\n      const assetIdentityRows = this.db.prepare(`', start);
      if (start >= 0 && end > start) {
        source = `${source.slice(0, start)}${source.slice(end)}`;
        result = { source, appliedHunks: 1, skippedHunks: 0 };
      }
    }
    if (result.appliedHunks === 0) reverseFailures.push(event.sha256);
    else {
      source = result.source;
      if (result.skippedHunks > 0) reversePartials.push({
        sha256: event.sha256,
        appliedHunks: result.appliedHunks,
        skippedHunks: result.skippedHunks,
      });
    }
    if (/PROJECT_DATABASE_SCHEMA_VERSION/.test(event.diff)) reverseVersions.push({
      sha256: event.sha256,
      version: schemaVersion(source),
      appliedHunks: result.appliedHunks,
      skippedHunks: result.skippedHunks,
    });
  }
  if (requestedStart === 3) {
    if (schemaVersion(source) !== 14) {
      throw new Error(`expected schema14 source jump, got ${schemaVersion(source)}`);
    }
    schema14JumpSource = source;
    source = reconstructPreSchema3Source();
    const schema3Index = events.findIndex((event) => event.sha256 === schema3VersionPatch);
    if (schema3Index < 0) throw new Error('schema3 source patch not found');
    for (let index = schema3Index; index < firstPatchIndex; index += 1) {
      const result = applyUnifiedDiff(source, events[index].diff, false);
      if (result.appliedHunks > 0) source = result.source;
    }
  }
  const initialSource = source;
  if (schemaVersion(initialSource) !== requestedStart) {
    throw new Error(`expected reconstructed schema ${requestedStart}, got ${schemaVersion(initialSource)}; reverse failures: ${reverseFailures.join(',')}; reverse partials: ${JSON.stringify(reversePartials)}; versions: ${JSON.stringify(reverseVersions)}`);
  }

  const strategies = new Set(process.argv.slice(2));
  if (strategies.has('--debug-initial')) {
    const lines = initialSource.split('\n');
    lines.forEach((line, index) => {
      if (!line.includes('asset_blobs')) return;
      process.stdout.write(`--- ${index + 1} ---\n${lines.slice(Math.max(0, index - 3), index + 4).join('\n')}\n`);
    });
  }
  const strategy = strategies.has('--version-only')
    ? 'version-only'
    : strategies.has('--migration-only') ? 'migration-only' : 'every-parseable';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `t8-core-prerelease-${strategy}-`));
  const filename = path.join(directory, 'project.sqlite3');
  const opened = [];
  const compileFailures = [];
  try {
    if (requestedStart === 3) {
      const schema2Source = reconstructPreSchema3Source();
      const schema1Source = reconstructSchema1Source(schema2Source);
      await openWithSource(schema1Source, filename, 'schema1-prerelease');
      opened.push({ stage: 'schema1-prerelease', version: 1 });
      await openWithSource(schema2Source, filename, 'schema2-prerelease');
      opened.push({ stage: 'schema2-prerelease', version: 2 });
    }
    await openWithSource(initialSource, filename, `schema${requestedStart}`);
    opened.push({ stage: 'initial', version: requestedStart });
    let previousVersion = requestedStart;
    for (let index = firstPatchIndex; index < events.length; index += 1) {
      const event = events[index];
      if (requestedStart === 3 && event.sha256 === firstSchema12Patch) {
        await openWithSource(schema14JumpSource, filename, 'schema14-source-jump');
        opened.push({ stage: 'schema14-source-jump', version: 14 });
        source = schema14JumpSource;
        previousVersion = 14;
        index = events.findIndex((candidate) => candidate.sha256 === firstSchema15Patch) - 1;
        continue;
      }
      const result = applyUnifiedDiff(source, event.diff, false);
      if (result.appliedHunks === 0) continue;
      source = result.source;
      const version = schemaVersion(source);
      const shouldOpen = strategy === 'every-parseable'
        || (strategy === 'migration-only' && event.migrationBearing)
        || (strategy === 'version-only' && version > previousVersion);
      if (!shouldOpen) continue;
      try {
        const openedVersion = await openWithSource(
          source,
          filename,
          `${index}-${event.sha256.slice(0, 8)}`,
        );
        opened.push({
          stage: event.sha256.slice(0, 12),
          timestamp: event.timestamp,
          version: openedVersion,
          migrationBearing: event.migrationBearing,
        });
        previousVersion = Math.max(previousVersion, openedVersion);
      } catch (error) {
        compileFailures.push({
          stage: event.sha256.slice(0, 12),
          timestamp: event.timestamp,
          version,
          message: String(error?.message || error).slice(0, 500),
        });
      }
    }
    const finalNormalized = finalSource.replace(/\r\n?/g, '\n');
    const replayNormalized = source.replace(/\r\n?/g, '\n');
    const finalSourceMatches = finalNormalized === replayNormalized;
    await openWithSource(finalSource, filename, 'schema22-final-v2.5.6');
    opened.push({ stage: 'schema22-final-v2.5.6', version: 22 });

    const historical23 = childProcess.execFileSync('git', [
      '-c', 'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7',
      'show',
      'v2.5.8:backend/src/services/projectDatabase.js',
    ], { cwd: root, encoding: 'utf8', windowsHide: true });
    await openWithSource(historical23, filename, 'schema23');
    const current = strategies.has('--manual-lineage')
      ? compileProjectDatabase(
        fs.readFileSync(path.join(root, 'backend', 'src', 'services', 'projectDatabase.js'), 'utf8')
          .replace(
            "      assertProjectDatabaseSchema28(this.db, 'legacy-bridge-result');",
            "      void 0; // source-only probe: commit the TEMP legacy bridge before the public gate",
          ),
        'current-manual-lineage-bridge',
      )
      : require('../backend/src/services/projectDatabase');
    let database;
    try {
      database = new current.ProjectDatabase(filename, { autoBackup: false });
    } catch (error) {
      const failure = {
        strategy,
        requestedStart,
        eventCount: events.length,
        firstPatchIndex,
        reverseFailures,
        reversePartials,
        finalSourceMatches,
        opened,
        compileFailures,
        migrationError: {
          name: error?.name,
          code: error?.code,
          message: error?.message,
          details: error?.details,
        },
      };
      if (strategies.has('--manual-lineage')) {
        const BetterSqlite3 = require('better-sqlite3');
        const {
          inspectProjectDatabaseSchemaManifest,
        } = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');
        const {
          PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
        } = require('../backend/src/services/projectDatabaseMigration23');
        const {
          PROJECT_DATABASE_MIGRATION_29_UP_SQL,
        } = require('../backend/src/services/projectDatabaseMigration29');
        const {
          PROJECT_DATABASE_MIGRATION_30_UP_SQL,
        } = require('../backend/src/services/projectDatabaseMigration30');
        const {
          PROJECT_DATABASE_MIGRATION_31_UP_SQL,
        } = require('../backend/src/services/projectDatabaseMigration31');
        const raw = new BetterSqlite3(filename);
        try {
          const schema28 = inspectProjectDatabaseSchemaManifest(raw, {
            descriptorVersion: 28,
            excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
          });
          raw.exec(PROJECT_DATABASE_MIGRATION_29_UP_SQL);
          raw.exec(PROJECT_DATABASE_MIGRATION_30_UP_SQL);
          raw.exec(PROJECT_DATABASE_MIGRATION_31_UP_SQL);
          const schema31 = inspectProjectDatabaseSchemaManifest(raw, {
            descriptorVersion: 31,
            excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES,
          });
          failure.manualLineage = {
            schema28Fingerprint: schema28.fingerprint,
            schema31Fingerprint: schema31.fingerprint,
            schema31Descriptor: schema31.descriptor,
          };
          const descriptorOutput = process.env.T8_SCHEMA_DESCRIPTOR_OUTPUT;
          if (descriptorOutput) {
            fs.writeFileSync(descriptorOutput, `${JSON.stringify(failure.manualLineage)}\n`);
            failure.manualLineage = {
              schema28Fingerprint: schema28.fingerprint,
              schema31Fingerprint: schema31.fingerprint,
              descriptorOutput,
            };
          }
        } finally {
          raw.close();
        }
      }
      process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
      return;
    }
    await closeDatabase(database);
    database = null;

    const BetterSqlite3 = require('better-sqlite3');
    const { inspectProjectDatabaseSchemaManifest } = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');
    const { PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES } = require('../backend/src/services/projectDatabaseMigration23');
    const {
      PROJECT_DATABASE_MIGRATION_32_UP_SQL,
      PROJECT_DATABASE_SCHEMA_32_OWNED_OBJECT_NAMES,
    } = require('../backend/src/services/projectDatabaseMigration32');
    const raw = new BetterSqlite3(filename);
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
        strategy,
        requestedStart,
        eventCount: events.length,
        firstPatchIndex,
        reverseFailures,
        reversePartials,
        finalSourceMatches,
        opened,
        compileFailures,
        sourceFingerprint: sourceManifest.fingerprint,
        targetFingerprint: targetManifest.fingerprint,
        extensionFingerprint: extensionManifest.fingerprint,
      }, null, 2)}\n`);
    } finally {
      raw.close();
    }
  } finally {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'EBUSY') throw error;
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
