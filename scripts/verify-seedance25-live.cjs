const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const seedanceNz = require('../backend/src/providers/seedanceNz');

const apiKey = String(process.env.SEEDANCE_NZ_API_KEY || '').trim();
if (!apiKey) {
  console.error('SEEDANCE_NZ_API_KEY is required');
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
const ffmpeg = path.join(root, 'tools', 'ffmpeg-runtime', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const ffprobe = path.join(root, 'tools', 'ffmpeg-runtime', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const runName = String(process.env.SEEDANCE25_LIVE_RUN || 'seedance25-live-20260807').trim();
const outputDir = path.join(root, 'output', runName);
const stateFile = path.join(outputDir, 'state.private.json');
const reportFile = path.join(outputDir, 'report.json');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-seedance25-'));
fs.mkdirSync(outputDir, { recursive: true });

const catalogModels = [
  'seedance-2.5-global-standard-i2v',
  'seedance-2.5-global-standard-multi',
  'seedance-2.5-global-standard-t2v',
  'seedance-2.5-standard-i2v',
  'seedance-2.5-standard-multi',
  'seedance-2.5-standard-t2v',
];
const requestedModels = String(process.env.SEEDANCE25_VERIFY_MODELS || '').split(',').map((item) => item.trim()).filter(Boolean);
if (requestedModels.some((model) => !catalogModels.includes(model))) {
  console.error('SEEDANCE25_VERIFY_MODELS contains a model outside the Seedance 2.5 catalog');
  process.exit(2);
}
const models = requestedModels.length ? catalogModels.filter((model) => requestedModels.includes(model)) : catalogModels;

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
  }
  return result.stdout;
}

function createFixtures() {
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) throw new Error('ffmpeg/ffprobe runtime is missing');
  const image = path.join(tempDir, 'reference.png');
  const video = path.join(tempDir, 'reference.mp4');
  const audio = path.join(tempDir, 'reference.wav');
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x17324d:s=768x768:d=0.1',
    '-vf', 'drawbox=x=172:y=172:w=424:h=424:color=0xf1d39a:t=fill,drawbox=x=268:y=268:w=232:h=232:color=0x315a7d:t=fill',
    '-frames:v', '1', image,
  ], 'reference image');
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x17324d:s=480x270:d=5:r=24',
    '-vf', 'drawbox=x=70+40*t:y=85:w=100:h=100:color=0xf1d39a:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', video,
  ], 'reference video');
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'pcm_s16le', audio,
  ], 'reference audio');
  return { image, video, audio };
}

function loadState() {
  if (!fs.existsSync(stateFile)) return { tasks: {}, history: {}, appliedRetryTokens: {} };
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return parsed && typeof parsed === 'object' && parsed.tasks ? parsed : { tasks: {}, history: {}, appliedRetryTokens: {} };
}

