import type { SubflowDefinition } from './subflows';

export const SUBFLOW_DRAFT_HISTORY_LIMIT = 50;

export interface SubflowDraftHistoryState {
  draft: SubflowDefinition;
  undoStack: SubflowDefinition[];
  redoStack: SubflowDefinition[];
}

function cloneDefinition(definition: SubflowDefinition): SubflowDefinition {
  if (typeof structuredClone === 'function') return structuredClone(definition);
  return JSON.parse(JSON.stringify(definition)) as SubflowDefinition;
}

function persistentDefinition(definition: SubflowDefinition): SubflowDefinition {
  const snapshot = cloneDefinition(definition);
  snapshot.nodes = snapshot.nodes.map(({ selected: _selected, ...node }) => node);
  snapshot.edges = snapshot.edges.map(({ selected: _selected, ...edge }) => edge);
  return snapshot;
}

function sameDefinition(left: SubflowDefinition, right: SubflowDefinition): boolean {
  return JSON.stringify(persistentDefinition(left)) === JSON.stringify(persistentDefinition(right));
}

export function createSubflowDraftHistory(draft: SubflowDefinition): SubflowDraftHistoryState {
  return { draft: cloneDefinition(draft), undoStack: [], redoStack: [] };
}

export function commitSubflowDraftHistory(
  state: SubflowDraftHistoryState,
  nextDraft: SubflowDefinition,
  limit = SUBFLOW_DRAFT_HISTORY_LIMIT,
): SubflowDraftHistoryState {
  const next = cloneDefinition(nextDraft);
  if (sameDefinition(state.draft, next)) return { ...state, draft: next };
  const undoStack = [...state.undoStack, persistentDefinition(state.draft)];
  return {
    draft: next,
    undoStack: undoStack.slice(-Math.max(1, limit)),
    redoStack: [],
  };
}

export function undoSubflowDraftHistory(
  state: SubflowDraftHistoryState,
  limit = SUBFLOW_DRAFT_HISTORY_LIMIT,
): SubflowDraftHistoryState {
  if (!state.undoStack.length) return state;
  const previous = state.undoStack[state.undoStack.length - 1];
  return {
    draft: cloneDefinition(previous),
    undoStack: state.undoStack.slice(0, -1),
    redoStack: [...state.redoStack, persistentDefinition(state.draft)].slice(-Math.max(1, limit)),
  };
}

export function redoSubflowDraftHistory(
  state: SubflowDraftHistoryState,
  limit = SUBFLOW_DRAFT_HISTORY_LIMIT,
): SubflowDraftHistoryState {
  if (!state.redoStack.length) return state;
  const next = state.redoStack[state.redoStack.length - 1];
  return {
    draft: cloneDefinition(next),
    undoStack: [...state.undoStack, persistentDefinition(state.draft)].slice(-Math.max(1, limit)),
    redoStack: state.redoStack.slice(0, -1),
  };
}
