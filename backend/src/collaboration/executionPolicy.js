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
    const usage = this.database.getExecutionUsage(projectId, input.now, { excludeIntentId });
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
    if (usage.activeCount >= policy.concurrencyLimit) {
      throw new ExecutionPolicyError('concurrency_limit', '主机代执行并发已满', { limit: policy.concurrencyLimit, active: usage.activeCount });
    }
    return { policy, usage, estimatedCost, estimatedCostKnown, declarations };
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

    const canvas = this.database.getCanvas(intent.canvasId);
    if (!canvas || canvas.projectId !== intent.projectId) {
      throw new ExecutionPolicyError(
        'intent_canvas_scope_invalid',
        '运行意图对应画布不存在或已离开当前项目',
        { canvasId: intent.canvasId },
        409,
      );
    }
    if (Number(canvas.revision) !== Number(intent.canvasRevision)) {
      throw new ExecutionPolicyError(
        'intent_canvas_stale',
        '运行意图对应的画布版本已变化，请重新发起',
        { expectedRevision: intent.canvasRevision, currentRevision: canvas.revision },
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
      declarations: authority.declarations,
      estimatedCost: authority.cost.known === true ? authority.cost.amount : null,
      estimatedCostKnown: authority.cost.known === true,
      intentId: intent.id,
      reservationAlreadyCounted: options.reservationAlreadyCounted === true,
      now: options.now,
    });
    return { intent, member, canvas, authority, ...authorization };
  }

}

module.exports = { ExecutionPolicyError, HostExecutionPolicy, modelKeys };
