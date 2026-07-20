const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { crc32 } = require('node:zlib');
const express = require('express');
const sharp = require('sharp');
const {
  ProjectDatabase,
  ProjectDatabaseStorageCapacityError,
} = require('../backend/src/services/projectDatabase');
const {
  mapProjectDatabaseStorageCapacityPublicError,
} = require('../backend/src/services/projectDatabasePublicError');
const { resolveBundledFfmpeg, resolveBundledFfprobe } = require('../backend/src/providers/llmMedia');
const {
  AssetIndexer,
  getBackgroundAssetIndexer,
  createDerivedMedia,
  differenceHash,
  dctPerceptualHash,
  dct64FromGrayscale32,
  extensionInfo,
  hashFile,
  readStableAssetSource,
  parseExifBuffer,
  parseGltfDocument,
  parseObjMetadata,
  stableAssetId,
  stableSourceLocator,
  versionedAssetId,
  PHASH_DCT64_ALGORITHM,
  DEFAULT_ASSET_PREVIEW_PIPELINE_VERSION,
} = require('../backend/src/services/assetIndexer');

function localThumbnailPath(thumbnails, url) {
  const relative = String(url).replace(/^\/files\/thumbnails\//, '');
  return path.join(thumbnails, ...relative.split('/').map(decodeURIComponent));
}

function metadataGlb(binaryBytes = 256 * 1024) {
  const document = {
    asset: { version: '2.0', generator: 'bounded metadata test' },
    buffers: [{ byteLength: binaryBytes }],
    scenes: [{}],
  };
  const jsonSource = Buffer.from(JSON.stringify(document));
  const json = Buffer.alloc(Math.ceil(jsonSource.length / 4) * 4, 0x20);
  jsonSource.copy(json);
  const binary = Buffer.alloc(Math.ceil(binaryBytes / 4) * 4, 7);
  const output = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  output.writeUInt32LE(0x46546C67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4E4F534A, 16);
  json.copy(output, 20);
  const binaryHeader = 20 + json.length;
  output.writeUInt32LE(binary.length, binaryHeader);
  output.writeUInt32LE(0x004E4942, binaryHeader + 4);
  binary.copy(output, binaryHeader + 8);
  return output;
}

function referenceDct64(grayscale) {
  assert.equal(grayscale.length, 32 * 32);
  const coefficients = [];
  for (let v = 0; v < 8; v += 1) {
    for (let u = 0; u < 8; u += 1) {
      let sum = 0;
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          sum += Number(grayscale[y * 32 + x])
            * Math.cos(((2 * x + 1) * u * Math.PI) / 64)
            * Math.cos(((2 * y + 1) * v * Math.PI) / 64);
        }
      }
      const scaleU = u === 0 ? Math.sqrt(1 / 32) : Math.sqrt(2 / 32);
      const scaleV = v === 0 ? Math.sqrt(1 / 32) : Math.sqrt(2 / 32);
      coefficients.push(sum * scaleU * scaleV);
    }
  }
  const ac = coefficients.slice(1).sort((left, right) => left - right);
  const median = ac[Math.floor(ac.length / 2)];
  let fingerprint = 0n;
  coefficients.forEach((coefficient) => {
    fingerprint = (fingerprint << 1n) | (coefficient > median ? 1n : 0n);
  });
  return fingerprint.toString(16).padStart(16, '0');
}

function hammingDistance64(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) {
    value &= value - 1n;
    count += 1;
  }
  return count;
}

test('asset extension classification and IDs are deterministic', () => {
  assert.deepEqual(extensionInfo('a.MP4'), { extension: 'mp4', kind: 'video', mimeType: 'video/mp4' });
  assert.equal(stableAssetId('input', 'Folder\\A.png'), stableAssetId('input', 'folder/a.png'));
  assert.notEqual(stableAssetId('input', 'a.png'), stableAssetId('output', 'a.png'));
  assert.equal(
    stableSourceLocator('project-a', 'input', 'Folder\\A.png'),
    stableSourceLocator('project-a', 'input', 'folder/a.png'),
  );
  assert.notEqual(
    stableSourceLocator('project-a', 'input', 'folder/a.png'),
    stableSourceLocator('project-b', 'input', 'folder/a.png'),
  );
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  assert.equal(versionedAssetId('project-a:input', 'same.png', hashA), versionedAssetId('project-a:input', 'same.png', hashA));
  assert.notEqual(versionedAssetId('project-a:input', 'same.png', hashA), versionedAssetId('project-a:input', 'same.png', hashB));
  assert.throws(() => versionedAssetId('input', 'same.png', 'short'), /SHA-256/);
});

test('phash-dct64-v1 is a reproducible 64-bit 32x32 DCT-II fingerprint with an AC-only median', () => {
  const grayscale = Buffer.alloc(32 * 32);
  for (let y = 0; y < 32; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      grayscale[y * 32 + x] = (x * 11 + y * 7 + ((x ^ y) % 9) * 13) % 256;
    }
  }
  const expected = referenceDct64(grayscale);
  assert.equal(expected, 'b5680f9c51b4eb43');
  assert.equal(dct64FromGrayscale32(grayscale), expected);
  assert.match(expected, /^[a-f0-9]{16}$/);
  assert.throws(() => dct64FromGrayscale32(Buffer.alloc(1023)), /32x32/);
  assert.equal(PHASH_DCT64_ALGORITHM, 'phash-dct64-v1');
  assert.equal(DEFAULT_ASSET_PREVIEW_PIPELINE_VERSION, 'asset-preview-v2-phash');
});

