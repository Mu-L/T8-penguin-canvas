const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  SEMANTIC_MODEL_IDS,
  getPublicSemanticModelManifest,
  getTrustedSemanticModelSpec,
} = require('../backend/src/services/assetSemanticModels');
const {
  AssetSemanticWorker,
  cleanupSemanticModelOrphans,
  hashFileSha256,
  sanitizeSemanticError,
  semanticChildEnv,
} = require('../backend/src/services/assetSemanticWorker');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'tools', 'asset-semantic', 'semantic_runner.py');
const EMBEDDING_MODEL = SEMANTIC_MODEL_IDS.EMBEDDING_MULTILINGUAL_MINILM_L12_V2;
const CAPTION_MODEL = SEMANTIC_MODEL_IDS.CAPTION_BLIP_BASE;
const OCR_MODEL = SEMANTIC_MODEL_IDS.OCR_TROCR_SMALL_PRINTED;

function bundledPython() {
  const candidates = [
    path.join(ROOT, 'tools', 'remove-ai-watermarks-runtime', 'python', 'python.exe'),
    path.join(ROOT, 'runtime-cache', 'remove-ai-watermarks', 'python', 'python.exe'),
    process.platform === 'win32' ? '' : '/usr/bin/python3',
  ].filter(Boolean);
  return candidates.find((filename) => fs.existsSync(filename)) || '';
}

function createDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}

function writeFakeWorker(directory) {
  const filename = path.join(directory, 'fake_semantic_worker.py');
  fs.writeFileSync(filename, String.raw`
import argparse
import json
import os
from pathlib import Path
import sys
import time

MODELS = [
    "caption-blip-base",
    "embedding-multilingual-minilm-l12-v2",
    "ocr-trocr-small-printed",
]

parser = argparse.ArgumentParser()
parser.add_argument("--worker", action="store_true")
parser.add_argument("--probe", action="store_true")
parser.add_argument("--download", action="store_true")
parser.add_argument("--model-root", default="")
parser.add_argument("--model-id", default="")
parser.add_argument("--staging-dir", default="")
args = parser.parse_args()

if args.probe:
    print(json.dumps({"ok": True, "directClasses": True, "modelIds": MODELS, "protocolVersion": 1}))
    raise SystemExit(0)

if args.download:
    staging = Path(args.staging_dir)
    staging.mkdir(parents=True, exist_ok=True)
    (staging / "model.safetensors").write_bytes(b"deliberately-too-small")
    print(json.dumps({
        "ok": True,
        "result": {
            "modelId": args.model_id,
            "revision": "e8f8c211226b894fcb81acc59f3b34ba3efd5f42",
            "weightSize": 470641600,
            "weightSha256": "eaa086f0ffee582aeb45b36e34cdd1fe2d6de2bef61f8a559a1bbc9bd955917b",
        },
    }))
    raise SystemExit(0)

sequence = 0
for line in sys.stdin:
    request = json.loads(line)
    request_id = request["id"]
    operation = request.get("op")
    if operation == "unload":
        response = {"id": request_id, "ok": True, "result": {"unloaded": True}}
    elif operation == "execute":
        sequence += 1
        text = request.get("text", "")
        if text == "__hang__":
            time.sleep(60)
            continue
        if text == "__error__":
            response = {
                "id": request_id,
                "ok": False,
                "error": {
                    "code": "fake-semantic-error",
                    "message": "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA at C:\\Users\\Alice\\private\\model.bin",
                },
            }
        else:
            if text == "__slow__":
                time.sleep(0.08)
            response = {
                "id": request_id,
                "ok": True,
                "result": {
                    "task": request.get("task"),
                    "text": text,
                    "dimension": 384,
                    "textLength": len(text),
                    "vector": (
                        [0.0] * 10
                        if text == "__invalid_vector__"
                        else (([1.0, 0.0] if sequence % 2 == 1 else [0.0, 1.0]) + ([0.0] * 382))
                    ),
                    "pid": os.getpid(),
                    "sequence": sequence,
                },
            }
    else:
        response = {"id": request_id, "ok": True, "result": {"ready": True}}
    payload = json.dumps(response, separators=(",", ":")) + "\n"
    midpoint = max(1, len(payload) // 2)
    sys.stdout.write(payload[:midpoint])
    sys.stdout.flush()
    time.sleep(0.01)
    sys.stdout.write(payload[midpoint:])
    sys.stdout.flush()
`, 'utf8');
  return filename;
}

