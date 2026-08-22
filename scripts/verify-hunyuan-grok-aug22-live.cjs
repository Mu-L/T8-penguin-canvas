'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../backend/src/config');
const provider = require('../backend/src/providers/seedanceNz');

const OUTPUT_DIR = path.join(__dirname, '..', 'output', 'hunyuan-grok-aug22-live');
const RECOVERY_FILE = path.join(__dirname, '..', '.tmp', 'hunyuan-grok-aug22-live-recovery.json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function apiKey() {
  const settings = JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf8'));
  const value = String(settings?.zhenzhenSd2ApiKey || '').trim();
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(value)) throw new Error('本机未配置可用的贞贞平价AI小屋 API Key');
  return value;
}

async function poll(label, query, done, maxPolls = 720) {
  for (let pollCount = 1; pollCount <= maxPolls; pollCount += 1) {
    const value = await query();
    if (value.status === 'failed') throw new Error(`${label} failed: ${value.failReason || value.error || 'unknown'}`);
    if (value.status === 'succeeded' || value.status === 'completed') {
      const result = done(value);
      if (result) return { value, result, pollCount };
    }
    if (pollCount % 12 === 0) process.stdout.write(`[live] ${label}: waiting (${pollCount})\n`);
    await sleep(5000);
  }
  throw new Error(`${label} polling timeout`);
}

