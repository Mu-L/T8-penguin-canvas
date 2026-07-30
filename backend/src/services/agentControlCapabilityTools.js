'use strict';

const capabilitySurfaces = require('../shared/creativeCapabilitySurfaces.json');

const VERSIONED_TOOL_PROTOCOL = 't8-versioned-creative-tool-v1';
const VERSIONED_TOOL_REQUEST_SCHEMA = 't8-versioned-creative-tool-request-v1';
const VERSIONED_TOOL_RESULT_SCHEMA = 't8-versioned-creative-tool-result-v1';
const VERSIONED_TOOL_CATALOG_SCHEMA = 't8-versioned-creative-tool-catalog-v1';
const TOOL_NAME_RE = /^zcanvas_[a-z][a-z0-9_]{2,127}$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TOP_LEVEL_KEYS = new Set([
  'schema',
  'tool',
  'version',
  'operation',
  'projectId',
  'canvasId',
  'clientRequestId',
  'input',
]);
const FORBIDDEN_INPUT_KEYS = new Set([
  'handler',
  'service',
  'method',
  'route',
  'endpoint',
  'baseurl',
  'targeturl',
  'url',
  'headers',
  'authorization',
  'credential',
  'credentials',
  'cookie',
  'cookies',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'secret',
  'providerpayload',
  'providerrequest',
  'requestinit',
  'rawbody',
  'sql',
  'database',
  'db',
  'dom',
  'selector',
  'reactflow',
  'zustand',
  'sourcecode',
  'sourcefile',
  'sourcepath',
  'command',
  'shell',
  'argv',
  'process',
  'childprocess',
  'patch',
  'canvaspatch',
  'operations',
  'nodes',
  'edges',
  'path',
]);
const MAX_INPUT_DEPTH = 12;
const MAX_INPUT_ENTRIES = 2_048;
const MAX_STRING_BYTES = 48 * 1024;

class AgentControlCapabilityToolError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'AgentControlCapabilityToolError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentControlCapabilityToolError(
      'CAPABILITY_TOOL_REQUEST_INVALID',
      `${label}必须是普通对象`,
    );
  }
  return value;
}

