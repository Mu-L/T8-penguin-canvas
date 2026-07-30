'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AgentControlApprovalError,
  createAgentControlApprovalBinding,
  createAgentControlApprovalService,
} = require('../backend/src/services/agentControlApprovals.js');

test('operation approval binds one exact session, secret and preview before one-time completion', () => {
  let clock = Date.parse('2026-07-24T00:00:00.000Z');
  const service = createAgentControlApprovalService({ now: () => clock });
  const created = service.create({
    action: 'patch.apply',
    sessionId: 'session-a',
    actorId: 'agent:a',
    clientName: 'Codex',
    projectId: 'project-local',
    canvasId: 'canvas-a',
    patchId: 'patch-a',
    patch: { id: 'patch-a' },
    preview: { patchId: 'patch-a', previewDigest: 'a'.repeat(64), changes: [] },
  });

  assert.equal(service.listPending().length, 1);
  assert.equal(JSON.stringify(service.listPending()).includes(created.pollSecret), false);
  assert.deepEqual(service.beginCompletion({
    approvalRequestId: created.approvalRequestId,
    pollSecret: created.pollSecret,
    sessionId: 'session-a',
  }), { status: 'pending', record: null });
  assert.throws(
    () => service.beginCompletion({
      approvalRequestId: created.approvalRequestId,
      pollSecret: 'x'.repeat(43),
      sessionId: 'session-a',
    }),
    (error) => error instanceof AgentControlApprovalError && error.code === 'APPROVAL_POLL_FORBIDDEN',
  );
  assert.throws(
    () => service.beginCompletion({
      approvalRequestId: created.approvalRequestId,
      pollSecret: created.pollSecret,
      sessionId: 'session-b',
    }),
    (error) => error instanceof AgentControlApprovalError && error.code === 'APPROVAL_SESSION_MISMATCH',
  );

  service.approve(created.approvalRequestId);
  const completion = service.beginCompletion({
    approvalRequestId: created.approvalRequestId,
    pollSecret: created.pollSecret,
    sessionId: 'session-a',
  });
  assert.equal(completion.status, 'approved');
  assert.equal(completion.record.preview.previewDigest, 'a'.repeat(64));
  service.finishCompletion(completion.record, true);
  assert.throws(
    () => service.beginCompletion({
      approvalRequestId: created.approvalRequestId,
      pollSecret: created.pollSecret,
      sessionId: 'session-a',
    }),
    (error) => error instanceof AgentControlApprovalError && error.code === 'APPROVAL_NOT_FOUND',
  );

  const denied = service.create({
    action: 'patch.revert',
    sessionId: 'session-a',
    actorId: 'agent:a',
    projectId: 'project-local',
    canvasId: 'canvas-a',
    patchId: 'patch-b',
    preview: { summary: '撤销 patch-b' },
  });
  service.deny(denied.approvalRequestId);
  assert.equal(service.beginCompletion({
    approvalRequestId: denied.approvalRequestId,
    pollSecret: denied.pollSecret,
    sessionId: 'session-a',
  }).status, 'denied');

  clock += 11 * 60 * 1000;
  assert.equal(service.listPending().length, 0);
});

