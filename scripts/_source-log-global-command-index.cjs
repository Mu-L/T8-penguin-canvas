'use strict';

// Read-only diagnostic index for locating historical shell launches in Codex
// session logs. It never opens a project database.

const childProcess = require('node:child_process');
const path = require('node:path');

const patternText = process.argv[2] || 'Start-Process|npm run dev|dev:backend|node src/server\\.js';
const pattern = new RegExp(patternText, 'i');
const from = process.argv.find((arg) => arg.startsWith('--from='))?.slice('--from='.length) || '';
const to = process.argv.find((arg) => arg.startsWith('--to='))?.slice('--to='.length) || '';
const compact = process.argv.includes('--compact');
const coreOnly = process.argv.includes('--core-only');
const defaultDataOnly = process.argv.includes('--default-data-only');
const roots = [
  'C:\\Users\\Administrator\\.codex\\archived_sessions',
  'C:\\Users\\Administrator\\.codex\\sessions\\2026\\07',
];

const result = childProcess.spawnSync('rg', [
  '--json',
  '-g', 'rollout-2026-07-04*.jsonl',
  '-g', 'rollout-2026-07-1[2-6]*.jsonl',
  patternText,
  ...roots,
], {
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 512 * 1024 * 1024,
});
if (result.error) throw result.error;
if (![0, 1].includes(result.status)) {
  throw new Error(`rg failed (${result.status}): ${String(result.stderr || '').slice(0, 1000)}`);
}

const seen = new Set();
const rows = [];
for (const line of String(result.stdout || '').split(/\r?\n/)) {
  let rgEvent;
  try { rgEvent = JSON.parse(line); } catch (_) { continue; }
  if (rgEvent.type !== 'match') continue;
  let event;
  try { event = JSON.parse(rgEvent.data?.lines?.text); } catch (_) { continue; }
  const payload = event.payload || {};
  if (event.type !== 'response_item') continue;
  if (from && String(event.timestamp) < from) continue;
  if (to && String(event.timestamp) > to) continue;
  const isCustomToolCall = payload.type === 'custom_tool_call';
  const isLegacyFunctionCall = payload.type === 'function_call';
  if (!isCustomToolCall && !isLegacyFunctionCall) continue;
  const command = String(isCustomToolCall ? (payload.input || '') : (payload.arguments || ''));
  if (!pattern.test(command)) continue;
  if (coreOnly && !/E:\\\\PenguinPravite\\\\T8-penguin-canvas(?!-release)/i.test(command)) continue;
  if (defaultDataOnly && /T8PC_USER_DATA(?:_DIR)?/i.test(command)) continue;
  const callId = String(payload.call_id || '');
  const key = callId || `${event.timestamp}:${command}`;
  if (seen.has(key)) continue;
  seen.add(key);
  rows.push({
    timestamp: String(event.timestamp),
    callId,
    toolName: String(payload.name || (isCustomToolCall ? 'custom_tool_call' : '')),
    log: path.basename(String(rgEvent.data?.path?.text || '')),
    command: compact ? command.replace(/\s+/g, ' ').trim().slice(0, 1000) : command,
  });
}

rows.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.callId.localeCompare(right.callId));
for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
