import type {
  AssetRevision,
  AssetSemanticCapability,
  AssetSemanticProfileUpdateInput,
  AssetSemanticStatus,
} from '../../types/project';

export const ASSET_SEMANTIC_ACTIVE_POLL_MS = 1_000;
export const ASSET_SEMANTIC_IDLE_POLL_MS = 5_000;

export const ASSET_SEMANTIC_CAPABILITIES: ReadonlyArray<{
  id: AssetSemanticCapability;
  label: string;
  description: string;
}> = [
  { id: 'caption', label: 'Caption', description: '为图像生成内容描述，供文字检索和证据展示使用。' },
  { id: 'ocr', label: 'OCR', description: '识别画面中的可见文字；不会修改原素材。' },
  { id: 'embedding', label: 'Embedding', description: '建立本机向量索引，用于自然语言检索。' },
];

export type AssetSemanticSettingsDraft = Record<AssetSemanticCapability, boolean>;

export function assetSemanticSettingsDraft(status: AssetSemanticStatus): AssetSemanticSettingsDraft {
  return {
    caption: Boolean(status.project.capabilities.caption.enabled),
    ocr: Boolean(status.project.capabilities.ocr.enabled),
    embedding: Boolean(status.project.capabilities.embedding.enabled),
  };
}

export function assetSemanticCasRevision(value: AssetRevision): number | null {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : null;
}

export function assetSemanticSettingsPollMs(status: AssetSemanticStatus | null | undefined): number {
  if (!status) return ASSET_SEMANTIC_ACTIVE_POLL_MS;
  const modelBusy = status.models.some((model) => (
    model.installState === 'downloading'
    || model.installState === 'verifying'
    || model.installState === 'deleting'
  ));
  const indexBusy = status.project.buildingGeneration != null
    || status.project.indexState === 'queued'
    || status.project.indexState === 'building'
    || status.rebuild?.status === 'building';
  return modelBusy || indexBusy ? ASSET_SEMANTIC_ACTIVE_POLL_MS : ASSET_SEMANTIC_IDLE_POLL_MS;
}

function modelForCapability(status: AssetSemanticStatus, capability: AssetSemanticCapability) {
  return status.project.capabilities[capability].model
    || status.models.find((model) => model.capability === capability)
    || null;
}

export function assetSemanticSettingsIndexMessage(status: AssetSemanticStatus | null | undefined): string {
  if (!status) return '正在读取本项目的配置、模型和索引状态。';
  if (!status.project.enabled) return '项目智能分析配置未启用；普通关键词筛选仍可使用。';
  const enabled = ASSET_SEMANTIC_CAPABILITIES.filter(({ id }) => status.project.capabilities[id].enabled);
  const models = enabled.map(({ id }) => modelForCapability(status, id));
  if (models.some((model) => !model || model.installState === 'not-installed')) {
    return '配置已启用，但所需本机模型尚未下载；应用不会自动下载模型。';
  }
  if (models.some((model) => model?.installState === 'downloading' || model?.installState === 'verifying')) {
    return '模型正在下载或校验；模型就绪不等于索引已经建立。';
  }
  if (models.some((model) => model?.installState === 'error' || model?.installState === 'failed' || !model?.installed)) {
    return '配置已启用，但至少一个本机模型不可用；请处理模型错误后再重建索引。';
  }
  const hasActiveIndex = status.project.activeGeneration > 0 && String(status.project.activeIndexRevision || '') !== '';
  if (status.project.buildingGeneration != null || status.project.indexState === 'queued' || status.project.indexState === 'building') {
    return hasActiveIndex
      ? '新索引正在构建；自然语言检索继续使用上一个成功代次。'
      : '首次索引正在构建；完成前自然语言检索不可用。';
  }
  if (status.project.indexState === 'error' || status.project.indexState === 'degraded') {
    return hasActiveIndex
      ? '最近一次索引重建失败；自然语言检索仍使用上一个成功代次。'
      : '索引构建失败，目前没有可用于自然语言检索的成功代次。';
  }
  if (status.project.indexStale || status.project.indexState === 'stale'
    || String(status.project.activeCatalogRevision) !== String(status.project.currentCatalogRevision)) {
    return '素材目录已变化；当前检索使用上一个索引，建议重建。';
  }
  if (!hasActiveIndex || status.project.indexState === 'empty') {
    return '配置和模型已就绪，但当前项目尚未建立可用索引。';
  }
  return '项目配置、所需模型和当前索引均已就绪。';
}

export function formatAssetSemanticBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '大小未知';
  const bytes = Math.max(0, Number(value));
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function buildAssetSemanticProfileUpdate(
  projectId: string,
  status: AssetSemanticStatus,
  draft: AssetSemanticSettingsDraft,
  updatedBy = 'local-owner',
): AssetSemanticProfileUpdateInput {
  const expectedRevision = assetSemanticCasRevision(status.project.revision);
  if (expectedRevision == null) throw new Error('配置 revision 无效，请重新读取状态。');
  const capabilityPatch = (capability: AssetSemanticCapability) => {
    const configured = status.project.capabilities[capability];
    if (!configured.modelKey || !configured.modelVersion) {
      throw new Error(`${capability} 的固定模型身份尚未读取，请稍后重试。`);
    }
    return {
      enabled: Boolean(draft[capability]),
      modelKey: configured.modelKey,
      modelVersion: configured.modelVersion,
    };
  };
  return {
    projectId,
    expectedRevision,
    enabled: ASSET_SEMANTIC_CAPABILITIES.some(({ id }) => draft[id]),
    caption: capabilityPatch('caption'),
    ocr: capabilityPatch('ocr'),
    embedding: capabilityPatch('embedding'),
    updatedBy,
  };
}

function idempotencySegment(value: string, maxLength: number): string {
  return String(value || 'none').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, maxLength) || 'none';
}

export function createAssetSemanticIdempotencyKey(
  action: 'model-download' | 'rebuild',
  projectId: string,
  target = 'project',
  nonce?: string,
): string {
  const randomPart = nonce || (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
  return [
    'asset-semantic',
    action,
    idempotencySegment(projectId, 40),
    idempotencySegment(target, 40),
    idempotencySegment(randomPart, 48),
  ].join(':').slice(0, 160);
}