function saveState(state) {
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function applyExplicitRetry(state) {
  const token = String(process.env.SEEDANCE25_RETRY_TOKEN || '').trim();
  const requested = String(process.env.SEEDANCE25_RETRY_MODELS || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!token || requested.length === 0) return;
  if (requested.some((model) => !models.includes(model))) throw new Error('retry model is outside the Seedance 2.5 catalog');
  state.appliedRetryTokens ||= {};
  if (state.appliedRetryTokens[token]) return;
  state.history ||= {};
  for (const model of requested) {
    if (!state.tasks[model]?.taskId) throw new Error(`${model} has no previous accepted task to retry`);
    state.history[model] ||= [];
    state.history[model].push(state.tasks[model]);
    delete state.tasks[model];
  }
  state.appliedRetryTokens[token] = requested;
  saveState(state);
}

function requestFor(model, fixtures) {
  const common = {
    model,
    duration: 4,
    resolution: '480p',
    ratio: '16:9',
    generate_audio: true,
    return_last_frame: false,
  };
  if (model.endsWith('-i2v')) {
    return {
      ...common,
      ratio: 'adaptive',
      prompt: 'The geometric subject gently rotates while the camera slowly pushes in; preserve identity, lighting and composition.',
      firstFrame: fixtures.image,
    };
  }
  if (model.endsWith('-multi')) {
    return {
      ...common,
      prompt: 'Keep @Image 1 as the subject identity, follow @Video 1 camera rhythm, and synchronize motion accents with @Audio 1.',
      refImages: [fixtures.image],
      videos: [fixtures.video],
      audios: [fixtures.audio],
    };
  }
  return {
    ...common,
    prompt: 'A geometric paper sculpture gently rotates in a clean blue studio while the camera slowly pushes in, coherent cinematic lighting, no text.',
  };
}

function taskTypeFor(model) {
  return model.endsWith('-t2v') ? 't2v' : model.endsWith('-i2v') ? 'i2v' : 'multi';
}

async function submitWithAcceptedResponseRecovery(model, request) {
  let accepted = null;
  const fetchImpl = async (url, init) => {
    const isVideoSubmission = init?.method === 'POST' && new URL(url).pathname === '/v1/videos';
    const response = await globalThis.fetch(url, isVideoSubmission ? {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        'Idempotency-Key': crypto.createHash('sha256').update(`${runName}:${model}:${JSON.stringify(request)}`).digest('hex'),
      },
    } : init);
    if (isVideoSubmission) {
      const clone = response.clone();
      const body = await clone.text();
      let data = null;
      try { data = JSON.parse(body); } catch {}
      accepted = {
        ok: response.ok,
        status: response.status,
        data,
        bodyBytes: Buffer.byteLength(body),
        contentLength: Number(response.headers.get('content-length') || 0),
        contentEncoding: String(response.headers.get('content-encoding') || ''),
      };
    }
    return response;
  };

  try {
    return await seedanceNz.submitTask(request, apiKey, { fetchImpl });
  } catch (error) {
    const taskId = String(accepted?.data?.id || accepted?.data?.task_id || accepted?.data?.data?.id || '').trim();
    const acceptedModel = String(accepted?.data?.model || accepted?.data?.data?.model || '').trim();
    const acceptedStatus = String(accepted?.data?.status || accepted?.data?.data?.status || '').trim().toLowerCase();
    const safeOpaqueId = taskId.length > 0
      && taskId.length <= 512
      && !/[\u0000-\u0020\u007f]/.test(taskId)
      && !taskId.includes(apiKey)
      && !/^https?:\/\//i.test(taskId);
    console.log(`[live:${model}] submit diagnostics code=${error?.code || 'unknown'} http=${accepted?.status || 0} captured=${Boolean(accepted?.data)} idType=${typeof (accepted?.data?.id ?? accepted?.data?.task_id ?? accepted?.data?.data?.id)} idLength=${taskId.length} safeOpaque=${safeOpaqueId} modelMatch=${!acceptedModel || acceptedModel === model} status=${acceptedStatus || 'missing'} bytes=${accepted?.contentLength || 0}/${accepted?.bodyBytes || 0}`);
    if (error?.code !== 'SEEDANCE_INVALID_RESPONSE' || !accepted?.ok || !safeOpaqueId || !['queued', 'pending', 'in_progress', 'processing', 'submitted'].includes(acceptedStatus)) throw error;
    console.log(`[live:${model}] recovered an accepted response after bounded-reader rejection (${accepted.contentLength}/${accepted.bodyBytes} bytes, encoding=${accepted.contentEncoding || 'identity'})`);
    return { taskId, taskType: taskTypeFor(model), model };
  }
}

async function poll(model, entry, state) {
  const deadline = Date.now() + 60 * 60 * 1000;
  let previous = '';
  while (Date.now() < deadline) {
    const result = await seedanceNz.queryTask(entry.taskId, apiKey);
    const line = `${result.status}:${result.progress || ''}`;
    if (line !== previous) console.log(`[live:${model}] ${line}`);
    previous = line;
    if (result.status === 'failed') {
      state.tasks[model].status = 'failed';
      state.tasks[model].failReason = result.failReason || 'unknown Provider error';
      saveState(state);
      throw new Error(`${model} failed: ${result.failReason || 'unknown Provider error'}`);
    }
    if (result.status === 'succeeded') {
      if (!result.videoUrl) throw new Error(`${model} succeeded without a result URL`);
      state.tasks[model].status = 'succeeded';
      state.tasks[model].url = result.videoUrl;
      saveState(state);
      return result.videoUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, 7000));
  }
  throw new Error(`${model} timed out`);
}

