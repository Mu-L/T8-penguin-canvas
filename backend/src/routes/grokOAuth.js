'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { runLocalHooks } = require('../extensions/runtimeHooks');
const { safeRemoteMediaFetch } = require('../utils/safeRemoteMediaFetch');
const {
  providerSubmissionContextMiddleware,
  currentProviderSubmissionKey,
} = require('../services/providerSubmissionContext');

const router = express.Router();
router.use(providerSubmissionContextMiddleware);

const PRIVATE_DISABLED_MESSAGE = 'Grok OAuth 私有模块未启用，请使用带私有模块的本地版本。';
const GROK_VIDEO_AGENT_POLL_INTERVAL_MS = 5000;
const GROK_VIDEO_AGENT_MAX_POLLS = 180;

function disabledPayload(extra = {}) {
  return {
    success: false,
    code: 'grok_oauth_private_module_missing',
    error: PRIVATE_DISABLED_MESSAGE,
    data: {
      available: false,
      moduleEnabled: false,
      message: PRIVATE_DISABLED_MESSAGE,
      ...extra,
    },
  };
}

function statusPayload(extra = {}) {
  return {
    success: true,
    data: {
      available: false,
      loggedIn: false,
      moduleEnabled: false,
      message: PRIVATE_DISABLED_MESSAGE,
      ...extra,
    },
  };
}

function outputExtFromMime(mime, fallback = '.png') {
  const text = String(mime || '').toLowerCase();
  if (text.includes('mp4')) return '.mp4';
  if (text.includes('webm')) return '.webm';
  if (text.includes('quicktime')) return '.mov';
  if (text.includes('mpeg') || text.includes('mp3')) return '.mp3';
  if (text.includes('wav')) return '.wav';
  if (text.includes('ogg')) return '.ogg';
  if (text.includes('flac')) return '.flac';
  if (text.includes('aac')) return '.aac';
  if (text.includes('jpeg') || text.includes('jpg')) return '.jpg';
  if (text.includes('webp')) return '.webp';
  if (text.includes('gif')) return '.gif';
  if (text.includes('bmp')) return '.bmp';
  if (text.includes('png')) return '.png';
  return fallback;
}

function outputExtFromUrl(url, fallback = '.png') {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.mp4', '.webm', '.mov', '.m4v', '.mp3', '.wav', '.ogg', '.flac', '.aac'].includes(ext)) {
      return ext;
    }
  } catch {
    // ignore
  }
  return fallback;
}

function defaultExtForKind(kind) {
  if (kind === 'video') return '.mp4';
  if (kind === 'audio') return '.mp3';
  return '.png';
}

function writeOutputBuffer(buffer, ext) {
  if (!fs.existsSync(config.OUTPUT_DIR)) fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
  const suffix = crypto.randomBytes(4).toString('hex');
  const filename = `grok_oauth_${Date.now()}_${suffix}${ext || '.png'}`;
  fs.writeFileSync(path.join(config.OUTPUT_DIR, filename), buffer);
  return `/files/output/${filename}`;
}

async function saveOneMediaOutput(url, kind = 'image') {
  const text = String(url || '').trim();
  if (!text) return '';
  if (text.startsWith('/files/output/') || text.startsWith('/files/input/')) return text;
  const dataMatch = text.match(/^data:([^;,]+);base64,(.+)$/i);
  if (dataMatch) {
    return writeOutputBuffer(Buffer.from(dataMatch[2], 'base64'), outputExtFromMime(dataMatch[1], defaultExtForKind(kind)));
  }
  if (/^https?:\/\//i.test(text)) {
    const remote = await safeRemoteMediaFetch(text, {
      allowedKinds: [kind],
      maxBytes: kind === 'video' ? 1024 * 1024 * 1024 : kind === 'audio' ? 256 * 1024 * 1024 : 64 * 1024 * 1024,
      deadlineMs: 5 * 60 * 1000,
      idleTimeoutMs: 30 * 1000,
      maxRedirects: 4,
      userAgent: 'T8-PenguinCanvas-GrokOAuth/1.0',
    });
    const ext = outputExtFromMime(
      remote.contentType,
      outputExtFromUrl(remote.finalUrl || text, defaultExtForKind(kind)),
    );
    return writeOutputBuffer(remote.buffer, ext);
  }
  return text;
}

