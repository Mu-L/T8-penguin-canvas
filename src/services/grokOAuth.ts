const BASE = '/api/grok-oauth';
const GROK_VIDEO_AGENT_POLL_INTERVAL_MS = 5000;
const GROK_VIDEO_AGENT_MAX_POLLS = 180;

export const GROK_OAUTH_PRIVATE_DISABLED_MESSAGE = 'Grok OAuth 私有模块未启用，请使用带私有模块的本地版本。';

export interface GrokOAuthStatus {
  available?: boolean;
  loggedIn?: boolean;
  moduleEnabled?: boolean;
  user?: string;
  account?: string;
  expiresAt?: string;
  message?: string;
  [key: string]: any;
}

export interface GrokOAuthMaterialPayload {
  prompt?: string;
  promptResolved?: string;
  text?: string;
  model?: string;
  mode?: string;
  images?: string[];
  videos?: string[];
  audios?: string[];
  ratio?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  voiceId?: string;
  language?: string;
  outputFormat?: string;
  messages?: Array<Record<string, any>>;
  [key: string]: any;
}

export interface GrokOAuthMediaResult {
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  videoUrls?: string[];
  audioUrl?: string;
  audioUrls?: string[];
  remoteImageUrls?: string[];
  remoteVideoUrls?: string[];
  remoteAudioUrls?: string[];
  text?: string;
  prompt?: string;
  reply?: string;
  requestId?: string;
  transportHttpStatus?: number;
  upstreamHttpStatus?: number;
  usage?: Record<string, unknown>;
  status?: string;
  progress?: number;
  message?: string;
  [key: string]: any;
}

export interface GrokOAuthStreamEvent {
  type?: string;
  event?: string;
  delta?: string;
  text?: string;
  message?: string;
  progress?: number;
  artifact?: GrokOAuthMediaResult & {
    id?: string;
    kind?: 'text' | 'image' | 'video' | 'audio' | 'transcript';
    title?: string;
    url?: string;
    urls?: string[];
  };
  result?: GrokOAuthMediaResult;
  done?: boolean;
  error?: string;
  [key: string]: any;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    // ignore non-json body
  }
  if (!res.ok || data?.success === false) {
    const error = new Error(data?.error || data?.message || `HTTP ${res.status}`) as Error & Record<string, any>;
    error.transportHttpStatus = res.status;
    error.requestId = data?.requestId || data?.request_id || res.headers?.get?.('x-request-id') || undefined;
    error.upstreamHttpStatus = data?.upstreamHttpStatus || data?.upstream_http_status || undefined;
    throw error;
  }
  const payload = data?.data ?? data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload as T;
  const requestId = payload.requestId || payload.request_id || res.headers?.get?.('x-request-id') || undefined;
  const upstreamHttpStatus = Number(payload.upstreamHttpStatus ?? payload.upstream_http_status);
  const usage = payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
    ? payload.usage
    : payload.raw?.usage && typeof payload.raw.usage === 'object' && !Array.isArray(payload.raw.usage)
      ? payload.raw.usage
      : undefined;
  return {
    ...payload,
    ...(requestId ? { requestId } : {}),
    transportHttpStatus: res.status,
    ...(Number.isInteger(upstreamHttpStatus) && upstreamHttpStatus >= 100 && upstreamHttpStatus <= 599 ? { upstreamHttpStatus } : {}),
    ...(usage ? { usage } : {}),
  } as T;
}

export async function getGrokOAuthStatus(): Promise<GrokOAuthStatus> {
  return requestJson<GrokOAuthStatus>(`${BASE}/status`);
}

