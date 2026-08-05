import assert from 'node:assert/strict';
import test from 'node:test';
import type { Node } from '@xyflow/react';
import { buildRunPreflightDiagnostics } from '../src/utils/runPreflightContext.ts';
import { analyzeWorkflow } from '../src/utils/workflowDoctor.ts';
import type { ApiSettings } from '../src/types/canvas.ts';

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

function enhancer(data: Record<string, unknown> = {}): Node {
  return {
    id: 'seedance20-enhancer',
    type: 'seedance20-prompt-enhancer',
    position: { x: 0, y: 0 },
    data: {
      providerSource: 'zhenzhen',
      providerModel: 'bytedance/doubao-seed-2.1-pro',
      userPrompt: '雨中的追逐镜头',
      ...data,
    },
  };
}

test('Seedance 2.0 enhancer preflight follows the selected built-in credential', () => {
  const node = enhancer();
  const input = {
    nodes: [node], edges: [], executionNodeIds: [node.id], scopeMode: 'exact-plan' as const,
    projectId: 'project-seedance20-enhancer', providersComplete: true, assets: [], policy: null,
  };
  const missingDefault = buildRunPreflightDiagnostics({ ...input, settings: EMPTY_SETTINGS });
  assert.equal(missingDefault.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'), true);
  const configuredDefault = buildRunPreflightDiagnostics({ ...input, settings: { ...EMPTY_SETTINGS, zhenzhenSd2ApiKey: 'configured' } });
  assert.equal(configuredDefault.capability.some((item) => item.ruleId === 'provider.seedance-nz-credential-missing'), false);
  const workshop = enhancer({ llmApiSource: 'zhenzhen', model: 'gemini-3.5-flash' });
  const missingWorkshop = buildRunPreflightDiagnostics({ ...input, nodes: [workshop], settings: EMPTY_SETTINGS });
  assert.equal(missingWorkshop.capability.some((item) => item.ruleId === 'provider.llm-credential-missing'), true);
});

test('workflow doctor treats the enhancer as domestic by default and exposes missing extensions', () => {
  const defaultIssues = analyzeWorkflow([enhancer()], [], {
    limits: { allowedModels: ['seedance-nz:bytedance/doubao-seed-2.1-pro'] },
  });
  assert.equal(defaultIssues.some((item) => item.ruleId === 'model.capability-mismatch'), false);
  const externalIssues = analyzeWorkflow([enhancer({
    providerSource: 'openai-compatible',
    providerId: 'missing-openai',
    providerModel: 'vision-model',
  })], [], { providersComplete: true, providers: [] });
  assert.equal(externalIssues.some((item) => item.ruleId === 'provider.selection-unavailable'), true);
});
