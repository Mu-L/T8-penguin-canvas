const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProviderSubmissionKey,
  providerSubmissionContextMiddleware,
  currentProviderSubmissionKey,
  providerIdempotencyHeaders,
  providerIdempotencyHeadersLike,
} = require('../backend/src/services/providerSubmissionContext');

function runWithSubmission(key, callback) {
  return new Promise((resolve, reject) => {
    providerSubmissionContextMiddleware({
      get(name) {
        return String(name).toLowerCase() === 'x-t8-provider-submission' ? key : '';
      },
    }, {}, () => {
      Promise.resolve()
        .then(callback)
        .then(resolve, reject);
    });
  });
}

test('provider submission keys are normalized before entering request context', () => {
  assert.equal(normalizeProviderSubmissionKey(' attempt-12345678 '), 'attempt-12345678');
  assert.equal(normalizeProviderSubmissionKey('short'), '');
  assert.equal(normalizeProviderSubmissionKey('invalid key with spaces'), '');
});

test('write requests inherit one stable upstream Idempotency-Key', async () => {
  await runWithSubmission('attempt-stable-1234', async () => {
    assert.equal(currentProviderSubmissionKey(), 'attempt-stable-1234');
    await new Promise((resolve) => setImmediate(resolve));
    const headers = providerIdempotencyHeaders({ Accept: 'application/json' }, 'POST');
    assert.equal(headers.get('Idempotency-Key'), 'attempt-stable-1234');
    assert.equal(headers.get('Accept'), 'application/json');
  });
  assert.equal(currentProviderSubmissionKey(), '');
});

test('parallel provider request contexts never leak submission identities', async () => {
  const observed = await Promise.all([
    runWithSubmission('attempt-parallel-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        current: currentProviderSubmissionKey(),
        upstream: providerIdempotencyHeaders({}, 'POST').get('Idempotency-Key'),
      };
    }),
    runWithSubmission('attempt-parallel-b', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        current: currentProviderSubmissionKey(),
        upstream: providerIdempotencyHeaders({}, 'PATCH').get('Idempotency-Key'),
      };
    }),
  ]);
  assert.deepEqual(observed, [
    { current: 'attempt-parallel-a', upstream: 'attempt-parallel-a' },
    { current: 'attempt-parallel-b', upstream: 'attempt-parallel-b' },
  ]);
});

test('polling reads do not receive an idempotency header and explicit provider keys win', async () => {
  await runWithSubmission('attempt-read-1234', async () => {
    assert.deepEqual(providerIdempotencyHeaders({}, 'GET'), {});
    assert.equal(
      providerIdempotencyHeaders({ 'Idempotency-Key': 'provider-specific-key' }, 'POST')
        .get('Idempotency-Key'),
      'provider-specific-key',
    );
  });
});

test('adapter helper preserves plain-object headers while appending the stable key', async () => {
  await runWithSubmission('attempt-object-1234', async () => {
    const headers = providerIdempotencyHeadersLike({
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    }, 'POST');
    assert.equal(headers.Authorization, 'Bearer secret');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['Idempotency-Key'], 'attempt-object-1234');
  });
});
