import type { CanvasData } from './canvas';

export type CanvasOperationType =
  | 'node.add'
  | 'node.patch'
  | 'node.move'
  | 'node.delete'
  | 'node.restore'
  | 'edge.add'
  | 'edge.delete'
  | 'edge.restore'
  | 'viewport.set';

export interface CanvasOperation {
  opId: string;
  projectId?: string | null;
  canvasId?: string | null;
  actorId: string;
  sessionId: string;
  baseRevision?: number | null;
  clientSeq: number;
  timestamp: number;
  type: CanvasOperationType;
  payload: Record<string, unknown>;
}

export type CanvasPatchSchema = 't8-canvas-patch-v1';
export type CanvasPatchStatus = 'applied' | 'reverted';

/**
 * Authoritative, serializable patch envelope. Server-owned identity fields on
 * every operation are placeholders until the patch service validates and
 * applies the patch for an authenticated actor/session.
 */
export interface CanvasPatch {
  schema: CanvasPatchSchema;
  id: string;
  baseRevision: number;
  summary: string;
  operations: CanvasOperation[];
  diagnosticsResolved: string[];
  requiresConfirmation: true;
}

export interface CanvasPatchChange {
  operationIndex: number;
  type: CanvasOperationType;
  targetType: 'node' | 'edge' | 'canvas';
  targetId: string;
  fields: string[];
  before: unknown;
  after: unknown;
  relatedNodeIds?: string[];
  relatedEdgeIds?: string[];
}

export interface CanvasPatchPreview {
  patchId: string;
  baseRevision: number;
  currentRevision: number;
  previewDigest: string;
  summary: string;
  diagnosticsResolved: string[];
  affectedNodeIds: string[];
  affectedEdgeIds: string[];
  changes: CanvasPatchChange[];
  warnings?: string[];
}

/** Bounded patch metadata suitable for history/audit UI; it omits raw operations and inverse data. */
export interface CanvasPatchRecord {
  patchId: string;
  summary: string;
  diagnosticsResolved: string[];
  baseRevision: number;
  appliedRevision: number;
  revertedRevision?: number | null;
  actorId: string;
  status: CanvasPatchStatus;
  operationCount: number;
  createdAt: number;
  revertedAt?: number | null;
  canRevert: boolean;
}

export interface CanvasPatchAcknowledgement {
  opId: string;
  revision: number;
  duplicate: boolean;
}

export interface CanvasPatchApplyResult {
  patchId: string;
  status: 'applied';
  duplicate: boolean;
  baseRevision: number;
  revision: number;
  document: VersionedCanvasData;
  acknowledgements?: CanvasPatchAcknowledgement[];
}

export interface CanvasPatchRevertResult {
  patchId: string;
  status: 'reverted';
  duplicate?: boolean;
  revision: number;
  document: VersionedCanvasData;
}

export interface VersionedCanvasData extends CanvasData {
  schema: 't8-canvas-document';
  schemaVersion: 2;
  projectId: string;
  canvasId: string;
  entityUid: string;
  revision: number;
  subflowInstances: Array<Record<string, unknown>>;
  tombstones: {
    nodes: Record<string, { opId: string; actorId: string; sessionId: string; deletedAt: number; revision: number; entityUid?: string | null }>;
    edges: Record<string, { opId: string; actorId: string; sessionId: string; deletedAt: number; revision: number; entityUid?: string | null }>;
  };
  updatedAt: number;
}

export type CanvasSyncData =
  | { mode: 'snapshot'; document: VersionedCanvasData }
  | { mode: 'operations'; canvasId: string; revision: number; operations: Array<CanvasOperation & { revision: number }> };

export type WorkspaceRole = 'owner' | 'editor' | 'reviewer' | 'viewer';

export type WorkspaceCapability =
  | 'editGraph'
  | 'publishSubflow'
  | 'runWorkflow'
  | 'uploadAsset'
  | 'downloadOriginal'
  | 'comment'
  | 'approve'
  | 'manageMembers'
  | 'manageProviders';

