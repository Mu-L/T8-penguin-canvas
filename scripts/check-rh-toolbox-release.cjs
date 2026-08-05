#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { syncRhToolboxManifest } = require('./sync-rh-toolbox-manifest.cjs');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'src', 'data', 'rhToolboxManifest.ts');
const REQUIRED_TOOL_IDS = [
  'image-cutout-v1',
  'image-upscale-4k',
  'tuantiquv10',
  'bernini1',
  'berninituxiangbianji',
  'bernini2',
  'translate-cutout-v1',
  'video-removebg-v1',
  'video-nividia-upscale',
  'video-flashvsr',
];
const REQUIRED_CATEGORY_IDS = [
  'custom-rh-tools',
  'video-category-fwv2n',
  'image-category-d5zwl',
  'video-category-e2v4g',
  'image-category-e78o2',
  'text-category-nfjhp',
  'video-category-9d33p',
  'video-category-9dael',
];
const VALID_MEDIA_KINDS = new Set(['text', 'image', 'video', 'audio']);
const VALID_PARAM_KINDS = new Set(['text', 'number', 'select', 'boolean']);
const VALID_PARENT_IDS = new Set(['image', 'video', 'audio', 'model3d', 'text']);
const RH_TOOLBOX_MIN_RUNTIME_MS = 60 * 60 * 1000;
const FORBIDDEN_MANIFEST_PATTERNS = [
  [/RHToolboxMakerNode/, 'dev maker component name'],
  [/rh-toolbox-maker/, 'dev maker node type'],
  [/t8-rh-toolbox-maker-drafts/, 'dev maker localStorage key'],
  [/\bapiKey\b\s*[:=]/i, 'apiKey field'],
  [/Authorization\s*:\s*Bearer/i, 'bearer token header'],
  [/sk-[A-Za-z0-9_-]{16,}/, 'API token-like secret'],
];

function fail(message, failures) {
  failures.push(message);
}

function readManifestSource() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`manifest file not found: ${MANIFEST_PATH}`);
  }
  return fs.readFileSync(MANIFEST_PATH, 'utf-8');
}

function extractObjectLiteral(source) {
  const marker = 'export const RH_TOOLBOX_MANIFEST';
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error('RH_TOOLBOX_MANIFEST export not found');
  const start = source.indexOf('{', markerIndex);
  if (start < 0) throw new Error('RH_TOOLBOX_MANIFEST object literal not found');

  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('RH_TOOLBOX_MANIFEST object literal is not balanced');
}

function loadManifest() {
  const source = readManifestSource();
  const literal = extractObjectLiteral(source);
  const manifest = Function(`"use strict"; return (${literal});`)();
  return { source, manifest };
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function collectDuplicateIds(items) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    const id = String(item && item.id || '').trim();
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return Array.from(duplicates);
}

