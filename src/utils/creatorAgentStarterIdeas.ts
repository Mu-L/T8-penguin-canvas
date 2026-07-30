import starterCatalogJson from '../../backend/src/shared/creatorAgentStarterCatalog.json' with { type: 'json' };

export type CreatorAgentStarterMode =
  | 'blank-new'
  | 'attachment-ready'
  | 'selection-ready'
  | 'canvas-explicit'
  | 'recoverable-failure'
  | 'resumed-session';

export interface CreatorAgentStarterIdea {
  id: string;
  batch: number;
  label: string;
  description: string;
  starterPrompt: string;
  intent: string;
  taskFamily: string;
  creatorKind: string;
  expectedFirstArtifact: string;
  requiredCapabilityIds: string[];
}

export interface CreatorAgentStarterIdeaContext {
  canvasRevision?: number | null;
  nodeCount?: number;
  edgeCount?: number;
  selectedNodeTypes?: readonly string[];
  referencedNodeTypes?: readonly string[];
  attachmentKinds?: readonly string[];
  failedRunCount?: number;
  offscreenFailedCount?: number;
  allowCanvasContext?: boolean;
  allowFailureContext?: boolean;
  resumedSession?: boolean;
}

interface CreatorAgentStarterCatalog {
  schema: string;
  rotationCount: number;
  modes: Record<CreatorAgentStarterMode, CreatorAgentStarterIdea[]>;
}

const starterCatalog = starterCatalogJson as CreatorAgentStarterCatalog;

if (starterCatalog.schema !== 't8-creator-agent-starter-catalog-v2') {
  throw new Error('Creator Agent starter catalog schema mismatch');
}

export const CREATOR_AGENT_STARTER_IDEA_BATCH_COUNT = Math.max(
  1,
  Number(starterCatalog.rotationCount) || 1,
);

function stableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function boundedCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(9999, Math.trunc(parsed)))
    : 0;
}

function normalizedTypes(value: readonly string[] | undefined) {
  return [...new Set((value || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))]
    .sort()
    .slice(0, 16);
}

export function creatorAgentStarterMode(
  input: CreatorAgentStarterIdeaContext,
): CreatorAgentStarterMode {
  if (input.resumedSession) return 'resumed-session';
  if (normalizedTypes(input.referencedNodeTypes).length > 0) return 'selection-ready';
  if (normalizedTypes(input.attachmentKinds).length > 0) return 'attachment-ready';
  if (normalizedTypes(input.selectedNodeTypes).length > 0) return 'selection-ready';
  if (
    input.allowFailureContext
    && (
      boundedCount(input.failedRunCount) > 0
      || boundedCount(input.offscreenFailedCount) > 0
    )
  ) {
    return 'recoverable-failure';
  }
  if (input.allowCanvasContext && boundedCount(input.nodeCount) > 0) {
    return 'canvas-explicit';
  }
  return 'blank-new';
}

export function creatorAgentStarterIdeaContextKey(
  input: CreatorAgentStarterIdeaContext,
) {
  const mode = creatorAgentStarterMode(input);
  const safeSummary = {
    schema: 't8-creator-starter-context-v2',
    mode,
    canvasRevision: input.canvasRevision == null
      ? null
      : boundedCount(input.canvasRevision),
    nodeCount: boundedCount(input.nodeCount),
    edgeCount: boundedCount(input.edgeCount),
    selectedNodeTypes: normalizedTypes(input.selectedNodeTypes),
    referencedNodeTypes: normalizedTypes(input.referencedNodeTypes),
    attachmentKinds: normalizedTypes(input.attachmentKinds),
    failedRunCount: boundedCount(input.failedRunCount),
    offscreenFailedCount: boundedCount(input.offscreenFailedCount),
    allowCanvasContext: Boolean(input.allowCanvasContext),
    allowFailureContext: Boolean(input.allowFailureContext),
    resumedSession: Boolean(input.resumedSession),
  };
  return stableHash(JSON.stringify(safeSummary));
}

function catalogIdeasForMode(mode: CreatorAgentStarterMode) {
  return (starterCatalog.modes[mode] || []).map((item) => ({
    ...item,
    requiredCapabilityIds: [...item.requiredCapabilityIds],
  }));
}

export function creatorAgentStarterIdeaBatch(input: {
  sessionSeed: string;
  contextKey: string;
  mode?: CreatorAgentStarterMode;
  rotation?: number;
}) {
  const mode = input.mode || 'blank-new';
  if (mode === 'resumed-session') return [];
  const eligible = catalogIdeasForMode(mode);
  if (eligible.length === 0) return [];

  const batches = [...new Set(eligible.map((item) => boundedCount(item.batch)))].sort(
    (left, right) => left - right,
  );
  const sessionSeed = String(input.sessionSeed || 'new-session').slice(0, 160);
  const contextKey = String(input.contextKey || '00000000').slice(0, 64);
  const hash = stableHash(`t8-creator-starter-v2\0${mode}\0${sessionSeed}\0${contextKey}`);
  const baseIndex = Number.parseInt(hash, 16) % batches.length;
  const rotation = Number.isFinite(input.rotation)
    ? Math.trunc(Number(input.rotation))
    : 0;
  const normalizedRotation = ((rotation % batches.length) + batches.length) % batches.length;
  const selectedBatch = batches[(baseIndex + normalizedRotation) % batches.length];
  const selected = eligible.filter((item) => boundedCount(item.batch) === selectedBatch);
  return selected.slice(0, 3);
}
