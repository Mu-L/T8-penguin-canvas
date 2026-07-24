import seedanceNzLlmModels from '../../backend/src/shared/seedanceNzLlmModels.json' with { type: 'json' };

export const SEEDANCE_NZ_LLM_MODELS = Object.freeze(
  seedanceNzLlmModels.map((model) => String(model)),
);

export const DEFAULT_SEEDANCE_NZ_LLM_MODEL =
  SEEDANCE_NZ_LLM_MODELS.find((model) => model === 'bytedance/doubao-seed-2.0-mini')
  || SEEDANCE_NZ_LLM_MODELS[0]
  || '';

export function resolveSeedanceNzLlmModel(value: unknown): string {
  const model = typeof value === 'string' ? value.trim() : '';
  return SEEDANCE_NZ_LLM_MODELS.includes(model)
    ? model
    : DEFAULT_SEEDANCE_NZ_LLM_MODEL;
}
