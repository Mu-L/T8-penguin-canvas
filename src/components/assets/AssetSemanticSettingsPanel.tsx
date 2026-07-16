import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, RefreshCw, Save, Trash2 } from 'lucide-react';
import {
  ApiRequestError,
  deleteProjectAssetSemanticModel,
  downloadProjectAssetSemanticModel,
  getProjectAssetSemanticStatus,
  rebuildProjectAssetSemanticIndex,
  updateProjectAssetSemanticProfile,
} from '../../services/api';
import type {
  AssetSemanticCapability,
  AssetSemanticModelStatus,
  AssetSemanticStatus,
} from '../../types/project';
import {
  ASSET_SEMANTIC_CAPABILITIES,
  ASSET_SEMANTIC_IDLE_POLL_MS,
  assetSemanticCasRevision,
  assetSemanticSettingsDraft,
  assetSemanticSettingsIndexMessage,
  assetSemanticSettingsPollMs,
  buildAssetSemanticProfileUpdate,
  createAssetSemanticIdempotencyKey,
  formatAssetSemanticBytes,
  type AssetSemanticSettingsDraft,
} from './assetSemanticSettingsState';

export interface AssetSemanticSettingsPanelProps {
  projectId: string;
  onStatusChange?: (status: AssetSemanticStatus) => void;
}

const INSTALL_STATE_LABEL: Record<AssetSemanticModelStatus['installState'], string> = {
  'not-installed': '未下载',
  downloading: '下载中',
  verifying: '校验中',
  installed: '已安装',
  failed: '安装失败',
  error: '安装失败',
  disabled: '已停用',
  deleting: '删除中',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '操作失败');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function modelProgress(model: AssetSemanticModelStatus): number | null {
  if (model.totalBytes == null || model.totalBytes <= 0) return null;
  return Math.max(0, Math.min(100, (model.downloadedBytes / model.totalBytes) * 100));
}

function modelForCapability(status: AssetSemanticStatus | null, capability: AssetSemanticCapability) {
  if (!status) return null;
  return status.project.capabilities[capability].model
    || status.models.find((model) => model.capability === capability)
    || null;
}

