import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canPerformCollaborationReviewLifecycleAction,
  canReassertCollaborationReviewDecision,
  canTransitionCollaborationReviewLifecycle,
  collaborationReviewLifecycleActionTarget,
  oppositeCollaborationReviewResolutionStatus,
} from '../src/utils/reviewLifecycle.ts';

test('F6 UI lifecycle actions expose only legal role-gated transitions', () => {
  const editor = { online: true, canComment: true, canApprove: false };
  const reviewer = { online: true, canComment: true, canApprove: true };

  assert.equal(collaborationReviewLifecycleActionTarget('draft', 'submit_for_review'), 'in_review');
  assert.equal(canPerformCollaborationReviewLifecycleAction('draft', 'submit_for_review', editor), true);
  assert.equal(canPerformCollaborationReviewLifecycleAction('draft', 'approve', reviewer), false);
  assert.equal(canPerformCollaborationReviewLifecycleAction('in_review', 'approve', editor), false);
  assert.equal(canPerformCollaborationReviewLifecycleAction('in_review', 'approve', reviewer), true);
  assert.equal(canPerformCollaborationReviewLifecycleAction('changes_requested', 'resubmit_for_review', editor), true);
  assert.equal(canTransitionCollaborationReviewLifecycle('approved', 'in_review'), false);
  assert.equal(canPerformCollaborationReviewLifecycleAction('approved', 'resubmit_for_review', reviewer), false);
  assert.equal(canReassertCollaborationReviewDecision('approved', 'expired', reviewer), true);
  assert.equal(canReassertCollaborationReviewDecision('changes_requested', 'expired', reviewer), true);
  assert.equal(canReassertCollaborationReviewDecision('approved', 'expired', editor), false);
  assert.equal(canReassertCollaborationReviewDecision('approved', 'approved', reviewer), false);
});

test('F6 resolution toggle is orthogonal to review lifecycle', () => {
  assert.equal(oppositeCollaborationReviewResolutionStatus('open'), 'resolved');
  assert.equal(oppositeCollaborationReviewResolutionStatus('resolved'), 'open');
});
