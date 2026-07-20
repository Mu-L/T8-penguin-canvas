import schemaManifest from '../../backend/src/shared/canvasNodeSchema.json' with { type: 'json' };

// Keep every execution planner on the same capability list. Production types
// are versioned in the shared schema; DEV-only makers are intentionally absent.
export const EXECUTABLE_NODE_TYPES: ReadonlySet<string> = new Set(
  schemaManifest.types.filter((item) => item.executable).map((item) => item.type),
);
