import type { Node, Edge } from '@xyflow/react';

/**
 * 在仅包含 executableTypes 的节点子图上做 Kahn 拓扑排序。
 * 仅保留两端都是可执行节点的边作为依赖关系。
 * 若存在环或孤岛,环节点会按照原始顺序追加到末尾(尽力而为)。
 */
export function topologicalSort(
  nodes: Node[],
  edges: Edge[],
  executableTypes: ReadonlySet<string>
): string[] {
  const exeNodes = nodes.filter((n) => n.type && executableTypes.has(n.type));
  const exeIds = new Set(exeNodes.map((n) => n.id));

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  exeIds.forEach((id) => {
    inDegree.set(id, 0);
    adj.set(id, []);
  });

  for (const e of edges) {
    if (exeIds.has(e.source) && exeIds.has(e.target) && e.source !== e.target) {
      adj.get(e.source)!.push(e.target);
      inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
    }
  }

  // 用原始顺序作为入队 tie-breaker,保证视觉上稳定
  const queue: string[] = [];
  for (const n of exeNodes) {
    if ((inDegree.get(n.id) || 0) === 0) queue.push(n.id);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const next of adj.get(id) || []) {
      const d = (inDegree.get(next) || 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (result.length < exeIds.size) {
    // 环或异常,把剩下未排序的按原始顺序补上
    const got = new Set(result);
    for (const n of exeNodes) {
      if (!got.has(n.id)) result.push(n.id);
    }
  }

  return result;
}

/**
 * 与 topologicalSort 使用同一套依赖规则，但返回可并发执行的层。
 * 同一层内节点之间没有可执行依赖；下一层必须等待上一层完成。
 * 遇到环时剩余节点按原始顺序单节点串行兜底，避免错误并发。
 */
export function topologicalLayers(
  nodes: Node[],
  edges: Edge[],
  executableTypes: ReadonlySet<string>
): string[][] {
  const exeNodes = nodes.filter((n) => n.type && executableTypes.has(n.type));
  const exeIds = new Set(exeNodes.map((n) => n.id));

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  exeIds.forEach((id) => {
    inDegree.set(id, 0);
    adj.set(id, []);
  });

  for (const e of edges) {
    if (exeIds.has(e.source) && exeIds.has(e.target) && e.source !== e.target) {
      adj.get(e.source)!.push(e.target);
      inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
    }
  }

  let queue: string[] = [];
  for (const n of exeNodes) {
    if ((inDegree.get(n.id) || 0) === 0) queue.push(n.id);
  }

  const layers: string[][] = [];
  const got = new Set<string>();
  while (queue.length > 0) {
    const layer = queue;
    queue = [];
    layers.push(layer);
    for (const id of layer) {
      got.add(id);
      for (const next of adj.get(id) || []) {
        const d = (inDegree.get(next) || 0) - 1;
        inDegree.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
  }

  if (got.size < exeIds.size) {
    for (const n of exeNodes) {
      if (!got.has(n.id)) layers.push([n.id]);
    }
  }

  return layers;
}
