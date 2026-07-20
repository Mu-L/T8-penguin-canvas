const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { ProjectDatabase } = require('../backend/src/services/projectDatabase');
const { AssetIndexer, resolveControlledOutputSource } = require('../backend/src/services/assetIndexer');
const { AssetPreviewPipeline } = require('../backend/src/services/assetPreviewPipeline');
const { resolveBundledFfmpeg } = require('../backend/src/providers/llmMedia');

function createConfig(directory) {
  const thumbnails = path.join(directory, 'thumbnails');
  const config = {
    INPUT_DIR: path.join(directory, 'input'),
    OUTPUT_DIR: path.join(directory, 'output'),
    THUMBNAILS_DIR: thumbnails,
    ASSET_PREVIEWS_DIR: path.join(thumbnails, 'asset-previews'),
    ASSET_PREVIEW_CONCURRENCY: 2,
    ASSET_PREVIEW_MAX_ATTEMPTS: 3,
    ASSET_PREVIEW_RETRY_BASE_MS: 10,
    ASSET_PREVIEW_PIPELINE_VERSION: 'asset-preview-v1',
  };
  [config.INPUT_DIR, config.OUTPUT_DIR, config.THUMBNAILS_DIR, config.ASSET_PREVIEWS_DIR]
    .forEach((item) => fs.mkdirSync(item, { recursive: true }));
  return config;
}

function createRun(database) {
  database.ensureCanvas('canvas-run-ingest', { nodes: [], edges: [] }, 'project-run-ingest');
  const run = database.createRun({
    projectId: 'project-run-ingest',
    canvasId: 'canvas-run-ingest',
    initiatorId: 'alice',
    status: 'running',
  });
  const nodeRun = database.createNodeRun({
    runId: run.id,
    nodeId: 'generator-node',
    originalNodeId: 'generator-node',
    status: 'running',
    inputSnapshot: {
      node: { id: 'generator-node', type: 'multi-media-generator', data: { prompt: 'controlled local output' } },
      upstreamNodes: [], incomingEdges: [],
    },
  });
  const attempt = database.createAttempt({
    nodeRunId: nodeRun.id,
    provider: 'local-test',
    model: 'four-media',
    status: 'running',
  });
  return { run, nodeRun, attempt };
}