export interface RunSummary {
  id: string;
  projectId: string;
  canvasId: string;
  canvasRevision: number;
  initiatorId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped' | 'interrupted';
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  summary?: Record<string, unknown>;
  parentRunId?: string | null;
}

export type RunExecutionMode = 'single' | 'batch' | 'replay';

/**
 * Immutable identity for one persisted topology execution.
 *
 * A context is created once by Canvas.runNodesByOrder and copied into every
 * execution-token binding. Late promises therefore keep writing to the Run
 * that issued them even after the active canvas starts another Run.
 */
export interface RunContext {
  contextId: string;
  runId: string;
  projectId: string;
  canvasId: string;
  canvasRevision: number;
  mode: RunExecutionMode;
  plannedNodeIds: string[];
  /** Exact runtime IDs authorized by the final, freshly revalidated preflight. */
  authorizedNodeIds?: string[];
  parentRunId?: string | null;
  replayMode?: string | null;
  replaySourceRunId?: string | null;
  replaySourceAttemptId?: string | null;
  /** Correlates an explicit node-surface action with the exact confirmed preview. */
  requestId?: string | null;
  /**
   * Present only for a fixed-whitelist secondary Provider action. The owning
   * Canvas copies these immutable fields from the validated action envelope;
   * node listeners require all four to match before invoking an executor.
   */
  secondaryProviderActionSchema?: string | null;
  secondaryProviderActionId?: string | null;
  secondaryProviderActionTarget?: string | null;
  secondaryProviderActionDigest?: string | null;
  createdAt: number;
}

export type RunNodeLifecycleEventType =
  | 'node.progress'
  | 'node.polling'
  | 'node.output'
  | 'provider.request'
  | 'provider.submitted'
  | 'provider.polling'
  | 'provider.response'
  | 'provider.usage';

export interface RunNodeLifecycleReporter {
  readonly runContext: RunContext | null;
  readonly executionToken: string;
  progress(payload?: Record<string, unknown>): Promise<void>;
  polling(payload?: Record<string, unknown>): Promise<void>;
  output(payload?: Record<string, unknown>): Promise<void>;
  providerRequest(payload?: Record<string, unknown>): Promise<void>;
  providerSubmitted(payload?: Record<string, unknown>): Promise<void>;
  providerPolling(payload?: Record<string, unknown>): Promise<void>;
  providerResponse(payload?: Record<string, unknown>): Promise<void>;
  providerUsage(payload?: Record<string, unknown>): Promise<void>;
}

export interface NodeRunSummary {
  id: string;
  runId: string;
  nodeId: string;
  parentNodeRunId?: string | null;
  originalNodeId?: string | null;
  definitionId?: string | null;
  definitionVersion?: number | null;
  subflowPath: string[];
  status: string;
  inputSnapshot: Record<string, unknown>;
  outputRefs: string[];
  createdAt: number;
  updatedAt: number;
  attempts?: RunAttemptSummary[];
}