function normalizedBoundaryKey(value) {
  return String(value || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function assertBoundedHighLevelInput(value) {
  let entries = 0;
  const visit = (item, path, depth) => {
    if (depth > MAX_INPUT_DEPTH) {
      throw new AgentControlCapabilityToolError(
        'CAPABILITY_TOOL_INPUT_TOO_DEEP',
        '高层能力输入层级过深，已停止调用',
      );
    }
    if (typeof item === 'string') {
      if (Buffer.byteLength(item, 'utf8') > MAX_STRING_BYTES) {
        throw new AgentControlCapabilityToolError(
          'CAPABILITY_TOOL_INPUT_TOO_LARGE',
          `高层能力输入字段过长：${path}`,
        );
      }
      return;
    }
    if (item == null || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new AgentControlCapabilityToolError(
          'CAPABILITY_TOOL_REQUEST_INVALID',
          `高层能力输入数字无效：${path}`,
        );
      }
      return;
    }
    if (Array.isArray(item)) {
      entries += item.length;
      if (entries > MAX_INPUT_ENTRIES) {
        throw new AgentControlCapabilityToolError(
          'CAPABILITY_TOOL_INPUT_TOO_LARGE',
          '高层能力输入项目过多，已停止调用',
        );
      }
      item.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof item !== 'object') {
      throw new AgentControlCapabilityToolError(
        'CAPABILITY_TOOL_REQUEST_INVALID',
        `高层能力输入包含不支持的值：${path}`,
      );
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AgentControlCapabilityToolError(
        'CAPABILITY_TOOL_REQUEST_INVALID',
        `高层能力输入必须是 JSON 对象：${path}`,
      );
    }
    const keys = Object.keys(item);
    entries += keys.length;
    if (entries > MAX_INPUT_ENTRIES) {
      throw new AgentControlCapabilityToolError(
        'CAPABILITY_TOOL_INPUT_TOO_LARGE',
        '高层能力输入字段过多，已停止调用',
      );
    }
    for (const key of keys) {
      const normalized = normalizedBoundaryKey(key);
      if (FORBIDDEN_INPUT_KEYS.has(normalized)) {
        throw new AgentControlCapabilityToolError(
          'CAPABILITY_TOOL_LOW_LEVEL_FIELD_FORBIDDEN',
          `外部 Agent 只能使用版本化高层能力，不能提交底层字段：${key}`,
          403,
          { field: key, path: `${path}.${key}` },
        );
      }
      visit(item[key], `${path}.${key}`, depth + 1);
    }
  };
  visit(value, 'input', 0);
}

function validateCapabilityToolSurfaces(value = capabilitySurfaces) {
  if (value?.schema !== 't8-creative-capability-surfaces-v1'
    || !VERSION_RE.test(String(value.capabilityManifestVersion || ''))
    || !/^[a-f0-9]{64}$/.test(String(value.sourceDigest || ''))
    || !/^[a-f0-9]{64}$/.test(String(value.capabilityGraphDigest || ''))
    || !Array.isArray(value.capabilities)) {
    throw new Error('Versioned creative capability tool surface is invalid');
  }
  const names = new Set();
  for (const capability of value.capabilities) {
    const tool = capability?.agentTool;
    const policies = Array.isArray(capability?.ui?.operations) ? capability.ui.operations : [];
    const operations = new Map(policies.map((policy) => [String(policy?.operation || ''), policy]));
    const directOperations = Array.isArray(tool?.directOperations) ? tool.directOperations : [];
    if (!TOOL_NAME_RE.test(String(tool?.name || ''))
      || names.has(tool.name)
      || tool.version !== value.capabilityManifestVersion
      || tool.protocol !== VERSIONED_TOOL_PROTOCOL
      || tool.requestSchema !== VERSIONED_TOOL_REQUEST_SCHEMA
      || tool.resultSchema !== VERSIONED_TOOL_RESULT_SCHEMA
      || !String(tool.handler || '').trim()
      || !/^agentControl[A-Z][A-Za-z0-9]*$/.test(String(tool.service || ''))
      || !/^[a-z][A-Za-z0-9]*$/.test(String(tool.method || ''))
      || !String(tool.bindingOperation || '').trim()
      || !operations.has(String(tool.defaultOperation || ''))
      || directOperations.length < 1
      || directOperations.some((operation) => {
        const policy = operations.get(String(operation || ''));
        return !policy || policy.riskLevel !== 'L0' || policy.approvalRequired !== false;
      })
      || !directOperations.includes(tool.defaultOperation)) {
      throw new Error(`Versioned creative capability tool surface drifted for ${capability?.id || '(unknown)'}`);
    }
    names.add(tool.name);
  }
  return value;
}

function toolIndex(value = capabilitySurfaces) {
  const contract = validateCapabilityToolSurfaces(value);
  return {
    contract,
    byName: new Map(contract.capabilities.map((capability) => [
      capability.agentTool.name,
      capability,
    ])),
  };
}

function prepareVersionedCapabilityToolRequest(rawRequest, surfaces = capabilitySurfaces) {
  const request = plainRecord(rawRequest, '版本化高层能力请求');
  const unexpected = Object.keys(request).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unexpected.length > 0) {
    throw new AgentControlCapabilityToolError(
      'CAPABILITY_TOOL_REQUEST_INVALID',
      `高层能力请求包含未声明字段：${unexpected.join('、')}`,
    );
  }
  if (request.schema !== VERSIONED_TOOL_REQUEST_SCHEMA) {
    throw new AgentControlCapabilityToolError(
      'CAPABILITY_TOOL_SCHEMA_UNSUPPORTED',
      '高层能力请求版本不受支持，请刷新能力清单后重试',
      409,
    );
  }
  const { contract, byName } = toolIndex(surfaces);
  const name = String(request.tool || '').trim();
  const capability = byName.get(name);
  if (!capability) {
    throw new AgentControlCapabilityToolError(
      'CAPABILITY_TOOL_UNKNOWN',
      '这个高层能力不存在或已下线，请刷新能力清单后重试',
      404,
    );
  }
  const version = String(request.version || '').trim();
  if (version !== capability.agentTool.version) {
    throw new AgentControlCapabilityToolError(
      'CAPABILITY_TOOL_VERSION_UNSUPPORTED',
      `高层能力版本不匹配；当前需要 ${capability.agentTool.version}，请刷新后重试`,
      409,
      { expectedVersion: capability.agentTool.version },
    );
  }
  const operation = String(request.operation || capability.agentTool.defaultOperation).trim();
  const operationContract = capability.ui.operations
    .find((candidate) => candidate.operation === operation);
  if (!operationContract) {
    throw new AgentControlCapabilityToolError(
      'CAPABILITY_TOOL_OPERATION_UNSUPPORTED',
      '这个高层能力不支持所请求的操作，请刷新能力清单后重试',
      409,
    );
  }
  const projectId = String(request.projectId || '').trim();
  const canvasId = String(request.canvasId || '').trim();
  if (!ENTITY_ID_RE.test(projectId) || !ENTITY_ID_RE.test(canvasId)) {
    throw new AgentControlCapabilityToolError(
      'CAPABILITY_TOOL_SCOPE_INVALID',
      '高层能力必须绑定有效的当前项目和画布',
    );
  }
  const clientRequestId = String(request.clientRequestId || '').trim();
  if (clientRequestId && !ENTITY_ID_RE.test(clientRequestId)) {
    throw new AgentControlCapabilityToolError(
      'CAPABILITY_TOOL_REQUEST_ID_INVALID',
      '高层能力 clientRequestId 无效',
    );
  }
  const input = request.input == null ? {} : plainRecord(request.input, '高层能力 input');
  assertBoundedHighLevelInput(input);
  return Object.freeze({
    requestSchema: request.schema,
    tool: name,
    version,
    capabilityId: capability.id,
    requestAction: capability.agentTool.requestAction,
    operation,
    operationContract: Object.freeze(cloneJson(operationContract)),
    requiredScopes: Object.freeze([...(operationContract.requiredScopes || [])]),
    direct: capability.agentTool.directOperations.includes(operation),
    projectId,
    canvasId,
    clientRequestId,
    input: cloneJson(input),
    surface: capability,
    surfaceDigest: contract.sourceDigest,
    capabilityGraphDigest: contract.capabilityGraphDigest,
  });
}

