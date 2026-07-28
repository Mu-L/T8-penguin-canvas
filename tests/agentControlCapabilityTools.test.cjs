'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const surfaces = require('../backend/src/shared/creativeCapabilitySurfaces.json');
const {
  AgentControlCapabilityToolError,
  VERSIONED_TOOL_REQUEST_SCHEMA,
  VERSIONED_TOOL_RESULT_SCHEMA,
  createAgentControlCapabilityToolService,
  prepareVersionedCapabilityToolRequest,
  publicVersionedCapabilityToolCatalog,
  validateCapabilityToolSurfaces,
} = require('../backend/src/services/agentControlCapabilityTools.js');

function request(overrides = {}) {
  return {
    schema: VERSIONED_TOOL_REQUEST_SCHEMA,
    tool: 'zcanvas_create_image',
    version: surfaces.capabilityManifestVersion,
    operation: 'plan',
    projectId: 'project-local',
    canvasId: 'canvas-versioned-tools',
    clientRequestId: 'request-versioned-tools-1',
    input: {
      kind: 'image',
      prompt: '电影感角色设定',
      provider: 'seedance-nz',
      model: 'zhenzhen-image-g2-t2i',
    },
    ...overrides,
  };
}

function hasInternalBindingKey(value) {
  const internalKeys = new Set(['handler', 'service', 'method', 'bindingOperation']);
  const visit = (item) => {
    if (!item || typeof item !== 'object') return false;
    if (Array.isArray(item)) return item.some(visit);
    if (Object.keys(item).some((key) => internalKeys.has(key))) return true;
    return Object.values(item).some(visit);
  };
  return visit(value);
}

test('versioned high-level catalog exposes 31 unique public tools without internal bindings', () => {
  const catalog = publicVersionedCapabilityToolCatalog();
  assert.equal(catalog.schema, 't8-versioned-creative-tool-catalog-v1');
  assert.equal(catalog.protocol, 't8-versioned-creative-tool-v1');
  assert.equal(catalog.capabilityManifestVersion, surfaces.capabilityManifestVersion);
  assert.equal(catalog.tools.length, 31);
  assert.equal(new Set(catalog.tools.map((tool) => tool.name)).size, 31);
  assert.equal(hasInternalBindingKey(catalog), false);
  for (const tool of catalog.tools) {
    assert.equal(tool.version, surfaces.capabilityManifestVersion);
    assert.equal(tool.requestSchema, VERSIONED_TOOL_REQUEST_SCHEMA);
    assert.equal(tool.resultSchema, VERSIONED_TOOL_RESULT_SCHEMA);
    assert.equal(tool.directOperations.includes(tool.defaultOperation), true);
    assert.ok(tool.directOperations.length > 0);
  }
});

test('versioned high-level invocation dispatches one exact generated binding and reports zero side effects', async () => {
  const calls = [];
  const service = createAgentControlCapabilityToolService({
    dispatch: async (entry) => {
      calls.push(structuredClone(entry));
      return { planId: 'plan-versioned-tools-1', ready: true };
    },
  });
  const prepared = service.prepare(request());
  assert.equal(prepared.direct, true);
  assert.deepEqual(prepared.requiredScopes, ['canvas:read']);
  const result = await service.invokePrepared(prepared, {
    actorId: 'actor-versioned-tools',
    sessionId: 'session-versioned-tools',
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].binding, {
    handler: 'creative-plan:create.image',
    service: 'agentControlCreative',
    method: 'createPlan',
    operation: 'image',
  });
  assert.equal(calls[0].operation, 'plan');
  assert.equal(calls[0].requestAction, 'create.image');
  assert.equal(calls[0].scope.projectId, 'project-local');
  assert.equal(calls[0].scope.canvasId, 'canvas-versioned-tools');
  assert.equal(result.schema, VERSIONED_TOOL_RESULT_SCHEMA);
  assert.equal(result.readOnly, true);
  assert.equal(result.directInternalAccess, false);
  assert.deepEqual(result.sideEffects, {
    canvasWrites: 0,
    providerCalls: 0,
    fileWrites: 0,
  });
  assert.equal(result.data.planId, 'plan-versioned-tools-1');
});

