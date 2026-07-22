import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, type NodeProps, type Node, type Edge } from '@xyflow/react';
import { Repeat, Play, Square, Loader2, AlertCircle, GitBranch, Layers } from 'lucide-react';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useThemeStore } from '../../stores/theme';
import { matchesRunCompletion, useRunBusStore } from '../../stores/runBus';
import { useUpstreamMaterials, type MaterialKind, type Material } from './useUpstreamMaterials';
import { topologicalSort } from '../../utils/topologicalSort';
import { excludeRandomRouteBranchDescendants } from '../../utils/randomRoute';
import { EXECUTABLE_NODE_TYPES } from '../../config/executableNodeTypes';
import {
  buildLoopCustomIterationInputs,
  buildLoopParallelCloneGraph,
  isLoopRunRequestId,
  loopParallelCloneNodeId,
  normalizeLoopCustomMaterialConfig,
  type LoopCustomIterationInput,
} from '../../utils/loopDerivedExecution';
import { PORT_COLOR } from '../../config/portTypes';
import LoopingVideo from '../LoopingVideo';
import SmartImage from '../SmartImage';
// v1.2.10.5: 节点落点防重叠 —— 多链克隆子图整组避让
import { placeBatchNodes, rectOf, type Rect as PlacementRect } from '../../utils/nodePlacement';
import type { RunContext } from '../../types/project';

/**
 * LoopNode — 工具节点：循环器（v1.2.8 新增）
 *
 * 功能:
 *   1. 接收上游 N 个同类型素材 (text / image / video / audio)
 *   2. 三种模式:
 *      - serial 串联循环: 每轮把第 i 个素材注入自身 → 触发整条下游可执行子图 → 等成功/失败 → 下一轮
 *      - parallel 并联循环: 克隆 (N-1) 份完整下游子图并分别连接第 i 个来源素材
 *        → 并发触发 N 条链 → 等所有完成
 *      - parallel-custom 并联循环（自定义）: 主素材决定轮数，每种素材独立选择顺序取值或固定复用；
 *        每条链通过 __loopCustomInput 读取隔离快照，避免同源数组被每个克隆重复整组读取
 *   3. 输出聚合: imageUrls / urls / videoUrls / audioUrls 数组 (失败位 null 占位)
 *
 * 重要不变量:
 *   - 不修改任何现有 16 个可执行节点
 *   - 原有 serial / parallel 的素材读取与执行语义保持不变
 *   - 仅利用 v1.2.8 扩展的 runBus.runningIds + triggerRunMany
 */

// 自动计算型下游节点：没有 useRunTrigger，不应放入 EXEC_TYPES 等待 runBus，
// 但循环器每轮注入素材后，这些节点会通过 useUpstreamMaterials/useEffect 自行刷新 data。
const PASSIVE_LOOP_TYPES = new Set<string>(['text-split']);

const COLOR = '#a78bfa'; // violet-400

type LoopMode = 'serial' | 'parallel' | 'parallel-custom';

const KIND_LABEL: Record<MaterialKind, string> = { text: '文本', image: '图像', video: '视频', audio: '音频' };

// ===== helper: 把单条素材注入 patch =====
function buildItemPatch(kind: MaterialKind, item: string) {
  if (kind === 'image') return { imageUrl: item, imageUrls: [item] };
  if (kind === 'video') return { videoUrl: item };
  if (kind === 'audio') return { audioUrl: item };
  // text
  return { text: item, prompt: item, outputText: item, textSegments: [item], segments: [item], texts: [item] };
}
// 重置 patch（开始新轮次前清空可能的旧数据）
function buildResetPatch(kind: MaterialKind) {
  if (kind === 'image') return { imageUrl: '', imageUrls: [] };
  if (kind === 'video') return { videoUrl: '' };
  if (kind === 'audio') return { audioUrl: '' };
  return { text: '', prompt: '', outputText: '', textSegments: [], segments: [], texts: [] };
}

function buildCustomInputPatch(input: LoopCustomIterationInput) {
  const text = input.texts[0]?.url || '';
  const image = input.images[0]?.url || '';
  const video = input.videos[0]?.url || '';
  const audio = input.audios[0]?.url || '';
  return {
    text,
    prompt: text,
    outputText: text,
    textSegments: text ? [text] : [],
    segments: text ? [text] : [],
    texts: text ? [text] : [],
    imageUrl: image,
    imageUrls: image ? [image] : [],
    urls: image ? [image] : [],
    videoUrl: video,
    videoUrls: video ? [video] : [],
    audioUrl: audio,
    audioUrls: audio ? [audio] : [],
  };
}

const EMPTY_CUSTOM_INPUT: LoopCustomIterationInput = { texts: [], images: [], videos: [], audios: [] };

// ===== helper: 从某个节点 data 提取对应 kind 的产物 url/text =====
// v1.2.9.11: kind 不匹配兜底 —— 用户场景: 上游图像 (kind=image) → 循环器 → 视频节点 → OutputNode
//   原版 extractFromNode(kind='image') 在视频节点上读不到 imageUrl/firstFrameUrl → 返回 null → failCount++,
//   循环器显示「2/2 失败 2」即使下游视频节点本轮成功生成了 videoUrl。
//   修复: 优先匹配 kind 字段, 找不到时遍历所有产物字段 (imageUrl / videoUrl / audioUrl / outputText 等)
//        只要任一非空就视为本轮成功。这样允许「输入图、输出视频」「输入视频、输出音频」等混合产物链路在循环里正常累积。
function extractFromNode(node: Node | undefined, kind: MaterialKind): string | null {
  if (!node) return null;
  const ud: any = node.data || {};
  if (kind === 'image') {
    if (typeof ud.imageUrl === 'string' && ud.imageUrl) return ud.imageUrl;
    if (Array.isArray(ud.imageUrls) && ud.imageUrls[0]) return ud.imageUrls[0];
    if (Array.isArray(ud.urls) && ud.urls[0]) return ud.urls[0];
    // v1.2.8.5: FramePair 节点兼容 (firstFrameUrl/lastFrameUrl 两个字段中任一表明本轮有产物)
    if (typeof ud.firstFrameUrl === 'string' && ud.firstFrameUrl) return ud.firstFrameUrl;
    if (typeof ud.lastFrameUrl === 'string' && ud.lastFrameUrl) return ud.lastFrameUrl;
  } else if (kind === 'video') {
    if (typeof ud.videoUrl === 'string' && ud.videoUrl) return ud.videoUrl;
    // v1.2.9.2: 循环视频 → FramePair (视频输入 → 图像输出) 兼容 —— 避免误报失败
    if (typeof ud.firstFrameUrl === 'string' && ud.firstFrameUrl) return ud.firstFrameUrl;
    if (typeof ud.lastFrameUrl === 'string' && ud.lastFrameUrl) return ud.lastFrameUrl;
  } else if (kind === 'audio') {
    if (typeof ud.audioUrl === 'string' && ud.audioUrl) return ud.audioUrl;
  } else {
    if (typeof ud.outputText === 'string' && ud.outputText) return ud.outputText;
    if (typeof ud.reply === 'string' && ud.reply) return ud.reply;
    if (typeof ud.text === 'string' && ud.text) return ud.text;
    if (typeof ud.prompt === 'string' && ud.prompt) return ud.prompt;
  }
  // v1.2.9.11: kind 不匹配兜底 —— 任何非空产物字段都算成功
  if (typeof ud.videoUrl === 'string' && ud.videoUrl) return ud.videoUrl;
  if (typeof ud.audioUrl === 'string' && ud.audioUrl) return ud.audioUrl;
  if (typeof ud.imageUrl === 'string' && ud.imageUrl) return ud.imageUrl;
  if (Array.isArray(ud.imageUrls) && ud.imageUrls[0]) return ud.imageUrls[0];
  if (typeof ud.firstFrameUrl === 'string' && ud.firstFrameUrl) return ud.firstFrameUrl;
  if (typeof ud.lastFrameUrl === 'string' && ud.lastFrameUrl) return ud.lastFrameUrl;
  if (typeof ud.outputText === 'string' && ud.outputText) return ud.outputText;
  if (typeof ud.reply === 'string' && ud.reply) return ud.reply;
  return null;
}

