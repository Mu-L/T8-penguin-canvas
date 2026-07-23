import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CUSTOM_LLM_MODEL_VALUE,
  LLM_MODELS,
  resolveLlmModelSelection,
} from '../src/providers/models.ts';
import { generateLlm } from '../src/services/generation.ts';

const ROOT = path.resolve(process.cwd());

test('zhenzhen LLM presets include the requested common models', () => {
  const byId = new Map(LLM_MODELS.map((item) => [item.id, item]));
  for (const model of ['gpt-5.6-luna', 'kimi-k3', 'gemini-3.6-flash']) {
    assert.equal(byId.get(model)?.id, model);
    assert.equal(byId.get(model)?.provider, 'llm-direct');
  }
});

test('custom LLM selection preserves exact model names and infers legacy unknown models', () => {
  const selected = resolveLlmModelSelection({
    model: 'gemini-3.5-flash',
    customModel: '  vendor/custom-model-v2  ',
    useCustomModel: true,
  });
  assert.deepEqual(selected, {
    model: 'vendor/custom-model-v2',
    customModelInput: '  vendor/custom-model-v2  ',
    isCustom: true,
    presetValue: CUSTOM_LLM_MODEL_VALUE,
  });

  const legacy = resolveLlmModelSelection({ model: 'legacy-provider/model-7' });
  assert.equal(legacy.model, 'legacy-provider/model-7');
  assert.equal(legacy.customModelInput, 'legacy-provider/model-7');
  assert.equal(legacy.isCustom, true);
  assert.equal(legacy.presetValue, CUSTOM_LLM_MODEL_VALUE);

  const preset = resolveLlmModelSelection({ model: 'gpt-5.6-luna' });
  assert.equal(preset.model, 'gpt-5.6-luna');
  assert.equal(preset.isCustom, false);
  assert.equal(preset.presetValue, 'gpt-5.6-luna');

  const empty = resolveLlmModelSelection({ model: '', customModel: '   ', useCustomModel: true });
  assert.equal(empty.model, '');
  assert.equal(empty.isCustom, true);
});

test('LLM node exposes Custom input and sends the resolved model unchanged', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/components/nodes/LLMNode.tsx'), 'utf8');
  assert.match(source, /Custom \/ 自定义/);
  assert.match(source, /placeholder="填写贞贞工坊支持的模型名称"/);
  assert.match(source, /customModel:\s*e\.target\.value/);
  assert.match(source, /model:\s*e\.target\.value/);
  assert.match(source, /请先填写 Custom 模型名称/);

  const originalFetch = globalThis.fetch;
  let submittedModel = '';
  try {
    globalThis.fetch = async (_input, init) => {
      submittedModel = String(JSON.parse(String(init?.body || '{}')).model || '');
      return new Response(JSON.stringify({
        success: true,
        data: {
          content: 'ok',
          imageUrls: [],
          raw: {},
          model: submittedModel,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const custom = resolveLlmModelSelection({
      model: 'vendor/custom-model-v2',
      customModel: 'vendor/custom-model-v2',
      useCustomModel: true,
    });
    const result = await generateLlm({
      model: custom.model,
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(submittedModel, 'vendor/custom-model-v2');
    assert.equal(result.model, 'vendor/custom-model-v2');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
