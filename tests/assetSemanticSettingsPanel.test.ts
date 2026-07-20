import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AssetSemanticModelStatus, AssetSemanticStatus } from '../src/types/project.ts';
import {
  ASSET_SEMANTIC_ACTIVE_POLL_MS,
  ASSET_SEMANTIC_IDLE_POLL_MS,
  assetSemanticCasRevision,
  assetSemanticSettingsDraft,
  assetSemanticSettingsIndexMessage,
  assetSemanticSettingsPollMs,
  buildAssetSemanticProfileUpdate,
  createAssetSemanticIdempotencyKey,
  formatAssetSemanticBytes,
} from '../src/components/assets/assetSemanticSettingsState.ts';

const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function model(capability: 'caption' | 'ocr' | 'embedding', overrides: Partial<AssetSemanticModelStatus> = {}): AssetSemanticModelStatus {
  return {
    key: `${capability}-fixed-model`,
    capability,
    label: `${capability} fixed model`,
    version: 'fixed-v1',
    revision: 2,
    installState: 'installed',
    installed: true,
    downloadedBytes: 1024,
    totalBytes: 1024,
    error: null,
    ...overrides,
  };
}

function semanticStatus(overrides: Partial<AssetSemanticStatus['project']> = {}): AssetSemanticStatus {
  const models = [model('caption'), model('ocr'), model('embedding')];
  const capability = (name: 'caption' | 'ocr' | 'embedding') => ({
    capability: name,
    enabled: true,
    modelKey: `${name}-fixed-model`,
    modelVersion: 'fixed-v1',
    model: models.find((entry) => entry.capability === name) || null,
    eligible: 4,
    queued: 0,
    running: 0,
    succeeded: 4,
    skipped: 0,
    failed: 0,
  });
  return {
    project: {
      projectId: 'project-a',
      revision: 9,
      enabled: true,
      activeGeneration: 3,
      activeIndexRevision: 'index-3',
      activeCatalogRevision: 12,
      currentCatalogRevision: 12,
      buildingGeneration: null,
      indexState: 'ready',
      indexStale: false,
      capabilities: {
        caption: capability('caption'),
        ocr: capability('ocr'),
        embedding: capability('embedding'),
      },
      ...overrides,
    },
    models,
    rebuild: null,
  };
}

test('settings polling is fast only for model/index transitions and otherwise bounded at five seconds', () => {
  assert.equal(assetSemanticSettingsPollMs(null), ASSET_SEMANTIC_ACTIVE_POLL_MS);
  assert.equal(assetSemanticSettingsPollMs(semanticStatus()), ASSET_SEMANTIC_IDLE_POLL_MS);

  const downloading = semanticStatus();
  downloading.models[2] = model('embedding', { installState: 'downloading', installed: false, downloadedBytes: 400 });
  assert.equal(assetSemanticSettingsPollMs(downloading), ASSET_SEMANTIC_ACTIVE_POLL_MS);

  const verifying = semanticStatus();
  verifying.models[0] = model('caption', { installState: 'verifying', installed: false });
  assert.equal(assetSemanticSettingsPollMs(verifying), ASSET_SEMANTIC_ACTIVE_POLL_MS);

  assert.equal(assetSemanticSettingsPollMs(semanticStatus({ buildingGeneration: 4, indexState: 'building' })), ASSET_SEMANTIC_ACTIVE_POLL_MS);
});

test('profile draft and save payload preserve fixed model identities and current CAS revision', () => {
  const status = semanticStatus();
  const draft = { ...assetSemanticSettingsDraft(status), caption: false, ocr: false, embedding: true };
  assert.deepEqual(buildAssetSemanticProfileUpdate('project-a', status, draft, 'local-owner'), {
    projectId: 'project-a',
    expectedRevision: 9,
    enabled: true,
    caption: { enabled: false, modelKey: 'caption-fixed-model', modelVersion: 'fixed-v1' },
    ocr: { enabled: false, modelKey: 'ocr-fixed-model', modelVersion: 'fixed-v1' },
    embedding: { enabled: true, modelKey: 'embedding-fixed-model', modelVersion: 'fixed-v1' },
    updatedBy: 'local-owner',
  });
  assert.equal(assetSemanticCasRevision('12'), 12);
  assert.equal(assetSemanticCasRevision('stale'), null);
  assert.throws(() => buildAssetSemanticProfileUpdate('project-a', semanticStatus({ revision: 'invalid' }), draft), /revision/);
});