test('Run output ingestion parses and hashes real image/video/audio/3D files before entering the shared preview queue', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-run-output-ingest-'));
  const config = createConfig(directory);
  const image = path.join(config.OUTPUT_DIR, 'run image.png');
  const video = path.join(config.OUTPUT_DIR, 'clip.mp4');
  const audio = path.join(config.OUTPUT_DIR, 'tone.wav');
  const model = path.join(config.OUTPUT_DIR, 'mesh.obj');
  await sharp({ create: { width: 41, height: 29, channels: 3, background: '#226688' } }).png().toFile(image);
  execFileSync(resolveBundledFfmpeg(), [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=4:duration=0.5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video,
  ], { windowsHide: true, timeout: 30_000 });
  execFileSync(resolveBundledFfmpeg(), [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25:sample_rate=16000',
    '-ac', '1', '-c:a', 'pcm_s16le', audio,
  ], { windowsHide: true, timeout: 30_000 });
  fs.writeFileSync(model, 'v -1 -2 -3\nv 4 5 6\nv 0 1 0\nf 1 2 3\n');

  const database = new ProjectDatabase(':memory:');
  const pipeline = new AssetPreviewPipeline(config, database, { autoStart: false, recover: false });
  // Keep this regression at the queue boundary; preview generation itself has
  // dedicated real-media tests and must not race these queued-state assertions.
  pipeline.schedulePump = () => {};
  const indexer = new AssetIndexer(config, database, { previewPipeline: pipeline });
  try {
    const { run, nodeRun, attempt } = createRun(database);
    const result = await indexer.recordRunOutputAssets({
      runId: run.id,
      nodeRunId: nodeRun.id,
      attemptId: attempt.id,
      outputs: [
        { kind: 'other', sourceUrl: '/files/output/run%20image.png?cache=1', filename: 'spoof.bin', mimeType: 'application/octet-stream' },
        { kind: 'video', sourceUrl: '/output/clip.mp4', filename: 'clip.mp4' },
        { kind: 'audio', sourceUrl: 'http://127.0.0.1:18766/files/output/tone.wav', filename: 'tone.wav' },
        { kind: 'model3d', sourceUrl: '/files/output/mesh.obj', filename: 'mesh.obj' },
      ],
    });

    assert.equal(result.assets.length, 4);
    const byKind = Object.fromEntries(result.assets.map((asset) => [asset.kind, asset]));
    assert.deepEqual(Object.keys(byKind).sort(), ['audio', 'image', 'model3d', 'video']);
    for (const [kind, filename] of [['image', image], ['video', video], ['audio', audio], ['model3d', model]]) {
      const asset = byKind[kind];
      assert.equal(asset.storageMode, 'managed');
      assert.equal(asset.availability, 'available');
      assert.match(asset.contentHash, /^[a-f0-9]{64}$/);
      assert.equal(fs.realpathSync.native(asset.managedPath), fs.realpathSync.native(filename));
      assert.equal(asset.metadata.previewStatus, 'queued');
      const jobs = database.listAssetPreviewJobs({ assetId: asset.id });
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].jobKind, `${kind}-preview`);
      assert.equal(jobs[0].status, 'queued');
      const lineage = database.getAssetLineage(asset.id);
      assert.equal(lineage.length, 1);
      assert.equal(lineage[0].sourceType, 'node-output');
      assert.equal(lineage[0].runId, run.id);
      assert.equal(lineage[0].attemptId, attempt.id);
    }
    assert.equal(byKind.image.filename, 'run image.png');
    assert.equal(byKind.image.mimeType, 'image/png');
    assert.equal(byKind.image.sourceUrl, '/files/output/run%20image.png');
    assert.equal(byKind.image.metadata.width, 41);
    assert.equal(byKind.video.metadata.videoCodec, 'h264');
    assert.equal(byKind.audio.metadata.sampleRate, 16000);
    assert.deepEqual(byKind.model3d.metadata.bounds, { min: [-1, -2, -3], max: [4, 5, 6] });
    assert.deepEqual(database.getNodeRun(nodeRun.id).outputRefs, result.assets.map((asset) => asset.id));
    assert.equal(database.getAssetPreviewJobStatus().counts.queued, 4);
  } finally {
    pipeline.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test('Run output ingestion marks missing controlled files honestly and never trusts remote or escaping path hints', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't8-run-output-boundary-'));
  const config = createConfig(directory);
  const database = new ProjectDatabase(':memory:');
  const indexer = new AssetIndexer(config, database, { previewPipeline: { enqueueAsset: () => { throw new Error('missing or remote outputs must not be queued'); } } });
  try {
    const { run, nodeRun, attempt } = createRun(database);
    assert.equal(resolveControlledOutputSource('/files/output/%2e%2e/secret.png', config).safe, false);
    const result = await indexer.recordRunOutputAssets({
      runId: run.id,
      nodeRunId: nodeRun.id,
      attemptId: attempt.id,
      outputs: [
        { kind: 'image', sourceUrl: '/files/output/not-yet.png', filename: 'not-yet.png' },
        {
          kind: 'image', sourceUrl: 'https://cdn.example/result.png', filename: 'remote.png',
          managedPath: path.join(config.OUTPUT_DIR, 'forged.png'), contentHash: 'f'.repeat(64),
          storageMode: 'managed', availability: 'available',
        },
        { kind: 'image', sourceUrl: '/files/output/%2e%2e/secret.png', filename: 'escape.png', managedPath: path.join(directory, 'secret.png') },
        { kind: 'image', sourceUrl: '/files/input/not-an-output.png', filename: 'input.png' },
      ],
    });

    const missing = result.assets.find((asset) => asset.sourceUrl === '/files/output/not-yet.png');
    const remote = result.assets.find((asset) => asset.sourceUrl === 'https://cdn.example/result.png');
    const escaped = result.assets.find((asset) => asset.filename === 'escape.png');
    const uncontrolled = result.assets.find((asset) => asset.filename === 'input.png');
    assert.equal(missing.storageMode, 'managed');
    assert.equal(missing.availability, 'missing');
    assert.equal(missing.contentHash, null);
    assert.equal(missing.metadata.health, 'missing');
    assert.equal(path.resolve(missing.managedPath), path.join(fs.realpathSync.native(config.OUTPUT_DIR), 'not-yet.png'));
    assert.equal(remote.storageMode, 'remote');
    assert.equal(remote.availability, 'unverified');
    assert.equal(remote.managedPath, null);
    assert.equal(remote.contentHash, null);
    assert.equal(escaped.storageMode, 'linked');
    assert.equal(escaped.availability, 'unverified');
    assert.equal(escaped.managedPath, null);
    assert.equal(uncontrolled.storageMode, 'linked');
    assert.equal(uncontrolled.availability, 'unverified');
    assert.equal(database.getAssetPreviewJobStatus().counts.queued, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});