// ===== helper: BFS 沿出边收集可达节点 (含起点) =====
function bfsForward(allEdges: Edge[], starts: string[]): Set<string> {
  const visited = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const e of allEdges) {
      if (e.source === cur && !visited.has(e.target)) queue.push(e.target);
    }
  }
  return visited;
}

function hasPassiveLoopNode(nodes: Node[]): boolean {
  return nodes.some((node) => node.type && PASSIVE_LOOP_TYPES.has(node.type));
}

// ===== helper: 触发节点并只等待本次 execution token =====
const LOOP_NODE_WAIT_TIMEOUT_MS = 60 * 60 * 1000;

function awaitTriggeredNode(
  nodeId: string,
  cancelRef: React.MutableRefObject<boolean>,
  runContext: RunContext | null,
  timeoutMs = LOOP_NODE_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const startCancelSeq = useRunBusStore.getState().cancelSeq;
    let executionToken: string | null = null;
    const finish = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      off();
      window.clearTimeout(timer);
      resolve(ok);
    };
    const off = useRunBusStore.subscribe((state) => {
      if (cancelRef.current || (state.cancelSeq !== startCancelSeq && state.cancelTargets.includes(nodeId))) finish(false);
      else if (matchesRunCompletion(state.lastDone, nodeId, executionToken)) finish(state.lastDone.ok);
      else if (executionToken && state.executionTokens[nodeId] !== executionToken) finish(false);
    });
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    // 用 triggerRunMany([id]) 而非 triggerRun(id) 触发——这样并联多链时 currentRunId 不会互相覆盖
    const tokens = useRunBusStore.getState().triggerRunMany([nodeId], 'batch', runContext);
    executionToken = tokens[nodeId] || null;
    const current = useRunBusStore.getState();
    if (cancelRef.current || (current.cancelSeq !== startCancelSeq && current.cancelTargets.includes(nodeId))) finish(false);
    else if (matchesRunCompletion(current.lastDone, nodeId, executionToken)) finish(current.lastDone.ok);
    else if (!executionToken || current.executionTokens[nodeId] !== executionToken) finish(false);
  });
}

function awaitNode(nodeId: string, cancelRef: React.MutableRefObject<boolean>, runContext: RunContext | null, timeoutMs = LOOP_NODE_WAIT_TIMEOUT_MS): Promise<boolean> {
  return awaitTriggeredNode(nodeId, cancelRef, runContext, timeoutMs);
}

// 并联模式每条克隆链仍逐节点独立触发，但不同链可同时等待各自的 token。
function awaitOnly(nodeId: string, cancelRef: React.MutableRefObject<boolean>, runContext: RunContext | null, timeoutMs = LOOP_NODE_WAIT_TIMEOUT_MS): Promise<boolean> {
  return awaitTriggeredNode(nodeId, cancelRef, runContext, timeoutMs);
}

