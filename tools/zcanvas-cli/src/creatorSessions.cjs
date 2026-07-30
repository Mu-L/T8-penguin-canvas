'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CREATOR_SESSION_SCHEMA = 't8-zcanvas-creator-sessions-v1';
const CREATOR_SESSION_AUTHORITY_SCHEMA = 't8-zcanvas-creator-session-authority-v1';
const CREATOR_SESSION_LIMIT = 512 * 1024;
const CREATOR_SESSION_COUNT = 64;

class CreatorSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CreatorSessionError';
    this.code = code;
  }
}

function creatorSessionPath(options = {}) {
  const explicit = String(options.env?.ZCANVAS_CREATOR_SESSION_STORE || process.env.ZCANVAS_CREATOR_SESSION_STORE || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(options.homeDir || os.homedir(), '.zcanvas', 'creator-sessions-v1.json');
}

function emptyStore() {
  return { schema: CREATOR_SESSION_SCHEMA, sessions: [] };
}

function readCreatorSessions(options = {}) {
  const filePath = creatorSessionPath(options);
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CREATOR_SESSION_LIMIT) {
      throw new CreatorSessionError('CREATOR_SESSION_STORE_INVALID', '创作会话存储无效');
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed?.schema !== CREATOR_SESSION_SCHEMA || !Array.isArray(parsed.sessions)) {
      throw new CreatorSessionError('CREATOR_SESSION_STORE_INVALID', '创作会话存储格式不兼容');
    }
    return {
      schema: CREATOR_SESSION_SCHEMA,
      sessions: parsed.sessions.filter((item) => item && typeof item === 'object').slice(0, CREATOR_SESSION_COUNT),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    if (error instanceof CreatorSessionError) throw error;
    throw new CreatorSessionError('CREATOR_SESSION_STORE_INVALID', '无法读取创作会话存储');
  }
}

function writeCreatorSessions(store, options = {}) {
  const filePath = creatorSessionPath(options);
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(store)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > CREATOR_SESSION_LIMIT) {
    throw new CreatorSessionError('CREATOR_SESSION_STORE_FULL', '创作会话存储超过安全限制');
  }
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch (_) {}
  }
}

function validateSessionInput(input = {}) {
  const instanceId = String(input.instanceId || '').trim();
  const projectId = String(input.projectId || '').trim();
  const canvasId = String(input.canvasId || '').trim();
  const prompt = String(input.prompt || '').trim();
  if (!instanceId || !projectId || !canvasId || !prompt || prompt.length > 40_000) {
    throw new CreatorSessionError('CREATOR_SESSION_INVALID', '创作会话缺少实例、画布或有效创作要求');
  }
  return { instanceId, projectId, canvasId, prompt };
}

function compactAuthorityEvent(event = {}) {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload
    : {};
  return {
    sequence: Math.max(0, Math.trunc(Number(event.sequence) || 0)),
    type: String(event.type || '').slice(0, 80),
    createdAt: String(event.createdAt || '').slice(0, 80),
    planId: String(payload.planId || '').slice(0, 160),
    planDigest: String(payload.planDigest || '').slice(0, 160),
    patchId: String(payload.patchId || '').slice(0, 160),
    runId: String(payload.runId || '').slice(0, 160),
    approvalRequestId: String(payload.approvalRequestId || '').slice(0, 160),
    status: String(payload.status || '').slice(0, 40),
    verified: payload.verified === true || payload.verification?.verified === true,
    valid: payload.valid === true,
  };
}

function authoritativeLifecycleState(events = [], planId = '') {
  let state = '';
  for (const event of events) {
    if (!['plan.previewed', 'plan.applied', 'plan.reverted', 'plan.failed'].includes(event.type)) continue;
    if (planId && event.planId && event.planId !== planId) continue;
    state = event.type.slice('plan.'.length);
  }
  return state;
}

