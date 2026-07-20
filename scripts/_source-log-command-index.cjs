'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const filename = process.argv[2];
const pattern = new RegExp(process.argv[3] || 'projectDatabase\\.js', 'i');
const from = process.argv.find((arg) => arg.startsWith('--from='))?.slice('--from='.length) || '';
const to = process.argv.find((arg) => arg.startsWith('--to='))?.slice('--to='.length) || '';
const compact = process.argv.includes('--compact');
const input = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity });

input.on('line', (line) => {
  let event;
  try { event = JSON.parse(line); } catch (_) { return; }
  const payload = event.payload || {};
  if (event.type !== 'response_item') return;
  if (from && String(event.timestamp) < from) return;
  if (to && String(event.timestamp) > to) return;
  const isCustomToolCall = payload.type === 'custom_tool_call';
  const isLegacyFunctionCall = payload.type === 'function_call';
  if (!isCustomToolCall && !isLegacyFunctionCall) return;
  const command = String(isCustomToolCall ? (payload.input || '') : (payload.arguments || ''));
  if (process.argv.includes('--shell-only')) {
    const toolName = String(payload.name || '');
    const isShell = isCustomToolCall
      ? (command.includes('shell_command') && !command.includes('apply_patch'))
      : ['exec_command', 'shell_command'].includes(toolName);
    if (!isShell) return;
  }
  if (!pattern.test(command)) return;
  const renderedCommand = compact
    ? command.replace(/\s+/g, ' ').trim().slice(0, 800)
    : command;
  process.stdout.write(`${JSON.stringify({
    timestamp: event.timestamp,
    callId: payload.call_id,
    toolName: payload.name || (isCustomToolCall ? 'custom_tool_call' : ''),
    command: renderedCommand,
  })}\n`);
});