test('status copy distinguishes configuration, model lifecycle and index lifecycle without inventing confidence', () => {
  const disabled = semanticStatus({ enabled: false });
  assert.match(assetSemanticSettingsIndexMessage(disabled), /配置未启用/);

  const missing = semanticStatus();
  missing.models[2] = model('embedding', { installState: 'not-installed', installed: false });
  missing.project.capabilities.embedding.model = missing.models[2];
  assert.match(assetSemanticSettingsIndexMessage(missing), /模型尚未下载/);

  const downloading = semanticStatus();
  downloading.models[2] = model('embedding', { installState: 'downloading', installed: false });
  downloading.project.capabilities.embedding.model = downloading.models[2];
  assert.match(assetSemanticSettingsIndexMessage(downloading), /模型正在下载或校验/);

  assert.match(assetSemanticSettingsIndexMessage(semanticStatus({ activeGeneration: 0, activeIndexRevision: '', buildingGeneration: 1, indexState: 'building' })), /首次索引正在构建/);
  assert.match(assetSemanticSettingsIndexMessage(semanticStatus({ buildingGeneration: 4, indexState: 'building' })), /上一个成功代次/);
  assert.match(assetSemanticSettingsIndexMessage(semanticStatus({ currentCatalogRevision: 13, indexState: 'stale', indexStale: true })), /目录已变化/);
  assert.match(assetSemanticSettingsIndexMessage(semanticStatus()), /均已就绪/);

  const allCopy = [disabled, missing, downloading, semanticStatus()].map(assetSemanticSettingsIndexMessage).join('\n');
  assert.doesNotMatch(allCopy, /置信度|confidence/i);
});

test('download/rebuild idempotency keys are explicit, stable when seeded, and wire bounded', () => {
  const first = createAssetSemanticIdempotencyKey('model-download', '项目 A/with spaces', 'embedding/model', 'nonce-1');
  const second = createAssetSemanticIdempotencyKey('model-download', '项目 A/with spaces', 'embedding/model', 'nonce-1');
  assert.equal(first, second);
  assert.match(first, /^asset-semantic:model-download:/);
  assert.equal(first.length <= 160, true);
  assert.doesNotMatch(first, /\s/);
  assert.notEqual(createAssetSemanticIdempotencyKey('rebuild', 'project-a', 'project', 'nonce-a'), createAssetSemanticIdempotencyKey('rebuild', 'project-a', 'project', 'nonce-b'));
  assert.equal(formatAssetSemanticBytes(null), '大小未知');
  assert.equal(formatAssetSemanticBytes(1024), '1.0 KiB');
  assert.equal(formatAssetSemanticBytes(1024 ** 3), '1.00 GiB');
});