test('versioned high-level request fails closed on stale versions, unknown tools and undeclared operations', () => {
  const cases = [
    [request({ schema: 't8-versioned-creative-tool-request-v0' }), 'CAPABILITY_TOOL_SCHEMA_UNSUPPORTED'],
    [request({ version: '9.9.9' }), 'CAPABILITY_TOOL_VERSION_UNSUPPORTED'],
    [request({ tool: 'zcanvas_unknown_tool' }), 'CAPABILITY_TOOL_UNKNOWN'],
    [request({ operation: 'direct-database-write' }), 'CAPABILITY_TOOL_OPERATION_UNSUPPORTED'],
    [request({ extra: true }), 'CAPABILITY_TOOL_REQUEST_INVALID'],
  ];
  for (const [payload, code] of cases) {
    assert.throws(
      () => prepareVersionedCapabilityToolRequest(payload),
      (error) => error instanceof AgentControlCapabilityToolError && error.code === code,
    );
  }
});

test('versioned high-level input rejects low-level implementation and authority fields before dispatch', () => {
  const forbidden = [
    ['handler', 'creative-plan:create.image'],
    ['endpoint', 'https://example.invalid'],
    ['headers', { Authorization: 'secret' }],
    ['apiKey', 'secret'],
    ['providerPayload', { raw: true }],
    ['sql', 'DELETE FROM canvases'],
    ['database', 'canvas.sqlite'],
    ['dom', { selector: '#root' }],
    ['selector', '.react-flow'],
    ['reactFlow', { nodes: [] }],
    ['sourceCode', 'process.exit(1)'],
    ['command', 'node'],
    ['shell', 'powershell'],
    ['patch', { operations: [] }],
    ['operations', []],
    ['nodes', []],
    ['edges', []],
    ['path', 'E:\\private\\source.ts'],
  ];
  for (const [key, value] of forbidden) {
    assert.throws(
      () => prepareVersionedCapabilityToolRequest(request({
        input: { nested: { [key]: value } },
      })),
      (error) => error instanceof AgentControlCapabilityToolError
        && error.code === 'CAPABILITY_TOOL_LOW_LEVEL_FIELD_FORBIDDEN'
        && error.details.field === key,
      key,
    );
  }
  const allowed = prepareVersionedCapabilityToolRequest(request({
    input: {
      provider: 'seedance-nz',
      model: 'zhenzhen-image-g2-t2i',
      filePath: 'E:\\creator-assets\\reference.png',
      targetPath: 'E:\\creator-delivery',
    },
  }));
  assert.equal(allowed.input.provider, 'seedance-nz');
});

test('non-L0 operations never reach a direct dispatcher', async () => {
  let dispatchCalls = 0;
  const service = createAgentControlCapabilityToolService({
    dispatch: async () => {
      dispatchCalls += 1;
      return {};
    },
  });
  const prepared = service.prepare(request({ operation: 'apply' }));
  assert.equal(prepared.direct, false);
  await assert.rejects(
    service.invokePrepared(prepared, {
      actorId: 'actor-versioned-tools',
      sessionId: 'session-versioned-tools',
    }),
    (error) => error instanceof AgentControlCapabilityToolError
      && error.code === 'CAPABILITY_TOOL_APPROVAL_REQUIRED'
      && error.details.approvalRequired === true,
  );
  assert.equal(dispatchCalls, 0);
});

test('versioned surface validator rejects tool protocol, version and direct-operation drift', () => {
  const badVersion = structuredClone(surfaces);
  badVersion.capabilities[0].agentTool.version = '9.9.9';
  assert.throws(() => validateCapabilityToolSurfaces(badVersion), /surface drifted/);

  const badProtocol = structuredClone(surfaces);
  badProtocol.capabilities[0].agentTool.protocol = 't8-direct-internal-tool-v1';
  assert.throws(() => validateCapabilityToolSurfaces(badProtocol), /surface drifted/);

  const badDirectOperation = structuredClone(surfaces);
  badDirectOperation.capabilities[0].agentTool.directOperations.push('apply');
  assert.throws(() => validateCapabilityToolSurfaces(badDirectOperation), /surface drifted/);

  const missingBindingOperation = structuredClone(surfaces);
  missingBindingOperation.capabilities[0].agentTool.bindingOperation = '';
  assert.throws(() => validateCapabilityToolSurfaces(missingBindingOperation), /surface drifted/);
});