export default function AssetSemanticSettingsPanel({ projectId, onStatusChange }: AssetSemanticSettingsPanelProps) {
  const [status, setStatus] = useState<AssetSemanticStatus | null>(null);
  const [draft, setDraft] = useState<AssetSemanticSettingsDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const statusRef = useRef<AssetSemanticStatus | null>(null);
  const dirtyRef = useRef(false);
  const currentProjectRef = useRef(projectId);
  const loadedProjectRef = useRef<string | null>(null);
  const projectGenerationRef = useRef(0);
  const readAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const onStatusChangeRef = useRef(onStatusChange);
  currentProjectRef.current = projectId;
  onStatusChangeRef.current = onStatusChange;

  const acceptStatus = useCallback((next: AssetSemanticStatus, resetDraft = false) => {
    statusRef.current = next;
    setStatus(next);
    if (resetDraft || !dirtyRef.current) {
      dirtyRef.current = false;
      setDirty(false);
      setDraft(assetSemanticSettingsDraft(next));
    }
    onStatusChangeRef.current?.(next);
  }, []);

  useEffect(() => {
    const generation = ++projectGenerationRef.current;
    const projectChanged = loadedProjectRef.current !== projectId;
    loadedProjectRef.current = projectId;
    if (projectChanged) {
      statusRef.current = null;
      dirtyRef.current = false;
      setStatus(null);
      setDraft(null);
      setDirty(false);
      setMessage('');
      setError('');
      setLoading(true);
    }
    let disposed = false;
    let timer: number | undefined;

    const clearTimer = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (delay: number) => {
      clearTimer();
      if (disposed || generation !== projectGenerationRef.current || document.visibilityState === 'hidden') return;
      timer = window.setTimeout(() => void readStatus(), delay);
    };
    const readStatus = async () => {
      if (disposed || generation !== projectGenerationRef.current || document.visibilityState === 'hidden') return;
      readAbortRef.current?.abort();
      const controller = new AbortController();
      readAbortRef.current = controller;
      if (!statusRef.current) setLoading(true);
      try {
        const next = await getProjectAssetSemanticStatus(projectId, { signal: controller.signal });
        if (disposed || controller.signal.aborted || generation !== projectGenerationRef.current
          || currentProjectRef.current !== projectId) return;
        setError('');
        acceptStatus(next);
        schedule(assetSemanticSettingsPollMs(next));
      } catch (caught) {
        if (disposed || controller.signal.aborted || isAbortError(caught)
          || generation !== projectGenerationRef.current || currentProjectRef.current !== projectId) return;
        setError(`状态读取失败：${errorMessage(caught)}`);
        schedule(ASSET_SEMANTIC_IDLE_POLL_MS);
      } finally {
        if (!disposed && generation === projectGenerationRef.current && currentProjectRef.current === projectId) {
          setLoading(false);
        }
      }
    };
    const handleVisibility = () => {
      clearTimer();
      if (document.visibilityState === 'hidden') {
        readAbortRef.current?.abort();
        return;
      }
      void readStatus();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    if (document.visibilityState !== 'hidden') void readStatus();
    return () => {
      disposed = true;
      clearTimer();
      readAbortRef.current?.abort();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [acceptStatus, projectId, refreshToken]);

  useEffect(() => () => mutationAbortRef.current?.abort(), [projectId]);

  const invalidateConflict = useCallback(() => {
    statusRef.current = null;
    dirtyRef.current = false;
    setStatus(null);
    setDraft(null);
    setDirty(false);
    setError('');
    setMessage('状态已被其他操作更新；本地旧 revision 已清空，正在重新读取。');
    setRefreshToken((value) => value + 1);
  }, []);

  const runMutation = useCallback(async <T,>(
    action: string,
    requestMutation: (signal: AbortSignal) => Promise<T>,
    applyResult: (result: T) => void,
  ) => {
    mutationAbortRef.current?.abort();
    const controller = new AbortController();
    mutationAbortRef.current = controller;
    const generation = projectGenerationRef.current;
    const expectedProjectId = projectId;
    setBusyAction(action);
    setError('');
    try {
      const result = await requestMutation(controller.signal);
      if (controller.signal.aborted || generation !== projectGenerationRef.current
        || currentProjectRef.current !== expectedProjectId) return;
      applyResult(result);
    } catch (caught) {
      if (controller.signal.aborted || isAbortError(caught) || generation !== projectGenerationRef.current
        || currentProjectRef.current !== expectedProjectId) return;
      if (caught instanceof ApiRequestError && caught.status === 409) {
        invalidateConflict();
        return;
      }
      setError(errorMessage(caught));
    } finally {
      if (mutationAbortRef.current === controller) mutationAbortRef.current = null;
      if (generation === projectGenerationRef.current && currentProjectRef.current === expectedProjectId) {
        setBusyAction(null);
      }
    }
  }, [invalidateConflict, projectId]);

  const toggleCapability = (capability: AssetSemanticCapability, enabled: boolean) => {
    dirtyRef.current = true;
    setDirty(true);
    setMessage('');
    setDraft((current) => current ? { ...current, [capability]: enabled } : current);
  };

  const saveConfiguration = () => {
    if (!status || !draft) return;
    let input;
    try {
      input = buildAssetSemanticProfileUpdate(projectId, status, draft);
    } catch (caught) {
      setError(errorMessage(caught));
      return;
    }
    void runMutation('profile-save',
      (signal) => updateProjectAssetSemanticProfile(input, { signal }),
      (next) => {
        acceptStatus(next, true);
        setMessage('配置已保存。模型不会自动下载；配置变化后请显式重建索引。');
      });
  };

  const downloadModel = (model: AssetSemanticModelStatus) => {
    const size = model.totalBytes == null ? '大小尚未返回' : formatAssetSemanticBytes(model.totalBytes);
    const confirmed = window.confirm(
      `即将下载本机大模型“${model.label}”\n固定身份：${model.key}\n固定版本：${model.version}\n预计大小：${size}\n\n应用绝不会自动下载模型。下载会占用网络与磁盘空间，确认继续？`,
    );
    if (!confirmed) return;
    void runMutation(`model-download:${model.key}`,
      (signal) => downloadProjectAssetSemanticModel(model.key, {
        expectedRevision: model.revision,
        idempotencyKey: createAssetSemanticIdempotencyKey('model-download', projectId, model.key),
      }, { signal }),
      (next) => {
        setMessage(`已显式启动“${next.label}”下载；下载完成后仍需保存配置并重建索引。`);
        setRefreshToken((value) => value + 1);
      });
  };

  const deleteModel = (model: AssetSemanticModelStatus) => {
    if (!window.confirm(`删除本机模型“${model.label}”（${model.key} / ${model.version}）？项目配置会保留，但依赖该模型的能力将不可用。`)) return;
    void runMutation(`model-delete:${model.key}`,
      (signal) => deleteProjectAssetSemanticModel(model.key, { expectedRevision: model.revision }, { signal }),
      (next) => {
        setMessage(`本机模型“${next.label}”已删除；项目配置未被伪装为可用。`);
        setRefreshToken((value) => value + 1);
      });
  };

  const rebuildIndex = () => {
    if (!status) return;
    const expectedRevision = assetSemanticCasRevision(status.project.revision);
    if (expectedRevision == null) {
      setError('配置 revision 无效，请重新读取状态。');
      return;
    }
    void runMutation('index-rebuild',
      (signal) => rebuildProjectAssetSemanticIndex({
        projectId,
        expectedRevision,
        idempotencyKey: createAssetSemanticIdempotencyKey('rebuild', projectId),
      }, { signal }),
      (next) => {
        setMessage(`已显式启动索引代次 ${next.generation}；首次构建完成前自然语言检索不可用。`);
        setRefreshToken((value) => value + 1);
      });
  };

  const savedEnabledCapabilities = useMemo(() => status
    ? ASSET_SEMANTIC_CAPABILITIES.filter(({ id }) => status.project.capabilities[id].enabled)
    : [], [status]);
  const savedModelsReady = savedEnabledCapabilities.length > 0 && savedEnabledCapabilities.every(({ id }) => (
    modelForCapability(status, id)?.installed === true
  ));
  const indexBusy = Boolean(status?.project.buildingGeneration != null
    || status?.project.indexState === 'queued'
    || status?.project.indexState === 'building');
  const canRebuild = Boolean(status && !dirty && savedModelsReady && !indexBusy && !busyAction);
  const summaryMessage = assetSemanticSettingsIndexMessage(status);

  return <details className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-primary)]">
    <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-semibold">
      <span className="flex items-center justify-between gap-3">
        <span>智能分析与自然语言检索（可选 · 本机）</span>
        <span className="text-[10px] font-normal text-[var(--text-secondary)]">
          {loading && !status ? '读取中…' : status?.project.indexState || '未读取'}
        </span>
      </span>
      <span className="mt-1 block text-[10px] font-normal leading-4 text-[var(--text-secondary)]">{summaryMessage}</span>
    </summary>

    <div className="space-y-3 border-t border-[var(--border-primary)] p-3">
      <div className="rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2 text-[10px] leading-4 text-[var(--text-secondary)]">
        三项能力均为显式配置。本面板只读取状态，不会自动下载模型，也不会把“模型已安装”误报成“索引可用”。
      </div>

      {ASSET_SEMANTIC_CAPABILITIES.map(({ id, label, description }) => {
        const capability = status?.project.capabilities[id];
        const model = modelForCapability(status, id);
        const progress = model ? modelProgress(model) : null;
        const actionBusy = Boolean(busyAction?.endsWith(`:${model?.key || ''}`));
        const transitionBusy = model?.installState === 'downloading'
          || model?.installState === 'verifying'
          || model?.installState === 'deleting';
        return <section key={id} className="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2.5">
          <div className="flex items-start justify-between gap-3">
            <label className="flex min-w-0 cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--accent-primary)]"
                checked={Boolean(draft?.[id])}
                disabled={!draft || Boolean(busyAction)}
                onChange={(event) => toggleCapability(id, event.target.checked)}
                aria-label={`启用 ${label}`}
              />
              <span>
                <span className="block text-xs font-semibold">{label}</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-[var(--text-secondary)]">{description}</span>
              </span>
            </label>
            <span className="shrink-0 rounded bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[9px] text-[var(--text-secondary)]">
              配置：{capability?.enabled ? '已启用' : '未启用'}
            </span>
          </div>

          <div className="mt-2 grid gap-1 text-[10px] text-[var(--text-secondary)] sm:grid-cols-2">
            <span>固定模型：<strong className="text-[var(--text-primary)]">{model?.label || '尚未读取'}</strong></span>
            <span>安装状态：<strong className="text-[var(--text-primary)]">{model ? INSTALL_STATE_LABEL[model.installState] : '未知'}</strong></span>
            <span className="break-all">身份：<code>{model?.key || capability?.modelKey || '—'}</code></span>
            <span className="break-all">版本：<code>{model?.version || capability?.modelVersion || '—'}</code></span>
          </div>

          {model && <div className="mt-2">
            <div className="mb-1 flex justify-between gap-2 text-[9px] text-[var(--text-secondary)]">
              <span>{formatAssetSemanticBytes(model.downloadedBytes)} / {formatAssetSemanticBytes(model.totalBytes)}</span>
              <span>{progress == null ? '总大小待服务端返回' : `${progress.toFixed(1)}%`}</span>
            </div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-secondary)]"
              role="progressbar"
              aria-label={`${label} 模型下载进度`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress == null ? undefined : Math.round(progress)}
            >
              <div className="h-full bg-[var(--accent-primary)] transition-[width]" style={{ width: `${progress || 0}%` }} />
            </div>
          </div>}

          {model?.error && <p className="mt-2 break-words rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-400">模型错误：{model.error}</p>}

          {capability && <p className="mt-2 text-[9px] text-[var(--text-secondary)]">
            当前代次任务：可处理 {capability.eligible} · 排队 {capability.queued} · 运行 {capability.running} · 成功 {capability.succeeded} · 跳过 {capability.skipped} · 失败 {capability.failed}
          </p>}

          <div className="mt-2 flex flex-wrap gap-2">
            {model && !model.installed && !transitionBusy && <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-[var(--border-primary)] px-2 py-1 text-[10px] hover:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(busyAction)}
              onClick={() => downloadModel(model)}
            >
              {actionBusy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {model.installState === 'error' || model.installState === 'failed' ? '确认后重新下载' : '确认后下载模型'}
            </button>}
            {model?.installed && <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-red-500/40 px-2 py-1 text-[10px] text-red-400 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(busyAction)}
              onClick={() => deleteModel(model)}
            >
              {actionBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              删除本机模型
            </button>}
            {transitionBusy && <span className="inline-flex items-center gap-1 text-[10px] text-amber-500"><Loader2 size={12} className="animate-spin" />后台状态轮询中</span>}
          </div>
        </section>;
      })}

      {status && <section className="rounded-md border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2.5 text-[10px] text-[var(--text-secondary)]">
        <div className="font-semibold text-[var(--text-primary)]">索引状态</div>
        <p className="mt-1 leading-4">{summaryMessage}</p>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          <span>配置 revision：{String(status.project.revision)}</span>
          <span>活动代次：{status.project.activeGeneration || '无'}</span>
          <span>活动目录 revision：{String(status.project.activeCatalogRevision || '无')}</span>
          <span>当前目录 revision：{String(status.project.currentCatalogRevision || '无')}</span>
          <span>构建代次：{status.project.buildingGeneration ?? '无'}</span>
          <span>索引陈旧：{status.project.indexStale ? '是' : '否'}</span>
        </div>
        {status.rebuild && <p className="mt-2">
          重建任务：排队 {status.rebuild.counts.queued} · 运行 {status.rebuild.counts.running} · 重试 {status.rebuild.counts.retrying} · 成功 {status.rebuild.counts.succeeded} · 跳过 {status.rebuild.counts.skipped} · 失败 {status.rebuild.counts.failed}
          <br />登记素材：可校验 {status.rebuild.eligibleAssetCount ?? 0} · 未校验未进入语义索引 {status.rebuild.excludedAssetCount ?? 0} · 任务封存 {status.rebuild.jobsSealed ? '完成' : '未完成'}
          {status.rebuild.payloadPrunedAt && <><br />历史任务明细已安全回收；登记数量与失败原因仍保留。</>}
        </p>}
      </section>}

      {dirty && <p className="text-[10px] text-amber-500">能力开关有未保存更改。保存前不会影响后端配置；保存后也不会自动下载模型或自动重建索引。</p>}
      {message && <p className="text-[10px] text-emerald-500" aria-live="polite">{message}</p>}
      {error && <p className="break-words text-[10px] text-red-400" role="alert">{error}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-primary)] pt-3">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded bg-[var(--accent-primary)] px-2.5 py-1.5 text-[10px] text-white disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!dirty || !status || !draft || Boolean(busyAction)}
          onClick={saveConfiguration}
        >
          {busyAction === 'profile-save' ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          保存配置（CAS）
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-[var(--border-primary)] px-2.5 py-1.5 text-[10px] hover:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canRebuild}
          onClick={rebuildIndex}
          title={dirty ? '请先保存配置' : !savedModelsReady ? '已启用能力的模型尚未全部安装' : indexBusy ? '已有索引正在构建' : ''}
        >
          {busyAction === 'index-rebuild' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          显式重建索引
        </button>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded border border-[var(--border-primary)] px-2 py-1.5 text-[10px] text-[var(--text-secondary)] disabled:opacity-50"
          disabled={loading || Boolean(busyAction)}
          onClick={() => {
            setError('');
            setRefreshToken((value) => value + 1);
          }}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />立即刷新
        </button>
      </div>
    </div>
  </details>;
}