function cloneAuthorityValue(value, fallback) {
  try {
    return value == null ? fallback : JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function creatorSessionAuthority(remote = {}) {
  const latestPlan = remote.latestPlan && typeof remote.latestPlan === 'object'
    && !Array.isArray(remote.latestPlan) ? remote.latestPlan : null;
  const planId = String(latestPlan?.planId || '').slice(0, 160);
  const lifecycleEvents = (Array.isArray(remote.events) ? remote.events : [])
    .filter((event) => [
      'plan.previewed',
      'plan.applied',
      'plan.reverted',
      'plan.failed',
      'artifact.sent-to-canvas',
      'run.linked',
      'run.artifacts-verified',
      'delivery.approval-requested',
      'delivery.completed',
      'delivery.denied',
      'delivery.failed',
    ].includes(String(event?.type || '')))
    .slice(-32)
    .map(compactAuthorityEvent);
  const production = remote.production && typeof remote.production === 'object'
    && !Array.isArray(remote.production)
    ? cloneAuthorityValue(remote.production, null)
    : null;
  const eventLifecycleState = authoritativeLifecycleState(lifecycleEvents, planId);
  const checkpointType = String(production?.checkpoint?.type || '');
  const checkpointPlanId = String(production?.checkpoint?.planId || '');
  const lifecycleState = eventLifecycleState || (
    ['plan.applied', 'plan.reverted', 'plan.failed'].includes(checkpointType)
      && (!planId || !checkpointPlanId || checkpointPlanId === planId)
      ? checkpointType.slice('plan.'.length) : ''
  );
  const runLinks = (Array.isArray(remote.runLinks) ? remote.runLinks : []).slice(-24).map((item) => ({
    planId: String(item?.planId || '').slice(0, 160),
    patchId: String(item?.patchId || '').slice(0, 160),
    runId: String(item?.runId || '').slice(0, 160),
    runIntentId: String(item?.runIntentId || '').slice(0, 160),
    matchedNodeIds: (Array.isArray(item?.matchedNodeIds) ? item.matchedNodeIds : [])
      .map((value) => String(value || '').slice(0, 160))
      .filter(Boolean)
      .slice(0, 64),
  }));
  const artifactVerifications = (Array.isArray(remote.artifactVerifications)
    ? remote.artifactVerifications : []).slice(-24).map((item) => ({
    runId: String(item?.runId || '').slice(0, 160),
    verified: item?.verified === true,
    verificationDigest: String(item?.verificationDigest || '').slice(0, 160),
    assetIds: (Array.isArray(item?.assets) ? item.assets : [])
      .map((asset) => String(asset?.assetId || '').slice(0, 160))
      .filter(Boolean)
      .slice(0, 100),
  }));
  const assetLineage = cloneAuthorityValue(
    (Array.isArray(remote.context?.assetLineage) ? remote.context.assetLineage : []).slice(-24),
    [],
  );
  const deliveryEvidence = (Array.isArray(remote.deliveryEvidence)
    ? remote.deliveryEvidence : []).slice(-24).map((item) => ({
    approvalRequestId: String(item?.approvalRequestId || '').slice(0, 160),
    planId: String(item?.planId || '').slice(0, 160),
    status: String(item?.status || '').slice(0, 40),
    valid: item?.valid === true,
    packageDigest: String(item?.packageDigest || '').slice(0, 160),
  }));
  const authority = {
    schema: CREATOR_SESSION_AUTHORITY_SCHEMA,
    source: 'canvas-creator-session',
    lastSequence: Math.max(0, Math.trunc(Number(remote.lastSequence) || 0)),
    remoteUpdatedAt: String(remote.updatedAt || '').slice(0, 80),
    status: String(remote.status || 'active').slice(0, 40),
    phase: String(production?.currentPhase || remote.phase || 'idea').slice(0, 80),
    planId,
    planDigest: String(latestPlan?.planDigest || '').slice(0, 160),
    lifecycleState,
    approval: {
      status: lifecycleState === 'previewed'
        ? 'previewed'
        : String(remote.status || '') === 'awaiting-approval' ? 'awaiting-approval'
          : lifecycleState || 'none',
      decisionEvidence: lifecycleEvents.filter((event) => (
        event.type.startsWith('plan.') || event.type.startsWith('delivery.')
      )),
      transferable: false,
    },
    production,
    assetLineage,
    runLinks,
    artifactVerifications,
    deliveryEvidence,
    lifecycleEvents,
  };
  authority.snapshotDigest = crypto.createHash('sha256')
    .update(JSON.stringify(authority))
    .digest('hex');
  return authority;
}

function mergeCreatorSessionAuthority(checkpoint = {}, remote = {}) {
  if (!checkpoint || typeof checkpoint !== 'object' || !remote || typeof remote !== 'object') {
    throw new CreatorSessionError('CREATOR_SESSION_AUTHORITY_INVALID', '画布返回的创作会话无效');
  }
  if (String(remote.id || '') !== String(checkpoint.id || '')
    || String(remote.projectId || '') !== String(checkpoint.projectId || '')
    || String(remote.canvasId || '') !== String(checkpoint.canvasId || '')) {
    throw new CreatorSessionError('CREATOR_SESSION_AUTHORITY_MISMATCH', '本机会话与画布权威会话不一致，已停止继续');
  }
  const authority = creatorSessionAuthority(remote);
  const latestPlan = remote.latestPlan && typeof remote.latestPlan === 'object'
    && !Array.isArray(remote.latestPlan) ? remote.latestPlan : null;
  const authoritativePrompt = String(latestPlan?.brief?.goal || '').trim();
  const status = authority.lifecycleState === 'applied'
    ? 'applied'
    : authority.lifecycleState === 'reverted'
      ? (latestPlan?.ready ? 'planned' : 'active')
      : String(remote.status || checkpoint.status || 'active');
  return {
    ...checkpoint,
    prompt: authoritativePrompt || checkpoint.prompt,
    kind: String(latestPlan?.kind || checkpoint.kind || 'image'),
    profile: String(latestPlan?.profile || checkpoint.profile || 'balanced'),
    request: {
      ...(checkpoint.request && typeof checkpoint.request === 'object' ? checkpoint.request : {}),
      ...(authoritativePrompt ? { prompt: authoritativePrompt } : {}),
      ...(latestPlan?.kind ? { kind: latestPlan.kind } : {}),
    },
    planId: String(latestPlan?.planId || checkpoint.planId || ''),
    planDigest: String(latestPlan?.planDigest || checkpoint.planDigest || ''),
    planExpiresAt: String(latestPlan?.expiresAt || checkpoint.planExpiresAt || ''),
    status,
    linkedNodeId: String(latestPlan?.targets?.primaryNodeId || checkpoint.linkedNodeId || ''),
    storyNodeId: String(latestPlan?.targets?.storyNodeId || checkpoint.storyNodeId || ''),
    authority,
  };
}

function saveCreatorSession(input = {}, options = {}) {
  const validated = validateSessionInput(input);
  const store = readCreatorSessions(options);
  const now = new Date().toISOString();
  const requestedId = String(input.sessionId || input.id || '').trim();
  const id = requestedId || `cs_${crypto.randomBytes(18).toString('base64url')}`;
  const existing = store.sessions.find((item) => item.id === id);
  const session = {
    ...(existing || {}),
    id,
    schema: 't8-zcanvas-creator-session-v1',
    ...validated,
    kind: String(input.kind || existing?.kind || 'image'),
    profile: String(input.profile || existing?.profile || 'balanced'),
    request: input.request && typeof input.request === 'object' ? input.request : existing?.request || {},
    planId: String(input.planId || ''),
    planDigest: String(input.planDigest || ''),
    planExpiresAt: String(input.planExpiresAt || ''),
    status: String(input.status || existing?.status || 'planned'),
    linkedNodeId: String(input.linkedNodeId || existing?.linkedNodeId || ''),
    storyNodeId: String(input.storyNodeId || existing?.storyNodeId || ''),
    lastDirection: String(input.lastDirection ?? existing?.lastDirection ?? '').slice(0, 12_000),
    incrementalPlan: input.incrementalPlan && typeof input.incrementalPlan === 'object'
      ? input.incrementalPlan
      : existing?.incrementalPlan || null,
    authority: input.authority?.schema === CREATOR_SESSION_AUTHORITY_SCHEMA
      ? input.authority
      : existing?.authority || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  store.sessions = [session, ...store.sessions.filter((item) => item.id !== id)]
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, CREATOR_SESSION_COUNT);
  writeCreatorSessions(store, options);
  return { ...session };
}

function getCreatorSession(id = '', options = {}) {
  const sessions = readCreatorSessions(options).sessions;
  const requested = String(id || '').trim();
  const session = requested ? sessions.find((item) => item.id === requested) : sessions[0];
  return session ? { ...session } : null;
}

function listCreatorSessions(options = {}) {
  return readCreatorSessions(options).sessions.map((session) => ({
    id: session.id,
    kind: session.kind,
    status: session.status,
    projectId: session.projectId,
    canvasId: session.canvasId,
    title: String(session.request?.title || session.prompt || '').slice(0, 120),
    linkedNodeId: session.linkedNodeId || '',
    storyNodeId: session.storyNodeId || '',
    authoritativeStatus: session.authority?.status || '',
    phase: session.authority?.phase || '',
    authorityCursor: Math.max(0, Number(session.authority?.lastSequence) || 0),
    authorityUpdatedAt: session.authority?.remoteUpdatedAt || '',
    updatedAt: session.updatedAt,
  }));
}

module.exports = {
  CREATOR_SESSION_COUNT,
  CREATOR_SESSION_LIMIT,
  CREATOR_SESSION_SCHEMA,
  CREATOR_SESSION_AUTHORITY_SCHEMA,
  CreatorSessionError,
  creatorSessionPath,
  creatorSessionAuthority,
  getCreatorSession,
  listCreatorSessions,
  mergeCreatorSessionAuthority,
  readCreatorSessions,
  saveCreatorSession,
  writeCreatorSessions,
};
