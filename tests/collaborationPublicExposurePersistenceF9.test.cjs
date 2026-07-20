const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PUBLIC_EXPOSURE_STORE_MAX_BYTES,
  PublicExposureStore,
  PublicExposureStoreError,
} = require('../backend/src/collaboration/publicExposureStore');

function tempFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-f9-public-exposure-'));
  return {
    directory,
    filePath: path.join(directory, 'collaboration-public-exposure.json'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test('F9 persisted public Base URL survives a fresh store instance with a validated exact record', () => {
  const fixture = tempFixture();
  try {
    const first = new PublicExposureStore({
      filePath: fixture.filePath,
      now: () => 1_785_000_000_000,
      randomId: () => 'first-write',
    });
    assert.equal(first.load().status, 'unconfigured');
    const saved = first.save('https://collab.example/team/collab/');
    assert.equal(saved.status, 'configured');
    assert.equal(saved.source, 'persisted');
    assert.equal(saved.baseUrl, 'https://collab.example/team/collab');
    assert.equal(saved.durable, true);
    assert.equal(saved.updatedAt, 1_785_000_000_000);

    const restarted = new PublicExposureStore({ filePath: fixture.filePath }).load();
    assert.equal(restarted.status, 'configured');
    assert.equal(restarted.source, 'persisted');
    assert.equal(restarted.baseUrl, saved.baseUrl);
    assert.equal(restarted.failClosed, false);
    assert.equal(restarted.canClearPersisted, true);
    assert.deepEqual(
      fs.readdirSync(fixture.directory),
      ['collaboration-public-exposure.json'],
      'successful atomic replacement must not leave a temp file',
    );
  } finally {
    fixture.cleanup();
  }
});

test('F9 empty, corrupt and unreadable persisted records never fall back to an otherwise valid environment URL', () => {
  const fixture = tempFixture();
  try {
    const options = {
      filePath: fixture.filePath,
      environmentBaseUrl: 'https://environment.example/collab',
    };
    assert.equal(new PublicExposureStore(options).load().source, 'environment');

    fs.writeFileSync(fixture.filePath, '');
    let state = new PublicExposureStore(options).load();
    assert.equal(state.status, 'invalid');
    assert.equal(state.source, 'persisted');
    assert.equal(state.baseUrl, '');
    assert.equal(state.failClosed, true);

    fs.writeFileSync(fixture.filePath, '{"schema":"wrong"}\n');
    state = new PublicExposureStore(options).load();
    assert.equal(state.status, 'invalid');
    assert.equal(state.source, 'persisted');
    assert.equal(state.errorCode, 'collaboration_public_exposure_store_invalid');

    const realFs = fs;
    const unreadableFs = new Proxy(realFs, {
      get(target, property, receiver) {
        if (property === 'readFileSync') {
          return () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    state = new PublicExposureStore({ ...options, fs: unreadableFs }).load();
    assert.equal(state.status, 'invalid');
    assert.equal(state.source, 'persisted');
    assert.equal(state.errorCode, 'collaboration_public_exposure_store_unreadable');
    assert.equal(state.baseUrl, '');
  } finally {
    fixture.cleanup();
  }
});

test('F9 each atomic write phase failure preserves the last valid record and removes its private temp file', () => {
  const fixture = tempFixture();
  try {
    const originalUrl = 'https://old.example/collab';
    new PublicExposureStore({
      filePath: fixture.filePath,
      now: () => 1_785_000_000_001,
      randomId: () => 'original',
    }).save(originalUrl);
    const originalBytes = fs.readFileSync(fixture.filePath);
    for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
      let injectedFailures = 0;
      const failingFs = new Proxy(fs, {
        get(target, property, receiver) {
          if (property === operation) {
            return () => {
              injectedFailures += 1;
              throw Object.assign(new Error(`${operation} denied`), { code: 'EPERM' });
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const failing = new PublicExposureStore({
        filePath: fixture.filePath,
        fs: failingFs,
        now: () => 1_785_000_000_002,
        randomId: () => `failed-${operation}`,
      });
      assert.throws(
        () => failing.save(`https://${operation.toLowerCase()}.example/collab`),
        (error) => error instanceof PublicExposureStoreError
          && error.code === 'collaboration_public_exposure_persist_failed'
          && error.status === 503,
        operation,
      );
      assert.equal(injectedFailures, 1, operation);
      assert.deepEqual(fs.readFileSync(fixture.filePath), originalBytes, operation);
      assert.equal(
        new PublicExposureStore({ filePath: fixture.filePath }).load().baseUrl,
        originalUrl,
        operation,
      );
      assert.deepEqual(
        fs.readdirSync(fixture.directory),
        ['collaboration-public-exposure.json'],
        `${operation} must not leave a private temp file`,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test('F9 clear failure preserves the last valid record instead of reporting an environment fallback', () => {
  const fixture = tempFixture();
  try {
    const originalUrl = 'https://old.example/collab';
    new PublicExposureStore({ filePath: fixture.filePath }).save(originalUrl);
    const originalBytes = fs.readFileSync(fixture.filePath);
    const failingFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property === 'unlinkSync') {
          return () => { throw Object.assign(new Error('unlink denied'), { code: 'EPERM' }); };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const store = new PublicExposureStore({
      filePath: fixture.filePath,
      environmentBaseUrl: 'https://environment.example/collab',
      fs: failingFs,
    });
    assert.throws(
      () => store.clear(),
      (error) => error instanceof PublicExposureStoreError
        && error.code === 'collaboration_public_exposure_clear_failed'
        && error.status === 503,
    );
    assert.deepEqual(fs.readFileSync(fixture.filePath), originalBytes);
    assert.equal(new PublicExposureStore({ filePath: fixture.filePath }).load().baseUrl, originalUrl);
  } finally {
    fixture.cleanup();
  }
});

test('F9 clear restores valid, invalid or empty environment state only after removing the override', () => {
  const cases = [
    {
      name: 'valid',
      environmentBaseUrl: 'https://environment.example/collab',
      expected: {
        status: 'configured',
        source: 'environment',
        baseUrl: 'https://environment.example/collab',
        failClosed: false,
      },
    },
    {
      name: 'invalid',
      environmentBaseUrl: 'not a URL',
      expected: {
        status: 'invalid',
        source: 'environment',
        baseUrl: '',
        failClosed: true,
        errorCode: 'collaboration_public_exposure_environment_invalid',
      },
    },
    {
      name: 'empty',
      environmentBaseUrl: '',
      expected: {
        status: 'unconfigured',
        source: 'none',
        baseUrl: '',
        failClosed: true,
      },
    },
  ];

  for (const entry of cases) {
    const fixture = tempFixture();
    try {
      const store = new PublicExposureStore({
        filePath: fixture.filePath,
        environmentBaseUrl: entry.environmentBaseUrl,
        now: () => 1_785_000_000_003,
        randomId: () => `override-${entry.name}`,
      });
      store.save('http://public-http.example/collab');
      assert.equal(store.load().source, 'persisted', entry.name);
      const cleared = store.clear();
      for (const [key, value] of Object.entries(entry.expected)) {
        assert.equal(cleared[key], value, `${entry.name}.${key}`);
      }
      assert.equal(fs.existsSync(fixture.filePath), false, entry.name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('F9 checksum tampering and over-limit sidecars fail closed without environment fallback', () => {
  for (const variant of ['checksum', 'over-limit']) {
    const fixture = tempFixture();
    try {
      if (variant === 'checksum') {
        new PublicExposureStore({ filePath: fixture.filePath }).save('https://persisted.example/collab');
        const record = JSON.parse(fs.readFileSync(fixture.filePath, 'utf8'));
        record.checksum = record.checksum === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
        fs.writeFileSync(fixture.filePath, `${JSON.stringify(record)}\n`, 'utf8');
      } else {
        fs.writeFileSync(fixture.filePath, Buffer.alloc(PUBLIC_EXPOSURE_STORE_MAX_BYTES + 1, 0x61));
      }
      const state = new PublicExposureStore({
        filePath: fixture.filePath,
        environmentBaseUrl: 'https://environment.example/collab',
      }).load();
      assert.equal(state.status, 'invalid', variant);
      assert.equal(state.source, 'persisted', variant);
      assert.equal(state.baseUrl, '', variant);
      assert.equal(state.failClosed, true, variant);
      assert.equal(state.errorCode, 'collaboration_public_exposure_store_invalid', variant);
      assert.equal(state.canClearPersisted, true, variant);
    } finally {
      fixture.cleanup();
    }
  }
});

test('F9 a symlink sidecar fails closed even when its target is a valid record', () => {
  const fixture = tempFixture();
  try {
    const targetPath = path.join(fixture.directory, 'valid-target.json');
    new PublicExposureStore({ filePath: targetPath }).save('https://target.example/collab');
    let exposureFs = fs;
    try {
      fs.symlinkSync(targetPath, fixture.filePath, 'file');
    } catch (error) {
      assert.ok(['EACCES', 'EPERM'].includes(error?.code), error?.code);
      const targetStat = fs.lstatSync(targetPath);
      exposureFs = new Proxy(fs, {
        get(target, property, receiver) {
          if (property === 'lstatSync') {
            return (candidate) => path.resolve(candidate) === path.resolve(fixture.filePath)
              ? {
                isFile: () => true,
                isSymbolicLink: () => true,
                size: targetStat.size,
              }
              : target.lstatSync(candidate);
          }
          return Reflect.get(target, property, receiver);
        },
      });
    }
    const state = new PublicExposureStore({
      filePath: fixture.filePath,
      environmentBaseUrl: 'https://environment.example/collab',
      fs: exposureFs,
    }).load();
    assert.equal(state.status, 'invalid');
    assert.equal(state.source, 'persisted');
    assert.equal(state.baseUrl, '');
    assert.equal(state.failClosed, true);
    assert.equal(state.errorCode, 'collaboration_public_exposure_store_invalid');
    assert.equal(state.canClearPersisted, true);
  } finally {
    fixture.cleanup();
  }
});
