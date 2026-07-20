'use strict';

// Read `rg --json` output for Codex source-patch events and emit only the
// projectDatabase.js migration-bearing summaries. This never opens a database.

const crypto = require('node:crypto');
const readline = require('node:readline');

const entries = [];
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  let rgEvent;
  try { rgEvent = JSON.parse(line); } catch (_) { return; }
  if (rgEvent.type !== 'match') return;
  const sourceLine = rgEvent.data?.lines?.text;
  if (!sourceLine) return;
  let event;
  try { event = JSON.parse(sourceLine); } catch (_) { return; }
  if (event.type !== 'event_msg'
    || event.payload?.type !== 'patch_apply_end'
    || event.payload?.success !== true) return;
  for (const [filename, change] of Object.entries(event.payload?.changes || {})) {
    if (!/projectDatabase\.js$/i.test(filename)) continue;
    const diff = String(change?.unified_diff || '');
    entries.push({
      timestamp: event.timestamp,
      sourceLog: String(rgEvent.data?.path?.text || ''),
      filename,
      callId: String(event.payload?.call_id || ''),
      sha256: crypto.createHash('sha256').update(diff).digest('hex'),
      bytes: Buffer.byteLength(diff),
      ...(process.env.T8_PATCH_SHA
        && crypto.createHash('sha256').update(diff).digest('hex').startsWith(process.env.T8_PATCH_SHA)
        ? { diff }
        : {}),
      migrationLines: diff.split(/\r?\n/).filter((candidate) => (
        /PROJECT_DATABASE_SCHEMA_VERSION|ensureColumn|ALTER TABLE|CREATE TABLE|CREATE (?:UNIQUE )?INDEX|CREATE TRIGGER|beforeMigrationCommit/i
          .test(candidate)
      )).slice(0, 80),
    });
  }
});

input.on('close', () => {
  const unique = new Map();
  for (const entry of entries) {
    const key = `${entry.filename.toLowerCase()}\0${entry.sha256}`;
    const previous = unique.get(key);
    if (!previous || String(entry.timestamp) < String(previous.timestamp)) unique.set(key, entry);
  }
  let output = [...unique.values()];
  if (process.argv.includes('--migration-only')) {
    output = output.filter((entry) => entry.migrationLines.length > 0);
  }
  if (process.argv.includes('--core-only')) {
    output = output.filter((entry) => /\\T8-penguin-canvas\\backend\\/i.test(entry.filename)
      && !/T8-penguin-canvas-release-/i.test(entry.filename));
  }
  output.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp))
    || left.filename.localeCompare(right.filename));
  for (const entry of output) process.stdout.write(`${JSON.stringify(entry)}\n`);
});