test('approval binding invalidates only the superseded subject before any completion side effect', () => {
  let clock = Date.parse('2026-07-24T01:00:00.000Z');
  const service = createAgentControlApprovalService({ now: () => clock });
  const scope = {
    action: 'run.start',
    sessionId: 'session-bound',
    projectId: 'project-local',
    canvasId: 'canvas-bound',
  };
  const oldBinding = createAgentControlApprovalBinding({
    ...scope,
    subject: { kind: 'run-plan', action: 'run.start', requestedNodeIds: ['node-a'] },
    planDigest: '1'.repeat(64),
    boundary: {
      providerSelections: [{ provider: 'zhenzhen', model: 'image-a', nodeIds: ['node-a'] }],
    },
  });
  const independentBinding = createAgentControlApprovalBinding({
    ...scope,
    subject: { kind: 'run-plan', action: 'run.start', requestedNodeIds: ['node-b'] },
    planDigest: '2'.repeat(64),
    boundary: {
      providerSelections: [{ provider: 'zhenzhen', model: 'image-a', nodeIds: ['node-b'] }],
    },
  });
  const oldApproval = service.create({
    ...scope,
    actorId: 'agent:bound',
    operationId: 'run-bound-old',
    approvalBinding: oldBinding,
  });
  const independentApproval = service.create({
    ...scope,
    actorId: 'agent:bound',
    operationId: 'run-bound-independent',
    approvalBinding: independentBinding,
  });
  assert.equal(oldApproval.approvalBinding.schema, 't8-agent-control-approval-binding-v1');
  assert.equal(oldApproval.approvalBinding.boundary.costTier.status, 'unknown');
  assert.equal(oldApproval.approvalBinding.boundary.privacyBoundary.status, 'unknown');

  const replacementBinding = createAgentControlApprovalBinding({
    ...scope,
    subject: { kind: 'run-plan', action: 'run.start', requestedNodeIds: ['node-a'] },
    planDigest: '3'.repeat(64),
    boundary: {
      providerSelections: [{ provider: 'seedance-nz', model: 'image-b', nodeIds: ['node-a'] }],
    },
  });
  const invalidation = service.invalidateBinding(replacementBinding);
  assert.equal(invalidation.invalidated, 1);
  assert.equal(service.invalidateBinding(replacementBinding).invalidated, 0);
  assert.deepEqual(
    service.listPending().map((item) => item.approvalRequestId),
    [independentApproval.approvalRequestId],
  );
  assert.throws(
    () => service.approve(oldApproval.approvalRequestId),
    (error) => error instanceof AgentControlApprovalError && error.code === 'APPROVAL_STALE',
  );
  assert.throws(
    () => service.beginCompletion({
      approvalRequestId: oldApproval.approvalRequestId,
      pollSecret: oldApproval.pollSecret,
      sessionId: scope.sessionId,
    }),
    (error) => error instanceof AgentControlApprovalError
      && error.code === 'APPROVAL_STALE'
      && error.status === 409,
  );

  service.approve(independentApproval.approvalRequestId);
  const independentCompletion = service.beginCompletion({
    approvalRequestId: independentApproval.approvalRequestId,
    pollSecret: independentApproval.pollSecret,
    sessionId: scope.sessionId,
  });
  assert.equal(independentCompletion.status, 'approved');
  assert.equal(independentCompletion.record.operationId, 'run-bound-independent');
  service.finishCompletion(independentCompletion.record, true);

  const replacementApproval = service.create({
    ...scope,
    actorId: 'agent:bound',
    operationId: 'run-bound-new',
    approvalBinding: replacementBinding,
  });
  assert.equal(replacementApproval.approvalBinding.planDigest, '3'.repeat(64));
  assert.notEqual(replacementApproval.approvalBinding.bindingDigest, oldBinding.bindingDigest);
});

test('provider, cost tier and privacy boundary changes each invalidate the old approval', () => {
  const cases = [
    {
      label: 'provider',
      before: {
        providerSelections: [{ kind: 'image', provider: 'zhenzhen', model: 'image-a' }],
      },
      after: {
        providerSelections: [{ kind: 'image', provider: 'seedance-nz', model: 'image-a' }],
      },
    },
    {
      label: 'cost',
      before: {
        costTier: {
          status: 'verified',
          value: 'standard',
          sourceDigest: 'c'.repeat(64),
          asOf: '2026-07-28T01:00:00.000Z',
          message: '标准费用等级',
        },
      },
      after: {
        costTier: {
          status: 'verified',
          value: 'premium',
          sourceDigest: 'd'.repeat(64),
          asOf: '2026-07-28T01:05:00.000Z',
          message: '高费用等级',
        },
      },
    },
    {
      label: 'privacy',
      before: {
        privacyBoundary: {
          status: 'verified',
          value: 'domestic',
          sourceDigest: 'e'.repeat(64),
          asOf: '2026-07-28T01:00:00.000Z',
          message: '境内处理',
        },
      },
      after: {
        privacyBoundary: {
          status: 'verified',
          value: 'cross-border',
          sourceDigest: 'f'.repeat(64),
          asOf: '2026-07-28T01:05:00.000Z',
          message: '跨境处理',
        },
      },
    },
  ];
  for (const item of cases) {
    const service = createAgentControlApprovalService();
    const shared = {
      action: 'creative.apply',
      sessionId: `session-${item.label}`,
      projectId: 'project-local',
      canvasId: 'canvas-boundary',
      subject: { kind: 'creative-plan', action: 'create.image', creativeKind: 'image' },
      planDigest: 'a'.repeat(64),
      modelDecisionDigest: 'b'.repeat(64),
    };
    const before = createAgentControlApprovalBinding({ ...shared, boundary: item.before });
    const old = service.create({
      action: shared.action,
      sessionId: shared.sessionId,
      projectId: shared.projectId,
      canvasId: shared.canvasId,
      actorId: 'agent:boundary',
      operationId: `old-${item.label}`,
      approvalBinding: before,
    });
    const after = createAgentControlApprovalBinding({ ...shared, boundary: item.after });
    assert.notEqual(after.boundaryDigest, before.boundaryDigest, item.label);
    assert.equal(service.invalidateBinding(after).invalidated, 1, item.label);
    assert.throws(
      () => service.approve(old.approvalRequestId),
      (error) => error instanceof AgentControlApprovalError && error.code === 'APPROVAL_STALE',
      item.label,
    );
  }
});

