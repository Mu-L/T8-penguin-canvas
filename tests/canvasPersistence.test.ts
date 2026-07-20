import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('canvas route uses resilient JSON persistence for crash recovery', () => {
  const source = readFileSync(new URL('../backend/src/routes/canvas.js', import.meta.url), 'utf8');

  assert.match(source, /function readJsonFile/);
  assert.match(source, /replace\(\s*\/\^\\uFEFF\//);
  assert.match(source, /replace\(\s*\/\\0\/g/);
  assert.match(source, /function recoverCanvasListFromFiles/);
  assert.match(source, /return recoverCanvasListFromFiles\(\)/);
  assert.match(source, /atomicWriteJson\(config\.CANVAS_FILE,\s*list\)/);
  assert.match(source, /atomicWriteJson\(getCanvasFile\(canvasId\),\s*document\)/);
  assert.match(source, /atomicWriteJson\(file,\s*(?:document|result\.document)\)/);
  assert.match(source, /const data = readJsonFile\(file\)/);
});
