export type NormalizedRunErrorKind = 'authentication' | 'quota' | 'rate_limit' | 'network' | 'protocol' | 'upstream' | 'cancelled' | 'local_io' | 'unknown';

export interface NormalizedRunError {
  kind: NormalizedRunErrorKind;
  message: string;
  code?: string;
  httpStatus?: number;
  retryable: boolean;
}

export function normalizeRunError(error: unknown): NormalizedRunError {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = String(record.message || error || '未知运行错误').slice(0, 2000);
  const code = String(record.code || record.name || '').slice(0, 120) || undefined;
  const explicitHttpStatus = Number(
    record.upstreamHttpStatus
    || record.httpStatus
    || record.transportHttpStatus
    || record.status
    || record.statusCode
    || (record.response as any)?.status
    || (record.data as any)?.status,
  ) || undefined;
  const messageHttpStatus = Number(message.match(/(?:HTTP\s*|status(?:\s+code)?\s*[:=]?\s*)([1-5]\d{2})/i)?.[1]) || undefined;
  const httpStatus = explicitHttpStatus && explicitHttpStatus >= 100 && explicitHttpStatus <= 599
    ? explicitHttpStatus
    : messageHttpStatus;
  const haystack = `${code || ''} ${message}`.toLowerCase();
  let kind: NormalizedRunErrorKind = 'unknown';
  if (httpStatus === 401 || httpStatus === 403 || /unauthor|forbidden|invalid api|api.?key|认证|密钥/.test(haystack)) kind = 'authentication';
  else if (httpStatus === 429 || /rate.?limit|too many|限流|频率/.test(haystack)) kind = 'rate_limit';
  else if (httpStatus === 402 || /quota|credit|balance|额度|余额|配额/.test(haystack)) kind = 'quota';
  else if (/abort|cancel|stopp|取消|停止/.test(haystack)) kind = 'cancelled';
  else if (/enospc|eacces|eperm|write|disk|mkdir|写盘|磁盘|权限/.test(haystack)) kind = 'local_io';
  else if (/network|fetch|timeout|timed out|econn|enotfound|网络|超时/.test(haystack)) kind = 'network';
  else if ((httpStatus && httpStatus >= 500) || /upstream|provider|服务繁忙|上游/.test(haystack)) kind = 'upstream';
  else if ((httpStatus && httpStatus >= 400) || /invalid response|parse|json|协议|响应格式/.test(haystack)) kind = 'protocol';
  return {
    kind,
    message,
    ...(code ? { code } : {}),
    ...(httpStatus ? { httpStatus } : {}),
    retryable: ['rate_limit', 'network', 'upstream'].includes(kind),
  };
}