function spawnCurlRangeOnce(url, resolveArg, start, end, target) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const args = [
      '--fail', '--silent', '--show-error', '--location',
      '--range', `${start}-${end}`,
      '--connect-timeout', '30', '--max-time', '180',
      '--output', target,
      url,
    ];
    if (resolveArg) args.unshift('--resolve', resolveArg);
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(0, 500); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ranged output download failed (curl ${code}): ${stderr.trim().slice(0, 240)}`));
    });
  });
}

async function spawnCurlRange(url, resolveArgs, start, end, target) {
  let lastError = null;
  const candidates = [...resolveArgs, ''];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    fs.rmSync(target, { force: true });
    try {
      await spawnCurlRangeOnce(url, candidates[attempt % candidates.length], start, end, target);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('ranged output download failed');
}

async function downloadWithVerifiedRanges(model, url, target) {
  const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const probe = path.join(tempDir, `${model}.probe`);
  const parsedUrl = new URL(url);
  const resolver = new dns.promises.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const addresses = [...new Set(await resolver.resolve4(parsedUrl.hostname))];
  const resolveArgs = addresses.map((address) => `${parsedUrl.hostname}:${parsedUrl.port || '443'}:${address}`);
  const rangeRoot = path.join(outputDir, '.ranges');
  fs.mkdirSync(rangeRoot, { recursive: true });
  const manifestFile = path.join(rangeRoot, `${model}.json`);
  const urlHash = crypto.createHash('sha256').update(url).digest('hex');
  let total = 0;
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest.urlHash === urlHash) total = Number(manifest.total || 0);
    } catch {}
  }
  if (!Number.isSafeInteger(total) || total < 1024 || total > 512 * 1024 * 1024) total = 0;
  if (!total) {
    const probeCandidates = [...resolveArgs, ''];
    for (let cycle = 0; cycle < 3 && !total; cycle += 1) {
      for (const candidateResolve of probeCandidates) {
        const args = [
          '--fail', '--silent', '--show-error', '--location',
          '--range', '0-0', '--connect-timeout', '30', '--max-time', '45',
          '--output', probe,
          '--write-out', '__T8_META__%{http_code}|%header{content-range}|%{content_type}',
          url,
        ];
        if (candidateResolve) args.unshift('--resolve', candidateResolve);
        const checked = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 50_000 });
        const meta = String(checked.stdout || '').match(/__T8_META__(\d{3})\|bytes\s+0-0\/(\d+)\|([^\r\n]*)/i);
        const candidateTotal = Number(meta?.[2] || 0);
        if (checked.status === 0 && meta?.[1] === '206' && Number.isSafeInteger(candidateTotal)) {
          total = candidateTotal;
          break;
        }
      }
    }
  }
  if (!Number.isSafeInteger(total) || total < 1024 || total > 512 * 1024 * 1024) {
    throw new Error(`${model} output did not expose a valid bounded byte range`);
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify({ urlHash, total })}\n`);
  fs.rmSync(probe, { force: true });

  const chunkSize = 128 * 1024;
  const chunkDir = path.join(outputDir, '.ranges', `${model}-${total}`);
  fs.mkdirSync(chunkDir, { recursive: true });
  const jobs = [];
  for (let start = 0, index = 0; start < total; start += chunkSize, index += 1) {
    const end = Math.min(total - 1, start + chunkSize - 1);
    jobs.push({ start, end, file: path.join(chunkDir, `${model}.part-${index}`), index });
  }
  const priorTempDirs = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('t8-seedance25-'))
    .map((entry) => path.join(os.tmpdir(), entry.name));
  for (const job of jobs) {
    const expected = job.end - job.start + 1;
    if (fs.existsSync(job.file) && fs.statSync(job.file).size === expected) continue;
    fs.rmSync(job.file, { force: true });
    const recovered = priorTempDirs
      .map((dir) => path.join(dir, `${model}.part-${job.index}`))
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).size === expected);
    if (recovered) fs.copyFileSync(recovered, job.file);
  }
  let cursor = 0;
  const pendingJobs = jobs.filter((job) => {
    const expected = job.end - job.start + 1;
    return !fs.existsSync(job.file) || fs.statSync(job.file).size !== expected;
  });
  const workers = Array.from({ length: Math.min(6, pendingJobs.length) }, async () => {
    while (cursor < pendingJobs.length) {
      const job = pendingJobs[cursor];
      cursor += 1;
      await spawnCurlRange(url, resolveArgs, job.start, job.end, job.file);
      const actual = fs.statSync(job.file).size;
      if (actual !== job.end - job.start + 1) throw new Error(`${model} output range length mismatch`);
    }
  });
  await Promise.all(workers);

  const temporary = `${target}.partial-${process.pid}`;
  const descriptor = fs.openSync(temporary, 'wx');
  try {
    for (const job of jobs) fs.writeSync(descriptor, fs.readFileSync(job.file));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (fs.statSync(temporary).size !== total) throw new Error(`${model} assembled output length mismatch`);
  fs.rmSync(target, { force: true });
  fs.renameSync(temporary, target);
  fs.rmSync(chunkDir, { recursive: true, force: true });
  return fs.readFileSync(target);
}