export interface RunAttemptSummary {
  id: string;
  nodeRunId: string;
  attemptNumber: number;
  provider?: string | null;
  model?: string | null;
  upstreamTaskId?: string | null;
  requestId?: string | null;
  httpStatus?: number | null;
  pollCount: number;
  status: string;
  timestamps: Record<string, number>;
  usage: Record<string, unknown>;
  metadata: Record<string, unknown>;
  error?: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunDetail extends RunSummary {
  nodeRuns: NodeRunSummary[];
}

export interface RunEventRecord {
  id: number;
  runId: string;
  nodeRunId?: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface RunRetentionPolicy {
  projectId: string;
  maxDays: number;
  maxRuns: number;
  maxAssetRefs: number;
  maxDbBytes: number;
  keepReferenced: boolean;
  updatedAt: number;
}

export interface RunRetentionResult {
  deletedRuns: number;
  protectedRuns: number;
  deletedAssetRefs: number;
  beforeRuns: number;
  afterRuns: number;
  beforeAssetRefs: number;
  afterAssetRefs: number;
  beforeBytes: number;
  afterBytes: number;
  assetsDeleted: number;
  limitsSatisfied: boolean;
  blockedBy: string[];
  policy: RunRetentionPolicy;
}

export interface RunRecoveryPreparation {
  runs: number;
  nodeRuns: number;
  attempts: number;
  recoverableRuns: number;
  recoverableNodeRuns: number;
  recoverableAttempts: number;
}

export interface RunRecoveryManagerStatus {
  status: 'idle' | 'running' | 'completed';
  running: boolean;
  recovered: number;
  failed: number;
  interrupted: number;
  pending: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RunRecoveryOverview {
  startup: RunRecoveryPreparation;
  manager: RunRecoveryManagerStatus;
  pending: number;
}

export type AssetPreviewStatus = 'queued' | 'running' | 'retrying' | 'ready' | 'failed' | 'unsupported';

export interface AssetMetadata extends Record<string, unknown> {
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
  frameCount?: number;
  sampleRate?: number;
  colorSpace?: string;
  space?: string;
  health?: string;
  previewStatus?: AssetPreviewStatus;
  previewError?: string;
  thumbnailUrl?: string;
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  keyframeUrls?: string[];
  keyframeTimes?: number[];
  contactSheetUrl?: string;
  proxyUrl?: string;
  videoProxyUrl?: string;
  waveformUrl?: string;
  modelPreviewUrl?: string;
  perceptualHashAlgorithm?: string;
  perceptualHashes?: Array<{
    role: string;
    index: number;
    time?: number;
    hash: string;
    algorithm: string;
  }>;
}

export type AssetRevision = string | number;

export interface AssetRef {
  id: string;
  entityUid: string;
  projectId: string;
  kind: 'image' | 'video' | 'audio' | 'model3d' | 'text' | 'other';
  filename: string;
  mimeType?: string;
  contentHash?: string;
  perceptualHash?: string;
  perceptualHashAlgorithm?: string;
  sourceUrl?: string;
  storageMode: 'managed' | 'linked' | 'remote' | 'embedded';
  availability: 'available' | 'missing' | 'corrupt' | 'unverified';
  metadata?: AssetMetadata;
  provenance?: Record<string, unknown>;
  tags?: string[];
  collectionIds?: string[];
  organizationRevision?: AssetRevision;
  access?: {
    visibility: 'project' | 'restricted';
    grants: AssetPermissionGrant[];
  };
  createdAt: number;
  updatedAt?: number;
}

export interface AssetCollection {
  id: string;
  projectId: string;
  name: string;
  description: string;
  createdBy: string;
  assetCount: number;
  createdAt: number;
  updatedAt: number;
  revision: AssetRevision;
}

export interface AssetCatalogFilterSnapshot {
  projectId?: string;
  kind?: string;
  query?: string;
  tag?: string;
  collectionId?: string;
  storageMode?: AssetRef['storageMode'];
  availability?: AssetRef['availability'];
  source?: string;
  sort?: 'created-desc' | 'created-asc' | 'updated-desc' | 'updated-asc' | 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc';
}

export interface AssetCatalogPage {
  items: AssetRef[];
  total: number;
  offset: number;
  catalogRevision: AssetRevision;
  tags: string[];
}

export interface AssetPermissionGrant {
  principalType: 'member' | 'role';
  principalId: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface AssetPermissionWireGrant {
  principalType: 'member' | 'role';
  principalId: string;
  permissions: string[];
  grantedBy?: string;
  createdAt?: number;
}

export interface AssetPermissionRecord {
  projectId: string;
  assetId: string;
  scope: 'project' | 'restricted';
  revision: AssetRevision;
  grants: AssetPermissionWireGrant[];
  updatedAt: number;
}

export type AssetBatchTarget = {
  mode: 'ids';
  assetIds: string[];
  expectedRevisions: Record<string, AssetRevision>;
} | {
  mode: 'query';
  query: AssetCatalogFilterSnapshot;
  catalogRevision: AssetRevision;
  exclusions: string[];
};

export interface AssetBatchMutationSet {
  tags?: { mode: 'add' | 'remove' | 'replace'; values: string[] };
  collections?:
    | { mode: 'add' | 'remove' | 'replace'; values: string[] }
    | { mode: 'move'; fromCollectionIds: string[]; toCollectionId: string };
  access?: {
    visibility: 'project' | 'restricted';
    grants: AssetPermissionGrant[];
  };
}

export interface AssetBatchResult {
  idempotent?: boolean;
  affected: number;
  assetIds?: string[];
  organizationRevisions?: Record<string, AssetRevision>;
  catalogRevision: AssetRevision;
  assets?: AssetRef[];
  conflicts?: Array<{ assetId: string; expected?: AssetRevision; actual?: AssetRevision }>;
}

export type AssetDuplicateKind = 'exact' | 'near';
export type AssetDuplicateDecision = 'pending' | 'confirmed' | 'dismissed';

export interface AssetDuplicateFrameMatch {
  sourceIndex: number;
  targetIndex: number;
  sourceTime?: number;
  targetTime?: number;
  distance: number;
  algorithm: string;
}

export interface AssetDuplicateCandidate {
  id: string;
  asset: AssetRef;
  kind: AssetDuplicateKind;
  algorithm: string;
  distance: number;
  frameMatches: AssetDuplicateFrameMatch[];
  decision: AssetDuplicateDecision;
  revision?: AssetRevision;
  updatedAt?: number;
  confidence?: 'low' | 'medium' | 'high';
  evidenceCount?: number;
  coverage?: number;
  aggregateDistance?: number;
}

export interface AssetDuplicatePage {
  items: AssetDuplicateCandidate[];
  cursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface AssetExactDuplicateGroup {
  id: string;
  kind: 'exact';
  contentHash: string;
  memberCount: number;
  members: AssetRef[];
  membersTruncated: boolean;
}

export interface AssetExactDuplicateGroupPage {
  items: AssetExactDuplicateGroup[];
  cursor: string | null;
  hasMore: boolean;
}

export interface AssetSourceTreeNode {
  assetId: string;
  direction: 'ancestor' | 'root' | 'descendant';
  depth: number;
  asset?: AssetRef;
  filename?: string;
  tombstone?: boolean;
}

export interface AssetSourceTreeEdge {
  id: string;
  fromAssetId: string;
  toAssetId: string;
  relation: string;
}

export interface AssetSourceTree {
  rootAssetId: string;
  nodes: AssetSourceTreeNode[];
  edges: AssetSourceTreeEdge[];
  cursor: string | null;
  hasMore: boolean;
  truncated: boolean;
  cycleDetected: boolean;
  totalNodes?: number;
  totalEdges?: number;
}

export interface AssetLineageRecord {
  id: string;
  childAssetId: string;
  parentAssetId?: string | null;
  relation: string;
  sourceType: string;
  sourceNodeId?: string | null;
  sourceNodeType?: string | null;
  runId?: string | null;
  nodeRunId?: string | null;
  attemptId?: string | null;
  canvasId?: string | null;
  creatorId: string;
  promptSummary?: string | null;
  promptDigest?: string | null;
  derivedOperation?: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface AssetLineagePage {
  items: AssetLineageRecord[];
  total: number;
  limit: number;
  cursor: string | null;
  hasMore: boolean;
  lineageRevision: string;
}

export interface AssetIndexResult {
  total: number;
  indexed: number;
  failed: number;
  availability?: { checked: number; missing: number; restored: number };
  previewJobs?: { queued: number; succeeded: number; failed: number };
  startedAt: number;
  finishedAt: number;
}

export type AssetPreviewTaskState = 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed';

export interface AssetPreviewTaskSummary {
  id?: string;
  assetId: string;
  filename?: string;
  kind?: string;
  status: AssetPreviewTaskState;
  attempt?: number;
  progress?: number;
  error?: string | null;
  nextAttemptAt?: number | null;
}

export interface AssetPreviewPipelineCounts {
  queued: number;
  running: number;
  retrying: number;
  succeeded: number;
  failed: number;
}

export interface AssetPipelineStatus {
  scan: {
    running: boolean;
    lastResult: AssetIndexResult | null;
  };
  previews: {
    active: number;
    concurrency: number;
    counts: AssetPreviewPipelineCounts;
    nextAttemptAt?: number | null;
  };
}

export type AssetSearchMode = 'keyword' | 'semantic';

export type AssetSemanticCapability = 'caption' | 'ocr' | 'embedding';

/** Public install lifecycle only. Model locations and download origins stay backend-private. */
export type AssetSemanticInstallState =
  | 'not-installed'
  | 'downloading'
  | 'verifying'
  | 'installed'
  | 'failed'
  | 'error'
  | 'disabled'
  | 'deleting';

export type AssetSemanticIndexState =
  | 'disabled'
  | 'empty'
  | 'queued'
  | 'building'
  | 'ready'
  | 'stale'
  | 'degraded'
  | 'error';

export interface AssetSemanticModelStatus {
  key: string;
  capability: AssetSemanticCapability;
  label: string;
  version: string;
  revision: number;
  installState: AssetSemanticInstallState;
  installed: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
  error?: string | null;
}

export interface AssetSemanticCapabilityProfile {
  enabled: boolean;
  modelKey: string;
  modelVersion: string;
}

export interface AssetSemanticProfile {
  projectId: string;
  revision: number;
  enabled: boolean;
  caption: AssetSemanticCapabilityProfile;
  ocr: AssetSemanticCapabilityProfile;
  embedding: AssetSemanticCapabilityProfile;
  activeGeneration: number;
  buildingGeneration: number | null;
  updatedBy?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface AssetSemanticCapabilityProfilePatch {
  enabled?: boolean;
  modelKey?: string;
  modelVersion?: string;
}

export interface AssetSemanticProfileUpdateInput {
  projectId: string;
  expectedRevision: number;
  enabled?: boolean;
  caption?: AssetSemanticCapabilityProfilePatch;
  ocr?: AssetSemanticCapabilityProfilePatch;
  embedding?: AssetSemanticCapabilityProfilePatch;
  updatedBy: string;
}

export interface AssetSemanticCapabilityCounts {
  eligible: number;
  queued: number;
  running: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

export interface AssetSemanticCapabilityStatus extends AssetSemanticCapabilityCounts {
  capability: AssetSemanticCapability;
  enabled: boolean;
  modelKey: string;
  modelVersion: string;
  model: AssetSemanticModelStatus | null;
}

export interface AssetSemanticProjectStatus {
  projectId: string;
  revision: AssetRevision;
  enabled?: boolean;
  activeGeneration: number;
  activeIndexRevision: AssetRevision;
  activeCatalogRevision: AssetRevision;
  currentCatalogRevision: AssetRevision;
  buildingGeneration: number | null;
  indexState: AssetSemanticIndexState;
  indexStale: boolean;
  capabilities: Record<AssetSemanticCapability, AssetSemanticCapabilityStatus>;
  updatedAt?: number | null;
}

export interface AssetSemanticGenerationCounts {
  queued: number;
  running: number;
  retrying: number;
  succeeded: number;
  skipped: number;
  failed: number;
  superseded: number;
  total: number;
}

export type AssetSemanticGenerationState = 'building' | 'ready' | 'active' | 'failed' | 'superseded';

export interface AssetSemanticGenerationSummary {
  projectId: string;
  generation: number;
  revision: number;
  profileRevision: number;
  catalogRevision: number;
  jobsSealed?: boolean;
  expectedJobCount?: number;
  eligibleAssetCount?: number;
  excludedAssetCount?: number;
  payloadPrunedAt?: number | null;
  status: AssetSemanticGenerationState;
  counts: AssetSemanticGenerationCounts;
  error?: string | null;
  createdBy?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  finishedAt?: number | null;
}

export type AssetSemanticRebuildStatus = AssetSemanticGenerationSummary;

export interface AssetSemanticStatus {
  project: AssetSemanticProjectStatus;
  models: AssetSemanticModelStatus[];
  rebuild: AssetSemanticRebuildStatus | null;
}

export type AssetSemanticJobState =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'superseded';

export interface AssetSemanticJobSummary {
  id: string;
  projectId: string;
  assetId: string;
  generation: number;
  jobKind: AssetSemanticCapability;
  modelKey: string;
  modelVersion: string;
  status: AssetSemanticJobState;
  revision: number;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt?: number | null;
  error?: string | null;
  createdAt?: number | null;
  startedAt?: number | null;
  updatedAt?: number | null;
  finishedAt?: number | null;
}

export interface AssetSemanticDocument {
  id: string | number;
  assetId: string;
  source: 'caption' | 'ocr';
  modelKey: string;
  modelVersion: string;
  text: string;
  language?: string | null;
  metadata?: Record<string, unknown>;
  indexedAt?: number | null;
}

export interface AssetSemanticEvidence {
  source: 'filename' | 'tag' | 'metadata' | 'caption' | 'ocr' | 'text';
  snippet: string;
  language?: string | null;
  modelKey?: string;
  modelVersion?: string;
  frameIndex?: number;
  time?: number;
  page?: number;
  bbox?: [number, number, number, number];
}

export interface AssetSemanticSearchHit {
  asset: AssetRef;
  rank: number;
  score: number;
  metric: 'cosine' | 'rrf' | 'bm25' | 'keyword';
  evidence: AssetSemanticEvidence[];
}

export interface AssetSemanticSearchIdentity {
  projectId: string;
  queryDigest: string;
  catalogRevision: AssetRevision;
  semanticIndexRevision: AssetRevision;
  activeGeneration: number;
  modelKey: string;
  modelVersion: string;
}

export interface AssetSemanticSearchPage {
  hits: AssetSemanticSearchHit[];
  total: number;
  offset: number;
  limit: number;
  identity: AssetSemanticSearchIdentity;
  stale?: boolean;
}

export type AssetSemanticSearchFilters = Record<string, unknown>;

export interface AssetSemanticSearchInput {
  projectId: string;
  query: string;
  filters?: AssetSemanticSearchFilters;
  limit?: number;
  offset?: number;
  expectedCatalogRevision?: AssetRevision;
  expectedProfileRevision?: number;
  expectedGeneration?: number;
}

export interface AssetSemanticModelMutationInput {
  expectedRevision: number;
  idempotencyKey: string;
}

export interface AssetSemanticModelDeleteInput {
  expectedRevision: number;
}

export interface AssetSemanticRebuildInput {
  projectId: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface AssetSemanticJobRetryInput {
  projectId: string;
  expectedRevision: number;
}

export interface CollaborationAssetQuotaScope {
  limitBytes: number | null;
  usedBytes: number;
  reservedBytes: number;
  availableBytes: number | null;
}

export interface CollaborationAssetQuota extends CollaborationAssetQuotaScope {
  project?: CollaborationAssetQuotaScope;
  member?: CollaborationAssetQuotaScope | null;
}

export interface CollaborationAssetUploadPolicy {
  chunkSize: number;
  maxFileBytes: number | null;
  quota: CollaborationAssetQuota;
}

export type CollaborationAssetUploadSessionState =
  | 'created'
  | 'uploading'
  | 'paused'
  | 'verifying'
  | 'assembling'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'aborted'
  | 'expired';

export interface CollaborationAssetUploadChunk {
  index: number;
  size?: number;
  receivedBytes?: number;
  status?: string;
}

/** Public, path-free state returned by the collaboration upload gateway. */
export interface CollaborationAssetUploadSession {
  sessionId: string;
  generation?: number;
  state?: CollaborationAssetUploadSessionState;
  status?: CollaborationAssetUploadSessionState;
  chunkSize?: number;
  receivedBytes?: number;
  receivedChunks?: Array<number | CollaborationAssetUploadChunk>;
  receivedIndexes?: number[];
  uploadedChunks?: Array<number | CollaborationAssetUploadChunk>;
  chunks?: CollaborationAssetUploadChunk[];
  missingChunks?: number[];
  quota?: CollaborationAssetQuota;
  asset?: AssetRef;
  reused?: boolean;
  deduplicated?: boolean;
}

export interface CollaborationAssetUploadCompleteResult {
  session?: CollaborationAssetUploadSession;
  asset?: AssetRef;
  quota?: CollaborationAssetQuota;
  reused?: boolean;
  deduplicated?: boolean;
}

export interface CollaborationNetworkInterface {
  id: string;
  name: string;
  address: string;
  family: 'IPv4';
  internal: boolean;
  cidr?: string | null;
  scope: 'loopback' | 'private' | 'link-local' | 'public' | 'wildcard';
  label: string;
}

export interface CollaborationRoomStatus {
  projectId: string;
  canvasId: string;
  canvasCount: number;
  memberCount: number;
  activeSessionCount: number;
  connectionCount: number;
  resourceScope?: CollaborationResourceScopeStatus | null;
}

export interface CollaborationResourceScopeStatus {
  status: 'ready' | 'confirmation-required' | 'stale';
  ready: boolean;
  canvasRevision: number;
  trustedRevision?: number | null;
  initializedAt?: number | null;
  assetCount: number;
  subflowCount: number;
}

export interface CollaborationStatus {
  running: boolean;
  host?: string | null;
  port?: number | null;
  startedAt?: number | null;
  connectionCount: number;
  privateBackendExposed: boolean;
  networkInterfaces: CollaborationNetworkInterface[];
  shareUrls: string[];
  defaultHost: string;
  defaultPort: number;
  room?: CollaborationRoomStatus | null;
}

export interface CollaborationExecutionPolicy {
  projectId: string;
  allowedModels: string[];
  dailyCostLimit: number;
  perRunCostLimit: number;
  concurrencyLimit: number;
  updatedBy?: string | null;
  updatedAt?: number | null;
}

export interface CollaborationExecutionUsage {
  activeCount: number;
  dailyCost: number;
  unknownCostCount: number;
  dayStart: number;
}

export interface CollaborationExecutionPolicySnapshot {
  policy: CollaborationExecutionPolicy;
  usage: CollaborationExecutionUsage;
}

export interface CollaborationInvite {
  id: string;
  code?: string;
  projectId: string;
  canvasId?: string | null;
  role: WorkspaceRole;
  capabilities: WorkspaceCapability[];
  expiresAt: number;
  maxUses: number;
  useCount?: number;
  revokedAt?: number | null;
  createdAt?: number;
  localUrl?: string | null;
  shareUrls?: string[];
}

export interface CollaborationMember {
  id: string;
  projectId: string;
  canvasId?: string | null;
  displayName: string;
  role: WorkspaceRole;
  capabilities: WorkspaceCapability[];
  createdAt: number;
  updatedAt: number;
  sessionCount?: number;
  connectionCount?: number;
  online?: boolean;
  lastSeenAt?: number | null;
  disconnectedConnections?: number;
}

export interface CollaborationSession {
  id: string;
  projectId: string;
  canvasId?: string | null;
  memberId: string;
  displayName: string;
  role: WorkspaceRole;
  expiresAt: number;
  revokedAt?: number | null;
  createdAt: number;
  lastSeenAt: number;
  active: boolean;
  connectionCount?: number;
  connected?: boolean;
  disconnectedConnections?: number;
}

export interface CollaborationSessionRevocationResult {
  projectId: string;
  canvasId: string;
  revokedSessions: number;
  disconnectedConnections: number;
}

export interface RunIntent {
  id: string;
  projectId: string;
  canvasId: string;
  canvasRevision: number;
  nodeIds: string[];
  idempotencyKey: string;
  requestedBy: string;
  provider?: string | null;
  model?: string | null;
  estimatedCost: number | null;
  estimatedCostKnown: boolean;
  executionAuthority?: {
    schema: string;
    requestedNodeIds: string[];
    authorizedNodeIds: string[];
    declarations: Array<{ provider: string; model: string; nodeIds: string[] }>;
    cost: {
      known: boolean;
      currency: string | null;
      amount: number | null;
      reasonCode?: string;
    };
  } | null;
  actualCost?: number | null;
  status: 'pending' | 'accepted' | 'running' | 'completed' | 'failed' | 'rejected' | 'stale' | string;
  runId?: string | null;
  createdAt: number;
  updatedAt: number;
}
