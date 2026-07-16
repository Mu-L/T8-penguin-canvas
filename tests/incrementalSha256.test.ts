import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { IncrementalSha256, sha256Hex } from '../src/utils/incrementalSha256.ts';

const expectedSha256 = (input: Uint8Array | string) => crypto.createHash('sha256').update(input).digest('hex');

test('incremental SHA-256 matches the standard empty, abc, and multi-block vectors', () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ] as const;

  for (const [input, expected] of vectors) {
    const bytes = new TextEncoder().encode(input);
    assert.equal(sha256Hex(bytes), expected);
    const split = new IncrementalSha256();
    for (const byte of bytes) split.update(Uint8Array.of(byte));
    assert.equal(split.hex(), expected);
  }
});

test('incremental SHA-256 is correct across padding and compression-block boundaries', () => {
  for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 4095, 4096, 4097]) {
    const bytes = Buffer.allocUnsafe(size);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 131 + size * 17) & 0xff;
    const digest = new IncrementalSha256();
    for (let offset = 0; offset < bytes.length; offset += 37) digest.update(bytes.subarray(offset, offset + 37));
    assert.equal(digest.hex(), expectedSha256(bytes), `size ${size}`);
  }
});

test('incremental SHA-256 matches node crypto for random bytes and random chunk boundaries', () => {
  const bytes = crypto.randomBytes(3 * 1024 * 1024 + 733);
  const digest = new IncrementalSha256();
  let seed = 0x6d2b79f5;
  let offset = 0;
  while (offset < bytes.length) {
    seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x9e3779b9) >>> 0;
    const chunkSize = 1 + (seed % 65_537);
    digest.update(bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
    offset += chunkSize;
  }
  assert.equal(digest.hex(), expectedSha256(bytes));
});

test('incremental SHA-256 streams more than 100 MiB with a fixed caller buffer', () => {
  const reusableBlock = Buffer.allocUnsafe(1024 * 1024);
  for (let index = 0; index < reusableBlock.length; index += 1) reusableBlock[index] = (index * 29 + 7) & 0xff;
  const totalBytes = 100 * 1024 * 1024 + 257;
  const expected = crypto.createHash('sha256');
  const actual = new IncrementalSha256();
  let processed = 0;
  let maxUpdateBytes = 0;
  while (processed < totalBytes) {
    const length = Math.min(reusableBlock.length, totalBytes - processed);
    const chunk = reusableBlock.subarray(0, length);
    maxUpdateBytes = Math.max(maxUpdateBytes, chunk.byteLength);
    expected.update(chunk);
    actual.update(chunk);
    processed += length;
  }
  assert.equal(processed, totalBytes);
  assert.equal(maxUpdateBytes, 1024 * 1024);
  assert.equal(actual.hex(), expected.digest('hex'));
});

test('incremental SHA-256 keeps only fixed 64-word/block workspaces internally', () => {
  const source = readFileSync(new URL('../src/utils/incrementalSha256.ts', import.meta.url), 'utf8');
  assert.match(source, /private readonly buffer = new Uint8Array\(64\)/);
  assert.match(source, /private readonly schedule = new Uint32Array\(64\)/);
  assert.doesNotMatch(source, /Buffer\.concat|Uint8Array\.from\([^)]*this\.|\.push\(\.\.\.bytes\)/);
});
