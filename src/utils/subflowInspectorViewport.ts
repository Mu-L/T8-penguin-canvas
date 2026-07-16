export interface SubflowInspectorViewportKeyOptions {
  rootInstanceNodeId: string;
  pathNodeIds: string[];
  projectId?: string;
  definitionId: string;
  definitionVersion: number;
  editing?: boolean;
}

export function buildSubflowInspectorViewportKey(options: SubflowInspectorViewportKeyOptions): string {
  return JSON.stringify([
    String(options.rootInstanceNodeId || ''),
    options.pathNodeIds.map((nodeId) => String(nodeId)),
    String(options.projectId || 'local'),
    String(options.definitionId || ''),
    Math.max(0, Math.trunc(Number(options.definitionVersion) || 0)),
    options.editing ? 'edit' : 'read',
  ]);
}
