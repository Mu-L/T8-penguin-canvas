import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SEEDANCE_NZ_LLM_MODEL,
  SEEDANCE_NZ_LLM_MODELS,
  resolveSeedanceNzLlmModel,
} from '../src/config/llm.ts';
import { generateLlm, generateLlmStream } from '../src/services/generation.ts';
import { buildRunPreflightDiagnostics } from '../src/utils/runPreflightContext.ts';
import type { ApiSettings } from '../src/types/canvas.ts';
import type { Node } from '@xyflow/react';

const require = createRequire(import.meta.url);
const proxyRouter = require('../backend/src/routes/proxy.js');
const runIntentAuthority = require('../backend/src/collaboration/runIntentAuthority.js');

const EXPECTED_MODELS = [
  'bytedance/doubao-seed-2.0-code',
  'bytedance/doubao-seed-2.0-lite',
  'bytedance/doubao-seed-2.0-mini',
  'bytedance/doubao-seed-2.0-pro',
  'bytedance/doubao-seed-2.1-pro',
  'bytedance/doubao-seed-2.1-turbo',
  'bytedance/doubao-seed-evolving',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
  'glm-5',
  'glm-5-turbo',
  'glm-5.1',
  'glm-5.2',
  'glm-5v-turbo',
  'minimax/minimax-m2.7',
  'zhenzhen/gk-4.6',
  'qwen/qwen3.6-flash',
  'qwen/qwen3.6-max-preview',
  'qwen/qwen3.6-plus',
  'qwen/qwen3.7-max',
  'qwen/qwen3.7-plus',
  'qwen/qwen3.8-max',
];

const EMPTY_SETTINGS: ApiSettings = {
  zhenzhenApiKey: '',
  zhenzhenBaseUrl: 'https://ai.t8star.org',
  zhenzhenSd2ApiKey: '',
  zhenzhenSd2BaseUrl: 'https://api.seedance.nz',
  rhApiKey: '',
  rhBaseUrl: 'https://www.runninghub.cn',
  rhIntlApiKey: '',
  rhIntlBaseUrl: 'https://www.runninghub.ai',
  llmApiKey: '',
  llmBaseUrl: 'https://ai.t8star.org',
  advancedProviders: [],
};

test('Seedance NZ LLM catalog is the exact verified 22-model allowlist', () => {
  assert.deepEqual([...SEEDANCE_NZ_LLM_MODELS], EXPECTED_MODELS);
  assert.equal(DEFAULT_SEEDANCE_NZ_LLM_MODEL, 'bytedance/doubao-seed-2.0-mini');
  assert.equal(resolveSeedanceNzLlmModel('glm-5.2'), 'glm-5.2');
  assert.equal(resolveSeedanceNzLlmModel('zhenzhen/gk-4.6'), 'zhenzhen/gk-4.6');
  assert.equal(resolveSeedanceNzLlmModel('qwen/qwen3.8-max'), 'qwen/qwen3.8-max');
  assert.equal(resolveSeedanceNzLlmModel('not-in-catalog'), DEFAULT_SEEDANCE_NZ_LLM_MODEL);
});

test('built-in LLM provider resolves the domestic key and rejects models outside the verified list', () => {
  const resolve = proxyRouter._test.resolveBuiltInLlmProvider;
  const settings = {
    llmApiKey: 'overseas-key',
    zhenzhenSd2ApiKey: 'domestic-key',
  };

  const domestic = resolve(settings, 'seedance-nz', 'glm-5.2');
  assert.equal(domestic.source, 'seedance-nz');
  assert.equal(domestic.apiKey, 'domestic-key');
  assert.equal(domestic.baseUrl, 'https://api.seedance.nz');
  assert.equal(domestic.modelAllowed, true);
  assert.equal(resolve(settings, 'seedance-nz', 'zhenzhen/gk-4.6').modelAllowed, true);
  assert.equal(resolve(settings, 'seedance-nz', 'qwen/qwen3.8-max').modelAllowed, true);
  assert.equal(resolve(settings, 'seedance-nz', 'unknown-model').modelAllowed, false);

  const defaultProvider = resolve(settings, 'zhenzhen', 'custom-model');
  assert.equal(defaultProvider.source, 'zhenzhen');
  assert.equal(defaultProvider.apiKey, 'overseas-key');
  assert.equal(defaultProvider.baseUrl, 'https://ai.t8star.org');
  assert.equal(defaultProvider.modelAllowed, true);
});

test('run authority records the selected domestic LLM provider and exact model', () => {
  assert.deepEqual(
    runIntentAuthority.providerDeclarationForNode({
      id: 'llm-domestic',
      type: 'llm',
      data: {
        llmApiSource: 'seedance-nz',
        providerSource: 'zhenzhen',
        providerModel: 'qwen/qwen3.8-max',
      },
    }),
    { provider: 'seedance-nz', model: 'qwen/qwen3.8-max' },
  );
  assert.throws(
    () => runIntentAuthority.providerDeclarationForNode({
      id: 'llm-invalid',
      type: 'llm',
      data: {
        llmApiSource: 'seedance-nz',
        providerSource: 'zhenzhen',
        providerModel: 'not-in-catalog',
      },
    }),
    /不在已验证模型列表/,
  );
});

