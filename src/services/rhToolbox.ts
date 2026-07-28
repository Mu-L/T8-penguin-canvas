import {
  cancelRh,
  fetchRhAppInfo,
  queryRh,
  submitRh,
  uploadRhAsset,
  type ProviderTransportTrace,
  type RhSite,
} from './generation';
import { RH_TOOLBOX_MANIFEST } from '../data/rhToolboxManifest';
import {
  buildRhToolboxNodeInfoList,
  classifyRhToolboxOutputs,
  findRhToolboxToolById,
  normalizeRhToolboxManifest,
  pickRhToolboxInputs,
  RH_TOOLBOX_DEFAULT_MAX_POLLS,
  RH_TOOLBOX_DEFAULT_POLL_INTERVAL_MS,
  type RhToolboxInputPools,
  type RhToolboxManifest,
  type RhToolboxNodeInfoItem,
  type RhToolboxOutputClassification,
  type RhToolboxTool,
} from '../utils/rhToolbox';

export type RhToolboxProgressStage =
  | 'prepare'
  | 'app-info'
  | 'upload'
  | 'submit'
  | 'poll'
  | 'cancel'
  | 'success'
  | 'error';

export interface RunRhToolboxProgress extends ProviderTransportTrace {
  stage: RhToolboxProgressStage;
  message: string;
  taskId?: string;
  pollCount?: number;
}

export interface RunRhToolboxToolOptions {
  toolId: string;
  manifest?: RhToolboxManifest;
  inputs?: RhToolboxInputPools;
  inputValues?: Record<string, string | string[]>;
  userParams?: Record<string, string | number | boolean>;
  instanceType?: string;
  appInfo?: any;
  signal?: AbortSignal;
  submissionKey?: string | null;
  onProgress?: (progress: RunRhToolboxProgress) => void | Promise<void>;
}

export interface RunRhToolboxToolResult extends RhToolboxOutputClassification, ProviderTransportTrace {
  tool: RhToolboxTool;
  taskId: string;
  nodeInfoList: RhToolboxNodeInfoItem[];
  appInfo?: any;
  raw?: any;
  site?: RhSite;
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

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('已取消');
}

function isMediaInputKind(kind: string): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio';
}

function hasInputValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasInputValue(item));
  return String(value ?? '').trim() !== '';
}

async function resolveRhToolboxInputValues(
  tool: RhToolboxTool,
  rawValues: Record<string, string | string[]>,
  onProgress?: (progress: RunRhToolboxProgress) => void | Promise<void>,
  signal?: AbortSignal,
  siteState: { current: RhSite } = { current: 'cn' },
): Promise<Record<string, string | string[]>> {
  const resolved: Record<string, string | string[]> = {};
  for (const input of tool.inputSchema) {
    assertNotAborted(signal);
    const raw = rawValues[input.key];
    if (raw == null || raw === '') continue;
    const values = Array.isArray(raw) ? raw : [raw];
    const next: string[] = [];
    for (const value of values) {
      const v = String(value || '').trim();
      if (!v) continue;
      if (isMediaInputKind(input.kind) && input.uploadAsset !== false) {
        await onProgress?.({ stage: 'upload', message: `上传 ${input.label || input.key}` });
        const uploaded = await uploadRhAsset(v, siteState.current);
        if (uploaded.site) siteState.current = uploaded.site;
        next.push(uploaded.fileName || v);
      } else {
        next.push(v);
      }
    }
    if (next.length > 0) {
      resolved[input.key] = input.multiple ? next : next[0];
    }
  }
  return resolved;
}

function normalizeFailedReason(reason: any, fallback = 'RH 工具箱任务失败'): string {
  if (reason == null || reason === '') return fallback;
  if (typeof reason === 'string') return reason;
  try {
    return reason.exception_message || reason.message || JSON.stringify(reason);
  } catch {
    return fallback;
  }
}

async function cancelSubmittedRhTask(
  taskId: string,
  site: RhSite,
  progress?: (progress: RunRhToolboxProgress) => void | Promise<void>,
): Promise<void> {
  if (!taskId) return;
  await progress?.({ stage: 'cancel', message: '取消 RH 后台任务', taskId });
  try {
    await cancelRh(taskId, site);
    await progress?.({ stage: 'cancel', message: '已请求取消 RH 后台任务', taskId });
  } catch (error: any) {
    const message = `取消 RH 后台任务失败：${error?.message || error}`;
    await progress?.({
      stage: 'error',
      message,
      taskId,
    });
    throw new Error(message);
  }
}

export function getRhToolboxManifest(): RhToolboxManifest {
  return normalizeRhToolboxManifest(RH_TOOLBOX_MANIFEST);
}