function createFakeWorker(options = {}) {
  const python = bundledPython();
  if (!python) throw new Error('bundled Python runtime unavailable');
  const directory = createDirectory('t8-semantic-worker-');
  const runnerPath = writeFakeWorker(directory);
  const worker = new AssetSemanticWorker({
    BASE_DIR: ROOT,
    DATA_DIR: path.join(directory, 'data'),
    IS_PACKAGED: false,
  }, {
    pythonCommand: python,
    runnerPath,
    modelRoot: path.join(directory, 'models'),
    executeTimeoutMs: options.executeTimeoutMs || 2_000,
    modelVerifier: async () => ({ installed: true, verified: true }),
  });
  return { directory, worker };
}

test('fixed registry exposes only safe public fields and exact pinned download totals', () => {
  const manifest = getPublicSemanticModelManifest();
  assert.deepEqual(manifest.map((model) => model.modelId), [
    'caption-blip-base',
    'ocr-trocr-small-printed',
    'embedding-multilingual-minilm-l12-v2',
  ]);
  assert.deepEqual(manifest.map((model) => model.downloadBytes), [
    990_769_234,
    247_200_667,
    499_557_407,
  ]);
  assert.equal(manifest.find((model) => model.task === 'embedding').embeddingDimension, 384);
  for (const model of manifest) {
    assert.match(model.revision, /^[a-f0-9]{40}$/);
    assert.deepEqual(
      Object.keys(model).sort(),
      Object.keys(model).filter((key) => !/repo|url|path|filename|weight|sha/i.test(key)).sort(),
    );
  }
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /Salesforce|microsoft\/trocr|sentence-transformers|pytorch_model|safetensors|sha256|https?:/i);
  assert.throws(
    () => getTrustedSemanticModelSpec('https://evil.example/model'),
    (error) => error?.code === 'asset-semantic-model-not-allowed',
  );
  assert.throws(
    () => getTrustedSemanticModelSpec(EMBEDDING_MODEL, 'caption'),
    (error) => error?.code === 'asset-semantic-model-task-mismatch',
  );

  const trusted = getTrustedSemanticModelSpec(EMBEDDING_MODEL);
  assert.deepEqual(trusted.weight, {
    filename: 'model.safetensors',
    size: 470_641_600,
    sha256: 'eaa086f0ffee582aeb45b36e34cdd1fe2d6de2bef61f8a559a1bbc9bd955917b',
  });
  const runnerSource = fs.readFileSync(RUNNER, 'utf8');
  for (const model of manifest) {
    const spec = getTrustedSemanticModelSpec(model.modelId);
    assert.equal(runnerSource.includes(JSON.stringify(model.modelId)), true);
    assert.equal(runnerSource.includes(JSON.stringify(spec.repository)), true);
    assert.equal(runnerSource.includes(JSON.stringify(spec.revision)), true);
    assert.equal(runnerSource.includes(JSON.stringify(spec.weight.filename)), true);
    assert.equal(runnerSource.includes(JSON.stringify(spec.weight.sha256)), true);
    assert.match(spec.weight.sha256, /^[a-f0-9]{64}$/, 'every pinned weight digest must be a complete SHA-256');
    assert.equal(runnerSource.includes(spec.weight.size.toLocaleString('en-US').replaceAll(',', '_')), true);
  }
});

test('file hashing releases the verified file before its promise resolves', async () => {
  const directory = createDirectory('t8-semantic-hash-close-');
  const source = path.join(directory, 'source.bin');
  const destination = path.join(directory, 'renamed.bin');
  try {
    fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 0x5a));
    const digest = await hashFileSha256(source);
    assert.match(digest, /^[a-f0-9]{64}$/);
    fs.renameSync(source, destination);
    assert.equal(fs.existsSync(destination), true);
  } finally {
    removeDirectory(directory);
  }
});

