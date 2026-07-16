const { containsPlaintextSecret } = require('./subflowPackage');

function validateSubflowDefinition(input) {
  if (!input || typeof input !== 'object') throw new Error('子工作流定义无效');
  if (!String(input.id || '').trim()) throw new Error('子工作流定义 ID 不能为空');
  if (!String(input.name || '').trim()) throw new Error('子工作流名称不能为空');
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) throw new Error('子工作流至少需要一个节点');
  if (!Array.isArray(input.edges)) throw new Error('子工作流连线无效');
  if (!Array.isArray(input.inputs) || !Array.isArray(input.outputs)) throw new Error('子工作流端口无效');
  const nodeIds = new Set(input.nodes.map((node) => String(node?.id || '')));
  if (nodeIds.has('') || nodeIds.size !== input.nodes.length) throw new Error('子工作流节点 ID 缺失或重复');
  const edgeIds = input.edges.map((edge) => String(edge?.id || ''));
  if (edgeIds.some((id) => !id) || new Set(edgeIds).size !== edgeIds.length) throw new Error('子工作流连线 ID 缺失或重复');
  for (const edge of input.edges) {
    if (!nodeIds.has(String(edge?.source || '')) || !nodeIds.has(String(edge?.target || ''))) throw new Error('子工作流包含悬空内部连线');
  }
  const portIds = [...input.inputs, ...input.outputs].map((port) => String(port?.id || ''));
  if (portIds.some((id) => !id) || new Set(portIds).size !== portIds.length) throw new Error('子工作流端口 ID 缺失或重复');
  for (const port of [...input.inputs, ...input.outputs]) {
    if (!nodeIds.has(String(port?.internalNodeId || ''))) throw new Error('子工作流端口指向不存在的内部节点');
  }
  const parameters = Array.isArray(input.exposedParameters) ? input.exposedParameters : [];
  const parameterIds = parameters.map((parameter) => String(parameter?.id || ''));
  if (parameterIds.some((id) => !id) || new Set(parameterIds).size !== parameterIds.length) throw new Error('子工作流公开参数 ID 缺失或重复');
  for (const parameter of parameters) {
    if (!nodeIds.has(String(parameter?.nodeId || ''))) throw new Error('子工作流公开参数指向不存在的内部节点');
    if (!String(parameter?.dataKey || '').trim()) throw new Error('子工作流公开参数缺少配置字段');
  }
  for (const node of input.nodes) {
    if (node?.type !== 'subflow') continue;
    const data = node.data && typeof node.data === 'object' ? node.data : {};
    const embedded = data.definition && typeof data.definition === 'object' ? data.definition : null;
    const definitionId = String(data.definitionId || embedded?.id || '').trim();
    const version = Number(data.definitionVersion || embedded?.version || 0);
    if (!definitionId || !Number.isInteger(version) || version < 1) throw new Error(`嵌套子工作流节点缺少固定版本: ${String(node.id || '')}`);
  }
  if (containsPlaintextSecret(input)) throw new Error('子工作流定义不能包含凭据或秘密设置');
  return input;
}

function normalizeSubflowChangeSummary(value, options = {}) {
  const summary = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (options.required && !summary) throw new Error('发布子工作流必须填写变更说明');
  if (summary.length > 500) throw new Error('子工作流变更说明不能超过 500 字');
  return summary;
}

function publicSubflowPublication(definition) {
  if (!definition) return null;
  return {
    id: definition.id,
    projectId: definition.projectId,
    name: definition.name,
    version: definition.version,
    revision: definition.revision,
    changeSummary: definition.changeSummary,
    publishedBy: definition.publishedBy,
    publishedAt: definition.publishedAt,
  };
}

module.exports = {
  normalizeSubflowChangeSummary,
  publicSubflowPublication,
  validateSubflowDefinition,
};
