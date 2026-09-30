const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDataStorage, inventory } = require('../electron/dataStorage.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't8-storage-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); const target = path.join(root, 'target');
  fs.mkdirSync(path.join(source, 'data'), { recursive: true }); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'data', 'example.json'), '{"canvas":"preserved"}');
  return { source, target };
}
test('offline migration verifies bytes, retains source and persists new root', async (t) => {
  const { source, target } = fixture(t); const manager = createDataStorage(source);
  const destination = manager.schedule(target);
  assert.equal(manager.root(), source);
  await createDataStorage(source).migrate();
  assert.equal(createDataStorage(source).root(), destination);
  assert.equal(fs.readFileSync(path.join(destination, 'data', 'example.json'), 'utf8'), fs.readFileSync(path.join(source, 'data', 'example.json'), 'utf8'));
});
test('nested targets cannot recursively copy the original directory', (t) => {
  const { source } = fixture(t);
  assert.throws(() => createDataStorage(source).schedule(path.join(source, 'data')), /独立目录/);
});
test('existing destination is not overwritten; old root remains authoritative', async (t) => {
  const { source, target } = fixture(t); const manager = createDataStorage(source);
  const destination = manager.schedule(target); fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'sentinel'), 'do not overwrite');
  await assert.rejects(manager.migrate(), /已经存在/);
  assert.equal(createDataStorage(source).root(), source);
  assert.equal(fs.readFileSync(path.join(destination, 'sentinel'), 'utf8'), 'do not overwrite');
});
test('linked entries are refused without reading linked contents', (t) => {
  const { source, target } = fixture(t);
  fs.symlinkSync(target, path.join(source, 'data', 'link'), 'junction');
  assert.throws(() => inventory(source), /含链接/);
});
test('invalid bootstrap does not fall back to an empty database', (t) => {
  const { source } = fixture(t);
  fs.writeFileSync(path.join(source, 'data-location.json'), '{"version":1,"activeRoot":"relative"}');
  assert.throws(() => createDataStorage(source), /配置无效/);
});
test('interrupted staging is not reused as authoritative data', async (t) => {
  const { source, target } = fixture(t);
  const destination = createDataStorage(source).schedule(target);
  const interrupted = `${destination}.partial-interrupted`;
  fs.mkdirSync(path.join(interrupted, 'data'), { recursive: true });
  fs.writeFileSync(path.join(interrupted, 'data', 'example.json'), 'truncated');
  await createDataStorage(source).migrate();
  assert.equal(createDataStorage(source).root(), destination);
  assert.equal(fs.readFileSync(path.join(destination, 'data', 'example.json'), 'utf8'), '{"canvas":"preserved"}');
  assert.equal(fs.readFileSync(path.join(interrupted, 'data', 'example.json'), 'utf8'), 'truncated');
});
test('empty directories migrate and an unavailable relocated root never becomes an empty replacement', async (t) => {
  const { source, target } = fixture(t);
  fs.mkdirSync(path.join(source, 'data', 'empty'));
  const destination = createDataStorage(source).schedule(target);
  await createDataStorage(source).migrate();
  createDataStorage(source).assertAvailable();
  assert.ok(fs.statSync(path.join(destination, 'data', 'empty')).isDirectory());
  fs.renameSync(destination, `${destination}.offline`);
  assert.throws(() => createDataStorage(source).assertAvailable(), /数据目录不可用/);
  assert.equal(fs.existsSync(destination), false);
});
test('fresh installs can initialize the default profile without an existing data folder', (t) => {
  const { target } = fixture(t);
  const profile = path.join(target, 'new-profile');
  createDataStorage(profile).assertAvailable();
  assert.ok(fs.statSync(profile).isDirectory());
});
