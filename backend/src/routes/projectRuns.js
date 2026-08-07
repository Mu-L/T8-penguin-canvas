const express = require('express');
const config = require('../config');
const { getProjectDatabase } = require('../services/projectDatabase');
const {
  sendProjectDatabaseStorageCapacityError,
} = require('../services/projectDatabasePublicError');
const { getBackgroundAssetIndexer } = require('../services/assetIndexer');
const { getAssetPreviewPipeline } = require('../services/assetPreviewPipeline');
const { publicAsset, redactLocalPaths } = require('../services/assetPublicView');
const { redactAndScanRunValue } = require('../services/runRedaction');
const { normalizeRunError } = require('../services/runErrors');
const { explicitRunCost } = require('../services/runUsage');
const { getRunRecoveryManager } = require('../services/runRecovery');
const { getCollaborationGateway } = require('../collaboration/gateway');
const { ExecutionPolicyError, HostExecutionPolicy } = require('../collaboration/executionPolicy');
const {
  normalizeRunStatus,
  normalizeNodeRunStatus,
  runEventTypeForStatus,
  nodeRunEventTypeForStatus,
  normalizeRunEventType,
} = require('../services/runLifecycle');

const router = express.Router();
const TERMINAL_NODE_RUN_STATUSES = new Set(['succeeded', 'failed', 'stopped', 'interrupted']);
const HOST_AUTHORITATIVE_EVENT_TYPES = new Set([
  'run.queued', 'run.running', 'run.succeeded', 'run.failed', 'run.stopped', 'run.interrupted',
  'node.queued', 'node.started', 'node.polling', 'node.output',
  'node.succeeded', 'node.failed', 'node.stopped', 'node.interrupted',
]);

function safeCommittedNotificationLabel(value) {
  const normalized = String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return normalized || 'unknown';
}

function runCommittedNotification(label, callback) {
  try {
    callback();
    return true;
  } catch (_) {
    try {
      console.warn(
        `[project-runs] committed notification failed (${safeCommittedNotificationLabel(label)})`,
      );
    } catch (_) { /* logging is best effort too */ }
    return false;
  }
}

const database = getProjectDatabase(config);
const previewPipeline = getAssetPreviewPipeline(config, database);
const assetIndexer = getBackgroundAssetIndexer(config, database, previewPipeline);
const collaborationGateway = getCollaborationGateway(config);
const runExecutionPolicy = new HostExecutionPolicy(database);
const recoveryManager = getRunRecoveryManager({
  database,
  baseUrl: `http://127.0.0.1:${config.PORT}`,
  broadcast: {
    intent: (intent) => runCommittedNotification(
      'recovery.run-intent',
      () => collaborationGateway.broadcastHostRunIntent(intent),
    ),
    run: (run) => runCommittedNotification(
      'recovery.run',
      () => collaborationGateway.broadcastHostRunState(run),
    ),
    node: (run, nodeRun) => runCommittedNotification(
      'recovery.node',
      () => collaborationGateway.broadcastHostNodeRunState(run, nodeRun),
    ),
    output: (run, nodeRun, assets) => runCommittedNotification(
      'recovery.output',
      () => collaborationGateway.broadcastHostRunOutput(run, nodeRun, assets),
    ),
  },
  commitRunOutputArtifacts: (input) => assetIndexer.commitHostRunOutputAssets(input),
});

