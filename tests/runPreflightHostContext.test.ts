import test from 'node:test';
import assert from 'node:assert/strict';
import type { ApiSettings } from '../src/types/canvas.ts';
import type { AssetRef, CollaborationExecutionPolicySnapshot, RunIntent } from '../src/types/project.ts';
import { createRunPreflightHostContextDigest } from '../src/utils/runPreflightHostContext.ts';

function settings(overrides: Partial<ApiSettings> = {}): ApiSettings {
  return {
    zhenzhenApiKey: 'sk-configured-first-secret-value',
    zhenzhenBaseUrl: 'https://provider-a.example/v1',
    zhenzhenSd2ApiKey: '',
    zhenzhenSd2BaseUrl: 'https://api.seedance.nz',
    rhApiKey: '', rhBaseUrl: 'https://www.runninghub.cn',
    rhIntlApiKey: '', rhIntlBaseUrl: 'https://www.runninghub.ai',
    llmApiKey: '', llmBaseUrl: 'https://provider-a.example/v1',
    gptImageApiKey: '', nanoBananaApiKey: '', mjApiKey: '', veoApiKey: '',
    soraApiKey: '', grokApiKey: '', seedanceApiKey: '', sunoApiKey: '',
    advancedProviders: [{
      id: 'provider-a', label: 'Provider A', protocol: 'openai-compatible', enabled: true,
      baseUrl: 'https://provider-a.example/v1', apiKey: 'sk-provider-first-secret-value',
      imageModels: ['image-b', 'image-a'], videoModels: [], chatModels: ['chat-a'],
    }],
    advancedProviderSummary: { enabledCount: 1, configuredKeyCount: 1, comfyuiConfigured: false, jimengConfigured: false },
    cloudUploadTargets: [],
    cloudUploadSummary: { totalCount: 0, enabledCount: 0, configuredCount: 0, supportedUploadCount: 0, defaultTargetId: '', defaultLabel: '' },
    taskCompletionSound: { mode: 'default', url: '' },
    preferences: { theme: 'dark', language: 'zh-CN' },
    ...overrides,
  } as ApiSettings;
}

function asset(contentHash: string): AssetRef {
  return {
    id: 'asset-a', entityUid: 'asset-uid-a', projectId: 'project-a', kind: 'image',
    filename: 'safe.png', contentHash, storageMode: 'managed', availability: 'available',
    createdAt: 10, updatedAt: 20,
  };
}

function policy(overrides: Partial<CollaborationExecutionPolicySnapshot['policy']> = {}): CollaborationExecutionPolicySnapshot {
  return {
    policy: {
      projectId: 'project-a', allowedModels: ['image-a'], dailyCostLimit: 10,
      perRunCostLimit: 2, concurrencyLimit: 3, updatedAt: 100, ...overrides,
    },
    usage: { activeCount: 1, dailyCost: 2, unknownCostCount: 0, dayStart: 1 },
  };
}

function intent(overrides: Partial<RunIntent> = {}): RunIntent {
  return {
    id: 'intent-a', projectId: 'project-a', canvasId: 'canvas-a', canvasRevision: 7,
    nodeIds: ['node-a'], idempotencyKey: 'idem-a', requestedBy: 'member-a',
    provider: 'image', model: 'image-a', estimatedCost: 1, estimatedCostKnown: true, status: 'pending',
    createdAt: 100, updatedAt: 100, ...overrides,
  };
}

function digest(input: {
  settings?: ApiSettings;
  asset?: AssetRef | 'missing';
  policy?: CollaborationExecutionPolicySnapshot | null;
  intent?: RunIntent | null;
} = {}) {
  return createRunPreflightHostContextDigest({
    settings: input.settings || settings(),
    assetIds: ['asset-a'],
    assetRecords: new Map([['asset-a', input.asset || asset('a'.repeat(64))]]),
    policy: input.policy === undefined ? policy() : input.policy,
    runIntent: input.intent === undefined ? intent() : input.intent,
  });
}

test('host context digest binds asset identity/content, policy/usage, and RunIntent state', () => {
  const baseline = digest();
  assert.match(baseline, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(digest({ asset: asset('b'.repeat(64)) }), baseline);
  assert.notEqual(digest({ policy: policy({ updatedAt: 101 }) }), baseline);
  assert.notEqual(digest({ intent: intent({ status: 'accepted', updatedAt: 101 }) }), baseline);
  assert.notEqual(digest({ asset: 'missing' }), baseline);
});

test('provider endpoint, enabled state, and model roster are bound without exposing secrets', () => {
  const baseline = digest();
  const rotatedSecrets = settings({
    zhenzhenApiKey: 'sk-configured-rotated-secret-value',
    advancedProviders: [{
      ...(settings().advancedProviders || [])[0],
      apiKey: 'sk-provider-rotated-secret-value',
    }],
  });
  assert.equal(digest({ settings: rotatedSecrets }), baseline,
    'credential rotation with the same configured-state is intentionally not fingerprinted');

  const endpointChanged = settings({
    advancedProviders: [{ ...(settings().advancedProviders || [])[0], baseUrl: 'https://provider-b.example/v1' }],
  });
  const modelChanged = settings({
    advancedProviders: [{ ...(settings().advancedProviders || [])[0], imageModels: ['image-c'] }],
  });
  assert.notEqual(digest({ settings: endpointChanged }), baseline);
  assert.notEqual(digest({ settings: modelChanged }), baseline);
  assert.doesNotMatch(baseline, /configured|provider-a|secret/i);
});

test('host context digest is deterministic across map/model ordering', () => {
  const reversed = settings({
    advancedProviders: [{
      ...(settings().advancedProviders || [])[0],
      imageModels: ['image-a', 'image-b'],
    }],
  });
  const records = new Map<string, AssetRef | 'missing'>([['asset-a', asset('a'.repeat(64))]]);
  const first = createRunPreflightHostContextDigest({
    settings: settings(), assetIds: ['asset-a', 'asset-a'], assetRecords: records, policy: policy(), runIntent: intent(),
  });
  const second = createRunPreflightHostContextDigest({
    settings: reversed, assetIds: ['asset-a'], assetRecords: records, policy: policy(), runIntent: intent(),
  });
  assert.equal(first, second);
});
