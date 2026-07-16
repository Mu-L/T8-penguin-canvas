'use strict';

/**
 * Supply-chain registry for the optional local semantic asset models.
 *
 * Keep repository names, filenames and integrity details private to the
 * backend worker. HTTP callers are only ever allowed to select one of the
 * stable model ids below; they cannot provide a repository, URL, revision or
 * filesystem path.
 */

const SEMANTIC_TASKS = Object.freeze({
  CAPTION: 'caption',
  OCR: 'ocr',
  EMBEDDING: 'embedding',
});

const SEMANTIC_MODEL_IDS = Object.freeze({
  CAPTION_BLIP_BASE: 'caption-blip-base',
  OCR_TROCR_SMALL_PRINTED: 'ocr-trocr-small-printed',
  EMBEDDING_MULTILINGUAL_MINILM_L12_V2: 'embedding-multilingual-minilm-l12-v2',
});

const TRUSTED_MODEL_SPECS = Object.freeze({
  [SEMANTIC_MODEL_IDS.CAPTION_BLIP_BASE]: Object.freeze({
    modelId: SEMANTIC_MODEL_IDS.CAPTION_BLIP_BASE,
    task: SEMANTIC_TASKS.CAPTION,
    displayName: 'BLIP Base 图像描述',
    downloadBytes: 990_769_234,
    repository: 'Salesforce/blip-image-captioning-base',
    revision: '82a37760796d32b1411fe092ab5d4e227313294b',
    weight: Object.freeze({
      filename: 'pytorch_model.bin',
      size: 989_820_849,
      sha256: 'd6638651a5526cc2ede56f2b5104d6851b0755816d220e5e046870430180c767',
    }),
    allowPatterns: Object.freeze([
      'config.json',
      'preprocessor_config.json',
      'pytorch_model.bin',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'vocab.txt',
    ]),
    inputKinds: Object.freeze(['image']),
  }),
  [SEMANTIC_MODEL_IDS.OCR_TROCR_SMALL_PRINTED]: Object.freeze({
    modelId: SEMANTIC_MODEL_IDS.OCR_TROCR_SMALL_PRINTED,
    task: SEMANTIC_TASKS.OCR,
    displayName: 'TrOCR Small 印刷文字识别',
    downloadBytes: 247_200_667,
    repository: 'microsoft/trocr-small-printed',
    revision: '04e994ab854b0089d4929f48c2b4dbe2ce78a340',
    weight: Object.freeze({
      filename: 'model.safetensors',
      size: 245_839_136,
      sha256: '49350a39968df83e5a1adc90fc0ede02ff247671aed70b842af350fd4a7103f3',
    }),
    allowPatterns: Object.freeze([
      'config.json',
      'generation_config.json',
      'model.safetensors',
      'preprocessor_config.json',
      'sentencepiece.bpe.model',
      'special_tokens_map.json',
      'tokenizer_config.json',
    ]),
    inputKinds: Object.freeze(['image']),
    maximumLines: 16,
  }),
  [SEMANTIC_MODEL_IDS.EMBEDDING_MULTILINGUAL_MINILM_L12_V2]: Object.freeze({
    modelId: SEMANTIC_MODEL_IDS.EMBEDDING_MULTILINGUAL_MINILM_L12_V2,
    task: SEMANTIC_TASKS.EMBEDDING,
    displayName: 'Multilingual MiniLM L12 向量',
    downloadBytes: 499_557_407,
    repository: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
    revision: 'e8f8c211226b894fcb81acc59f3b34ba3efd5f42',
    weight: Object.freeze({
      filename: 'model.safetensors',
      size: 470_641_600,
      sha256: 'eaa086f0ffee582aeb45b36e34cdd1fe2d6de2bef61f8a559a1bbc9bd955917b',
    }),
    allowPatterns: Object.freeze([
      'config.json',
      'config_sentence_transformers.json',
      'model.safetensors',
      'modules.json',
      'sentence_bert_config.json',
      'sentencepiece.bpe.model',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'unigram.json',
      '1_Pooling/config.json',
    ]),
    inputKinds: Object.freeze(['text']),
    embeddingDimension: 384,
  }),
});

const DEFAULT_SEMANTIC_MODEL_BY_TASK = Object.freeze({
  [SEMANTIC_TASKS.CAPTION]: SEMANTIC_MODEL_IDS.CAPTION_BLIP_BASE,
  [SEMANTIC_TASKS.OCR]: SEMANTIC_MODEL_IDS.OCR_TROCR_SMALL_PRINTED,
  [SEMANTIC_TASKS.EMBEDDING]: SEMANTIC_MODEL_IDS.EMBEDDING_MULTILINGUAL_MINILM_L12_V2,
});

function semanticModelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertSemanticModelId(modelId, expectedTask = '') {
  if (typeof modelId !== 'string' || !Object.prototype.hasOwnProperty.call(TRUSTED_MODEL_SPECS, modelId)) {
    throw semanticModelError('asset-semantic-model-not-allowed', '不支持的语义模型');
  }
  const spec = TRUSTED_MODEL_SPECS[modelId];
  if (expectedTask && spec.task !== expectedTask) {
    throw semanticModelError('asset-semantic-model-task-mismatch', '语义模型与任务类型不匹配');
  }
  return modelId;
}

/** Internal-only supply-chain metadata. Never serialize this object. */
function getTrustedSemanticModelSpec(modelId, expectedTask = '') {
  assertSemanticModelId(modelId, expectedTask);
  return TRUSTED_MODEL_SPECS[modelId];
}

function toPublicModel(spec) {
  return Object.freeze({
    modelId: spec.modelId,
    task: spec.task,
    displayName: spec.displayName,
    revision: spec.revision,
    downloadBytes: spec.downloadBytes,
    inputKinds: Object.freeze([...spec.inputKinds]),
    ...(spec.embeddingDimension ? { embeddingDimension: spec.embeddingDimension } : {}),
    ...(spec.maximumLines ? { maximumLines: spec.maximumLines } : {}),
  });
}

const PUBLIC_MODEL_MANIFEST = Object.freeze(
  Object.values(TRUSTED_MODEL_SPECS).map(toPublicModel),
);

function getPublicSemanticModelManifest() {
  return PUBLIC_MODEL_MANIFEST.map((model) => ({
    ...model,
    inputKinds: [...model.inputKinds],
  }));
}

function getPublicSemanticModel(modelId) {
  const id = assertSemanticModelId(modelId);
  const model = PUBLIC_MODEL_MANIFEST.find((entry) => entry.modelId === id);
  return {
    ...model,
    inputKinds: [...model.inputKinds],
  };
}

module.exports = {
  DEFAULT_SEMANTIC_MODEL_BY_TASK,
  SEMANTIC_MODEL_IDS,
  SEMANTIC_TASKS,
  assertSemanticModelId,
  getPublicSemanticModel,
  getPublicSemanticModelManifest,
  getTrustedSemanticModelSpec,
};