function requireRun(runId, res) {
  const run = database.getRun(runId);
  if (!run) res.status(404).json({ success: false, error: '运行记录不存在' });
  return run;
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '').trim().toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isLoopbackHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isTrustedHostArtifactRequest(req) {
  if (!isLoopbackRequest(req)) return false;
  const host = String(req.headers?.host || '').trim();
  if (!host) return false;
  try {
    const authority = new URL(`http://${host}`);
    if (!isLoopbackHostname(authority.hostname) || authority.username || authority.password) return false;
  } catch (_) {
    return false;
  }
  const fetchSite = String(req.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return false;
  const origin = String(req.headers?.origin || '').trim();
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username
      && !parsed.password
      && isLoopbackHostname(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function requireHostArtifactJsonMutation(req, res) {
  if (!isTrustedHostArtifactRequest(req)) {
    res.status(403).json({
      success: false,
      error: 'host artifact 提交只接受可信的主机本机回环来源',
      code: 'trusted_loopback_required',
    });
    return false;
  }
  const contentType = String(req.headers?.['content-type'] || '').trim().toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    res.status(415).json({
      success: false,
      error: 'host artifact 提交只接受 application/json',
      code: 'host_artifact_json_required',
    });
    return false;
  }
  return true;
}

function publicHostArtifactError(error) {
  const fallback = 'host artifact 提交失败';
  const message = redactLocalPaths(error?.message || String(error || fallback)) || fallback;
  const body = { success: false, error: message };
  const code = String(error?.code || '').trim().toLowerCase().replace(/-/g, '_').slice(0, 120);
  if (/^[a-z0-9_]+$/.test(code)) body.code = code;
  return body;
}

function hostArtifactErrorStatus(error) {
  const explicit = Number(error?.status);
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  return /(?:^|[_-])(?:conflict|collision)(?:$|[_-])/.test(String(error?.code || '')) ? 409 : 400;
}

function authoritativeRunEventPayload(raw, canonical) {
  const userPayload = redactAndScanRunValue(raw && typeof raw === 'object' ? raw : {});
  for (const key of [
    'nodeId', 'nodeEntityUid', 'outputRefs', 'attemptId', 'attemptEntityUid',
    'status', 'assets', 'artifactEntityUid', 'outputOrdinal',
  ]) delete userPayload[key];
  return { ...userPayload, ...canonical };
}

function normalizeRunIntentClaim(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('运行意图租约凭据格式无效');
    error.code = 'run_intent_claim_invalid';
    error.status = 400;
    throw error;
  }
  const allowedKeys = new Set(['intentId', 'expectedQueueRevision', 'leaseToken', 'leaseOwner']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    const error = new Error('运行意图租约凭据包含不支持的字段');
    error.code = 'run_intent_claim_invalid';
    error.status = 400;
    throw error;
  }
  const intentId = String(value.intentId || '').trim();
  const leaseToken = String(value.leaseToken || '').trim();
  const leaseOwner = String(value.leaseOwner || '').trim();
  const expectedQueueRevision = Number(value.expectedQueueRevision);
  if (!intentId || intentId.length > 240
    || !leaseToken || leaseToken.length > 512
    || !leaseOwner || leaseOwner.length > 240
    || !Number.isSafeInteger(expectedQueueRevision)
    || expectedQueueRevision < 1) {
    const error = new Error('运行意图租约凭据不完整或格式无效');
    error.code = 'run_intent_claim_invalid';
    error.status = 400;
    throw error;
  }
  return { intentId, expectedQueueRevision, leaseToken, leaseOwner };
}

function stripRunIntentLeaseAuthority(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => stripRunIntentLeaseAuthority(entry, seen));
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const leaseAuthorityField = normalized === 'runintentclaim'
      || ((normalized.includes('lease') || normalized.includes('runintent'))
        && (normalized.includes('token') || normalized.includes('owner')));
    if (leaseAuthorityField) continue;
    output[key] = stripRunIntentLeaseAuthority(entry, seen);
  }
  return output;
}

router.get('/', (req, res) => {
  res.json({
    success: true,
    data: database.listRuns({
      projectId: req.query.projectId,
      canvasId: req.query.canvasId,
      status: req.query.status,
      initiatorId: req.query.initiatorId,
      provider: req.query.provider,
      model: req.query.model,
      limit: req.query.limit,
    }),
  });
});

