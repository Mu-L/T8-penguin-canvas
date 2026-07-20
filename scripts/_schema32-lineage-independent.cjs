'use strict';

// Independent TEMP-only schema lineage reconstruction. This script reads
// source-history evidence and never opens or copies a retained project DB.

const fs = require('node:fs');
const childProcess = require('node:child_process');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const baseScript = path.join(__dirname, '_schema32-core-prerelease-replay.cjs');

function extractCoreBackendStarts() {
  const archive = path.join(process.env.USERPROFILE || '', '.codex', 'archived_sessions');
  const sessions = path.join(process.env.USERPROFILE || '', '.codex', 'sessions');
  const rgOutput = childProcess.execFileSync('rg', [
    '--json',
    '--only-matching',
    '--max-columns', '200000',
    '-g', '*.jsonl',
    '^.{0,3000}(?:Start-Process|npm run dev|node src/server\\.js|npm\\.cmd).{0,50000}',
    archive,
    sessions,
  ], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  const byCallId = new Map();
  for (const line of rgOutput.split(/\r?\n/)) {
    let rgEvent;
    try { rgEvent = JSON.parse(line); } catch (_) { continue; }
    if (rgEvent.type !== 'match') continue;
    const input = String(rgEvent.data?.lines?.text || '');
    if (!/"payload":\{"type":"(?:custom_tool_call|function_call)"/.test(input)) continue;
    const normalized = input.replace(/\\+/g, '/');
    if (!normalized.toLowerCase().includes('e:/penguinpravite/t8-penguin-canvas')) continue;
    if (/T8-penguin-canvas-release-/i.test(normalized)) continue;
    const startsNpmDev = /Start-Process[\s\S]{0,5000}(?:['"]run['"],['"]dev(?::backend)?['"]|npm(?:\.cmd)?[\s\S]{0,300}run[\s\S]{0,100}dev(?::backend)?)/i.test(input);
    const startsNodeBackend = /Start-Process[\s\S]{0,5000}node[\s\S]{0,1000}(?:backend[\\/]src[\\/]server|src[\\/]server\.js)/i.test(input);
    const directNpmDev = /["']command["']?\s*:\s*["'][^"']*npm(?:\.cmd)?\s+run\s+dev(?::backend)?\b/i.test(input);
    const directNodeBackend = /["']command["']?\s*:\s*["'][^"']*node\s+(?:backend[\\/]src[\\/]server|src[\\/]server\.js)/i.test(input);
    if (!startsNpmDev && !startsNodeBackend && !directNpmDev && !directNodeBackend) continue;
    if (/T8PC_USER_DATA|T8PC_PORT|\$env:PORT|process\.env\.PORT|--port\b/i.test(input)) continue;
    const callId = /"call_id":"([^"]+)"/.exec(input)?.[1] || '';
    if (!callId) continue;
    const timestamp = /"timestamp":"([^"]+)"/.exec(input)?.[1] || '';
    if (timestamp < '2026-07-13T07:31:00.000Z' || timestamp > '2026-07-18T23:59:59.999Z') continue;
    const candidate = {
      timestamp,
      callId,
      name: /"name":"([^"]+)"/.exec(input)?.[1] || '',
      sourceFile: String(rgEvent.data?.path?.text || ''),
      input,
    };
    const previous = byCallId.get(callId);
    if (!previous || candidate.timestamp < previous.timestamp) byCallId.set(callId, candidate);
  }
  const starts = [...byCallId.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const output = path.join(os.tmpdir(), 't8-core-backend-start-candidates.json');
  fs.writeFileSync(output, `${JSON.stringify({ starts }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, count: starts.length, starts: starts.map(({ input, ...entry }) => ({ ...entry, inputPreview: input.slice(0, 500) })) }, null, 2)}\n`);
}

function loadReplayInternals() {
  const source = fs.readFileSync(baseScript, 'utf8').replace(
    /main\(\)\.catch\([\s\S]*$/,
    'module.exports = { collectEvents, reconstructPreSchema3Source, applyUnifiedDiff, schemaVersion, compileProjectDatabase, closeDatabase };\n',
  );
  const loaded = new Module(`${baseScript}#independent`, module);
  loaded.filename = baseScript;
  loaded.paths = Module._nodeModulePaths(path.dirname(baseScript));
  loaded._compile(source, baseScript);
  return loaded.exports;
}

function isSyntacticallyValid(source) {
  try {
    // Parse as CommonJS without executing module side effects.
    new Function('require', 'module', 'exports', '__filename', '__dirname', source);
    return true;
  } catch (_) {
    return false;
  }
}

function gitText(...args) {
  return childProcess.execFileSync(
    'git',
    ['-c', 'safe.directory=E:/PenguinPravite/T8-penguin-canvas-release-2.5.7', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
}

async function openWithSource(replay, source, filename, label) {
  const implementation = replay.compileProjectDatabase(source, label);
  const database = new implementation.ProjectDatabase(filename, { autoBackup: false });
  await replay.closeDatabase(database);
  return implementation.PROJECT_DATABASE_SCHEMA_VERSION;
}

async function replayExactOpenChain(replay, events, source2, source10) {
  const final22 = gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js');
  const cutoff19 = '2026-07-15T20:53:47.509Z';
  let source19 = final22;
  const reverse19 = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.timestamp <= cutoff19) break;
    const result = replay.applyUnifiedDiff(source19, event.diff, true);
    if (result.appliedHunks > 0) {
      source19 = result.source;
      reverse19.push({ timestamp: event.timestamp, sha256: event.sha256, appliedHunks: result.appliedHunks, skippedHunks: result.skippedHunks });
    }
  }
  if (replay.schemaVersion(source19) !== 19 || !isSyntacticallyValid(source19)) {
    throw new Error(`reverse schema19 invalid: version=${replay.schemaVersion(source19)}`);
  }
  fs.writeFileSync(path.join(os.tmpdir(), 't8-schema19-reverse-independent.cjs'), source19);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-schema32-lineage-independent-'));
  const filename = path.join(directory, 'project.sqlite3');
  try {
    const opened = [];
    opened.push({ label: 'schema2', version: await openWithSource(replay, source2, filename, 'independent-schema2') });
    opened.push({ label: 'schema10', version: await openWithSource(replay, source10, filename, 'independent-schema10') });
    opened.push({ label: 'schema19', version: await openWithSource(replay, source19, filename, 'independent-schema19-reverse') });
    opened.push({ label: 'schema22', version: await openWithSource(replay, final22, filename, 'independent-schema22-final') });
    const historical23 = gitText('show', 'v2.5.8:backend/src/services/projectDatabase.js');
    opened.push({ label: 'schema23', version: await openWithSource(replay, historical23, filename, 'independent-schema23') });

    const currentSource = fs.readFileSync(path.join(root, 'backend', 'src', 'services', 'projectDatabase.js'), 'utf8').replace(
      "      assertProjectDatabaseSchema28(this.db, 'legacy-bridge-result');",
      '      void 0; // TEMP-only independent lineage probe',
    );
    let migrationError = null;
    try {
      await openWithSource(replay, currentSource, filename, 'independent-current-bridge');
    } catch (error) {
      migrationError = { name: error?.name, code: error?.code, message: error?.message, details: error?.details };
    }

    const BetterSqlite3 = require('better-sqlite3');
    const { inspectProjectDatabaseSchemaManifest } = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');
    const { PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES } = require('../backend/src/services/projectDatabaseMigration23');
    const { PROJECT_DATABASE_MIGRATION_29_UP_SQL } = require('../backend/src/services/projectDatabaseMigration29');
    const { PROJECT_DATABASE_MIGRATION_30_UP_SQL } = require('../backend/src/services/projectDatabaseMigration30');
    const { PROJECT_DATABASE_MIGRATION_31_UP_SQL } = require('../backend/src/services/projectDatabaseMigration31');
    const { PROJECT_DATABASE_MIGRATION_32_UP_SQL } = require('../backend/src/services/projectDatabaseMigration32');
    const raw = new BetterSqlite3(filename);
    try {
      const schema28 = inspectProjectDatabaseSchemaManifest(raw, { descriptorVersion: 28, excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES });
      raw.exec(PROJECT_DATABASE_MIGRATION_29_UP_SQL);
      raw.exec(PROJECT_DATABASE_MIGRATION_30_UP_SQL);
      raw.exec(PROJECT_DATABASE_MIGRATION_31_UP_SQL);
      const schema31 = inspectProjectDatabaseSchemaManifest(raw, { descriptorVersion: 31, excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES });
      raw.exec(PROJECT_DATABASE_MIGRATION_32_UP_SQL);
      const schema32 = inspectProjectDatabaseSchemaManifest(raw, { descriptorVersion: 32, excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES });
      const output = path.join(os.tmpdir(), 't8-schema32-lineage-independent-result.json');
      const result = {
        opened,
        reverse19,
        migrationError,
        schema28Fingerprint: schema28.fingerprint,
        schema31Fingerprint: schema31.fingerprint,
        schema32Fingerprint: schema32.fingerprint,
        schema31Descriptor: schema31.descriptor,
        schema32Descriptor: schema32.descriptor,
      };
      fs.writeFileSync(output, `${JSON.stringify(result)}\n`);
      process.stdout.write(`${JSON.stringify({ ...result, schema31Descriptor: { output }, schema32Descriptor: { output } }, null, 2)}\n`);
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

function reverseSourceTo(replay, events, finalSource, cutoff) {
  let source = finalSource;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.timestamp <= cutoff) break;
    const result = replay.applyUnifiedDiff(source, event.diff, true);
    if (result.appliedHunks > 0) source = result.source;
  }
  return source;
}

async function probeVariant(replay, label, sources, captureDescriptor = false, continueOnOpenError = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `t8-schema32-${label}-`));
  const filename = path.join(directory, 'project.sqlite3');
  try {
    const openErrors = [];
    for (let index = 0; index < sources.length; index += 1) {
      try {
        await openWithSource(replay, sources[index], filename, `${label}-${index}`);
      } catch (error) {
        if (!continueOnOpenError) throw error;
        openErrors.push({ index, error: String(error?.message || error) });
      }
    }
    const historical23 = gitText('show', 'v2.5.8:backend/src/services/projectDatabase.js');
    await openWithSource(replay, historical23, filename, `${label}-schema23`);
    const currentSource = fs.readFileSync(path.join(root, 'backend', 'src', 'services', 'projectDatabase.js'), 'utf8').replace(
      "      assertProjectDatabaseSchema28(this.db, 'legacy-bridge-result');",
      '      void 0; // TEMP-only independent matrix probe',
    );
    try { await openWithSource(replay, currentSource, filename, `${label}-current`); } catch (_) {}
    const BetterSqlite3 = require('better-sqlite3');
    const { inspectProjectDatabaseSchemaManifest } = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');
    const { PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES } = require('../backend/src/services/projectDatabaseMigration23');
    const { PROJECT_DATABASE_MIGRATION_29_UP_SQL } = require('../backend/src/services/projectDatabaseMigration29');
    const { PROJECT_DATABASE_MIGRATION_30_UP_SQL } = require('../backend/src/services/projectDatabaseMigration30');
    const { PROJECT_DATABASE_MIGRATION_31_UP_SQL } = require('../backend/src/services/projectDatabaseMigration31');
    const { PROJECT_DATABASE_MIGRATION_32_UP_SQL } = require('../backend/src/services/projectDatabaseMigration32');
    const raw = new BetterSqlite3(filename);
    try {
      const schema28 = inspectProjectDatabaseSchemaManifest(raw, { descriptorVersion: 28, excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES });
      raw.exec(PROJECT_DATABASE_MIGRATION_29_UP_SQL);
      raw.exec(PROJECT_DATABASE_MIGRATION_30_UP_SQL);
      raw.exec(PROJECT_DATABASE_MIGRATION_31_UP_SQL);
      const schema31 = inspectProjectDatabaseSchemaManifest(raw, { descriptorVersion: 31, excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES });
      raw.exec(PROJECT_DATABASE_MIGRATION_32_UP_SQL);
      const schema32 = inspectProjectDatabaseSchemaManifest(raw, { descriptorVersion: 32, excludedObjectNames: PROJECT_DATABASE_SCHEMA_23_OWNED_OBJECT_NAMES });
      const result = { label, schema28: schema28.fingerprint, schema31: schema31.fingerprint, schema32: schema32.fingerprint };
      if (openErrors.length > 0) result.openErrors = openErrors;
      if (captureDescriptor) result.descriptor = schema31.descriptor;
      if (schema28.fingerprint === 'fede2259001890e0551199b59c1d44bf32804b93de9f0141e577c7b57f72903f') {
        const output = path.join(os.tmpdir(), 't8-schema32-lineage-independent-exact.json');
        fs.writeFileSync(output, `${JSON.stringify({ ...result, schema31Descriptor: schema31.descriptor, schema32Descriptor: schema32.descriptor })}\n`);
        result.output = output;
      }
      return result;
    } finally { raw.close(); }
  } catch (error) {
    return { label, error: String(error?.message || error), stack: String(error?.stack || '').split(/\r?\n/).slice(0, 4) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}

async function runIntermediateOpenMatrix(replay, events, source2) {
  const schema3Index = events.findIndex((event) => event.sha256 === 'dc8576976d9a6da8d427fea013352b4f3f98e0511740db472c8aea66240e2a05');
  let source = source2;
  let previousVersion = 2;
  const snapshots = [];
  for (let index = schema3Index; index < events.length; index += 1) {
    const result = replay.applyUnifiedDiff(source, events[index].diff, false);
    if (result.appliedHunks === 0 || !isSyntacticallyValid(result.source)) continue;
    source = result.source;
    const version = replay.schemaVersion(source);
    if (version > previousVersion && version <= 18) {
      snapshots.push({ version, source });
      previousVersion = version;
    }
  }
  const source10 = fs.readFileSync(path.join(os.tmpdir(), 't8-schema10-source-independent.cjs'), 'utf8');
  const final22 = gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js');
  const source19 = reverseSourceTo(replay, events, final22, '2026-07-15T20:53:47.509Z');
  const descriptors = [];
  for (const snapshot of snapshots) {
    const sequence = snapshot.version < 10
      ? [source2, snapshot.source, source10, source19, final22]
      : [source2, source10, snapshot.source, source19, final22];
    const result = await probeVariant(replay, `extra-schema${snapshot.version}`, sequence, true);
    if (result.descriptor) descriptors.push({ label: result.label, descriptor: result.descriptor });
    process.stdout.write(`${JSON.stringify({ label: result.label, schema31: result.schema31, error: result.error })}\n`);
  }
  const output = path.join(os.tmpdir(), 't8-schema31-intermediate-open-descriptors.json');
  fs.writeFileSync(output, `${JSON.stringify({ descriptors })}\n`);
  process.stdout.write(`${JSON.stringify({ output, count: descriptors.length })}\n`);
}

async function runSourceMatrix(replay, events, source2) {
  const final22 = gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js');
  const source10Forward = fs.readFileSync(path.join(os.tmpdir(), 't8-schema10-source-independent.cjs'), 'utf8');
  const source19Forward = fs.readFileSync(path.join(os.tmpdir(), 't8-schema19-source-independent.cjs'), 'utf8');
  const source22Forward = fs.readFileSync(path.join(os.tmpdir(), 't8-schema22-source-independent.cjs'), 'utf8');
  const source10Reverse = reverseSourceTo(replay, events, final22, '2026-07-14T06:31:19.180Z');
  const source19Reverse = reverseSourceTo(replay, events, final22, '2026-07-15T20:53:47.509Z');
  const source22Reverse = reverseSourceTo(replay, events, final22, '2026-07-16T08:20:08.461Z');
  const choices = [
    ['10f', source10Forward, 10], ['10r', source10Reverse, 10],
    ['19f', source19Forward, 19], ['19r', source19Reverse, 19],
    ['22f', source22Forward, 22], ['22r', source22Reverse, 22], ['22tag', final22, 22],
  ];
  for (const [name, source, expected] of choices) {
    process.stdout.write(`${JSON.stringify({ source: name, version: replay.schemaVersion(source), expected, syntax: isSyntacticallyValid(source) })}\n`);
  }
  const results = [];
  for (const [name10, source10] of choices.filter(([name]) => name.startsWith('10'))) {
    for (const [name19, source19] of choices.filter(([name]) => name.startsWith('19'))) {
      for (const [name22, source22] of choices.filter(([name]) => name.startsWith('22'))) {
        results.push(await probeVariant(replay, `${name10}-${name19}-${name22}`, [source2, source10, source19, source22]));
      }
    }
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

async function runSource2Matrix(replay, events, source2Final) {
  const source10 = fs.readFileSync(path.join(os.tmpdir(), 't8-schema10-source-independent.cjs'), 'utf8');
  const final22 = gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js');
  const source19 = reverseSourceTo(replay, events, final22, '2026-07-15T20:53:47.509Z');
  const schema3At = '2026-07-13T09:21:53.733Z';
  const early = events.filter((event) => event.timestamp < schema3At);
  let source = source2Final;
  const variants = [{ label: 'schema2-final', source }];
  for (let index = early.length - 1; index >= 0; index -= 1) {
    const event = early[index];
    const result = replay.applyUnifiedDiff(source, event.diff, true);
    if (result.appliedHunks === 0) continue;
    source = result.source;
    if (isSyntacticallyValid(source)) variants.push({ label: `schema2-before-${event.sha256.slice(0, 8)}`, source });
  }
  const results = [];
  for (const variant of variants) {
    results.push(await probeVariant(replay, variant.label, [variant.source, source10, source19, final22]));
    if (results.at(-1)?.schema28 === 'fede2259001890e0551199b59c1d44bf32804b93de9f0141e577c7b57f72903f') break;
  }
  const chronological = [...variants].reverse();
  for (let start = 0; start < chronological.length; start += 1) {
    const lineage = chronological.slice(start).map((entry) => entry.source);
    const label = `schema2-multi-${start}-${chronological.at(start).label}`;
    results.push(await probeVariant(replay, label, [...lineage, source10, source19, final22]));
    if (results.at(-1)?.schema28 === 'fede2259001890e0551199b59c1d44bf32804b93de9f0141e577c7b57f72903f') break;
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

function reconstructSchema1Source(source2) {
  let source1 = source2;
  source1 = source1.replace(/^[ \t]*parent_id TEXT,\r?\n/m, '');
  source1 = source1.replace(/^[ \t]*const reviewCommentColumns = .*\r?\n/m, '');
  source1 = source1.replace(/^[ \t]*if \(!reviewCommentColumns\.has\('parent_id'\)\).*\r?\n/m, '');
  source1 = source1.replace(
    /^[ \t]*this\.db\.prepare\('INSERT OR IGNORE INTO schema_migrations\(version, applied_at\) VALUES \(\?, \?\)'\)\.run\(2, Date\.now\(\)\);\r?\n/m,
    '',
  );
  fs.writeFileSync(path.join(os.tmpdir(), 't8-schema1-source-independent.cjs'), source1);
  if (!isSyntacticallyValid(source1)) {
    throw new Error('reconstructed schema1 source invalid');
  }
  return source1;
}

function collectEarlyVersionSnapshots(replay, events, source2) {
  const schema3Index = events.findIndex((event) => event.sha256 === 'dc8576976d9a6da8d427fea013352b4f3f98e0511740db472c8aea66240e2a05');
  let source = source2;
  let previousVersion = 2;
  const snapshots = [];
  for (let index = schema3Index; index < events.length; index += 1) {
    const event = events[index];
    if (event.timestamp > '2026-07-14T06:31:19.180Z') break;
    if (event.embedded) continue;
    const result = replay.applyUnifiedDiff(source, event.diff, false);
    if (result.appliedHunks === 0 || !isSyntacticallyValid(result.source)) continue;
    source = result.source;
    const version = replay.schemaVersion(source);
    if (version > previousVersion) {
      snapshots.push({ version, source, timestamp: event.timestamp, sha256: event.sha256 });
      previousVersion = version;
    }
  }
  return snapshots;
}

function collectEarlyPatchSnapshots(replay, events, source2) {
  const schema3Index = events.findIndex((event) => event.sha256 === 'dc8576976d9a6da8d427fea013352b4f3f98e0511740db472c8aea66240e2a05');
  let source = source2;
  const snapshots = [];
  for (let index = schema3Index; index < events.length; index += 1) {
    const event = events[index];
    if (event.timestamp > '2026-07-14T06:31:19.180Z') break;
    if (event.embedded) continue;
    const result = replay.applyUnifiedDiff(source, event.diff, false);
    if (result.appliedHunks === 0 || !isSyntacticallyValid(result.source)) continue;
    source = result.source;
    snapshots.push({
      version: replay.schemaVersion(source),
      source,
      timestamp: event.timestamp,
      sha256: event.sha256,
      appliedHunks: result.appliedHunks,
      skippedHunks: result.skippedHunks,
    });
  }
  return snapshots;
}

function reconstructSource2AtFirstCoreOpen(replay, events, source2Final) {
  const cutoff = '2026-07-13T07:31:58.000Z';
  const schema3At = '2026-07-13T09:21:53.733Z';
  let source = source2Final;
  const reversed = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.timestamp >= schema3At || event.timestamp <= cutoff || event.embedded) continue;
    const result = replay.applyUnifiedDiff(source, event.diff, true);
    if (result.appliedHunks === 0 || !isSyntacticallyValid(result.source)) continue;
    source = result.source;
    reversed.push({
      timestamp: event.timestamp,
      sha256: event.sha256,
      appliedHunks: result.appliedHunks,
      skippedHunks: result.skippedHunks,
    });
  }
  return { source, cutoff, reversed };
}

function reconstructSourcesAt(replay, events, source2, checkpoints) {
  const ordered = checkpoints.map((entry) => ({ ...entry })).sort((left, right) => left.at.localeCompare(right.at));
  const schema3Index = events.findIndex((event) => event.sha256 === 'dc8576976d9a6da8d427fea013352b4f3f98e0511740db472c8aea66240e2a05');
  let source = source2;
  let checkpointIndex = 0;
  const results = [];
  for (let index = schema3Index; index < events.length && checkpointIndex < ordered.length; index += 1) {
    const event = events[index];
    while (checkpointIndex < ordered.length && event.timestamp > ordered[checkpointIndex].at) {
      results.push({ ...ordered[checkpointIndex], source, version: replay.schemaVersion(source) });
      checkpointIndex += 1;
    }
    if (checkpointIndex >= ordered.length) break;
    const applied = replay.applyUnifiedDiff(source, event.diff, false);
    if (applied.appliedHunks === 0 || !isSyntacticallyValid(applied.source)) continue;
    source = applied.source;
  }
  while (checkpointIndex < ordered.length) {
    results.push({ ...ordered[checkpointIndex], source, version: replay.schemaVersion(source) });
    checkpointIndex += 1;
  }
  return results;
}

async function main() {
  if (process.argv.includes('--extract-core-starts')) {
    extractCoreBackendStarts();
    return;
  }
  const replay = loadReplayInternals();
  const events = replay.collectEvents();
  if (process.argv.includes('--dump-version-timeline')) {
    const transitions = events.flatMap((event) => {
      const removed = [...event.diff.matchAll(/^-const PROJECT_DATABASE_SCHEMA_VERSION = (\d+);$/gm)].map((match) => Number(match[1]));
      const added = [...event.diff.matchAll(/^\+const PROJECT_DATABASE_SCHEMA_VERSION = (\d+);$/gm)].map((match) => Number(match[1]));
      if (!removed.length && !added.length) return [];
      return [{
        timestamp: event.timestamp,
        callId: event.callId,
        sha256: event.sha256,
        embedded: Boolean(event.embedded),
        removed,
        added,
      }];
    });
    const output = path.join(os.tmpdir(), 't8-schema-version-patch-timeline.json');
    fs.writeFileSync(output, `${JSON.stringify({ transitions }, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ output, transitions }, null, 2)}\n`);
    return;
  }
  if (process.argv.includes('--merge-descriptors')) {
    const base = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 't8-schema31-descriptors.json'), 'utf8'));
    const extra = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 't8-schema31-intermediate-open-descriptors.json'), 'utf8'));
    const schema1Path = path.join(os.tmpdir(), 't8-schema31-schema1-real-chain.json');
    const schema1 = fs.existsSync(schema1Path) ? JSON.parse(fs.readFileSync(schema1Path, 'utf8')) : { descriptors: [] };
    const output = path.join(os.tmpdir(), 't8-schema31-merged-independent.json');
    fs.writeFileSync(output, `${JSON.stringify({ descriptors: [...base.descriptors, ...extra.descriptors, ...schema1.descriptors] })}\n`);
    process.stdout.write(`${JSON.stringify({ output })}\n`);
  }
  if (process.argv.includes('--dump-early-events')) {
    const output = path.join(os.tmpdir(), 't8-schema10-early-events-independent.json');
    fs.writeFileSync(output, `${JSON.stringify(events.filter((event) => event.timestamp <= '2026-07-14T06:31:19.180Z'))}\n`);
    process.stdout.write(`${JSON.stringify({ output })}\n`);
  }
  const schema3Index = events.findIndex((event) => event.sha256 === 'dc8576976d9a6da8d427fea013352b4f3f98e0511740db472c8aea66240e2a05');
  if (schema3Index < 0) throw new Error('schema3 patch missing');
  const checkpoints = [
    { label: 'schema10', at: '2026-07-14T06:31:19.180Z', expected: 10 },
    { label: 'schema19', at: '2026-07-15T20:53:47.509Z', expected: 19 },
    { label: 'schema22', at: '2026-07-16T08:20:08.461Z', expected: 22 },
  ];
  let source = replay.reconstructPreSchema3Source();
  const accepted = [];
  const rejected = [];
  let checkpointIndex = 0;
  for (let index = schema3Index; index < events.length && checkpointIndex < checkpoints.length; index += 1) {
    const event = events[index];
    while (checkpointIndex < checkpoints.length && event.timestamp > checkpoints[checkpointIndex].at) {
      const checkpoint = checkpoints[checkpointIndex];
      const output = path.join(os.tmpdir(), `t8-${checkpoint.label}-source-independent.cjs`);
      fs.writeFileSync(output, source);
      process.stdout.write(`${JSON.stringify({ checkpoint, version: replay.schemaVersion(source), output, accepted: accepted.length, partials: accepted.filter((entry) => entry.skippedHunks > 0), rejected })}\n`);
      checkpointIndex += 1;
    }
    if (checkpointIndex >= checkpoints.length) break;
    const applied = replay.applyUnifiedDiff(source, event.diff, false);
    if (applied.appliedHunks === 0) continue;
    if (!isSyntacticallyValid(applied.source)) {
      rejected.push({ timestamp: event.timestamp, sha256: event.sha256, appliedHunks: applied.appliedHunks, skippedHunks: applied.skippedHunks });
      continue;
    }
    source = applied.source;
    accepted.push({
      timestamp: event.timestamp,
      sha256: event.sha256,
      version: replay.schemaVersion(source),
      appliedHunks: applied.appliedHunks,
      skippedHunks: applied.skippedHunks,
    });
  }
  while (checkpointIndex < checkpoints.length) {
    const checkpoint = checkpoints[checkpointIndex];
    const output = path.join(os.tmpdir(), `t8-${checkpoint.label}-source-independent.cjs`);
    fs.writeFileSync(output, source);
    process.stdout.write(`${JSON.stringify({ checkpoint, version: replay.schemaVersion(source), output, accepted: accepted.length, partials: accepted.filter((entry) => entry.skippedHunks > 0), rejected })}\n`);
    checkpointIndex += 1;
  }
  if (process.argv.includes('--replay-exact-open-chain')) {
    await replayExactOpenChain(
      replay,
      events,
      replay.reconstructPreSchema3Source(),
      fs.readFileSync(path.join(os.tmpdir(), 't8-schema10-source-independent.cjs'), 'utf8'),
    );
  }
  if (process.argv.includes('--source-matrix')) {
    await runSourceMatrix(replay, events, replay.reconstructPreSchema3Source());
  }
  if (process.argv.includes('--source2-matrix')) {
    await runSource2Matrix(replay, events, replay.reconstructPreSchema3Source());
  }
  if (process.argv.includes('--schema1-chain')) {
    const source2 = replay.reconstructPreSchema3Source();
    const source1 = reconstructSchema1Source(source2);
    const source10 = fs.readFileSync(path.join(os.tmpdir(), 't8-schema10-source-independent.cjs'), 'utf8');
    const final22 = gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js');
    const source19 = reverseSourceTo(replay, events, final22, '2026-07-15T20:53:47.509Z');
    const result = await probeVariant(replay, 'schema1-then-schema2-real-chain', [source1, source2, source10, source19, final22], true);
    const output = path.join(os.tmpdir(), 't8-schema31-schema1-real-chain.json');
    fs.writeFileSync(output, `${JSON.stringify({ descriptors: result.descriptor ? [{ label: result.label, descriptor: result.descriptor }] : [] })}\n`);
    process.stdout.write(`${JSON.stringify({ ...result, descriptor: result.descriptor ? { output } : undefined, output }, null, 2)}\n`);
  }
  if (process.argv.includes('--schema1-early-sequential')) {
    const source2 = replay.reconstructPreSchema3Source();
    const source1 = reconstructSchema1Source(source2);
    const snapshots = collectEarlyVersionSnapshots(replay, events, source2);
    const source10 = fs.readFileSync(path.join(os.tmpdir(), 't8-schema10-source-independent.cjs'), 'utf8');
    const final22 = gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js');
    const source19 = reverseSourceTo(replay, events, final22, '2026-07-15T20:53:47.509Z');
    const earlySources = snapshots.filter((entry) => entry.version < 10).map((entry) => entry.source);
    const result = await probeVariant(
      replay,
      `schema1-early-sequential-${snapshots.map((entry) => entry.version).join('-')}`,
      [source1, source2, ...earlySources, source10, source19, final22],
      false,
    );
    const output = path.join(os.tmpdir(), 't8-schema32-schema1-early-sequential.json');
    fs.writeFileSync(output, `${JSON.stringify({ snapshots: snapshots.map(({ source: _, ...entry }) => entry), result })}\n`);
    process.stdout.write(`${JSON.stringify({ snapshots: snapshots.map(({ source: _, ...entry }) => entry), result, output }, null, 2)}\n`);
  }
  if (process.argv.includes('--source2-early-sequential')) {
    const source2 = replay.reconstructPreSchema3Source();
    const snapshots = collectEarlyVersionSnapshots(replay, events, source2);
    const source10 = fs.readFileSync(path.join(os.tmpdir(), 't8-schema10-source-independent.cjs'), 'utf8');
    const final22 = gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js');
    const source19 = reverseSourceTo(replay, events, final22, '2026-07-15T20:53:47.509Z');
    const result = await probeVariant(
      replay,
      `source2-early-sequential-${snapshots.map((entry) => entry.version).join('-')}`,
      [source2, ...snapshots.filter((entry) => entry.version < 10).map((entry) => entry.source), source10, source19, final22],
      false,
    );
    const output = path.join(os.tmpdir(), 't8-schema32-source2-early-sequential.json');
    fs.writeFileSync(output, `${JSON.stringify({ snapshots: snapshots.map(({ source: _, ...entry }) => entry), result })}\n`);
    process.stdout.write(`${JSON.stringify({ snapshots: snapshots.map(({ source: _, ...entry }) => entry), result, output }, null, 2)}\n`);
  }
  if (process.argv.includes('--schema1-every-early-patch')) {
    const source2 = replay.reconstructPreSchema3Source();
    const source1 = reconstructSchema1Source(source2);
    const snapshots = collectEarlyPatchSnapshots(replay, events, source2);
    const source10 = fs.readFileSync(path.join(os.tmpdir(), 't8-schema10-source-independent.cjs'), 'utf8');
    const final22 = gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js');
    const source19 = reverseSourceTo(replay, events, final22, '2026-07-15T20:53:47.509Z');
    const result = await probeVariant(
      replay,
      `schema1-every-early-patch-${snapshots.length}`,
      [source1, source2, ...snapshots.map((entry) => entry.source), source10, source19, final22],
      false,
      true,
    );
    const output = path.join(os.tmpdir(), 't8-schema32-schema1-every-early-patch.json');
    fs.writeFileSync(output, `${JSON.stringify({ snapshots: snapshots.map(({ source: _, ...entry }) => entry), result })}\n`);
    process.stdout.write(`${JSON.stringify({ snapshots: snapshots.map(({ source: _, ...entry }) => entry), result, output }, null, 2)}\n`);
  }
  if (process.argv.includes('--source2-first-core-open')) {
    const source2Final = replay.reconstructPreSchema3Source();
    const reconstructed = reconstructSource2AtFirstCoreOpen(replay, events, source2Final);
    const source10 = fs.readFileSync(path.join(os.tmpdir(), 't8-schema10-source-independent.cjs'), 'utf8');
    const final22 = gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js');
    const source19 = reverseSourceTo(replay, events, final22, '2026-07-15T20:53:47.509Z');
    fs.writeFileSync(path.join(os.tmpdir(), 't8-schema2-first-core-open-source.cjs'), reconstructed.source);
    const result = await probeVariant(
      replay,
      'source2-first-core-open-073158',
      [reconstructed.source, source10, source19, final22],
      true,
    );
    const output = path.join(os.tmpdir(), 't8-schema32-source2-first-core-open.json');
    fs.writeFileSync(output, `${JSON.stringify({ cutoff: reconstructed.cutoff, reversed: reconstructed.reversed, result })}\n`);
    process.stdout.write(`${JSON.stringify({ cutoff: reconstructed.cutoff, reversed: reconstructed.reversed, result: { ...result, descriptor: result.descriptor ? { output } : undefined }, output }, null, 2)}\n`);
  }
  if (process.argv.includes('--replay-duplicate-schema10-opens')) {
    const source2 = replay.reconstructPreSchema3Source();
    const opens = reconstructSourcesAt(replay, events, source2, [
      { label: 'schema10-open-060737', at: '2026-07-14T06:07:37.197Z' },
      { label: 'schema10-open-063119', at: '2026-07-14T06:31:19.180Z' },
      { label: 'schema10-open-065222', at: '2026-07-14T06:52:22.555Z' },
      { label: 'schema10-open-075735', at: '2026-07-14T07:57:35.695Z' },
    ]);
    const final22 = gitText('show', 'v2.5.6:backend/src/services/projectDatabase.js');
    const source19 = reverseSourceTo(replay, events, final22, '2026-07-15T20:53:47.509Z');
    const result = await probeVariant(
      replay,
      'actual-duplicate-schema10-opens',
      [source2, ...opens.map((entry) => entry.source), source19, final22],
      true,
    );
    const output = path.join(os.tmpdir(), 't8-schema32-duplicate-schema10-opens.json');
    fs.writeFileSync(output, `${JSON.stringify({ opens: opens.map(({ source: _, ...entry }) => entry), result })}\n`);
    process.stdout.write(`${JSON.stringify({ opens: opens.map(({ source: _, ...entry }) => entry), result: { ...result, descriptor: result.descriptor ? { output } : undefined }, output }, null, 2)}\n`);
  }
  if (process.argv.includes('--intermediate-open-matrix')) {
    await runIntermediateOpenMatrix(replay, events, replay.reconstructPreSchema3Source());
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
