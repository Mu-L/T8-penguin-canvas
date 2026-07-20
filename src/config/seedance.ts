export const LEGACY_SEEDANCE_MODEL_OPTIONS = [
  { value: 'doubao-seedance-2-0-fast-260128', label: 'seedance-2-0-fast' },
  { value: 'doubao-seedance-2-0-260128', label: 'seedance-2-0' },
  { value: 'doubao-seedance-2.0-mini', label: 'seedance-2.0-mini' },
] as const;

export const SEEDANCE_NZ_MODEL_OPTIONS = [
  { value: 'standard', label: '国内 Standard' },
  { value: 'fast', label: '国内 Fast' },
  { value: 'mini', label: '国内 Mini' },
  { value: 'global-standard', label: '全球 Standard' },
  { value: 'global-fast', label: '全球 Fast' },
  { value: 'global-mini', label: '全球 Mini' },
] as const;

export const LEGACY_SEEDANCE_RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', 'adaptive'] as const;
export const SEEDANCE_NZ_RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'] as const;
export const LEGACY_SEEDANCE_RESOLUTION_OPTIONS = ['480p', '720p', 'native1080p', 'native4K', '1080p', '2k', '4k'] as const;
export const SEEDANCE_NZ_RESOLUTION_OPTIONS = ['480p', '720p', '1080p', '2k', '4k'] as const;
export const SEEDANCE_NZ_NATIVE_RESOLUTION_OPTIONS = [...SEEDANCE_NZ_RESOLUTION_OPTIONS, 'native1080p', 'native4k'] as const;
export const SEEDANCE_DURATION_OPTIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
export const SEEDANCE_NZ_DURATION_OPTIONS = [-1, ...SEEDANCE_DURATION_OPTIONS] as const;

export type SeedanceBuiltinSource = 'auto' | 'seedance-nz' | 'zhenzhen-legacy';

export function isSeedanceBuiltinSource(value: unknown): value is SeedanceBuiltinSource {
  return value === 'auto' || value === 'seedance-nz' || value === 'zhenzhen-legacy';
}

export function isSeedanceNzStandardModel(value: unknown): boolean {
  return /(^|-)standard$/.test(String(value || ''));
}
