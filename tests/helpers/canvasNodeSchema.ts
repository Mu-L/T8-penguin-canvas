import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

interface CanvasNodeSchemaEntry {
  type: string;
  label: string;
  category: string;
  description: string;
  icon: string;
  ports: {
    inputs: string[];
    outputs: string[];
  };
  executable: boolean;
}

interface CanvasNodeSchemaManifest {
  schema: string;
  version: number;
  types: CanvasNodeSchemaEntry[];
}

const manifest = JSON.parse(
  readFileSync(new URL('../../backend/src/shared/canvasNodeSchema.json', import.meta.url), 'utf8'),
) as CanvasNodeSchemaManifest;

assert.equal(manifest.schema, 't8-canvas-node-schema-v1');
assert.equal(manifest.version, 1);
assert.ok(Array.isArray(manifest.types));

export function assertProductionNodeSchema(
  type: string,
  expected: {
    label: string;
    category: string;
    inputs: string[];
    outputs: string[];
    executable: boolean;
    icon?: string;
    description?: string | RegExp;
  },
) {
  const matches = manifest.types.filter((entry) => entry.type === type);
  assert.equal(matches.length, 1, `${type} must appear exactly once in the production canvas schema`);
  const entry = matches[0];
  assert.equal(entry.type, type);
  assert.equal(entry.label, expected.label);
  assert.equal(entry.category, expected.category);
  assert.deepEqual(entry.ports.inputs, expected.inputs);
  assert.deepEqual(entry.ports.outputs, expected.outputs);
  assert.equal(entry.executable, expected.executable);
  if (expected.icon !== undefined) assert.equal(entry.icon, expected.icon);
  if (typeof expected.description === 'string') assert.equal(entry.description, expected.description);
  if (expected.description instanceof RegExp) assert.match(entry.description, expected.description);
  return entry;
}
