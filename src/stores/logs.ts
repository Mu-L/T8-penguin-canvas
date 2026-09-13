import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * 日志总线 - 对齐 gpt-image-2-web 的 log() 实现
 * 任意业务节点都可以调用 logBus.log('级别', '内容', '来源') 写入
 * TerminalPanel 订阅显示
 */
export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  id: string;
  ts: number; // unix ms
  level: LogLevel;
  source?: string; // 节点 id 或模块名,如 image:nodeXXX / video / system
  message: string;
}

export interface LogState {
  entries: LogEntry[];
  open: boolean;
  unread: number; // 未读消息数(面板关闭时累计)
  log: (level: LogLevel, message: string, source?: string) => void;
  clear: () => void;
  setOpen: (v: boolean) => void;
  toggleOpen: () => void;
}

const MAX_LOGS = 500;
const MAX_PERSISTED_LOGS = 300;
const MAX_PERSISTED_MESSAGE_LENGTH = 2_000;
const LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
export const LOG_STORAGE_NAME = 't8-canvas-logs-v1';

export interface LogStorage {
  getItem: (name: string) => string | null;
  setItem: (name: string, value: string) => void;
  removeItem: (name: string) => void;
}

const LOG_LEVELS = new Set<LogLevel>(['info', 'success', 'warn', 'error', 'debug']);

function sanitizePersistedUrl(raw: string) {
  const trailingMatch = raw.match(/([),.;!?，。；！]+)$/);
  const trailing = trailingMatch?.[1] || '';
  const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
  try {
    const parsed = new URL(candidate);
    const queryNotice = parsed.search ? '?[redacted]' : '';
    const hashNotice = parsed.hash ? '#[redacted]' : '';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${queryNotice}${hashNotice}${trailing}`;
  } catch (_) {
    return '[redacted-url]';
  }
}

/**
 * Only the persisted copy is redacted. The live in-memory panel keeps the
 * original diagnostic text, while restart recovery never stores signed query
 * strings, bearer tokens or API keys in browser storage.
 */
export function sanitizeLogMessageForPersistence(message: unknown) {
  let text = String(message ?? '');
  text = text.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, sanitizePersistedUrl);
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[redacted]');
  text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/gi, '[redacted-api-key]');
  text = text.replace(
    /((?:api[_-]?key|access[_-]?token|token|secret|signature|authorization)["']?\s*[:=]\s*["']?)([^"'\s,;}]+)/gi,
    '$1[redacted]',
  );
  if (text.length <= MAX_PERSISTED_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_PERSISTED_MESSAGE_LENGTH)}…[truncated]`;
}

export function normalizePersistedLogEntries(value: unknown, now = Date.now()) {
  const cutoff = now - LOG_RETENTION_MS;
  const candidates = Array.isArray(value) ? value.slice(-MAX_PERSISTED_LOGS) : [];
  const entries: LogEntry[] = [];
  const seenIds = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Partial<LogEntry>;
    const ts = Math.trunc(Number(record.ts));
    if (!Number.isSafeInteger(ts) || ts < cutoff || ts > now + 60_000) continue;
    if (!LOG_LEVELS.has(record.level as LogLevel) || typeof record.message !== 'string') continue;
    let id = String(record.id || `${ts}_restored_${index}`).slice(0, 160);
    if (seenIds.has(id)) id = `${id}_${index}`.slice(0, 160);
    seenIds.add(id);
    entries.push({
      id,
      ts,
      level: record.level as LogLevel,
      ...(typeof record.source === 'string' && record.source ? { source: record.source.slice(0, 160) } : {}),
      message: sanitizeLogMessageForPersistence(record.message),
    });
  }
  return entries;
}

export function createLogStore(storage?: LogStorage) {
  return create<LogState>()(
    persist(
      (set, get) => ({
        entries: [],
        open: false,
        unread: 0,
        log: (level, message, source) => {
          const entry: LogEntry = {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            ts: Date.now(),
            level,
            source,
            message: String(message ?? ''),
          };
          set((state) => {
            const entries = [...state.entries, entry];
            if (entries.length > MAX_LOGS) entries.splice(0, entries.length - MAX_LOGS);
            return { entries, unread: state.open ? 0 : Math.min(99, state.unread + 1) };
          });
        },
        clear: () => set({ entries: [], unread: 0 }),
        setOpen: (value) => set({ open: value, unread: value ? 0 : get().unread }),
        toggleOpen: () => set((state) => ({ open: !state.open, unread: !state.open ? 0 : state.unread })),
      }),
      {
        name: LOG_STORAGE_NAME,
        version: 1,
        storage: createJSONStorage(() => storage || window.localStorage),
        partialize: (state) => ({
          entries: state.entries.slice(-MAX_PERSISTED_LOGS).map((entry) => ({
            ...entry,
            source: entry.source?.slice(0, 160),
            message: sanitizeLogMessageForPersistence(entry.message),
          })),
        }),
        merge: (persisted, current) => {
          const restored = normalizePersistedLogEntries((persisted as Partial<LogState> | null)?.entries);
          return { ...current, entries: restored };
        },
      },
    ),
  );
}

export const useLogStore = createLogStore();

// 便捷 API
export const logBus = {
  info: (msg: string, source?: string) => useLogStore.getState().log('info', msg, source),
  success: (msg: string, source?: string) => useLogStore.getState().log('success', msg, source),
  warn: (msg: string, source?: string) => useLogStore.getState().log('warn', msg, source),
  error: (msg: string, source?: string) => useLogStore.getState().log('error', msg, source),
  debug: (msg: string, source?: string) => useLogStore.getState().log('debug', msg, source),
};
