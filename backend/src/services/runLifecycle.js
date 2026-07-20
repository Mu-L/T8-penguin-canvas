const RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'stopped', 'interrupted']);
const NODE_RUN_STATUSES = new Set(['queued', 'running', 'polling', 'succeeded', 'failed', 'stopped', 'interrupted']);

const RUN_EVENT_TYPES = new Set([
  'run.queued',
  'run.running',
  'run.succeeded',
  'run.failed',
  'run.stopped',
  'run.interrupted',
  'node.queued',
  'node.started',
  'node.progress',
  'node.polling',
  'node.output',
  'node.succeeded',
  'node.failed',
  'node.stopped',
  'node.interrupted',
  'provider.request',
  'provider.submitted',
  'provider.polling',
  'provider.response',
  'provider.usage',
  'log',
]);

function normalizeStatus(value, allowed, fallback) {
  const status = String(value || fallback).trim().toLowerCase();
  if (!allowed.has(status)) throw new Error(`不支持的运行状态: ${status}`);
  return status;
}

function normalizeRunStatus(value, fallback = 'queued') {
  return normalizeStatus(value, RUN_STATUSES, fallback);
}

function normalizeNodeRunStatus(value, fallback = 'queued') {
  return normalizeStatus(value, NODE_RUN_STATUSES, fallback);
}

function runEventTypeForStatus(status) {
  return `run.${normalizeRunStatus(status)}`;
}

function nodeRunEventTypeForStatus(status) {
  const normalized = normalizeNodeRunStatus(status);
  if (normalized === 'running') return 'node.started';
  return `node.${normalized}`;
}

function normalizeRunEventType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!RUN_EVENT_TYPES.has(type)) throw new Error(`不支持的运行事件: ${type || '(empty)'}`);
  return type;
}

module.exports = {
  RUN_STATUSES,
  NODE_RUN_STATUSES,
  RUN_EVENT_TYPES,
  normalizeRunStatus,
  normalizeNodeRunStatus,
  runEventTypeForStatus,
  nodeRunEventTypeForStatus,
  normalizeRunEventType,
};
