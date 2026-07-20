import type {
  CollaborationReviewLifecycleStatus,
  CollaborationReviewResolutionStatus,
} from '../types/project';

export const COLLABORATION_REVIEW_LIFECYCLE_TRANSITIONS: Readonly<
  Record<CollaborationReviewLifecycleStatus, readonly CollaborationReviewLifecycleStatus[]>
> = Object.freeze({
  draft: Object.freeze(['in_review'] as CollaborationReviewLifecycleStatus[]),
  in_review: Object.freeze(['changes_requested', 'approved'] as CollaborationReviewLifecycleStatus[]),
  changes_requested: Object.freeze(['in_review'] as CollaborationReviewLifecycleStatus[]),
  approved: Object.freeze([] as CollaborationReviewLifecycleStatus[]),
});

export type CollaborationReviewLifecycleAction =
  | 'submit_for_review'
  | 'request_changes'
  | 'approve'
  | 'resubmit_for_review';

const ACTION_TARGETS: Readonly<Record<
  CollaborationReviewLifecycleAction,
  CollaborationReviewLifecycleStatus
>> = Object.freeze({
  submit_for_review: 'in_review',
  request_changes: 'changes_requested',
  approve: 'approved',
  resubmit_for_review: 'in_review',
});

export function canTransitionCollaborationReviewLifecycle(
  fromStatus: CollaborationReviewLifecycleStatus,
  toStatus: CollaborationReviewLifecycleStatus,
) {
  return fromStatus === toStatus
    || COLLABORATION_REVIEW_LIFECYCLE_TRANSITIONS[fromStatus].includes(toStatus);
}

export function collaborationReviewLifecycleActionTarget(
  currentStatus: CollaborationReviewLifecycleStatus,
  action: CollaborationReviewLifecycleAction,
): CollaborationReviewLifecycleStatus | null {
  const target = ACTION_TARGETS[action];
  if (action === 'submit_for_review' && currentStatus !== 'draft') return null;
  if (action === 'resubmit_for_review' && currentStatus !== 'changes_requested') return null;
  if ((action === 'request_changes' || action === 'approve') && currentStatus !== 'in_review') return null;
  return canTransitionCollaborationReviewLifecycle(currentStatus, target) ? target : null;
}

export function canPerformCollaborationReviewLifecycleAction(
  currentStatus: CollaborationReviewLifecycleStatus,
  action: CollaborationReviewLifecycleAction,
  authority: { online: boolean; canComment: boolean; canApprove: boolean },
) {
  const target = collaborationReviewLifecycleActionTarget(currentStatus, action);
  if (!authority.online || !target) return false;
  return target === 'approved' || target === 'changes_requested'
    ? authority.canApprove
    : authority.canComment;
}

export function canReassertCollaborationReviewDecision(
  currentStatus: CollaborationReviewLifecycleStatus,
  effectiveStatus: CollaborationReviewLifecycleStatus | 'expired',
  authority: { online: boolean; canApprove: boolean },
) {
  return authority.online
    && authority.canApprove
    && effectiveStatus === 'expired'
    && (currentStatus === 'approved' || currentStatus === 'changes_requested');
}

export function oppositeCollaborationReviewResolutionStatus(
  status: CollaborationReviewResolutionStatus,
): CollaborationReviewResolutionStatus {
  return status === 'open' ? 'resolved' : 'open';
}
