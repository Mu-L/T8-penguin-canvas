const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  IdentityMigrationError,
  MIGRATION_CONTRACT,
  migrateLegacyProjectDocument,
  parseCanonicalProjectDocument,
  serializeCanonicalProjectDocument,
  stableProjectEntityUuid,
  validateCanonicalProjectDocument,
} = require('../backend/src/services/projectIdentityMigration');

const FIXTURE_DIRECTORY = path.join(__dirname, 'fixtures', 'canvas-v1');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fixtureFiles() {
  return fs.readdirSync(FIXTURE_DIRECTORY)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIRECTORY, name), 'utf8'));
}

function assertUuid(value, label) {
  assert.match(value, UUID, `${label} must be an RFC4122 UUID`);
}

function allIdentityRecords(document) {
  const records = [
    ['canvas', document],
    ...document.nodes.map((item) => ['node', item]),
    ...document.edges.map((item) => ['edge', item]),
    ...document.assets.map((item) => ['asset', item]),
    ...document.subflowInstances.map((item) => ['subflow instance', item]),
    ...document.subflowDefinitions.map((item) => ['subflow definition', item]),
    ...document.runs.map((item) => ['run', item]),
    ...document.reviewThreads.map((item) => ['review thread', item]),
    ...(document.reviewComments || []).map((item) => ['review comment', item]),
  ];
  for (const definition of document.subflowDefinitions) {
    records.push(
      ...definition.nodes.map((item) => ['subflow node', item]),
      ...definition.edges.map((item) => ['subflow edge', item]),
      ...definition.inputs.map((item) => ['subflow input port', item]),
      ...definition.outputs.map((item) => ['subflow output port', item]),
      ...definition.exposedParameters.map((item) => ['subflow parameter', item]),
    );
  }
  for (const run of document.runs) {
    records.push(...run.events.map((item) => ['run event', item]));
    for (const nodeRun of run.nodeRuns) {
      records.push(['node run', nodeRun], ...nodeRun.attempts.map((item) => ['run attempt', item]));
    }
  }
  for (const thread of document.reviewThreads) {
    records.push(...thread.comments.map((item) => ['review comment', item]));
  }
  return records;
}