router.post('/', (req, res) => {
  try {
    const runIntentClaim = normalizeRunIntentClaim(req.body?.runIntentClaim);
    if (runIntentClaim && !isTrustedHostArtifactRequest(req)) {
      return res.status(403).json({
        success: false,
        code: 'trusted_loopback_required',
        error: '运行意图只能由可信的主机本机 Worker 认领',
      });
    }
    const summary = stripRunIntentLeaseAuthority(
      redactAndScanRunValue(req.body?.summary || {}),
    );
    const declaredIntentId = typeof summary.runIntentId === 'string' && summary.runIntentId
      ? String(summary.runIntentId)
      : null;
    if (declaredIntentId && (!runIntentClaim || declaredIntentId !== runIntentClaim.intentId)) {
      return res.status(409).json({
        success: false,
        code: 'run_intent_lease_required',
        error: '运行意图必须通过有效主机租约认领',
      });
    }
    if (runIntentClaim) summary.runIntentId = runIntentClaim.intentId;
    else delete summary.runIntentId;
    delete summary.runIntentRecovery;
    let claimedIntent = null;
    const run = database.withProjectDatabaseWrite('run.create', () => {
      let intent = runIntentClaim ? database.getRunIntent(runIntentClaim.intentId) : null;
      if (runIntentClaim) {
        const authorized = runExecutionPolicy.authorizeRunIntent(runIntentClaim.intentId, {
          allowedStatuses: ['dispatching'],
          requireUnclaimed: true,
          requireConfirmationSatisfied: true,
          reservationAlreadyCounted: true,
          enforceConcurrency: true,
        });
        intent = authorized.intent;
      }
      const created = database.createRun({
        id: req.body?.id,
        entityUid: req.body?.entityUid,
        projectId: req.body?.projectId,
        canvasId: req.body?.canvasId,
        canvasRevision: req.body?.canvasRevision,
        initiatorId: req.body?.initiatorId,
        parentRunId: req.body?.parentRunId,
        startedAt: req.body?.startedAt,
        finishedAt: req.body?.finishedAt,
        ...(intent ? {
          projectId: intent.projectId,
          canvasId: intent.canvasId,
          canvasRevision: intent.canvasRevision,
          initiatorId: intent.requestedBy,
        } : {}),
        status: 'queued',
        summary,
      });
      if (intent) {
        claimedIntent = database.claimRunIntent(intent.id, created, {
          expectedQueueRevision: runIntentClaim.expectedQueueRevision,
          leaseOwner: runIntentClaim.leaseOwner,
          leaseToken: runIntentClaim.leaseToken,
          actorId: 'local-owner',
          sessionId: 'local-run-worker',
        });
      }
      database.appendRunEvent(created.id, { type: 'run.queued', payload: { status: 'queued' } });
      database.appendAuditEvent({
        projectId: created.projectId,
        canvasId: created.canvasId,
        actorId: 'local-owner',
        sessionId: 'local-run-worker',
        action: 'run.queued',
        targetType: 'run',
        targetId: created.id,
        metadata: {
          runEntityUid: created.entityUid,
          canvasRevision: created.canvasRevision,
          runIntentEntityUid: claimedIntent?.entityUid || null,
        },
      });
      return created;
    });
    runCommittedNotification('run.created', () => {
      collaborationGateway.broadcastHostRunState(run);
    });
    if (claimedIntent) {
      runCommittedNotification('run-intent.claimed', () => {
        collaborationGateway.broadcastHostRunIntent(claimedIntent);
      });
    }
    res.status(201).json({ success: true, data: run });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.create' })) return;
    if (error instanceof ExecutionPolicyError) {
      return res.status(error.httpStatus || 429).json({ success: false, code: error.code, error: error.message, data: error.details });
    }
    res.status(Number(error?.status) || 400).json({
      success: false,
      ...(error?.code ? { code: error.code } : {}),
      error: error?.message || String(error),
    });
  }
});

router.get('/retention', (req, res) => {
  res.json({
    success: true,
    data: database.getRunRetentionPolicy(req.query.projectId),
  });
});

