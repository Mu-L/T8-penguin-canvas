export const SMART_TRANSLATION_RECORD_SCHEMA = 't8-rh-smart-translation-v1' as const;

export type SmartTranslationStatus = 'success' | 'error' | 'stale';

export interface SmartTranslationRecord {
  schema: typeof SMART_TRANSLATION_RECORD_SCHEMA;
  version: 1;
  status: SmartTranslationStatus;
  sourceText: string;
  translatedText?: string;
  provider: 'runninghub';
  capability: 'text.translate';
  toolId?: string;
  webappId?: string;
  taskId?: string;
  requestId?: string;
  startedAt: string;
  completedAt: string;
  error?: string;
}

export interface ProtectedTranslationText {
  sourceText: string;
  requestText: string;
  replacements: Array<{ placeholder: string; literal: string }>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueProtectedTerms(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(
    values
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Protect structured @ references while a remote translator rewrites the prose.
 * A missing placeholder fails closed so a completed request never silently breaks
 * media bindings in Text / LLM nodes.
 */
export function protectSmartTranslationText(
  source: unknown,
  protectedTerms: unknown = [],
): ProtectedTranslationText {
  const sourceText = String(source || '').trim();
  if (!sourceText) throw new Error('缺少要翻译的文本');

  let requestText = sourceText;
  const replacements: ProtectedTranslationText['replacements'] = [];
  uniqueProtectedTerms(protectedTerms).forEach((literal, index) => {
    if (!requestText.includes(literal)) return;
    let placeholder = `__T8_MEDIA_REF_${index + 1}__`;
    while (sourceText.includes(placeholder)) placeholder = `_${placeholder}_`;
    requestText = requestText.split(literal).join(placeholder);
    replacements.push({ placeholder, literal });
  });
  return { sourceText, requestText, replacements };
}

export function restoreSmartTranslationText(
  translated: unknown,
  replacements: ProtectedTranslationText['replacements'] = [],
): string {
  let text = String(translated || '').trim();
  if (!text) throw new Error('智能翻译未返回文本结果');
  for (const replacement of replacements) {
    const matcher = new RegExp(escapeRegExp(replacement.placeholder), 'gi');
    if (!matcher.test(text)) {
      throw new Error(`智能翻译未保留素材引用 ${replacement.literal}，结果未覆盖原文`);
    }
    text = text.replace(matcher, replacement.literal);
  }
  return text.trim();
}