test('worker defaults to no model download and public status never leaks cache paths', () => {
  const directory = createDirectory('t8-semantic-status-');
  const configuredModelRoot = path.join(directory, 'configured-semantic-models');
  const worker = new AssetSemanticWorker({ BASE_DIR: ROOT, DATA_DIR: path.join(directory, 'data'), IS_PACKAGED: false }, {
    modelRoot: path.join(directory, 'private-model-cache'),
  });
  const configuredWorker = new AssetSemanticWorker({
    BASE_DIR: ROOT,
    DATA_DIR: path.join(directory, 'other-data'),
    ASSET_SEMANTIC_MODELS_DIR: configuredModelRoot,
    IS_PACKAGED: false,
  });
  try {
    const statuses = worker.listModelStatuses();
    assert.equal(statuses.length, 3);
    assert.equal(statuses.every((status) => status.installed === false && status.state === 'not-installed'), true);
    assert.equal(fs.readdirSync(path.join(directory, 'private-model-cache')).length, 0, 'constructor must not download models');
    const serialized = JSON.stringify(statuses);
    assert.equal(serialized.includes(directory), false);
    assert.doesNotMatch(serialized, /repo|cachePath|modelPath|stagingDir|https?:/i);
    const progress = worker.getDownloadProgress(EMBEDDING_MODEL);
    assert.deepEqual(progress, {
      modelId: EMBEDDING_MODEL,
      state: 'not-installed',
      downloadedBytes: 0,
      totalBytes: 499_557_407,
      percent: 0,
    });
    assert.equal(fs.existsSync(configuredModelRoot), true, 'shared config model root must take precedence over DATA_DIR fallback');
    assert.equal(configuredWorker.modelRoot, path.resolve(configuredModelRoot));
  } finally {
    worker.close();
    configuredWorker.close();
    removeDirectory(directory);
  }
});

