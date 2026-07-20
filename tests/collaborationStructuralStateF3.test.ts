import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { VersionedCanvasData } from '../src/types/project.ts';
import {
  collaborationDeleteDrafts,
  collaborationEdgeAddDraft,
  collaborationNodeLabelPatchDraft,
  collaborationPresenceWithDrag,
  collaborationRemoteDragPositions,
  collaborationRestoreEdgeDraft,
  collaborationRestoreNodeDraft,
  collaborationTextNodeAddDraft,
  shouldSendCollaborationDragPreview,
} from '../src/utils/collaborationStructure.ts';

const workspace = readFileSync(
  new URL('../src/components/CollaborationWorkspace.tsx', import.meta.url),
  'utf8',
);

function document(): VersionedCanvasData {
  return {
    schema: 't8-canvas-document',
    schemaVersion: 2,
    projectId: 'project-f3',
    canvasId: 'canvas-f3',
    entityUid: 'canvas-uid',
    revision: 4,
    nodes: [
      { id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: {} },
      { id: 'node-b', type: 'text', position: { x: 100, y: 0 }, data: {} },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    subflowInstances: [],
    tombstones: { nodes: {}, edges: {} },
    updatedAt: 100,
  } as VersionedCanvasData;
}

test('F3 React Flow structure events map to exact operation drafts without duplicate cascade deletes', () => {
  assert.deepEqual(collaborationEdgeAddDraft({
    source: 'node-a',
    target: 'node-b',
    sourceHandle: 'text-out',
    targetHandle: 'prompt-in',
  }, 'edge-new'), {
    type: 'edge.add',
    payload: {
      edge: {
        id: 'edge-new',
        source: 'node-a',
        target: 'node-b',
        sourceHandle: 'text-out',
        targetHandle: 'prompt-in',
        type: 'default',
      },
    },
  });

  const deleted = collaborationDeleteDrafts(
    [{ id: 'node-a' }],
    [
      { id: 'cascade', source: 'node-a', target: 'node-b' },
      { id: 'explicit', source: 'node-b', target: 'node-c' },
    ],
  );
  assert.deepEqual(deleted, [
    { type: 'node.delete', payload: { nodeId: 'node-a' } },
    { type: 'edge.delete', payload: { edgeId: 'explicit' } },
  ]);

  assert.equal(collaborationTextNodeAddDraft('node-new', { x: 1, y: 2 }).type, 'node.add');
  assert.deepEqual(collaborationNodeLabelPatchDraft('node-a', '新的标题'), {
    type: 'node.patch',
    payload: { nodeId: 'node-a', dataPatch: { label: '新的标题' } },
  });
});

test('F3 explicit restore drafts require tombstone-bound UUID, type, and endpoints', () => {
  const restoredNode = collaborationRestoreNodeDraft('node-deleted', {
    entityUid: 'b30d40e5-a2ca-5ef5-a9cf-8c657b83e1bf',
    entityType: 'text',
  }, { x: 40, y: 80 });
  assert.equal(restoredNode.type, 'node.restore');
  assert.equal((restoredNode.payload.node as Record<string, unknown>).entityUid, 'b30d40e5-a2ca-5ef5-a9cf-8c657b83e1bf');

  const restoredEdge = collaborationRestoreEdgeDraft('edge-deleted', {
    entityUid: '9ad767f9-dc65-5f3a-8fa9-ce160b39dde9',
    entityType: 'default',
    source: 'node-a',
    target: 'node-b',
    sourceHandle: 'text-out',
    targetHandle: 'prompt-in',
  });
  assert.equal(restoredEdge.type, 'edge.restore');
  assert.deepEqual(restoredEdge.payload.edge, {
    id: 'edge-deleted',
    entityUid: '9ad767f9-dc65-5f3a-8fa9-ce160b39dde9',
    type: 'default',
    source: 'node-a',
    target: 'node-b',
    sourceHandle: 'text-out',
    targetHandle: 'prompt-in',
  });

  const legacyEdge = collaborationRestoreEdgeDraft('edge-legacy', {
    entityUid: '7c498d8c-16f7-5f27-a81a-1ab600ad459d',
    entityType: 'default',
    source: 'node-a',
    target: 'node-b',
  });
  assert.equal(Object.hasOwn(legacyEdge.payload.edge as object, 'sourceHandle'), false);

  assert.throws(() => collaborationRestoreNodeDraft('node-deleted', {}, { x: 0, y: 0 }));
  assert.throws(() => collaborationRestoreEdgeDraft('edge-deleted', {}));
});

test('F3 drag preview is bounded to 5-10Hz while clear removes only ephemeral drag state', () => {
  assert.equal(shouldSendCollaborationDragPreview(0, 99), false);
  assert.equal(shouldSendCollaborationDragPreview(0, 100), true);
  assert.equal(shouldSendCollaborationDragPreview(100, 199), false);
  assert.equal(shouldSendCollaborationDragPreview(100, 200), true);

  const initial = { cursor: { x: 2, y: 3 }, selectedNodeIds: ['node-a'] };
  const dragging = collaborationPresenceWithDrag(initial, {
    nodeId: 'node-a',
    dragId: 'drag-1',
    seq: 2,
    position: { x: 10, y: 20 },
  });
  assert.deepEqual(dragging.drag?.position, { x: 10, y: 20 });
  assert.deepEqual(collaborationPresenceWithDrag(dragging, null), initial);
  assert.throws(() => collaborationPresenceWithDrag(initial, {
    nodeId: 'node-a', dragId: 'drag-1', seq: 3, position: { x: Number.NaN, y: 0 },
  }));
});

test('F3 remote drag previews never override an active local drag and never mutate the document', () => {
  const base = document();
  const before = structuredClone(base);
  const positions = collaborationRemoteDragPositions(base, [
    collaborationPresenceWithDrag({}, {
      nodeId: 'node-a', dragId: 'remote-a', seq: 1, position: { x: 50, y: 60 },
    }),
    collaborationPresenceWithDrag({}, {
      nodeId: 'node-b', dragId: 'remote-b', seq: 1, position: { x: 70, y: 80 },
    }),
  ], ['node-a']);
  assert.equal(positions.has('node-a'), false);
  assert.deepEqual(positions.get('node-b'), { x: 70, y: 80 });
  assert.deepEqual(base, before);
});

test('F3 workspace keeps structure batches online-only and validates exact ACKs before accepting state', () => {
  const start = workspace.indexOf('const submitStructuralOperations = useCallback');
  const end = workspace.indexOf('const onNodesChange = useCallback', start);
  const submit = workspace.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(submit, /drafts\.some\(\(draft\) => draft\.type === 'node\.move'\)/);
  assert.match(submit, /connectionStateRef\.current\.phase !== 'online'/);
  assert.match(submit, /F2 本地队列仍只保存最终 node\.move/);
  assert.match(submit, /if \(offlineQueueRef\.current\.length > 0\) await flushOfflineQueue\(\)/);
  assert.match(submit, /const commonBatch = buildCommonGraphBatch\(/);
  assert.match(submit, /const requestBody = JSON\.stringify\(commonBatch\);/);
  const fenceIndex = submit.indexOf('const mutationFence = captureMutationFence()');
  const requestIndex = submit.indexOf('collaborationMutationRequest<unknown>');
  const validateIndex = submit.indexOf('acceptCommonCollaborationMutationResult(result');
  const acceptIndex = submit.indexOf('acceptAuthoritativeDocument(confirmed.document)');
  assert.ok(fenceIndex >= 0 && requestIndex > fenceIndex && validateIndex > requestIndex && acceptIndex > validateIndex);
  assert.match(submit, /exactRetry < 2/);
  assert.match(submit, /rebaseAttempt <= 3/);
  assert.match(workspace, /connectionStateRef\.current\.phase === 'online'[\s\S]*`协作在线 · revision \$\{next\.revision\}`/);
  assert.match(workspace, /if \(!selected\) return;/);
  assert.match(workspace, /!nodes\.some\(\(node\) => String\(node\.id\) === selectedNodeId\)/);
});

test('F3 workspace throttles ephemeral drag presence and commits one guarded final move', () => {
  assert.match(workspace, /shouldSendCollaborationDragPreview\(next\.lastSentAt, now\)/);
  assert.match(workspace, /if \(localDragRef\.current && !localDragRef\.current\.finalCommitted\) return;/);
  const start = workspace.indexOf('const finalizeLocalDrag = useCallback');
  const end = workspace.indexOf('const onNodeDragStop', start);
  const finalize = workspace.slice(start, end);
  assert.match(finalize, /if \(!active \|\| active\.finalCommitted\) return false;/);
  assert.match(finalize, /finalCommitted: true/);
  assert.match(finalize, /collaborationPresenceWithDrag\(localPresenceRef\.current, null\)/);
  assert.match(finalize, /sendOperations\(\[\{[\s\S]*type: 'node\.move'/);
  assert.match(workspace, /onPointerCancel=\{\(\) => \{ finalizeLocalDrag\(\); \}\}/);
});
