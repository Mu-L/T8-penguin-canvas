const {
  RunIntentAuthorityError,
  assertRunIntentAuthorityMatches,
  deriveRunIntentAuthority,
} = require('./runIntentAuthority');

class ExecutionPolicyError extends Error {
  constructor(code, message, details = {}, httpStatus = 429) {
    super(message);
    this.name = 'ExecutionPolicyError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function modelKeys(provider, model) {
  const cleanProvider = String(provider || '').trim();
  const cleanModel = String(model || '').trim();
  return new Set([cleanModel, cleanProvider && cleanModel ? `${cleanProvider}:${cleanModel}` : ''].filter(Boolean));
}

class HostExecutionPolicy {
  constructor(database) {
    this.database = database;
  }

  authorize(input = {}) {
    const projectId = String(input.projectId || 'project-local');
    const policy = this.database.getExecutionPolicy(projectId);
    const evaluationNow = input.now == null ? Date.now() : input.now;
    const excludeIntentId = input.reservationAlreadyCounted === true
      ? String(input.intentId || '').trim()
      : null;
    if (input.reservationAlreadyCounted === true && !excludeIntentId) {
      throw new ExecutionPolicyError(
        'intent_reservation_identity_missing',
        '无法确认当前运行意图的额度预留',
        {},
        409,
      );
    }
    const reservationIntent = excludeIntentId && typeof this.database.getRunIntent === 'function'
      ? this.database.getRunIntent(excludeIntentId)
      : null;
    const usage = this.database.getExecutionUsage(projectId, evaluationNow, { excludeIntentId });
    const estimatedCostKnown = input.estimatedCostKnown === true
      || (input.estimatedCostKnown !== false && input.estimatedCost != null && Number.isFinite(Number(input.estimatedCost)));
    const estimatedCost = estimatedCostKnown ? Math.max(0, Number(input.estimatedCost) || 0) : null;
    const declarations = Array.isArray(input.declarations)
      ? input.declarations.map((entry) => ({
          provider: String(entry?.provider || '').trim(),
          model: String(entry?.model || '').trim(),
        })).filter((entry) => entry.provider && entry.model)
      : [{
          provider: String(input.provider || '').trim(),
          model: String(input.model || '').trim(),
        }].filter((entry) => entry.provider && entry.model);
    const allowed = new Set(policy.allowedModels || []);
    if (!allowed.has('*')) {
      if (declarations.length === 0) {
        throw new ExecutionPolicyError('model_not_allowed', '主机无法从权威执行范围确认允许的模型', {
          provider: null,
          model: null,
        });
      }
      for (const declaration of declarations) {
        const keys = modelKeys(declaration.provider, declaration.model);
        if (![...keys].some((key) => allowed.has(key))) {
          throw new ExecutionPolicyError('model_not_allowed', '该模型不在主机允许列表中', declaration);
        }
      }
    }
    if ((policy.perRunCostLimit > 0 || policy.dailyCostLimit > 0) && !estimatedCostKnown) {
      throw new ExecutionPolicyError(
        'cost_estimate_unavailable',
        '主机配置了费用上限，但当前运行没有服务端权威费用估算',
        { perRunCostLimit: policy.perRunCostLimit, dailyCostLimit: policy.dailyCostLimit },
        409,
      );
    }
    if (policy.dailyCostLimit > 0 && usage.unknownCostCount > 0) {
      throw new ExecutionPolicyError(
        'daily_cost_usage_incomplete',
        '今日已有运行缺少权威费用记录，无法证明未超过主机额度',
        { unknownCostCount: usage.unknownCostCount },
        409,
      );
    }
    if (policy.perRunCostLimit > 0 && estimatedCost > policy.perRunCostLimit) {
      throw new ExecutionPolicyError('run_cost_limit', '预计单次成本超过主机上限', { limit: policy.perRunCostLimit, estimatedCost });
    }
    if (policy.dailyCostLimit > 0 && usage.dailyCost + estimatedCost > policy.dailyCostLimit) {
      throw new ExecutionPolicyError('daily_cost_limit', '今日主机代执行额度已用尽', { limit: policy.dailyCostLimit, used: usage.dailyCost, estimatedCost });
    }
    if (input.enforceConcurrency !== false && usage.activeCount >= policy.concurrencyLimit) {
      throw new ExecutionPolicyError('concurrency_limit', '主机代执行并发已满', { limit: policy.concurrencyLimit, active: usage.activeCount });
    }

    const canvasId = String(input.canvasId || '').trim();
    const requestedBy = String(input.requestedBy || '').trim();
    const requesterRole = String(input.requesterRole || '').trim().toLowerCase();
    let roomPolicy = null;
    let roomUsage = null;
    let confirmation = {
      required: false,
      lowRisk: true,
      reasons: [],
    };
    if (canvasId && typeof this.database.getRoomExecutionPolicy === 'function') {
      roomPolicy = this.database.getRoomExecutionPolicy(projectId, canvasId);
      if (requesterRole && !['owner', 'editor'].includes(requesterRole)) {
        throw new ExecutionPolicyError(
          'room_run_role_forbidden',
          '当前成员角色不能提交主机代执行请求',
          { role: requesterRole },
          403,
        );
      }
      if (requesterRole === 'editor' && roomPolicy.allowEditorRuns !== true) {
        throw new ExecutionPolicyError(
          'room_editor_runs_disabled',
          '当前协作房间未允许编辑者提交主机代执行请求',
          { canvasId },
          403,
        );
      }
      if (requestedBy && typeof this.database.getRoomExecutionUsage === 'function') {
        roomUsage = this.database.getRoomExecutionUsage(projectId, canvasId, requestedBy, evaluationNow);
        const exactRoomReservation = input.reservationAlreadyCounted === true
          && reservationIntent
          && reservationIntent.projectId === projectId
          && reservationIntent.canvasId === canvasId
          && reservationIntent.requestedBy === requestedBy;
        const reservationCreatedAt = Number(reservationIntent?.createdAt);
        const roomDayStart = Number(roomUsage?.dayStart);
        const alreadyReserved = exactRoomReservation
          && ['pending', 'accepted', 'dispatching', 'running'].includes(reservationIntent.status)
          && Number.isSafeInteger(reservationCreatedAt)
          && Number.isSafeInteger(roomDayStart)
          && reservationCreatedAt >= roomDayStart
          ? 1
          : 0;
        const activeReservationAlreadyCounted = exactRoomReservation
          && (
            reservationIntent.status === 'running'
            || (reservationIntent.status === 'dispatching'
              && Number(reservationIntent.leaseExpiresAt) > Number(evaluationNow))
          )
          ? 1
          : 0;
        const activeCount = Math.max(
          0,
          Number(roomUsage?.activeCount || 0) - activeReservationAlreadyCounted,
        );
        if (input.enforceConcurrency !== false
          && activeCount >= roomPolicy.canvasConcurrencyLimit) {
          throw new ExecutionPolicyError(
            'concurrency_limit',
            '当前协作房间的主机代执行并发已满',
            {
              scope: 'room',
              canvasId,
              limit: roomPolicy.canvasConcurrencyLimit,
              active: activeCount,
            },
            429,
          );
        }
        const requesterDailyCount = Math.max(
          0,
          Number(roomUsage?.requestedByDailyCount || 0) - alreadyReserved,
        );
        if (roomPolicy.memberDailyRunLimit > 0
          && requesterDailyCount >= roomPolicy.memberDailyRunLimit) {
          throw new ExecutionPolicyError(
            'room_member_daily_run_limit',
            '当前成员今日的主机代执行次数已达房间上限',
            {
              canvasId,
              limit: roomPolicy.memberDailyRunLimit,
              used: requesterDailyCount,
            },
            429,
          );
        }
      }

      const reasons = [];
      if (!estimatedCostKnown && roomPolicy.requireUnknownCostConfirmation === true) {
        reasons.push('cost_unknown');
      }
      if (estimatedCostKnown
        && roomPolicy.highCostConfirmationThreshold > 0
        && estimatedCost > roomPolicy.highCostConfirmationThreshold) {
        reasons.push('high_cost');
      }
      const lowRisk = reasons.length === 0;
      confirmation = {
        required: !lowRisk || roomPolicy.autoApproveLowRisk !== true,
        lowRisk,
        reasons,
      };
    }
    return {
      policy,
      usage,
      roomPolicy,
      roomUsage,
      confirmation,
      estimatedCost,
      estimatedCostKnown,
      declarations,
    };
  }

