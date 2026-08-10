const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const seedanceNz = require('../backend/src/providers/seedanceNz');

const apiKey = String(process.env.SEEDANCE_NZ_API_KEY || '').trim();
if (!apiKey) {
  console.error('SEEDANCE_NZ_API_KEY is required');
  process.exit(2);
}

const SUPPORTED_MODELS = new Set([
  'seedream-v5-pro-layer-decomposition',
  'dola-seedream-5.0-pro-layer-decomposition',
]);
const MODEL = String(process.env.SEEDREAM_LAYER_MODEL || 'seedream-v5-pro-layer-decomposition').trim();
if (!SUPPORTED_MODELS.has(MODEL)) {
  console.error('SEEDREAM_LAYER_MODEL is not a documented layer-decomposition model');
  process.exit(2);
}
const requestedResolution = String(process.env.SEEDREAM_LAYER_RESOLUTION || '1k').trim().toLowerCase();
if (!new Set(['auto', '1k', '1.5k', '2k']).has(requestedResolution)) {
  console.error('SEEDREAM_LAYER_RESOLUTION must be auto, 1k, 1.5k, or 2k');
  process.exit(2);
}
const root = path.resolve(__dirname, '..');
const defaultRunName = MODEL.startsWith('dola-')
  ? 'dola-seedream-layer-live-20260811'
  : 'seedream-layer-live-20260809';
const runName = String(process.env.SEEDREAM_LAYER_LIVE_RUN || defaultRunName).trim();
const outputDir = path.join(root, 'output', runName);
const reportFile = path.join(outputDir, 'report.json');
const privateStateFile = path.join(outputDir, 'state.private.json');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-seedream-layer-'));
fs.mkdirSync(outputDir, { recursive: true });

async function createReferenceImage() {
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
      <rect width="1024" height="1024" fill="#d8e8f2"/>
      <rect x="90" y="690" width="844" height="190" rx="28" fill="#38516c"/>
      <circle cx="320" cy="405" r="185" fill="#f4b83f"/>
      <rect x="555" y="220" width="265" height="385" rx="36" fill="#26405f"/>
      <path d="M640 635 L785 635 L715 825 Z" fill="#e45f62"/>
      <circle cx="735" cy="380" r="58" fill="#f4f1df"/>
    </svg>
  `);
  const file = path.join(tempDir, 'seedream-layer-source.png');
  await sharp(svg).png().toFile(file);
  const metadata = await sharp(file).metadata();
  if (metadata.width !== 1024 || metadata.height !== 1024 || metadata.format !== 'png') {
    throw new Error('reference fixture decode failed');
  }
  return file;
}

function loadPrivateState() {
  if (!fs.existsSync(privateStateFile)) return {};
  const parsed = JSON.parse(fs.readFileSync(privateStateFile, 'utf8'));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function savePrivateState(state) {
  fs.writeFileSync(privateStateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function acceptedTask(referenceImage) {
  const state = loadPrivateState();
  if (state.model === MODEL && typeof state.taskId === 'string' && state.taskId) {
    console.log('[live:seedream-layer] resuming accepted task');
    return state.taskId;
  }
  console.log('[live:seedream-layer] submitting one paid task');
  const submitted = await seedanceNz.submitImageTask({
    model: MODEL,
    images: [referenceImage],
    prompt: 'Separate the background, platform, yellow circle, navy object, red triangle, and small white circle into clean editable layers.',
    resolution: requestedResolution,
    output_format: 'png',
  }, apiKey);
  savePrivateState({ model: MODEL, taskId: submitted.taskId, acceptedAt: new Date().toISOString() });
  console.log('[live:seedream-layer] task accepted');
  return submitted.taskId;
}

async function poll(taskId) {
  const deadline = Date.now() + 60 * 60 * 1000;
  let previous = '';
  while (Date.now() < deadline) {
    const result = await seedanceNz.queryImageTask(taskId, apiKey);
    const current = `${result.status}:${result.progress || ''}`;
    if (current !== previous) console.log(`[live:seedream-layer] ${current}`);
    previous = current;
    if (result.status === 'failed') throw new Error(`Provider task failed: ${result.failReason || 'unknown reason'}`);
    if (result.status === 'succeeded') {
      const urls = Array.isArray(result.imageUrls) ? result.imageUrls.filter(Boolean) : [];
      if (urls.length < 2) throw new Error(`Provider returned ${urls.length} image; expected base image plus at least one layer`);
      if (urls.length > 17) throw new Error(`Provider returned ${urls.length} images; documented maximum is 17`);
      return urls;
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error('Provider task timed out after 60 minutes; accepted task was not replayed');
}

async function downloadEveryOutput(urls) {
  const outputs = [];
  for (let index = 0; index < urls.length; index += 1) {
    const response = await seedanceNz.fetchRemote(urls[index]);
    if (!response.ok) throw new Error(`output ${index + 1}/${urls.length} download failed: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) throw new Error(`output ${index + 1}/${urls.length} is unexpectedly small`);
    const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height || !metadata.format) {
      throw new Error(`output ${index + 1}/${urls.length} could not be decoded as an image`);
    }
    const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
    const role = index === 0 ? 'base' : `layer-${String(index).padStart(2, '0')}`;
    const file = path.join(outputDir, `${String(index).padStart(2, '0')}-${role}.${extension}`);
    fs.writeFileSync(file, buffer);
    outputs.push({
      index,
      role,
      file: path.relative(root, file).replace(/\\/g, '/'),
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      media: {
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        channels: metadata.channels || null,
        hasAlpha: metadata.hasAlpha === true,
      },
    });
    console.log(`[live:seedream-layer] downloaded ${index + 1}/${urls.length}`);
  }
  return outputs;
}

async function main() {
  try {
    const referenceImage = await createReferenceImage();
    const taskId = await acceptedTask(referenceImage);
    const urls = await poll(taskId);
    const outputs = await downloadEveryOutput(urls);
    const report = {
      ok: outputs.length === urls.length && outputs.length >= 2 && outputs.length <= 17,
      verifiedAt: new Date().toISOString(),
      provider: 'seedance-nz',
      model: MODEL,
      officialDocs: 'https://api.seedance.nz/docs/llms.txt',
      requestedResolution,
      requestedOutputFormat: 'png',
      providerOutputCount: urls.length,
      downloadedOutputCount: outputs.length,
      preservedProviderOrder: true,
      credentialsPersisted: false,
      taskIdPersistedInReport: false,
      remoteUrlsPersistedInReport: false,
      outputs,
    };
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    if (fs.existsSync(privateStateFile)) fs.rmSync(privateStateFile, { force: true });
    console.log(`[live:seedream-layer] verified ${outputs.length}/${urls.length}; sanitized report saved`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[live:seedream-layer] ${error?.message || error}`);
  process.exitCode = 1;
});
