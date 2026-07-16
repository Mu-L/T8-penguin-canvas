import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRunError } from '../src/utils/runErrors.ts';

test('run errors are classified into stable user-actionable categories', () => {
  assert.equal(normalizeRunError({ status: 401, message: 'invalid API key' }).kind, 'authentication');
  assert.equal(normalizeRunError({ status: 429, message: 'too many requests' }).kind, 'rate_limit');
  assert.equal(normalizeRunError(new Error('fetch timeout')).kind, 'network');
  assert.equal(normalizeRunError({ code: 'ENOSPC', message: 'disk full' }).kind, 'local_io');
  assert.equal(normalizeRunError(new Error('cancelled by user')).kind, 'cancelled');
  assert.equal(normalizeRunError({ status: 503, message: 'upstream unavailable' }).retryable, true);
  assert.deepEqual(
    normalizeRunError(new Error('Provider request failed: HTTP 403 Forbidden')),
    {
      kind: 'authentication',
      message: 'Provider request failed: HTTP 403 Forbidden',
      code: 'Error',
      httpStatus: 403,
      retryable: false,
    },
  );
  assert.equal(normalizeRunError({ response: { status: 402 }, message: 'insufficient credits' }).kind, 'quota');
  assert.deepEqual(normalizeRunError({ transportHttpStatus: 429, message: 'local proxy rejected request' }), {
    kind: 'rate_limit',
    message: 'local proxy rejected request',
    httpStatus: 429,
    retryable: true,
  });
});
