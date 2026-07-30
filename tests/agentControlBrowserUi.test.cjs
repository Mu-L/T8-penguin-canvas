'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('visible browser handoff highlights only an existing node in the bound active canvas', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'components', 'Canvas.tsx'), 'utf8');

  assert.match(source, /params\.get\('zcanvasHandoff'\)/);
  assert.match(source, /action !== 'highlight'/);
  assert.match(source, /canvasId !== activeId/);
  assert.match(source, /nodesRef\.current\.find\(\(node\) => node\.id === nodeId\)/);
  assert.match(source, /selected: node\.id === nodeId/);
  assert.match(source, /pulseNearestNode\(nodeId\)/);
  assert.match(source, /window\.history\.replaceState/);
});

test('browser route and CLI preserve explicit local-only handoff authority', () => {
  const route = fs.readFileSync(path.join(root, 'backend', 'src', 'routes', 'agentControl.js'), 'utf8');
  const cli = fs.readFileSync(path.join(root, 'tools', 'zcanvas-cli', 'src', 'cli.cjs'), 'utf8');
  const reference = fs.readFileSync(
    path.join(root, '.agents', 'skills', 'zhenzhen-canvas', 'references', 'browser-control.md'),
    'utf8',
  );

  assert.match(route, /\.\.\.\(req\.body \|\| \{\}\)/);
  assert.match(route, /userInitiated: req\.body\?\.userInitiated === true/);
  assert.match(cli, /userInitiated: action !== 'status'/);
  assert.match(cli, /allowedOrigins 唯一列出的当前画布 origin/);
  assert.match(reference, /exactly one allowed local Canvas origin/i);
  assert.match(reference, /must not carry a target URL, cookies, profile, headers, or storage state/i);
});
