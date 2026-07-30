const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  commitMaterializedOutputBuffer,
  isCommittedMaterializedOutputUrl,
} = require('../backend/src/services/materializedOutputStore');

function outputUrl(result) {
  return `/files/output/${result.filename}`;
}

test('materialized output commits data and completion manifest before cache reuse', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-materialized-output-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const buffer = Buffer.from('verified-provider-result');
  const result = commitMaterializedOutputBuffer({
    outputDir: directory,
    buffer,
    prefix: 'img',
    extension: 'png',
    materializationKey: 'task-a:0',
  });

  assert.deepEqual(fs.readFileSync(result.filePath), buffer);
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.byteSize, buffer.length);
  assert.equal(manifest.sha256, crypto.createHash('sha256').update(buffer).digest('hex'));
  assert.equal(isCommittedMaterializedOutputUrl(directory, outputUrl(result)), true);
  assert.equal(
    fs.readdirSync(directory).some((name) => name.endsWith('.part')),
    false,
  );
});

test('a nonzero partial final file is never treated as a completed cached output', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-materialized-partial-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const complete = Buffer.from('complete-video-payload-that-must-not-be-truncated');
  const first = commitMaterializedOutputBuffer({
    outputDir: directory,
    buffer: complete,
    prefix: 'vid',
    extension: 'mp4',
    materializationKey: 'task-video:0',
  });
  fs.rmSync(first.manifestPath, { force: true });
  fs.writeFileSync(first.filePath, complete.subarray(0, 7));
  assert.equal(isCommittedMaterializedOutputUrl(directory, outputUrl(first)), false);

  const recovered = commitMaterializedOutputBuffer({
    outputDir: directory,
    buffer: complete,
    prefix: 'vid',
    extension: 'mp4',
    materializationKey: 'task-video:0',
  });
  assert.equal(recovered.filename, first.filename);
  assert.deepEqual(fs.readFileSync(recovered.filePath), complete);
  assert.equal(isCommittedMaterializedOutputUrl(directory, outputUrl(recovered)), true);
});

test('a fully renamed file without its manifest is hash-verified and promoted after restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-materialized-promote-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const complete = Buffer.from('completed-before-process-exit');
  const first = commitMaterializedOutputBuffer({
    outputDir: directory,
    buffer: complete,
    prefix: 'audio',
    extension: 'mp3',
    materializationKey: 'task-audio:0',
  });
  fs.rmSync(first.manifestPath, { force: true });
  const before = fs.statSync(first.filePath).mtimeMs;

  const promoted = commitMaterializedOutputBuffer({
    outputDir: directory,
    buffer: complete,
    prefix: 'audio',
    extension: 'mp3',
    materializationKey: 'task-audio:0',
  });
  assert.equal(promoted.filename, first.filename);
  assert.equal(fs.statSync(promoted.filePath).mtimeMs, before);
  assert.equal(isCommittedMaterializedOutputUrl(directory, outputUrl(promoted)), true);
});