function publicVersionedCapabilityToolCatalog(surfaces = capabilitySurfaces) {
  const contract = validateCapabilityToolSurfaces(surfaces);
  return {
    schema: VERSIONED_TOOL_CATALOG_SCHEMA,
    protocol: VERSIONED_TOOL_PROTOCOL,
    capabilityManifestVersion: contract.capabilityManifestVersion,
    capabilityManifestDigest: contract.sourceDigest,
    capabilityGraphDigest: contract.capabilityGraphDigest,
    tools: contract.capabilities.map((capability) => ({
      name: capability.agentTool.name,
      version: capability.agentTool.version,
      capabilityId: capability.id,
      creatorLabel: capability.creatorLabel,
      category: capability.category,
      requestSchema: capability.agentTool.requestSchema,
      resultSchema: capability.agentTool.resultSchema,
      defaultOperation: capability.agentTool.defaultOperation,
      directOperations: [...capability.agentTool.directOperations],
      operations: capability.ui.operations.map((operation) => ({ ...operation })),
    })),
  };
}

function createAgentControlCapabilityToolService(options = {}) {
  const surfaces = options.surfaces || capabilitySurfaces;
  validateCapabilityToolSurfaces(surfaces);

  function prepare(rawRequest) {
    return prepareVersionedCapabilityToolRequest(rawRequest, surfaces);
  }

  async function invokePrepared(prepared, context = {}) {
    if (!prepared?.surface || prepared.surface.agentTool.name !== prepared.tool) {
      throw new AgentControlCapabilityToolError(
        'CAPABILITY_TOOL_REQUEST_INVALID',
        '高层能力请求尚未通过版本校验',
      );
    }
    if (!prepared.direct) {
      throw new AgentControlCapabilityToolError(
        'CAPABILITY_TOOL_APPROVAL_REQUIRED',
        '这个操作会产生写入、运行或外部传输，不能由外部 Agent 直接执行；请走对应的预览与画布确认流程',
        409,
        {
          capabilityId: prepared.capabilityId,
          operation: prepared.operation,
          riskLevel: prepared.operationContract.riskLevel,
          requiredScopes: [...prepared.requiredScopes],
          approvalRequired: true,
        },
      );
    }
    if (typeof options.dispatch !== 'function') {
      throw new AgentControlCapabilityToolError(
        'CAPABILITY_TOOL_HANDLER_UNAVAILABLE',
        '当前桌面版尚未绑定这个高层能力，请更新后重试',
        503,
      );
    }
    const data = await options.dispatch({
      capabilityId: prepared.capabilityId,
      tool: prepared.tool,
      version: prepared.version,
      requestAction: prepared.requestAction,
      operation: prepared.operation,
      input: cloneJson(prepared.input),
      scope: {
        projectId: prepared.projectId,
        canvasId: prepared.canvasId,
        actorId: String(context.actorId || ''),
        sessionId: String(context.sessionId || ''),
      },
      binding: {
        handler: prepared.surface.agentTool.handler,
        service: prepared.surface.agentTool.service,
        method: prepared.surface.agentTool.method,
        operation: prepared.surface.agentTool.bindingOperation,
      },
    });
    return {
      schema: VERSIONED_TOOL_RESULT_SCHEMA,
      tool: {
        name: prepared.tool,
        version: prepared.version,
        capabilityId: prepared.capabilityId,
        operation: prepared.operation,
        requestAction: prepared.requestAction,
      },
      contract: {
        protocol: VERSIONED_TOOL_PROTOCOL,
        capabilityManifestDigest: prepared.surfaceDigest,
        capabilityGraphDigest: prepared.capabilityGraphDigest,
        riskLevel: prepared.operationContract.riskLevel,
        approvalRequired: false,
        requiredScopes: [...prepared.requiredScopes],
      },
      request: {
        clientRequestId: prepared.clientRequestId || null,
        projectId: prepared.projectId,
        canvasId: prepared.canvasId,
      },
      readOnly: true,
      directInternalAccess: false,
      sideEffects: {
        canvasWrites: 0,
        providerCalls: 0,
        fileWrites: 0,
      },
      data,
    };
  }

  return {
    catalog: () => publicVersionedCapabilityToolCatalog(surfaces),
    invokePrepared,
    prepare,
  };
}

module.exports = {
  AgentControlCapabilityToolError,
  FORBIDDEN_INPUT_KEYS,
  VERSIONED_TOOL_CATALOG_SCHEMA,
  VERSIONED_TOOL_PROTOCOL,
  VERSIONED_TOOL_REQUEST_SCHEMA,
  VERSIONED_TOOL_RESULT_SCHEMA,
  assertBoundedHighLevelInput,
  createAgentControlCapabilityToolService,
  prepareVersionedCapabilityToolRequest,
  publicVersionedCapabilityToolCatalog,
  validateCapabilityToolSurfaces,
};
