const REVIEW_STORAGE_PREFIX = 't8-review-state-v1';

const REVIEW_RESOLUTION_STATUSES = Object.freeze(['open', 'resolved']);
const REVIEW_LIFECYCLE_STATUSES = Object.freeze([
  'draft',
  'in_review',
  'changes_requested',
  'approved',
]);
const REVIEW_DECISION_STATUSES = Object.freeze(['changes_requested', 'approved']);

const RESOLUTION_STATUS_SET = new Set(REVIEW_RESOLUTION_STATUSES);
const LIFECYCLE_STATUS_SET = new Set(REVIEW_LIFECYCLE_STATUSES);
const DECISION_STATUS_SET = new Set(REVIEW_DECISION_STATUSES);

const REVIEW_LIFECYCLE_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['in_review']),
  in_review: Object.freeze(['changes_requested', 'approved']),
  changes_requested: Object.freeze(['in_review']),
  approved: Object.freeze([]),
});

function isReviewResolutionStatus(value) {
  return typeof value === 'string' && RESOLUTION_STATUS_SET.has(value);
}

function isReviewLifecycleStatus(value) {
  return typeof value === 'string' && LIFECYCLE_STATUS_SET.has(value);
}

function isReviewDecisionStatus(value) {
  return typeof value === 'string' && DECISION_STATUS_SET.has(value);
}

function encodeReviewThreadStorageStatus(resolutionStatus, reviewStatus) {
  if (!isReviewResolutionStatus(resolutionStatus) || !isReviewLifecycleStatus(reviewStatus)) {
    throw new TypeError('review thread lifecycle state is invalid');
  }
  return `${REVIEW_STORAGE_PREFIX}:${resolutionStatus}:${reviewStatus}`;
}

function decodeReviewThreadStorageStatus(rawStatus) {
  const status = String(rawStatus || '');
  const match = /^t8-review-state-v1:(open|resolved):(draft|in_review|changes_requested|approved)$/.exec(status);
  if (match) {
    return {
      resolutionStatus: match[1],
      reviewStatus: match[2],
      legacy: false,
    };
  }

  // Historical F6 rows used one column for two independent concepts. Keep
  // those bytes readable forever and only move a row to the versioned encoding
  // when a later mutation already has authority to update it.
  if (status === 'open' || status === 'resolved') {
    return {
      resolutionStatus: status,
      reviewStatus: 'in_review',
      legacy: true,
    };
  }
  if (status === 'changes_requested' || status === 'approved') {
    return {
      // Preserve the old unresolved filter exactly: changes_requested was
      // unresolved while approved was treated as resolved.
      resolutionStatus: status === 'approved' ? 'resolved' : 'open',
      reviewStatus: status,
      legacy: true,
    };
  }
  throw new TypeError('review thread persisted status is invalid');
}

function reviewCompatibilityStatus(resolutionStatus, reviewStatus) {
  if (!isReviewResolutionStatus(resolutionStatus) || !isReviewLifecycleStatus(reviewStatus)) {
    throw new TypeError('review thread lifecycle state is invalid');
  }
  if (isReviewDecisionStatus(reviewStatus)) return reviewStatus;
  return resolutionStatus;
}

function canTransitionReviewLifecycle(fromStatus, toStatus) {
  if (!isReviewLifecycleStatus(fromStatus) || !isReviewLifecycleStatus(toStatus)) return false;
  if (fromStatus === toStatus) return true;
  return REVIEW_LIFECYCLE_TRANSITIONS[fromStatus].includes(toStatus);
}

function reviewLifecycleTransitionCapability(fromStatus, toStatus) {
  if (!canTransitionReviewLifecycle(fromStatus, toStatus)) return null;
  // Reasserting an existing decision can move its pinned canvas revision and
  // therefore has the same authority requirements as entering that decision.
  // Same-state non-decision writes remain ordinary comment mutations.
  if (isReviewDecisionStatus(toStatus)) return 'approve';
  return fromStatus === toStatus ? null : 'comment';
}

module.exports = {
  REVIEW_DECISION_STATUSES,
  REVIEW_LIFECYCLE_STATUSES,
  REVIEW_LIFECYCLE_TRANSITIONS,
  REVIEW_RESOLUTION_STATUSES,
  REVIEW_STORAGE_PREFIX,
  canTransitionReviewLifecycle,
  decodeReviewThreadStorageStatus,
  encodeReviewThreadStorageStatus,
  isReviewDecisionStatus,
  isReviewLifecycleStatus,
  isReviewResolutionStatus,
  reviewCompatibilityStatus,
  reviewLifecycleTransitionCapability,
};