async function downloadAndValidate(model, url) {
  const file = path.join(outputDir, `${model}.mp4`);
  const buffer = fs.existsSync(file) && fs.statSync(file).size >= 1024
    ? fs.readFileSync(file)
    : await downloadWithVerifiedRanges(model, url, file);
  const probe = JSON.parse(run(ffprobe, [
    '-v', 'error', '-show_entries', 'format=format_name,duration,size', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', file,
  ], `${model} ffprobe`));
  const video = Array.isArray(probe.streams) ? probe.streams.find((item) => item.codec_type === 'video') : null;
  const media = {
    format: probe.format?.format_name || null,
    duration: Number(probe.format?.duration || 0),
    codec: video?.codec_name || null,
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
  };
  if (!media.duration || !media.codec || !media.width || !media.height) throw new Error(`${model} video decode failed`);
  return {
    file: path.relative(root, file).replace(/\\/g, '/'),
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    media,
  };
}

async function main() {
  const fixtures = createFixtures();
  const state = loadState();
  applyExplicitRetry(state);
  const results = [];

  for (const model of models) {
    let entry = state.tasks[model];
    if (!entry?.taskId) {
      console.log(`[live:${model}] submitting`);
      const submitted = await submitWithAcceptedResponseRecovery(model, requestFor(model, fixtures));
      entry = { taskId: submitted.taskId, taskType: submitted.taskType, status: 'submitted' };
      state.tasks[model] = entry;
      saveState(state);
      console.log(`[live:${model}] accepted as ${submitted.taskType}`);
    }
    const url = entry.status === 'succeeded' && entry.url ? entry.url : await poll(model, entry, state);
    const output = await downloadAndValidate(model, url);
    results.push({
      model,
      taskType: entry.taskType || taskTypeFor(model),
      status: 'succeeded',
      attempts: 1 + (state.history?.[model]?.length || 0),
      output,
    });
    console.log(`[live:${model}] downloaded and decoded`);
  }

  const report = {
    ok: results.length === models.length && results.every((item) => item.status === 'succeeded'),
    verifiedAt: new Date().toISOString(),
    provider: 'seedance-nz',
    officialDocs: 'https://api.seedance.nz/docs/llms.txt',
    taskCount: results.length,
    catalogTaskCount: catalogModels.length,
    credentialsPersisted: false,
    results,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[live] verified ${results.length}/${models.length} models; sanitized report: ${path.relative(root, reportFile)}`);
}

main().catch((error) => {
  console.error(`[live] ${error?.message || error}`);
  process.exitCode = 1;
});
