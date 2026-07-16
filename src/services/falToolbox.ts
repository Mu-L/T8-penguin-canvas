import { FAL_TOOLBOX_MANIFEST } from '../data/falToolboxManifest';
import {
  buildFalToolboxRunPayload,
  classifyFalToolboxOutputs,
  findFalToolboxToolById,
  normalizeFalToolboxManifest,
  pickFalToolboxInputs,
  type FalToolboxInputPools,
  type FalToolboxManifest,
  type FalToolboxOutputClassification,
  type FalToolboxRunPayload,
  type FalToolboxTool,
} from '../utils/falToolbox';

export type FalToolboxProgressStage =
  | 'prepare'
  | 'submit'
  | 'poll'
  | 'success'
  | 'error';

export interface RunFalToolboxProgress {
  stage: FalToolboxProgressStage;
  message: string;
  requestId?: string;
  pollCount?: number;
  transportHttpStatus?: number;
  upstreamHttpStatus?: number;
  usage?: Record<string, unknown>;
}

export interface RunFalToolboxToolOptions {
  toolId: string;
  manifest?: FalToolboxManifest;
  inputs?: FalToolboxInputPools;
  inputValues?: Record<string, string | string[]>;
  userParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  onProgress?: (progress: RunFalToolboxProgress) => void;
}

export interface RunFalToolboxToolResult extends FalToolboxOutputClassification {
  tool: FalToolboxTool;
  requestId?: string;
  responseUrl?: string;
  raw?: any;
  transportHttpStatus?: number;
  upstreamHttpStatus?: number;
  usage?: Record<string, unknown>;
}

function withTransportTrace(payload: any, response: Response): any {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const requestId = String(record.requestId || record.request_id || response.headers?.get?.('x-request-id') || '').trim();
  const upstreamHttpStatus = Number(record.upstreamHttpStatus ?? record.upstream_http_status);
  const usage = record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
    ? record.usage
    : record.raw?.usage && typeof record.raw.usage === 'object' && !Array.isArray(record.raw.usage)
      ? record.raw.usage
      : undefined;
  return {
    ...record,
    ...(requestId ? { requestId } : {}),
    transportHttpStatus: response.status,
    ...(Number.isInteger(upstreamHttpStatus) && upstreamHttpStatus >= 100 && upstreamHttpStatus <= 599 ? { upstreamHttpStatus } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function getFalToolboxManifest(): FalToolboxManifest {
  return normalizeFalToolboxManifest(FAL_TOOLBOX_MANIFEST);
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('已取消');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('已取消'));
    };
    signal?.addEventListener('abort', onAbort);
  });
}

async function readJsonResponse(r: Response): Promise<any> {
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, error: text || `HTTP ${r.status}` };
  }
}

function errorFromResponse(data: any, fallback: string): string {
  return data?.error || data?.message || data?.data?.error || data?.data?.message || fallback;
}

function hasRunInputValue(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some((item) => String(item || '').trim().length > 0);
  return String(value).trim().length > 0;
}