test('LLM service preserves the selected built-in platform for JSON and SSE requests', async () => {
  const originalFetch = globalThis.fetch;
  const submittedSources: string[] = [];
  const encoder = new TextEncoder();
  try {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      submittedSources.push(body.source);
      if (body.stream) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"stream ok"},"finish_reason":"stop"}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) as any;
      }
      return new Response(JSON.stringify({
        success: true,
        data: { content: 'json ok', model: body.model },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const request = {
      source: 'seedance-nz' as const,
      model: 'glm-5.2',
      messages: [{ role: 'user' as const, content: 'hello' }],
    };
    assert.equal((await generateLlm(request)).content, 'json ok');
    assert.equal((await generateLlmStream(request)).content, 'stream ok');
    assert.deepEqual(submittedSources, ['seedance-nz', 'seedance-nz']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LLM node exposes the two built-in platforms and only the verified domestic model catalog', () => {
  const nodeSource = readFileSync(new URL('../src/components/nodes/LLMNode.tsx', import.meta.url), 'utf8');
  const proxySource = readFileSync(new URL('../backend/src/routes/proxy.js', import.meta.url), 'utf8');

  assert.match(nodeSource, /贞贞的AI工坊-独立LLM Key\(默认\)/);
  assert.match(nodeSource, /<option value="seedance-nz"[\s\S]*贞贞的平价AI小屋/);
  assert.match(nodeSource, /SEEDANCE_NZ_LLM_MODELS\.map/);
  assert.match(nodeSource, /source:\s*isSeedanceNzSelected \? 'seedance-nz' : 'zhenzhen'/);
  assert.match(proxySource, /ZHENZHEN_SD2_BASE_URL/);
  assert.match(proxySource, /\/v1\/chat\/completions/);
  assert.match(proxySource, /SEEDANCE_NZ_LLM_MODEL_SET\.has/);
});

test('LLM preflight checks the key belonging to the selected built-in platform', () => {
  const node: Node = {
    id: 'llm-domestic',
    type: 'llm',
    position: { x: 0, y: 0 },
    data: {
      llmApiSource: 'seedance-nz',
      providerSource: 'zhenzhen',
      providerModel: 'glm-5.2',
      userPrompt: 'hello',
    },
  };
  const input = {
    nodes: [node],
    edges: [],
    executionNodeIds: [node.id],
    scopeMode: 'exact-plan' as const,
    projectId: 'project-a',
    providersComplete: true,
    assets: [],
    policy: null,
  };

  const missing = buildRunPreflightDiagnostics({ ...input, settings: EMPTY_SETTINGS });
  assert.equal(
    missing.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'),
    true,
  );

  const configured = buildRunPreflightDiagnostics({
    ...input,
    settings: { ...EMPTY_SETTINGS, zhenzhenSd2ApiKey: 'configured' },
  });
  assert.equal(
    configured.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'),
    false,
  );
});

test('MiniMax H3 preflight defaults to the domestic key and follows an explicit built-in channel switch', () => {
  const baseNode: Node = {
    id: 'h3-enhancer',
    type: 'minimax-h3-prompt-enhancer',
    position: { x: 0, y: 0 },
    data: {
      providerSource: 'zhenzhen',
      providerModel: 'bytedance/doubao-seed-2.1-pro',
      userPrompt: '雨中的追逐镜头',
    },
  };
  const input = {
    nodes: [baseNode],
    edges: [],
    executionNodeIds: [baseNode.id],
    scopeMode: 'exact-plan' as const,
    projectId: 'project-h3',
    providersComplete: true,
    assets: [],
    policy: null,
  };

  const defaultMissing = buildRunPreflightDiagnostics({ ...input, settings: EMPTY_SETTINGS });
  assert.equal(
    defaultMissing.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'),
    true,
  );
  const defaultConfigured = buildRunPreflightDiagnostics({
    ...input,
    settings: { ...EMPTY_SETTINGS, zhenzhenSd2ApiKey: 'configured' },
  });
  assert.equal(
    defaultConfigured.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'),
    false,
  );

  const workshopInput = {
    ...input,
    nodes: [{ ...baseNode, data: { ...baseNode.data, llmApiSource: 'zhenzhen', model: 'gemini-3.5-flash' } }],
  };
  const workshopMissing = buildRunPreflightDiagnostics({ ...workshopInput, settings: EMPTY_SETTINGS });
  assert.equal(
    workshopMissing.capability.some((item) => item.ruleId === 'provider.llm-credential-missing'),
    true,
  );
  const workshopConfigured = buildRunPreflightDiagnostics({
    ...workshopInput,
    settings: { ...EMPTY_SETTINGS, llmApiKey: 'configured' },
  });
  assert.equal(
    workshopConfigured.capability.some((item) => item.ruleId === 'provider.llm-credential-missing'),
    false,
  );
});

test('Story analysis preflight checks the domestic LLM key without affecting later production stages', () => {
  const story: Node = {
    id: 'story-domestic',
    type: 'story',
    position: { x: 0, y: 0 },
    data: {
      storyRunMode: 'analyze',
      providerSource: 'seedance-nz',
      providerModel: 'bytedance/doubao-seed-2.0-mini',
      llmApiSource: 'seedance-nz',
      storyProject: { shots: [] },
    },
  };
  const input = {
    nodes: [story],
    edges: [],
    executionNodeIds: [story.id],
    scopeMode: 'exact-plan' as const,
    projectId: 'project-story',
    providersComplete: true,
    assets: [],
    policy: null,
  };

  const missing = buildRunPreflightDiagnostics({ ...input, settings: EMPTY_SETTINGS });
  assert.equal(
    missing.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'),
    true,
  );

  const configured = buildRunPreflightDiagnostics({
    ...input,
    settings: { ...EMPTY_SETTINGS, zhenzhenSd2ApiKey: 'configured' },
  });
  assert.equal(
    configured.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'),
    false,
  );

  const assetRun = buildRunPreflightDiagnostics({
    ...input,
    nodes: [{
      ...story,
      data: { ...story.data, storyRunMode: 'assets-missing' },
    }],
    settings: EMPTY_SETTINGS,
  });
  assert.equal(
    assetRun.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'),
    false,
  );
});
