const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  ProjectDatabase,
  ProjectDatabaseRecoveryGenerationPathError,
  ProjectDatabaseRecoveryGenerationUnavailableError,
} = require('../backend/src/services/projectDatabase');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIDECAR_MAX_BYTES = 4 * 1024;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROJECT_DATABASE_MODULE = path.join(PROJECT_ROOT, 'backend', 'src', 'services', 'projectDatabase.js');

function temporaryProject(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filename = path.join(directory, 'projects.sqlite3');
  return {
    directory,
    filename,
    backupFilename: `${filename}.backup`,
    generationFilename: `${filename}.recovery-generation.json`,
    preMigration23BackupFilename: `${filename}.pre-migration-v22.sqlite3`,
    preMigrationBackupFilename: `${filename}.pre-migration-v28.sqlite3`,
    preMigration30BackupFilename: `${filename}.pre-migration-v29.sqlite3`,
    preMigration31BackupFilename: `${filename}.pre-migration-v30.sqlite3`,
  };
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function openProject(filename, options = {}) {
  return new ProjectDatabase(filename, { autoBackup: false, ...options });
}

function createExistingProject(fixture, canvasId = 'sidecar-canvas') {
  const database = openProject(fixture.filename);
  try {
    database.ensureCanvas(canvasId, {
      nodes: [{ id: 'node-a', type: 'image', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    return database.getRecoveryGeneration();
  } finally {
    database.close();
  }
}

function readSidecar(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function fileState(filename) {
  const stat = fs.statSync(filename, { bigint: true });
  return Object.freeze({ size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
}

function sha256(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function assertV3State(state, expected = {}) {
  assert.deepEqual(Object.keys(state).sort(), [
    'acknowledgedWriteSequence',
    'databaseUuid',
    'generation',
    'previousGeneration',
    'reason',
    'requiresSnapshot',
    'updatedAt',
    'version',
  ]);
  assert.equal(state.version, 3);
  assert.match(state.databaseUuid, UUID_PATTERN);
  assert.equal(state.databaseUuid, state.databaseUuid.toLowerCase());
  assert.match(state.generation, UUID_PATTERN);
  assert.equal(state.generation, state.generation.toLowerCase());
  assert.equal(state.previousGeneration, expected.previousGeneration ?? null);
  assert.equal(
    Number.isSafeInteger(state.acknowledgedWriteSequence)
      && state.acknowledgedWriteSequence >= 0,
    true,
  );
  if (expected.databaseUuid !== undefined) assert.equal(state.databaseUuid, expected.databaseUuid);
  if (expected.acknowledgedWriteSequence !== undefined) {
    assert.equal(state.acknowledgedWriteSequence, expected.acknowledgedWriteSequence);
  }
  if (expected.reason !== undefined) assert.equal(state.reason, expected.reason);
  if (expected.requiresSnapshot !== undefined) {
    assert.equal(state.requiresSnapshot, expected.requiresSnapshot);
  }
  assert.equal(Number.isSafeInteger(state.updatedAt) && state.updatedAt > 0, true);
}

function sidecarTemps(fixture) {
  const basename = path.basename(fixture.generationFilename);
  const prefixes = [`${basename}.tmp-`, `.${basename}.tmp-`];
  return fs.readdirSync(fixture.directory)
    .filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
    .sort();
}

function sidecarEvidence(fixture) {
  const prefix = `${path.basename(fixture.generationFilename)}.corrupt-`;
  return fs.readdirSync(fixture.directory).filter((name) => name.startsWith(prefix)).sort();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await sleep(10);
  }
}

function collectChild(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const CONCURRENT_OPENER_SOURCE = String.raw`
const fs = require('node:fs');
const { ProjectDatabase } = require(process.argv[1]);
const filename = process.argv[2];
const readyFilename = process.argv[3];
const gateFilename = process.argv[4];
const outputFilename = process.argv[5];
const waiter = new Int32Array(new SharedArrayBuffer(4));
fs.writeFileSync(readyFilename, String(process.pid), 'utf8');
const deadline = Date.now() + 15000;
while (!fs.existsSync(gateFilename)) {
  if (Date.now() >= deadline) throw new Error('concurrent opener gate timed out');
  Atomics.wait(waiter, 0, 0, 5);
}
(async () => {
  let database = null;
  try {
    database = new ProjectDatabase(filename, { autoBackup: false });
    const state = {
      generation: database.getRecoveryGeneration(),
      requiresSnapshot: database.requiresRecoveryGeneration(),
      durableState: database.recoveryGenerationState,
    };
    await database.close();
    database = null;
    fs.writeFileSync(outputFilename, JSON.stringify({ ok: true, state }), 'utf8');
  } catch (error) {
    try { await database?.close(); } catch (_) {}
    fs.writeFileSync(outputFilename, JSON.stringify({
      ok: false,
      name: error?.name || null,
      code: error?.code || null,
      message: error?.message || String(error),
      details: error?.details || null,
    }), 'utf8');
    process.exitCode = 1;
  }
})().catch((error) => {
  fs.writeFileSync(outputFilename, JSON.stringify({
    ok: false,
    code: error?.code || null,
    message: error?.message || String(error),
  }), 'utf8');
  process.exitCode = 1;
});
`;

async function attemptOpenInTwoElectronProcesses(fixture) {
  assert.ok(process.versions.electron, 'this suite must run with Electron as Node');
  const results = [];
  for (const index of [0, 1]) {
    const gateFilename = path.join(fixture.directory, `open-${index}.gate`);
    const readyFilename = path.join(fixture.directory, `child-${index}.ready`);
    const outputFilename = path.join(fixture.directory, `child-${index}.json`);
    const child = spawn(process.execPath, [
      '-e',
      CONCURRENT_OPENER_SOURCE,
      PROJECT_DATABASE_MODULE,
      fixture.filename,
      readyFilename,
      gateFilename,
      outputFilename,
    ], {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const settled = collectChild(child);
    await waitUntil(
      () => fs.existsSync(readyFilename),
      `Electron child-process ${index} barrier`,
    );
    fs.writeFileSync(gateFilename, 'go', 'utf8');
    const exit = await settled;
    const output = fs.existsSync(outputFilename)
        ? JSON.parse(fs.readFileSync(outputFilename, 'utf8'))
        : null;
    assert.equal(exit.signal, null, exit.stderr || exit.stdout);
    results.push(Object.freeze({ exit, output }));
  }
  return results;
}

test('fresh paths, zero-byte placeholders, and memory databases bootstrap exact v3 freshness semantics', () => {
  const fresh = temporaryProject('t8-b2-sidecar-fresh-');
  const zero = temporaryProject('t8-b2-sidecar-zero-');
  let freshDatabase = null;
  let zeroDatabase = null;
  let memoryDatabase = null;
  try {
    fs.writeFileSync(zero.filename, Buffer.alloc(0));
    freshDatabase = openProject(fresh.filename);
    zeroDatabase = openProject(zero.filename);
    memoryDatabase = openProject(':memory:');

    for (const [database, fixture] of [
      [freshDatabase, fresh],
      [zeroDatabase, zero],
    ]) {
      const state = readSidecar(fixture.generationFilename);
      assertV3State(state, { reason: 'schema32-migration', requiresSnapshot: true });
      assert.equal(database.getRecoveryGeneration(), state.generation);
      assert.equal(database.requiresRecoveryGeneration(), true);
      assert.deepEqual(database.recoveryGenerationState, state);
    }

    assert.equal(memoryDatabase.recoveryGenerationFilename, null);
    assertV3State(memoryDatabase.recoveryGenerationState, {
      reason: 'memory-database',
      requiresSnapshot: false,
    });
    assert.equal(memoryDatabase.getRecoveryGeneration(), memoryDatabase.recoveryGenerationState.generation);
    assert.equal(memoryDatabase.requiresRecoveryGeneration(), false);
  } finally {
    try { freshDatabase?.close(); } catch (_) {}
    try { zeroDatabase?.close(); } catch (_) {}
    try { memoryDatabase?.close(); } catch (_) {}
    cleanup(fresh.directory);
    cleanup(zero.directory);
  }
});

test('schema32 refuses valid legacy v1 and v2 sidecars without changing their bytes or mtime', () => {
  for (const version of [1, 2]) {
    const fixture = temporaryProject(`t8-b2-sidecar-v${version}-reopen-`);
    let database = null;
    try {
      createExistingProject(fixture);
      const generation = crypto.randomUUID().toLowerCase();
      const state = version === 1
        ? {
          version: 1,
          generation,
          previousGeneration: null,
          reason: 'initialize',
          updatedAt: 1_700_000_000_000,
        }
        : {
          version: 2,
          generation,
          previousGeneration: null,
          reason: 'initialize',
          requiresSnapshot: false,
          updatedAt: 1_700_000_000_000,
        };
      const raw = Buffer.from(`  ${JSON.stringify(state, null, 2)}  `, 'utf8');
      fs.writeFileSync(fixture.generationFilename, raw);
      const before = fileState(fixture.generationFilename);

      assert.throws(
        () => openProject(fixture.filename),
        (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
          && error.code === 'project_database_recovery_generation_unavailable'
          && error.status === 503
          && error.details?.phase === 'schema32-legacy-sidecar-unproven',
      );
      assert.deepEqual(fs.readFileSync(fixture.generationFilename), raw);
      assert.deepEqual(fileState(fixture.generationFilename), before);
    } finally {
      try { database?.close(); } catch (_) {}
      cleanup(fixture.directory);
    }
  }
});

test('an existing schema32 database with a missing sidecar fails closed without minting an ACK', () => {
  const fixture = temporaryProject('t8-b2-sidecar-missing-existing-');
  let database = null;
  try {
    createExistingProject(fixture, 'missing-sidecar-canvas');
    fs.rmSync(fixture.generationFilename, { force: true });

    assert.throws(
      () => openProject(fixture.filename),
      (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
        && error.code === 'project_database_recovery_generation_unavailable'
        && error.status === 503
        && error.details?.phase === 'schema32-freshness-fence-unproven'
        && error.details?.sidecarStatus === 'missing',
    );
    assert.equal(fs.existsSync(fixture.generationFilename), false);
    assert.deepEqual(sidecarEvidence(fixture), []);
    assert.deepEqual(sidecarTemps(fixture), []);
  } finally {
    try { database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('small corrupt, invalid UTF-8, and invalid field matrices preserve exact evidence and fail closed', () => {
  const generation = crypto.randomUUID().toLowerCase();
  const previousGeneration = crypto.randomUUID().toLowerCase();
  const valid = {
    version: 2,
    generation,
    previousGeneration: null,
    reason: 'initialize',
    requiresSnapshot: false,
    updatedAt: 1_700_000_000_000,
  };
  const rawScenarios = [
    ['truncated-json', Buffer.from('{"version":2', 'utf8')],
    ['invalid-utf8', Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])],
    ['null-root', Buffer.from('null', 'utf8')],
    ['array-root', Buffer.from('[]', 'utf8')],
    ['missing-field', Buffer.from(JSON.stringify((({ requiresSnapshot, ...rest }) => rest)(valid)), 'utf8')],
    ['extra-field', Buffer.from(JSON.stringify({ ...valid, extra: true }), 'utf8')],
    ['unknown-version', Buffer.from(JSON.stringify({ ...valid, version: 3 }), 'utf8')],
    ['invalid-generation', Buffer.from(JSON.stringify({ ...valid, generation: 'not-a-uuid' }), 'utf8')],
    ['invalid-previous', Buffer.from(JSON.stringify({ ...valid, previousGeneration: 'not-a-uuid', requiresSnapshot: true }), 'utf8')],
    ['generation-cycle', Buffer.from(JSON.stringify({ ...valid, previousGeneration: generation, requiresSnapshot: true }), 'utf8')],
    ['blank-reason', Buffer.from(JSON.stringify({ ...valid, reason: ' ' }), 'utf8')],
    ['control-reason', Buffer.from(JSON.stringify({ ...valid, reason: 'bad\nreason' }), 'utf8')],
    ['oversized-reason', Buffer.from(JSON.stringify({ ...valid, reason: 'r'.repeat(121) }), 'utf8')],
    ['zero-updated-at', Buffer.from(JSON.stringify({ ...valid, updatedAt: 0 }), 'utf8')],
    ['unsafe-updated-at', Buffer.from(JSON.stringify({ ...valid, updatedAt: Number.MAX_SAFE_INTEGER + 1 }), 'utf8')],
    ['nonboolean-requires', Buffer.from(JSON.stringify({ ...valid, requiresSnapshot: 'false' }), 'utf8')],
    ['false-with-previous', Buffer.from(JSON.stringify({ ...valid, previousGeneration, requiresSnapshot: false }), 'utf8')],
    ['false-repair-downgrade', Buffer.from(JSON.stringify({ ...valid, reason: 'sidecar-repair', requiresSnapshot: false }), 'utf8')],
    ['legacy-extra-field', Buffer.from(JSON.stringify({
      version: 1,
      generation,
      previousGeneration: null,
      reason: 'initialize',
      requiresSnapshot: false,
      updatedAt: 1_700_000_000_000,
    }), 'utf8')],
  ];

  for (const [name, raw] of rawScenarios) {
    const fixture = temporaryProject(`t8-b2-sidecar-invalid-${name}-`);
    let database = null;
    try {
      createExistingProject(fixture, `canvas-${name}`);
      fs.writeFileSync(fixture.generationFilename, raw);
      const digest = sha256(raw);
      const expectedEvidence = `${fixture.generationFilename}.corrupt-sha256-${digest}`;

      assert.throws(
        () => openProject(fixture.filename),
        (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
          && error.code === 'project_database_recovery_generation_unavailable'
          && error.status === 503
          && error.details?.phase === 'schema32-freshness-fence-unproven'
          && error.details?.sidecarStatus === 'invalid',
        name,
      );
      assert.deepEqual(fs.readFileSync(expectedEvidence), raw, name);
      assert.deepEqual(sidecarEvidence(fixture), [path.basename(expectedEvidence)], name);
      assert.deepEqual(fs.readFileSync(fixture.generationFilename), raw, name);
      assert.deepEqual(sidecarTemps(fixture), [], name);
    } finally {
      try { database?.close(); } catch (_) {}
      cleanup(fixture.directory);
    }
  }
});

test('bootstrap never deletes pre-existing evidence or an unowned temp-path collision', () => {
  const evidenceFixture = temporaryProject('t8-b2-sidecar-evidence-owner-');
  const tempFixture = temporaryProject('t8-b2-sidecar-temp-owner-');
  try {
    createExistingProject(evidenceFixture);
    const corruptRaw = Buffer.from('{"version":2', 'utf8');
    const evidenceFilename = `${evidenceFixture.generationFilename}.corrupt-sha256-${sha256(corruptRaw)}`;
    const unrelatedEvidence = Buffer.from('pre-existing operator evidence', 'utf8');
    fs.writeFileSync(evidenceFixture.generationFilename, corruptRaw);
    fs.writeFileSync(evidenceFilename, unrelatedEvidence);

    assert.throws(
      () => openProject(evidenceFixture.filename),
      (error) => error?.code === 'EEXIST',
    );
    assert.deepEqual(fs.readFileSync(evidenceFixture.generationFilename), corruptRaw);
    assert.deepEqual(fs.readFileSync(evidenceFilename), unrelatedEvidence);

    const unrelatedTemp = Buffer.from('pre-existing temp collision', 'utf8');
    let tempFilename = null;
    assert.throws(
      () => openProject(tempFixture.filename, {
        beforeRecoveryGenerationStateOpen: ({ tempFilename: candidate }) => {
          tempFilename = candidate;
          fs.writeFileSync(candidate, unrelatedTemp);
        },
      }),
      (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
        && error.code === 'project_database_recovery_generation_unavailable'
        && error.status === 503,
    );
    assert.equal(typeof tempFilename, 'string');
    assert.deepEqual(fs.readFileSync(tempFilename), unrelatedTemp);
  } finally {
    cleanup(evidenceFixture.directory);
    cleanup(tempFixture.directory);
  }
});

test('oversized and non-regular sidecars fail closed without replacement or repair evidence', () => {
  const oversized = temporaryProject('t8-b2-sidecar-oversized-');
  const nonregular = temporaryProject('t8-b2-sidecar-nonregular-');
  try {
    createExistingProject(oversized);
    const oversizedRaw = Buffer.alloc(SIDECAR_MAX_BYTES + 1, 0x78);
    fs.writeFileSync(oversized.generationFilename, oversizedRaw);
    const oversizedState = fileState(oversized.generationFilename);
    assert.throws(
      () => openProject(oversized.filename),
      (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
        && error.code === 'project_database_recovery_generation_unavailable'
        && error.details?.phase === 'schema32-bootstrap-observe'
        && error.details?.reason === 'oversized',
    );
    assert.deepEqual(fs.readFileSync(oversized.generationFilename), oversizedRaw);
    assert.deepEqual(fileState(oversized.generationFilename), oversizedState);
    assert.deepEqual(sidecarEvidence(oversized), []);
    assert.deepEqual(sidecarTemps(oversized), []);

    createExistingProject(nonregular);
    fs.rmSync(nonregular.generationFilename, { force: true });
    fs.mkdirSync(nonregular.generationFilename);
    assert.throws(
      () => openProject(nonregular.filename),
      (error) => error instanceof ProjectDatabaseRecoveryGenerationPathError
        && error.code === 'project_database_recovery_generation_path_invalid'
        && error.details?.phase === 'target-type',
    );
    assert.equal(fs.lstatSync(nonregular.generationFilename).isDirectory(), true);
    assert.deepEqual(sidecarEvidence(nonregular), []);
    assert.deepEqual(sidecarTemps(nonregular), []);
  } finally {
    cleanup(oversized.directory);
    cleanup(nonregular.directory);
  }
});

test('missing or zero-byte primaries with any known recovery artifact fail before open', () => {
  const artifacts = [
    { name: 'sidecar', artifact: 'generationFilename', kind: 'recovery-generation' },
    { name: 'backup', artifact: 'backupFilename', kind: 'startup-backup' },
    { name: 'primary-wal', artifact: (f) => `${f.filename}-wal`, kind: 'primary-wal' },
    { name: 'primary-journal', artifact: (f) => `${f.filename}-journal`, kind: 'primary-journal' },
    { name: 'v22-backup', artifact: 'preMigration23BackupFilename', kind: 'schema22-backup' },
    { name: 'v28-backup', artifact: 'preMigrationBackupFilename', kind: 'schema28-backup' },
    { name: 'v29-backup', artifact: 'preMigration30BackupFilename', kind: 'schema29-backup' },
    { name: 'v30-backup', artifact: 'preMigration31BackupFilename', kind: 'schema30-backup' },
    {
      name: 'sidecar-corrupt-evidence',
      artifact: (f) => `${f.generationFilename}.corrupt-sha256-${'a'.repeat(64)}`,
      kind: 'recovery-generation-corrupt-evidence',
    },
    {
      name: 'sidecar-temp',
      artifact: (f) => `${f.generationFilename}.tmp-1234-deadbeef`,
      kind: 'recovery-generation-temp',
    },
    {
      name: 'primary-corrupt-evidence',
      artifact: (f) => `${f.filename}.corrupt-1700000000000-deadbeef`,
      kind: 'primary-corrupt-evidence',
    },
    {
      name: 'primary-restore-temp',
      artifact: (f) => `${f.filename}.restore-1700000000000-deadbeef.tmp`,
      kind: 'primary-restore-temp',
    },
    {
      name: 'startup-backup-owned-temp',
      artifact: (f) => path.join(f.directory, `.${path.basename(f.backupFilename)}.owned-1234-deadbeef`),
      kind: 'startup-backup-owned-temp',
    },
    {
      name: 'schema22-backup-owned-temp',
      artifact: (f) => path.join(f.directory, `.${path.basename(f.preMigration23BackupFilename)}.owned-1234-deadbeef`),
      kind: 'schema22-backup-owned-temp',
    },
    {
      name: 'schema28-backup-owned-temp',
      artifact: (f) => path.join(f.directory, `.${path.basename(f.preMigrationBackupFilename)}.owned-1234-deadbeef`),
      kind: 'schema28-backup-owned-temp',
    },
    {
      name: 'schema29-backup-owned-temp',
      artifact: (f) => path.join(f.directory, `.${path.basename(f.preMigration30BackupFilename)}.owned-1234-deadbeef`),
      kind: 'schema29-backup-owned-temp',
    },
    {
      name: 'schema30-backup-owned-temp',
      artifact: (f) => path.join(f.directory, `.${path.basename(f.preMigration31BackupFilename)}.owned-1234-deadbeef`),
      kind: 'schema30-backup-owned-temp',
    },
  ];
  const scenarios = ['missing', 'zero'].flatMap((main) => artifacts.map((artifact) => ({
    ...artifact,
    main,
    name: `${main}-${artifact.name}`,
  })));

  for (const scenario of scenarios) {
    const fixture = temporaryProject(`t8-b2-fresh-artifact-${scenario.name}-`);
    try {
      if (scenario.main === 'zero') fs.writeFileSync(fixture.filename, Buffer.alloc(0));
      const artifactFilename = typeof scenario.artifact === 'function'
        ? scenario.artifact(fixture)
        : fixture[scenario.artifact];
      const artifactRaw = Buffer.from(`preserved-${scenario.name}-${crypto.randomUUID()}`, 'utf8');
      fs.writeFileSync(artifactFilename, artifactRaw);
      const artifactBefore = fileState(artifactFilename);
      const mainBefore = fs.existsSync(fixture.filename)
        ? { raw: fs.readFileSync(fixture.filename), state: fileState(fixture.filename) }
        : null;
      let migrationReached = false;

      assert.throws(
        () => openProject(fixture.filename, {
          beforeMigrationCommit: () => { migrationReached = true; },
        }),
        (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
          && error.code === 'project_database_recovery_generation_unavailable'
          && error.details?.phase === 'fresh-database-recovery-artifacts-present'
          && error.details?.artifactKinds?.includes(scenario.kind),
        scenario.name,
      );
      assert.equal(migrationReached, false, scenario.name);
      assert.deepEqual(fs.readFileSync(artifactFilename), artifactRaw, scenario.name);
      assert.deepEqual(fileState(artifactFilename), artifactBefore, scenario.name);
      if (mainBefore) {
        assert.deepEqual(fs.readFileSync(fixture.filename), mainBefore.raw, scenario.name);
        assert.deepEqual(fileState(fixture.filename), mainBefore.state, scenario.name);
      } else {
        assert.equal(fs.existsSync(fixture.filename), false, scenario.name);
      }
    } finally {
      cleanup(fixture.directory);
    }
  }
});

test('lexical and hard-link collisions with protected database artifacts fail without changing bytes', () => {
  const fixture = temporaryProject('t8-b2-sidecar-path-collision-');
  try {
    createExistingProject(fixture);
    const primaryRaw = fs.readFileSync(fixture.filename);
    const primaryState = fileState(fixture.filename);

    for (const [name, collisionFilename, expectedKind] of [
      ['primary-exact', fixture.filename, 'primary'],
      ['backup-exact', fixture.backupFilename, 'startup-backup'],
    ]) {
      assert.throws(
        () => openProject(fixture.filename, { recoveryGenerationFilename: collisionFilename }),
        (error) => error instanceof ProjectDatabaseRecoveryGenerationPathError
          && error.details?.phase === 'lexical-collision'
          && error.details?.targetKind === expectedKind,
        name,
      );
    }
    assert.deepEqual(fs.readFileSync(fixture.filename), primaryRaw);
    assert.deepEqual(fileState(fixture.filename), primaryState);

    const hardlinkFilename = path.join(fixture.directory, 'generation-hardlink.json');
    fs.linkSync(fixture.filename, hardlinkFilename);
    const primaryStateAfterLink = fileState(fixture.filename);
    const hardlinkState = fileState(hardlinkFilename);
    assert.throws(
      () => openProject(fixture.filename, { recoveryGenerationFilename: hardlinkFilename }),
      (error) => error instanceof ProjectDatabaseRecoveryGenerationPathError
        && error.details?.phase === 'file-identity-collision'
        && error.details?.targetKind === 'primary',
    );
    assert.deepEqual(fs.readFileSync(fixture.filename), primaryRaw);
    assert.deepEqual(fileState(fixture.filename), primaryStateAfterLink);
    assert.deepEqual(fileState(hardlinkFilename), hardlinkState);
  } finally {
    cleanup(fixture.directory);
  }
});

test('symbolic-link sidecar aliases fail closed without touching their target', (t) => {
  const fixture = temporaryProject('t8-b2-sidecar-symlink-collision-');
  try {
    createExistingProject(fixture);
    const primaryRaw = fs.readFileSync(fixture.filename);
    const primaryState = fileState(fixture.filename);
    const symlinkFilename = path.join(fixture.directory, 'generation-symlink.json');
    try {
      fs.symlinkSync(fixture.filename, symlinkFilename, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`symbolic links unavailable on this Windows host: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => openProject(fixture.filename, { recoveryGenerationFilename: symlinkFilename }),
      (error) => error instanceof ProjectDatabaseRecoveryGenerationPathError
        && error.details?.phase === 'target-type'
        && error.details?.symbolicLink === true,
    );
    assert.equal(fs.lstatSync(symlinkFilename).isSymbolicLink(), true);
    assert.deepEqual(fs.readFileSync(fixture.filename), primaryRaw);
    assert.deepEqual(fileState(fixture.filename), primaryState);
  } finally {
    cleanup(fixture.directory);
  }
});

test('query_only runtime getters, requires check, and sync perform no sidecar filesystem access or database writes', () => {
  const fixture = temporaryProject('t8-b2-sidecar-runtime-pure-read-');
  let database = null;
  const originals = new Map();
  try {
    database = openProject(fixture.filename);
    const document = database.ensureCanvas('runtime-pure-read-canvas', {
      nodes: [{ id: 'node-a', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    const generation = database.getRecoveryGeneration();
    const expectedRequires = database.requiresRecoveryGeneration();
    const rawBefore = fs.readFileSync(fixture.generationFilename);
    const stateBefore = fileState(fixture.generationFilename);
    const totalChangesBefore = database.db.prepare('SELECT total_changes() AS value').get().value;
    database.db.pragma('query_only = ON');

    const target = path.resolve(fixture.generationFilename);
    const touchesTarget = (args) => args.some((argument) => (
      typeof argument === 'string' && path.resolve(argument) === target
    ));
    for (const method of [
      'existsSync',
      'lstatSync',
      'statSync',
      'openSync',
      'readFileSync',
      'writeFileSync',
      'renameSync',
      'rmSync',
      'unlinkSync',
    ]) {
      const original = fs[method];
      originals.set(method, original);
      fs[method] = function sidecarAccessFence(...args) {
        if (touchesTarget(args)) {
          throw Object.assign(new Error(`runtime touched sidecar via fs.${method}`), {
            code: 'test_runtime_sidecar_fs_access',
          });
        }
        return original.apply(this, args);
      };
    }

    assert.equal(database.getRecoveryGeneration(), generation);
    assert.equal(database.requiresRecoveryGeneration(), expectedRequires);
    const sync = database.syncCanvas(document.canvasId, document.revision, 500, generation);
    assert.equal(sync.mode, 'operations');
    assert.deepEqual(sync.operations, []);
    assert.equal(sync.generation, generation);
    assert.equal(
      database.db.prepare('SELECT total_changes() AS value').get().value,
      totalChangesBefore,
    );

    for (const [method, original] of originals) fs[method] = original;
    originals.clear();
    assert.deepEqual(fs.readFileSync(fixture.generationFilename), rawBefore);
    assert.deepEqual(fileState(fixture.generationFilename), stateBefore);
  } finally {
    for (const [method, original] of originals) fs[method] = original;
    try { database?.db.pragma('query_only = OFF'); } catch (_) {}
    try { database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('unbootstrapped recovery generation getters fail closed', () => {
  const database = Object.create(ProjectDatabase.prototype);
  database.recoveryGenerationBootstrapped = false;
  database.recoveryGeneration = null;
  database.recoveryGenerationState = null;
  for (const invoke of [
    () => database.getRecoveryGeneration(),
    () => database.requiresRecoveryGeneration(),
  ]) {
    assert.throws(
      invoke,
      (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
        && error.code === 'project_database_recovery_generation_unavailable'
        && error.status === 503
        && error.details?.phase === 'runtime-fence-uninitialized',
    );
  }
});

test('a schema32 post-replace ACK failure permanently fail-closes the live instance', () => {
  const fixture = temporaryProject('t8-b2-sidecar-post-replace-failure-');
  let database = null;
  let reopened = null;
  try {
    let failRotation = false;
    database = openProject(fixture.filename, {
      projectDatabaseWriteAcknowledgementPersistenceOptions32: {
        afterReplace: ({ value }) => {
          if (!failRotation || value.reason !== 'post-replace-failure') return;
          throw Object.assign(new Error('simulated post-replace directory persistence failure'), {
            code: 'EIO',
          });
        },
      },
    });
    database.ensureCanvas('post-replace-failure-canvas', {
      nodes: [{ id: 'node-a', type: 'image', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });
    const stateBefore = database.recoveryGenerationState;
    const generationBefore = stateBefore.generation;
    failRotation = true;

    assert.throws(
      () => database.rotateRecoveryGeneration('post-replace-failure'),
      (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
        && error.code === 'project_database_recovery_generation_unavailable'
        && error.status === 503
        && error.details?.phase === 'schema32-rotation-committed-acknowledgement-failed'
        && error.details?.committed === true
        && error.details?.acknowledgementPublished === true
        && error.details?.errorCode === 'EIO',
    );
    const durableAfter = readSidecar(fixture.generationFilename);
    assertV3State(durableAfter, {
      databaseUuid: stateBefore.databaseUuid,
      previousGeneration: generationBefore,
      acknowledgedWriteSequence: stateBefore.acknowledgedWriteSequence + 1,
      reason: 'post-replace-failure',
      requiresSnapshot: true,
    });
    assert.notEqual(durableAfter.generation, generationBefore);
    for (const invoke of [
      () => database.getRecoveryGeneration(),
      () => database.requiresRecoveryGeneration(),
      () => database.syncCanvas('post-replace-failure-canvas', 1, 500, generationBefore),
      () => database.bootstrapRecoveryGeneration(),
    ]) {
      assert.throws(
        invoke,
        (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
          && error.code === 'project_database_recovery_generation_unavailable'
          && error.status === 503
          && error.details?.phase === 'schema32-rotation-committed-acknowledgement-failed'
          && error.details?.errorCode === 'EIO',
      );
    }
    assert.equal(database.recoveryGenerationBootstrapped, false);
    assert.equal(database.recoveryGeneration, null);
    assert.equal(database.recoveryGenerationState, null);

    assert.throws(
      () => openProject(fixture.filename),
      (error) => error?.code === 'project_database_owner_conflict' && error?.status === 409,
    );
    database.close();
    database = null;
    reopened = openProject(fixture.filename);
    assert.equal(reopened.getRecoveryGeneration(), durableAfter.generation);
    assert.equal(reopened.requiresRecoveryGeneration(), true);
  } finally {
    try { reopened?.close(); } catch (_) {}
    try { database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('a schema32 pre-replace ACK failure keeps the old ACK and cleans its owned temp', () => {
  const fixture = temporaryProject('t8-b2-sidecar-temp-replaced-');
  let database = null;
  try {
    let failRotation = false;
    database = openProject(fixture.filename, {
      projectDatabaseWriteAcknowledgementPersistenceOptions32: {
        beforeReplace: ({ value }) => {
          if (!failRotation || value.reason !== 'temp-path-replaced') return;
          throw Object.assign(new Error('simulated pre-replace failure'), { code: 'EIO' });
        },
      },
    });
    const generationBefore = database.getRecoveryGeneration();
    const durableBefore = fs.readFileSync(fixture.generationFilename);
    const durableStateBefore = fileState(fixture.generationFilename);
    failRotation = true;

    assert.throws(
      () => database.rotateRecoveryGeneration('temp-path-replaced'),
      (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
        && error.code === 'project_database_recovery_generation_unavailable'
        && error.status === 503
        && error.details?.phase === 'schema32-rotation-committed-acknowledgement-failed'
        && error.details?.committed === true
        && error.details?.acknowledgementPublished === false
        && error.details?.errorCode === 'EIO',
    );
    assert.equal(database.recoveryGenerationBootstrapped, false);
    assert.equal(database.recoveryGeneration, null);
    assert.deepEqual(fs.readFileSync(fixture.generationFilename), durableBefore);
    assert.deepEqual(fileState(fixture.generationFilename), durableStateBefore);
    assert.deepEqual(sidecarTemps(fixture), []);
    assert.notEqual(generationBefore, null);
  } finally {
    try { database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('schema32 migration ACK ENOSPC cleans its owned temp and exact guard repairs on retry', () => {
  const fixture = temporaryProject('t8-b2-sidecar-late-enospc-');
  let database = null;
  try {
    let replaceReached = 0;
    assert.throws(
      () => openProject(fixture.filename, {
        beforeRecoveryGenerationStateReplace: () => {
          replaceReached += 1;
          throw Object.assign(new Error('simulated late sidecar ENOSPC'), { code: 'ENOSPC' });
        },
      }),
      (error) => error instanceof ProjectDatabaseRecoveryGenerationUnavailableError
        && error.code === 'project_database_recovery_generation_unavailable'
        && error.status === 503
        && error.details?.phase === 'migration-32-committed-acknowledgement-failed'
        && error.details?.committed === true
        && error.details?.acknowledgementPublished === false
        && error.details?.errorCode === 'ENOSPC',
    );
    assert.equal(replaceReached, 1);
    assert.equal(fs.existsSync(fixture.filename), true);
    assert.equal(fs.existsSync(fixture.generationFilename), false);
    assert.deepEqual(sidecarTemps(fixture), []);

    database = openProject(fixture.filename);
    const state = readSidecar(fixture.generationFilename);
    assertV3State(state, { reason: 'schema32-migration', requiresSnapshot: true });
    assert.equal(database.getRecoveryGeneration(), state.generation);
    assert.equal(database.requiresRecoveryGeneration(), true);
    assert.deepEqual(sidecarTemps(fixture), []);
  } finally {
    try { database?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('schema32 rotate always requires a snapshot and a stale expected generation cannot overwrite it', () => {
  const fixture = temporaryProject('t8-b2-sidecar-rotate-conflict-');
  let first = null;
  try {
    first = openProject(fixture.filename);
    const initialGeneration = first.getRecoveryGeneration();
    const initialState = first.recoveryGenerationState;
    assert.equal(first.requiresRecoveryGeneration(), true);

    const rotatedGeneration = first.rotateRecoveryGeneration('initialize');
    assert.notEqual(rotatedGeneration, initialGeneration);
    assert.equal(first.requiresRecoveryGeneration(), true);
    const rotated = readSidecar(fixture.generationFilename);
    assertV3State(rotated, {
      databaseUuid: initialState.databaseUuid,
      previousGeneration: initialGeneration,
      acknowledgedWriteSequence: initialState.acknowledgedWriteSequence + 1,
      reason: 'initialize',
      requiresSnapshot: true,
    });
    assert.equal(rotated.generation, rotatedGeneration);
    const durableBeforeConflict = fs.readFileSync(fixture.generationFilename);
    const durableStateBeforeConflict = fileState(fixture.generationFilename);

    assert.throws(
      () => first.rotateRecoveryGeneration('stale-instance-attempt', initialGeneration),
      (error) => error?.code === 'project_database_recovery_generation_conflict'
        && error?.status === 409
        && error?.details?.phase === 'memory-fence',
    );
    assert.equal(first.getRecoveryGeneration(), rotatedGeneration);
    assert.deepEqual(fs.readFileSync(fixture.generationFilename), durableBeforeConflict);
    assert.deepEqual(fileState(fixture.generationFilename), durableStateBeforeConflict);
  } finally {
    try { first?.close(); } catch (_) {}
    cleanup(fixture.directory);
  }
});

test('independent Electron processes both refuse an existing schema32 database with a missing ACK', async () => {
  const fixture = temporaryProject('t8-b2-sidecar-process-missing-');
  try {
    createExistingProject(fixture, 'process-missing-canvas');
    fs.rmSync(fixture.generationFilename, { force: true });

    const attempts = await attemptOpenInTwoElectronProcesses(fixture);
    for (const { exit, output } of attempts) {
      assert.equal(exit.code, 1, JSON.stringify({ exit, output }));
      assert.equal(output?.ok, false, JSON.stringify(output));
      assert.equal(output?.code, 'project_database_recovery_generation_unavailable');
      assert.equal(output?.details?.phase, 'schema32-freshness-fence-unproven');
      assert.equal(output?.details?.sidecarStatus, 'missing');
    }
    assert.equal(fs.existsSync(fixture.generationFilename), false);
    assert.deepEqual(sidecarEvidence(fixture), []);
    assert.deepEqual(sidecarTemps(fixture), []);
  } finally {
    cleanup(fixture.directory);
  }
});

test('independent Electron processes refuse a corrupt schema32 ACK and preserve one exact evidence file', async () => {
  const fixture = temporaryProject('t8-b2-sidecar-process-corrupt-');
  try {
    createExistingProject(fixture, 'process-corrupt-canvas');
    const corruptRaw = Buffer.from('{"generation":"concurrent-corrupt"', 'utf8');
    fs.writeFileSync(fixture.generationFilename, corruptRaw);
    const expectedEvidence = `${fixture.generationFilename}.corrupt-sha256-${sha256(corruptRaw)}`;

    const attempts = await attemptOpenInTwoElectronProcesses(fixture);
    for (const { exit, output } of attempts) {
      assert.equal(exit.code, 1, JSON.stringify({ exit, output }));
      assert.equal(output?.ok, false, JSON.stringify(output));
      assert.equal(
        output?.code === 'project_database_recovery_generation_unavailable'
          || output?.code === 'EEXIST',
        true,
        JSON.stringify(output),
      );
    }
    assert.equal(
      attempts.some(({ output }) => (
        output?.details?.phase === 'schema32-freshness-fence-unproven'
          && output?.details?.sidecarStatus === 'invalid'
      )),
      true,
    );
    assert.deepEqual(fs.readFileSync(fixture.generationFilename), corruptRaw);
    assert.deepEqual(fs.readFileSync(expectedEvidence), corruptRaw);
    assert.deepEqual(sidecarEvidence(fixture), [path.basename(expectedEvidence)]);
    assert.deepEqual(sidecarTemps(fixture), []);
  } finally {
    cleanup(fixture.directory);
  }
});
