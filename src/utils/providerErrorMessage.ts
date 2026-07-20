const PROVIDER_ERROR_MESSAGE_KEYS = [
  'message',
  'error',
  'detail',
  'failReason',
  'fail_reason',
  'reason',
  'description',
] as const;

const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 2000;
const MAX_PROVIDER_ERROR_DEPTH = 4;

function boundedErrorText(value: unknown): string {
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > MAX_PROVIDER_ERROR_MESSAGE_LENGTH
      ? `${text.slice(0, MAX_PROVIDER_ERROR_MESSAGE_LENGTH)}…`
      : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Provider failures are not trustworthy runtime data. Some upstream APIs return
 * `{ message, code }` even when their TypeScript contract says `string`.
 * Only extract known text fields so React never receives an object child and
 * arbitrary provider payloads are not stringified into the UI or logs.
 */
export function normalizeProviderErrorMessage(value: unknown, fallback = '未知错误'): string {
  const seen = new Set<object>();

  const visit = (candidate: unknown, depth: number): string => {
    const primitive = boundedErrorText(candidate);
    if (primitive) return primitive;
    if (!candidate || typeof candidate !== 'object' || depth >= MAX_PROVIDER_ERROR_DEPTH) return '';
    if (seen.has(candidate)) return '';
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      for (const item of candidate.slice(0, 8)) {
        const message = visit(item, depth + 1);
        if (message) return message;
      }
      return '';
    }

    const record = candidate as Record<string, unknown>;
    for (const key of PROVIDER_ERROR_MESSAGE_KEYS) {
      const message = visit(record[key], depth + 1);
      if (message) return message;
    }
    return visit(record.code, depth + 1);
  };

  return visit(value, 0) || boundedErrorText(fallback) || '未知错误';
}