export async function runRhToolboxTool(options: RunRhToolboxToolOptions): Promise<RunRhToolboxToolResult> {
  const manifest = normalizeRhToolboxManifest(options.manifest || RH_TOOLBOX_MANIFEST);
  const tool = findRhToolboxToolById(manifest, options.toolId);
  if (!tool) throw new Error('RH工具箱未找到可用工具');
  if (!tool.enabled || !tool.webappId) throw new Error('该 RH工具箱工具尚未启用');

  const progress = options.onProgress;
  const siteState: { current: RhSite } = { current: tool.rhSite === 'intl' ? 'intl' : 'cn' };
  await progress?.({ stage: 'prepare', message: `准备运行 ${tool.title}` });

  const picked = pickRhToolboxInputs(tool, options.inputs || {});
  const explicitInputValues = options.inputValues || {};
  const missing = tool.inputSchema
    .filter((input) => input.required !== false)
    .filter((input) => !hasInputValue(picked.values[input.key]) && !hasInputValue(explicitInputValues[input.key]) && !hasInputValue(input.defaultValue))
    .map((input) => input.label || input.key);
  if (missing.length > 0) {
    throw new Error(`缺少输入：${missing.join('、')}（可在节点内填写/上传，或从左侧连接上游素材）`);
  }

  assertNotAborted(options.signal);
  const appInfo = options.appInfo || (tool.runtime?.fetchAppInfo === false
    ? undefined
    : await (async () => {
        await progress?.({ stage: 'app-info', message: '读取 RH 应用字段' });
        const info = await fetchRhAppInfo(tool.webappId, siteState.current);
        if (info?.rhSite) siteState.current = info.rhSite;
        return info;
      })());

  const inputValues = await resolveRhToolboxInputValues(tool, {
    ...picked.values,
    ...explicitInputValues,
  }, progress, options.signal, siteState);
  const nodeInfoList = buildRhToolboxNodeInfoList(tool, {
    inputValues,
    userParamValues: options.userParams,
  });

  let taskId = '';
  let remoteTaskCompleted = false;
  let remoteCancelRequested = false;
  const cancelTaskIfNeeded = async () => {
    if (!taskId || remoteTaskCompleted || remoteCancelRequested) return;
    remoteCancelRequested = true;
    await cancelSubmittedRhTask(taskId, siteState.current, progress);
  };
  try {
    await progress?.({ stage: 'submit', message: '提交 RH 任务' });
    const submitResult = await submitRh({
      webappId: tool.webappId,
      nodeInfoList,
      instanceType: options.instanceType || tool.runtime?.instanceType || undefined,
      site: siteState.current,
    }, { submissionKey: options.submissionKey });
    taskId = submitResult.taskId;
    siteState.current = submitResult.site || siteState.current;
    if (!taskId) throw new Error('RH 未返回 taskId');
    await progress?.({
      stage: 'submit',
      message: '已提交 RH 任务',
      taskId,
      requestId: submitResult.requestId,
      transportHttpStatus: submitResult.transportHttpStatus,
      upstreamHttpStatus: submitResult.upstreamHttpStatus,
      usage: submitResult.usage,
    });
    if (options.signal?.aborted) {
      await cancelTaskIfNeeded();
      throw new Error('已取消');
    }

    const pollIntervalMs = Math.max(1000, tool.runtime?.pollIntervalMs || RH_TOOLBOX_DEFAULT_POLL_INTERVAL_MS);
    const maxPolls = Math.max(1, tool.runtime?.maxPolls || RH_TOOLBOX_DEFAULT_MAX_POLLS);
    let lastRaw: any;
    let lastError = '';

    for (let pollCount = 1; pollCount <= maxPolls; pollCount += 1) {
      assertNotAborted(options.signal);
      await progress?.({ stage: 'poll', message: `轮询中 ${pollCount}/${maxPolls}`, taskId, pollCount });
      await delay(pollIntervalMs, options.signal);
      try {
        const query = await queryRh(taskId, siteState.current);
        if (query.site) siteState.current = query.site;
        lastRaw = query;
        await progress?.({
          stage: 'poll',
          message: `轮询响应 ${pollCount}/${maxPolls}`,
          taskId,
          pollCount,
          requestId: query.requestId,
          transportHttpStatus: query.transportHttpStatus,
          upstreamHttpStatus: query.upstreamHttpStatus,
          usage: query.usage,
        });
        const normalizedStatus = String(query.status || '').trim().toUpperCase();
        if (normalizedStatus === 'MATERIALIZING') {
          // Provider 已经完成，当前只剩结果文件转存。即使随后本地轮询超时，
          // 也不能再向 RunningHub 发送取消，更不能重新提交付费任务。
          remoteTaskCompleted = true;
          lastError = query.error || 'RH 结果已经生成，正在适配 TUN/代理网络并安全下载；原任务会保留';
          await progress?.({
            stage: 'poll',
            message: lastError,
            taskId,
            pollCount,
            requestId: query.requestId,
            transportHttpStatus: query.transportHttpStatus,
            upstreamHttpStatus: query.upstreamHttpStatus,
            usage: query.usage,
          });
          continue;
        }
        if (normalizedStatus === 'SUCCESS') {
          remoteTaskCompleted = true;
          const classified = classifyRhToolboxOutputs(query.urls || []);
          await progress?.({
            stage: 'success',
            message: `完成 · ${classified.urls.length} 个输出`,
            taskId,
            pollCount,
            requestId: query.requestId,
            transportHttpStatus: query.transportHttpStatus,
            upstreamHttpStatus: query.upstreamHttpStatus,
            usage: query.usage,
          });
          return {
            ...classified,
            tool,
            taskId,
            nodeInfoList,
            appInfo,
            raw: query,
            site: siteState.current,
            requestId: query.requestId || submitResult.requestId,
            transportHttpStatus: query.transportHttpStatus,
            upstreamHttpStatus: query.upstreamHttpStatus,
            usage: query.usage,
          };
        }
        if (normalizedStatus === 'FAILED') {
          remoteTaskCompleted = true;
          throw new Error(normalizeFailedReason(query.failReason));
        }
      } catch (error: any) {
        lastError = error?.message || String(error);
        if (lastRaw?.status === 'FAILED') break;
      }
    }

    await progress?.({ stage: 'error', message: lastError || 'RH 工具箱轮询超时', taskId });
    if (!remoteTaskCompleted) await cancelTaskIfNeeded();
    throw new Error(lastError || 'RH 工具箱轮询超时');
  } catch (error) {
    if (options.signal?.aborted && taskId && !remoteTaskCompleted) {
      await cancelTaskIfNeeded();
    }
    throw error;
  }
}