router.put('/retention', (req, res) => {
  try {
    const policy = database.setRunRetentionPolicy(req.body?.projectId, req.body || {});
    res.json({ success: true, data: policy });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.retention-policy' })) return;
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/retention/prune', (req, res) => {
  try {
    const result = database.pruneRuns(req.body?.projectId);
    res.json({ success: true, data: result });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.retention-prune' })) return;
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/recovery', (_req, res) => {
  res.json({
    success: true,
    data: {
      startup: database.lastInterruptedRecovery,
      manager: recoveryManager.status(),
      pending: database.listPendingRunRecoveries().length,
    },
  });
});

router.post('/recover-interrupted', async (_req, res) => {
  try {
    const prepared = database.recoverInterruptedRuns();
    const recovered = await recoveryManager.recoverPendingRuns();
    res.json({ success: true, data: { prepared, recovered } });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.recover-interrupted' })) return;
    res.status(500).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/:runId', (req, res) => {
  const run = requireRun(req.params.runId, res);
  if (!run) return;
  const nodeRuns = database.listNodeRuns(run.id).map((nodeRun) => ({
    ...nodeRun,
    attempts: database.listAttempts(nodeRun.id),
  }));
  res.json({ success: true, data: { ...run, nodeRuns } });
});

router.patch('/:runId', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  try {
    const requestedStatus = req.body?.status === undefined ? undefined : normalizeRunStatus(req.body.status);
    const summary = redactAndScanRunValue(req.body?.summary || {});
    const result = database.withProjectDatabaseWrite('run.update', () => {
      const current = database.getRun(req.params.runId);
      if (!current) throw new Error('运行记录不存在');
      const run = database.updateRun(current.id, {
        status: requestedStatus,
        startedAt: req.body?.startedAt,
        finishedAt: req.body?.finishedAt,
        summary,
      });
      if (requestedStatus) {
        database.appendRunEvent(run.id, {
          type: runEventTypeForStatus(requestedStatus),
          payload: { status: requestedStatus },
        });
        database.appendAuditEvent({
          projectId: run.projectId,
          canvasId: run.canvasId,
          actorId: 'local-owner',
          sessionId: 'local-run-worker',
          action: `run.${requestedStatus}`,
          targetType: 'run',
          targetId: run.id,
          metadata: {
            runEntityUid: run.entityUid,
            revision: run.revision,
            previousStatus: current.status,
            status: requestedStatus,
          },
        });
      }
      const completedIntent = requestedStatus && ['succeeded', 'failed', 'stopped', 'interrupted'].includes(requestedStatus)
        ? database.finishRunIntentForRun(
            run.id,
            requestedStatus,
            explicitRunCost(database.listRunAttempts(run.id)),
          )
        : null;
      return { run, completedIntent };
    });
    runCommittedNotification('run.updated', () => {
      collaborationGateway.broadcastHostRunState(result.run);
    });
    if (result.completedIntent) {
      runCommittedNotification('run-intent.completed', () => {
        collaborationGateway.broadcastHostRunIntent(result.completedIntent);
      });
    }
    res.json({ success: true, data: result.run });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.update' })) return;
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.get('/:runId/events', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  res.json({ success: true, data: database.getRunEvents(req.params.runId, req.query.afterId) });
});

router.post('/:runId/events', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  try {
    const type = normalizeRunEventType(req.body?.type);
    if (HOST_AUTHORITATIVE_EVENT_TYPES.has(type)) {
      return res.status(409).json({
        success: false,
        error: '该 RunEvent 只能由对应的主机权威状态事务写入',
        code: 'run_event_authority_required',
      });
    }
    if (req.body?.nodeRunId) {
      const nodeRun = database.getNodeRun(req.body.nodeRunId);
      if (!nodeRun || nodeRun.runId !== req.params.runId) throw new Error('RunEvent NodeRun 不属于当前 Run');
    }
    const event = database.appendRunEvent(req.params.runId, {
      nodeRunId: req.body?.nodeRunId,
      type,
      payload: redactAndScanRunValue(req.body?.payload || {}),
      createdAt: req.body?.createdAt,
    });
    res.status(201).json({ success: true, data: event });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.event-create' })) return;
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/:runId/nodes', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'outputRefs')) {
    return res.status(409).json({
      success: false,
      error: 'NodeRun outputRefs 只能由 host artifact 权威提交写入',
      code: 'host_artifact_authority_required',
    });
  }
  try {
    const result = database.withProjectDatabaseWrite('run.node-create', () => {
      const run = database.getRun(req.params.runId);
      if (!run) throw new Error('运行记录不存在');
      if (req.body?.parentNodeRunId) {
        const parent = database.getNodeRun(req.body.parentNodeRunId);
        if (!parent || parent.runId !== run.id) throw new Error('父节点运行记录不属于当前 Run');
      }
      const nodeRun = database.createNodeRun({
        ...req.body,
        runId: run.id,
        status: 'queued',
        inputSnapshot: redactAndScanRunValue(req.body?.inputSnapshot || {}),
      });
      database.appendRunEvent(run.id, {
        nodeRunId: nodeRun.id,
        type: 'node.queued',
        payload: { nodeId: nodeRun.nodeId },
      });
      return { run, nodeRun };
    });
    runCommittedNotification('run.node-created', () => {
      collaborationGateway.broadcastHostNodeRunState(result.run, result.nodeRun);
    });
    res.status(201).json({ success: true, data: result.nodeRun });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.node-create' })) return;
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.patch('/:runId/nodes/:nodeRunId', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  const initial = database.getNodeRun(req.params.nodeRunId);
  if (!initial || initial.runId !== req.params.runId) return res.status(404).json({ success: false, error: '节点运行记录不存在' });
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'outputRefs')) {
    return res.status(409).json({
      success: false,
      error: 'NodeRun outputRefs 只能由 host artifact 权威提交写入',
      code: 'host_artifact_authority_required',
    });
  }
  try {
    const requestedStatus = req.body?.status === undefined ? undefined : normalizeNodeRunStatus(req.body.status);
    const result = database.withProjectDatabaseWrite('run.node-update', () => {
      const run = database.getRun(req.params.runId);
      if (!run) throw new Error('运行记录不存在');
      const latest = database.getNodeRun(req.params.nodeRunId);
      if (!latest || latest.runId !== run.id) throw new Error('节点运行记录不属于当前 Run');
      const nodeRun = database.updateNodeRun(latest.id, {
        status: requestedStatus,
      });
      const eventType = requestedStatus ? nodeRunEventTypeForStatus(requestedStatus) : null;
      if (eventType) {
        database.appendRunEvent(run.id, {
          nodeRunId: nodeRun.id,
          type: eventType,
          payload: authoritativeRunEventPayload(req.body?.eventPayload, {
            nodeId: nodeRun.nodeId,
            outputRefs: nodeRun.outputRefs,
            status: nodeRun.status,
          }),
        });
      }
      return { run, nodeRun };
    });
    runCommittedNotification('run.node-updated', () => {
      collaborationGateway.broadcastHostNodeRunState(result.run, result.nodeRun);
    });
    res.json({ success: true, data: result.nodeRun });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.node-update' })) return;
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.post('/:runId/nodes/:nodeRunId/attempts', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  const initialNodeRun = database.getNodeRun(req.params.nodeRunId);
  if (!initialNodeRun || initialNodeRun.runId !== req.params.runId) return res.status(404).json({ success: false, error: '节点运行记录不存在' });
  try {
    const result = database.withProjectDatabaseWrite('run.attempt-create', () => {
      const run = database.getRun(req.params.runId);
      if (!run) throw new Error('运行记录不存在');
      const nodeRun = database.getNodeRun(req.params.nodeRunId);
      if (!nodeRun || nodeRun.runId !== run.id) throw new Error('节点运行记录不属于当前 Run');
      const incomingMetadata = redactAndScanRunValue(req.body?.metadata || {});
      const submissionKey = String(incomingMetadata?.providerSubmission?.submissionKey || '').trim();
      if (incomingMetadata.approvalTask && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(submissionKey)) {
        const existing = database.findProviderSubmissionAttempt({
          projectId: run.projectId,
          canvasId: run.canvasId,
          nodeEntityUid: nodeRun.nodeEntityUid,
          originalNodeId: nodeRun.originalNodeId,
          nodeId: nodeRun.nodeId,
          submissionKey,
        });
        if (existing) {
          const sameScope = String(existing.provider || '') === String(req.body?.provider || '')
            && String(existing.model || '') === String(req.body?.model || '')
            && String(existing.metadata?.jobId || '') === String(incomingMetadata.jobId || '')
            && String(existing.metadata?.jobKind || '') === String(incomingMetadata.jobKind || '')
            && JSON.stringify(existing.metadata?.approvalTask || null) === JSON.stringify(incomingMetadata.approvalTask || null);
          if (!sameScope) {
            const error = new Error('Provider submissionKey 已被另一项请求占用');
            error.code = 'provider_submission_key_collision';
            throw error;
          }
          if (existing.upstreamTaskId) {
            return {
              attempt: database.createAttempt({
                ...req.body,
                nodeRunId: nodeRun.id,
                provider: existing.provider,
                model: existing.model,
                upstreamTaskId: existing.upstreamTaskId,
                requestId: existing.requestId,
                status: 'polling',
                usage: redactAndScanRunValue(req.body?.usage || {}),
                metadata: {
                  ...incomingMetadata,
                  recoveredFromAttemptId: existing.id,
                  mvRecovery: existing.metadata?.mvRecovery || null,
                  providerSubmission: {
                    ...incomingMetadata.providerSubmission,
                    state: 'submitted',
                    recoveredAt: Date.now(),
                  },
                },
                error: null,
              }),
              reusedSubmission: true,
            };
          }
          return { attempt: existing, reusedSubmission: true };
        }
      }
      return { attempt: database.createAttempt({
        ...req.body,
        nodeRunId: nodeRun.id,
        status: normalizeNodeRunStatus(req.body?.status, 'queued'),
        usage: redactAndScanRunValue(req.body?.usage || {}),
        metadata: incomingMetadata,
        error: req.body?.error ? normalizeRunError(redactAndScanRunValue(req.body.error)) : null,
      }), reusedSubmission: false };
    });
    res.status(result.reusedSubmission ? 200 : 201).json({ success: true, data: result.attempt, reusedSubmission: result.reusedSubmission });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.attempt-create' })) return;
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.patch('/:runId/nodes/:nodeRunId/attempts/:attemptId', (req, res) => {
  if (!requireRun(req.params.runId, res)) return;
  const initialNodeRun = database.getNodeRun(req.params.nodeRunId);
  if (!initialNodeRun || initialNodeRun.runId !== req.params.runId) return res.status(404).json({ success: false, error: '节点运行记录不存在' });
  const initialAttempt = database.getAttempt(req.params.attemptId);
  if (!initialAttempt || initialAttempt.nodeRunId !== req.params.nodeRunId) return res.status(404).json({ success: false, error: '尝试记录不存在' });
  try {
    const attempt = database.withProjectDatabaseWrite('run.attempt-update', () => {
      const run = database.getRun(req.params.runId);
      if (!run) throw new Error('运行记录不存在');
      const nodeRun = database.getNodeRun(req.params.nodeRunId);
      if (!nodeRun || nodeRun.runId !== run.id) throw new Error('节点运行记录不属于当前 Run');
      const currentAttempt = database.getAttempt(req.params.attemptId);
      if (!currentAttempt || currentAttempt.nodeRunId !== nodeRun.id) {
        throw new Error('Attempt 不属于当前 Run/NodeRun');
      }
      return database.updateAttempt(currentAttempt.id, {
        ...req.body,
        status: req.body?.status === undefined ? undefined : normalizeNodeRunStatus(req.body.status),
        usage: req.body?.usage === undefined ? undefined : redactAndScanRunValue(req.body.usage),
        metadata: req.body?.metadata === undefined ? undefined : redactAndScanRunValue(req.body.metadata),
        error: req.body?.error === undefined ? undefined : normalizeRunError(redactAndScanRunValue(req.body.error)),
      }, { runId: run.id, nodeRunId: nodeRun.id });
    });
    res.json({
      success: true,
      data: attempt,
    });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.attempt-update' })) return;
    res.status(400).json({ success: false, error: error?.message || String(error) });
  }
});

router.patch('/:runId/nodes/:nodeRunId/attempts/:attemptId/terminal', (req, res) => {
  try {
    const requestedStatus = normalizeNodeRunStatus(req.body?.status);
    if (!TERMINAL_NODE_RUN_STATUSES.has(requestedStatus)) {
      throw new Error(`节点终态不受支持: ${requestedStatus}`);
    }
    const normalizedError = req.body?.error == null
      ? null
      : normalizeRunError(redactAndScanRunValue(req.body.error));
    const timestamps = redactAndScanRunValue(req.body?.timestamps || {});
    const eventPayload = req.body?.eventPayload && typeof req.body.eventPayload === 'object'
      ? req.body.eventPayload
      : {};
    const result = database.withProjectDatabaseWrite('run.attempt-terminal', () => {
      const run = database.getRun(req.params.runId);
      if (!run) throw new Error('运行记录不存在');
      const currentNodeRun = database.getNodeRun(req.params.nodeRunId);
      if (!currentNodeRun || currentNodeRun.runId !== run.id) {
        throw new Error('节点运行记录不属于当前 Run');
      }
      const currentAttempt = database.getAttempt(req.params.attemptId);
      if (!currentAttempt || currentAttempt.nodeRunId !== currentNodeRun.id) {
        throw new Error('Attempt 不属于当前 Run/NodeRun');
      }
      const providerSubmission = currentAttempt.metadata?.providerSubmission;
      if (requestedStatus === 'succeeded'
        && providerSubmission
        && providerSubmission.expectedOutput === true) {
        if (providerSubmission.state !== 'verified') {
          throw Object.assign(
            new Error('Provider 结果尚未完成下载、校验与资产持久化，不能标记为成功'),
            { code: 'provider_submission_not_verified', status: 409 },
          );
        }
        if (!Array.isArray(currentNodeRun.outputRefs) || currentNodeRun.outputRefs.length < 1) {
          throw Object.assign(
            new Error('Provider 结果尚未关联到当前 NodeRun，不能标记为成功'),
            { code: 'provider_submission_output_missing', status: 409 },
          );
        }
      }
      const attempt = database.updateAttempt(currentAttempt.id, {
        status: requestedStatus,
        timestamps,
        error: normalizedError,
      }, { runId: run.id, nodeRunId: currentNodeRun.id });
      const nodeRun = database.updateNodeRun(currentNodeRun.id, { status: requestedStatus });
      const event = database.appendRunEvent(run.id, {
        nodeRunId: nodeRun.id,
        type: nodeRunEventTypeForStatus(requestedStatus),
        payload: authoritativeRunEventPayload(eventPayload, {
          nodeId: nodeRun.nodeId,
          attemptId: attempt.id,
          status: requestedStatus,
          outputRefs: nodeRun.outputRefs,
        }),
      });
      return { run, nodeRun, attempt, event };
    });
    runCommittedNotification('run.attempt-terminal', () => {
      collaborationGateway.broadcastHostNodeRunState(result.run, result.nodeRun);
    });
    res.json({
      success: true,
      data: { nodeRun: result.nodeRun, attempt: result.attempt, event: result.event },
    });
  } catch (error) {
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.attempt-terminal' })) return;
    res.status(Number(error?.status) || 400).json({
      success: false,
      ...(error?.code ? { code: error.code } : {}),
      error: error?.message || String(error),
    });
  }
});

router.post('/:runId/nodes/:nodeRunId/outputs', async (req, res) => {
  if (!requireHostArtifactJsonMutation(req, res)) return;
  const run = requireRun(req.params.runId, res);
  if (!run) return;
  const nodeRun = database.getNodeRun(req.params.nodeRunId);
  if (!nodeRun || nodeRun.runId !== run.id) return res.status(404).json({ success: false, error: '节点运行记录不存在' });
  const persistenceAbort = new AbortController();
  const abortPersistence = () => {
    if (!persistenceAbort.signal.aborted) persistenceAbort.abort(new Error('host output client disconnected'));
  };
  const abortOnResponseClose = () => {
    if (!res.writableEnded) abortPersistence();
  };
  req.once('aborted', abortPersistence);
  res.once('close', abortOnResponseClose);
  try {
    const outputs = Array.isArray(req.body?.outputs)
      ? req.body.outputs.map((item, index) => ({
        sourceUrl: typeof item?.sourceUrl === 'string' ? item.sourceUrl : '',
        ...(typeof item?.text === 'string' ? { text: item.text } : {}),
        kind: typeof item?.kind === 'string' ? item.kind : '',
        filename: typeof item?.filename === 'string' ? item.filename : '',
        mimeType: typeof item?.mimeType === 'string' ? item.mimeType : '',
        outputOrdinal: item?.outputOrdinal == null ? index : item.outputOrdinal,
      }))
      : [];
    const result = await assetIndexer.commitHostRunOutputAssets({
      runId: run.id,
      nodeRunId: nodeRun.id,
      attemptId: typeof req.body?.attemptId === 'string' ? req.body.attemptId : '',
      outputs,
      signal: persistenceAbort.signal,
    });
    if (!result.duplicate) {
      runCommittedNotification('run.output.node', () => {
        collaborationGateway.broadcastHostNodeRunState(result.run, result.nodeRun);
      });
      runCommittedNotification('run.output.assets', () => {
        collaborationGateway.broadcastHostRunOutput(result.run, result.nodeRun, result.assets);
      });
    }
    res.status(result.duplicate ? 200 : 201).json({
      success: true,
      data: {
        duplicate: Boolean(result.duplicate),
        nodeRun: result.nodeRun,
        assets: result.assets.map(publicAsset),
      },
    });
  } catch (error) {
    if (persistenceAbort.signal.aborted || req.aborted || res.destroyed) return;
    if (sendProjectDatabaseStorageCapacityError(res, error, { operation: 'run.output-commit' })) return;
    res.status(hostArtifactErrorStatus(error)).json(publicHostArtifactError(error));
  } finally {
    req.removeListener('aborted', abortPersistence);
    res.removeListener('close', abortOnResponseClose);
  }
});

module.exports = router;
