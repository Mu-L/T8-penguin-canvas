'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CreatorAgentSessionError,
  createCreatorAgentSessionStore,
  creatorAttachmentOnlyPrompt,
  creatorSuggestions,
  creatorSuggestionBinding,
  creatorSuggestionSet,
  inferCreatorKind,
  inferCreatorRecipe,
  normalizeAttachments,
  normalizeContext,
  normalizeCreatorProductionState,
  phaseForPlan,
  resolveCreatorSuggestionSelection,
} = require('../backend/src/services/creatorAgentSessions.js');

function stableTestString(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableTestString).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableTestString(value[key])}`
  )).join(',')}}`;
}

const stableTestDigest = (value) => crypto.createHash('sha256')
  .update(stableTestString(value)).digest('hex');

function temporaryStore() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-creator-agent-session-'));
  return {
    rootDir,
    store: createCreatorAgentSessionStore({ rootDir }),
    cleanup() {
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

test('creator suggestions are deterministic and always contain exactly three actions', () => {
  const contexts = [
    {},
    { nodeCount: 4 },
    { selectedNodeTypes: ['image'] },
  ];
  const plans = [
    null,
    { kind: 'story' },
    { kind: 'image' },
    { kind: 'video' },
    { kind: 'audio' },
    { kind: 'delivery' },
  ];
  for (const context of contexts) {
    for (const plan of plans) {
      const first = creatorSuggestions(context, plan);
      const second = creatorSuggestions(context, plan);
      assert.equal(first.length, 3);
      assert.deepEqual(second, first);
      assert.equal(new Set(first).size, 3);
      assert.equal(first.every((item) => typeof item === 'string' && item.trim().length > 0), true);
      const structured = creatorSuggestionSet(context, plan);
      assert.equal(structured.schema, 't8-creator-suggestion-set-v1');
      assert.equal(structured.items.length, 3);
      assert.equal(structured.deterministic, true);
      assert.equal(structured.providerCalls, 0);
      for (const item of structured.items) {
        assert.equal(typeof item.id, 'string');
        assert.equal(typeof item.intent, 'string');
        assert.equal(item.riskLevel, 'L0-intent');
        assert.equal(item.arguments.planOnly, true);
        assert.ok(item.requiredCapabilityIds.length > 0);
      }
    }
  }
});

test('creator suggestion receipts bind canvas, context, assets and plan and reject stale clicks', () => {
  const context = {
    canvasRevision: 12,
    nodeCount: 1,
    edgeCount: 0,
    selectedNodeIds: ['image-a'],
    selectedNodeTypes: ['image'],
    viewport: { x: 12, y: 24, zoom: 1.2 },
    outputAssetCount: 1,
    canvasObjects: [{
      nodeId: 'image-a',
      nodeType: 'image',
      label: '主视觉',
      selected: true,
      mediaKinds: ['image'],
      resultCount: 1,
      accepted: true,
      lockKeys: ['subject'],
    }],
    assetLineage: [{
      assetId: 'asset-a',
      kind: 'image',
      label: '主视觉结果',
      relations: ['generated-from'],
      sourceNodeIds: ['image-a'],
      runIds: ['run-a'],
    }],
  };
  const plan = { kind: 'image', planDigest: 'a'.repeat(64) };
  const suggestionSet = creatorSuggestionSet(context, plan);
  assert.match(suggestionSet.setDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(suggestionSet.binding, creatorSuggestionBinding(context, plan));
  assert.equal(suggestionSet.binding.canvasRevision, 12);
  assert.equal(suggestionSet.binding.planDigest, plan.planDigest);

  const recentActionOnly = creatorSuggestionSet({
    ...context,
    recentActions: [{ eventType: 'assistant.plan', label: '刚形成计划', createdAt: 'now' }],
  }, plan);
  assert.equal(recentActionOnly.setDigest, suggestionSet.setDigest);

  const selectionChanged = creatorSuggestionSet({
    ...context,
    selectedNodeIds: [],
    selectedNodeTypes: [],
    canvasObjects: context.canvasObjects.map((item) => ({ ...item, selected: false })),
  }, plan);
  assert.notEqual(selectionChanged.binding.contextDigest, suggestionSet.binding.contextDigest);
  assert.equal(selectionChanged.binding.assetVersion, suggestionSet.binding.assetVersion);

  const assetChanged = creatorSuggestionSet({
    ...context,
    outputAssetCount: 2,
    canvasObjects: context.canvasObjects.map((item) => ({ ...item, resultCount: 2 })),
  }, plan);
  assert.equal(assetChanged.binding.contextDigest, suggestionSet.binding.contextDigest);
  assert.notEqual(assetChanged.binding.assetVersion, suggestionSet.binding.assetVersion);

  const session = { context, latestPlan: plan, suggestionSet };
  const resolved = resolveCreatorSuggestionSelection(session, {
    suggestionId: suggestionSet.items[0].id,
    suggestionSetDigest: suggestionSet.setDigest,
    context,
  });
  assert.equal(resolved.id, suggestionSet.items[0].id);
  assert.throws(
    () => resolveCreatorSuggestionSelection(session, {
      suggestionId: suggestionSet.items[0].id,
      suggestionSetDigest: suggestionSet.setDigest,
      context: { ...context, canvasRevision: 13 },
    }),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_SUGGESTION_STALE'
      && error.status === 409
      && error.details.staleFields.includes('canvasRevision'),
  );
  assert.throws(
    () => resolveCreatorSuggestionSelection(session, {
      suggestionId: suggestionSet.items[0].id,
      suggestionSetDigest: suggestionSet.setDigest,
      context: {
        ...context,
        outputAssetCount: 2,
        canvasObjects: context.canvasObjects.map((item) => ({ ...item, resultCount: 2 })),
      },
    }),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_SUGGESTION_STALE'
      && error.details.staleFields.includes('assetVersion'),
  );
});

test('explicit Creator references outrank the live selection and invalidate stale suggestions', () => {
  const context = {
    canvasRevision: 20,
    nodeCount: 2,
    edgeCount: 0,
    selectedNodeIds: ['node-live'],
    selectedNodeTypes: ['video'],
    referencedNodeIds: ['node-pinned'],
    referencedNodeTypes: ['image'],
    canvasObjects: [{
      nodeId: 'node-live',
      nodeType: 'video',
      label: '临时选中的视频',
      selected: true,
      mediaKinds: ['video'],
    }, {
      nodeId: 'node-pinned',
      nodeType: 'image',
      label: '固定引用的主视觉',
      selected: false,
      mediaKinds: ['image'],
      accepted: true,
      lockKeys: ['subject'],
    }],
  };
  const normalized = normalizeContext({
    ...context,
    referencedNodeIds: [...Array.from({ length: 10 }, (_, index) => `node-${index}`), 'node-0'],
    referencedNodeTypes: Array.from({ length: 10 }, () => 'image'),
  });
  assert.equal(normalized.referencedNodeIds.length, 8);
  assert.equal(new Set(normalized.referencedNodeIds).size, 8);
  assert.equal(normalized.referencedNodeTypes.length, 1);

  const suggestionSet = creatorSuggestionSet(context, { kind: 'image' });
  assert.match(suggestionSet.items[0].label, /固定引用的主视觉/);
  assert.doesNotMatch(suggestionSet.items[0].label, /临时选中的视频/);

  const changed = {
    ...context,
    referencedNodeIds: ['node-live'],
    referencedNodeTypes: ['video'],
  };
  assert.notEqual(
    creatorSuggestionBinding(changed, { kind: 'image' }).contextDigest,
    suggestionSet.binding.contextDigest,
  );
  assert.throws(
    () => resolveCreatorSuggestionSelection(
      { context, latestPlan: { kind: 'image' }, suggestionSet },
      {
        suggestionId: suggestionSet.items[0].id,
        suggestionSetDigest: suggestionSet.setDigest,
        context: changed,
      },
    ),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_SUGGESTION_STALE',
  );
});

test('creator context focus is explicit reference, selection, viewport, session, then project summary', () => {
  const objects = [{
    nodeId: 'node-selected',
    nodeType: 'video',
    label: '临时选中的视频',
    selected: true,
    inViewport: true,
  }, {
    nodeId: 'node-referenced',
    nodeType: 'image',
    label: '固定引用的主视觉',
    selected: false,
    inViewport: false,
  }, {
    nodeId: 'node-visible',
    nodeType: 'audio',
    label: '视口里的旁白',
    selected: false,
    inViewport: true,
  }];
  const plan = {
    kind: 'story',
    brief: { recipe: 'storyboard' },
    analysis: { stage: 'assets' },
  };
  const shared = {
    nodeCount: 3,
    failedRunCount: 2,
    referencedNodeIds: ['node-referenced'],
    referencedNodeTypes: ['image'],
    selectedNodeIds: ['node-selected'],
    selectedNodeTypes: ['video'],
    canvasObjects: objects,
  };

  const explicit = creatorSuggestionSet(shared, plan);
  assert.match(explicit.items[0].label, /固定引用的主视觉/);
  assert.doesNotMatch(explicit.items[0].label, /失败发生/);
  assert.deepEqual(
    explicit.items.map((item) => item.id),
    ['selection-refine', 'selection-review', 'selection-missing'],
  );

  const selection = creatorSuggestionSet({
    ...shared,
    referencedNodeIds: [],
    referencedNodeTypes: [],
  }, plan);
  assert.match(selection.items[0].label, /临时选中的视频/);
  assert.doesNotMatch(selection.items[0].label, /失败发生/);
  assert.deepEqual(
    selection.items.map((item) => item.id),
    ['selection-refine', 'selection-review', 'selection-missing'],
  );

  const viewport = creatorSuggestionSet({
    ...shared,
    failedRunCount: 0,
    referencedNodeIds: [],
    referencedNodeTypes: [],
    selectedNodeIds: [],
    selectedNodeTypes: [],
    canvasObjects: objects.map((item) => ({
      ...item,
      selected: false,
      inViewport: item.nodeId === 'node-visible',
    })),
  }, plan);
  assert.match(viewport.items[0].label, /视口里的旁白/);
  assert.doesNotMatch(viewport.items[0].label, /核对角色、场景/);
  assert.deepEqual(
    viewport.items.map((item) => item.id),
    ['selection-refine', 'selection-review', 'selection-missing'],
  );

  const session = creatorSuggestionSet({
    phase: 'assets',
    nodeCount: 3,
    canvasObjects: objects.map((item) => ({ ...item, selected: false, inViewport: false })),
  }, plan);
  assert.match(session.items[0].label, /核对角色、场景/);
  assert.deepEqual(
    session.items.map((item) => item.id),
    ['story-assets-review', 'story-assets-missing', 'story-assets-to-shots'],
  );

  const project = creatorSuggestionSet({ nodeCount: 3 }, null);
  assert.match(project.items[0].label, /看懂当前画布/);
});

test('story suggestions follow the persisted production phase and stay capability-backed', () => {
  const expectations = [
    ['assets', ['story-assets-review', 'story-assets-missing', 'story-assets-to-shots']],
    ['prompts', ['story-shots-review', 'story-shots-compile', 'story-shots-continuity']],
    ['candidates', ['story-candidates-compare', 'story-candidates-accept', 'story-candidates-retry']],
  ];
  for (const [stage, expectedIds] of expectations) {
    const structured = creatorSuggestionSet(
      { phase: stage },
      { kind: 'story', ready: true, analysis: { stage } },
    );
    assert.deepEqual(structured.items.map((item) => item.id), expectedIds);
    assert.equal(structured.items.length, 3);
    assert.equal(structured.items.every((item) => (
      item.arguments.planOnly === true
      && item.requiredCapabilityIds.length > 0
    )), true);
  }
  assert.match(
    creatorSuggestionSet({ phase: 'assets' }, {
      kind: 'story',
      ready: true,
      analysis: { stage: 'assets' },
    }).items[1].label,
    /不覆盖现有素材/,
  );
});

test('creator suggestions hide unavailable capabilities and deterministically backfill three safe actions', () => {
  const availableCapabilityIds = ['create.story', 'story.analyze', 'iterate.compare'];
  const structured = creatorSuggestionSet(
    {},
    { kind: 'image' },
    { availableCapabilityIds },
  );
  assert.equal(structured.items.length, 3);
  assert.deepEqual(
    structured.items.map((item) => item.id),
    ['safe-clarify-story', 'safe-review-canvas', 'safe-compare-options'],
  );
  assert.equal(structured.items.every((item) => (
    item.requiredCapabilityIds.every((id) => availableCapabilityIds.includes(id))
  )), true);
  assert.throws(
    () => creatorSuggestionSet({}, null, { availableCapabilityIds: [] }),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_SUGGESTION_CAPABILITY_GAP',
  );
});

test('creator context keeps a bounded production summary and prioritizes failed Run recovery', () => {
  const context = normalizeContext({
    nodeCount: 12,
    edgeCount: 11,
    nodeTypeCounts: { image: 4, video: 3, story: 1, empty: 0 },
    viewport: { x: 12.345, y: -8.888, zoom: 1.23456 },
    failedRunCount: 2,
    outputAssetCount: 7,
    recentRuns: [{
      runId: 'run-failed',
      status: 'failed',
      nodeRunCount: 3,
      failedNodeCount: 1,
      outputAssetCount: 2,
    }],
  });
  assert.deepEqual(context.nodeTypeCounts, { image: 4, video: 3, story: 1 });
  assert.deepEqual(context.viewport, { x: 12.35, y: -8.89, zoom: 1.235 });
  assert.equal(context.failedRunCount, 2);
  assert.equal(context.outputAssetCount, 7);
  assert.deepEqual(context.recentRuns, [{
    runId: 'run-failed',
    status: 'failed',
    nodeRunCount: 3,
    failedNodeCount: 1,
    outputAssetCount: 2,
  }]);

  const suggestions = creatorSuggestionSet(context, { kind: 'image' });
  assert.deepEqual(
    suggestions.items.map((item) => item.id),
    ['recovery-explain', 'recovery-retry-scope', 'recovery-continue'],
  );
  assert.equal(suggestions.items.every((item) => item.arguments.planOnly === true), true);
  assert.match(suggestions.items[0].expectedEffect, /不启动重试/);
});

test('creator context prioritizes selected objects, locks and offscreen failures without raw media data', () => {
  const canvasObjects = Array.from({ length: 30 }, (_, index) => ({
    nodeId: `node-${index + 1}`,
    nodeType: index === 0 ? 'image' : 'output',
    label: index === 0 ? '主视觉海报' : `结果 ${index + 1}`,
    status: index === 1 ? 'failed' : 'completed',
    selected: index === 0,
    inViewport: index !== 1,
    mediaKinds: ['image', 'unsafe-kind'],
    resultCount: 1,
    accepted: index === 0,
    lockKeys: index === 0 ? ['composition', 'identity'] : [],
    upstreamCount: 1,
    downstreamCount: 2,
    prompt: 'must not persist',
    sourceUrl: 'https://signed.example/private',
  }));
  const context = normalizeContext({
    nodeCount: 30,
    edgeCount: 29,
    canvasObjects,
    offscreenSummary: {
      nodeCount: 1,
      failedCount: 0,
      outputCount: 1,
      lockedCount: 0,
    },
    recentActions: [{
      eventType: 'candidate.accepted',
      label: '已采用一个候选结果',
      createdAt: '2026-07-26T00:00:00.000Z',
      prompt: 'must not persist',
    }],
    assetLineage: [{
      assetId: 'asset-main',
      kind: 'image',
      label: '主视觉结果.png',
      eventCount: 2,
      relations: ['generated-from', 'generated-from'],
      parentAssetIds: ['asset-source'],
      sourceNodeIds: ['node-1'],
      runIds: ['run-1'],
      nodeRunIds: ['node-run-1'],
      derivedOperations: ['image-generation'],
      truncated: false,
      promptSummary: 'must not persist',
      sourceUrl: 'https://signed.example/private',
      metadata: {
        localPath: 'C:\\private\\asset.png',
      },
    }],
  });
  assert.equal(context.canvasObjects.length, 24);
  assert.deepEqual(context.canvasObjects[0], {
    nodeId: 'node-1',
    nodeType: 'image',
    label: '主视觉海报',
    status: 'completed',
    selected: true,
    inViewport: true,
    mediaKinds: ['image'],
    resultCount: 1,
    accepted: true,
    lockKeys: ['composition', 'identity'],
    upstreamCount: 1,
    downstreamCount: 2,
  });
  assert.equal('prompt' in context.canvasObjects[0], false);
  assert.equal('sourceUrl' in context.canvasObjects[0], false);
  assert.deepEqual(context.recentActions, [{
    eventType: 'candidate.accepted',
    label: '已采用一个候选结果',
    createdAt: '2026-07-26T00:00:00.000Z',
  }]);
  assert.deepEqual(context.assetLineage, [{
    assetId: 'asset-main',
    kind: 'image',
    label: '主视觉结果.png',
    eventCount: 2,
    relations: ['generated-from'],
    parentAssetIds: ['asset-source'],
    sourceNodeIds: ['node-1'],
    runIds: ['run-1'],
    nodeRunIds: ['node-run-1'],
    derivedOperations: ['image-generation'],
    truncated: false,
  }]);
  assert.equal('promptSummary' in context.assetLineage[0], false);
  assert.equal('sourceUrl' in context.assetLineage[0], false);
  assert.equal('metadata' in context.assetLineage[0], false);
  const suggestions = creatorSuggestionSet(context, { kind: 'image' });
  assert.deepEqual(
    suggestions.items.map((item) => item.id),
    ['selection-refine', 'selection-review', 'selection-missing'],
  );
  assert.match(suggestions.items[0].label, /主视觉海报/);
  assert.match(suggestions.items[0].label, /锁定/);
  assert.match(suggestions.items[0].label, /真实素材来源/);
});

test('creator sessions retain more than 500 lightweight message events without unbounded UI rendering', () => {
  const fixture = temporaryStore();
  try {
    const created = fixture.store.create({ projectId: 'project-long', canvasId: 'canvas-long' });
    for (let index = 0; index < 520; index += 1) {
      fixture.store.appendLifecycle(created.id, 'plan.previewed', { index });
    }
    const recovered = fixture.store.read(created.id);
    assert.equal(recovered.events.length, 521);
    assert.equal(recovered.events.at(-1).payload.index, 519);
  } finally {
    fixture.cleanup();
  }
});

test('attachments require durable references and never persist base64 bodies', () => {
  assert.throws(
    () => normalizeAttachments([{
      id: 'inline',
      kind: 'image',
      name: 'inline.png',
      ref: 'data:image/png;base64,AAAA',
    }]),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_ATTACHMENT_REF_REQUIRED',
  );

  assert.deepEqual(normalizeAttachments([{
    id: 'asset-1',
    assetId: 'project-asset-1',
    kind: 'video',
    name: 'shot.mov',
    ref: '/api/files/asset-1',
    mimeType: 'video/quicktime',
    size: 2048,
  }]), [{
    id: 'asset-1',
    assetId: 'project-asset-1',
    kind: 'video',
    name: 'shot.mov',
    ref: '/api/files/asset-1',
    mimeType: 'video/quicktime',
    size: 2048,
  }]);
});

test('attachment-only turns use one transparent prompt without leaking attachment identifiers', (t) => {
  const fixture = temporaryStore();
  t.after(() => fixture.cleanup());
  const attachments = normalizeAttachments([
    {
      id: 'private-image-id',
      assetId: 'private-asset-id',
      kind: 'image',
      name: 'private-character.png',
      ref: '/api/private/files/private-character',
      mimeType: 'image/png',
      size: 1024,
    },
    {
      id: 'private-audio-id',
      kind: 'audio',
      name: 'private-voice.wav',
      ref: '/api/private/files/private-voice',
      mimeType: 'audio/wav',
      size: 2048,
    },
  ]);
  const prompt = creatorAttachmentOnlyPrompt(attachments);
  assert.equal(
    prompt,
    '请分析我上传的1 张图片、1 段音频，先说明可直接使用的内容和缺失信息，再给出 3 个可执行的创作下一步；不要自动生成或修改画布。',
  );
  for (const privateValue of [
    'private-image-id',
    'private-asset-id',
    'private-character.png',
    '/api/private/files/private-character',
    'private-audio-id',
    'private-voice.wav',
    '/api/private/files/private-voice',
  ]) {
    assert.equal(prompt.includes(privateValue), false);
  }

  const appendedSession = fixture.store.create({
    projectId: 'project-attachment-only',
    canvasId: 'canvas-attachment-only',
  });
  const appended = fixture.store.appendTurn(appendedSession.id, {
    text: '',
    attachments,
  });
  assert.equal(appended.userEvent.payload.text, prompt);
  assert.deepEqual(appended.userEvent.payload.attachments, attachments);
  assert.equal(appended.userEvent.payload.inputMode, 'attachments-only');
  assert.equal(appended.session.title, '分析1 张图片、1 段音频');

  const streamingSession = fixture.store.create({
    projectId: 'project-attachment-stream',
    canvasId: 'canvas-attachment-stream',
  });
  const streaming = fixture.store.beginStreamingTurn(streamingSession.id, {
    text: '',
    attachments,
  });
  assert.equal(streaming.userEvent.payload.text, prompt);
  assert.deepEqual(streaming.userEvent.payload.attachments, attachments);
  assert.equal(streaming.userEvent.payload.inputMode, 'attachments-only');
  assert.equal(streaming.session.title, '分析1 张图片、1 段音频');
  assert.equal(streaming.startedEvent.type, 'assistant.response.started');

  assert.equal(creatorAttachmentOnlyPrompt([]), '');
  const emptySession = fixture.store.create({
    projectId: 'project-empty-message',
    canvasId: 'canvas-empty-message',
  });
  assert.throws(
    () => fixture.store.appendTurn(emptySession.id, {
      text: '',
      attachments: [],
    }),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_MESSAGE_EMPTY'
      && /输入创作要求，或添加一个已上传附件/.test(error.message),
  );
});

test('verified Run links are durable and idempotent within one Creator Session', (t) => {
  const fixture = temporaryStore();
  t.after(() => fixture.cleanup());
  const created = fixture.store.create({
    projectId: 'project-local',
    canvasId: 'canvas-a',
    context: { nodeCount: 1, edgeCount: 0 },
  });
  const payload = {
    planId: 'plan-a',
    planDigest: 'digest-a',
    patchId: 'patch-a',
    runId: 'run-a',
    runIntentId: 'intent-a',
    matchedNodeIds: ['node-a', 'node-a'],
  };
  const linked = fixture.store.appendLifecycle(created.id, 'run.linked', payload);
  const repeated = fixture.store.appendLifecycle(created.id, 'run.linked', payload);

  assert.equal(linked.runLinks.length, 1);
  assert.deepEqual(linked.runLinks[0], {
    schema: 't8-creator-run-link-v1',
    planId: 'plan-a',
    planDigest: 'digest-a',
    patchId: 'patch-a',
    runId: 'run-a',
    runIntentId: 'intent-a',
    matchedNodeIds: ['node-a'],
    linkedAt: linked.runLinks[0].linkedAt,
  });
  assert.equal(repeated.runLinks.length, 1);
  assert.equal(repeated.events.filter((event) => event.type === 'run.linked').length, 1);
  assert.equal(fixture.store.read(created.id).runLinks[0].runId, 'run-a');

  const verification = {
    verified: true,
    reasons: [],
    run: {
      runId: 'run-a',
      status: 'succeeded',
      canvasRevision: 9,
      createdAt: 1,
      finishedAt: 2,
    },
    nodeRuns: [{
      nodeRunId: 'node-run-a',
      nodeId: 'node-a',
      status: 'succeeded',
      latestAttemptId: 'attempt-a',
      latestAttemptStatus: 'succeeded',
      outputAssetIds: ['asset-a'],
    }],
    assets: [{
      assetId: 'asset-a',
      nodeRunId: 'node-run-a',
      kind: 'image',
      mimeType: 'image/png',
      contentHash: 'a'.repeat(64),
      availability: 'available',
      stored: true,
      blobPresent: true,
      hashVerified: true,
      magicVerified: true,
      detectedKind: 'image',
      detectedMimeType: 'image/png',
      observedContentHash: 'a'.repeat(64),
      byteSize: 68,
      decodeEvidence: 'indexed-parser-verified',
      associationVerified: true,
      expectedNodeId: 'node-a',
      expectedShotIds: [],
      observedShotIds: [],
      expectedCanvasRevision: 9,
    }],
  };
  const verified = fixture.store.appendLifecycle(created.id, 'run.artifacts-verified', {
    runId: 'run-a',
    verification,
  });
  const verifiedAgain = fixture.store.appendLifecycle(created.id, 'run.artifacts-verified', {
    runId: 'run-a',
    verification,
  });
  assert.equal(verified.artifactVerifications.length, 1);
  assert.equal(verified.artifactVerifications[0].verified, true);
  assert.equal(verified.artifactVerifications[0].assets[0].hashVerified, true);
  assert.equal(verifiedAgain.artifactVerifications.length, 1);
  assert.equal(verifiedAgain.events.filter((event) => event.type === 'run.artifacts-verified').length, 1);
});

test('creator session survives store recreation and keeps append-only event evidence', (t) => {
  const fixture = temporaryStore();
  t.after(() => fixture.cleanup());

  const created = fixture.store.create({
    projectId: 'project-local',
    canvasId: 'canvas-a',
    context: {
      nodeCount: 2,
      edgeCount: 1,
      selectedNodeIds: ['node-a'],
      selectedNodeTypes: ['image'],
      canvasTitle: '雨夜广告',
    },
  });
  assert.equal(created.suggestions.length, 3);
  assert.equal(created.lastSequence, 1);
  assert.equal(created.events[0].type, 'session.created');

  const plan = {
    planId: 'plan-a',
    kind: 'story',
    ready: true,
    candidateCount: 3,
    questions: [],
  };
  const turn = fixture.store.appendTurn(created.id, {
    text: '把这句话做成 30 秒竖屏短片',
    attachments: [{
      id: 'script-1',
      kind: 'text',
      name: 'brief.md',
      ref: '/api/files/brief-1',
      mimeType: 'text/markdown',
      size: 128,
    }],
    context: { phase: 'story' },
    plan,
  });
  assert.equal(turn.session.lastSequence, 3);
  assert.equal(turn.session.events.map((event) => event.type).join(','), [
    'session.created',
    'user.message',
    'assistant.plan',
  ].join(','));
  assert.equal(turn.session.suggestions.length, 3);
  assert.equal(turn.session.latestPlan.planId, 'plan-a');

  const recoveredStore = createCreatorAgentSessionStore({ rootDir: fixture.rootDir });
  const recovered = recoveredStore.read(created.id);
  assert.equal(recovered.title, '把这句话做成 30 秒竖屏短片');
  assert.equal(recovered.lastSequence, 3);
  assert.equal(recovered.latestPlan.planId, 'plan-a');
  assert.equal(recovered.events[1].payload.attachments[0].ref, '/api/files/brief-1');

  const eventPath = path.join(fixture.rootDir, 'events', `${created.id}.jsonl`);
  const eventLines = fs.readFileSync(eventPath, 'utf8').trim().split(/\r?\n/);
  assert.equal(eventLines.length, 3);
  assert.deepEqual(eventLines.map((line) => JSON.parse(line).sequence), [1, 2, 3]);
});

test('production document confirmation is exact, idempotent, persisted, and never mutates the plan digest', (t) => {
  const fixture = temporaryStore();
  t.after(() => fixture.cleanup());
  const created = fixture.store.create({
    projectId: 'project-local',
    canvasId: 'canvas-doc-confirm',
  });
  const content = { goal: '做一支雨夜短片' };
  const contentDigest = crypto.createHash('sha256')
    .update(JSON.stringify({ content, kind: 'production-brief' }))
    .digest('hex');
  const document = {
    schema: 't8-creator-production-document-v1',
    id: 'document-brief',
    kind: 'production-brief',
    label: '制作需求',
    revision: 1,
    versionId: 'document-brief-v1',
    status: 'draft',
    contentDigest,
    content,
  };
  const plan = {
    planId: 'plan-doc-confirm',
    planDigest: 'a'.repeat(64),
    kind: 'story',
    ready: true,
    candidateCount: 1,
    questions: [],
    productionDocuments: [document],
  };
  const planned = fixture.store.appendTurn(created.id, {
    text: '做一支雨夜短片',
    plan,
  }).session;
  const confirmed = fixture.store.confirmProductionDocuments(created.id, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    documents: [{
      documentId: document.id,
      versionId: document.versionId,
      contentDigest,
    }],
    actor: 'canvas-ui',
  });
  assert.equal(confirmed.duplicate, false);
  assert.equal(confirmed.confirmations.length, 1);
  assert.equal(confirmed.session.latestPlan.planDigest, plan.planDigest);
  assert.equal(confirmed.session.latestPlan.productionDocuments[0].status, 'draft');
  assert.equal(confirmed.session.productionDocumentConfirmations.length, 1);
  assert.equal(confirmed.session.events.at(-1).type, 'production-documents.confirmed');
  assert.equal(confirmed.session.events.at(-1).payload.providerCalls, 0);
  assert.equal(confirmed.session.events.at(-1).payload.canvasWrites, 0);
  assert.equal(fixture.store.productionDocumentsForNextPlan(created.id)[0].status, 'confirmed');

  const sequence = confirmed.session.lastSequence;
  const duplicate = fixture.store.confirmProductionDocuments(created.id, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    documents: [{
      documentId: document.id,
      versionId: document.versionId,
      contentDigest,
    }],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.session.lastSequence, sequence);

  const recovered = createCreatorAgentSessionStore({ rootDir: fixture.rootDir });
  assert.equal(recovered.read(created.id).productionDocumentConfirmations.length, 1);
  assert.equal(recovered.productionDocumentsForNextPlan(created.id)[0].status, 'confirmed');
  assert.throws(
    () => recovered.confirmProductionDocuments(created.id, {
      planId: plan.planId,
      planDigest: 'b'.repeat(64),
      documents: [{
        documentId: document.id,
        versionId: document.versionId,
        contentDigest,
      }],
    }),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_PRODUCTION_DOCUMENT_STALE'
      && error.status === 409,
  );
  assert.equal(planned.events.filter((event) => event.type === 'assistant.plan').length, 1);
});

test('natural-language creator routing covers Story, image, video and audio without setup syntax', () => {
  assert.equal(inferCreatorKind('把这个剧本做成完整短片'), 'story');
  assert.equal(inferCreatorKind('做一张雨夜电影海报'), 'image');
  assert.equal(inferCreatorKind('让镜头缓慢推进并生成视频'), 'video');
  assert.equal(inferCreatorKind('生成旁白、对白和环境音'), 'audio');
  assert.equal(inferCreatorKind('替换图片背景', [{ kind: 'image' }]), 'edit-image');
  assert.equal(inferCreatorKind('修改这个视频片段', [{ kind: 'video' }]), 'edit-video');
  assert.equal(inferCreatorKind('把当前画布已验证素材打包交付'), 'delivery');
});

test('one-sentence creator recipes cover LibTV-style starts and TapNow-style reference breakdown', () => {
  assert.equal(inferCreatorRecipe('把两个朋友的故事做成 30 秒竖屏短片', 'story'), 'short-drama');
  assert.equal(inferCreatorRecipe('为透明折叠伞做 20 秒品牌广告片', 'story'), 'tvc');
  assert.equal(inferCreatorRecipe('帮我拉片，只学习镜头语言', 'story', [{ kind: 'video' }]), 'shot-breakdown');
  assert.equal(inferCreatorRecipe('分析这段参考视频的运镜和节奏', 'story', [{ kind: 'video' }]), 'shot-breakdown');
  assert.equal(inferCreatorRecipe('做一张角色三视图', 'image'), 'character-sheet');
  assert.equal(inferCreatorRecipe('做一个科普视频', 'story'), 'education');
  assert.equal(inferCreatorRecipe('普通自由创作', 'story'), 'general');
});

test('creator session advances only after canonical production evidence', (t) => {
  const fixture = temporaryStore();
  t.after(() => fixture.cleanup());

  const created = fixture.store.create({
    projectId: 'project-local',
    canvasId: 'canvas-phase',
    context: { phase: 'idea' },
  });
  assert.equal(created.phase, 'idea');
  assert.equal(created.production.currentPhase, 'idea');
  assert.deepEqual(created.production.completedPhases, []);

  const plan = {
    planId: 'plan-story',
    action: 'create.story',
    kind: 'story',
    ready: true,
    questions: [],
    analysis: { stage: 'assets' },
  };
  const turn = fixture.store.appendTurn(created.id, {
    text: '把这个故事做成一支短片',
    context: { phase: 'idea' },
    plan,
  });
  assert.equal(turn.session.status, 'planned');
  assert.equal(turn.session.phase, 'idea');
  assert.equal(turn.session.production.currentPhase, 'idea');
  assert.deepEqual(turn.session.production.completedPhases, []);

  const previewed = fixture.store.appendLifecycle(created.id, 'plan.previewed', {
    planId: plan.planId,
    previewDigest: 'preview-a',
  });
  assert.equal(previewed.status, 'previewed');
  assert.equal(previewed.phase, 'idea');

  const failed = fixture.store.appendLifecycle(created.id, 'plan.failed', {
    planId: plan.planId,
    error: 'revision 已变化',
  });
  assert.equal(failed.status, 'active');
  assert.equal(failed.lastFailure.message, 'revision 已变化');
  assert.equal(failed.production.currentPhase, 'idea');
  assert.equal(failed.production.blocked.message, 'revision 已变化');

  const applied = fixture.store.appendLifecycle(created.id, 'plan.applied', {
    planId: plan.planId,
    productionEvidence: {
      schema: 't8-creator-production-evidence-v1',
      source: 'canonical-canvas-evidence',
      verified: true,
      authoritative: true,
      lifecycleType: 'plan.applied',
      action: 'create.story',
      kind: 'story',
      currentPhase: 'assets',
      completedPhases: ['idea', 'script'],
      affectedNodeIds: ['story-a'],
      canvasRevision: 2,
      documentVerified: true,
      story: {
        verified: true,
        nodeIds: ['story-a'],
        scriptReady: true,
        assetsReady: false,
        promptsReady: false,
        videosReady: false,
        finalVideoReady: false,
        snapshots: [],
      },
      candidates: {
        acceptedNodeIds: [],
        reviewedNodeIds: [],
        acceptedAndReviewed: false,
      },
    },
  });
  assert.equal(applied.status, 'active');
  assert.equal(applied.phase, 'assets');
  assert.deepEqual(applied.production.completedPhases, ['idea', 'script']);
  assert.equal(applied.lastFailure, null);
  assert.equal(applied.production.blocked, null);

  const delivered = fixture.store.appendLifecycle(created.id, 'artifact.sent-to-canvas', {
    planId: 'plan-story-progress',
    planDigest: 'b'.repeat(64),
    patchId: 'patch-story-progress',
    assetId: 'asset-final',
    contentHash: 'c'.repeat(64),
    nodeId: 'output-final',
    appliedRevision: 2,
  });
  assert.equal(delivered.phase, 'assets');
  assert.equal(delivered.production.currentPhase, 'assets');
  assert.equal(delivered.production.checkpoint.type, 'artifact.sent-to-canvas');
  assert.equal(delivered.events.at(-1).type, 'artifact.sent-to-canvas');

  assert.equal(phaseForPlan({ kind: 'story', analysis: { stage: 'prompts' } }), 'shots');
  assert.equal(phaseForPlan({ kind: 'video' }), 'candidates');
  assert.equal(phaseForPlan({ kind: 'delivery' }), 'delivery');
});

test('creator production ignores planned phase skips and invalidates downstream only after applied revision evidence', (t) => {
  const fixture = temporaryStore();
  t.after(() => fixture.cleanup());

  const created = fixture.store.create({
    projectId: 'project-local',
    canvasId: 'canvas-production',
    context: { phase: 'delivery' },
  });
  assert.equal(created.phase, 'idea');
  assert.equal(created.production.currentPhase, 'idea');

  const generated = fixture.store.appendTurn(created.id, {
    text: '先进入候选制作',
    context: { phase: 'delivery' },
    plan: {
      planId: 'plan-candidates',
      kind: 'story',
      ready: true,
      questions: [],
      analysis: { stage: 'candidates' },
    },
  }).session;
  assert.equal(generated.phase, 'idea');
  assert.deepEqual(generated.production.completedPhases, []);
  const generatedApplied = fixture.store.appendLifecycle(created.id, 'plan.applied', {
    planId: 'plan-candidates',
    productionEvidence: {
      schema: 't8-creator-production-evidence-v1',
      source: 'canonical-canvas-evidence',
      verified: true,
      authoritative: false,
      lifecycleType: 'plan.applied',
      action: 'accept',
      kind: 'image',
      currentPhase: 'candidates',
      completedPhases: ['idea', 'candidates'],
      affectedNodeIds: ['candidate-a'],
      documentVerified: true,
      story: { verified: false, snapshots: [] },
      candidates: {
        acceptedNodeIds: ['candidate-a'],
        reviewedNodeIds: ['candidate-a'],
        acceptedAndReviewed: true,
      },
    },
  });
  assert.equal(generatedApplied.phase, 'candidates');
  assert.deepEqual(generatedApplied.production.completedPhases, ['idea', 'candidates']);

  const revisedPlan = fixture.store.appendTurn(created.id, {
    text: '返回剧本阶段修改人物动机',
    context: { phase: 'delivery' },
    plan: {
      planId: 'plan-revise-script',
      kind: 'story',
      ready: true,
      questions: [],
      analysis: { stage: 'script' },
    },
  }).session;
  assert.equal(revisedPlan.phase, 'candidates');
  assert.deepEqual(revisedPlan.production.completedPhases, ['idea', 'candidates']);
  const revised = fixture.store.appendLifecycle(created.id, 'plan.applied', {
    planId: 'plan-revise-script',
    productionEvidence: {
      schema: 't8-creator-production-evidence-v1',
      source: 'canonical-canvas-evidence',
      verified: true,
      authoritative: true,
      lifecycleType: 'plan.applied',
      action: 'story.analyze',
      kind: 'story',
      currentPhase: 'script',
      completedPhases: ['idea'],
      affectedNodeIds: ['story-a'],
      documentVerified: true,
      story: {
        verified: true,
        nodeIds: ['story-a'],
        scriptReady: false,
        assetsReady: false,
        promptsReady: false,
        videosReady: false,
        finalVideoReady: false,
        snapshots: [],
      },
      candidates: {
        acceptedNodeIds: [],
        reviewedNodeIds: [],
        acceptedAndReviewed: false,
      },
    },
  });
  assert.equal(revised.phase, 'script');
  assert.deepEqual(revised.production.completedPhases, ['idea']);
  assert.deepEqual(
    revised.production.invalidatedPhases,
    ['candidates'],
  );
  assert.equal(revised.production.history.at(-1).direction, 'revise');

  const needsInput = fixture.store.appendTurn(created.id, {
    text: '直接跳到交付',
    context: { phase: 'delivery' },
    plan: {
      planId: 'plan-not-ready',
      kind: 'delivery',
      ready: false,
      questions: [{ question: '请先确认交付范围' }],
    },
  }).session;
  assert.equal(needsInput.phase, 'script');
  assert.equal(needsInput.production.currentPhase, 'script');
  assert.equal(needsInput.production.blocked.message, '请先确认交付范围');

  const reopened = createCreatorAgentSessionStore({ rootDir: fixture.rootDir }).read(created.id);
  assert.deepEqual(reopened.production, needsInput.production);
  assert.equal(reopened.phase, 'script');
  assert.equal(JSON.stringify(reopened.production).includes('context.phase'), false);
});

test('legacy creator production state normalizes without inventing completed phases', () => {
  const normalized = normalizeCreatorProductionState(null, 'shots');
  assert.equal(normalized.currentPhase, 'shots');
  assert.deepEqual(normalized.visitedPhases, ['shots']);
  assert.deepEqual(normalized.completedPhases, []);
  assert.deepEqual(normalized.invalidatedPhases, []);
});

test('delivery suggestions and lifecycle keep exact physical evidence without persisting local paths', (t) => {
  const fixture = temporaryStore();
  t.after(() => fixture.cleanup());

  const suggestions = creatorSuggestionSet({}, { kind: 'delivery' });
  assert.deepEqual(
    suggestions.items.map((item) => item.id),
    ['delivery-review', 'delivery-verified-only', 'delivery-verify'],
  );
  assert.equal(suggestions.items.every((item) => (
    item.requiredCapabilityIds.length === 1
    && item.requiredCapabilityIds[0] === 'delivery.package'
  )), true);

  const created = fixture.store.create({
    projectId: 'project-local',
    canvasId: 'canvas-delivery',
  });
  const requested = fixture.store.appendLifecycle(created.id, 'delivery.approval-requested', {
    approvalRequestId: 'approval-a',
    planId: 'plan-delivery',
    packageName: 'canvas-delivery-package',
    itemCount: 2,
    totalBytes: 3072,
    licenseSummary: { known: 1, unknown: 1 },
    expiresAt: '2027-01-01T00:00:00.000Z',
    target: { absolute: 'C:\\Users\\creator\\Desktop\\private-package' },
  });
  assert.equal(requested.status, 'awaiting-approval');
  assert.equal(requested.phase, 'delivery');
  assert.equal(requested.deliveryEvidence.length, 0);
  assert.equal(
    JSON.stringify(requested.events.at(-1)).includes('private-package'),
    false,
  );

  const completed = fixture.store.appendLifecycle(created.id, 'delivery.completed', {
    approvalRequestId: 'approval-a',
    planId: 'plan-delivery',
    packageName: 'canvas-delivery-package',
    itemCount: 2,
    totalBytes: 3072,
    packageDigest: 'a'.repeat(64),
    verifiedItems: 2,
    verifiedBytes: 3072,
    valid: true,
    licenseSummary: { known: 1, unknown: 1 },
    targetPath: 'C:\\Users\\creator\\Desktop\\private-package',
  });
  const repeated = fixture.store.appendLifecycle(created.id, 'delivery.completed', {
    approvalRequestId: 'approval-a',
    planId: 'plan-delivery',
    packageName: 'canvas-delivery-package',
    itemCount: 2,
    totalBytes: 3072,
    packageDigest: 'a'.repeat(64),
    verifiedItems: 2,
    verifiedBytes: 3072,
    valid: true,
    licenseSummary: { known: 1, unknown: 1 },
  });
  assert.equal(completed.deliveryEvidence.length, 1);
  assert.equal(completed.deliveryEvidence[0].status, 'completed');
  assert.equal(completed.deliveryEvidence[0].valid, true);
  assert.equal(completed.deliveryEvidence[0].packageDigest, 'a'.repeat(64));
  assert.equal(JSON.stringify(completed).includes('private-package'), false);
  assert.equal(completed.production.currentPhase, 'delivery');
  assert.equal(completed.production.completedPhases.includes('delivery'), true);
  assert.equal(completed.production.checkpoint.type, 'delivery.completed');
  assert.equal(
    repeated.events.filter((event) => event.type === 'delivery.completed').length,
    1,
  );
});

test('zcanvas session ids, authoritative patch snapshots and latest-session lookup share one store', (t) => {
  const fixture = temporaryStore();
  t.after(() => fixture.cleanup());

  const created = fixture.store.create({
    sessionId: 'cs_0123456789abcdefghijklmnop',
    projectId: 'project-local',
    canvasId: 'canvas-shared',
    source: 'zcanvas',
    context: { phase: 'story' },
  });
  assert.equal(created.id, 'cs_0123456789abcdefghijklmnop');
  assert.equal(created.source, 'zcanvas');

  const plan = {
    schema: 't8-agent-creative-plan-v1',
    planId: 'plan-shared',
    planDigest: 'a'.repeat(64),
    projectId: 'project-local',
    canvasId: 'canvas-shared',
    kind: 'story',
    ready: true,
    questions: [],
  };
  const patch = {
    schema: 't8-canvas-patch-v1',
    id: 'patch-shared',
    baseRevision: 7,
    summary: '共享创作计划',
    requiresConfirmation: true,
    operations: [{
      type: 'node.add',
      payload: { node: { id: 'story-shared', type: 'story', data: {} } },
    }],
  };
  const turn = fixture.store.appendTurn(created.id, {
    text: '一句话生成雨夜短片',
    plan,
    patch,
    source: 'zcanvas',
  });
  assert.equal(turn.session.latestPatch.id, 'patch-shared');
  assert.equal(turn.session.latestPlan.planId, 'plan-shared');

  const latest = fixture.store.list({
    projectId: 'project-local',
    canvasId: 'canvas-shared',
    limit: 1,
  });
  assert.equal(latest.length, 1);
  assert.equal(latest[0].id, created.id);
  assert.equal(latest[0].latestPatch.operations[0].payload.node.id, 'story-shared');
  assert.equal(latest[0].suggestionSet.items.length, 3);

  const events = fixture.store.eventsAfter(created.id, 1, 10);
  assert.equal(events.cursorReset, false);
  assert.deepEqual(events.events.map((event) => event.sequence), [2, 3]);
});

test('assistant response deltas are durable, ordered, idempotent and resumable by cursor', (t) => {
  const fixture = temporaryStore();
  t.after(fixture.cleanup);
  const created = fixture.store.create({
    projectId: 'project-local',
    canvasId: 'canvas-stream',
    context: { nodeCount: 0, edgeCount: 0 },
  });
  const plan = {
    planId: 'plan-stream',
    kind: 'story',
    ready: true,
    candidateCount: 3,
    questions: [],
  };
  const begun = fixture.store.beginStreamingTurn(created.id, {
    text: '一句话做一个雨夜短片',
    context: { phase: 'story' },
    plan,
  });
  assert.equal(begun.startedEvent.type, 'assistant.response.started');
  assert.equal(begun.startedEvent.payload.providerCalls, 0);
  assert.ok(begun.chunks.length > 1);
  assert.ok(begun.chunks.length <= 8);

  let firstDelta;
  begun.chunks.forEach((delta, index) => {
    const result = fixture.store.appendResponseDelta(created.id, {
      responseId: begun.responseId,
      index,
      delta,
    });
    if (index === 0) firstDelta = result.event;
  });
  const duplicate = fixture.store.appendResponseDelta(created.id, {
    responseId: begun.responseId,
    index: 0,
    delta: begun.chunks[0],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.eventId, firstDelta.eventId);

  const completed = fixture.store.completeStreamingTurn(created.id, {
    responseId: begun.responseId,
    context: { phase: 'story' },
    plan,
  });
  assert.equal(completed.assistantEvent.type, 'assistant.response.completed');
  assert.equal(completed.assistantEvent.payload.providerCalls, 0);
  assert.equal(completed.session.latestPlan.planId, 'plan-stream');
  assert.equal(completed.session.status, 'planned');

  const recovered = createCreatorAgentSessionStore({ rootDir: fixture.rootDir }).read(created.id);
  const responseEvents = recovered.events.filter((event) => event.payload?.responseId === begun.responseId);
  assert.equal(responseEvents.filter((event) => event.type === 'assistant.response.started').length, 1);
  assert.equal(responseEvents.filter((event) => event.type === 'assistant.response.completed').length, 1);
  assert.equal(responseEvents.filter((event) => event.type === 'assistant.response.delta')
    .map((event) => event.payload.delta).join(''), completed.assistantEvent.payload.text);
  const resumed = fixture.store.eventsAfter(created.id, begun.startedEvent.sequence, 100);
  assert.equal(resumed.cursorReset, false);
  assert.equal(resumed.events.at(-1).type, 'assistant.response.completed');
});

test('stopping a local assistant reply is durable, idempotent and never completes its plan', (t) => {
  const fixture = temporaryStore();
  t.after(fixture.cleanup);
  const created = fixture.store.create({
    projectId: 'project-local',
    canvasId: 'canvas-stop-response',
    context: { nodeCount: 0, edgeCount: 0 },
  });
  const plan = {
    planId: 'plan-stop-response',
    kind: 'story',
    ready: true,
    candidateCount: 3,
    questions: [],
  };
  const clientRequestId = 'creator-stop-response-0001';
  const requestDigest = 'c'.repeat(64);
  const begun = fixture.store.beginStreamingTurn(created.id, {
    text: '把这句话做成一支雨夜短片',
    context: { phase: 'story' },
    plan,
    clientRequestId,
    requestDigest,
  });
  fixture.store.appendResponseDelta(created.id, {
    responseId: begun.responseId,
    index: 0,
    delta: begun.chunks[0],
  });

  const stopped = fixture.store.stopStreamingTurn(created.id, {
    responseId: begun.responseId,
  });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.duplicate, false);
  assert.equal(stopped.assistantEvent.type, 'assistant.response.stopped');
  assert.equal(stopped.assistantEvent.payload.text, begun.chunks[0]);
  assert.equal(stopped.assistantEvent.payload.providerCalls, 0);
  assert.equal(stopped.assistantEvent.payload.remoteTasksAffected, 0);
  assert.equal(stopped.session.status, 'needs-input');
  assert.equal(stopped.session.latestPlan, null);

  const duplicate = fixture.store.stopStreamingTurn(created.id, {
    responseId: begun.responseId,
  });
  assert.equal(duplicate.status, 'stopped');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.assistantEvent.eventId, stopped.assistantEvent.eventId);

  const completionRace = fixture.store.completeStreamingTurn(created.id, {
    responseId: begun.responseId,
    context: { phase: 'story' },
    plan,
  });
  assert.equal(completionRace.status, 'stopped');
  assert.equal(completionRace.assistantEvent.eventId, stopped.assistantEvent.eventId);
  assert.equal(completionRace.session.latestPlan, null);
  assert.throws(
    () => fixture.store.appendResponseDelta(created.id, {
      responseId: begun.responseId,
      index: 1,
      delta: begun.chunks[1],
    }),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_RESPONSE_ALREADY_FINISHED',
  );
  const recovered = fixture.store.messageRequest(created.id, {
    clientRequestId,
    requestDigest,
  });
  assert.equal(recovered.status, 'stopped');
  assert.equal(recovered.assistantEvent.eventId, stopped.assistantEvent.eventId);
});

test('creator message request recovery binds one logical request to one durable response', (t) => {
  const fixture = temporaryStore();
  t.after(fixture.cleanup);
  const created = fixture.store.create({
    projectId: 'project-local',
    canvasId: 'canvas-request-recovery',
    context: { nodeCount: 0, edgeCount: 0 },
  });
  const plan = {
    planId: 'plan-request-recovery',
    kind: 'story',
    ready: true,
    candidateCount: 3,
    questions: [],
  };
  const clientRequestId = 'creator-request-recovery-0001';
  const requestDigest = 'a'.repeat(64);
  const begun = fixture.store.beginStreamingTurn(created.id, {
    text: '把一句话做成可编辑的雨夜短片',
    context: { phase: 'story' },
    plan,
    clientRequestId,
    requestDigest,
  });
  const inProgress = fixture.store.messageRequest(created.id, {
    clientRequestId,
    requestDigest,
  });
  assert.equal(inProgress.schema, 't8-creator-message-request-v1');
  assert.equal(inProgress.status, 'in-progress');
  assert.equal(inProgress.responseId, begun.responseId);
  assert.equal(inProgress.userEvent.payload.clientRequestId, clientRequestId);
  assert.equal(inProgress.assistantEvent.type, 'assistant.response.started');

  begun.chunks.forEach((delta, index) => fixture.store.appendResponseDelta(created.id, {
    responseId: begun.responseId,
    index,
    delta,
  }));
  fixture.store.completeStreamingTurn(created.id, {
    responseId: begun.responseId,
    context: { phase: 'story' },
    plan,
  });
  const completed = fixture.store.messageRequest(created.id, {
    clientRequestId,
    requestDigest,
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.responseId, begun.responseId);
  assert.equal(completed.assistantEvent.type, 'assistant.response.completed');
  assert.throws(
    () => fixture.store.messageRequest(created.id, {
      clientRequestId,
      requestDigest: 'b'.repeat(64),
    }),
    (error) => error instanceof CreatorAgentSessionError
      && error.code === 'CREATOR_MESSAGE_IDEMPOTENCY_CONFLICT'
      && error.statusCode === 409,
  );
});

test('linked Run events advance a durable per-Run cursor and coalesce noisy progress', (t) => {
  const fixture = temporaryStore();
  t.after(fixture.cleanup);
  const created = fixture.store.create({
    projectId: 'project-local',
    canvasId: 'canvas-run-cursor',
    context: { nodeCount: 1, edgeCount: 0 },
  });
  fixture.store.appendLifecycle(created.id, 'run.linked', {
    planId: 'plan-run-cursor',
    planDigest: 'b'.repeat(64),
    patchId: 'patch-run-cursor',
    runId: 'run-cursor-a',
    runIntentId: 'intent-run-cursor',
    matchedNodeIds: ['node-a'],
  });
  const first = fixture.store.appendRunEvents(created.id, [
    {
      id: 20,
      entityUid: 'event-run-queued',
      runId: 'run-cursor-a',
      nodeRunId: null,
      type: 'run.queued',
      payload: {
        status: 'queued',
        message: '下载 https://signed.example/result?token=private，凭据 sk-1234567890abcdef',
      },
      createdAt: 20,
    },
    {
      id: 21,
      runId: 'run-cursor-a',
      type: 'provider.polling',
      payload: { status: 'processing', pollCount: 8 },
      createdAt: 21,
    },
    {
      id: 22,
      runId: 'run-cursor-a',
      nodeRunId: 'node-run-a',
      type: 'log',
      payload: { phase: 'progress', videoOperation: { progress: 14, status: 'running' } },
      createdAt: 22,
    },
    {
      id: 23,
      runId: 'run-cursor-a',
      nodeRunId: 'node-run-a',
      type: 'log',
      payload: { phase: 'progress', videoOperation: { progress: 18, status: 'running' } },
      createdAt: 23,
    },
    {
      id: 24,
      runId: 'run-cursor-a',
      nodeRunId: 'node-run-a',
      type: 'node.succeeded',
      payload: { status: 'succeeded', outputRefs: ['asset-a'] },
      createdAt: 24,
    },
  ]);
  assert.equal(first.events.length, 3);
  assert.equal(first.session.runEventCursors['run-cursor-a'], 24);
  assert.deepEqual(first.events.map((event) => event.payload.sourceEventId), [20, 22, 24]);
  assert.doesNotMatch(first.events[0].payload.message, /signed\.example|1234567890abcdef/);
  assert.match(first.events[0].payload.message, /远程地址已隐藏|凭据已隐藏/);
  assert.equal(fixture.store.appendRunEvents(created.id, [{
    id: 24, runId: 'run-cursor-a', type: 'node.succeeded', payload: { status: 'succeeded' },
  }]).events.length, 0);
  const recovered = createCreatorAgentSessionStore({ rootDir: fixture.rootDir }).read(created.id);
  assert.equal(recovered.runEventCursors['run-cursor-a'], 24);
  assert.equal(recovered.events.filter((event) => event.type === 'run.event').length, 3);
});

test('reference video breakdown suggestions stay bound to analysis-only follow-ups', () => {
  const suggestions = creatorSuggestionSet({}, {
    kind: 'story',
    planDigest: 'plan-breakdown-digest',
    brief: { recipe: 'shot-breakdown' },
  });

  assert.deepEqual(suggestions.items.map((item) => item.label), [
    '只学习参考视频的节奏和剪辑密度',
    '只提取镜头语言、景别和运镜规则',
    '核对拉片结果后继续规划关键帧和视频，不立即生成',
  ]);
  assert.deepEqual(suggestions.items.map((item) => item.intent), [
    'reference-breakdown.rhythm',
    'reference-breakdown.camera-language',
    'reference-breakdown.continue-production',
  ]);
  assert.deepEqual(suggestions.items.map((item) => item.executable), [true, true, false]);
  assert.equal(suggestions.items[2].blockers[0].code, 'reference-breakdown-result-missing');
  assert.equal(suggestions.items.every((item) => item.riskLevel === 'L0-intent'), true);
  assert.equal(suggestions.providerCalls, 0);
});

test('reference video breakdown continue-production unlocks only for a verified current document', () => {
  const content = {
    status: 'analysis-result-ready',
    sourceBinding: {
      assetId: 'asset-reference-video',
      contentRevision: 4,
      contentHash: 'b'.repeat(64),
    },
    shots: [{
      ordinal: 1,
      startTimecode: '00:00:00.000',
      endTimecode: '00:00:03.000',
      action: '人物进入画面',
    }],
    resultEvidence: {
      schema: 't8-reference-video-breakdown-evidence-v1',
      runBindingStatus: 'verified',
      runId: 'run-reference',
      nodeRunId: 'node-run-reference',
      attemptId: 'attempt-reference',
    },
  };
  const document = {
    schema: 't8-creator-production-document-v1',
    kind: 'reference-breakdown',
    content,
    contentDigest: stableTestDigest({ kind: 'reference-breakdown', content }),
  };
  const suggestions = creatorSuggestionSet({}, {
    kind: 'story',
    planDigest: 'plan-breakdown-verified',
    brief: { recipe: 'shot-breakdown' },
    productionDocuments: [document],
  });

  assert.equal(suggestions.items[2].intent, 'reference-breakdown.continue-production');
  assert.equal(suggestions.items[2].executable, true);
  assert.deepEqual(suggestions.items[2].blockers, []);

  const pendingContent = structuredClone(content);
  pendingContent.resultEvidence.runBindingStatus = 'pending';
  pendingContent.resultEvidence.runEvidenceReason = '目标节点仍在运行';
  const pending = creatorSuggestionSet({}, {
    kind: 'story',
    planDigest: 'plan-breakdown-pending',
    brief: { recipe: 'shot-breakdown' },
    productionDocuments: [{
      ...document,
      content: pendingContent,
      contentDigest: stableTestDigest({ kind: 'reference-breakdown', content: pendingContent }),
    }],
  });
  assert.equal(pending.items[2].executable, false);
  assert.equal(pending.items[2].blockers[0].code, 'reference-breakdown-run-evidence-required');
  assert.match(pending.items[2].disabledReason, /仍在运行/);
});
