import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLogStore,
  LOG_STORAGE_NAME,
  normalizePersistedLogEntries,
  sanitizeLogMessageForPersistence,
  type LogStorage,
} from '../src/stores/logs';

class MemoryStorage implements LogStorage {
  private readonly values = new Map<string, string>();
  getItem(name: string) { return this.values.get(name) ?? null; }
  setItem(name: string, value: string) { this.values.set(name, value); }
  removeItem(name: string) { this.values.delete(name); }
}

test('persisted terminal logs redact signed URLs and credentials', () => {
  const sanitized = sanitizeLogMessageForPersistence(
    'GET https://cdn.example/result.png?X-Amz-Signature=secret#token Authorization=topsecret Bearer abcdefghijkl sk-proj-1234567890',
  );
  assert.equal(
    sanitized,
    'GET https://cdn.example/result.png?[redacted]#[redacted] Authorization=[redacted] Bearer [redacted] [redacted-api-key]',
  );
  assert.doesNotMatch(sanitized, /secret|topsecret|abcdefghijkl|1234567890/);
});

test('terminal logs synchronously survive store recreation and clear removes recovered history', () => {
  const storage = new MemoryStorage();
  const first = createLogStore(storage);
  first.getState().log(
    'error',
    '下载失败 https://cdn.example/output.webp?signature=must-not-persist',
    'image:abc123',
  );

  const raw = storage.getItem(LOG_STORAGE_NAME);
  assert.ok(raw);
  assert.doesNotMatch(raw, /must-not-persist/);
  assert.match(raw, /\[redacted\]/);

  const restored = createLogStore(storage);
  assert.equal(restored.getState().entries.length, 1);
  assert.equal(restored.getState().entries[0]?.level, 'error');
  assert.equal(restored.getState().entries[0]?.source, 'image:abc123');
  assert.equal(
    restored.getState().entries[0]?.message,
    '下载失败 https://cdn.example/output.webp?[redacted]',
  );

  restored.getState().clear();
  const afterClear = createLogStore(storage);
  assert.deepEqual(afterClear.getState().entries, []);
});

test('malformed, stale and future persisted log entries are discarded', () => {
  const now = 1_800_000_000_000;
  const entries = normalizePersistedLogEntries([
    { id: 'valid', ts: now, level: 'info', message: 'kept' },
    { id: 'stale', ts: now - (15 * 24 * 60 * 60 * 1_000), level: 'warn', message: 'old' },
    { id: 'future', ts: now + 60_001, level: 'error', message: 'future' },
    { id: 'bad-level', ts: now, level: 'fatal', message: 'bad' },
  ], now);
  assert.deepEqual(entries, [{ id: 'valid', ts: now, level: 'info', message: 'kept' }]);
});