export async function submitFalToolbox(payload: FalToolboxRunPayload): Promise<any> {
  const r = await fetch('/api/proxy/fal-toolbox/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await readJsonResponse(r);
  if (!r.ok || !data.success) {
    throw new Error(errorFromResponse(data, `FAL HTTP ${r.status}`));
  }
  return withTransportTrace(data.data || {}, r);
}

export async function queryFalToolbox(payload: {
  endpoint: string;
  requestId: string;
  responseUrl?: string;
  statusUrl?: string;
  outputSchema?: any[];
  statusPath?: string;
}): Promise<any> {
  const r = await fetch('/api/proxy/fal-toolbox/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await readJsonResponse(r);
  if (!r.ok || !data.success) {
    if (data?.data?.status === 'failed') return withTransportTrace(data.data, r);
    throw new Error(errorFromResponse(data, `FAL Poll HTTP ${r.status}`));
  }
  return withTransportTrace(data.data || {}, r);
}

export async function runFalToolboxTool(options: RunFalToolboxToolOptions): Promise<RunFalToolboxToolResult> {
  const manifest = normalizeFalToolboxManifest(options.manifest || FAL_TOOLBOX_MANIFEST);
  const tool = findFalToolboxToolById(manifest, options.toolId);
  if (!tool) throw new Error('Fal超市未找到可用工具');
  if (!tool.enabled || !tool.endpoint) throw new Error('该 Fal 工具尚未启用');

  const progress = options.onProgress;
  progress?.({ stage: 'prepare', message: `准备运行 ${tool.title}` });
  const picked = pickFalToolboxInputs(tool, options.inputs || {});
  const explicitInputValues = options.inputValues || {};
  if (picked.missingKeys.length > 0) {
    const stillMissing = picked.missingKeys
      .filter((key) => !hasRunInputValue(explicitInputValues[key]))
      .map((key) => tool.inputSchema.find((input) => input.key === key)?.label || key);
    if (stillMissing.length > 0) {
      throw new Error(`缺少输入：${stillMissing.join('、')}`);
    }
  }

  assertNotAborted(options.signal);
  const runPayload = buildFalToolboxRunPayload(tool, {
    inputValues: { ...picked.values, ...explicitInputValues },
    userParamValues: options.userParams,
  });

  progress?.({ stage: 'submit', message: '提交 FAL 任务' });
  const submitted = await submitFalToolbox(runPayload);
  progress?.({
    stage: 'submit',
    message: '已提交 FAL 任务',
    requestId: submitted.requestId || submitted.request_id,
    transportHttpStatus: submitted.transportHttpStatus,
    upstreamHttpStatus: submitted.upstreamHttpStatus,
    usage: submitted.usage,
  });
  const initial = classifyFalToolboxOutputs(submitted);
  if (submitted.status === 'completed' || submitted.sync === true || initial.urls.length || initial.textOutputs.length) {
    progress?.({
      stage: 'success',
      message: `完成 · ${initial.urls.length + initial.textOutputs.length} 个输出`,
      requestId: submitted.requestId,
      transportHttpStatus: submitted.transportHttpStatus,
      upstreamHttpStatus: submitted.upstreamHttpStatus,
      usage: submitted.usage,
    });
    return {
      ...initial,
      tool,
      requestId: submitted.requestId,
      responseUrl: submitted.responseUrl,
      raw: submitted.raw || submitted,
      transportHttpStatus: submitted.transportHttpStatus,
      upstreamHttpStatus: submitted.upstreamHttpStatus,
      usage: submitted.usage,
    };
  }
  if (submitted.status === 'failed') {
    throw new Error(submitted.error || 'FAL 任务失败');
  }

  const requestId = submitted.requestId || submitted.request_id;
  if (!requestId) {
    throw new Error('FAL 未返回 request_id');
  }
  const responseUrl = submitted.responseUrl || submitted.response_url;
  const statusUrl = submitted.statusUrl || submitted.status_url;
  const pollIntervalMs = Math.max(1000, tool.runtime?.pollIntervalMs || 3000);
  const maxPolls = Math.max(1, tool.runtime?.maxPolls || 360);
  let lastRaw: any = submitted.raw || submitted;
  let transientPollErrors = 0;

  for (let pollCount = 1; pollCount <= maxPolls; pollCount += 1) {
    assertNotAborted(options.signal);
    progress?.({
      stage: 'poll',
      message: transientPollErrors > 0 ? `轮询重试 ${transientPollErrors}/3 · ${pollCount}/${maxPolls}` : `轮询中 ${pollCount}/${maxPolls}`,
      requestId,
      pollCount,
    });
    await delay(pollIntervalMs, options.signal);
    let query: any;
    try {
      query = await queryFalToolbox({
        endpoint: tool.endpoint,
        requestId,
        responseUrl,
        statusUrl,
        outputSchema: tool.outputSchema,
        statusPath: tool.runtime?.statusPath,
      });
      progress?.({
        stage: 'poll',
        message: `轮询响应 ${pollCount}/${maxPolls}`,
        requestId,
        pollCount,
        transportHttpStatus: query.transportHttpStatus,
        upstreamHttpStatus: query.upstreamHttpStatus,
        usage: query.usage,
      });
      transientPollErrors = 0;
    } catch (error) {
      transientPollErrors += 1;
      if (transientPollErrors > 3) throw error;
      continue;
    }
    lastRaw = query.raw || query;
    if (query.status === 'failed') {
      throw new Error(query.error || 'FAL 任务失败');
    }
    const classified = classifyFalToolboxOutputs(query);
    if (query.status === 'completed' || classified.urls.length || classified.textOutputs.length) {
      progress?.({
        stage: 'success',
        message: `完成 · ${classified.urls.length + classified.textOutputs.length} 个输出`,
        requestId,
        pollCount,
        transportHttpStatus: query.transportHttpStatus,
        upstreamHttpStatus: query.upstreamHttpStatus,
        usage: query.usage,
      });
      return {
        ...classified,
        tool,
        requestId,
        responseUrl,
        raw: lastRaw,
        transportHttpStatus: query.transportHttpStatus,
        upstreamHttpStatus: query.upstreamHttpStatus,
        usage: query.usage,
      };
    }
  }

  progress?.({ stage: 'error', message: 'Fal超市轮询超时', requestId });
  throw new Error('Fal超市轮询超时');
}