test('DCT pHash keeps visually identical re-encodes close and separates a different composition', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-phash-'));
  const png = path.join(directory, 'composition.png');
  const jpeg = path.join(directory, 'composition.jpg');
  const webp = path.join(directory, 'composition.webp');
  const different = path.join(directory, 'different.png');
  try {
    const composition = Buffer.from('<svg width="640" height="400"><rect width="640" height="400" fill="#172554"/><circle cx="180" cy="190" r="112" fill="#f59e0b"/><rect x="330" y="70" width="210" height="260" rx="35" fill="#0ea5e9"/><path d="M40 350 L300 70 L610 350" fill="none" stroke="#f8fafc" stroke-width="25"/></svg>');
    const pixels = await sharp(composition).png().toBuffer();
    await sharp(pixels).png().toFile(png);
    await sharp(pixels).jpeg({ quality: 82 }).toFile(jpeg);
    await sharp(pixels).webp({ quality: 78 }).toFile(webp);
    await sharp(Buffer.from('<svg width="640" height="400"><rect width="640" height="400" fill="#fff"/><rect width="320" height="400" fill="#000"/><circle cx="500" cy="200" r="100" fill="#000"/></svg>')).png().toFile(different);

    const [pngHash, jpegHash, webpHash, differentHash] = await Promise.all(
      [png, jpeg, webp, different].map((filename) => dctPerceptualHash(filename)),
    );
    [pngHash, jpegHash, webpHash, differentHash].forEach((hash) => assert.match(hash, /^[a-f0-9]{16}$/));
    assert.equal(hammingDistance64(pngHash, jpegHash) <= 4, true);
    assert.equal(hammingDistance64(pngHash, webpHash) <= 4, true);
    assert.equal(hammingDistance64(pngHash, differentHash) >= 16, true);

    const corrupt = path.join(directory, 'corrupt.png');
    fs.writeFileSync(corrupt, Buffer.from('not an image'));
    await assert.rejects(dctPerceptualHash(corrupt));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('stable source snapshot retries when bytes change between hashing and metadata reads', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-stable-source-'));
  const source = path.join(directory, 'source.txt');
  try {
    fs.writeFileSync(source, 'first-version');
    let metadataReads = 0;
    const snapshot = await readStableAssetSource(source, 'text', {
      attempts: 2,
      readMetadata: async (_filename, _kind, stat) => {
        metadataReads += 1;
        if (metadataReads === 1) fs.writeFileSync(source, 'second-version-with-different-size');
        return { size: stat.size, modifiedAt: stat.mtimeMs };
      },
    });
    assert.equal(metadataReads, 2);
    assert.equal(snapshot.attempts, 2);
    assert.equal(snapshot.contentHash, await hashFile(source));
    assert.equal(snapshot.metadata.size, fs.statSync(source).size);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stable source snapshot fails closed when a changing source exhausts its retry budget', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-changing-source-'));
  const source = path.join(directory, 'source.txt');
  try {
    fs.writeFileSync(source, 'before');
    await assert.rejects(
      readStableAssetSource(source, 'text', {
        attempts: 1,
        readMetadata: async (_filename, _kind, stat) => {
          fs.writeFileSync(source, 'after-with-different-size');
          return { size: stat.size, modifiedAt: stat.mtimeMs };
        },
      }),
      (error) => error?.code === 'ASSET_SOURCE_CHANGED' && error?.retryable === true,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('asset indexer hashes files, reads image metadata and keeps host paths private in storage only', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-assets-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  await sharp({ create: { width: 64, height: 48, channels: 4, background: '#33aa77' } }).png().toFile(path.join(input, 'sample.png'));
  fs.writeFileSync(path.join(output, 'caption.txt'), 'A searchable caption');
  const database = new ProjectDatabase(':memory:');
  try {
    const indexer = new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output }, database);
    const result = await indexer.scan({ concurrency: 2 });
    assert.deepEqual({ total: result.total, indexed: result.indexed, failed: result.failed }, { total: 2, indexed: 2, failed: 0 });
    const images = database.listAssets({ kind: 'image' });
    assert.equal(images.length, 1);
    assert.equal(images[0].metadata.width, 64);
    assert.equal(images[0].metadata.height, 48);
    assert.match(images[0].contentHash, /^[a-f0-9]{64}$/);
    assert.equal(images[0].sourceUrl, '/files/input/sample.png');
    assert.equal(path.resolve(images[0].managedPath), path.resolve(input, 'sample.png'));
    assert.equal(database.listAssets({ query: 'searchable' })[0].filename, 'caption.txt');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('asset indexer preserves immutable source versions across A -> same A -> B -> A rescans', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-source-versions-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  const source = path.join(input, 'versioned.txt');
  const projectId = 'project-source-versions';
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(source, 'content-version-A');
  const hashA = await hashFile(source);
  const locator = stableSourceLocator(projectId, 'input', 'versioned.txt');
  const database = new ProjectDatabase(':memory:');
  try {
    assert.equal(typeof database.findAssetBySourceLocator, 'function');
    assert.equal(typeof database.replaceAssetAtSource, 'function');
    const indexer = new AssetIndexer({
      INPUT_DIR: input,
      OUTPUT_DIR: output,
      ASSET_INDEX_STABILITY_ATTEMPTS: 2,
    }, database);

    const firstScan = await indexer.scan({ projectId, concurrency: 1 });
    assert.deepEqual(
      { total: firstScan.total, indexed: firstScan.indexed, failed: firstScan.failed },
      { total: 1, indexed: 1, failed: 0 },
    );
    const firstA = database.findAssetBySourceLocator(projectId, locator);
    assert.ok(firstA);
    assert.equal(firstA.id, versionedAssetId(`${projectId}:input`, 'versioned.txt', hashA));
    assert.equal(firstA.contentHash, hashA);
    assert.equal(firstA.availability, 'available');
    assert.equal(path.resolve(firstA.managedPath), path.resolve(source));
    assert.equal(database.listAssets({ projectId, limit: 100 }).length, 1);

    const sameScan = await indexer.scan({ projectId, concurrency: 1 });
    assert.equal(sameScan.failed, 0);
    const sameA = database.findAssetBySourceLocator(projectId, locator);
    assert.equal(sameA.id, firstA.id);
    assert.equal(sameA.contentHash, hashA);
    assert.equal(database.listAssets({ projectId, limit: 100 }).length, 1);

    fs.writeFileSync(source, 'content-version-B-with-different-bytes');
    const hashB = await hashFile(source);
    assert.notEqual(hashB, hashA);
    const secondScan = await indexer.scan({ projectId, concurrency: 1 });
    assert.equal(secondScan.failed, 0);
    const currentB = database.findAssetBySourceLocator(projectId, locator);
    const replacedA = database.findAssetBySourceLocator(projectId, locator, {
      contentHash: hashA,
      includeReplaced: true,
    });
    assert.ok(currentB);
    assert.ok(replacedA);
    assert.notEqual(currentB.id, firstA.id);
    assert.equal(currentB.id, versionedAssetId(`${projectId}:input`, 'versioned.txt', hashB));
    assert.equal(currentB.contentHash, hashB);
    assert.equal(currentB.availability, 'available');
    assert.equal(replacedA.id, firstA.id);
    assert.equal(replacedA.contentHash, hashA);
    assert.equal(replacedA.availability, 'missing');
    assert.equal(replacedA.managedPath, null);
    assert.equal(/^\/files\/(?:input|output)\//.test(String(replacedA.sourceUrl || '')), false);
    assert.equal(database.listAssets({ projectId, limit: 100 }).length, 2);

    const aToBLineage = database.getAssetLineage(currentB.id).find((event) => (
      event.childAssetId === currentB.id
      && event.parentAssetId === firstA.id
      && event.sourceType === 'source-version-replacement'
      && event.derivedOperation === 'replaced-at-source'
    ));
    assert.ok(aToBLineage, 'A -> B replacement lineage should be retained');

    fs.writeFileSync(source, 'content-version-A');
    const thirdScan = await indexer.scan({ projectId, concurrency: 1 });
    assert.equal(thirdScan.failed, 0);
    const currentA = database.findAssetBySourceLocator(projectId, locator);
    const replacedB = database.findAssetBySourceLocator(projectId, locator, {
      contentHash: hashB,
      includeReplaced: true,
    });
    assert.ok(currentA);
    assert.ok(replacedB);
    assert.equal(currentA.id, firstA.id);
    assert.equal(currentA.contentHash, hashA);
    assert.equal(currentA.availability, 'available');
    assert.equal(path.resolve(currentA.managedPath), path.resolve(source));
    assert.equal(replacedB.id, currentB.id);
    assert.equal(replacedB.availability, 'missing');
    assert.equal(replacedB.managedPath, null);
    assert.equal(/^\/files\/(?:input|output)\//.test(String(replacedB.sourceUrl || '')), false);
    assert.equal(database.listAssets({ projectId, limit: 100 }).length, 2);

    const replacementHistory = [
      ...database.getAssetLineage(currentA.id),
      ...database.getAssetLineage(replacedB.id),
    ];
    assert.equal(replacementHistory.some((event) => (
      event.childAssetId === replacedB.id
      && event.parentAssetId === currentA.id
      && event.sourceType === 'source-version-replacement'
    )), true);
    assert.equal(replacementHistory.some((event) => (
      event.childAssetId === currentA.id
      && event.parentAssetId === null
      && event.sourceType === 'source-version-replacement'
      && event.metadata?.replacedAssetId === replacedB.id
      && event.metadata?.reusedHistorical === true
    )), true);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('asset indexer keeps same-named files with different paths and content independent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-same-name-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  const left = path.join(input, 'left', 'same.txt');
  const right = path.join(input, 'right', 'same.txt');
  const projectId = 'project-same-name-assets';
  fs.mkdirSync(path.dirname(left), { recursive: true });
  fs.mkdirSync(path.dirname(right), { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(left, 'left-file-content');
  fs.writeFileSync(right, 'right-file-content-is-different');
  const database = new ProjectDatabase(':memory:');
  try {
    const indexer = new AssetIndexer({
      INPUT_DIR: input,
      OUTPUT_DIR: output,
      ASSET_INDEX_STABILITY_ATTEMPTS: 2,
    }, database);
    const result = await indexer.scan({ projectId, concurrency: 1 });
    assert.deepEqual(
      { total: result.total, indexed: result.indexed, failed: result.failed },
      { total: 2, indexed: 2, failed: 0 },
    );
    const assets = database.listAssets({ projectId, limit: 100, sort: 'name-asc' });
    assert.equal(assets.length, 2);
    assert.deepEqual(assets.map((asset) => asset.filename), ['same.txt', 'same.txt']);
    assert.notEqual(assets[0].id, assets[1].id);
    assert.notEqual(assets[0].sourceLocator, assets[1].sourceLocator);
    assert.notEqual(assets[0].contentHash, assets[1].contentHash);

    const leftAsset = database.findAssetBySourceLocator(
      projectId,
      stableSourceLocator(projectId, 'input', path.join('left', 'same.txt')),
    );
    const rightAsset = database.findAssetBySourceLocator(
      projectId,
      stableSourceLocator(projectId, 'input', path.join('right', 'same.txt')),
    );
    assert.ok(leftAsset);
    assert.ok(rightAsset);
    assert.notEqual(leftAsset.id, rightAsset.id);
    assert.equal(leftAsset.metadata.relativePath, 'left/same.txt');
    assert.equal(rightAsset.metadata.relativePath, 'right/same.txt');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('asset indexer generates bounded image previews and deterministic perceptual hashes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-previews-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  const thumbnails = path.join(directory, 'thumbnails');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const imagePath = path.join(input, 'wide.png');
  await sharp({ create: { width: 900, height: 300, channels: 3, background: '#336699' } }).png().composite([{ input: Buffer.from('<svg width="900" height="300"><rect x="450" width="450" height="300" fill="#fff"/></svg>') }]).toFile(imagePath);
  const database = new ProjectDatabase(':memory:');
  try {
    const indexer = new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output, THUMBNAILS_DIR: thumbnails }, database);
    const result = await indexer.scan();
    assert.equal(result.failed, 0);
    const asset = database.listAssets({ kind: 'image' })[0];
    assert.match(asset.metadata.thumbnailUrl, /^\/files\/thumbnails\/asset-[a-f0-9]+-asset-preview-v2-phash-thumb\.webp$/);
    assert.match(asset.metadata.perceptualHash, /^[a-f0-9]{16}$/);
    assert.equal(asset.metadata.perceptualHash, await dctPerceptualHash(imagePath));
    assert.equal(asset.metadata.perceptualHashAlgorithm, PHASH_DCT64_ALGORITHM);
    assert.deepEqual(asset.metadata.perceptualHashes, [{
      role: 'primary',
      index: 0,
      hash: asset.metadata.perceptualHash,
      algorithm: PHASH_DCT64_ALGORITHM,
    }]);
    const legacyDifferenceHash = await differenceHash(imagePath);
    assert.match(legacyDifferenceHash, /^[a-f0-9]{16}$/);
    assert.equal(legacyDifferenceHash, await differenceHash(imagePath));
    const preview = path.join(thumbnails, decodeURIComponent(asset.metadata.thumbnailUrl.split('/').pop()));
    const previewInfo = await sharp(fs.readFileSync(preview)).metadata();
    assert.equal(Math.max(previewInfo.width, previewInfo.height) <= 480, true);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('reindexing restores persisted succeeded preview results when asset metadata was overwritten', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-preview-restore-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const source = path.join(input, 'restored.png');
  await sharp({ create: { width: 32, height: 24, channels: 3, background: '#446688' } }).png().toFile(source);
  const database = new ProjectDatabase(':memory:');
  const previewPipeline = {
    enqueueAsset(asset) {
      return database.enqueueAssetPreviewJob({
        assetId: asset.id,
        contentHash: asset.contentHash,
        jobKind: 'image-preview',
        pipelineVersion: 'asset-preview-v1',
      });
    },
  };
  try {
    const indexer = new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output }, database, { previewPipeline });
    const first = await indexer.indexFile(source, { projectId: 'preview-restore', rootName: 'input', rootPath: input, publicPrefix: '/files/input/' });
    const claimed = database.claimNextAssetPreviewJob();
    database.completeAssetPreviewJob(claimed.id, {
      thumbnailUrl: '/files/thumbnails/persisted-thumb.webp',
      perceptualHash: '0123456789abcdef',
    }, { expectedAttempt: claimed, expectedAssetSnapshot: claimed.availabilitySnapshot });
    database.upsertAsset({ ...database.getAsset(first.id), metadata: { previewStatus: 'queued', overwritten: true } });

    const restored = await indexer.indexFile(source, { projectId: 'preview-restore', rootName: 'input', rootPath: input, publicPrefix: '/files/input/' });
    assert.equal(restored.metadata.previewStatus, 'ready');
    assert.equal(restored.metadata.thumbnailUrl, '/files/thumbnails/persisted-thumb.webp');
    assert.equal(restored.metadata.perceptualHash, '0123456789abcdef');
    assert.equal(restored.perceptualHash, '0123456789abcdef');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('oversized image declarations become honest corrupt/failed records without partial previews', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-pixel-limit-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  const thumbnails = path.join(directory, 'thumbnails');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const source = path.join(input, 'oversized-header.png');
  const png = Buffer.from(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toBuffer());
  png.writeUInt32BE(10_001, 16);
  png.writeUInt32BE(10_000, 20);
  png.writeUInt32BE(Number(crc32(png.subarray(12, 29))) >>> 0, 29);
  fs.writeFileSync(source, png);
  const database = new ProjectDatabase(':memory:');
  try {
    const result = await new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output, THUMBNAILS_DIR: thumbnails }, database).scan();
    assert.equal(result.failed, 0);
    const asset = database.listAssets({ kind: 'image' })[0];
    assert.equal(asset.availability, 'corrupt');
    assert.equal(asset.metadata.health, 'corrupt');
    assert.equal(asset.metadata.previewStatus, 'failed');
    assert.match(`${asset.metadata.metadataError} ${asset.metadata.previewError}`, /pixel|limit|exceeds/i);
    const partials = fs.existsSync(thumbnails)
      ? fs.readdirSync(thumbnails, { recursive: true }).filter((entry) => String(entry).includes('.part-'))
      : [];
    assert.deepEqual(partials, []);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('glTF metadata reports bounds and missing external dependencies without reading outside its folder', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-gltf-'));
  const filename = path.join(directory, 'scene.gltf');
  fs.writeFileSync(filename, JSON.stringify({
    asset: { version: '2.0', generator: 'test' },
    buffers: [{ uri: 'mesh.bin' }, { uri: '../outside.bin' }],
    images: [{ uri: 'missing.png' }, { uri: 'data:image/png;base64,AA==' }, { uri: 'https://example.invalid/private.png' }],
    accessors: [{ type: 'VEC3', min: [-1, -2, -3], max: [4, 5, 6] }],
    scenes: [{}], nodes: [{}], meshes: [{ primitives: [{}, {}] }], materials: [{}], textures: [{}],
  }));
  fs.writeFileSync(path.join(directory, 'mesh.bin'), Buffer.from([0, 1, 2]));
  try {
    const metadata = parseGltfDocument(filename);
    assert.deepEqual(metadata.bounds, { min: [-1, -2, -3], max: [4, 5, 6] });
    assert.equal(metadata.primitives, 2);
    assert.deepEqual(metadata.missingReferences.sort(), ['../outside.bin', 'https://example.invalid/private.png', 'missing.png']);
    assert.equal(metadata.references.find((item) => item.reference === '../outside.bin').unsafe, true);
    assert.equal(metadata.references.find((item) => item.reference.startsWith('https:')).unsafe, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('EXIF parser exposes bounded camera metadata without leaking raw binary or GPS coordinates', () => {
  const tiff = Buffer.alloc(82);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x010F, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(6, 14);
  tiff.writeUInt32LE(38, 18);
  tiff.writeUInt16LE(0x8769, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  tiff.writeUInt32LE(44, 30);
  tiff.writeUInt32LE(0, 34);
  tiff.write('Canon\0', 38, 'ascii');
  tiff.writeUInt16LE(1, 44);
  tiff.writeUInt16LE(0x9003, 46);
  tiff.writeUInt16LE(2, 48);
  tiff.writeUInt32LE(20, 50);
  tiff.writeUInt32LE(62, 54);
  tiff.writeUInt32LE(0, 58);
  tiff.write('2026:07:15 12:34:56\0', 62, 'ascii');
  const exif = parseExifBuffer(Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]));
  assert.deepEqual(exif, { make: 'Canon', dateTimeOriginal: '2026:07:15 12:34:56' });
  assert.equal(Object.hasOwn(exif, 'gpsLatitude'), false);
});

test('OBJ metadata resolves material texture references and reports missing textures safely', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-obj-'));
  const filename = path.join(directory, 'mesh.obj');
  fs.writeFileSync(filename, 'mtllib material.mtl\nv -1 -2 -3\nv 4 5 6\nf 1 2 1\n');
  fs.writeFileSync(path.join(directory, 'material.mtl'), 'newmtl body\nmap_Kd texture.png\nmap_bump missing-normal.png\n');
  fs.writeFileSync(path.join(directory, 'texture.png'), Buffer.from([1]));
  try {
    const metadata = parseObjMetadata(filename);
    assert.deepEqual(metadata.bounds, { min: [-1, -2, -3], max: [4, 5, 6] });
    assert.equal(metadata.textureReferences.length, 2);
    assert.deepEqual(metadata.missingReferences, ['missing-normal.png']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('3D metadata parsers enforce byte, line, vertex, reference and MTL limits with safe errors', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-model-limits-'));
  try {
    const oversizedJson = path.join(directory, 'oversized.gltf');
    fs.writeFileSync(oversizedJson, JSON.stringify({ asset: { version: '2.0' }, extras: 'x'.repeat(256) }));
    assert.throws(
      () => parseGltfDocument(oversizedJson, { maxSourceBytes: 64, maxJsonBytes: 64 }),
      (error) => error?.code === 'MODEL_SOURCE_TOO_LARGE' && !String(error.message).includes(directory),
    );

    const tooManyReferences = path.join(directory, 'references.gltf');
    fs.writeFileSync(tooManyReferences, JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'a.bin' }, { uri: 'b.bin' }],
    }));
    assert.throws(
      () => parseGltfDocument(tooManyReferences, { maxReferences: 1 }),
      (error) => error?.code === 'MODEL_METADATA_TOO_COMPLEX',
    );

    const tooManyGltfVertices = path.join(directory, 'vertices.gltf');
    fs.writeFileSync(tooManyGltfVertices, JSON.stringify({
      asset: { version: '2.0' },
      accessors: [{ type: 'VEC3', count: 4 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    }));
    assert.throws(
      () => parseGltfDocument(tooManyGltfVertices, { maxVertices: 3 }),
      (error) => error?.code === 'MODEL_TOO_COMPLEX',
    );

    const tooManyVertices = path.join(directory, 'vertices.obj');
    fs.writeFileSync(tooManyVertices, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\n');
    assert.throws(
      () => parseObjMetadata(tooManyVertices, { maxVertices: 3 }),
      (error) => error?.code === 'MODEL_TOO_COMPLEX',
    );
    assert.throws(
      () => parseObjMetadata(tooManyVertices, { maxLines: 2 }),
      (error) => error?.code === 'MODEL_METADATA_TOO_COMPLEX',
    );

    const materialObj = path.join(directory, 'material.obj');
    fs.writeFileSync(materialObj, 'mtllib hostile.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    fs.writeFileSync(path.join(directory, 'hostile.mtl'), `newmtl body\n# ${'x'.repeat(256)}\nmap_Kd texture.png\n`);
    assert.throws(
      () => parseObjMetadata(materialObj, { maxMtlBytes: 64 }),
      (error) => error?.code === 'MODEL_METADATA_TOO_COMPLEX' && !String(error.message).includes(directory),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('GLB metadata reads only its bounded JSON chunk instead of bulk-reading binary payloads', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-glb-bounded-'));
  const filename = path.join(directory, 'payload.glb');
  fs.writeFileSync(filename, metadataGlb());
  const originalReadFileSync = fs.readFileSync;
  let bulkReads = 0;
  try {
    fs.readFileSync = function guardedReadFileSync(candidate, ...args) {
      if (path.resolve(String(candidate)) === path.resolve(filename)) {
        bulkReads += 1;
        throw new Error('GLB parser attempted a bulk read');
      }
      return originalReadFileSync.call(this, candidate, ...args);
    };
    const metadata = parseGltfDocument(filename, { maxSourceBytes: 512 * 1024, maxJsonBytes: 1024 });
    assert.equal(metadata.format, 'glb');
    assert.equal(metadata.scenes, 1);
    assert.equal(bulkReads, 0);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('over-limit models become corrupt before preview enqueue and never leave partial artifacts', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-model-reject-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  const thumbnails = path.join(directory, 'thumbnails');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(input, 'hostile.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  const database = new ProjectDatabase(':memory:');
  let enqueued = 0;
  try {
    const indexer = new AssetIndexer(
      { INPUT_DIR: input, OUTPUT_DIR: output, THUMBNAILS_DIR: thumbnails },
      database,
      {
        modelMetadataLimits: { maxSourceBytes: 24 },
        previewPipeline: { enqueueAsset() { enqueued += 1; return null; } },
      },
    );
    const result = await indexer.scan();
    const asset = database.listAssets({ kind: 'model3d' })[0];
    assert.equal(result.failed, 0);
    assert.equal(asset.availability, 'corrupt');
    assert.equal(asset.metadata.health, 'corrupt');
    assert.equal(asset.metadata.metadataErrorCode, 'MODEL_SOURCE_TOO_LARGE');
    assert.equal(asset.metadata.previewStatus, 'failed');
    assert.equal(enqueued, 0);
    const partials = fs.existsSync(thumbnails)
      ? fs.readdirSync(thumbnails, { recursive: true }).filter((entry) => String(entry).includes('.part-'))
      : [];
    assert.deepEqual(partials, []);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('video and audio indexing creates real keyframes, contact sheet and even H.264/AAC proxy', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-av-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  const thumbnails = path.join(directory, 'thumbnails');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const video = path.join(input, 'clip.mp4');
  const audio = path.join(input, 'tone.wav');
  execFileSync(resolveBundledFfmpeg(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=97x65:rate=16:duration=1.2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1.2:sample_rate=22050',
    '-shortest', '-metadata:s:v:0', 'rotate=90', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-g', '1', '-keyint_min', '1', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k', video,
  ], { windowsHide: true, timeout: 30_000 });
  execFileSync(resolveBundledFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4:sample_rate=22050', '-ac', '1', '-c:a', 'pcm_s16le', audio], { windowsHide: true, timeout: 30_000 });
  const database = new ProjectDatabase(':memory:');
  let staticServer = null;
  try {
    const result = await new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output, THUMBNAILS_DIR: thumbnails }, database).scan({ concurrency: 1 });
    assert.equal(result.failed, 0);
    const videoAsset = database.listAssets({ kind: 'video' })[0];
    const audioAsset = database.listAssets({ kind: 'audio' })[0];
    assert.equal(videoAsset.metadata.frameCount >= 5, true);
    assert.equal(typeof videoAsset.metadata.rotation, 'number');
    assert.match(videoAsset.metadata.firstFrameUrl, /-first\.webp$/);
    assert.match(videoAsset.metadata.lastFrameUrl, /-last\.webp$/);
    assert.match(videoAsset.metadata.contactSheetUrl, /-contact\.webp$/);
    assert.match(videoAsset.metadata.proxyUrl, /-proxy\.mp4$/);
    assert.equal(videoAsset.metadata.keyframeUrls.length, 12);
    assert.equal(videoAsset.metadata.keyframeTimes.length, videoAsset.metadata.keyframeUrls.length);
    assert.deepEqual([...videoAsset.metadata.keyframeTimes].sort((left, right) => left - right), videoAsset.metadata.keyframeTimes);
    [
      videoAsset.metadata.firstFrameUrl,
      videoAsset.metadata.lastFrameUrl,
      videoAsset.metadata.contactSheetUrl,
      videoAsset.metadata.proxyUrl,
      ...videoAsset.metadata.keyframeUrls,
    ].forEach((url) => assert.equal(fs.existsSync(localThumbnailPath(thumbnails, url)), true));
    assert.equal(videoAsset.metadata.perceptualHashAlgorithm, PHASH_DCT64_ALGORITHM);
    assert.equal(videoAsset.metadata.perceptualHashes.length, 12);
    for (let index = 0; index < videoAsset.metadata.perceptualHashes.length; index += 1) {
      const fingerprint = videoAsset.metadata.perceptualHashes[index];
      assert.deepEqual(Object.keys(fingerprint).sort(), ['algorithm', 'hash', 'index', 'role', 'time']);
      assert.equal(fingerprint.role, 'codec-keyframe');
      assert.equal(fingerprint.index, index);
      assert.equal(fingerprint.time, videoAsset.metadata.keyframeTimes[index]);
      assert.equal(fingerprint.algorithm, PHASH_DCT64_ALGORITHM);
      assert.match(fingerprint.hash, /^[a-f0-9]{16}$/);
      assert.equal(fingerprint.hash, await dctPerceptualHash(localThumbnailPath(thumbnails, videoAsset.metadata.keyframeUrls[index])));
    }
    assert.equal(videoAsset.metadata.perceptualHash, videoAsset.metadata.perceptualHashes[0].hash);
    assert.equal(new Set(videoAsset.metadata.perceptualHashes.map((entry) => entry.hash)).size >= 2, true);
    const proxyPath = localThumbnailPath(thumbnails, videoAsset.metadata.proxyUrl);
    const proxyProbe = JSON.parse(execFileSync(resolveBundledFfprobe(), [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', proxyPath,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }));
    const proxyVideo = proxyProbe.streams.find((stream) => stream.codec_type === 'video');
    const proxyAudio = proxyProbe.streams.find((stream) => stream.codec_type === 'audio');
    assert.equal(proxyVideo.codec_name, 'h264');
    assert.equal(proxyVideo.pix_fmt, 'yuv420p');
    assert.equal(proxyVideo.width % 2, 0);
    assert.equal(proxyVideo.height % 2, 0);
    assert.equal(proxyAudio.codec_name, 'aac');
    const proxyBytes = fs.readFileSync(proxyPath).toString('latin1');
    assert.equal(proxyBytes.indexOf('moov') < proxyBytes.indexOf('mdat'), true);
    const staticApp = express();
    staticApp.use('/files/thumbnails', express.static(thumbnails));
    staticApp.use((error, _req, res, next) => {
      if (Number(error?.status) === 416) {
        res.setHeader('Content-Range', `bytes */${fs.statSync(proxyPath).size}`);
        return res.status(416).end();
      }
      return next(error);
    });
    staticServer = await new Promise((resolve) => {
      const listener = staticApp.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const proxyUrl = `http://127.0.0.1:${staticServer.address().port}${videoAsset.metadata.proxyUrl}`;
    const rangedProxy = await fetch(proxyUrl, { headers: { Range: 'bytes=0-63' } });
    assert.equal(rangedProxy.status, 206);
    assert.equal(rangedProxy.headers.get('accept-ranges'), 'bytes');
    assert.equal(rangedProxy.headers.get('content-length'), '64');
    assert.equal(rangedProxy.headers.get('content-range'), `bytes 0-63/${fs.statSync(proxyPath).size}`);
    assert.equal((await rangedProxy.arrayBuffer()).byteLength, 64);
    const invalidProxyRange = await fetch(proxyUrl, { headers: { Range: `bytes=${fs.statSync(proxyPath).size + 1}-` } });
    assert.equal(invalidProxyRange.status, 416);
    assert.equal(invalidProxyRange.headers.get('content-range'), `bytes */${fs.statSync(proxyPath).size}`);
    await invalidProxyRange.arrayBuffer();
    assert.equal(audioAsset.metadata.sampleRate, 22050);
    assert.equal(audioAsset.metadata.channels, 1);
    assert.equal(audioAsset.metadata.bitsPerSample, 16);
    assert.equal(audioAsset.metadata.sampleFormat, 's16');
    assert.match(audioAsset.metadata.waveformUrl, /-waveform\.png$/);
  } finally {
    if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('3D indexing integration writes a versioned WebP target accepted by the renderer', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-model-preview-'));
  const thumbnails = path.join(directory, 'thumbnails');
  const previewRoot = path.join(thumbnails, 'asset-previews');
  const source = path.join(directory, 'triangle.obj');
  fs.writeFileSync(source, 'v -1 -1 0\nv 1 -1 0\nv 0 1 0\nf 1 2 3\n');
  try {
    const contentHash = await hashFile(source);
    const result = await createDerivedMedia(source, 'model3d', {}, {
      THUMBNAILS_DIR: thumbnails,
      ASSET_PREVIEWS_DIR: previewRoot,
      ASSET_PREVIEW_PIPELINE_VERSION: 'asset-preview-v1',
    }, contentHash);
    assert.match(result.modelPreviewUrl, /-asset-preview-v1-model\.webp$/);
    assert.equal(result.thumbnailUrl, result.modelPreviewUrl);
    const target = localThumbnailPath(thumbnails, result.modelPreviewUrl);
    assert.equal(fs.existsSync(target), true);
    const metadata = await sharp(fs.readFileSync(target)).metadata();
    assert.equal(metadata.format, 'webp');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('linked assets become explicitly missing without deleting their index or source by implication', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-linked-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const linkedPath = path.join(directory, 'outside.txt');
  fs.writeFileSync(linkedPath, 'linked source');
  const database = new ProjectDatabase(':memory:');
  try {
    const indexer = new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output }, database);
    await assert.rejects(indexer.indexLinkedFile(linkedPath, { canvasId: 'ghost-canvas' }), /Canvas 不存在/);
    const ghostIndexed = database.listAssets({ projectId: 'project-local', query: 'outside.txt' })[0];
    assert.ok(ghostIndexed);
    assert.equal(database.getAssetLineage(ghostIndexed.id).length, 0);
    database.ensureCanvas('canvas-linked', { nodes: [], edges: [] }, 'project-local');
    const asset = await indexer.indexLinkedFile(linkedPath, { canvasId: 'canvas-linked' });
    assert.equal(asset.storageMode, 'linked');
    assert.equal(asset.availability, 'available');
    assert.equal(asset.sourceUrl.includes(linkedPath), false);
    fs.unlinkSync(linkedPath);
    const result = await indexer.scan();
    const missing = database.getAsset(asset.id);
    assert.equal(result.availability.missing, 1);
    assert.equal(missing.availability, 'missing');
    assert.equal(missing.metadata.health, 'missing');
    assert.equal(database.getAssetLineage(asset.id)[0].sourceType, 'linked-file');
    fs.writeFileSync(linkedPath, 'restored source');
    const changedResult = await indexer.scan();
    assert.equal(changedResult.availability.sourceChanged, 1);
    assert.equal(changedResult.availability.restored, 0);
    assert.equal(database.getAsset(asset.id).availability, 'missing');
    assert.equal(database.getAsset(asset.id).metadata.availabilityNeedsReindex, true);
    fs.writeFileSync(linkedPath, 'linked source');
    const restoredResult = await indexer.scan();
    assert.equal(restoredResult.availability.restored, 1);
    assert.equal(database.getAsset(asset.id).availability, 'available');
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('corrupt 3D files stay indexed with an explicit corrupt availability state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-corrupt-3d-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(input, 'broken.glb'), Buffer.from('not-a-glb'));
  const database = new ProjectDatabase(':memory:');
  try {
    const result = await new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output }, database).scan();
    const asset = database.listAssets({ kind: 'model3d' })[0];
    assert.equal(result.failed, 0);
    assert.equal(asset.availability, 'corrupt');
    assert.equal(asset.metadata.health, 'corrupt');
    assert.match(asset.metadata.metadataError, /GLB|glTF|文件头/);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('asset indexer shares only the owning project scan and isolates project status and results', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-indexer-project-status-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const database = new ProjectDatabase(':memory:');
  try {
    const indexer = new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output }, database);
    const projectA = 'project/indexer-a';
    const projectB = 'project/indexer-b';

    const scanA = indexer.scan({ projectId: projectA, concurrency: 1 });
    const sameProjectScan = indexer.scan({ projectId: projectA, concurrency: 4 });
    const scanB = indexer.scan({ projectId: projectB, concurrency: 1 });
    assert.strictEqual(sameProjectScan, scanA, 'one project must share its exact owning promise');
    assert.notStrictEqual(scanB, scanA, 'different projects must never share a scan promise');
    assert.deepEqual(indexer.status(projectA), { projectId: projectA, running: true, lastResult: null });
    assert.deepEqual(indexer.status(projectB), { projectId: projectB, running: true, lastResult: null });

    const [resultA, resultB] = await Promise.all([scanA, scanB]);
    assert.equal(resultA.projectId, projectA);
    assert.equal(resultB.projectId, projectB);
    assert.equal(resultA.catalogRevision, 1);
    assert.equal(resultB.catalogRevision, 1);
    assert.deepEqual(
      { total: resultA.total, indexed: resultA.indexed, failed: resultA.failed },
      { total: 0, indexed: 0, failed: 0 },
    );
    assert.deepEqual(
      { total: resultB.total, indexed: resultB.indexed, failed: resultB.failed },
      { total: 0, indexed: 0, failed: 0 },
    );

    const statusA = indexer.status(projectA);
    const statusB = indexer.status(projectB);
    assert.equal(statusA.projectId, projectA);
    assert.equal(statusB.projectId, projectB);
    assert.equal(statusA.running, false);
    assert.equal(statusB.running, false);
    assert.strictEqual(statusA.lastResult, resultA);
    assert.strictEqual(statusB.lastResult, resultB);

    const secondScanA = indexer.scan({ projectId: projectA, concurrency: 1 });
    assert.notStrictEqual(secondScanA, scanA, 'a completed owning promise must be released');
    assert.equal(indexer.status(projectA).running, true);
    assert.equal(indexer.status(projectB).running, false);
    const secondResultA = await secondScanA;
    assert.equal(secondResultA.projectId, projectA);
    assert.strictEqual(indexer.status(projectA).lastResult, secondResultA);
    assert.strictEqual(indexer.status(projectB).lastResult, resultB);
  } finally {
    await database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('background asset indexer singleton is scoped to the ProjectDatabase instance', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-indexer-database-owner-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const config = { INPUT_DIR: input, OUTPUT_DIR: output };
  const databaseA = new ProjectDatabase(':memory:');
  const databaseB = new ProjectDatabase(':memory:');
  try {
    const pipelineA = { owner: 'pipeline-a' };
    const pipelineB = { owner: 'pipeline-b' };
    const indexerA = getBackgroundAssetIndexer(config, databaseA, pipelineA);
    const sameDatabase = getBackgroundAssetIndexer({ ...config }, databaseA, pipelineB);
    const indexerB = getBackgroundAssetIndexer(config, databaseB, pipelineB);

    assert.strictEqual(sameDatabase, indexerA);
    assert.notStrictEqual(indexerB, indexerA);
    assert.strictEqual(indexerA.database, databaseA);
    assert.strictEqual(indexerB.database, databaseB);
    assert.strictEqual(indexerA.previewPipeline, pipelineA);
    assert.strictEqual(indexerB.previewPipeline, pipelineB);
  } finally {
    await databaseA.close();
    await databaseB.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('asset indexer aborts a first-file SQLITE_FULL without publishing a successful scan result', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-indexer-first-full-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(input, 'a.txt'), 'first');
  fs.writeFileSync(path.join(input, 'b.txt'), 'tail');
  let indexCalls = 0;
  let availabilityReads = 0;
  const database = {
    listAssetAvailabilitySnapshots() {
      availabilityReads += 1;
      throw new Error('availability must not run after a fatal index write');
    },
  };
  const indexer = new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output }, database);
  const fatal = Object.assign(new Error(`SQLITE_FULL leaked path: ${directory}`), { code: 'SQLITE_FULL' });
  indexer.indexFile = async () => {
    indexCalls += 1;
    throw fatal;
  };
  try {
    let propagated = null;
    await assert.rejects(
      indexer.scan({ projectId: 'project/indexer-first-full', concurrency: 1 }),
      (error) => {
        propagated = error;
        return error === fatal;
      },
    );
    assert.equal(indexCalls, 1);
    assert.equal(availabilityReads, 0);
    assert.deepEqual(indexer.status('project/indexer-first-full'), {
      projectId: 'project/indexer-first-full',
      running: false,
      lastResult: null,
    });
    const mapped = mapProjectDatabaseStorageCapacityPublicError(propagated, { operation: 'asset.scan' });
    assert.equal(mapped.status, 507);
    assert.equal(mapped.body.code, 'project_database_storage_capacity_exceeded');
    assert.equal(mapped.body.reason, 'sqlite-full');
    assert.equal(mapped.body.error.includes(directory), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('asset indexer settles concurrent claimed workers after a late capacity failure and starts no tail work', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-indexer-late-full-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  for (let index = 0; index < 8; index += 1) {
    fs.writeFileSync(path.join(input, `${index}.txt`), String(index));
  }
  let availabilityReads = 0;
  const database = {
    listAssetAvailabilitySnapshots() {
      availabilityReads += 1;
      throw new Error('availability must not run after a fatal index write');
    },
  };
  const indexer = new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output }, database);
  const fatal = new ProjectDatabaseStorageCapacityError('sqlite-full', { operation: 'asset.index' });
  const started = [];
  const settled = [];
  let releaseFatal;
  let releaseSurvivors;
  const fatalGate = new Promise((resolve) => { releaseFatal = resolve; });
  const survivorGate = new Promise((resolve) => { releaseSurvivors = resolve; });
  indexer.indexFile = async () => {
    const ordinal = started.length + 1;
    started.push(ordinal);
    if (ordinal === 2) {
      await fatalGate;
      settled.push(ordinal);
      throw fatal;
    }
    await survivorGate;
    settled.push(ordinal);
  };
  try {
    const scan = indexer.scan({ projectId: 'project/indexer-late-full', concurrency: 3 });
    let scanSettled = false;
    scan.then(
      () => { scanSettled = true; },
      () => { scanSettled = true; },
    );
    for (let attempt = 0; attempt < 20 && started.length < 3; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(started.length, 3, 'the initial concurrency window must be claimed');

    releaseFatal();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 3, 'fatal observation must stop all new claims');
    assert.equal(scanSettled, false, 'scan must wait for already-started workers before rejecting');

    releaseSurvivors();
    await assert.rejects(scan, (error) => error === fatal);
    assert.deepEqual([...settled].sort((left, right) => left - right), [1, 2, 3]);
    assert.equal(availabilityReads, 0);
    const startedAfterRejection = started.length;
    const settledAfterRejection = settled.length;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, startedAfterRejection, 'no worker may claim tail work after rejection');
    assert.equal(settled.length, settledAfterRejection, 'no worker may write after rejection');
    assert.deepEqual(indexer.status('project/indexer-late-full'), {
      projectId: 'project/indexer-late-full',
      running: false,
      lastResult: null,
    });
  } finally {
    releaseFatal?.();
    releaseSurvivors?.();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('asset indexer treats quota and database-busy errors as fatal while ordinary file failures stay attributable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-asset-indexer-fatal-classification-'));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  fs.mkdirSync(input, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(input, 'a.txt'), 'a');
  fs.writeFileSync(path.join(input, 'b.txt'), 'b');
  const database = {
    listAssetAvailabilitySnapshots(projectId) {
      return { projectId, catalogRevision: 1, snapshots: [] };
    },
    syncAssetAvailabilityObservations() {
      throw new Error('empty availability must not open a writer');
    },
  };
  try {
    for (const phase of ['metadata', 'derived']) {
      const fatal = Object.assign(new Error(`private ${phase} ENOSPC detail`), { code: 'ENOSPC' });
      await assert.rejects(
        readStableAssetSource(path.join(input, 'a.txt'), phase === 'metadata' ? 'text' : 'image', {
          attempts: 1,
          readMetadata: async (_filename, _kind, stat) => {
            if (phase === 'metadata') throw fatal;
            return { size: stat.size, modifiedAt: stat.mtimeMs, health: 'ok' };
          },
          buildDerived: phase === 'derived' ? async () => { throw fatal; } : null,
        }),
        (error) => error === fatal,
        `${phase} capacity failures must not be downgraded to corrupt preview metadata`,
      );
    }

    for (const code of ['ENOSPC', 'EDQUOT', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED_SHAREDCACHE']) {
      const projectId = `project/indexer-${code.toLowerCase()}`;
      const indexer = new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output }, database);
      const fatal = Object.assign(new Error(`private ${code} detail`), { code });
      let calls = 0;
      indexer.indexFile = async () => {
        calls += 1;
        throw fatal;
      };
      await assert.rejects(indexer.scan({ projectId, concurrency: 1 }), (error) => error === fatal);
      assert.equal(calls, 1, `${code} must stop before the second file`);
      assert.equal(indexer.status(projectId).lastResult, null);
    }

    const ordinaryIndexer = new AssetIndexer({ INPUT_DIR: input, OUTPUT_DIR: output }, database);
    let ordinaryCalls = 0;
    ordinaryIndexer.indexFile = async () => {
      ordinaryCalls += 1;
      if (ordinaryCalls === 1) {
        throw Object.assign(new Error('attributable metadata parse failure'), { code: 'INVALID_MODEL_METADATA' });
      }
      return { id: 'indexed' };
    };
    const result = await ordinaryIndexer.scan({ projectId: 'project/indexer-ordinary-failure', concurrency: 1 });
    assert.deepEqual(
      { total: result.total, indexed: result.indexed, failed: result.failed },
      { total: 2, indexed: 1, failed: 1 },
    );
    assert.strictEqual(ordinaryIndexer.status('project/indexer-ordinary-failure').lastResult, result);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});