test('settings panel is collapsed, abortable, generation guarded, explicit about downloads, and conflict safe', () => {
  const source = read('src/components/assets/AssetSemanticSettingsPanel.tsx');
  const beforeDownloadHandler = source.slice(0, source.indexOf('const downloadModel ='));
  const automaticReadEffect = source.slice(
    source.indexOf('useEffect(() => {'),
    source.indexOf('useEffect(() => () => mutationAbortRef.current?.abort()'),
  );
  const modelRefreshHandler = source.slice(
    source.indexOf('const refreshLocalModelStatus ='),
    source.indexOf('const downloadModel ='),
  );
  assert.match(source, /export interface AssetSemanticSettingsPanelProps \{\s*projectId: string;\s*externalRefreshToken\?: number;\s*onStatusChange\?: \(status: AssetSemanticStatus, externalRefreshToken: number\) => void;/);
  assert.match(source, /<details className=/);
  assert.doesNotMatch(source, /<details[^>]+\sopen(?:=|\s|>)/);
  assert.match(source, /data-asset-semantic-settings-scroll-region/);
  assert.match(source, /max-h-\[min\(42vh,34rem\)\]/);
  assert.match(source, /\[@media\(max-height:820px\)\]:max-h-44/);
  assert.match(source, /overflow-y-auto overscroll-contain/);
  assert.match(source, /const projectGenerationRef = useRef\(0\)/);
  assert.match(source, /const currentProjectRef = useRef\(projectId\)/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /controller\.signal\.aborted \|\| generation !== projectGenerationRef\.current/);
  assert.match(source, /document\.addEventListener\('visibilitychange'/);
  assert.match(source, /assetSemanticSettingsPollMs\(next\)/);
  assert.match(source, /getProjectAssetSemanticStatus\(projectId, \{ signal: controller\.signal \}\)/);
  assert.match(automaticReadEffect, /const sourceRefreshToken = externalRefreshToken;[\s\S]*acceptStatus\(next, false, sourceRefreshToken\)/);
  assert.match(source, /onStatusChangeRef\.current\?\.\(next, sourceRefreshToken\)/);
  assert.match(source, /const sourceRefreshToken = externalRefreshTokenRef\.current;[\s\S]*applyResult\(result, sourceRefreshToken\)/);
  assert.match(source, /acceptStatus\(next, true, sourceRefreshToken\)/);
  assert.match(source, /\[acceptStatus, externalRefreshToken, projectId, refreshToken\]/);
  assert.match(source, /if \(mutationAbortRef\.current\) \{\s*schedule\(ASSET_SEMANTIC_IDLE_POLL_MS\);\s*return;/);
  assert.match(source, /readAbortRef\.current\?\.abort\(\);\s*mutationAbortRef\.current\?\.abort\(\);/);
  assert.doesNotMatch(automaticReadEffect, /refreshProjectAssetSemanticModels\(/, 'poll and visibility refresh must stay pure GET');
  assert.match(modelRefreshHandler, /runMutation\('model-status-refresh',[\s\S]*refreshProjectAssetSemanticModels\(projectId, \{ signal \}\)/);
  assert.doesNotMatch(modelRefreshHandler, /window\.confirm\(/, 'local model reconciliation is explicit but does not need a confirm dialog');
  assert.match(source, /同步本机模型状态/);
  assert.match(source, /立即刷新（只读）/);
  assert.doesNotMatch(beforeDownloadHandler, /downloadProjectAssetSemanticModel\(/, 'polling must never auto-download');
  assert.match(source, /window\.confirm\([\s\S]*本机大模型[\s\S]*绝不会自动下载模型/);
  assert.match(source, /downloadProjectAssetSemanticModel\([\s\S]*expectedRevision: model\.revision[\s\S]*idempotencyKey:/);
  assert.match(source, /deleteProjectAssetSemanticModel\([\s\S]*expectedRevision: model\.revision/);
  assert.match(source, /rebuildProjectAssetSemanticIndex\([\s\S]*expectedRevision,[\s\S]*idempotencyKey:/);
  assert.match(source, /可校验 \{status\.rebuild\.eligibleAssetCount \?\? 0\}/);
  assert.match(source, /未校验未进入语义索引 \{status\.rebuild\.excludedAssetCount \?\? 0\}/);
  assert.match(source, /历史任务明细已安全回收/);
  assert.match(source, /任务封存 \{status\.rebuild\.jobsSealed \? '完成' : '未完成'\}/);
  assert.match(source, /updateProjectAssetSemanticProfile\(input, \{ signal \}\)/);
  assert.match(source, /caught instanceof ApiRequestError && caught\.status === 409/);
  assert.match(source, /statusRef\.current = null;[\s\S]*setStatus\(null\);[\s\S]*setDraft\(null\);[\s\S]*setRefreshToken/);
  assert.match(source, /ASSET_SEMANTIC_CAPABILITIES\.map/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /置信度|confidence/i);
  assert.doesNotMatch(source, /AssetCenter/);
});
