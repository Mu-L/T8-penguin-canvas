'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const provider = require('../backend/src/providers/seedanceNz');

const apiKey = String(process.env.MINIMAX_H3_CONTEXT_IR_API_KEY || '').trim();
if (!apiKey) throw new Error('MINIMAX_H3_CONTEXT_IR_API_KEY is required');

const runId = String(process.env.MINIMAX_H3_CONTEXT_IR_LIVE_RUN || 'minimax-h3-context-ir-live-20260811').trim();
const reportDir = path.resolve(process.cwd(), 'output', runId);
const reportFile = path.join(reportDir, 'report.json');
const pollIntervalMs = Math.max(1000, Number(process.env.MINIMAX_H3_CONTEXT_IR_POLL_MS || 4000));
const timeoutMs = Math.max(60_000, Number(process.env.MINIMAX_H3_CONTEXT_IR_TIMEOUT_MS || 30 * 60 * 1000));
const models = [
  'minmax-h3-context-ir-text',
  'minmax-h3-context-ir-image',
  'minmax-h3-context-ir-multimodal',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function submissionFetch(model) {
  const idempotencyKey = `t8-context-ir-live:${runId}:${model}`;
  return (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const isTaskSubmission = method === 'POST' && /\/v1\/video\/generations\/?(?:\?|$)/.test(String(url));
    return fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(isTaskSubmission
          ? { 'Idempotency-Key': idempotencyKey }
          : {}),
      },
    });
  };
}

async function pollAcceptedTask(taskId, model) {
  const startedAt = Date.now();
  let pollCount = 0;
  let readFailures = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    let result;
    try {
      result = await provider.queryMinimaxH3ContextIrTask(taskId, apiKey);
      readFailures = 0;
    } catch (error) {
      readFailures += 1;
      if (readFailures >= 5) throw error;
      continue;
    }
    pollCount += 1;
    process.stdout.write(`[Context IR live] ${model} status=${result.status} progress=${result.progress || ''}\n`);
    if (result.status === 'succeeded') {
      const resultText = String(result.resultText || '').trim();
      if (!resultText) throw new Error(`${model} completed without result_text`);
      return {
        status: 'passed',
        resultTextLength: resultText.length,
        resultTextSha256: sha256(resultText),
        pollCount,
        elapsedMs: Date.now() - startedAt,
      };
    }
    if (result.status === 'failed') {
      throw new Error(result.failReason || `${model} failed`);
    }
  }
  throw new Error(`${model} polling exceeded ${timeoutMs}ms`);
}

async function main() {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-context-ir-live-'));
  try {
    const imageBuffer = await sharp({
      create: {
        width: 768,
        height: 432,
        channels: 3,
        background: { r: 30, g: 64, b: 92 },
      },
    }).composite([{
      input: Buffer.from('<svg width="768" height="432"><circle cx="384" cy="216" r="100" fill="#f0c56e"/><rect x="110" y="310" width="548" height="24" rx="12" fill="#88c9aa"/></svg>'),
      top: 0,
      left: 0,
    }]).png().toBuffer();
    const imageDataUrl = `data:image/png;base64,${imageBuffer.toString('base64')}`;

    const report = {
      schema: 't8-minimax-h3-context-ir-live-verification-v1',
      runId,
      checkedAt: new Date().toISOString(),
      provider: 'seedance-nz',
      baseUrl: provider.BASE_URL,
      officialDocs: {
        url: 'https://api.seedance.nz/docs/llms.txt',
        lastModified: 'Sun, 09 Aug 2026 23:40:34 GMT',
        bytes: 645722,
        sha256: '97926f8eea2a0a1c92bef88fe57e7e855419544ddc6589584749b89b8e22b37d',
      },
      referenceImplementation: 'F:/AI-T8-video-onekey/ComfyUI/custom_nodes/ComfyUI_Seedance@06fbe1e4c8b8b8f5bbac4121185da1c301962ed6',
      security: 'API key was process-only. Report excludes credentials, task IDs, signed URLs, and raw Provider responses.',
      models: [],
    };

    for (const model of models) {
      const request = {
        model,
        prompt: model === 'minmax-h3-context-ir-text'
          ? '清晨海边，一位旅行者迎着微风缓慢前行，镜头平稳跟随，电影感自然光。'
          : model === 'minmax-h3-context-ir-image'
            ? '保持参考图中的主体和构图，加入自然动作与连贯的电影镜头运动。'
            : '结合参考图的主体、色彩和空间关系，增强为连贯且可直接用于 MiniMax H3 的视频提示词。',
        seconds: '4',
        ...(model === 'minmax-h3-context-ir-text' ? { ratio: '16:9' } : {}),
        ...(model === 'minmax-h3-context-ir-multimodal' ? { ratio: 'adaptive' } : {}),
        ...(model === 'minmax-h3-context-ir-image' || model === 'minmax-h3-context-ir-multimodal'
          ? { images: [imageDataUrl] }
          : {}),
      };
      const entry = { model, submitted: false, status: 'not-run' };
      report.models.push(entry);
      try {
        const submitted = await provider.submitMinimaxH3ContextIrTask(request, apiKey, {
          fetchImpl: submissionFetch(model),
          uploadIntervalMs: 0,
          uploadCacheTtlMs: 0,
        });
        entry.submitted = true;
        entry.status = 'accepted';
        Object.assign(entry, await pollAcceptedTask(submitted.taskId, model));
      } catch (error) {
        entry.status = entry.submitted ? 'accepted-task-failed' : 'submission-not-accepted';
        entry.error = String(error?.message || error).replaceAll(apiKey, '[REDACTED]').slice(0, 500);
        break;
      }
    }
    report.passed = report.models.length === models.length && report.models.every((item) => item.status === 'passed');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`[Context IR live] sanitized report: ${reportFile}\n`);
    if (!report.passed) process.exitCode = 1;
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = String(error?.message || error).replaceAll(apiKey, '[REDACTED]');
  process.stderr.write(`[Context IR live] ${message}\n`);
  process.exitCode = 1;
});