test('approval boundary rejects unverified cost and privacy claims and canonicalizes unknown evidence', () => {
  const shared = {
    action: 'creative.apply',
    sessionId: 'session-boundary-evidence',
    projectId: 'project-local',
    canvasId: 'canvas-boundary-evidence',
    subject: { kind: 'creative-plan', action: 'create.image', creativeKind: 'image' },
    planDigest: 'a'.repeat(64),
    modelDecisionDigest: 'b'.repeat(64),
  };
  for (const boundary of [
    { costTier: { status: 'known', value: 'premium' } },
    { privacyBoundary: { status: 'known', value: 'cross-border' } },
    { costTier: { status: 'verified', value: 'premium', asOf: '2026-07-28T00:00:00.000Z' } },
    { privacyBoundary: { status: 'verified', value: 'domestic', sourceDigest: 'c'.repeat(64) } },
  ]) {
    assert.throws(
      () => createAgentControlApprovalBinding({ ...shared, boundary }),
      (error) => error instanceof AgentControlApprovalError
        && error.code === 'APPROVAL_BINDING_INVALID',
    );
  }

  const canonical = createAgentControlApprovalBinding({
    ...shared,
    boundary: {
      providerSelections: [
        { provider: 'zhenzhen', model: 'image-a', nodeIds: ['node-b', 'node-a', 'node-a'] },
      ],
      costTier: { status: 'unknown', value: 'forged-premium', message: '伪造费用结论' },
      privacyBoundary: { status: 'unknown', value: 'forged-cross-border', message: '伪造隐私结论' },
      ignored: 'not-part-of-the-contract',
    },
  });
  assert.deepEqual(canonical.boundary.providerSelections[0].nodeIds, ['node-a', 'node-b']);
  assert.deepEqual(Object.keys(canonical.boundary).sort(), ['costTier', 'privacyBoundary', 'providerSelections']);
  assert.deepEqual(Object.keys(canonical.boundary.costTier).sort(), ['message', 'status']);
  assert.deepEqual(Object.keys(canonical.boundary.privacyBoundary).sort(), ['message', 'status']);
});

test('same operation retry reuses one approval receipt while conflicting payload fails closed', () => {
  const service = createAgentControlApprovalService();
  const input = {
    action: 'creative.apply',
    operationId: 'creative-plan-idempotent-a',
    sessionId: 'session-idempotent',
    actorId: 'agent:idempotent',
    clientName: 'Codex',
    projectId: 'project-local',
    canvasId: 'canvas-idempotent',
    patchId: 'patch-idempotent',
    patch: { id: 'patch-idempotent', operations: [{ type: 'node.add' }] },
    payload: { planId: 'plan-idempotent', planDigest: 'a'.repeat(64) },
    preview: { patchId: 'patch-idempotent', previewDigest: 'b'.repeat(64), changes: [] },
  };

  const first = service.create(input);
  const retry = service.create(structuredClone(input));
  assert.equal(first.idempotent, false);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.approvalRequestId, first.approvalRequestId);
  assert.equal(retry.pollSecret, first.pollSecret);
  assert.equal(service.listPending().length, 1);
  assert.equal(JSON.stringify(service.listPending()).includes(first.pollSecret), false);

  assert.throws(
    () => service.create({
      ...structuredClone(input),
      preview: { ...input.preview, previewDigest: 'c'.repeat(64) },
    }),
    (error) => error instanceof AgentControlApprovalError
      && error.code === 'APPROVAL_IDEMPOTENCY_CONFLICT'
      && error.status === 409,
  );
  assert.equal(service.listPending().length, 1);

  service.approve(first.approvalRequestId);
  const afterRefresh = service.create(structuredClone(input));
  assert.equal(afterRefresh.approvalRequestId, first.approvalRequestId);
  assert.equal(afterRefresh.pollSecret, first.pollSecret);
  assert.equal(afterRefresh.status, 'approved');
  assert.equal(afterRefresh.idempotent, true);

  const completion = service.beginCompletion({
    approvalRequestId: afterRefresh.approvalRequestId,
    pollSecret: afterRefresh.pollSecret,
    sessionId: input.sessionId,
  });
  assert.equal(completion.status, 'approved');
  service.finishCompletion(completion.record, true);
});
