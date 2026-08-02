import test from 'node:test';
import assert from 'node:assert/strict';
import {
  materializeCanvasPatchDraft,
  type CanvasPatchDraft,
} from '../src/utils/workflowDoctor.ts';

const options = {
  projectId: 'project-script-master-test',
  canvasId: 'canvas-script-master-test',
  baseRevision: 3,
};

function draft(operations: CanvasPatchDraft['operations']): CanvasPatchDraft {
  return {
    source: 'script-master-v1',
    id: 'script-master-test-draft',
    title: '剧本大师下游预览',
    description: '只新增或更新受控生产节点',
    operations,
    diagnosticsResolved: [],
  };
}

test('script master draft materializes bounded downstream adds and updates', () => {
  const added = materializeCanvasPatchDraft(draft([{
    type: 'node.add',
    node: {
      id: 'director-node-stable',
      type: 'director-storyboard',
      position: { x: 120, y: 240 },
      data: { shots: [{ id: 'shot-1', title: '开场' }], status: 'idle' },
    },
  }]), options);
  assert.match(added.id, /^script-master-patch-/);
  assert.equal(added.requiresConfirmation, true);
  assert.deepEqual(added.operations[0].payload, {
    node: {
      id: 'director-node-stable',
      type: 'director-storyboard',
      position: { x: 120, y: 240 },
      data: { shots: [{ id: 'shot-1', title: '开场' }], status: 'idle' },
    },
  });

  const updated = materializeCanvasPatchDraft(draft([{
    type: 'node.patch',
    nodeId: 'director-node-stable',
    nodeType: 'director-storyboard',
    patch: { data: { shots: [{ id: 'shot-1', title: '新开场' }], status: 'idle' } },
  }]), options);
  assert.deepEqual(updated.operations[0].payload, {
    nodeId: 'director-node-stable',
    dataPatch: { shots: [{ id: 'shot-1', title: '新开场' }], status: 'idle' },
  });
});

test('script master draft rejects unsupported operations, node types and private content', () => {
  assert.throws(() => materializeCanvasPatchDraft(draft([{
    type: 'node.delete', nodeId: 'story-node-stable',
  }]), options), /只允许新增或更新/);

  assert.throws(() => materializeCanvasPatchDraft(draft([{
    type: 'node.add',
    node: { id: 'text-node', type: 'text', position: { x: 0, y: 0 }, data: { text: 'unsafe target' } },
  }]), options), /不允许写入节点类型/);

  assert.throws(() => materializeCanvasPatchDraft(draft([{
    type: 'node.patch',
    nodeId: 'story-node-stable',
    nodeType: 'story',
    patch: { data: { apiKey: 'sk-proj-secret-value' } },
  }]), options), /私有字段|不可公开内容/);

  assert.throws(() => materializeCanvasPatchDraft(draft([{
    type: 'node.add',
    node: { id: 'audio-node-stable', type: 'audio', position: { x: 0, y: 0 }, data: { prompt: '读取 C:\\private\\voice.wav' } },
  }]), options), /不可公开内容/);
});