const LoopNode = (p: NodeProps) => {
  const id = p.id;
  const update = useUpdateNodeData(id);
  const d = (p.data as any) || {};
  const { theme, style } = useThemeStore();
  const isPixel = style === 'pixel';
  const isDark = theme === 'dark';
  const rf = useReactFlow();

  const mode: LoopMode = d?.mode === 'parallel-custom'
    ? 'parallel-custom'
    : d?.mode === 'parallel'
      ? 'parallel'
      : 'serial';
  const kind: MaterialKind = (['text', 'image', 'video', 'audio'] as const).includes(d?.kind) ? d.kind : 'image';
  const status: 'idle' | 'running' | 'success' | 'error' = d?.status || 'idle';
  const progress: { done: number; total: number; ok: number; fail: number } = d?.progress || { done: 0, total: 0, ok: 0, fail: 0 };
  const outputs: Array<string | null> = Array.isArray(d?.outputs) ? d.outputs : [];

  const [error, setError] = useState<string | null>(d?.error || null);
  const cancelRef = useRef<boolean>(false);

  // 上游素材聚合 (按 kind 取对应数组)
  // v1.2.8.1: items 从 string[] 改为 Material[], 保留 sourceNodeId 供并联克隆时直连原始上游
  const upstream = useUpstreamMaterials(id);
  const items = useMemo<Material[]>(() => {
    const list = kind === 'image' ? upstream.images
      : kind === 'video' ? upstream.videos
      : kind === 'audio' ? upstream.audios
      : upstream.texts;
    return list.filter((m) => Boolean(m.url));
  }, [upstream.images, upstream.videos, upstream.audios, upstream.texts, kind]);
  const customConfig = useMemo(() => normalizeLoopCustomMaterialConfig(d), [d?.kind, d?.parallelCustomStrategies, d?.parallelCustomFixedIndexes]);
  const customIterationInputs = useMemo(() => buildLoopCustomIterationInputs({
    texts: upstream.texts,
    images: upstream.images,
    videos: upstream.videos,
    audios: upstream.audios,
  }, customConfig), [upstream.texts, upstream.images, upstream.videos, upstream.audios, customConfig]);

  // ===== 串联执行 =====
  const runSerial = useCallback(async (runContext: RunContext | null): Promise<void> => {
    if (items.length === 0) { setError('上游没有可循环的素材'); return; }
    setError(null);
    cancelRef.current = false;
    update({ status: 'running', error: null, outputs: [], progress: { done: 0, total: items.length, ok: 0, fail: 0 }, ...buildResetPatch(kind) });

    const allNodes = rf.getNodes();
    const allEdges = rf.getEdges();

    // v1.2.9.6: 自动清理「循环器 → 输出素材」的连线与孤儿 OutputNode 节点
    //          —— 循环器不产出最终结果, 这种连接产生的空白 OutputNode 体验很差,
    //          运行时主动断开 + 孤立则删除节点 (不孤立则仅删边保留节点)。
    const removeEdgeIds = new Set<string>();
    const orphanOutputIds = new Set<string>();
    for (const e of allEdges) {
      if (e.source !== id) continue;
      const t = allNodes.find((n) => n.id === e.target);
      if (t?.type !== 'output') continue;
      removeEdgeIds.add(e.id);
      const otherInbound = allEdges.some((x) => x.id !== e.id && x.target === e.target);
      if (!otherInbound) orphanOutputIds.add(e.target);
    }
    if (removeEdgeIds.size > 0) {
      rf.setEdges((eds) => eds.filter((x) => !removeEdgeIds.has(x.id)));
      if (orphanOutputIds.size > 0) {
        rf.setNodes((nds) => nds.filter((n) => !orphanOutputIds.has(n.id)));
      }
    }

    const directEdges = allEdges
      .filter((e) => e.source === id && !removeEdgeIds.has(e.id))
      .sort((left, right) => left.id.localeCompare(right.id) || left.target.localeCompare(right.target));
    const directs = directEdges.map((e) => e.target);
    if (directs.length === 0) { setError('请先把循环器输出端连到下游执行节点'); update({ status: 'error', error: '未连接下游' }); return; }

    const reachable = bfsForward(allEdges, directs);
    const subNodes = allNodes.filter((n) => reachable.has(n.id));
    const subEdges = allEdges.filter((e) => reachable.has(e.source) && reachable.has(e.target));
    const routePlanned = excludeRandomRouteBranchDescendants(subNodes, subEdges);
    const order = topologicalSort(routePlanned.nodes, routePlanned.edges, EXECUTABLE_NODE_TYPES);
    const passiveOnly = order.length === 0 && hasPassiveLoopNode(subNodes);
    if (order.length === 0 && !passiveOnly) { setError('下游链路上没有可执行节点'); update({ status: 'error', error: '无可执行节点' }); return; }

    // === v1.2.9.0: 全新累积参数机制 ===
    // 思路: 不再克隆 OutputNode 节点。改为给所有下游 EXEC + OUTPUT 节点注入 __loopAccumulate 标记,
    //      OutputNode 检测到上游含 __loopAccumulate 时跳过 fresh 收集 (让 direct*Urls 累积值独占显示)。
    //      LoopNode 每轮收尾读上游 fresh 产物 → 追加到 OutputNode 的 direct*Urls / directOutputText。
    //      跑 N 轮 = OutputNode 内累积 N 张图 (不增加节点污染画布), 生成节点本身始终只显示最新一轮。
    // v1.2.9.5: 回滚 v1.2.9.4 的「给 LoopNode 自身注入 __loopAccumulate」——循环器不输出任何结果到下游,
    //          也不让「直接接 LoopNode 的 OutputNode」变成「累积循环输入素材」 (与下游 EXEC→OutputNode 累积重复)。
    //          直接接的 OutputNode 渲染侧会显示「循环器无输出」提示代替 0 项空白。
    const execSubIds = new Set<string>(subNodes.filter((n) => EXECUTABLE_NODE_TYPES.has(n.type as string)).map((n) => n.id));
    // v1.2.9.9: outputNodeIds 改为「动态发现」——原因: 循环中 FramePair 等 EXEC 节点首次产生 firstFrameUrl/lastFrameUrl 后,
    //          Canvas autoOutput 会动态创建 OutputNode 接到它们身后。若 outputNodeIds 在 runSerial 开始时固化,
    //          这些运行中创建的 OutputNode 不会被 writeFreshToOutputs 写入 → 只显示最后一轮 (fresh 路由)。
    //          改为每次需要时从当前 nodes/edges 状态重新 BFS execSubIds 的下游 type='output' 节点 (含二级链路)。
    const discoverOutputNodeIds = (): Set<string> => {
      const cn = rf.getNodes();
      const ce = rf.getEdges();
      const found = new Set<string>();
      const visited = new Set<string>();
      const queue: string[] = Array.from(execSubIds);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        for (const e of ce) {
          if (e.source !== cur) continue;
          const tn = cn.find((n) => n.id === e.target);
          if (!tn) continue;
          if (tn.type === 'output') found.add(tn.id);
          if (!visited.has(tn.id)) queue.push(tn.id); // 继续 BFS 支持 OutputNode→OutputNode 二级链路
        }
      }
      return found;
    };
    // knownOutputs: 跨轮跟踪“已被写入过的 OutputNode”, 首次发现的新 OutputNode 在 writeFreshToOutputs 中视为 cur=[] 起算
    //              (避免继承旧画布 stale directImageUrls)
    const knownOutputs = new Set<string>(subNodes.filter((n) => n.type === 'output').map((n) => n.id));

    // === v1.2.9.13: EXEC 节点产物跨轮累积器 ===
    // 原 writeFreshToOutputs 仅基于「当前 ud」收集 fresh —— 但 RH 节点在循环中始终带 __loopAccumulate,
    // autoOutput 跳过它 → OutputNode 直到 finally 清除标记后才被新建并 upgrade pickKind='image', pickIndex=0,
    // 此时 directImageUrls 为空 → hasAnyDirectAccumulated=false → pickKind 切割成 1 张 (用户只看到最后一轮)。
    // 修复: 跨轮 accumulate 每个 EXEC 节点的 fresh 字段, write 时基于 accumulator,
    // 即使 OutputNode 是循环结束后才建/升级, finally 兜底 write 也能拿到完整累积
    // (与 v1.2.9.10 hasAnyDirectAccumulated 跳过 pickKind 切割双保险)。
    type ExecAcc = { isFP: boolean; isSuno: boolean; firsts: string[]; lasts: string[]; auds0: string[]; auds1: string[]; imgs: string[]; vids: string[]; auds: string[]; txts: string[] };
    const execAccumulator = new Map<string, ExecAcc>();
    const ensureAcc = (eid: string): ExecAcc => {
      let a = execAccumulator.get(eid);
      if (!a) { a = { isFP: false, isSuno: false, firsts: [], lasts: [], auds0: [], auds1: [], imgs: [], vids: [], auds: [], txts: [] }; execAccumulator.set(eid, a); }
      return a;
    };
    const pushUniqArr = (arr: string[], v: any) => {
      if (typeof v !== 'string') return;
      const s = v.trim();
      if (!s) return;
      if (arr.indexOf(s) === -1) arr.push(s);
    };
    // 从当前 RF 状态采集所有 EXEC 节点 ud 的产物字段, 累积进 execAccumulator (跨轮持续追加, dedup)。
    // 在每轮 awaitNode 完成后 + finally 兜底各调一次。
    const harvestFromExec = () => {
      const cn = rf.getNodes();
      for (const eid of execSubIds) {
        const n = cn.find((x) => x.id === eid);
        if (!n) continue;
        const ud: any = n.data || {};
        const acc = ensureAcc(eid);
        const isFP = Object.prototype.hasOwnProperty.call(ud, 'firstFrameUrl') &&
                     Object.prototype.hasOwnProperty.call(ud, 'lastFrameUrl');
        if (isFP) {
          acc.isFP = true;
          pushUniqArr(acc.firsts, ud.firstFrameUrl);
          pushUniqArr(acc.lasts, ud.lastFrameUrl);
          continue;
        }
        // v1.2.9.14: Suno 双轨检测 (与 FramePair 同模式) —— 同时具备 audioUrl + audioUrl_1 属性
        const isSuno = Object.prototype.hasOwnProperty.call(ud, 'audioUrl') &&
                       Object.prototype.hasOwnProperty.call(ud, 'audioUrl_1');
        if (isSuno) {
          acc.isSuno = true;
          pushUniqArr(acc.auds0, ud.audioUrl);     // 主轨 → audio-0
          pushUniqArr(acc.auds1, ud.audioUrl_1);   // 副轨 → audio-1
          // 另外 audioUrls 数组 (LoopNode 聚合过) 也合入主轨作为兼容
          if (Array.isArray(ud.audioUrls)) ud.audioUrls.forEach((u: any) => pushUniqArr(acc.auds0, u));
          // 同时走下面的 imgs/vids/txts 路径准备其他可能存在的产物 (Suno 实际不会产生, 但保证广義安全)
          continue;
        }
        pushUniqArr(acc.imgs, ud.imageUrl);
        if (Array.isArray(ud.imageUrls)) ud.imageUrls.forEach((u: any) => pushUniqArr(acc.imgs, u));
        if (Array.isArray(ud.urls)) ud.urls.forEach((u: any) => pushUniqArr(acc.imgs, u));
        if (Array.isArray(ud.generatedImages)) ud.generatedImages.forEach((u: any) => pushUniqArr(acc.imgs, u));
        pushUniqArr(acc.vids, ud.videoUrl);
        if (Array.isArray(ud.videoUrls)) ud.videoUrls.forEach((u: any) => pushUniqArr(acc.vids, u));
        pushUniqArr(acc.auds, ud.audioUrl);
        pushUniqArr(acc.auds, ud.audioUrl_1);
        if (Array.isArray(ud.audioUrls)) ud.audioUrls.forEach((u: any) => pushUniqArr(acc.auds, u));
        const textArrays = [ud.textSegments, ud.segments, ud.texts].filter(Array.isArray);
        if (textArrays.length > 0) {
          textArrays.forEach((arr: any) => arr.forEach((t: any) => pushUniqArr(acc.txts, t)));
        } else {
          if (typeof ud.outputText === 'string' && ud.outputText) pushUniqArr(acc.txts, ud.outputText);
          if (typeof ud.reply === 'string' && ud.reply) pushUniqArr(acc.txts, ud.reply);
          if (typeof ud.text === 'string' && ud.text) pushUniqArr(acc.txts, ud.text);
        }
      }
    };
    // 进入循环前: 仅标记下游 EXEC 节点 (让 OutputNode 跳过 fresh) + 清空已知 OutputNode 的累积字段。
    //         不给 OutputNode / LoopNode 本身注入 __loopAccumulate。
    //         运行中被 autoOutput 动态创建的新 OutputNode 不需清空 (本来就空)。
    rf.setNodes((prev) => prev.map((nd) => {
      const isExec = execSubIds.has(nd.id);
      const isOut = knownOutputs.has(nd.id);
      if (!isExec && !isOut) return nd;
      const od: any = nd.data || {};
      const next: any = { ...od };
      if (isExec) next.__loopAccumulate = id;
      if (isOut) {
        next.directImageUrls = [];
        next.directVideoUrls = [];
        next.directAudioUrls = [];
        next.directOutputText = '';
        next.directImageUrl = '';
        next.directVideoUrl = '';
        next.directAudioUrl = '';
      }
      return { ...nd, data: next };
    }));

    const collected: Array<string | null> = [];
    let okCount = 0; let failCount = 0;

    // === v1.2.9.8: 彻底放弃「OutputNode useEffect 自动累积 fresh」机制 (v1.2.9.2/4/7 均被抩废)
    //   原因:
    //     - FramePair 等节点每轮多次 update (reset / 首帧 / success) 让 OutputNode useEffect 多次 fire
    //     - StrictMode 双调 + 二级链路 (right OutputNode 接 left OutputNode) + finally 清除 __loopAccumulate 后
    //       collected useMemo 重算 → fresh 会被最后多加一次进去, 造成“快跳后又多出一个」
        //     - ref 去重也无法掩盖跨 useEffect / 多 OutputNode / 二级链路 的所有 race
    //   新策略:
    //     LoopNode 每轮 awaitNode 完成后用 functional setNodes 一次性写入子图内所有 OutputNode.direct*Urls。
    //     时机严格可控 (一轮息严格一次写入) + functional setNodes 读取 store 最新 cur + 本轮内全局 seen 去重。
    //   OutputNode 侧: collected useMemo 仍保留 __loopAccumulate 跳过 fresh 逻辑 (避免中间眨烁 fresh 未走 direct 装准 OUT), 但不再有 useEffect 累积。
    const pushUniq = (arr: string[], seen: Set<string>, v: any) => {
      if (typeof v !== 'string') return;
      const s = v.trim();
      if (!s) return;
      if (seen.has(s)) return;
      seen.add(s);
      arr.push(s);
    };
    // 根据当前 edges + execSubIds + 动态发现的 outputNodeIds，按 OutputNode 结集 “本轮 fresh” 写入 direct*Urls。
    // v1.2.9.9: targets 改为每次调用重新 discover (含运行中 autoOutput 动态创建的 OutputNode)。
    //           首次发现的新 OutputNode (!knownOutputs.has) 视为 cur=[] 起算, 避免继承 stale。
    // v1.2.9.13: 改读 execAccumulator (跨轮累积记录) 代替“当前 ud” ——
    //            防止 「最后一轮 ud.imageUrl 已被最新后 finally write 只能拿到最后 1 张」 的覆盖问题。
    const writeFreshToOutputs = () => {
      const targets = discoverOutputNodeIds();
      if (targets.size === 0) return;
      rf.setNodes((nds) => {
        const curEdges = rf.getEdges();
        return nds.map((nd) => {
          if (!targets.has(nd.id)) return nd;
          const isNewOut = !knownOutputs.has(nd.id);
          // 仅采集 EXEC 节点 → 本 OutputNode 的上游边 (二级链路如 OutputNode→OutputNode 不收集, 由透传链路自然流动)
          const inEdges = curEdges.filter((e) => e.target === nd.id);
          const fImgs: string[] = []; const fVids: string[] = []; const fAuds: string[] = []; const fTxts: string[] = [];
          const seenI = new Set<string>(); const seenV = new Set<string>(); const seenA = new Set<string>(); const seenT = new Set<string>();
          for (const e of inEdges) {
            if (!execSubIds.has(e.source)) continue;
            const acc = execAccumulator.get(e.source);
            if (!acc) continue;
            const handle = (e as any).sourceHandle as string | null | undefined;
            // FramePair 双端口语义: 'first'/'last' 取对应字段, null/默认 双取
            if (acc.isFP) {
              if (handle === 'first' || handle == null) acc.firsts.forEach((u) => pushUniq(fImgs, seenI, u));
              if (handle === 'last' || handle == null) acc.lasts.forEach((u) => pushUniq(fImgs, seenI, u));
              continue;
            }
            // v1.2.9.14: Suno 双轨语义: 'audio-0' 主轨 / 'audio-1' 副轨 / null/默认 双取
            if (acc.isSuno) {
              if (handle === 'audio-0' || handle == null) acc.auds0.forEach((u) => pushUniq(fAuds, seenA, u));
              if (handle === 'audio-1' || handle == null) acc.auds1.forEach((u) => pushUniq(fAuds, seenA, u));
              continue;
            }
            // 通用 EXEC 节点: 跨轮累积的产物全集
            acc.imgs.forEach((u) => pushUniq(fImgs, seenI, u));
            acc.vids.forEach((u) => pushUniq(fVids, seenV, u));
            acc.auds.forEach((u) => pushUniq(fAuds, seenA, u));
            acc.txts.forEach((t) => pushUniq(fTxts, seenT, t));
          }
          if (fImgs.length === 0 && fVids.length === 0 && fAuds.length === 0 && fTxts.length === 0) return nd;
          const od: any = nd.data || {};
          // v1.2.9.9: 新 OutputNode 视为 cur=[], 避免继承旧画布 stale directImageUrls
          const curImgs: string[] = isNewOut ? [] : (Array.isArray(od.directImageUrls) ? od.directImageUrls : []);
          const curVids: string[] = isNewOut ? [] : (Array.isArray(od.directVideoUrls) ? od.directVideoUrls : []);
          const curAuds: string[] = isNewOut ? [] : (Array.isArray(od.directAudioUrls) ? od.directAudioUrls : []);
          const curTxts: string[] = isNewOut ? [] : (typeof od.directOutputText === 'string' && od.directOutputText
            ? od.directOutputText.split('\n\n') : []);
          const mergedI = curImgs.slice(); fImgs.forEach((u) => { if (mergedI.indexOf(u) === -1) mergedI.push(u); });
          const mergedV = curVids.slice(); fVids.forEach((u) => { if (mergedV.indexOf(u) === -1) mergedV.push(u); });
          const mergedA = curAuds.slice(); fAuds.forEach((u) => { if (mergedA.indexOf(u) === -1) mergedA.push(u); });
          const mergedT = curTxts.slice(); fTxts.forEach((t) => { if (mergedT.indexOf(t) === -1) mergedT.push(t); });
          let changed = false;
          const nextData: any = { ...od };
          if (mergedI.length !== curImgs.length || isNewOut) { nextData.directImageUrls = mergedI; changed = true; }
          if (mergedV.length !== curVids.length || isNewOut) { nextData.directVideoUrls = mergedV; changed = true; }
          if (mergedA.length !== curAuds.length || isNewOut) { nextData.directAudioUrls = mergedA; changed = true; }
          if (mergedT.length !== curTxts.length || isNewOut) { nextData.directOutputText = mergedT.join('\n\n'); changed = true; }
          return changed ? { ...nd, data: nextData } : nd;
        });
      });
      // 跨轮记住这批 OutputNode (下一轮不再视为新)
      targets.forEach((tid) => knownOutputs.add(tid));
    };

    // v1.2.9.0: 包 try/finally 保证 __loopAccumulate 标记总能被清除 (避免异常/取消后下游节点被永久冻住于累积模式)
    try {
    for (let i = 0; i < items.length; i++) {
      if (cancelRef.current) break;

      // 1. 注入第 i 个素材到本节点 (同时 reset 下游上一轮产出, 避免老状态脱裤子)
      update({ ...buildResetPatch(kind), ...buildItemPatch(kind, items[i].url) });
      // 重要: rAF 一帧不够 xyflow store 落盘 + 下游 useNodesData 重渲染, 需 setTimeout(80)
      await new Promise<void>((r) => setTimeout(() => r(), 80));

      // 2. 串行触发整条下游链 (任一失败则本轮终止 → 下一轮)
      let chainOk = true;
      for (const nid of order) {
        if (cancelRef.current) { chainOk = false; break; }
        const ok = await awaitNode(nid, cancelRef, runContext);
        if (!ok) { chainOk = false; break; }
      }
      if (chainOk && passiveOnly) {
        await new Promise<void>((r) => setTimeout(() => r(), 80));
      }

      // 3. 收集本轮终点产物 (取直接下游第一个的当前 data)
      let result: string | null = null;
      if (chainOk) {
        const cur = rf.getNode(directs[0]);
        result = extractFromNode(cur, kind);
      }
      collected.push(result);
      if (result) okCount++; else failCount++;
      update({ outputs: [...collected], progress: { done: i + 1, total: items.length, ok: okCount, fail: failCount } });

      // === v1.2.9.8: 本轮收尾——LoopNode 主动一次性写 OutputNode.direct*Urls (原地去重 merge)
      //   时机: awaitNode 同步返回后, FramePair / Image / Video 等本轮终态已落 store, 此刻写入零 race。
      // v1.2.9.9: 去除 outputNodeIds.size>0 预判 — 动态发现机制下, 本轮刚被 autoOutput 创建的 OutputNode 也能被写入
      // v1.2.9.13: 先 harvestFromExec 跨轮累积 ud, 再 writeFreshToOutputs 基于 accumulator 写入
      if (chainOk) {
        // 等一个微微的 setTimeout(30) 为了让可能的跨节点多 update batch (FramePair: 首帧后 success)
        // 以及 autoOutput 动态创建新 OutputNode 的 useEffect 都落 store
        await new Promise<void>((r) => setTimeout(() => r(), 30));
        harvestFromExec();
        writeFreshToOutputs();
        await new Promise<void>((r) => setTimeout(() => r(), 20));
      }
    }
    } finally {
    // === v1.2.9.0: 循环结束——清除所有下游 EXEC 节点的 __loopAccumulate 标记 ===
    //         OutputNode 恢复正常 collected 透传 (fresh + direct*Urls 累积都参与)
    rf.setNodes((prev) => prev.map((nd) => {
      if (!execSubIds.has(nd.id)) return nd; // v1.2.9.5: 不再包含 LoopNode 自身
      const od: any = nd.data || {};
      if (!od.__loopAccumulate) return nd;
      const next: any = { ...od };
      delete next.__loopAccumulate;
      return { ...nd, data: next };
    }));
    // === v1.2.9.13: 兜底写入 ===
    // 场景: RH/RH钱包节点在循环中被 __loopAccumulate 跳过 autoOutput, 直到清除标记后 autoOutput 才
        // 创建 OutputNode + upgrade pickKind='image', pickIndex=0。之前 writeFreshToOutputs 写不进去 (target 不存在)。
    // 修复: 清除标记后等 200ms 让 autoOutput useEffect 创建出 OutputNode, 再 harvest+write 基于
    //       跨轮 accumulator 写入 directImageUrls = 全集。OutputNode 侧 v1.2.9.10 hasAnyDirectAccumulated
    //       检测到 directImageUrls 非空 → 跳过 pickKind 切割 → 展示全集。
    await new Promise<void>((r) => setTimeout(() => r(), 200));
    harvestFromExec();
    writeFreshToOutputs();
    }

    // v1.2.9.3: 循环器自身是否输出最终聚合
    //   - 子图内有 OutputNode (累积已由下游 OutputNode 自接管展示) → 循环器不再聚合, 并清空运行时残留的 fresh 字段,
    //     避免「循环器直接接 OutputNode」时与下游 EXEC→OutputNode 累积链路展示重复 (用户体验奇怪: 2 份)
    //   - 子图内没有 OutputNode → 仍按原逻辑聚合输出 (保留循环器单独充当汇总展示的用法)
    // v1.2.9.9: finalOutputIds 重新 discover — 包括运行中被 autoOutput 动态创建的 OutputNode,
    //          避免「初始 0 → 走聚合 → 写 videoUrls → autoOutput 反手给 LoopNode 加 OutputNode」的 BUG。
    //          (v1.2.9.9 同时在 Canvas SKIP_TYPES 加 'loop' 作双保险)
    const finalOutputIds = discoverOutputNodeIds();
    const successOnly = collected.filter((x): x is string => !!x);
    const aggPatch: any = {};
    if (finalOutputIds.size > 0) {
      // 不再聚合 + 清空本轮注入残留, 让循环器自身端口对下游不产出素材
      if (kind === 'image') { aggPatch.imageUrl = ''; aggPatch.imageUrls = []; aggPatch.urls = []; }
      else if (kind === 'video') { aggPatch.videoUrl = ''; aggPatch.videoUrls = []; }
      else if (kind === 'audio') { aggPatch.audioUrl = ''; aggPatch.audioUrls = []; }
      else { aggPatch.text = ''; aggPatch.prompt = ''; aggPatch.outputText = ''; aggPatch.texts = []; aggPatch.textSegments = []; aggPatch.segments = []; }
    } else {
      if (kind === 'image') { aggPatch.imageUrls = successOnly; aggPatch.urls = successOnly; aggPatch.imageUrl = successOnly[0] || ''; }
      else if (kind === 'video') { aggPatch.videoUrl = successOnly[0] || ''; aggPatch.videoUrls = successOnly; }
      else if (kind === 'audio') { aggPatch.audioUrl = successOnly[0] || ''; aggPatch.audioUrls = successOnly; }
      else { aggPatch.text = successOnly.join('\n\n'); aggPatch.prompt = successOnly.join('\n\n'); aggPatch.outputText = successOnly.join('\n\n'); aggPatch.texts = successOnly; aggPatch.textSegments = successOnly; aggPatch.segments = successOnly; }
    }
    update({ status: cancelRef.current ? 'idle' : (failCount === items.length ? 'error' : 'success'), error: null, ...aggPatch });
  }, [id, items, kind, rf, update]);

  // ===== 并联执行 =====
  const runParallel = useCallback(async (runContext: RunContext | null): Promise<void> => {
    if (items.length === 0) { setError('上游没有可循环的素材'); return; }
    setError(null);
    cancelRef.current = false;
    update({ status: 'running', error: null, outputs: [], progress: { done: 0, total: items.length, ok: 0, fail: 0 } });

    const allNodes = rf.getNodes();
    const allEdges = rf.getEdges();
    const requestId = runContext?.requestId;
    if (!isLoopRunRequestId(requestId)) {
      throw new Error('并联循环缺少最终体检绑定的 Run requestId');
    }

    // v1.2.9.6: 同 runSerial —— 自动清理「循环器 → 输出素材」连线与孤儿 OutputNode
    const removeEdgeIds = new Set<string>();
    const orphanOutputIds = new Set<string>();
    for (const e of allEdges) {
      if (e.source !== id) continue;
      const t = allNodes.find((n) => n.id === e.target);
      if (t?.type !== 'output') continue;
      removeEdgeIds.add(e.id);
      const otherInbound = allEdges.some((x) => x.id !== e.id && x.target === e.target);
      if (!otherInbound) orphanOutputIds.add(e.target);
    }
    if (removeEdgeIds.size > 0) {
      rf.setEdges((eds) => eds.filter((x) => !removeEdgeIds.has(x.id)));
      if (orphanOutputIds.size > 0) {
        rf.setNodes((nds) => nds.filter((n) => !orphanOutputIds.has(n.id)));
      }
    }

    const directEdges = allEdges
      .filter((e) => e.source === id && !removeEdgeIds.has(e.id))
      .sort((left, right) => left.id.localeCompare(right.id) || left.target.localeCompare(right.target));
    const directs = directEdges.map((e) => e.target);
    if (directs.length === 0) { setError('请先把循环器输出端连到下游执行节点'); update({ status: 'error', error: '未连接下游' }); return; }

    const reachable = bfsForward(allEdges, directs);
    const subNodes = allNodes.filter((n) => reachable.has(n.id));
    const subEdges = allEdges.filter((e) => reachable.has(e.source) && reachable.has(e.target));
    const routePlanned = excludeRandomRouteBranchDescendants(subNodes, subEdges);
    const originalOrder = topologicalSort(routePlanned.nodes, routePlanned.edges, EXECUTABLE_NODE_TYPES);
    const passiveOnly = originalOrder.length === 0 && hasPassiveLoopNode(subNodes);
    if (originalOrder.length === 0 && !passiveOnly) { setError('下游链路上没有可执行节点'); update({ status: 'error', error: '无可执行节点' }); return; }

    // 子图边界 (用于克隆排版)
    const minY = Math.min(...subNodes.map((n) => n.position.y));
    const maxY = Math.max(...subNodes.map((n) => n.position.y + ((n as any).measured?.height || (n as any).height || 200)));
    const blockH = (maxY - minY) + 30;

    const cloneIdMaps: Array<Map<string, string>> = [];

    // v1.2.10.5: 预算克隆链期望矩形 —— 全部克隆节点 (i=1..N-1) 作为一组防重叠
    //   其中 existing 排除 subNodes 本身 (它们是克隆源, 克隆后会被覆盖在原位 + yOffset)
    const subNodeIds = new Set(subNodes.map((n) => n.id));
    const _desiredClones: PlacementRect[] = [];
    for (let i = 1; i < items.length; i++) {
      const yOffset = i * blockH;
      for (const n of subNodes) {
        const r = rectOf(n);
        _desiredClones.push({ x: r.x, y: r.y + yOffset, w: r.w, h: r.h });
      }
    }
    const _offClone = items.length > 1
      ? placeBatchNodes(_desiredClones, rf.getNodes(), {
          excludeIds: subNodeIds,
          source: `placement:loop-clone:${id}`,
        })
      : { dx: 0, dy: 0 };

    const cloneGraph = buildLoopParallelCloneGraph({
      loopId: id,
      requestId,
      sourceNodes: subNodes,
      sourceEdges: subEdges,
      entryEdge: directEdges[0],
      items,
      ...(mode === 'parallel-custom' ? { iterationInputs: customIterationInputs } : {}),
    });
    const sourceNodesById = new Map(subNodes.map((node) => [node.id, node]));
    const allNewNodes = cloneGraph.nodes.map((clone) => {
      const cloneData = (clone.data || {}) as Record<string, any>;
      const source = sourceNodesById.get(String(cloneData.__loopCloneSourceNodeId));
      const iteration = Math.max(1, Number(cloneData.__loopCloneIteration) || 1);
      return {
        ...clone,
        position: source
          ? {
              x: source.position.x + _offClone.dx,
              y: source.position.y + iteration * blockH + _offClone.dy,
            }
          : clone.position,
      } as Node;
    });
    const allNewEdges = cloneGraph.edges;

    // 为 i=1..N-1 建立与预检完全同源的 requestId 派生 ID 映射。
    for (let i = 1; i < items.length; i++) {
      const idMap = new Map<string, string>();
      subNodes.forEach((node, nodeIndex) => {
        idMap.set(node.id, loopParallelCloneNodeId(id, requestId, i, nodeIndex));
      });
      cloneIdMaps.push(idMap);
    }

    // 写入画布
    if (allNewNodes.length > 0) rf.addNodes(allNewNodes);
    if (allNewEdges.length > 0) rf.setEdges((eds) => [...eds, ...allNewEdges]);

    const originalEntryId = directs[0];
    const originalEntry = rf.getNode(originalEntryId);
    const originalCustomInput = (originalEntry?.data as any)?.__loopCustomInput ?? null;
    if (mode === 'parallel-custom') {
      const firstInput = customIterationInputs[0];
      if (!firstInput) throw new Error('并联循环（自定义）没有可执行的主循环素材');
      rf.setNodes((nodes) => nodes.map((node) => node.id === originalEntryId
        ? { ...node, data: { ...(node.data as any), __loopCustomInput: firstInput } }
        : node));
      update(buildCustomInputPatch(firstInput));
    } else {
      // 注入 items[0] 到自身 (原版下游链使用, i=0 链仍走 LoopNode 中转)
      update(buildItemPatch(kind, items[0].url));
    }
    await new Promise<void>((r) => setTimeout(() => r(), 120)); // 等克隆 + 数据落 store + xyflow useNodesData 重订阅

    // 计算每条链的拓扑顺序
    const chainOrders: string[][] = [originalOrder];
    for (const idMap of cloneIdMaps) {
      chainOrders.push(originalOrder.map((nid) => idMap.get(nid) || nid));
    }

    // 每条链内部串行 + 多链并发
    const collected: Array<string | null> = new Array(items.length).fill(null);
    let okCount = 0; let failCount = 0;
    const updateProgress = () => update({ progress: { done: okCount + failCount, total: items.length, ok: okCount, fail: failCount }, outputs: [...collected] });

    const runChain = async (chainIdx: number): Promise<void> => {
      const chain = chainOrders[chainIdx];
      let chainOk = true;
      for (const nid of chain) {
        if (cancelRef.current) { chainOk = false; break; }
        const ok = await awaitOnly(nid, cancelRef, runContext);
        if (!ok) { chainOk = false; break; }
      }
      if (chainOk && passiveOnly) {
        await new Promise<void>((r) => setTimeout(() => r(), 80));
      }
      // 收集
      let result: string | null = null;
      if (chainOk) {
        const targetEntry = chainIdx === 0 ? directs[0] : (cloneIdMaps[chainIdx - 1].get(directs[0]) || directs[0]);
        const cur = rf.getNode(targetEntry);
        result = extractFromNode(cur, kind);
      }
      collected[chainIdx] = result;
      if (result) okCount++; else failCount++;
      updateProgress();
    };

    try {
      await Promise.all(chainOrders.map((_, i) => runChain(i)));
    } finally {
      if (mode === 'parallel-custom') {
        rf.setNodes((nodes) => nodes.map((node) => node.id === originalEntryId
          ? { ...node, data: { ...(node.data as any), __loopCustomInput: originalCustomInput } }
          : node));
      }
    }

    // v1.2.9.3: 同 runSerial 的逻辑——子图内有 OutputNode 时循环器不再输出聚合 (避免与下游累积展示重复)
    const successOnly = collected.filter((x): x is string => !!x);
    const aggPatch: any = mode === 'parallel-custom' ? buildCustomInputPatch(EMPTY_CUSTOM_INPUT) : {};
    const parallelHasOutput = subNodes.some((n) => n.type === 'output');
    if (parallelHasOutput) {
      if (kind === 'image') { aggPatch.imageUrl = ''; aggPatch.imageUrls = []; aggPatch.urls = []; }
      else if (kind === 'video') { aggPatch.videoUrl = ''; aggPatch.videoUrls = []; }
      else if (kind === 'audio') { aggPatch.audioUrl = ''; aggPatch.audioUrls = []; }
      else { aggPatch.text = ''; aggPatch.prompt = ''; aggPatch.outputText = ''; aggPatch.texts = []; aggPatch.textSegments = []; aggPatch.segments = []; }
    } else {
      if (kind === 'image') { aggPatch.imageUrls = successOnly; aggPatch.urls = successOnly; aggPatch.imageUrl = successOnly[0] || ''; }
      else if (kind === 'video') { aggPatch.videoUrl = successOnly[0] || ''; aggPatch.videoUrls = successOnly; }
      else if (kind === 'audio') { aggPatch.audioUrl = successOnly[0] || ''; aggPatch.audioUrls = successOnly; }
      else { aggPatch.text = successOnly.join('\n\n'); aggPatch.prompt = successOnly.join('\n\n'); aggPatch.outputText = successOnly.join('\n\n'); aggPatch.texts = successOnly; aggPatch.textSegments = successOnly; aggPatch.segments = successOnly; }
    }
    update({ status: cancelRef.current ? 'idle' : (failCount === items.length ? 'error' : 'success'), error: null, ...aggPatch });
  }, [id, items, kind, rf, update, mode, customIterationInputs]);

  const handleRun = useCallback(async (runContext: RunContext | null) => {
    try {
      if (mode === 'parallel' || mode === 'parallel-custom') await runParallel(runContext);
      else await runSerial(runContext);
    } catch (e: any) {
      const msg = e?.message || '循环执行失败';
      setError(msg);
      update({
        ...(mode === 'parallel-custom' ? buildCustomInputPatch(EMPTY_CUSTOM_INPUT) : {}),
        status: 'error',
        error: msg,
      });
    }
  }, [mode, runSerial, runParallel, update]);

  const handleStop = () => {
    cancelRef.current = true;
    update({ status: 'idle' });
    useRunBusStore.getState().cancelAll();
  };

  // 接入运行总线 (供批量运行 ▶ 调起本节点)
  useRunTrigger(id, async (reporter) => {
    if (status === 'running') return;
    await handleRun(reporter.runContext);
  }, 'loop', { lifecycleAware: true });

  // ===== 双主题 token =====
  // 重要: 必须固定 width 不能只设 minWidth, 否则子元素的预览图 / 视频会把节点擑到反近十倍宽
  const containerStyle: React.CSSProperties = isPixel
    ? { background: 'var(--px-surface)', border: '2px solid var(--px-ink)', borderRadius: 8, boxShadow: p.selected ? '5px 5px 0 var(--px-ink)' : '3px 3px 0 var(--px-ink)', width: 300 }
    : isDark
      ? { background: 'rgba(20,20,22,0.92)', border: `2px solid ${p.selected ? COLOR : 'rgba(255,255,255,0.15)'}`, borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)', width: 300 }
      : { background: 'rgba(255,255,255,0.95)', border: `2px solid ${p.selected ? COLOR : 'rgba(0,0,0,0.12)'}`, borderRadius: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', backdropFilter: 'blur(8px)', width: 300 };

  // 像素风 headerBg 改为 surface 白底 (与 FramePair/Upload/Pick 一致), 仅图标色块用 peach
  const headerBg = isPixel ? 'var(--px-surface)' : isDark ? 'rgba(167,139,250,0.16)' : 'rgba(167,139,250,0.12)';
  const headerColor = isPixel ? 'var(--px-ink)' : isDark ? '#ddd6fe' : '#6d28d9';
  const labelColor = isPixel ? 'var(--px-ink)' : isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.75)';
  const subLabel = isPixel ? 'rgba(0,0,0,0.55)' : isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';

  const handleColor = kind === 'image' ? PORT_COLOR.image : kind === 'video' ? PORT_COLOR.video : kind === 'audio' ? PORT_COLOR.audio : PORT_COLOR.text;

  // ===== 按钮样式 (科技风 / 像素风) =====
  const segBtn = (active: boolean): React.CSSProperties => isPixel
    ? { padding: '4px 10px', fontSize: 11, fontWeight: 700, border: '2px solid var(--px-ink)', background: active ? 'var(--px-mint)' : 'var(--px-surface)', color: 'var(--px-ink)', cursor: 'pointer', boxShadow: active ? 'inset 2px 2px 0 rgba(0,0,0,0.15)' : '2px 2px 0 var(--px-ink)' }
    : { padding: '4px 10px', fontSize: 11, fontWeight: 600, borderRadius: 6, border: 'none', background: active ? COLOR : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'), color: active ? '#1a1a2e' : (isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.7)'), cursor: 'pointer' };

  const primaryBtn: React.CSSProperties = isPixel
    ? { padding: '6px 14px', fontSize: 12, fontWeight: 700, border: '2px solid var(--px-ink)', background: 'var(--px-mint)', color: 'var(--px-ink)', cursor: 'pointer', boxShadow: '2px 2px 0 var(--px-ink)', display: 'inline-flex', alignItems: 'center', gap: 6 }
    : { padding: '6px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6, border: 'none', background: COLOR, color: '#1a1a2e', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 };

  const stopBtn: React.CSSProperties = { ...primaryBtn, background: isPixel ? 'var(--px-peach)' : '#ef4444', color: isPixel ? 'var(--px-ink)' : '#fff' };

  return (
    <div className="relative" style={containerStyle}>
      {/* target handle (左) */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: mode === 'parallel-custom' ? COLOR : handleColor, width: 12, height: 12, top: '50%', left: -6, transform: 'translateY(-50%)', border: 'none', zIndex: 12 }}
        title={mode === 'parallel-custom' ? '接入上游文本 / 图像 / 视频 / 音频' : `接入上游 ${KIND_LABEL[kind]}`}
      />
      {/* source handle (右) */}
      <Handle
        type="source"
        position={Position.Right}
        style={{ background: handleColor, width: 12, height: 12, top: '50%', right: -6, transform: 'translateY(-50%)', border: 'none', zIndex: 12 }}
        title={`输出 ${KIND_LABEL[kind]} (循环驱动下游)`}
      />

      {/* 头部 (像素风: 白底 surface + peach 图标色块, 与 FramePair / Upload 等其他工具节点一致) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: headerBg, borderBottom: isPixel ? '2px solid var(--px-ink)' : `1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`, borderRadius: isPixel ? '6px 6px 0 0' : '10px 10px 0 0' }}>
        <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', background: isPixel ? 'var(--px-peach, #FFCBA4)' : (isDark ? 'rgba(167,139,250,0.18)' : 'rgba(167,139,250,0.18)'), border: isPixel ? '2px solid var(--px-ink)' : 'none', borderRadius: isPixel ? 0 : 6, flexShrink: 0 }}>
          <Repeat size={13} color={isPixel ? 'var(--px-ink)' : headerColor} />
        </div>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 700, color: headerColor }}>循环器</div>
        <span style={{ fontSize: 10, color: subLabel }}>{items.length} 项 · {KIND_LABEL[kind]}</span>
      </div>

      {/* body */}
      <div className="nodrag" style={{ padding: 10 }} onMouseDown={(e) => e.stopPropagation()} onWheelCapture={(e) => e.stopPropagation()}>
        {/* 模式切换 */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            style={segBtn(mode === 'serial')}
            onClick={() => update({ mode: 'serial' })}
            disabled={status === 'running'}
            title="串联：第 i 个素材跑完整条下游链 → 下一个"
          >
            <GitBranch size={11} style={{ marginRight: 4, verticalAlign: -2 }} />串联循环
          </button>
          <button
            type="button"
            style={segBtn(mode === 'parallel')}
            onClick={() => update({ mode: 'parallel' })}
            disabled={status === 'running'}
            title="并联：克隆 N 份下游子图 → 同时跑"
          >
            <Layers size={11} style={{ marginRight: 4, verticalAlign: -2 }} />并联循环
          </button>
          <button
            type="button"
            style={segBtn(mode === 'parallel-custom')}
            onClick={() => update({ mode: 'parallel-custom' })}
            disabled={status === 'running'}
            title="并联自定义：每种素材分别选择按顺序取一个，或固定复用同一个"
          >
            <Layers size={11} style={{ marginRight: 4, verticalAlign: -2 }} />并联循环（自定义）
          </button>
        </div>

        {/* 类型选择 */}
        <div style={{ marginBottom: 4, fontSize: 10, color: subLabel }}>
          {mode === 'parallel-custom' ? '主循环素材（决定生成次数）' : '循环素材类型'}
        </div>
        <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
          {(['text', 'image', 'video', 'audio'] as MaterialKind[]).map((k) => (
            <button
              key={k}
              type="button"
              style={segBtn(kind === k)}
              onClick={() => update({ kind: k })}
              disabled={status === 'running'}
              title={`处理 ${KIND_LABEL[k]} 素材`}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>

        {mode === 'parallel-custom' && (
          <div style={{ marginBottom: 10, padding: 8, borderRadius: 6, border: isPixel ? '2px solid var(--px-ink)' : `1px solid ${isDark ? 'rgba(167,139,250,.28)' : 'rgba(109,40,217,.2)'}`, background: isDark ? 'rgba(167,139,250,.08)' : 'rgba(109,40,217,.05)' }}>
            <div style={{ fontSize: 10, lineHeight: 1.45, color: labelColor, marginBottom: 7 }}>
              把需要配对的文本、图片、视频或音频都连接到本循环器。每条并发链只读取本轮选中的单个素材，不会再读取整组提示词。
            </div>
            {(['text', 'image', 'video', 'audio'] as MaterialKind[]).map((materialKind) => {
              const pool = materialKind === 'text' ? upstream.texts
                : materialKind === 'image' ? upstream.images
                  : materialKind === 'video' ? upstream.videos
                    : upstream.audios;
              const strategy = customConfig.strategies[materialKind];
              return (
                <div key={materialKind} style={{ display: 'grid', gridTemplateColumns: '56px minmax(0, 1fr)', gap: 6, alignItems: 'center', marginTop: 5 }}>
                  <span style={{ fontSize: 10, color: materialKind === kind ? headerColor : subLabel, fontWeight: materialKind === kind ? 700 : 500 }}>
                    {KIND_LABEL[materialKind]} {pool.length}
                  </span>
                  <div style={{ display: 'flex', gap: 5, minWidth: 0 }}>
                    <select
                      value={strategy}
                      onChange={(event) => update({
                        parallelCustomStrategies: {
                          ...customConfig.strategies,
                          [materialKind]: event.target.value === 'fixed' ? 'fixed' : 'sequence',
                        },
                      })}
                      disabled={status === 'running' || pool.length === 0}
                      style={{ minWidth: 0, flex: 1, padding: '4px 5px', borderRadius: 4, border: isPixel ? '1px solid var(--px-ink)' : `1px solid ${isDark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.14)'}`, background: isDark ? '#18181b' : '#fff', color: labelColor, fontSize: 10 }}
                    >
                      <option value="sequence">按顺序·每个用一次</option>
                      <option value="fixed">固定·全部用同一个</option>
                    </select>
                    {strategy === 'fixed' && pool.length > 1 && (
                      <select
                        value={Math.min(customConfig.fixedIndexes[materialKind], pool.length - 1)}
                        onChange={(event) => update({
                          parallelCustomFixedIndexes: {
                            ...customConfig.fixedIndexes,
                            [materialKind]: Math.max(0, Number(event.target.value) || 0),
                          },
                        })}
                        disabled={status === 'running'}
                        title={`选择所有任务共同使用的${KIND_LABEL[materialKind]}`}
                        style={{ width: 78, padding: '4px 5px', borderRadius: 4, border: isPixel ? '1px solid var(--px-ink)' : `1px solid ${isDark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.14)'}`, background: isDark ? '#18181b' : '#fff', color: labelColor, fontSize: 10 }}
                      >
                        {pool.map((material, index) => (
                          <option key={material.id} value={index}>第 {index + 1} 个</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              );
            })}
            <div style={{ marginTop: 7, fontSize: 9, lineHeight: 1.4, color: subLabel }}>
              “按顺序”在素材不足时留空，不会从头循环；“固定”默认复用第 1 个，也可以指定其他素材。
            </div>
          </div>
        )}

        {/* 上游素材池预览 */}
        <div style={{ marginBottom: 8, fontSize: 10, color: subLabel }}>上游素材 ({items.length})</div>
        {/* minmax(0, 1fr) 是关键: 不加 子项的 aspect-ratio + img/video 会把列宽反向擑大 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 4, marginBottom: 10, minHeight: 0, width: '100%' }}>
          {items.length === 0 && (
            <div style={{ gridColumn: '1 / 4', padding: '12px 8px', textAlign: 'center', fontSize: 11, color: subLabel, border: isPixel ? '2px dashed var(--px-ink)' : `1px dashed ${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}`, borderRadius: 4 }}>
              请连接上游 N 个 {KIND_LABEL[kind]} 节点
            </div>
          )}
          {items.slice(0, 9).map((m, i) => (
            <div key={i} style={{ aspectRatio: '1 / 1', borderRadius: 4, overflow: 'hidden', background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)', border: isPixel ? '1px solid var(--px-ink)' : 'none', minWidth: 0 }}>
              {kind === 'image' ? (
                <SmartImage src={m.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} thumbSize={180} />
              ) : kind === 'video' ? (
                <LoopingVideo src={m.url} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} muted />
              ) : kind === 'audio' ? (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, color: labelColor }}>♪ {(m.url.split('/').pop() || '').slice(0, 10)}</div>
              ) : (
                <div style={{ padding: 4, fontSize: 9, lineHeight: 1.2, color: labelColor, height: '100%', overflow: 'hidden', wordBreak: 'break-all' }}>{(m.url || '').slice(0, 40)}</div>
              )}
            </div>
          ))}
          {items.length > 9 && <div style={{ gridColumn: '1 / 4', fontSize: 10, color: subLabel, textAlign: 'right' }}>...等 {items.length} 项</div>}
        </div>

        {/* 进度条 */}
        {(status === 'running' || progress.total > 0) && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: subLabel, marginBottom: 3 }}>
              进度 {progress.done}/{progress.total} · 成功 {progress.ok} · 失败 {progress.fail}
            </div>
            <div style={{ height: 4, background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`, height: '100%', background: COLOR, transition: 'width .2s' }} />
            </div>
          </div>
        )}

        {/* 错误条 */}
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderRadius: 4, background: isDark ? 'rgba(239,68,68,0.18)' : 'rgba(239,68,68,0.1)', color: '#fca5a5', fontSize: 11, marginBottom: 8 }}>
            <AlertCircle size={11} />
            <span style={{ flex: 1 }}>{error}</span>
          </div>
        )}

        {/* 主按钮 */}
        <div style={{ display: 'flex', gap: 6 }}>
          {status === 'running' ? (
            <button type="button" style={stopBtn} onClick={handleStop}>
              <Square size={11} /> 取消
            </button>
          ) : (
            <button type="button" style={primaryBtn} onClick={() => requestCanvasNodeRun(id)} disabled={items.length === 0}>
              <Play size={11} />
              {mode === 'serial' ? '串联运行' : mode === 'parallel-custom' ? '自定义并联运行' : '并联运行'}
            </button>
          )}
          <div style={{ flex: 1 }} />
          {outputs.length > 0 && (
            <span style={{ fontSize: 10, color: subLabel, alignSelf: 'center' }}>已采集 {outputs.filter((x) => x).length}/{outputs.length}</span>
          )}
        </div>
      </div>
    </div>
  );
};

export default memo(LoopNode);
