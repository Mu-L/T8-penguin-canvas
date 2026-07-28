'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const PROVIDER_SUBMISSION_HEADER = 'x-t8-provider-submission';
const providerSubmissionStorage = new AsyncLocalStorage();

function normalizeProviderSubmissionKey(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(key)) return '';
  return key;
}

function providerSubmissionContextMiddleware(req, _res, next) {
  const key = normalizeProviderSubmissionKey(req.get?.(PROVIDER_SUBMISSION_HEADER));
  providerSubmissionStorage.run(Object.freeze({ key: key || null }), next);
}

function currentProviderSubmissionKey() {
  return providerSubmissionStorage.getStore()?.key || '';
}

function providerIdempotencyHeaders(headers, method = 'POST') {
  const key = currentProviderSubmissionKey();
  if (!key || !['POST', 'PUT', 'PATCH'].includes(String(method || 'POST').toUpperCase())) return headers;
  const output = new Headers(headers || {});
  if (!output.has('Idempotency-Key')) output.set('Idempotency-Key', key);
  return output;
}

function providerIdempotencyHeadersLike(headers, method = 'POST') {
  const key = currentProviderSubmissionKey();
  if (!key || !['POST', 'PUT', 'PATCH'].includes(String(method || 'POST').toUpperCase())) return headers;
  if (headers instanceof Headers) {
    const output = new Headers(headers);
    if (!output.has('Idempotency-Key')) output.set('Idempotency-Key', key);
    return output;
  }
  if (Array.isArray(headers)) {
    const hasExplicit = headers.some(([name]) => String(name || '').toLowerCase() === 'idempotency-key');
    return hasExplicit ? headers : [...headers, ['Idempotency-Key', key]];
  }
  if (headers && typeof headers === 'object') {
    const hasExplicit = Object.keys(headers).some((name) => name.toLowerCase() === 'idempotency-key');
    return hasExplicit ? headers : { ...headers, 'Idempotency-Key': key };
  }
  return { 'Idempotency-Key': key };
}

module.exports = {
  PROVIDER_SUBMISSION_HEADER,
  normalizeProviderSubmissionKey,
  providerSubmissionContextMiddleware,
  currentProviderSubmissionKey,
  providerIdempotencyHeaders,
  providerIdempotencyHeadersLike,
};