function validateManifest(source, manifest) {
  const failures = [];
  for (const [pattern, label] of FORBIDDEN_MANIFEST_PATTERNS) {
    if (pattern.test(source)) fail(`manifest contains forbidden ${label}`, failures);
  }

  if (!isPlainObject(manifest)) fail('manifest is not an object', failures);
  if (manifest.schema !== 't8-rh-toolbox-manifest') fail('manifest.schema must be t8-rh-toolbox-manifest', failures);
  if (!Number.isFinite(manifest.version)) fail('manifest.version must be a number', failures);
  if (!Array.isArray(manifest.categories)) fail('manifest.categories must be an array', failures);
  if (!Array.isArray(manifest.tools)) fail('manifest.tools must be an array', failures);
  if (failures.length) return failures;

  const categories = manifest.categories;
  const tools = manifest.tools;
  const categoryIds = new Set(categories.map((category) => String(category.id || '').trim()).filter(Boolean));
  const categoryDuplicates = collectDuplicateIds(categories);
  const toolDuplicates = collectDuplicateIds(tools);
  if (categoryDuplicates.length) fail(`duplicate category ids: ${categoryDuplicates.join(', ')}`, failures);
  if (toolDuplicates.length) fail(`duplicate tool ids: ${toolDuplicates.join(', ')}`, failures);

  for (const id of REQUIRED_CATEGORY_IDS) {
    if (!categoryIds.has(id)) fail(`required category missing: ${id}`, failures);
  }
  for (const category of categories) {
    if (!String(category.id || '').trim()) fail('category has empty id', failures);
    if (!String(category.name || '').trim()) fail(`category ${category.id || '(unknown)'} has empty name`, failures);
    if (!VALID_PARENT_IDS.has(String(category.parentId || ''))) {
      fail(`category ${category.id || '(unknown)'} has invalid parentId`, failures);
    }
  }

  const enabledTools = tools.filter((tool) => tool && tool.enabled !== false && String(tool.webappId || '').trim());
  const minEnabled = Number(process.env.T8_RH_TOOLBOX_MIN_ENABLED || 5);
  if (enabledTools.length < minEnabled) {
    fail(`enabled RH toolbox tools ${enabledTools.length} is below T8_RH_TOOLBOX_MIN_ENABLED=${minEnabled}`, failures);
  }

  const toolIds = new Set(tools.map((tool) => String(tool.id || '').trim()).filter(Boolean));
  for (const id of REQUIRED_TOOL_IDS) {
    if (!toolIds.has(id)) fail(`required tool missing: ${id}`, failures);
  }

  for (const tool of tools) {
    const id = String(tool.id || '').trim() || '(unknown)';
    const enabled = tool.enabled !== false && String(tool.webappId || '').trim();
    if (!String(tool.id || '').trim()) fail('tool has empty id', failures);
    if (!String(tool.title || '').trim()) fail(`tool ${id} has empty title`, failures);
    if (!categoryIds.has(String(tool.categoryId || '').trim())) fail(`tool ${id} references missing category`, failures);
    if (!Array.isArray(tool.capabilities) || tool.capabilities.length === 0) fail(`tool ${id} has no capabilities`, failures);
    if (!Array.isArray(tool.inputSchema) || tool.inputSchema.length === 0) fail(`tool ${id} has empty inputSchema`, failures);
    if (!Array.isArray(tool.outputSchema) || tool.outputSchema.length === 0) fail(`tool ${id} has empty outputSchema`, failures);

    if (enabled && !/^\d{10,}$/.test(String(tool.webappId))) {
      fail(`tool ${id} has invalid webappId`, failures);
    }

    for (const [index, input] of (tool.inputSchema || []).entries()) {
      const label = `tool ${id} input[${index}]`;
      if (!String(input.key || '').trim()) fail(`${label} has empty key`, failures);
      if (!VALID_MEDIA_KINDS.has(String(input.kind || ''))) fail(`${label} has invalid kind`, failures);
      if (!String(input.rhNodeId || '').trim()) fail(`${label} has empty rhNodeId`, failures);
      if (!String(input.fieldName || '').trim()) fail(`${label} has empty fieldName`, failures);
    }

    for (const [index, output] of (tool.outputSchema || []).entries()) {
      const label = `tool ${id} output[${index}]`;
      if (!String(output.key || '').trim()) fail(`${label} has empty key`, failures);
      if (!VALID_MEDIA_KINDS.has(String(output.kind || ''))) fail(`${label} has invalid kind`, failures);
    }

    for (const [index, param] of (tool.userParams || []).entries()) {
      const label = `tool ${id} userParam[${index}]`;
      if (!String(param.key || '').trim()) fail(`${label} has empty key`, failures);
      if (!String(param.label || '').trim()) fail(`${label} has empty label`, failures);
      if (!VALID_PARAM_KINDS.has(String(param.kind || ''))) fail(`${label} has invalid kind`, failures);
      if (!String(param.rhNodeId || '').trim()) fail(`${label} has empty rhNodeId`, failures);
      if (!String(param.fieldName || '').trim()) fail(`${label} has empty fieldName`, failures);
      if (param.kind === 'select' && (!Array.isArray(param.options) || param.options.length < 2)) {
        fail(`${label} select param has fewer than 2 options`, failures);
      }
    }

    for (const [index, fixed] of (tool.fixedParams || []).entries()) {
      const label = `tool ${id} fixedParam[${index}]`;
      if (!String(fixed.rhNodeId || '').trim()) fail(`${label} has empty rhNodeId`, failures);
      if (!String(fixed.fieldName || '').trim()) fail(`${label} has empty fieldName`, failures);
    }

    const runtime = tool.runtime || {};
    if (runtime.pollIntervalMs != null && Number(runtime.pollIntervalMs) < 1000) {
      fail(`tool ${id} runtime.pollIntervalMs is too low`, failures);
    }
    if (runtime.maxPolls != null && Number(runtime.maxPolls) < 1) {
      fail(`tool ${id} runtime.maxPolls must be >= 1`, failures);
    }
    const pollIntervalMs = Number(runtime.pollIntervalMs || 5000);
    const maxPolls = Number(runtime.maxPolls || Math.ceil(RH_TOOLBOX_MIN_RUNTIME_MS / Math.max(1, pollIntervalMs)));
    if (enabled && pollIntervalMs * maxPolls < RH_TOOLBOX_MIN_RUNTIME_MS) {
      fail(`tool ${id} runtime must allow at least 60 minutes of polling`, failures);
    }
  }

  return failures;
}

function findArgValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return '';
  return process.argv[index + 1] || '';
}

function walkFiles(root, out = []) {
  if (!fs.existsSync(root)) return out;
  const st = fs.statSync(root);
  if (!st.isDirectory()) return out;
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    const item = fs.statSync(full);
    if (item.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function checkFrontendMarkers(frontendDir, markers) {
  if (!frontendDir) return [];
  const failures = [];
  const abs = path.resolve(ROOT, frontendDir);
  if (!fs.existsSync(abs)) {
    fail(`frontend dir not found: ${abs}`, failures);
    return failures;
  }
  const files = walkFiles(abs).filter((file) => ['.html', '.js', '.mjs', '.json'].includes(path.extname(file).toLowerCase()));
  const haystack = files.map((file) => fs.readFileSync(file, 'utf-8')).join('\n');
  for (const marker of markers) {
    if (!haystack.includes(marker)) fail(`frontend bundle is missing RH toolbox marker: ${marker}`, failures);
  }
  return failures;
}

function frontendMarkersForManifest(manifest) {
  const markers = [];
  for (const tool of Array.isArray(manifest.tools) ? manifest.tools : []) {
    if (!tool || tool.enabled === false || !String(tool.webappId || '').trim()) continue;
    if (String(tool.id || '').trim()) markers.push(String(tool.id).trim());
    markers.push(String(tool.webappId).trim());
  }
  return Array.from(new Set(markers));
}

function main() {
  syncRhToolboxManifest({ verbose: true });
  const { source, manifest } = loadManifest();
  const failures = validateManifest(source, manifest);
  const frontendDir = findArgValue('--frontend') || process.env.T8_RH_TOOLBOX_FRONTEND_DIR || '';
  failures.push(...checkFrontendMarkers(frontendDir, frontendMarkersForManifest(manifest)));

  if (failures.length) {
    console.error('[rh-toolbox-check] FAILED');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  const enabledTools = manifest.tools.filter((tool) => tool && tool.enabled !== false && String(tool.webappId || '').trim());
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(manifest))
    .digest('hex')
    .slice(0, 12);
  console.log(`[rh-toolbox-check] ok: ${enabledTools.length} enabled tools, ${manifest.categories.length} categories, hash=${hash}`);
}

main();