function arrayOf(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function uniqueUrls(...values) {
  return [...new Set(values.flatMap((value) => arrayOf(value)).map((url) => String(url || '').trim()).filter(Boolean))];
}

const VIDEO_DONE_STATUSES = new Set(['done', 'completed', 'complete', 'succeeded', 'success', 'finished', 'ready']);

function hasVideoOutput(data = {}) {
  return Boolean(data.videoUrl || (Array.isArray(data.videoUrls) && data.videoUrls.length > 0));
}

function isCompletedVideoStatus(status) {
  return VIDEO_DONE_STATUSES.has(String(status || '').toLowerCase());
}

function assertCompletedVideoHasOutput(data = {}) {
  if (!isCompletedVideoStatus(data.status) || hasVideoOutput(data)) return;
  const error = new Error('Grok OAuth 视频任务完成但没有返回视频地址。');
  error.code = 'completed_without_video_url';
  throw error;
}

async function normalizeMediaOutputs(data = {}) {
  const patch = {};
  const remoteImageUrls = uniqueUrls(data.imageUrls || data.images || data.urls, data.imageUrl);
  const remoteVideoUrls = uniqueUrls(data.videoUrls || data.videos, data.videoUrl);
  const remoteAudioUrls = uniqueUrls(data.audioUrls || data.audios, data.audioUrl);

  if (remoteImageUrls.length > 0) {
    patch.remoteImageUrls = remoteImageUrls;
    patch.imageUrls = [];
    for (const url of remoteImageUrls) patch.imageUrls.push(await saveOneMediaOutput(url, 'image'));
    patch.imageUrl = patch.imageUrls[0] || '';
  }
  if (remoteVideoUrls.length > 0) {
    patch.remoteVideoUrls = remoteVideoUrls;
    patch.videoUrls = [];
    for (const url of remoteVideoUrls) patch.videoUrls.push(await saveOneMediaOutput(url, 'video'));
    patch.videoUrl = patch.videoUrls[0] || '';
  }
  if (remoteAudioUrls.length > 0) {
    patch.remoteAudioUrls = remoteAudioUrls;
    patch.audioUrls = [];
    for (const url of remoteAudioUrls) patch.audioUrls.push(await saveOneMediaOutput(url, 'audio'));
    patch.audioUrl = patch.audioUrls[0] || '';
  }
  return patch;
}

async function runGrokHook(action, payload = {}) {
  return runLocalHooks(`grokOAuth.${action}`, {
    action,
    handled: false,
    config,
    providerSubmissionKey: currentProviderSubmissionKey() || undefined,
    ...payload,
  });
}

function sendHookJson(res, hookResult, fallbackStatus = 501, fallbackExtra = {}) {
  if (!hookResult?.handled) {
    return res.status(fallbackStatus).json(disabledPayload(fallbackExtra));
  }
  const status = Number(hookResult.status || hookResult.statusCode || 200);
  const ok = hookResult.success !== false && hookResult.ok !== false;
  const data = hookResult.data && typeof hookResult.data === 'object' ? hookResult.data : { ...hookResult };
  delete data.handled;
  delete data.config;
  delete data.action;
  delete data.status;
  delete data.statusCode;
  return res.status(status).json({
    success: ok,
    code: hookResult.code,
    error: ok ? undefined : (hookResult.error || hookResult.message || 'Grok OAuth 调用失败'),
    data,
  });
}

function beginSse(res) {
  if (res.headersSent) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sendSse(res, event, payload = {}) {
  if (res.writableEnded) return;
  beginSse(res);
  const data = {
    type: event,
    event,
    ...payload,
  };
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function endSse(res, result = {}) {
  if (res.writableEnded) return;
  sendSse(res, 'done', { done: true, result });
  res.end();
}

function agentMeta(body = {}, mode = '') {
  const sourceArtifactIds = Array.isArray(body.sourceArtifactIds)
    ? body.sourceArtifactIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return {
    mode,
    turnId: String(body.turnId || ''),
    command: String(body.command || body.slashCommand || mode || ''),
    sourceArtifactIds,
    parentArtifactId: String(body.parentArtifactId || sourceArtifactIds[0] || ''),
  };
}

function decorateAgentArtifact(artifact = {}, meta = {}) {
  return {
    ...artifact,
    turnId: meta.turnId || artifact.turnId || '',
    command: meta.command || artifact.command || '',
    sourceArtifactIds: artifact.sourceArtifactIds || meta.sourceArtifactIds || [],
    parentId: artifact.parentId || meta.parentArtifactId || undefined,
  };
}

function endAgentSse(res, result = {}, meta = {}) {
  if (res.writableEnded) return;
  sendSse(res, 'turn.completed', {
    ...meta,
    message: result?.message || 'Grok OAuth Agent 任务完成',
    progress: typeof result?.progress === 'number' ? result.progress : 100,
    result,
  });
  return endSse(res, result);
}

function sleep(ms, res) {
  return new Promise((resolve, reject) => {
    if (res.destroyed || res.writableEnded) {
      reject(new Error('client_disconnected'));
      return;
    }
    let settled = false;
    const cleanup = () => {
      res.off?.('close', onClose);
      res.removeListener?.('close', onClose);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error('client_disconnected'));
    };
    const timer = setTimeout(finish, ms);
    res.once('close', onClose);
  });
}

function cleanHookData(result = {}) {
  const data = result.data && typeof result.data === 'object' ? { ...result.data } : { ...result };
  delete data.handled;
  delete data.config;
  delete data.action;
  delete data.statusCode;
  return data;
}

function artifactFromResult(kind, data = {}) {
  const artifact = {
    kind,
    status: data.status || 'completed',
    progress: typeof data.progress === 'number' ? data.progress : 100,
    message: data.message || '',
    requestId: data.requestId || data.id || data.taskId || data.generationId || '',
  };
  if (data.text || data.reply || data.prompt) {
    artifact.text = data.text || data.reply || data.prompt;
  }
  if (data.imageUrl || data.imageUrls) {
    artifact.imageUrl = data.imageUrl || (Array.isArray(data.imageUrls) ? data.imageUrls[0] : '');
    artifact.imageUrls = arrayOf(data.imageUrls || data.imageUrl);
    artifact.url = artifact.imageUrl;
    artifact.urls = artifact.imageUrls;
  }
  if (data.videoUrl || data.videoUrls) {
    artifact.videoUrl = data.videoUrl || (Array.isArray(data.videoUrls) ? data.videoUrls[0] : '');
    artifact.videoUrls = arrayOf(data.videoUrls || data.videoUrl);
    artifact.url = artifact.videoUrl;
    artifact.urls = artifact.videoUrls;
  }
  if (data.audioUrl || data.audioUrls) {
    artifact.audioUrl = data.audioUrl || (Array.isArray(data.audioUrls) ? data.audioUrls[0] : '');
    artifact.audioUrls = arrayOf(data.audioUrls || data.audioUrl);
    artifact.url = artifact.audioUrl;
    artifact.urls = artifact.audioUrls;
  }
  return artifact;
}

function modeFromBody(body = {}) {
  const mode = String(body.mode || '').toLowerCase();
  if (['chat', 'image', 'video', 'tts', 'stt'].includes(mode)) return mode;
  if (body.audioUrl && !body.prompt) return 'stt';
  return 'chat';
}

router.get('/status', async (_req, res) => {
  try {
    const result = await runGrokHook('status');
    if (!result?.handled) return res.json(statusPayload());
    const data = result.data && typeof result.data === 'object' ? result.data : result;
    return res.json({
      success: result.success !== false && result.ok !== false,
      code: result.code,
      error: result.error,
      data: {
        available: true,
        moduleEnabled: true,
        ...data,
        handled: undefined,
        config: undefined,
        action: undefined,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, code: 'grok_oauth_status_failed', error: e?.message || String(e) });
  }
});

router.post('/login/start', async (req, res) => {
  try {
    const result = await runGrokHook('loginStart', { body: req.body || {} });
    return sendHookJson(res, result);
  } catch (e) {
    return res.status(500).json({ success: false, code: 'grok_oauth_login_start_failed', error: e?.message || String(e) });
  }
});

router.post('/login/poll', async (req, res) => {
  try {
    const result = await runGrokHook('loginPoll', { body: req.body || {} });
    return sendHookJson(res, result);
  } catch (e) {
    return res.status(500).json({ success: false, code: 'grok_oauth_login_poll_failed', error: e?.message || String(e) });
  }
});

router.post('/login/complete', async (req, res) => {
  try {
    const result = await runGrokHook('loginComplete', { body: req.body || {} });
    if (!result?.handled) {
      const fallback = await runGrokHook('loginPoll', { body: req.body || {} });
      return sendHookJson(res, fallback);
    }
    return sendHookJson(res, result);
  } catch (e) {
    return res.status(500).json({ success: false, code: 'grok_oauth_login_complete_failed', error: e?.message || String(e) });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const result = await runGrokHook('logout', { body: req.body || {} });
    return sendHookJson(res, result);
  } catch (e) {
    return res.status(500).json({ success: false, code: 'grok_oauth_logout_failed', error: e?.message || String(e) });
  }
});

router.post('/chat/stream', async (req, res) => {
  try {
    const result = await runGrokHook('chatStream', { req, res, body: req.body || {} });
    if (result?.handled) return undefined;
    return res.status(501).json(disabledPayload({ mode: 'chat' }));
  } catch (e) {
    if (!res.headersSent) {
      return res.status(500).json({ success: false, code: 'grok_oauth_chat_stream_failed', error: e?.message || String(e) });
    }
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message || String(e) })}\n\n`);
      res.end();
    } catch {
      // response may already be closed
    }
    return undefined;
  }
});

router.post('/agent/stream', async (req, res) => {
  const body = req.body || {};
  const mode = modeFromBody(body);
  const meta = agentMeta(body, mode);
  try {
    const custom = await runGrokHook('agentStream', { req, res, body });
    if (custom?.handled) return undefined;

    if (mode === 'chat') {
      const result = await runGrokHook('chatStream', { req, res, body });
      if (result?.handled) return undefined;
      return res.status(501).json(disabledPayload({ mode: 'chat' }));
    }

    beginSse(res);
    sendSse(res, 'turn.started', {
      ...meta,
      message: `已开始 Grok OAuth ${mode} 任务`,
      progress: 1,
    });
    sendSse(res, 'tool.started', {
      ...meta,
      mode,
      message:
        mode === 'image' ? '正在生成 Grok 图像...'
          : mode === 'video' ? '正在提交 Grok 视频任务...'
            : mode === 'tts' ? '正在生成 Grok 语音...'
              : '正在转写 Grok 音频...',
      progress: 2,
    });

    if (mode === 'image') {
      const hookResult = await runGrokHook('image', { body });
      if (!hookResult?.handled) throw new Error(PRIVATE_DISABLED_MESSAGE);
      const data = cleanHookData(hookResult);
      Object.assign(data, await normalizeMediaOutputs(data));
      const artifact = decorateAgentArtifact(artifactFromResult('image', data), meta);
      sendSse(res, 'artifact.completed', { ...meta, mode, artifact, result: data, progress: 100 });
      return endAgentSse(res, data, meta);
    }

    if (mode === 'tts') {
      const hookResult = await runGrokHook('tts', { body });
      if (!hookResult?.handled) throw new Error(PRIVATE_DISABLED_MESSAGE);
      const data = cleanHookData(hookResult);
      Object.assign(data, await normalizeMediaOutputs(data));
      const artifact = decorateAgentArtifact(artifactFromResult('audio', data), meta);
      sendSse(res, 'artifact.completed', { ...meta, mode, artifact, result: data, progress: 100 });
      return endAgentSse(res, data, meta);
    }

    if (mode === 'stt') {
      const hookResult = await runGrokHook('stt', { body });
      if (!hookResult?.handled) throw new Error(PRIVATE_DISABLED_MESSAGE);
      const data = cleanHookData(hookResult);
      const artifact = decorateAgentArtifact(artifactFromResult('transcript', data), meta);
      sendSse(res, 'message.completed', { ...meta, mode, text: artifact.text || data.text || '', result: data, progress: 100 });
      sendSse(res, 'artifact.completed', { ...meta, mode, artifact, result: data, progress: 100 });
      return endAgentSse(res, data, meta);
    }

    if (mode === 'video') {
      const firstHook = await runGrokHook('videoSubmit', { body });
      if (!firstHook?.handled) throw new Error(PRIVATE_DISABLED_MESSAGE);
      const first = cleanHookData(firstHook);
      Object.assign(first, await normalizeMediaOutputs(first));
      const requestId = first.requestId || first.id || first.taskId || first.generationId;
      if (first.videoUrl || (Array.isArray(first.videoUrls) && first.videoUrls.length > 0)) {
        const artifact = decorateAgentArtifact(artifactFromResult('video', first), meta);
        sendSse(res, 'artifact.completed', { ...meta, mode, artifact, result: first, progress: 100 });
        return endAgentSse(res, first, meta);
      }
      if (!requestId) {
        throw new Error('Grok OAuth 视频任务已提交但没有返回 requestId，无法轮询结果。');
      }
      sendSse(res, 'tool.progress', {
        ...meta,
        mode,
        requestId,
        message: first.message ? `${first.message} 正在轮询结果...` : '视频任务已提交，正在轮询结果...',
        progress: first.progress || 8,
        result: first,
      });
      let lastPoll = first;
      for (let i = 0; i < GROK_VIDEO_AGENT_MAX_POLLS; i += 1) {
        await sleep(GROK_VIDEO_AGENT_POLL_INTERVAL_MS, res);
        const poll = await runGrokHook('videoStatus', { body: { ...body, requestId } });
        if (!poll?.handled) throw new Error(PRIVATE_DISABLED_MESSAGE);
        const data = cleanHookData(poll);
        Object.assign(data, await normalizeMediaOutputs(data));
        lastPoll = data;
        const progress = typeof data.progress === 'number'
          ? data.progress
          : Math.min(95, 10 + Math.round(((i + 1) / GROK_VIDEO_AGENT_MAX_POLLS) * 85));
        sendSse(res, 'tool.progress', {
          ...meta,
          mode,
          requestId,
          message: data.message || `视频生成中 ${i + 1}/${GROK_VIDEO_AGENT_MAX_POLLS}`,
          progress,
          result: data,
        });
        if (data.status === 'failed' || data.error) throw new Error(data.error || data.message || 'Grok OAuth 视频生成失败');
        assertCompletedVideoHasOutput(data);
        if (hasVideoOutput(data) || isCompletedVideoStatus(data.status)) {
          const artifact = decorateAgentArtifact(artifactFromResult('video', data), meta);
          sendSse(res, 'artifact.completed', { ...meta, mode, artifact, result: data, progress: 100 });
          return endAgentSse(res, data, meta);
        }
      }
      const waitedMinutes = Math.round((GROK_VIDEO_AGENT_MAX_POLLS * GROK_VIDEO_AGENT_POLL_INTERVAL_MS) / 60000);
      const lastStatus = lastPoll?.status || lastPoll?.state || lastPoll?.phase || lastPoll?.message || '未知';
      throw new Error(`Grok OAuth 视频生成超时（已等待约 ${waitedMinutes} 分钟，requestId: ${requestId}，最后状态：${lastStatus}）。请稍后重试或用任务 ID 查询。`);
    }

    throw new Error(`不支持的 Grok OAuth Agent 模式：${mode}`);
  } catch (e) {
    const message = e?.message || String(e);
    if (message === 'client_disconnected') return undefined;
    if (!res.headersSent) {
      return res.status(500).json({ success: false, code: 'grok_oauth_agent_stream_failed', error: message });
    }
    sendSse(res, 'artifact.failed', { ...meta, mode, error: message, message });
    if (!res.writableEnded) res.end();
    return undefined;
  }
});

router.post('/image', async (req, res) => {
  try {
    const result = await runGrokHook('image', { body: req.body || {} });
    if (!result?.handled) return res.status(501).json(disabledPayload({ mode: 'image' }));
    const mediaPatch = await normalizeMediaOutputs(result.data || result);
    result.data = { ...(result.data || result), ...mediaPatch };
    return sendHookJson(res, result);
  } catch (e) {
    return res.status(500).json({ success: false, code: 'grok_oauth_image_failed', error: e?.message || String(e) });
  }
});

router.post('/video/submit', async (req, res) => {
  try {
    const result = await runGrokHook('videoSubmit', { body: req.body || {} });
    if (!result?.handled) return res.status(501).json(disabledPayload({ mode: 'video' }));
    const mediaPatch = await normalizeMediaOutputs(result.data || result);
    result.data = { ...(result.data || result), ...mediaPatch };
    return sendHookJson(res, result);
  } catch (e) {
    return res.status(500).json({ success: false, code: 'grok_oauth_video_submit_failed', error: e?.message || String(e) });
  }
});

router.post('/video/status', async (req, res) => {
  try {
    const result = await runGrokHook('videoStatus', { body: req.body || {} });
    if (!result?.handled) return res.status(501).json(disabledPayload({ mode: 'video' }));
    const mediaPatch = await normalizeMediaOutputs(result.data || result);
    result.data = { ...(result.data || result), ...mediaPatch };
    return sendHookJson(res, result);
  } catch (e) {
    return res.status(500).json({ success: false, code: 'grok_oauth_video_status_failed', error: e?.message || String(e) });
  }
});

router.post('/audio/tts', async (req, res) => {
  try {
    const result = await runGrokHook('tts', { body: req.body || {} });
    if (!result?.handled) return res.status(501).json(disabledPayload({ mode: 'tts' }));
    const mediaPatch = await normalizeMediaOutputs(result.data || result);
    result.data = { ...(result.data || result), ...mediaPatch };
    return sendHookJson(res, result);
  } catch (e) {
    return res.status(500).json({ success: false, code: 'grok_oauth_tts_failed', error: e?.message || String(e) });
  }
});

router.post('/audio/stt', async (req, res) => {
  try {
    const result = await runGrokHook('stt', { body: req.body || {} });
    return sendHookJson(res, result, 501, { mode: 'stt' });
  } catch (e) {
    return res.status(500).json({ success: false, code: 'grok_oauth_stt_failed', error: e?.message || String(e) });
  }
});

module.exports = router;
module.exports.PRIVATE_DISABLED_MESSAGE = PRIVATE_DISABLED_MESSAGE;