test('canvas-v1 contains exactly 30 static, substantial, distinct legacy JSON fixtures', () => {
  const files = fixtureFiles();
  assert.equal(files.length, 30);
  assert.deepEqual(files.map((name) => name.slice(0, 2)), Array.from({ length: 30 }, (_, index) => String(index + 1).padStart(2, '0')));

  const digests = new Set();
  for (const name of files) {
    const absolute = path.join(FIXTURE_DIRECTORY, name);
    const bytes = fs.readFileSync(absolute);
    assert.ok(bytes.length >= 450, `${name} is not a substantial static fixture`);
    const fixture = JSON.parse(bytes.toString('utf8'));
    assert.ok(Array.isArray(fixture.nodes) && fixture.nodes.length >= 1, `${name} must contain a real node graph`);
    assert.ok(Array.isArray(fixture.edges), `${name} must carry an explicit edge collection`);
    digests.add(crypto.createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(digests.size, 30);
});

test('all 30 legacy fixtures migrate deterministically and round-trip every canonical JSON field', () => {
  const aggregate = {
    assets: 0,
    definitions: 0,
    ports: 0,
    parameters: 0,
    runs: 0,
    comments: 0,
  };
  for (const name of fixtureFiles()) {
    const legacy = readFixture(name);
    const before = structuredClone(legacy);
    const first = migrateLegacyProjectDocument(legacy);
    const second = migrateLegacyProjectDocument(structuredClone(legacy));

    assert.deepEqual(legacy, before, `${name} migration must not mutate the source`);
    assert.deepEqual(first, second, `${name} migration must be deterministic`);
    assert.deepEqual(migrateLegacyProjectDocument(first), first, `${name} migration must be idempotent`);
    assert.equal(first.schema, 't8-canvas-document');
    assert.equal(first.schemaVersion, 2);
    assert.equal(first.identityContract, MIGRATION_CONTRACT);
    assert.ok(first.revision >= 1);
    assert.deepEqual(first.viewport, {
      ...(legacy.viewport || {}),
      x: Number.isFinite(Number(legacy.viewport?.x)) ? Number(legacy.viewport.x) : 0,
      y: Number.isFinite(Number(legacy.viewport?.y)) ? Number(legacy.viewport.y) : 0,
      zoom: Math.max(0.01, Number.isFinite(Number(legacy.viewport?.zoom)) ? Number(legacy.viewport.zoom) : 1),
    });

    for (const [kind, record] of allIdentityRecords(first)) {
      assertUuid(record.entityUid, `${name} ${kind}`);
      if (kind !== 'canvas') assert.ok(Array.isArray(record.legacyAliases), `${name} ${kind} aliases`);
    }

    const verification = validateCanonicalProjectDocument(first);
    assert.equal(verification.valid, true);
    aggregate.assets += verification.counts.assets;
    aggregate.definitions += verification.counts.subflowDefinitions;
    aggregate.ports += verification.counts.subflowPorts;
    aggregate.parameters += verification.counts.subflowParameters;
    aggregate.runs += verification.counts.runs;
    aggregate.comments += verification.counts.reviewComments;

    const serialized = serializeCanonicalProjectDocument(first, { pretty: true });
    const parsed = parseCanonicalProjectDocument(serialized);
    assert.deepEqual(parsed, first, `${name} canonical JSON round-trip must be field-exact`);
  }

  assert.ok(aggregate.assets >= 8);
  assert.ok(aggregate.definitions >= 6);
  assert.ok(aggregate.ports >= 12);
  assert.ok(aggregate.parameters >= 5);
  assert.ok(aggregate.runs >= 4);
  assert.ok(aggregate.comments >= 8);
});

test('fixture matrix preserves viewport extensions, themes, creative desk, private and unknown business data', () => {
  const pixel = migrateLegacyProjectDocument(readFixture('03-pixel-creative-desk.json'));
  assert.equal(pixel.theme.style, 'pixel');
  assert.equal(pixel.creativeDesk.items[0].frameId, 'polaroid');

  const privateFixture = migrateLegacyProjectDocument(readFixture('04-private-node-data.json'));
  assert.deepEqual(privateFixture.nodes[0].data.privateData, readFixture('04-private-node-data.json').nodes[0].data.privateData);
  assert.deepEqual(privateFixture.hostOnly, readFixture('04-private-node-data.json').hostOnly);

  const unknown = migrateLegacyProjectDocument(readFixture('05-unknown-business-fields.json'));
  assert.deepEqual(unknown.futureRootField, readFixture('05-unknown-business-fields.json').futureRootField);
  assert.deepEqual(unknown.nodes[0].futureNodeField, readFixture('05-unknown-business-fields.json').nodes[0].futureNodeField);
  assert.deepEqual(unknown.edges[0].futureEdgeField, readFixture('05-unknown-business-fields.json').edges[0].futureEdgeField);
  assert.equal(unknown.viewport.futureViewportField, 'preserve');

  const farm = migrateLegacyProjectDocument(readFixture('14-farm-canvas-state.json'));
  assert.deepEqual(farm.farmCanvas, readFixture('14-farm-canvas-state.json').farmCanvas);
  const deep = migrateLegacyProjectDocument(readFixture('25-deep-unknown-extension.json'));
  assert.deepEqual(deep.opaqueRoot, readFixture('25-deep-unknown-extension.json').opaqueRoot);
});

test('canonical aliases and companions resolve cross-domain node, edge, asset, subflow, run and comment references', () => {
  const document = migrateLegacyProjectDocument(readFixture('30-comprehensive-cross-domain.json'));
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const edge = document.edges[0];
  assert.equal(edge.sourceEntityUid, nodeById.get(edge.source).entityUid);
  assert.equal(edge.targetEntityUid, nodeById.get(edge.target).entityUid);

  const assetById = new Map(document.assets.map((asset) => [asset.id, asset]));
  assert.equal(nodeById.get('campaign-upload').data.sourceAssetEntityUid, assetById.get('campaign-product').entityUid);
  assert.deepEqual(document.assets[1].parentAssetEntityUids, [assetById.get('campaign-product').entityUid]);

  const definition = document.subflowDefinitions[0];
  assert.equal(nodeById.get('campaign-subflow').data.definitionEntityUid, definition.entityUid);
  assert.equal(document.subflowInstances[0].definitionEntityUid, definition.entityUid);
  assert.equal(document.subflowInstances[0].nodeEntityUid, nodeById.get('campaign-subflow').entityUid);
  assert.equal(definition.inputs[0].internalNodeEntityUid, definition.nodes.find((node) => node.id === 'layout-image').entityUid);
  assert.equal(definition.exposedParameters[0].nodeEntityUid, definition.nodes.find((node) => node.id === 'layout-copy').entityUid);

  const run = document.runs[0];
  assert.equal(run.nodeEntityUids[0], nodeById.get('campaign-subflow').entityUid);
  assert.equal(run.outputAssetEntityUids[0], assetById.get('campaign-result').entityUid);
  assert.equal(run.nodeRuns[0].definitionEntityUid, definition.entityUid);
  assert.equal(run.events[0].nodeRunEntityUid, run.nodeRuns[0].entityUid);
  assert.equal(run.events[0].payload.assetEntityUid, assetById.get('campaign-result').entityUid);

  const thread = document.reviewThreads[0];
  assert.equal(thread.anchor.assetEntityUid, assetById.get('campaign-result').entityUid);
  assert.equal(thread.comments[0].threadEntityUid, thread.entityUid);
});

test('legacy aliases remain stable across array reorder and existing UUIDs remain authoritative', () => {
  const legacy = readFixture('01-basic-text-edge.json');
  const normal = migrateLegacyProjectDocument(legacy);
  const reordered = migrateLegacyProjectDocument({
    ...legacy,
    nodes: [...legacy.nodes].reverse(),
    edges: [...legacy.edges].reverse(),
  });
  assert.deepEqual(
    Object.fromEntries(normal.nodes.map((node) => [node.id, node.entityUid])),
    Object.fromEntries(reordered.nodes.map((node) => [node.id, node.entityUid])),
  );

  const aliases = migrateLegacyProjectDocument(readFixture('21-preexisting-aliases.json'));
  assert.ok(aliases.nodes[0].legacyAliases.includes('node-1'));
  assert.equal(aliases.edges[0].sourceEntityUid, aliases.nodes[0].entityUid);
  assert.equal(aliases.edges[0].targetEntityUid, aliases.nodes[1].entityUid);

  const existing = migrateLegacyProjectDocument(readFixture('20-existing-uuid-identities.json'));
  assert.equal(existing.entityUid, '00000000-0000-5000-8000-000000000001');
  assert.equal(existing.nodes[0].entityUid, existing.nodes[0].id);
  assert.equal(existing.assets[0].entityUid, existing.assets[0].id);

  const runTree = migrateLegacyProjectDocument(readFixture('23-parent-and-child-runs.json'));
  assert.equal(runTree.runs[1].parentRunEntityUid, runTree.runs[0].entityUid);
  assert.equal(runTree.runs[1].nodeRuns[0].parentNodeRunEntityUid, runTree.runs[0].nodeRuns[0].entityUid);

  const deleted = migrateLegacyProjectDocument(readFixture('29-tombstones-and-deleted-identities.json'));
  assertUuid(deleted.tombstones.nodes['deleted-node-old'].entityUid, 'deleted node tombstone');
  assert.equal(deleted.tombstones.edges['deleted-edge-old'].sourceEntityUid, deleted.nodes[0].entityUid);
  assertUuid(deleted.tombstones.edges['deleted-edge-old'].targetEntityUid, 'deleted edge target');
});

test('optional missing legacy and UUID references remain explicit legacy-unverified barriers', () => {
  const missingUuid = '99999999-9999-5999-8999-999999999999';
  const legacy = {
    canvasId: 'unverified-reference-board',
    projectId: 'unverified-reference-project',
    nodes: [{
      id: 'node-known',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {
        sourceAssetId: 'asset-known',
        assetRefs: ['asset-known', 'asset-missing', missingUuid],
        outputRefs: ['asset-output-missing'],
        definitionId: 'definition-missing',
      },
    }],
    edges: [],
    assets: [
      { id: 'asset-known', kind: 'image' },
      {
        id: 'asset-child',
        kind: 'image',
        parentAssetIds: ['asset-known', 'asset-parent-missing', missingUuid],
      },
    ],
    subflowDefinitions: [],
    subflowInstances: [{
      instanceId: 'instance-orphaned',
      definitionId: missingUuid,
      nodeId: 'node-missing',
    }],
    runs: [{
      id: 'run-known',
      parentRunId: 'run-missing',
      nodeIds: ['node-known', 'node-missing', missingUuid],
      outputRefs: ['asset-known', 'asset-run-missing'],
      nodeRuns: [{
        id: 'node-run-known',
        nodeId: 'node-missing',
        parentNodeRunId: 'node-run-missing',
        definitionId: 'definition-missing',
        outputRefs: ['asset-node-run-missing'],
        attempts: [],
      }],
      events: [{
        id: 'event-known',
        nodeRunId: 'node-run-missing',
        payload: { assetId: 'asset-event-missing' },
      }],
    }],
    reviewThreads: [{
      id: 'thread-known',
      anchor: {
        nodeId: 'node-missing',
        edgeId: 'edge-missing',
        assetId: missingUuid,
      },
      comments: [],
    }],
    reviewComments: [{ id: 'comment-orphaned', threadId: 'thread-missing' }],
    tombstones: {
      nodes: {},
      edges: {
        'edge-deleted': {
          source: 'node-missing',
          target: 'node-known',
        },
      },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
  };

  const migrated = migrateLegacyProjectDocument(legacy);
  const assetKnownUid = migrated.assets.find((asset) => asset.id === 'asset-known').entityUid;
  assert.deepEqual(migrated.nodes[0].data.assetEntityUids, [assetKnownUid]);
  assert.deepEqual(migrated.assets[1].parentAssetEntityUids, [assetKnownUid]);
  assert.deepEqual(migrated.runs[0].nodeEntityUids, [migrated.nodes[0].entityUid]);
  assert.deepEqual(migrated.runs[0].outputAssetEntityUids, [assetKnownUid]);
  assert.equal(migrated.subflowInstances[0].definitionEntityUid, undefined);
  assert.equal(migrated.subflowInstances[0].nodeEntityUid, undefined);
  assert.equal(migrated.runs[0].parentRunEntityUid, undefined);
  assert.equal(migrated.runs[0].nodeRuns[0].nodeEntityUid, undefined);
  assert.equal(migrated.runs[0].nodeRuns[0].parentNodeRunEntityUid, undefined);
  assert.equal(migrated.runs[0].events[0].nodeRunEntityUid, undefined);
  assert.equal(migrated.runs[0].events[0].payload.assetEntityUid, undefined);
  assert.equal(migrated.reviewThreads[0].anchor.nodeEntityUid, undefined);
  assert.equal(migrated.reviewThreads[0].anchor.edgeEntityUid, undefined);
  assert.equal(migrated.reviewThreads[0].anchor.assetEntityUid, undefined);
  assert.equal(migrated.reviewComments[0].threadEntityUid, undefined);
  assert.equal(migrated.tombstones.edges['edge-deleted'].sourceEntityUid, undefined);
  assert.equal(
    migrated.tombstones.edges['edge-deleted'].targetEntityUid,
    migrated.nodes[0].entityUid,
  );

  const records = [
    migrated.nodes[0].data,
    migrated.assets[1],
    migrated.subflowInstances[0],
    migrated.runs[0],
    migrated.runs[0].nodeRuns[0],
    migrated.runs[0].events[0],
    migrated.runs[0].events[0].payload,
    migrated.reviewThreads[0].anchor,
    migrated.reviewComments[0],
    migrated.tombstones.edges['edge-deleted'],
  ];
  const unverified = records.flatMap((record) => record.unverifiedIdentityReferences || []);
  assert.ok(unverified.length >= 15);
  assert.ok(unverified.every((reference) => reference.status === 'legacy-unverified'));
  assert.ok(unverified.some((reference) => reference.legacyReference === missingUuid));
  assert.ok(unverified.some((reference) => (
    reference.stableField === 'threadEntityUid'
      && reference.legacyReference === 'thread-missing'
  )));
  assert.deepEqual(migrateLegacyProjectDocument(migrated), migrated);
  assert.deepEqual(parseCanonicalProjectDocument(serializeCanonicalProjectDocument(migrated)), migrated);

  const withLaterAliases = structuredClone(migrated);
  withLaterAliases.assets.push({ id: 'asset-missing', kind: 'image' });
  withLaterAliases.nodes.push({
    id: 'node-missing',
    type: 'text',
    position: { x: 10, y: 10 },
    data: {},
  });
  withLaterAliases.edges.push({ id: 'edge-missing', source: 'node-known', target: 'node-missing' });
  withLaterAliases.subflowDefinitions.push({
    id: 'definition-missing',
    version: 1,
    nodes: [],
    edges: [],
    inputs: [],
    outputs: [],
    exposedParameters: [],
  });
  withLaterAliases.runs.push({ id: 'run-missing', nodeRuns: [], events: [] });
  withLaterAliases.runs[0].nodeRuns.push({
    id: 'node-run-missing',
    nodeId: 'node-known',
    attempts: [],
  });
  withLaterAliases.reviewThreads.push({
    id: 'thread-missing',
    anchor: { kind: 'canvas' },
    comments: [],
  });
  const remigrated = migrateLegacyProjectDocument(withLaterAliases);
  assert.equal(remigrated.nodes[0].data.assetEntityUids.includes(
    remigrated.assets.find((asset) => asset.id === 'asset-missing').entityUid,
  ), false);
  assert.equal(remigrated.runs[0].nodeEntityUids.includes(
    remigrated.nodes.find((node) => node.id === 'node-missing').entityUid,
  ), false);
  assert.equal(remigrated.runs[0].parentRunEntityUid, undefined);
  assert.equal(remigrated.runs[0].nodeRuns[0].parentNodeRunEntityUid, undefined);
  assert.equal(remigrated.runs[0].events[0].nodeRunEntityUid, undefined);
  assert.equal(remigrated.reviewThreads[0].anchor.edgeEntityUid, undefined);
  assert.equal(remigrated.reviewComments[0].threadEntityUid, undefined);
  assert.equal(remigrated.tombstones.edges['edge-deleted'].sourceEntityUid, undefined);
});

test('stable UUID generation is RFC4122 v5-shaped and namespaces identical legacy labels', () => {
  const first = stableProjectEntityUuid('project-a', 'canvas-a', 'node', 'node-1');
  const retry = stableProjectEntityUuid('project-a', 'canvas-a', 'node', 'node-1');
  const otherCanvas = stableProjectEntityUuid('project-a', 'canvas-b', 'node', 'node-1');
  assertUuid(first, 'stable UUID');
  assert.equal(first[14], '5');
  assert.equal(first, retry);
  assert.notEqual(first, otherCanvas);
});

test('duplicate aliases, UUID collisions and dangling structural references fail closed', () => {
  const base = {
    canvasId: 'collision-board',
    projectId: 'collision-project',
    nodes: [{ id: 'same', type: 'text', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  assert.throws(
    () => migrateLegacyProjectDocument({ ...base, nodes: [...base.nodes, structuredClone(base.nodes[0])] }),
    (error) => error instanceof IdentityMigrationError && ['identity_uuid_collision', 'identity_alias_collision'].includes(error.code),
  );
  assert.throws(
    () => migrateLegacyProjectDocument({
      ...base,
      nodes: [
        { ...base.nodes[0], id: 'a', entityUid: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa' },
        { ...base.nodes[0], id: 'b', entityUid: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa' },
      ],
    }),
    (error) => error instanceof IdentityMigrationError && error.code === 'identity_uuid_collision',
  );
  assert.throws(
    () => migrateLegacyProjectDocument({
      ...base,
      nodes: [
        { ...base.nodes[0], id: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa', entityUid: 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb' },
        { ...base.nodes[0], id: 'second', entityUid: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa' },
      ],
    }),
    (error) => error instanceof IdentityMigrationError && error.code === 'identity_uuid_collision',
  );
  assert.throws(
    () => migrateLegacyProjectDocument({
      ...base,
      edges: [{ id: 'dangling', source: 'same', target: 'missing-node' }],
    }),
    (error) => error instanceof IdentityMigrationError && error.code === 'identity_reference_missing',
  );
});

test('tombstone lifecycle fails closed and unresolved endpoint UUIDs remain unverified', () => {
  const base = {
    canvasId: 'tombstone-board',
    projectId: 'tombstone-project',
    nodes: [
      { id: 'node-a', type: 'text', position: { x: 0, y: 0 }, data: {} },
      { id: 'node-b', type: 'output', position: { x: 10, y: 10 }, data: {} },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  const nodeAUid = stableProjectEntityUuid('tombstone-project', 'tombstone-board', 'node', 'node-a');
  const nodeBUid = stableProjectEntityUuid('tombstone-project', 'tombstone-board', 'node', 'node-b');
  const deletedNodeUid = 'dddddddd-dddd-5ddd-8ddd-dddddddddddd';
  const deletedEdgeUid = 'eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee';

  assert.throws(
    () => migrateLegacyProjectDocument({
      ...base,
      tombstones: {
        nodes: { 'node-a': { entityUid: nodeAUid, revision: 1 } },
        edges: {},
      },
    }),
    (error) => error instanceof IdentityMigrationError && error.code === 'identity_lifecycle_collision',
  );

  assert.throws(
    () => migrateLegacyProjectDocument({
      ...base,
      tombstones: {
        nodes: {},
        edges: {
          'deleted-edge': {
            entityUid: deletedEdgeUid,
            source: 'node-a',
            target: 'node-b',
            sourceEntityUid: deletedNodeUid,
            targetEntityUid: nodeBUid,
          },
        },
      },
    }),
    (error) => error instanceof IdentityMigrationError && error.code === 'identity_reference_collision',
  );

  const preserved = migrateLegacyProjectDocument({
    ...base,
    tombstones: {
      nodes: {},
      edges: {
        'deleted-edge': {
          entityUid: deletedEdgeUid,
          source: 'node-deleted-before-migration',
          target: 'node-a',
          sourceEntityUid: deletedNodeUid,
          targetEntityUid: nodeAUid,
        },
      },
    },
  });
  assert.equal(preserved.tombstones.edges['deleted-edge'].sourceEntityUid, undefined);
  assert.equal(preserved.tombstones.edges['deleted-edge'].targetEntityUid, nodeAUid);
  assert.deepEqual(preserved.tombstones.edges['deleted-edge'].unverifiedIdentityReferences, [{
    status: 'legacy-unverified',
    kind: 'node',
    field: 'source',
    stableField: 'sourceEntityUid',
    legacyReference: 'node-deleted-before-migration',
  }]);
  assert.deepEqual(migrateLegacyProjectDocument(preserved), preserved);
});

test('canonical parser rejects invalid JSON and tampered cross-reference companions', () => {
  assert.throws(
    () => parseCanonicalProjectDocument('{bad-json'),
    (error) => error instanceof IdentityMigrationError && error.code === 'identity_json_parse_failed',
  );
  const canonical = migrateLegacyProjectDocument(readFixture('01-basic-text-edge.json'));
  canonical.edges[0].sourceEntityUid = 'ffffffff-ffff-5fff-8fff-ffffffffffff';
  assert.throws(
    () => validateCanonicalProjectDocument(canonical),
    (error) => error instanceof IdentityMigrationError && error.code === 'identity_reference_collision',
  );
});
