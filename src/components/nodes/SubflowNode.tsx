import { memo, useCallback, useEffect, useMemo, type CSSProperties } from 'react';
import { Handle, Position, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { ExternalLink, GitFork, Play, RotateCcw, Workflow } from 'lucide-react';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { matchesRunCompletion, registerRunNodeExecutionContexts, useRunBusStore } from '../../stores/runBus';
import * as api from '../../services/api';
import { EXECUTABLE_NODE_TYPES } from '../../config/executableNodeTypes';
import { compileSubflow, isPrivateSubflowDataKey, loadSubflowDependencyDefinitions, prepareSubflowRootInputs, subflowDependencyMapKey, type SubflowDefinition, type SubflowParameter, type SubflowPort } from '../../utils/subflows';
import { selectSingleSourceHandleData } from '../../utils/sourceHandleData';
import { useUpdateNodeData } from './useUpdateNodeData';

function waitForNode(nodeId: string, executionToken: string) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cancelSeq = useRunBusStore.getState().cancelSeq;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      window.clearTimeout(timer);
      resolve(ok);
    };
    const unsubscribe = useRunBusStore.subscribe((state) => {
      if (state.cancelSeq !== cancelSeq) finish(false);
      else if (matchesRunCompletion(state.lastDone, nodeId, executionToken)) finish(state.lastDone.ok);
      else if (state.executionTokens[nodeId] !== executionToken) finish(false);
    });
    const timer = window.setTimeout(() => finish(false), 60 * 60 * 1000);
    const current = useRunBusStore.getState();
    if (current.cancelSeq !== cancelSeq) finish(false);
    else if (matchesRunCompletion(current.lastDone, nodeId, executionToken)) finish(current.lastDone.ok);
    else if (current.executionTokens[nodeId] !== executionToken) finish(false);
  });
}

function handleTop(index: number, count: number) {
  return `${Math.max(18, Math.min(82, ((index + 1) / (count + 1)) * 100))}%`;
}