test('startup orphan cleanup is TTL bounded, owner aware, and refuses symlink escape', async () => {
  const directory = createDirectory('t8-semantic-orphans-');
  const modelRoot = path.join(directory, 'models');
  const downloadsRoot = path.join(modelRoot, '.downloads');
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(downloadsRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside-must-survive', 'utf8');
  const names = {
    oldDownload: `${EMBEDDING_MODEL}-11111111-1111-4111-8111-111111111111`,
    recentDownload: `${EMBEDDING_MODEL}-22222222-2222-4222-8222-222222222222`,
    ownedDownload: `${EMBEDDING_MODEL}-33333333-3333-4333-8333-333333333333`,
    linkedDownload: `${EMBEDDING_MODEL}-44444444-4444-4444-8444-444444444444`,
    replaced: `.replaced-${OCR_MODEL}-55555555-5555-4555-8555-555555555555`,
    removed: `.removed-${CAPTION_MODEL}-66666666-6666-4666-8666-666666666666`,
  };
  const oldPaths = [
    path.join(downloadsRoot, names.oldDownload),
    path.join(downloadsRoot, names.ownedDownload),
    path.join(modelRoot, names.replaced),
    path.join(modelRoot, names.removed),
  ];
  for (const target of oldPaths) {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'payload.bin'), 'orphan', 'utf8');
  }
  fs.writeFileSync(path.join(downloadsRoot, names.ownedDownload, '.t8-semantic-download-owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');
  const recentPath = path.join(downloadsRoot, names.recentDownload);
  fs.mkdirSync(recentPath, { recursive: true });
  fs.writeFileSync(path.join(recentPath, 'payload.bin'), 'recent', 'utf8');
  const linkedPath = path.join(downloadsRoot, names.linkedDownload);
  fs.symlinkSync(outside, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');
  const now = Date.now();
  const oldDate = new Date(now - (2 * 60 * 60_000));
  for (const target of oldPaths) fs.utimesSync(target, oldDate, oldDate);
  const warnings = [];
  try {
    const result = cleanupSemanticModelOrphans(modelRoot, {
      now,
      ttlMs: 60_000,
      onWarning: (message) => warnings.push(message),
    });
    assert.equal(result.removed, 3, 'old unowned staging/replaced/removed directories must be reclaimed');
    assert.equal(fs.existsSync(path.join(downloadsRoot, names.oldDownload)), false);
    assert.equal(fs.existsSync(path.join(modelRoot, names.replaced)), false);
    assert.equal(fs.existsSync(path.join(modelRoot, names.removed)), false);
    assert.equal(fs.existsSync(recentPath), true, 'recent staging must be preserved');
    assert.equal(fs.existsSync(path.join(downloadsRoot, names.ownedDownload)), true, 'live owner must preserve old staging');
    assert.equal(fs.lstatSync(linkedPath).isSymbolicLink(), true, 'link itself must not be traversed or deleted');
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside-must-survive');

    const poisonedRoot = path.join(directory, 'poisoned-models');
    fs.mkdirSync(poisonedRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(poisonedRoot, '.downloads'), process.platform === 'win32' ? 'junction' : 'dir');
    const poisonedWorker = new AssetSemanticWorker({ BASE_DIR: ROOT, DATA_DIR: directory, IS_PACKAGED: false }, {
      modelRoot: poisonedRoot,
    });
    try {
      await assert.rejects(
        poisonedWorker.downloadModel(EMBEDDING_MODEL),
        (error) => error?.code === 'asset-semantic-model-link-rejected',
      );
    } finally {
      poisonedWorker.close();
    }
  } finally {
    removeDirectory(directory);
  }
});

test('model status is unverified after restart and same-size mutation cannot remain installed', async () => {
  const directory = createDirectory('t8-semantic-verification-');
  const modelRoot = path.join(directory, 'models');
  const spec = getTrustedSemanticModelSpec(OCR_MODEL);
  const modelDirectory = path.join(modelRoot, OCR_MODEL);
  const weightPath = path.join(modelDirectory, spec.weight.filename);
  fs.mkdirSync(modelDirectory, { recursive: true });
  const descriptor = fs.openSync(weightPath, 'w');
  fs.closeSync(descriptor);
  fs.truncateSync(weightPath, spec.weight.size);
  fs.writeFileSync(path.join(modelDirectory, '.t8-semantic-model.json'), `${JSON.stringify({
    format: 1,
    modelId: OCR_MODEL,
    task: spec.task,
    revision: spec.revision,
    weightSize: spec.weight.size,
    weightSha256: spec.weight.sha256,
  })}\n`, 'utf8');
  let expectedDigest = spec.weight.sha256;
  const createWorker = () => new AssetSemanticWorker({ BASE_DIR: ROOT, DATA_DIR: directory, IS_PACKAGED: false }, {
    modelRoot,
    modelHasher: async () => expectedDigest,
  });
  const first = createWorker();
  try {
    const cold = first.getModelStatus(OCR_MODEL);
    assert.equal(cold.installed, false);
    assert.equal(cold.verified, false);
    assert.equal(cold.state, 'verifying');
    assert.equal(cold.percent, 99);
    assert.equal((await first.verifyModel(OCR_MODEL)).installed, true);
  } finally {
    first.close();
  }
  const restarted = createWorker();
  try {
    assert.deepEqual(
      (({ installed, verified, state }) => ({ installed, verified, state }))(restarted.getModelStatus(OCR_MODEL)),
      { installed: false, verified: false, state: 'verifying' },
      'verification cache must not survive process restart',
    );
    assert.equal((await restarted.verifyModel(OCR_MODEL)).verified, true);
    const file = fs.openSync(weightPath, 'r+');
    try {
      fs.writeSync(file, Buffer.from([0x7f]), 0, 1, 0);
    } finally {
      fs.closeSync(file);
    }
    const mutated = restarted.getModelStatus(OCR_MODEL);
    assert.equal(mutated.installed, false);
    assert.equal(mutated.verified, false);
    assert.equal(mutated.state, 'verifying');
    expectedDigest = '0'.repeat(64);
    await assert.rejects(
      restarted.verifyModel(OCR_MODEL),
      (error) => error?.code === 'asset-semantic-model-hash-mismatch',
    );
    assert.equal(restarted.getModelStatus(OCR_MODEL).installed, false);
  } finally {
    restarted.close();
    removeDirectory(directory);
  }
});

test('persistent JSONL worker accepts chunked frames and serializes requests on one process', async (t) => {
  if (!bundledPython()) return t.skip('bundled Python runtime unavailable');
  const { directory, worker } = createFakeWorker();
  try {
    const [first, second] = await Promise.all([
      worker.execute({ modelId: EMBEDDING_MODEL, task: 'embedding', text: '__slow__' }),
      worker.execute({ modelId: EMBEDDING_MODEL, task: 'embedding', text: 'second request' }),
    ]);
    assert.deepEqual(first.vector.slice(0, 2), [1, 0]);
    assert.deepEqual(second.vector.slice(0, 2), [0, 1], 'second request must be sequence 2 in the same worker');
    assert.equal(first.vector.length, 384);
    assert.equal(second.textLength, 'second request'.length);
  } finally {
    worker.close();
    removeDirectory(directory);
  }
});

test('timeout kills the stuck worker and a later request starts a clean worker', async (t) => {
  if (!bundledPython()) return t.skip('bundled Python runtime unavailable');
  const { directory, worker } = createFakeWorker({ executeTimeoutMs: 2_000 });
  try {
    await assert.rejects(
      worker.execute(
        { modelId: EMBEDDING_MODEL, task: 'embedding', text: '__hang__' },
        { timeoutMs: 120 },
      ),
      (error) => error?.code === 'asset-semantic-timeout' && !String(error.message).includes(directory),
    );
    const recovered = await worker.execute({ modelId: EMBEDDING_MODEL, task: 'embedding', text: 'after timeout' });
    assert.equal(recovered.textLength, 'after timeout'.length);
    assert.deepEqual(recovered.vector.slice(0, 2), [1, 0], 'replacement process must start with clean state');
  } finally {
    worker.close();
    removeDirectory(directory);
  }
});

test('abort kills active inference, rejects as AbortError and does not poison the next request', async (t) => {
  if (!bundledPython()) return t.skip('bundled Python runtime unavailable');
  const { directory, worker } = createFakeWorker({ executeTimeoutMs: 5_000 });
  try {
    const controller = new AbortController();
    const pending = worker.execute(
      { modelId: EMBEDDING_MODEL, task: 'embedding', text: '__hang__' },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(
      pending,
      (error) => error?.name === 'AbortError' && error?.code === 'asset-semantic-aborted',
    );
    const recovered = await worker.execute({ modelId: EMBEDDING_MODEL, task: 'embedding', text: 'after abort' });
    assert.deepEqual(recovered.vector.slice(0, 2), [1, 0]);
  } finally {
    worker.close();
    removeDirectory(directory);
  }
});

test('semantic child environment is least-privilege and never forwards provider or proxy credentials', () => {
  const keys = [
    'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'T8_TEST_TOKEN', 'HF_TOKEN', 'PYTHONPATH',
    'LD_PRELOAD', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'HF_HOME',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.OPENAI_API_KEY = 'sk-semantic-child-must-not-see';
    process.env.AWS_SECRET_ACCESS_KEY = 'cloud-secret-must-not-see';
    process.env.T8_TEST_TOKEN = 'application-token-must-not-see';
    process.env.HF_TOKEN = 'hf-token-must-not-see';
    process.env.PYTHONPATH = 'C:\\malicious-python-injection';
    process.env.LD_PRELOAD = '/tmp/malicious.so';
    process.env.HTTP_PROXY = 'http://proxy.local:8080';
    process.env.HTTPS_PROXY = 'http://user:proxy-secret@proxy.local:8443';
    process.env.NO_PROXY = '127.0.0.1,localhost';
    process.env.HF_HOME = 'C:\\bounded-semantic-cache';
    const online = semanticChildEnv({ offline: false });
    const normalized = Object.fromEntries(Object.entries(online).map(([key, value]) => [key.toUpperCase(), value]));
    for (const key of [
      'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'T8_TEST_TOKEN', 'HF_TOKEN', 'PYTHONPATH', 'LD_PRELOAD', 'HTTPS_PROXY',
    ]) assert.equal(Object.hasOwn(normalized, key), false, `${key} must not reach the Python child`);
    assert.equal(normalized.HTTP_PROXY, 'http://proxy.local:8080/');
    assert.equal(normalized.NO_PROXY, '127.0.0.1,localhost');
    assert.equal(normalized.HF_HOME, 'C:\\bounded-semantic-cache');
    assert.equal(normalized.HF_HUB_DISABLE_TELEMETRY, '1');
    assert.equal(normalized.PYTHONDONTWRITEBYTECODE, '1');

    const offline = Object.fromEntries(Object.entries(semanticChildEnv({ offline: true }))
      .map(([key, value]) => [key.toUpperCase(), value]));
    assert.equal(offline.HF_HUB_OFFLINE, '1');
    assert.equal(offline.TRANSFORMERS_OFFLINE, '1');
    assert.equal(Object.hasOwn(offline, 'HTTP_PROXY'), false);
    assert.equal(Object.hasOwn(offline, 'NO_PROXY'), false);
  } finally {
    for (const key of keys) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('worker rejects model supply-chain overrides and sanitizes child errors', async (t) => {
  if (!bundledPython()) return t.skip('bundled Python runtime unavailable');
  const { directory, worker } = createFakeWorker();
  try {
    await assert.rejects(
      worker.execute({
        modelId: EMBEDDING_MODEL,
        task: 'embedding',
        text: 'hello',
        repo: 'evil/repo',
      }),
      (error) => error?.code === 'asset-semantic-request-field-not-allowed',
    );
    await assert.rejects(
      worker.downloadModel(EMBEDDING_MODEL, { modelPath: directory }),
      (error) => error?.code === 'asset-semantic-request-field-not-allowed',
    );
    await assert.rejects(
      worker.execute({ modelId: CAPTION_MODEL, task: 'caption', sourcePath: 'relative-source.png' }),
      (error) => error?.code === 'asset-semantic-source-invalid',
    );
    await assert.rejects(
      worker.execute({ modelId: EMBEDDING_MODEL, task: 'embedding', text: '__error__' }),
      (error) => error?.code === 'fake-semantic-error'
        && !String(error.message).includes('sk-')
        && !String(error.message).includes('Alice')
        && !String(error.message).includes(directory),
    );
    await assert.rejects(
      worker.execute({ modelId: EMBEDDING_MODEL, task: 'embedding', text: '__invalid_vector__' }),
      (error) => error?.code === 'asset-semantic-result-invalid',
    );
    const recovered = await worker.execute({ modelId: EMBEDDING_MODEL, task: 'embedding', text: 'valid again' });
    assert.deepEqual(recovered.vector.slice(0, 2), [1, 0], 'invalid output must retire the compromised worker');
    const safe = sanitizeSemanticError(new Error(`sk-${'Z'.repeat(32)} at ${directory}\\secret.bin`));
    assert.equal(safe.message.includes('sk-'), false);
    assert.equal(safe.message.includes(directory), false);
  } finally {
    worker.close();
    removeDirectory(directory);
  }
});

test('download process cannot install a snapshot whose fixed weight size is wrong', async (t) => {
  if (!bundledPython()) return t.skip('bundled Python runtime unavailable');
  const { directory, worker } = createFakeWorker();
  const observed = [];
  try {
    await assert.rejects(
      worker.downloadModel(EMBEDDING_MODEL, { onProgress: (progress) => observed.push(progress) }),
      (error) => error?.code === 'asset-semantic-download-size-mismatch'
        && !String(error.message).includes(directory),
    );
    assert.equal(observed.some((progress) => progress.state === 'downloading'), true);
    assert.equal(observed.at(-1).state, 'failed');
    assert.equal(observed.every((progress) => progress.downloadedBytes <= progress.totalBytes), true);
    const status = worker.getModelStatus(EMBEDDING_MODEL);
    assert.equal(status.installed, false);
    assert.equal(status.state, 'failed');
    assert.equal(JSON.stringify(status).includes(directory), false);
    const downloadsRoot = path.join(worker.modelRoot, '.downloads');
    const remaining = fs.existsSync(downloadsRoot) ? fs.readdirSync(downloadsRoot) : [];
    assert.deepEqual(remaining, [], 'failed staging snapshot must be removed');
  } finally {
    worker.close();
    removeDirectory(directory);
  }
});

test('fixed-weight downloader validates a real local Range transfer and exact snapshot files', (t) => {
  const python = bundledPython();
  if (!python) return t.skip('bundled Python runtime unavailable');
  const script = [
    'import http.server,importlib.util,json,pathlib,re,sys,tempfile,threading',
    'from types import SimpleNamespace',
    'import httpx',
    'spec=importlib.util.spec_from_file_location("semantic_runner",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'payload=bytes((index * 17) % 251 for index in range(97))',
    'observed=[]',
    'class Handler(http.server.BaseHTTPRequestHandler):',
    '    protocol_version="HTTP/1.1"',
    '    def log_message(self, *_args): pass',
    '    def do_GET(self):',
    '        value=self.headers.get("Range", "")',
    '        match=re.fullmatch(r"bytes=(\\d+)-(\\d+)", value)',
    '        if match is None:',
    '            self.send_error(400)',
    '            return',
    '        start,end=map(int,match.groups())',
    '        body=payload[start:end+1]',
    '        observed.append([start,end])',
    '        self.send_response(206)',
    '        self.send_header("Content-Range",f"bytes {start}-{end}/{len(payload)}")',
    '        self.send_header("Content-Length",str(len(body)))',
    '        self.send_header("Connection","close")',
    '        self.end_headers()',
    '        self.wfile.write(body)',
    'server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler)',
    'thread=threading.Thread(target=server.serve_forever,daemon=True)',
    'thread.start()',
    'result={"ok":False}',
    'try:',
    '    module.WEIGHT_RANGE_BYTES=13',
    '    module.WEIGHT_DOWNLOAD_WORKERS=4',
    '    module.WEIGHT_DOWNLOAD_ATTEMPTS=1',
    '    local_url=f"http://127.0.0.1:{server.server_port}/weight.bin"',
    '    original_url=module._official_weight_url',
    '    original_validate=module._validate_weight_response',
    '    module._official_weight_url=lambda _spec: local_url',
    '    def validate_local(response,start,end,total):',
    '        wrapped=SimpleNamespace(status_code=response.status_code,url=httpx.URL("https://cas-bridge.xethub.hf.co/weight.bin"),headers=response.headers)',
    '        return original_validate(wrapped,start,end,total)',
    '    module._validate_weight_response=validate_local',
    '    config=b"{}"',
    '    tiny={"repository":"owner/model","revision":"a"*40,"download_bytes":len(payload)+len(config),"weight":{"filename":"weight.bin","size":len(payload),"sha256":"0"*64},"allow_patterns":["config.json","weight.bin"]}',
    '    with tempfile.TemporaryDirectory(prefix="t8-semantic-range-") as temporary:',
    '        staging=pathlib.Path(temporary)',
    '        (staging/"config.json").write_bytes(config)',
    '        parts=staging/".t8-weight-parts"',
    '        parts.mkdir()',
    '        (parts/"part-0000.bin").write_bytes(payload[:5])',
    '        module._download_fixed_weight(staging,tiny)',
    '        module._validate_download_snapshot(staging,tiny)',
    '        assembled=(staging/"weight.bin").read_bytes()',
    '        no_parts=not (staging/".t8-weight-parts").exists() and not (staging/".weight.bin.assembling").exists()',
    '        (staging/"unexpected.bin").write_bytes(b"extra")',
    '        extra_code=""',
    '        try: module._validate_download_snapshot(staging,tiny)',
    '        except Exception as error: extra_code=getattr(error,"code","")',
    '    def checked(status=206,url="https://huggingface.co/owner/model/resolve/"+("a"*40)+"/weight.bin",content_range="bytes 0-3/97",content_length="4"):',
    '        response=SimpleNamespace(status_code=status,url=httpx.URL(url),headers={"content-range":content_range,"content-length":content_length})',
    '        try:',
    '            original_validate(response,0,3,97)',
    '            return "ok"',
    '        except Exception as error: return getattr(error,"code","")',
    '    validations={"valid":checked(),"status":checked(status=200),"range":checked(content_range="bytes 1-4/97"),"host":checked(url="https://evil.example/weight.bin"),"length":checked(content_length="5")}',
    '    safe=module._safe_error_message("GET https://user:secret@example.invalid/private/model.bin?token=abcdef failed")',
    '    planned=[list(item) for item in module._plan_download_ranges(len(payload),13)]',
    '    expected_requests=[[5,planned[0][1]],*planned[1:]]',
    '    result={"ok":assembled==payload,"noParts":no_parts,"ranges":sorted(observed),"expectedRequests":expected_requests,"resumed":[5,planned[0][1]] in observed,"extraCode":extra_code,"validations":validations,"urlRedacted":"https://" not in safe and "example.invalid" not in safe and "secret" not in safe}',
    'finally:',
    '    server.shutdown()',
    '    server.server_close()',
    '    thread.join(timeout=5)',
    'print(json.dumps(result,separators=(",",":")))',
  ].join('\n');
  const checked = spawnSync(python, ['-c', script, RUNNER], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const result = JSON.parse(checked.stdout.trim());
  assert.equal(result.ok, true);
  assert.equal(result.noParts, true, 'segments and assembly temporary file must be reclaimed');
  assert.deepEqual(result.ranges, result.expectedRequests, 'every real 206 response must match one fixed or resumed range');
  assert.equal(result.resumed, true, 'an interrupted segment must resume from its verified byte offset');
  assert.equal(result.extraCode, 'asset-semantic-download-files-mismatch');
  assert.deepEqual(result.validations, {
    valid: 'ok',
    status: 'asset-semantic-download-range-invalid',
    range: 'asset-semantic-download-range-invalid',
    host: 'asset-semantic-download-host-invalid',
    length: 'asset-semantic-download-range-invalid',
  });
  assert.equal(result.urlRedacted, true);
});

test('semantic Python runner has valid syntax and probes the actual bundled direct classes without downloads', (t) => {
  const python = bundledPython();
  if (!python) return t.skip('bundled Python runtime unavailable');
  const syntax = spawnSync(python, [
    '-c',
    'import pathlib,sys; p=pathlib.Path(sys.argv[1]); compile(p.read_text(encoding="utf-8"), str(p), "exec")',
    RUNNER,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

  const downloadRuntime = spawnSync(python, [
    '-c',
    [
      'import importlib.util,json,os,sys',
      'spec=importlib.util.spec_from_file_location("semantic_runner",sys.argv[1])',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'module._configure_download_runtime()',
      'from huggingface_hub import constants',
      'print(json.dumps({"disableXet":constants.HF_HUB_DISABLE_XET,"offline":os.environ.get("HF_HUB_OFFLINE"),"transformersOffline":os.environ.get("TRANSFORMERS_OFFLINE"),"highPerformance":os.environ.get("HF_XET_HIGH_PERFORMANCE"),"ranges":module._plan_download_ranges(35,16),"weightUrl":module._official_weight_url(module.MODEL_SPECS["caption-blip-base"])}))',
    ].join(';'),
    RUNNER,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_XET_HIGH_PERFORMANCE: '1',
    },
  });
  assert.equal(downloadRuntime.status, 0, downloadRuntime.stderr || downloadRuntime.stdout);
  assert.deepEqual(JSON.parse(downloadRuntime.stdout.trim()), {
    disableXet: true,
    offline: null,
    transformersOffline: null,
    highPerformance: null,
    ranges: [[0, 15], [16, 31], [32, 34]],
    weightUrl: 'https://huggingface.co/Salesforce/blip-image-captioning-base/resolve/82a37760796d32b1411fe092ab5d4e227313294b/pytorch_model.bin',
  });

  const stagingPreflightRoot = createDirectory('t8-semantic-staging-preflight-');
  const stagingDirectory = path.join(stagingPreflightRoot, 'staging');
  const outsideDirectory = path.join(stagingPreflightRoot, 'outside');
  fs.mkdirSync(stagingDirectory, { recursive: true });
  fs.mkdirSync(outsideDirectory, { recursive: true });
  fs.writeFileSync(path.join(outsideDirectory, 'sentinel.txt'), 'outside', 'utf8');
  const ownerPath = path.join(stagingDirectory, '.t8-semantic-download-owner.json');
  const preflightScript = [
    'import importlib.util,json,pathlib,sys',
    'spec=importlib.util.spec_from_file_location("semantic_runner",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'result={"ok":True}',
    'try: module._validate_download_staging(pathlib.Path(sys.argv[2]))',
    'except Exception as error: result={"ok":False,"code":getattr(error,"code","")}',
    'print(json.dumps(result))',
  ].join('\n');
  const runPreflight = () => {
    const checked = spawnSync(python, ['-c', preflightScript, RUNNER, stagingDirectory], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    return JSON.parse(checked.stdout.trim());
  };
  try {
    fs.writeFileSync(ownerPath, JSON.stringify({ format: 1, pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
    assert.deepEqual(runPreflight(), { ok: true }, 'the one fixed ordinary owner marker must be accepted');
    fs.writeFileSync(path.join(stagingDirectory, 'unexpected.bin'), 'unexpected', 'utf8');
    assert.deepEqual(runPreflight(), { ok: false, code: 'asset-semantic-staging-not-empty' });
    fs.rmSync(path.join(stagingDirectory, 'unexpected.bin'), { force: true });
    fs.rmSync(ownerPath, { force: true });
    fs.symlinkSync(outsideDirectory, ownerPath, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(runPreflight(), { ok: false, code: 'asset-semantic-staging-owner-invalid' });
    assert.equal(fs.readFileSync(path.join(outsideDirectory, 'sentinel.txt'), 'utf8'), 'outside');
  } finally {
    removeDirectory(stagingPreflightRoot);
  }

  const probe = spawnSync(python, [RUNNER, '--probe'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const payload = JSON.parse(probe.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.protocolVersion, 1);
  assert.equal(payload.directClasses, true);
  assert.equal(payload.trocrTokenizerAdapter, true);
  assert.equal(typeof payload.nativeSentencepiece, 'boolean');
  assert.match(payload.transformers, /^5\./);
  assert.deepEqual(payload.modelIds, [
    'caption-blip-base',
    'embedding-multilingual-minilm-l12-v2',
    'ocr-trocr-small-printed',
  ]);
  assert.equal(JSON.stringify(payload).includes(ROOT), false);

  const modelRoot = createDirectory('t8-semantic-runner-jsonl-');
  try {
    const jsonl = spawnSync(python, [RUNNER, '--worker', '--model-root', modelRoot], {
      cwd: ROOT,
      input: [
        JSON.stringify({ id: 'ping-1', op: 'ping' }),
        JSON.stringify({
          id: 'forbidden-1',
          op: 'execute',
          modelId: EMBEDDING_MODEL,
          task: 'embedding',
          text: 'hello',
          repo: 'evil/repo',
        }),
        '',
      ].join('\n'),
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(jsonl.status, 0, jsonl.stderr || jsonl.stdout);
    const frames = jsonl.stdout.trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(frames[0], { id: 'ping-1', ok: true, result: { protocolVersion: 1, ready: true } });
    assert.equal(frames[1].id, 'forbidden-1');
    assert.equal(frames[1].ok, false);
    assert.equal(frames[1].error.code, 'asset-semantic-request-field-not-allowed');
    assert.equal(JSON.stringify(frames).includes(modelRoot), false);
  } finally {
    removeDirectory(modelRoot);
  }
});
