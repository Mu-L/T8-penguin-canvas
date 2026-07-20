import { GARDEN_DEFENSE_VERSION, type GardenProfile, type GardenRunState } from './types.ts';
import { createGardenProfile, createGardenRun } from './engine.ts';

export const GARDEN_PROFILE_STORAGE_KEY = 't8-garden-defense-profile-v1';
const RUN_KEY_PREFIX = 't8-garden-defense-run-v1:';

function readJson(key: string) {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage pressure must never interrupt the canvas.
  }
}

export function loadGardenProfile(): GardenProfile {
  const raw = readJson(GARDEN_PROFILE_STORAGE_KEY);
  return createGardenProfile(raw && raw.version === GARDEN_DEFENSE_VERSION ? raw : {});
}

export function saveGardenProfile(profile: GardenProfile) {
  writeJson(GARDEN_PROFILE_STORAGE_KEY, createGardenProfile(profile));
}

export function gardenRunStorageKey(canvasId: string) {
  return `${RUN_KEY_PREFIX}${canvasId || 'default'}`;
}

export function loadGardenRun(canvasId: string, stageId?: string): GardenRunState {
  const raw = readJson(gardenRunStorageKey(canvasId));
  if (raw && raw.version === GARDEN_DEFENSE_VERSION && typeof raw.runId === 'string') {
    return {
      ...createGardenRun({ stageId: raw.stageId || stageId, seed: raw.seed }),
      ...raw,
      cooldowns: { ...(raw.cooldowns || {}) },
      plants: Array.isArray(raw.plants) ? raw.plants : [],
      zombies: Array.isArray(raw.zombies) ? raw.zombies : [],
      projectiles: Array.isArray(raw.projectiles) ? raw.projectiles : [],
      suns: Array.isArray(raw.suns) ? raw.suns : [],
      mowers: Array.isArray(raw.mowers) ? raw.mowers : [],
      events: Array.isArray(raw.events) ? raw.events : [],
      effects: [],
      stats: { ...createGardenRun().stats, ...(raw.stats || {}) },
      status: raw.status === 'running' ? 'paused' : raw.status,
      statusBeforePause: raw.status === 'running' ? 'running' : raw.statusBeforePause,
    };
  }
  return createGardenRun({ stageId });
}

export function saveGardenRun(canvasId: string, state: GardenRunState) {
  writeJson(gardenRunStorageKey(canvasId), { ...state, effects: [] });
}

export function clearGardenRun(canvasId: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(gardenRunStorageKey(canvasId));
  } catch {
    // Ignore unavailable storage.
  }
}
