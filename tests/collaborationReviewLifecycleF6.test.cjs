const assert = require('node:assert/strict');
const test = require('node:test');

const {
  canTransitionReviewLifecycle,
  decodeReviewThreadStorageStatus,
  encodeReviewThreadStorageStatus,
  reviewCompatibilityStatus,
  reviewLifecycleTransitionCapability,
} = require('../backend/src/collaboration/reviewLifecycle');

test('F6 versioned review-state codec keeps historical rows readable', () => {
  assert.deepEqual(decodeReviewThreadStorageStatus('open'), {
    resolutionStatus: 'open', reviewStatus: 'in_review', legacy: true,
  });
  assert.deepEqual(decodeReviewThreadStorageStatus('approved'), {
    resolutionStatus: 'resolved', reviewStatus: 'approved', legacy: true,
  });
  const encoded = encodeReviewThreadStorageStatus('resolved', 'changes_requested');
  assert.equal(encoded, 't8-review-state-v1:resolved:changes_requested');
  assert.deepEqual(decodeReviewThreadStorageStatus(encoded), {
    resolutionStatus: 'resolved', reviewStatus: 'changes_requested', legacy: false,
  });
  assert.equal(reviewCompatibilityStatus('resolved', 'changes_requested'), 'changes_requested');
});

test('F6 lifecycle graph and transition capabilities are explicit', () => {
  assert.equal(canTransitionReviewLifecycle('draft', 'in_review'), true);
  assert.equal(canTransitionReviewLifecycle('draft', 'approved'), false);
  assert.equal(canTransitionReviewLifecycle('in_review', 'approved'), true);
  assert.equal(canTransitionReviewLifecycle('changes_requested', 'in_review'), true);
  assert.equal(canTransitionReviewLifecycle('approved', 'in_review'), false);
  assert.equal(reviewLifecycleTransitionCapability('in_review', 'approved'), 'approve');
  assert.equal(reviewLifecycleTransitionCapability('approved', 'approved'), 'approve');
  assert.equal(reviewLifecycleTransitionCapability('changes_requested', 'changes_requested'), 'approve');
  assert.equal(reviewLifecycleTransitionCapability('changes_requested', 'in_review'), 'comment');
});
