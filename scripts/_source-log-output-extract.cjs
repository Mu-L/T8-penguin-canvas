'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const [filename, callId, outputFilename] = process.argv.slice(2);
if (!filename || !callId || !outputFilename) {
  throw new Error('usage: source-log-output-extract <jsonl> <call-id> <output>');
}
const input = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity });
let found = false;
input.on('line', (line) => {
  if (found || !line.includes(callId)) return;
  let event;
  try { event = JSON.parse(line); } catch (_) { return; }
  const payload = event.payload || {};
  if (event.type !== 'response_item'
    || payload.type !== 'custom_tool_call_output'
    || payload.call_id !== callId) return;
  const text = Array.isArray(payload.output)
    ? payload.output.map((item) => String(item?.text || '')).join('')
    : String(payload.output || '');
  fs.writeFileSync(outputFilename, text);
  found = true;
});
input.on('close', () => {
  if (!found) throw new Error(`output not found: ${callId}`);
  process.stdout.write(`${outputFilename}\n`);
});