function PortList({ ports, side }: { ports: SubflowPort[]; side: 'input' | 'output' }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${side === 'output' ? 'items-end text-right' : ''}`}>
      {ports.length ? ports.map((port) => (
        <div key={port.id} className="flex w-full min-w-0 items-center gap-1 text-[10px] text-[var(--text-secondary)]">
          {side === 'input' && <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: 'var(--accent-primary)' }} />}
          <span className="truncate" title={`${port.name} · ${port.kind}`}>{port.name}</span>
          <span className="shrink-0 opacity-55">{port.kind}</span>
          {side === 'output' && <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: 'var(--accent-secondary, var(--accent-primary))' }} />}
        </div>
      )) : <span className="text-[10px] opacity-45">无{side === 'input' ? '输入' : '输出'}</span>}
    </div>
  );
}

function parameterValue(parameter: SubflowParameter, overrides: Record<string, unknown>) {
  return Object.hasOwn(overrides, parameter.id) ? overrides[parameter.id] : parameter.defaultValue;
}

function coerceParameterValue(parameter: SubflowParameter, raw: string | boolean) {
  if (parameter.schema?.type === 'boolean') return Boolean(raw);
  if (parameter.schema?.type === 'integer') return Math.trunc(Number(raw));
  if (parameter.schema?.type === 'number') return Number(raw);
  return String(raw);
}

function ParameterEditor({ parameter, overrides, onChange, onReset }: {
  parameter: SubflowParameter;
  overrides: Record<string, unknown>;
  onChange: (value: unknown) => void;
  onReset: () => void;
}) {
  const value = parameterValue(parameter, overrides);
  const overridden = Object.hasOwn(overrides, parameter.id);
  const enumValues = parameter.schema?.enum || [];
  return <label className="block min-w-0 text-[10px] text-[var(--text-secondary)]" title={parameter.description || parameter.name}>
    <span className="mb-1 flex items-center justify-between gap-2"><span className="truncate font-semibold text-[var(--text-primary)]">{parameter.name}{parameter.required ? ' *' : ''}</span>{overridden && <button type="button" className="nodrag grid h-5 w-5 shrink-0 place-items-center rounded border border-[var(--border-primary)]" title="恢复定义默认值" onClick={(event) => { event.preventDefault(); onReset(); }}><RotateCcw size={11} /></button>}</span>
    {enumValues.length > 0 ? <select className="nodrag h-8 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-primary)]" value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>{enumValues.map((item) => <option key={JSON.stringify(item)} value={String(item)}>{String(item)}</option>)}</select>
      : parameter.schema?.type === 'boolean' ? <span className="flex h-8 items-center gap-2 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2"><input type="checkbox" className="nodrag" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />{Boolean(value) ? '开启' : '关闭'}</span>
        : <input className="nodrag h-8 w-full rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-primary)]" type={parameter.schema?.type === 'number' || parameter.schema?.type === 'integer' ? 'number' : 'text'} min={parameter.schema?.minimum} max={parameter.schema?.maximum} value={String(value ?? '')} onChange={(event) => onChange(coerceParameterValue(parameter, event.target.value))} />}
  </label>;
}

function collectOutputData(nodes: Node[], definition: SubflowDefinition, outputSources: Record<string, { nodeId: string; handle?: string | null }>) {
  const result: Record<string, unknown> = { subflowOutputs: {} };
  const arrays = new Map<string, unknown[]>();
  for (const port of definition.outputs) {
    const outputSource = outputSources[port.id];
    const source = nodes.find((node) => node.id === outputSource?.nodeId);
    const data = selectSingleSourceHandleData(
      (source?.data || {}) as Record<string, unknown>,
      outputSource?.handle,
      port.kind,
    );
    (result.subflowOutputs as Record<string, unknown>)[port.id] = data;
    for (const key of ['prompt', 'text', 'outputText', 'imageUrl', 'videoUrl', 'audioUrl', 'modelUrl']) {
      if (result[key] == null && data[key] != null) result[key] = data[key];
    }
    for (const key of ['imageUrls', 'videoUrls', 'audioUrls', 'modelUrls', 'textSegments']) {
      if (Array.isArray(data[key])) arrays.set(key, [...(arrays.get(key) || []), ...(data[key] as unknown[])]);
    }
  }
  arrays.forEach((value, key) => { result[key] = [...new Set(value)]; });
  return result;
}

const SubflowNode = memo((props: NodeProps) => {
  const data = (props.data || {}) as Record<string, any>;
  const definition = data.definition as SubflowDefinition | undefined;
  const inputs = Array.isArray(definition?.inputs) ? definition!.inputs : [];
  const outputs = Array.isArray(definition?.outputs) ? definition!.outputs : [];
  const update = useUpdateNodeData(props.id);
  const { getNodes, getEdges, setNodes, setEdges } = useReactFlow();
  const overrides = useMemo(() => data.parameterOverrides || {}, [data.parameterOverrides]);
  const parameters = useMemo(() => (definition?.exposedParameters || []).filter((parameter) => !isPrivateSubflowDataKey(parameter.dataKey) && !isPrivateSubflowDataKey(parameter.name)), [definition]);
  const updateParameter = useCallback((parameter: SubflowParameter, value: unknown) => {
    update({ parameterOverrides: { ...overrides, [parameter.id]: value } });
  }, [overrides, update]);
  const resetParameter = useCallback((parameter: SubflowParameter) => {
    const next = { ...overrides };
    delete next[parameter.id];
    update({ parameterOverrides: next });
  }, [overrides, update]);

  useEffect(() => {
    if (!definition) return undefined;
    return registerRunNodeExecutionContexts({
      [props.id]: {
        subflowPath: [],
        originalNodeId: props.id,
        definitionId: definition.id,
        definitionVersion: definition.version,
        inputSnapshot: {
          definitionId: definition.id,
          definitionVersion: definition.version,
          parameterOverrides: overrides,
        },
      },
    });
  }, [definition, overrides, props.id]);

  const run = useCallback(async () => {
    if (!definition) throw new Error('子工作流定义缺失');
    const dependencyDefinitions = await loadSubflowDependencyDefinitions(definition, (reference) => api.getSubflow(reference.definitionId, reference.version, reference.projectId));
    const compiled = compileSubflow(definition, props.id, overrides, {
      resolveDefinition: (reference) => dependencyDefinitions.get(subflowDependencyMapKey(reference)),
    });
    const existingNodes = getNodes();
    const existingEdges = getEdges();
    const rootInputs = prepareSubflowRootInputs(definition, props.id, existingNodes, existingEdges, compiled.inputTargets);
    const runtimeIds = new Set([...compiled.nodes, ...rootInputs.nodes].map((node) => node.id));
    const parentNodeRunId = useRunBusStore.getState().activeNodeRunIds[props.id];
    const unregisterExecutionContexts = registerRunNodeExecutionContexts(Object.fromEntries(
      Object.entries(compiled.trace).map(([nodeId, trace]) => [nodeId, {
        subflowPath: trace.instancePath.slice(0, -1),
        originalNodeId: trace.originalNodeId,
        definitionId: trace.definitionId,
        definitionVersion: trace.definitionVersion,
        inputSnapshot: trace.inputSnapshot,
        parentNodeRunId,
      }]),
    ));
    const instance = existingNodes.find((node) => node.id === props.id);
    const origin = instance?.position || { x: 0, y: 0 };
    const runtimeNodes = [...compiled.nodes, ...rootInputs.nodes].map((node) => ({
      ...node,
      position: { x: origin.x + node.position.x + 360, y: origin.y + node.position.y },
      selectable: false,
      draggable: false,
      style: { ...(node.style || {}), opacity: 0, pointerEvents: 'none' } satisfies CSSProperties,
      data: { ...(node.data || {}), __subflowRuntime: true },
    }));
    const runtimeEdges = [...compiled.edges, ...rootInputs.edges];
    const runtimeEdgeIds = new Set(runtimeEdges.map((edge) => edge.id));
    setNodes((current) => [...current.filter((node) => !runtimeIds.has(node.id)), ...runtimeNodes]);
    setEdges((current) => [...current.filter((edge) => !runtimeEdgeIds.has(edge.id)), ...runtimeEdges]);
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    try {
      for (const batch of compiled.batches) {
        const runnable = batch.filter((nodeId) => {
          const node = compiled.nodes.find((item) => item.id === nodeId);
          return Boolean(node?.type && EXECUTABLE_NODE_TYPES.has(node.type));
        });
        if (!runnable.length) continue;
        const executionTokens = useRunBusStore.getState().triggerRunMany(runnable, 'batch');
        const waits = runnable.map((nodeId) => waitForNode(nodeId, executionTokens[nodeId]));
        const results = await Promise.all(waits);
        const failedIndex = results.findIndex((ok) => !ok);
        if (failedIndex >= 0) throw new Error(`子工作流内部节点失败: ${runnable[failedIndex].split('::').pop()}`);
      }
      const latestNodes = getNodes();
      update({
        ...collectOutputData(latestNodes, definition, compiled.outputSources),
        lastRunAt: Date.now(),
        lastRunStatus: 'succeeded',
      });
    } catch (error) {
      update({ lastRunAt: Date.now(), lastRunStatus: 'failed', lastRunError: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      unregisterExecutionContexts();
      setNodes((current) => current.filter((node) => !runtimeIds.has(node.id)));
      setEdges((current) => current.filter((edge) => !runtimeEdgeIds.has(edge.id)));
    }
  }, [definition, getEdges, getNodes, overrides, props.id, setEdges, setNodes, update]);

  useRunTrigger(props.id, run, 'subflow');

  return (
    <div className="relative w-[330px] overflow-hidden rounded-md border-2 border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-lg">
      {inputs.map((port, index) => (
        <Handle key={port.id} id={port.id} type="target" position={Position.Left} style={{ top: handleTop(index, inputs.length), width: 12, height: 12 }} />
      ))}
      {outputs.map((port, index) => (
        <Handle key={port.id} id={port.id} type="source" position={Position.Right} style={{ top: handleTop(index, outputs.length), width: 12, height: 12 }} />
      ))}
      <div className="flex h-14 items-center gap-3 border-b border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_18%,var(--bg-secondary))] px-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded bg-[var(--accent-primary)] text-white"><Workflow size={19} /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{definition?.name || '子工作流缺失'}</div>
          <div className="truncate text-[10px] opacity-65">v{definition?.version || '?'} · {definition?.nodes?.length || 0} 节点 · 固定版本</div>
        </div>
        <GitFork size={16} className="opacity-55" />
      </div>
      <div className="grid min-h-24 grid-cols-2 gap-4 px-4 py-3">
        <PortList ports={inputs} side="input" />
        <PortList ports={outputs} side="output" />
      </div>
      {parameters.length > 0 && <div className="space-y-2 border-t border-[var(--border-primary)] px-4 py-3">
        <div className="flex items-center justify-between text-[10px]"><span className="font-bold">公开参数</span><span className="text-[var(--text-secondary)]">{parameters.length} 项可覆盖</span></div>
        {parameters.map((parameter) => <ParameterEditor key={parameter.id} parameter={parameter} overrides={overrides} onChange={(value) => updateParameter(parameter, value)} onReset={() => resetParameter(parameter)} />)}
        <div className="text-[9px] leading-4 text-[var(--text-secondary)]">未公开设置随 v{definition?.version} 固定；私密凭据读取全局设置。</div>
      </div>}
      <div className="grid grid-cols-2 gap-2 border-t border-[var(--border-primary)] p-3">
        <button type="button" className="nodrag flex h-9 items-center justify-center gap-2 rounded border border-[var(--border-primary)] bg-[var(--bg-tertiary)] text-xs font-semibold" onClick={() => window.dispatchEvent(new CustomEvent('penguin:subflow-open', { detail: { nodeId: props.id, definition } }))}>
          <ExternalLink size={14} /> 查看内部
        </button>
        <button type="button" className="nodrag flex h-9 items-center justify-center gap-2 rounded bg-[var(--accent-primary)] text-xs font-bold text-white" onClick={() => requestCanvasNodeRun(props.id)}>
          <Play size={14} fill="currentColor" /> 运行
        </button>
      </div>
      <div className="px-3 pb-2 text-[10px] opacity-60">
        {data.lastRunStatus === 'failed' ? `失败：${data.lastRunError || '内部节点错误'}` : data.lastRunAt ? `上次运行 ${new Date(data.lastRunAt).toLocaleTimeString()}` : '尚未运行'}
      </div>
    </div>
  );
});

SubflowNode.displayName = 'SubflowNode';
export default SubflowNode;
