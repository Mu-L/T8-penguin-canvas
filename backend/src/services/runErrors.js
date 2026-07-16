const ERROR_KINDS = new Set([
  'authentication',
  'quota',
  'rate_limit',
  'network',
  'protocol',
  'upstream',
  'cancelled',
  'local_io',
  'unknown',
]);

function httpStatusFrom(error, message) {
  const explicit = Number(error?.upstreamHttpStatus || error?.httpStatus || error?.transportHttpStatus || error?.status || error?.statusCode || error?.response?.status || error?.data?.status);
  if (Number.isInteger(explicit) && explicit >= 100 && explicit <= 599) return explicit;
  const parsed = Number(String(message || '').match(/(?:HTTP\s*|status(?:\s+code)?\s*[:=]?\s*)([1-5]\d{2})/i)?.[1]);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

function normalizeRunError(value) {
  const error = value && typeof value === 'object' ? value : {};
  const message = String(error.message || value || '未知运行错误').slice(0, 2000);
  const code = String(error.code || error.name || '').slice(0, 120) || undefined;
  const httpStatus = httpStatusFrom(error, message);
  const suppliedKind = String(error.kind || '').trim().toLowerCase();
  const haystack = `${code || ''} ${message}`.toLowerCase();
  let kind = ERROR_KINDS.has(suppliedKind) ? suppliedKind : 'unknown';
  if (kind === 'unknown') {
    if (httpStatus === 401 || httpStatus === 403 || /unauthor|forbidden|invalid api|api.?key|认证|密钥/.test(haystack)) kind = 'authentication';
    else if (httpStatus === 429 || /rate.?limit|too many|限流|频率/.test(haystack)) kind = 'rate_limit';
    else if (httpStatus === 402 || /quota|credit|balance|额度|余额|配额/.test(haystack)) kind = 'quota';
    else if (/abort|cancel|stopp|取消|停止/.test(haystack)) kind = 'cancelled';
    else if (/enospc|eacces|eperm|write|disk|mkdir|写盘|磁盘|权限/.test(haystack)) kind = 'local_io';
    else if (/network|fetch|timeout|timed out|econn|enotfound|网络|超时/.test(haystack)) kind = 'network';
    else if ((httpStatus && httpStatus >= 500) || /upstream|provider|服务繁忙|上游/.test(haystack)) kind = 'upstream';
    else if ((httpStatus && httpStatus >= 400) || /invalid response|parse|json|协议|响应格式/.test(haystack)) kind = 'protocol';
  }
  const retryable = typeof error.retryable === 'boolean'
    ? error.retryable
    : ['rate_limit', 'network', 'upstream'].includes(kind);
  return {
    kind,
    message,
    ...(code ? { code } : {}),
    ...(httpStatus ? { httpStatus } : {}),
    retryable,
  };
}

module.exports = {
  ERROR_KINDS,
  normalizeRunError,
};
