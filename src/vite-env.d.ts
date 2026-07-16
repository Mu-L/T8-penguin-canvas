/// <reference types="vite/client" />

declare module 'virtual:t8-local-extensions' {
  import type { FC } from 'react';
  import type { LocalNodeAddonSlotProps, LocalSettingsAddonSlotProps, LocalTopbarSlotProps } from './extensions/localExtensionTypes';

  export const LocalTopbarSlot: FC<LocalTopbarSlotProps>;
  export const LocalNodeAddonSlot: FC<LocalNodeAddonSlotProps>;
  export const LocalSettingsAddonSlot: FC<LocalSettingsAddonSlotProps>;
  export const LocalModalSlot: FC;
}

type T8UpdaterStatusCode =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

interface T8UpdaterProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

interface T8UpdaterStatus {
  status: T8UpdaterStatusCode;
  currentVersion: string;
  availableVersion?: string | null;
  message?: string | null;
  progress?: T8UpdaterProgress | null;
  downloaded?: boolean;
  error?: string | null;
  packaged?: boolean;
  updatedAt?: string | null;
}

interface T8UpdaterResult {
  success: boolean;
  message?: string;
  info?: unknown;
  status?: T8UpdaterStatus;
}

interface T8DragFileOutStatus {
  requestId?: string;
  success: boolean;
  message?: string;
  file?: string;
}

interface T8ParseAuthCookie {
  profileId: string;
  label: string;
  cookie: string;
  count: number;
  length: number;
  expiresAt?: string | null;
  domains?: string[];
}

interface T8ParseAuthSavedRecord {
  profileId: string;
  label: string;
  saved: true;
  encrypted?: boolean;
  savedAt?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  length: number;
  count: number;
  domains?: string[];
  cookie?: string;
}

interface T8ParseAuthResult {
  success: boolean;
  message?: string;
  data?: T8ParseAuthCookie
    | T8ParseAuthSavedRecord
    | { records: T8ParseAuthSavedRecord[]; encryptionAvailable: boolean }
    | { profileId: string; label: string; removed: number; savedRemoved?: number };
}

interface T8PickedMediaFile {
  path: string;
  name: string;
  kind: 'image' | 'video' | 'audio' | 'model3d';
  size: number;
  mime: string;
  relativePath?: string;
}

interface T8PickMediaFilesResult {
  success: boolean;
  cancelled?: boolean;
  message?: string;
  files?: T8PickedMediaFile[];
  truncated?: boolean;
}

interface Window {
  t8pc?: {
    getInfo: () => Promise<{
      packaged: boolean;
      backendPort: number;
      userData: string;
      version: string;
      updater?: T8UpdaterStatus;
    }>;
    openExternal: (url: string) => Promise<{ success: boolean; message?: string }>;
    openPath: (targetPath: string) => Promise<{ success: boolean; message?: string; path?: string }>;
    pickMediaFiles?: (options?: { directory?: boolean; multiple?: boolean; kinds?: Array<'image' | 'video' | 'audio' | 'model3d'> }) => Promise<T8PickMediaFilesResult>;
    getPathForFile?: (file: File) => string;
    dragFileOut?: (payload: { url?: string; path?: string; filename?: string; kind?: string; requestId?: string }) => void;
    onDragFileOutStatus?: (callback: (status: T8DragFileOutStatus) => void) => () => void;
    parseAuth?: {
      login: (profileId: string) => Promise<T8ParseAuthResult>;
      getCookie: (profileId: string) => Promise<T8ParseAuthResult>;
      listSaved: (profileId?: string) => Promise<T8ParseAuthResult>;
      save: (profileId: string, cookieText: string, meta?: Record<string, unknown>) => Promise<T8ParseAuthResult>;
      load: (profileId: string) => Promise<T8ParseAuthResult>;
      clear: (profileId: string) => Promise<T8ParseAuthResult>;
    };
    updater?: {
      getStatus: () => Promise<T8UpdaterStatus>;
      check: () => Promise<T8UpdaterResult>;
      download: () => Promise<T8UpdaterResult>;
      install: () => Promise<T8UpdaterResult>;
      onStatus: (callback: (status: T8UpdaterStatus) => void) => () => void;
    };
  };
}
