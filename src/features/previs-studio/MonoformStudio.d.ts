import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import type { PrevisStudioEditorHandle } from './PrevisStudioEditor';

export const MONOFORM_SOURCE_URL: string;
export const MONOFORM_SOURCE_COMMIT: string;

export interface MonoformStudioProps {
  initialProject?: Record<string, unknown> | null;
  storageKey?: string;
  projectTitle?: string;
  onProjectChange?: (project: Record<string, unknown>) => void;
  onImportAsset?: (file: File) => Promise<string>;
  onRequestRun?: (kind: 'image' | 'video') => void;
  onClose?: () => void;
}

declare const MonoformStudio: ForwardRefExoticComponent<MonoformStudioProps & RefAttributes<PrevisStudioEditorHandle>>;

export default MonoformStudio;