  authorizeRunIntent(intentOrId, options = {}) {
    const intentId = typeof intentOrId === 'string'
      ? intentOrId
      : String(intentOrId?.id || '');
    const intent = intentId ? this.database.getRunIntent(intentId) : null;
    if (!intent) {
      throw new ExecutionPolicyError('intent_not_found', '运行意图不存在', {}, 404);
    }
    const allowedStatuses = Array.isArray(options.allowedStatuses)
      ? new Set(options.allowedStatuses.map(String))
      : null;
    if ((allowedStatuses && !allowedStatuses.has(intent.status)) || (options.requireUnclaimed === true && intent.runId)) {
      throw new ExecutionPolicyError(
        'intent_state_invalid',
        '运行意图已被处理或当前状态不允许执行',
        { status: intent.status, claimed: Boolean(intent.runId) },
        409,
      );
    }

    const member = this.database.getCollaborationMember(intent.requestedBy);
    const roleCanRun = member && ['owner', 'editor'].includes(String(member.role));
    const capabilityCanRun = member && Array.isArray(member.capabilities) && member.capabilities.includes('runWorkflow');
    if (!member
      || member.projectId !== intent.projectId
      || String(member.canvasId || '') !== String(intent.canvasId)
      || !roleCanRun
      || !capabilityCanRun) {
      throw new ExecutionPolicyError(
        'intent_requester_not_authorized',
        '运行意图发起人已不是当前画布中可运行工作流的成员',
        {
          requestedBy: intent.requestedBy,
          role: member?.role || null,
          memberCanvasId: member?.canvasId || null,
          intentCanvasId: intent.canvasId,
        },
        403,
      );
    }

    const currentCanvas = this.database.getCanvas(intent.canvasId);
    if (!currentCanvas || currentCanvas.projectId !== intent.projectId) {
      throw new ExecutionPolicyError(
        'intent_canvas_scope_invalid',
        '运行意图对应画布不存在或已离开当前项目',
        { canvasId: intent.canvasId },
        409,
      );
    }
    // Dispatch always re-opens the current recovery-generation fence, but the
    // Provider authority belongs to the immutable revision that created the
    // intent. A collaborator may legitimately persist rN+1 while an accepted
    // rN request waits in FIFO; using the latest document here would either
    // reject that request or silently change its Provider-facing input.
    try {
      this.database.getRecoveryGeneration();
      this.database.requiresRecoveryGeneration();
    } catch (error) {
      throw new ExecutionPolicyError(
        String(error?.code || 'project_database_recovery_generation_unavailable'),
        '项目数据库 recovery generation 暂时不可用，已停止派发',
        {},
        Number(error?.statusCode ?? error?.status) || 503,
      );
    }

    let canvas = null;
    try {
      canvas = this.database.getCanvasSnapshotDocument(
        intent.canvasId,
        intent.canvasRevision,
      );
    } catch (error) {
      const snapshotIsInvalid = new Set([
        'canvas_snapshot_integrity_conflict',
        'collaboration_domain_review_snapshot_invalid',
      ]).has(String(error?.code || ''));
      throw new ExecutionPolicyError(
        snapshotIsInvalid
          ? 'intent_canvas_snapshot_unavailable'
          : 'intent_canvas_snapshot_read_unavailable',
        snapshotIsInvalid
          ? '运行意图绑定的精确历史画布快照不可用，不能回退到最新版本'
          : '运行意图绑定的历史画布快照暂时无法读取，已停止派发',
        { canvasId: intent.canvasId, canvasRevision: intent.canvasRevision },
        snapshotIsInvalid ? 409 : 503,
      );
    }
    if (!canvas
      || canvas.projectId !== intent.projectId
      || canvas.canvasId !== intent.canvasId
      || Number(canvas.revision) !== Number(intent.canvasRevision)) {
      throw new ExecutionPolicyError(
        'intent_canvas_snapshot_unavailable',
        '运行意图绑定的精确历史画布快照不可用，不能回退到最新版本',
        { canvasId: intent.canvasId, canvasRevision: intent.canvasRevision },
        409,
      );
    }

    let authority;
    try {
      authority = deriveRunIntentAuthority(canvas, intent.nodeIds);
      assertRunIntentAuthorityMatches(intent.executionAuthority, authority);
    } catch (error) {
      if (error instanceof RunIntentAuthorityError) {
        throw new ExecutionPolicyError(
          error.code,
          error.message,
          error.details,
          error.httpStatus,
        );
      }
      throw error;
    }

    const authorization = this.authorize({
      projectId: intent.projectId,
      canvasId: intent.canvasId,
      requestedBy: intent.requestedBy,
      requesterRole: member.role,
      declarations: authority.declarations,
      estimatedCost: authority.cost.known === true ? authority.cost.amount : null,
      estimatedCostKnown: authority.cost.known === true,
      intentId: intent.id,
      reservationAlreadyCounted: options.reservationAlreadyCounted === true,
      enforceConcurrency: options.enforceConcurrency !== false,
      now: options.now,
    });
    const confirmationSatisfied = intent.confirmationRequired === true
      && Number.isSafeInteger(Number(intent.confirmedAt))
      && Number(intent.confirmedAt) >= 1
      && Boolean(String(intent.confirmedBy || '').trim());
    if (options.requireConfirmationSatisfied === true
      && authorization.confirmation.required === true
      && !confirmationSatisfied) {
      throw new ExecutionPolicyError(
        'intent_confirmation_required',
        '最新执行策略要求人工确认，请确认后重新派发',
        {
          canvasId: intent.canvasId,
          reasons: [...authorization.confirmation.reasons],
          roomPolicyRevision: authorization.roomPolicy?.revision ?? null,
          confirmationRequired: intent.confirmationRequired === true,
          confirmationSatisfied: false,
        },
        409,
      );
    }
    return { intent, member, canvas, currentCanvas, authority, ...authorization };
  }

}

module.exports = { ExecutionPolicyError, HostExecutionPolicy, modelKeys };
