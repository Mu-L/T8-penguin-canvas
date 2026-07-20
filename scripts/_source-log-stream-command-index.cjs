'use strict';

// Stream Codex session logs and print matching shell calls without buffering
// the (potentially multi-gigabyte) rg result set. Read-only diagnostic helper.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const pattern = new RegExp(process.argv[2] || 'projectDatabase\\.js', 'i');
const from = process.argv.find((arg) => arg.startsWith('--from='))?.slice('--from='.length) || '';
const to = process.argv.find((arg) => arg.startsWith('--to='))?.slice('--to='.length) || '';
const roots = [
  'C:\\Users\\Administrator\\.codex\\archived_sessions',
  'C:\\Users\\Administrator\\.codex\\sessions\\2026\\07',
];

function collectFiles(root, output) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) collectFiles(filename, output);
    else if (entry.isFile() && /^rollout-2026-07-(?:0[4-9]|1[0-9]|20).*\.jsonl$/i.test(entry.name)) {
      output.push(filename);
    }
  }
}

async function main() {
  const files = [];
  roots.forEach((root) => collectFiles(root, files));
  const seen = new Set();
  const rows = [];
  for (const filename of files) {
    const lines = readline.createInterface({
      input: fs.createReadStream(filename),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch (_) { continue; }
      if (event.type !== 'response_item') continue;
      if (from && String(event.timestamp) < from) continue;
      if (to && String(event.timestamp) > to) continue;
      const payload = event.payload || {};
      const custom = payload.type === 'custom_tool_call';
      const legacy = payload.type === 'function_call';
      if (!custom && !legacy) continue;
      const command = String(custom ? payload.input || '' : payload.arguments || '');
      const toolName = String(payload.name || '');
      const shell = custom
        ? command.includes('shell_command') && !command.includes('apply_patch')
        : ['exec_command', 'shell_command'].includes(toolName);
      if (!shell || !pattern.test(command)) continue;
      const callId = String(payload.call_id || '');
      const key = callId || `${event.timestamp}:${command}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        timestamp: String(event.timestamp),
        callId,
        log: path.basename(filename),
        command: command.replace(/\s+/g, ' ').trim().slice(0, 1200),
      });
    }
  }
  rows.sort((left, right) => left.timestamp.localeCompare(right.timestamp)
    || left.callId.localeCompare(right.callId));
  for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
