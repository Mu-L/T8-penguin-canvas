export const GARDEN_DEFENSE_VERSION = 1 as const;
export const GARDEN_ROWS = 5;
export const GARDEN_COLUMNS = 9;
export const GARDEN_CELL_WIDTH = 106;
export const GARDEN_CELL_HEIGHT = 92;
export const GARDEN_FIELD_X = 218;
export const GARDEN_FIELD_Y = 164;
export const GARDEN_FIELD_WIDTH = GARDEN_COLUMNS * GARDEN_CELL_WIDTH;
export const GARDEN_FIELD_HEIGHT = GARDEN_ROWS * GARDEN_CELL_HEIGHT;

export type GardenPlantId =
  | 'sun-bloom'
  | 'pea-scout'
  | 'frost-bulb'
  | 'wall-root'
  | 'ember-melon'
  | 'storm-reed'
  | 'healer-clover'
  | 'chrono-mushroom';

export type GardenZombieId =
  | 'drifter'
  | 'pothead'
  | 'bucket-guard'
  | 'sprinter'
  | 'gatekeeper'
  | 'mole-miner'
  | 'moth-conductor'
  | 'compost-titan';

export type GardenPlantRole = 'sun' | 'shooter' | 'control' | 'tank' | 'splash' | 'support';
export type GardenProjectileKind = 'seed' | 'frost' | 'ember';
export type GardenRunStatus = 'ready' | 'running' | 'paused' | 'won' | 'lost';
export type GardenEventTone = 'info' | 'sun' | 'danger' | 'success' | 'unlock' | 'boss';
export type GardenCombatEffectKind =
  | 'sun-collected'
  | 'projectile-fired'
  | 'projectile-hit'
  | 'chain-hit'
  | 'chrono-hit'
  | 'zombie-bite'
  | 'boss-strike'
  | 'mower-hit';

export interface GardenPlantDefinition {
  id: GardenPlantId;
  name: string;
  description: string;
  role: GardenPlantRole;
  cost: number;
  cooldownMs: number;
  maxHp: number;
  damage: number;
  actionIntervalMs: number;
  projectileSpeed?: number;
  unlockStage: number;
  upgradeBlurb: string;
}

export interface GardenZombieDefinition {
  id: GardenZombieId;
  name: string;
  description: string;
  maxHp: number;
  speed: number;
  damage: number;
  attackIntervalMs: number;
  rewardSun: number;
  unlockWave: number;
  boss?: boolean;
}

export interface GardenStageDefinition {
  id: string;
  number: number;
  name: string;
  subtitle: string;
  totalWaves: number;
  startingSun: number;
  rewardLeaves: number;
  rewardXp: number;
  difficulty: number;
  night?: boolean;
  endless?: boolean;
}

export interface GardenPlantStats {
  maxHp: number;
  damage: number;
  actionIntervalMs: number;
  cost: number;
}

export interface GardenPlantEntity {
  id: string;
  plantId: GardenPlantId;
  row: number;
  column: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  actionInMs: number;
  level: number;
}

export interface GardenZombieEntity {
  id: string;
  zombieId: GardenZombieId;
  row: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  attackInMs: number;
  abilityInMs: number;
  slowMultiplier: number;
  slowRemainingMs: number;
  tunneled?: boolean;
}

export interface GardenProjectileEntity {
  id: string;
  kind: GardenProjectileKind;
  row: number;
  x: number;
  y: number;
  speed: number;
  damage: number;
  slowMultiplier?: number;
  splashRadius?: number;
}

export interface GardenSunEntity {
  id: string;
  x: number;
  y: number;
  value: number;
  ageMs: number;
  source: 'sky' | 'plant' | 'reward';
}

export interface GardenMowerState {
  row: number;
  active: boolean;
  triggeredAt?: number;
}

export interface GardenBattleEvent {
  id: string;
  at: number;
  tone: GardenEventTone;
  title: string;
  detail?: string;
}

export interface GardenCombatEffect {
  id: string;
  at: number;
  kind: GardenCombatEffectKind;
  x: number;
  y: number;
  row: number;
  entityId?: string;
  variant?: GardenProjectileKind;
  value?: number;
  intensity?: number;
}

export interface GardenBattleStats {
  planted: number;
  defeated: number;
  sunCollected: number;
  sunSpent: number;
  damageDealt: number;
  plantsLost: number;
  mowersUsed: number;
  bossesDefeated: number;
}

export interface GardenRunState {
  version: typeof GARDEN_DEFENSE_VERSION;
  runId: string;
  stageId: string;
  status: GardenRunStatus;
  statusBeforePause?: Exclude<GardenRunStatus, 'paused'>;
  rewardClaimed?: boolean;
  seed: number;
  rngState: number;
  elapsedMs: number;
  sun: number;
  lives: number;
  wave: number;
  totalWaves: number;
  waveSize: number;
  spawnedThisWave: number;
  defeatedThisWave: number;
  nextSpawnInMs: number;
  waveBreakMs: number;
  worldSunInMs: number;
  cooldowns: Partial<Record<GardenPlantId, number>>;
  plants: GardenPlantEntity[];
  zombies: GardenZombieEntity[];
  projectiles: GardenProjectileEntity[];
  suns: GardenSunEntity[];
  mowers: GardenMowerState[];
  events: GardenBattleEvent[];
  effects: GardenCombatEffect[];
  stats: GardenBattleStats;
  sequence: number;
}

export interface GardenProfile {
  version: typeof GARDEN_DEFENSE_VERSION;
  rank: number;
  experience: number;
  leafTokens: number;
  completedStages: string[];
  unlockedPlants: GardenPlantId[];
  discoveredZombies: GardenZombieId[];
  plantUpgrades: Partial<Record<GardenPlantId, number>>;
  bestEndlessWave: number;
  totalVictories: number;
  totalDefeated: number;
  soundEnabled: boolean;
  reducedMotion: boolean;
}

export interface GardenCreateRunOptions {
  stageId?: string;
  seed?: number;
  profile?: GardenProfile;
}

export interface GardenCommandResult {
  state: GardenRunState;
  changed: boolean;
  error?: string;
}