async function download(url, filename, kind) {
  const response = await provider.fetchRemote(url, { headers: { Accept: '*/*' } });
  if (!response.ok) throw new Error(`${kind} download HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error(`${kind} download empty`);
  if (kind === 'image' && !(buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) || buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))) throw new Error(`${kind} magic invalid`);
  if (kind === 'video' && !buffer.subarray(0, 64).includes(Buffer.from('ftyp'))) throw new Error(`${kind} MP4 magic invalid`);
  if (kind === 'model3d' && buffer.subarray(0, 4).toString('ascii') !== 'glTF') throw new Error(`${kind} GLB magic invalid`);
  const target = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(target, buffer);
  return { file: filename, bytes: buffer.length, sha256: sha256(buffer) };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const key = apiKey();
  const report = { schema: 't8-hunyuan-grok-live-verification-v1', verifiedAt: new Date().toISOString(), provider: 'seedance-nz', endpoint: 'https://api.seedance.nz', results: [] };

  if (process.argv.includes('--text3d-only')) {
    process.stdout.write('[live] Hunyuan 3D text-to-3D only\n');
    const text3dSubmit = await provider.submitHunyuan3dTask({ model: 'hunyuan3d-v3.1-text-to-3d', prompt: 'A simple stylized penguin astronaut toy, full body, clean watertight topology', face_count: 10000, enable_pbr: false, generate_type: 'Normal' }, key);
    fs.mkdirSync(path.dirname(RECOVERY_FILE), { recursive: true });
    fs.writeFileSync(RECOVERY_FILE, `${JSON.stringify({ schema: 't8-hunyuan-grok-live-recovery-v1', capability: 'hunyuan3d-v3.1-text-to-3d', taskId: text3dSubmit.taskId }, null, 2)}\n`, 'utf8');
    const text3d = await poll('hunyuan-text-3d', () => provider.queryHunyuan3dTask(text3dSubmit.taskId, key), (value) => value.modelUrl);
    report.results.push({ capability: 'hunyuan3d-v3.1-text-to-3d', status: 'passed', pollCount: text3d.pollCount, artifact: await download(text3d.result, 'hunyuan-text.glb', 'model3d') });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'text3d-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.rmSync(RECOVERY_FILE, { force: true });
    process.stdout.write('[live] completed text-to-3D; sanitized report saved\n');
    return;
  }

  if (process.argv.includes('--image3d-only')) {
    const sourcePath = path.join(OUTPUT_DIR, 'grok-source.jpg');
    if (!fs.existsSync(sourcePath)) throw new Error('missing previously validated grok-source.jpg');
    const sourceDataUrl = `data:image/jpeg;base64,${fs.readFileSync(sourcePath).toString('base64')}`;
    process.stdout.write('[live] Hunyuan 3D image-to-3D only\n');
    const image3dSubmit = await provider.submitHunyuan3dTask({ model: 'hunyuan3d-v3.1-image-to-3d', prompt: 'Reconstruct the complete centered toy as a clean watertight 3D asset', images: [sourceDataUrl], face_count: 10000, enable_pbr: false, generate_type: 'Normal' }, key);
    fs.mkdirSync(path.dirname(RECOVERY_FILE), { recursive: true });
    fs.writeFileSync(RECOVERY_FILE, `${JSON.stringify({ schema: 't8-hunyuan-grok-live-recovery-v1', capability: 'hunyuan3d-v3.1-image-to-3d', taskId: image3dSubmit.taskId }, null, 2)}\n`, 'utf8');
    const image3d = await poll('hunyuan-image-3d', () => provider.queryHunyuan3dTask(image3dSubmit.taskId, key), (value) => value.modelUrl);
    report.results.push({ capability: 'hunyuan3d-v3.1-image-to-3d', status: 'passed', pollCount: image3d.pollCount, artifact: await download(image3d.result, 'hunyuan-image.glb', 'model3d') });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'image3d-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.rmSync(RECOVERY_FILE, { force: true });
    process.stdout.write('[live] completed image-to-3D; sanitized report saved\n');
    return;
  }

  process.stdout.write('[live] Grok v2 single-image source\n');
  const sourceSubmit = await provider.submitImageTask({ model: 'zhenzhen-image-gk-v2', prompt: 'A single cute penguin astronaut toy centered on a plain white studio background, full body, product photo', size: '1:1', n: 1 }, key);
  const source = await poll('grok-source', () => provider.queryImageTask(sourceSubmit.taskId, key), (value) => value.imageUrls?.[0]);
  const sourceArtifact = await download(source.result, 'grok-source.jpg', 'image');
  report.results.push({ capability: 'zhenzhen-image-gk-v2-source', status: 'passed', pollCount: source.pollCount, artifact: sourceArtifact });

  process.stdout.write('[live] Grok v2 segmentation\n');
  const segmentSubmit = await provider.submitImageTask({ model: 'zhenzhen-image-gk-v2-segment', operation: 'segment', source_task_id: sourceSubmit.taskId, include_mask_rle: false }, key);
  const segment = await poll('grok-segment', () => provider.queryImageTask(segmentSubmit.taskId, key), (value) => value.operationResult?.image_id ? value.operationResult : null);
  const objects = Array.isArray(segment.result.objects) ? segment.result.objects : [];
  report.results.push({ capability: 'zhenzhen-image-gk-v2-segment', status: 'passed', pollCount: segment.pollCount, imageIdPresent: true, objectCount: objects.length });

  process.stdout.write('[live] Grok v2 region edit\n');
  const regionSubmit = await provider.submitImageTask({ model: 'zhenzhen-image-gk-v2-region-edit', operation: 'region_edit', image_id: segment.result.image_id, prompt: 'Change the selected object material to glossy red ceramic while preserving composition', object_indices: [0] }, key);
  const region = await poll('grok-region-edit', () => provider.queryImageTask(regionSubmit.taskId, key), (value) => value.imageUrls?.[0]);
  report.results.push({ capability: 'zhenzhen-image-gk-v2-region-edit', status: 'passed', pollCount: region.pollCount, artifact: await download(region.result, 'grok-region-edit.jpg', 'image') });

  process.stdout.write('[live] lowprice Omni text-to-video\n');
  const videoSubmit = await provider.submitTask({ model: 'zhenzhen-video-g-omni-flash-lowprice', mode: 'text', prompt: 'A cute penguin astronaut toy slowly rotates on a clean studio turntable, stable camera, product film', seconds: 4, resolution: '720p', aspect_ratio: '16:9', nsfw_check: false }, key);
  const video = await poll('omni-lowprice', () => provider.queryTask(videoSubmit.taskId, key), (value) => value.videoUrl);
  report.results.push({ capability: 'zhenzhen-video-g-omni-flash-lowprice', status: 'passed', pollCount: video.pollCount, artifact: await download(video.result, 'omni-lowprice.mp4', 'video') });

  process.stdout.write('[live] Hunyuan 3D text-to-3D\n');
  const text3dSubmit = await provider.submitHunyuan3dTask({ model: 'hunyuan3d-v3.1-text-to-3d', prompt: 'A simple stylized penguin astronaut toy, full body, clean watertight topology', face_count: 10000, enable_pbr: false, generate_type: 'Normal' }, key);
  const text3d = await poll('hunyuan-text-3d', () => provider.queryHunyuan3dTask(text3dSubmit.taskId, key), (value) => value.modelUrl);
  report.results.push({ capability: 'hunyuan3d-v3.1-text-to-3d', status: 'passed', pollCount: text3d.pollCount, artifact: await download(text3d.result, 'hunyuan-text.glb', 'model3d') });

  process.stdout.write('[live] Hunyuan 3D image-to-3D\n');
  const image3dSubmit = await provider.submitHunyuan3dTask({ model: 'hunyuan3d-v3.1-image-to-3d', prompt: 'Reconstruct the complete centered toy as a clean watertight 3D asset', images: [source.result], face_count: 10000, enable_pbr: false, generate_type: 'Normal' }, key);
  const image3d = await poll('hunyuan-image-3d', () => provider.queryHunyuan3dTask(image3dSubmit.taskId, key), (value) => value.modelUrl);
  report.results.push({ capability: 'hunyuan3d-v3.1-image-to-3d', status: 'passed', pollCount: image3d.pollCount, artifact: await download(image3d.result, 'hunyuan-image.glb', 'model3d') });

  fs.writeFileSync(path.join(OUTPUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`[live] completed ${report.results.length}/${report.results.length}; sanitized report saved\n`);
}

main().catch((error) => { process.stderr.write(`[live] failed: ${String(error?.message || error).replace(/https?:\/\/\S+/g, '[redacted-url]')}\n`); process.exitCode = 1; });
