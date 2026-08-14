import { useCallback, useRef, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';

/**
 * 画布撤销/重做历史栈
 * - 不直接接管 nodes/edges 的 useState,而是提供 capture / undo / redo 接口
 * - 由 Canvas.tsx 在合适时机调用 capture(防抖、拖拽结束等)
 * - 容量上限 50 步,超出后丢弃最旧
 */

export interface CanvasSnapshot {
  nodes: Node[];
  edges: Edge[];
}

export interface CanvasHistoryState {
  past: CanvasSnapshot[];
  present: CanvasSnapshot | null;
  future: CanvasSnapshot[];
}
export interface CanvasHistoryResetOptions {
  deferClone?: boolean;
}


export const CANVAS_HISTORY_LIMIT = 50;

export function sanitizeCanvasHistorySnapshot(snapshot: CanvasSnapshot): CanvasSnapshot {
  const transientIds = new Set(snapshot.nodes
    .filter((node) => Boolean((node.data as Record<string, unknown> | undefined)?.__subflowRuntime))
    .map((node) => node.id));
  return {
    nodes: snapshot.nodes.filter((node) => !transientIds.has(node.id)),
    edges: snapshot.edges.filter((edge) => !transientIds.has(edge.source)
      && !transientIds.has(edge.target)
      && !(edge.data as Record<string, unknown> | undefined)?.__subflowRuntime),
  };
}

function clone(s: CanvasSnapshot): CanvasSnapshot {
  // structuredClone 可用于复杂对象(包含 data 的任意结构)
  if (typeof structuredClone === 'function') {
    return structuredClone(s);
  }
  return JSON.parse(JSON.stringify(s));
}

function comparableSnapshot(snapshot: CanvasSnapshot): CanvasSnapshot {
  return {
    nodes: snapshot.nodes.map(({ selected: _selected, dragging: _dragging, measured: _measured, ...node }) => node),
    edges: snapshot.edges.map(({ selected: _selected, ...edge }) => edge),
  };
}

function equal(a: CanvasSnapshot | null, b: CanvasSnapshot | null) {
  if (!a || !b) return false;
  return JSON.stringify(comparableSnapshot(a)) === JSON.stringify(comparableSnapshot(b));
}

function historyLimit(limit: number) {
  return Math.max(1, Math.trunc(Number(limit) || CANVAS_HISTORY_LIMIT));
}

export function createCanvasHistoryState(
  initial?: CanvasSnapshot,
  options: CanvasHistoryResetOptions = {},
): CanvasHistoryState {
  const sanitized = initial ? sanitizeCanvasHistorySnapshot(initial) : null;
  return {
    past: [],
    present: sanitized ? (options.deferClone ? sanitized : clone(sanitized)) : null,
    future: [],
  };
}

export function captureCanvasHistoryState(
  state: CanvasHistoryState,
  snapshot: CanvasSnapshot,
  limit = CANVAS_HISTORY_LIMIT,
): CanvasHistoryState {
  const next = clone(sanitizeCanvasHistorySnapshot(snapshot));
  if (equal(state.present, next)) {
    // 瞬态选择/测量变化不产生历史，但保留最新 UI 状态作为下一次业务编辑的基线。
    return { ...state, present: next };
  }
  const past = state.present
    ? [...state.past, clone(state.present)].slice(-historyLimit(limit))
    : state.past;
  return { past, present: next, future: [] };
}

export function captureCanvasHistoryTransition(
  state: CanvasHistoryState,
  current: CanvasSnapshot,
  next: CanvasSnapshot,
  limit = CANVAS_HISTORY_LIMIT,
): CanvasHistoryState {
  const withCurrent = captureCanvasHistoryState(state, current, limit);
  return captureCanvasHistoryState(withCurrent, next, limit);
}

export function undoCanvasHistoryState(
  state: CanvasHistoryState,
  limit = CANVAS_HISTORY_LIMIT,
): CanvasHistoryState {
  if (!state.present || state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  return {
    past: state.past.slice(0, -1),
    present: clone(previous),
    future: [...state.future, clone(state.present)].slice(-historyLimit(limit)),
  };
}

export function redoCanvasHistoryState(
  state: CanvasHistoryState,
  limit = CANVAS_HISTORY_LIMIT,
): CanvasHistoryState {
  if (!state.present || state.future.length === 0) return state;
  const next = state.future[state.future.length - 1];
  return {
    past: [...state.past, clone(state.present)].slice(-historyLimit(limit)),
    present: clone(next),
    future: state.future.slice(0, -1),
  };
}

export function useCanvasHistory(
  applySnapshot: (snap: CanvasSnapshot) => void
) {
  const historyRef = useRef<CanvasHistoryState>(createCanvasHistoryState());
  // 是否正在执行 undo/redo,防止 capture 二次入栈
  const restoringRef = useRef(false);
  const [, setVersion] = useState(0);

  const reset = useCallback((init?: CanvasSnapshot, options?: CanvasHistoryResetOptions) => {
    historyRef.current = createCanvasHistoryState(init, options);
    setVersion((v) => v + 1);
  }, []);

  /**
   * 主动捕获一帧历史。
   * 内部会与 lastRef 比对,变化才入栈;一次 capture 同时会清空 future 栈。
   */
  const capture = useCallback((snap: CanvasSnapshot) => {
    if (restoringRef.current) return;
    const current = historyRef.current;
    const next = captureCanvasHistoryState(current, snap);
    historyRef.current = next;
    if (next.past !== current.past || next.future !== current.future) setVersion((v) => v + 1);
  }, []);

  const captureTransition = useCallback((currentSnapshot: CanvasSnapshot, nextSnapshot: CanvasSnapshot) => {
    if (restoringRef.current) return;
    const current = historyRef.current;
    const next = captureCanvasHistoryTransition(current, currentSnapshot, nextSnapshot);
    historyRef.current = next;
    if (next !== current) setVersion((v) => v + 1);
  }, []);

  const undo = useCallback(() => {
    const current = historyRef.current;
    const next = undoCanvasHistoryState(current);
    if (next === current || !next.present) return;
    historyRef.current = next;
    restoringRef.current = true;
    try {
      applySnapshot(clone(next.present));
    } finally {
      // 等下一帧再放开,避免因 setNodes 同步触发的 capture
      requestAnimationFrame(() => {
        restoringRef.current = false;
      });
    }
    setVersion((v) => v + 1);
  }, [applySnapshot]);

  const redo = useCallback(() => {
    const current = historyRef.current;
    const next = redoCanvasHistoryState(current);
    if (next === current || !next.present) return;
    historyRef.current = next;
    restoringRef.current = true;
    try {
      applySnapshot(clone(next.present));
    } finally {
      requestAnimationFrame(() => {
        restoringRef.current = false;
      });
    }
    setVersion((v) => v + 1);
  }, [applySnapshot]);

  return {
    capture,
    captureTransition,
    undo,
    redo,
    reset,
    canUndo: historyRef.current.past.length > 0,
    canRedo: historyRef.current.future.length > 0,
  };
}