export async function startGrokOAuthLogin(payload: Record<string, any> = {}): Promise<Record<string, any>> {
  return requestJson<Record<string, any>>(`${BASE}/login/start`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function pollGrokOAuthLogin(payload: Record<string, any> = {}): Promise<Record<string, any>> {
  return requestJson<Record<string, any>>(`${BASE}/login/poll`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function completeGrokOAuthLogin(payload: Record<string, any> = {}): Promise<Record<string, any>> {
  return requestJson<Record<string, any>>(`${BASE}/login/complete`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function logoutGrokOAuth(): Promise<Record<string, any>> {
  return requestJson<Record<string, any>>(`${BASE}/logout`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

function parseSseEvent(raw: string): any | null {
  const eventLine = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .find((line) => line.startsWith('event:'));
  const eventName = eventLine ? eventLine.slice(6).trim() : '';
  const dataLines = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const text = dataLines.join('\n');
  if (!text || text === '[DONE]') return { done: true, event: eventName || 'done' };
  try {
    const parsed = JSON.parse(text);
    return eventName && !parsed.event ? { ...parsed, event: eventName } : parsed;
  } catch {
    return { text, event: eventName };
  }
}

export function extractGrokStreamDeltaForTests(event: any): { delta: string; done: boolean; error?: string } {
  if (!event) return { delta: '', done: false };
  if (event.done) return { delta: '', done: true };
  if (event.error) return { delta: '', done: false, error: String(event.error) };
  if (event.type === 'error') return { delta: '', done: false, error: String(event.message || event.error || 'Grok OAuth 流式输出失败') };
  if (event.type === 'response.completed' || event.type === 'done' || event.event === 'done') return { delta: '', done: true };

  const delta =
    event.delta ||
    event.text_delta ||
    event.output_text_delta ||
    event.outputTextDelta ||
    (event.type === 'response.output_text.delta' ? event.delta : '') ||
    event.choices?.[0]?.delta?.content ||
    event.choices?.[0]?.text ||
    event.output_text ||
    event.text ||
    event.content ||
    '';
  return { delta: typeof delta === 'string' ? delta : '', done: false };
}

export async function streamGrokOAuthChat(
  payload: GrokOAuthMaterialPayload,
  options: {
    signal?: AbortSignal;
    onDelta?: (delta: string, event?: any) => void;
    onEvent?: (event: any) => void;
  } = {},
): Promise<string> {
  const res = await fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data.error || data.message || msg;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  if (!res.body) throw new Error('浏览器不支持流式读取。');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let reply = '';

  const consumeEvent = (raw: string) => {
    const event = parseSseEvent(raw);
    if (!event) return false;
    options.onEvent?.(event);
    const parsed = extractGrokStreamDeltaForTests(event);
    if (parsed.error) throw new Error(parsed.error);
    if (parsed.delta) {
      reply += parsed.delta;
      options.onDelta?.(parsed.delta, event);
    }
    return parsed.done;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let splitAt = buffer.indexOf('\n\n');
    while (splitAt >= 0) {
      const chunk = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      if (consumeEvent(chunk)) return reply;
      splitAt = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) consumeEvent(buffer);
  return reply;
}

function mergeStreamResult(target: GrokOAuthMediaResult, event: GrokOAuthStreamEvent) {
  const result = event.result && typeof event.result === 'object' ? event.result : null;
  const artifact = event.artifact && typeof event.artifact === 'object' ? event.artifact : null;
  for (const source of [result, artifact]) {
    if (!source) continue;
    const kind = String((source as any).kind || '').toLowerCase();
    const genericUrls = Array.isArray((source as any).urls)
      ? (source as any).urls
      : ((source as any).url ? [(source as any).url] : []);
    if (source.text || source.reply || source.prompt) {
      target.text = source.text || source.reply || source.prompt;
      target.reply = target.text;
    }
    if (source.imageUrl) target.imageUrl = source.imageUrl;
    if (Array.isArray(source.imageUrls)) target.imageUrls = source.imageUrls;
    if (kind === 'image' && genericUrls.length > 0) {
      target.imageUrls = genericUrls;
      target.imageUrl = genericUrls[0] || target.imageUrl;
    }
    if (source.videoUrl) target.videoUrl = source.videoUrl;
    if (Array.isArray(source.videoUrls)) target.videoUrls = source.videoUrls;
    if (kind === 'video' && genericUrls.length > 0) {
      target.videoUrls = genericUrls;
      target.videoUrl = genericUrls[0] || target.videoUrl;
    }
    if (source.audioUrl) target.audioUrl = source.audioUrl;
    if (Array.isArray(source.audioUrls)) target.audioUrls = source.audioUrls;
    if (kind === 'audio' && genericUrls.length > 0) {
      target.audioUrls = genericUrls;
      target.audioUrl = genericUrls[0] || target.audioUrl;
    }
    if (source.requestId) target.requestId = source.requestId;
    if (source.status) target.status = source.status;
    if (typeof source.progress === 'number') target.progress = source.progress;
    if (source.message) target.message = source.message;
  }
}

function fallbackDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function fallbackArtifact(kind: 'text' | 'image' | 'video' | 'audio' | 'transcript', result: GrokOAuthMediaResult): NonNullable<GrokOAuthStreamEvent['artifact']> {
  const artifact: NonNullable<GrokOAuthStreamEvent['artifact']> = {
    kind,
    status: result.status || 'completed',
    progress: typeof result.progress === 'number' ? result.progress : 100,
    requestId: result.requestId || result.id || result.taskId || result.generationId || '',
    message: result.message || '',
  };
  if (result.text || result.reply || result.prompt) artifact.text = result.text || result.reply || result.prompt;
  if (kind === 'image') {
    const urls = Array.isArray(result.imageUrls) ? result.imageUrls : (result.imageUrl ? [result.imageUrl] : []);
    artifact.imageUrls = urls;
    artifact.imageUrl = urls[0] || '';
    artifact.urls = urls;
    artifact.url = urls[0] || '';
  }
  if (kind === 'video') {
    const urls = Array.isArray(result.videoUrls) ? result.videoUrls : (result.videoUrl ? [result.videoUrl] : []);
    artifact.videoUrls = urls;
    artifact.videoUrl = urls[0] || '';
    artifact.urls = urls;
    artifact.url = urls[0] || '';
  }
  if (kind === 'audio') {
    const urls = Array.isArray(result.audioUrls) ? result.audioUrls : (result.audioUrl ? [result.audioUrl] : []);
    artifact.audioUrls = urls;
    artifact.audioUrl = urls[0] || '';
    artifact.urls = urls;
    artifact.url = urls[0] || '';
  }
  return artifact;
}

const VIDEO_DONE_STATUSES = new Set(['done', 'completed', 'complete', 'succeeded', 'success', 'finished', 'ready']);

function hasVideoOutput(result: GrokOAuthMediaResult = {}) {
  return Boolean(result.videoUrl || (Array.isArray(result.videoUrls) && result.videoUrls.length > 0));
}

function isCompletedVideoStatus(status: unknown) {
  return VIDEO_DONE_STATUSES.has(String(status || '').toLowerCase());
}

function completedVideoWithoutOutputError() {
  const error = new Error('Grok OAuth 视频任务完成但没有返回视频地址。') as Error & { code?: string };
  error.code = 'completed_without_video_url';
  return error;
}

function agentEventMeta(payload: GrokOAuthMaterialPayload, mode: string) {
  const sourceArtifactIds = Array.isArray(payload.sourceArtifactIds)
    ? payload.sourceArtifactIds.map((item: any) => String(item || '').trim()).filter(Boolean)
    : [];
  return {
    mode,
    turnId: String(payload.turnId || ''),
    command: String(payload.command || payload.slashCommand || mode || ''),
    sourceArtifactIds,
    parentArtifactId: String(payload.parentArtifactId || sourceArtifactIds[0] || ''),
  };
}

function withAgentArtifactMeta<T extends NonNullable<GrokOAuthStreamEvent['artifact']>>(artifact: T, meta: ReturnType<typeof agentEventMeta>): T {
  return {
    ...artifact,
    turnId: meta.turnId || (artifact as any).turnId || '',
    command: meta.command || (artifact as any).command || '',
    sourceArtifactIds: (artifact as any).sourceArtifactIds || meta.sourceArtifactIds || [],
    parentId: (artifact as any).parentId || meta.parentArtifactId || undefined,
  };
}

async function runLegacyGrokOAuthAgentFallback(
  payload: GrokOAuthMaterialPayload,
  options: {
    signal?: AbortSignal;
    onDelta?: (delta: string, event?: GrokOAuthStreamEvent) => void;
    onEvent?: (event: GrokOAuthStreamEvent) => void;
  } = {},
): Promise<GrokOAuthMediaResult> {
  const mode = String(payload.mode || 'chat').toLowerCase();
  const emit = (event: GrokOAuthStreamEvent) => options.onEvent?.(event);
  const meta = agentEventMeta(payload, mode);
  emit({
    type: 'turn.started',
    event: 'turn.started',
    ...meta,
    progress: 1,
    message: `已开始 Grok OAuth ${mode} 任务`,
  });
  emit({
    type: 'tool.started',
    event: 'tool.started',
    ...meta,
    progress: 1,
    message: '当前后端缺少 agent/stream，已自动切换旧接口兼容模式。',
  });

  if (mode === 'chat') {
    const reply = await streamGrokOAuthChat(payload, {
      signal: options.signal,
      onDelta: (delta, event) => options.onDelta?.(delta, { ...(event || {}), mode }),
      onEvent: (event) => options.onEvent?.({ ...(event || {}), mode }),
    });
    const result: GrokOAuthMediaResult = { text: reply, reply, status: 'completed', progress: 100 };
    emit({ type: 'message.completed', event: 'message.completed', ...meta, text: reply, result, progress: 100 });
    emit({ type: 'turn.completed', event: 'turn.completed', ...meta, result, progress: 100, message: 'Grok OAuth Agent 任务完成' });
    emit({ type: 'done', event: 'done', ...meta, done: true, result });
    return result;
  }

  if (mode === 'image') {
    const result = await generateGrokOAuthImage(payload);
    const artifact = withAgentArtifactMeta(fallbackArtifact('image', result), meta);
    emit({ type: 'artifact.completed', event: 'artifact.completed', ...meta, artifact, result, progress: 100 });
    emit({ type: 'turn.completed', event: 'turn.completed', ...meta, result, progress: 100, message: 'Grok OAuth Agent 任务完成' });
    emit({ type: 'done', event: 'done', ...meta, done: true, result });
    return result;
  }

  if (mode === 'tts') {
    const result = await generateGrokOAuthTts(payload);
    const artifact = withAgentArtifactMeta(fallbackArtifact('audio', result), meta);
    emit({ type: 'artifact.completed', event: 'artifact.completed', ...meta, artifact, result, progress: 100 });
    emit({ type: 'turn.completed', event: 'turn.completed', ...meta, result, progress: 100, message: 'Grok OAuth Agent 任务完成' });
    emit({ type: 'done', event: 'done', ...meta, done: true, result });
    return result;
  }

  if (mode === 'stt') {
    const result = await transcribeGrokOAuthAudio(payload);
    const artifact = withAgentArtifactMeta(fallbackArtifact('transcript', result), meta);
    emit({ type: 'message.completed', event: 'message.completed', ...meta, text: artifact?.text || result.text || '', result, progress: 100 });
    emit({ type: 'artifact.completed', event: 'artifact.completed', ...meta, artifact, result, progress: 100 });
    emit({ type: 'turn.completed', event: 'turn.completed', ...meta, result, progress: 100, message: 'Grok OAuth Agent 任务完成' });
    emit({ type: 'done', event: 'done', ...meta, done: true, result });
    return result;
  }

  if (mode === 'video') {
    const first = await submitGrokOAuthVideo(payload);
    const requestId = first.requestId || first.id || first.taskId || first.generationId;
    if (hasVideoOutput(first)) {
      const artifact = withAgentArtifactMeta(fallbackArtifact('video', first), meta);
      emit({ type: 'artifact.completed', event: 'artifact.completed', ...meta, artifact, result: first, progress: 100 });
      emit({ type: 'turn.completed', event: 'turn.completed', ...meta, result: first, progress: typeof first.progress === 'number' ? first.progress : 100, message: 'Grok OAuth Agent 任务完成' });
      emit({ type: 'done', event: 'done', ...meta, done: true, result: first });
      return first;
    }
    if (!requestId) {
      throw new Error('Grok OAuth 视频任务已提交但没有返回 requestId，无法轮询结果。');
    }
    emit({
      type: 'tool.progress',
      event: 'tool.progress',
      ...meta,
      requestId,
      pollCount: 0,
      progress: first.progress || 8,
      message: first.message ? `${first.message} 旧接口兼容轮询中...` : '视频任务已提交，旧接口兼容轮询中...',
      result: first,
    });
    let lastPoll: GrokOAuthMediaResult = first;
    for (let i = 0; i < GROK_VIDEO_AGENT_MAX_POLLS; i += 1) {
      await fallbackDelay(GROK_VIDEO_AGENT_POLL_INTERVAL_MS, options.signal);
      const result = await queryGrokOAuthVideoStatus({ ...payload, requestId });
      lastPoll = result;
      emit({
        type: 'tool.progress',
        event: 'tool.progress',
        ...meta,
        requestId,
        pollCount: i + 1,
        progress: typeof result.progress === 'number'
          ? result.progress
          : Math.min(95, 10 + Math.round(((i + 1) / GROK_VIDEO_AGENT_MAX_POLLS) * 85)),
        message: result.message || `视频生成中 ${i + 1}/${GROK_VIDEO_AGENT_MAX_POLLS}`,
        result,
      });
      if (result.status === 'failed' || result.error) throw new Error(result.error || result.message || 'Grok OAuth 视频生成失败');
      if (isCompletedVideoStatus(result.status) && !hasVideoOutput(result)) throw completedVideoWithoutOutputError();
      if (hasVideoOutput(result) || isCompletedVideoStatus(result.status)) {
        const artifact = withAgentArtifactMeta(fallbackArtifact('video', result), meta);
        emit({ type: 'artifact.completed', event: 'artifact.completed', ...meta, artifact, result, progress: 100 });
        emit({ type: 'turn.completed', event: 'turn.completed', ...meta, result, progress: 100, message: 'Grok OAuth Agent 任务完成' });
        emit({ type: 'done', event: 'done', ...meta, done: true, result });
        return result;
      }
    }
    const waitedMinutes = Math.round((GROK_VIDEO_AGENT_MAX_POLLS * GROK_VIDEO_AGENT_POLL_INTERVAL_MS) / 60000);
    const lastStatus = lastPoll?.status || lastPoll?.state || lastPoll?.phase || lastPoll?.message || '未知';
    throw new Error(`Grok OAuth 视频生成超时（已等待约 ${waitedMinutes} 分钟，requestId: ${requestId}，最后状态：${lastStatus}）。请稍后重试或用任务 ID 查询。`);
  }

  throw new Error(`不支持的 Grok OAuth Agent 模式：${mode}`);
}

export async function streamGrokOAuthAgent(
  payload: GrokOAuthMaterialPayload,
  options: {
    signal?: AbortSignal;
    onDelta?: (delta: string, event?: GrokOAuthStreamEvent) => void;
    onEvent?: (event: GrokOAuthStreamEvent) => void;
  } = {},
): Promise<GrokOAuthMediaResult> {
  const res = await fetch(`${BASE}/agent/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let bodyText = '';
    try {
      bodyText = await res.text();
      if (bodyText) {
        try {
          const data = JSON.parse(bodyText);
          msg = data.error || data.message || msg;
        } catch {
          msg = bodyText;
        }
      }
    } catch {
      // ignore
    }
    if (res.status === 404 && /Cannot POST\s+\/api\/grok-oauth\/agent\/stream/i.test(bodyText || msg)) {
      return runLegacyGrokOAuthAgentFallback(payload, options);
    }
    throw new Error(msg);
  }
  if (!res.body) throw new Error('浏览器不支持流式读取。');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let reply = '';
  const result: GrokOAuthMediaResult = {};

  const consumeEvent = (raw: string) => {
    const event = parseSseEvent(raw) as GrokOAuthStreamEvent | null;
    if (!event) return false;
    options.onEvent?.(event);
    if (event.error || event.type === 'error' || event.event === 'error' || event.type === 'artifact.failed') {
      throw new Error(String(event.error || event.message || 'Grok OAuth Agent 流式任务失败'));
    }
    const parsed = extractGrokStreamDeltaForTests(event);
    const delta =
      parsed.delta ||
      (event.type === 'message.delta' && typeof event.delta === 'string' ? event.delta : '') ||
      (event.event === 'message.delta' && typeof event.delta === 'string' ? event.delta : '');
    if (delta) {
      reply += delta;
      result.text = reply;
      result.reply = reply;
      options.onDelta?.(delta, event);
    }
    mergeStreamResult(result, event);
    if (event.done || parsed.done || event.type === 'done' || event.event === 'done') {
      if (reply && !result.text) {
        result.text = reply;
        result.reply = reply;
      }
      return true;
    }
    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let splitAt = buffer.indexOf('\n\n');
    while (splitAt >= 0) {
      const chunk = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      if (consumeEvent(chunk)) return result;
      splitAt = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim()) consumeEvent(buffer);
  if (reply && !result.text) {
    result.text = reply;
    result.reply = reply;
  }
  return result;
}

export async function generateGrokOAuthImage(payload: GrokOAuthMaterialPayload): Promise<GrokOAuthMediaResult> {
  return requestJson<GrokOAuthMediaResult>(`${BASE}/image`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function submitGrokOAuthVideo(payload: GrokOAuthMaterialPayload): Promise<GrokOAuthMediaResult> {
  return requestJson<GrokOAuthMediaResult>(`${BASE}/video/submit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function queryGrokOAuthVideoStatus(payload: Record<string, any>): Promise<GrokOAuthMediaResult> {
  return requestJson<GrokOAuthMediaResult>(`${BASE}/video/status`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function generateGrokOAuthTts(payload: GrokOAuthMaterialPayload): Promise<GrokOAuthMediaResult> {
  return requestJson<GrokOAuthMediaResult>(`${BASE}/audio/tts`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function transcribeGrokOAuthAudio(payload: GrokOAuthMaterialPayload): Promise<GrokOAuthMediaResult> {
  return requestJson<GrokOAuthMediaResult>(`${BASE}/audio/stt`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
