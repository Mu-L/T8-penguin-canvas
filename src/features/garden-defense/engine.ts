import {
  GARDEN_CELL_HEIGHT,
  GARDEN_CELL_WIDTH,
  GARDEN_COLUMNS,
  GARDEN_DEFENSE_VERSION,
  GARDEN_FIELD_X,
  GARDEN_FIELD_Y,
  GARDEN_FIELD_HEIGHT,
  GARDEN_FIELD_WIDTH,
  GARDEN_ROWS,
  type GardenBattleEvent,
  type GardenCombatEffect,
  type GardenCommandResult,
  type GardenCreateRunOptions,
  type GardenPlantEntity,
  type GardenPlantId,
  type GardenProfile,
  type GardenProjectileEntity,
  type GardenRunState,
  type GardenStageDefinition,
  type GardenSunEntity,
  type GardenZombieEntity,
  type GardenZombieId,
} from './types.ts';
import {
  GARDEN_PLANTS,
  GARDEN_STAGES,
  GARDEN_ZOMBIES,
  gardenUnlockedPlantsForStage,
  gardenUpgradeCost,
  gardenZombiePoolForWave,
  getGardenPlantStats,
  getGardenStage,
} from './catalog.ts';

const MAX_STEP_MS = 100;
const MAX_EVENTS = 18;
const MAX_EFFECTS = 48;
const EFFECT_LIFETIME_MS = 2200;
const SUN_LIFETIME_MS = 11500;
const HOUSE_X = GARDEN_FIELD_X - 42;
const ZOMBIE_SPAWN_X = GARDEN_FIELD_X + GARDEN_FIELD_WIDTH + 64;

function cloneRun(state: GardenRunState): GardenRunState {
  return {
    ...state,
    cooldowns: { ...state.cooldowns },
    plants: state.plants.map((entity) => ({ ...entity })),
    zombies: state.zombies.map((entity) => ({ ...entity })),
    projectiles: state.projectiles.map((entity) => ({ ...entity })),
    suns: state.suns.map((entity) => ({ ...entity })),
    mowers: state.mowers.map((mower) => ({ ...mower })),
    events: state.events.map((event) => ({ ...event })),
    effects: state.effects.map((effect) => ({ ...effect })),
    stats: { ...state.stats },
  };
}

function nextId(state: GardenRunState, prefix: string) {
  state.sequence += 1;
  return `${prefix}-${state.sequence}`;
}

function random(state: GardenRunState) {
  state.rngState = (Math.imul(state.rngState, 1664525) + 1013904223) >>> 0;
  return state.rngState / 4294967296;
}

function pushEvent(state: GardenRunState, event: Omit<GardenBattleEvent, 'id' | 'at'>) {
  state.events.unshift({ ...event, id: nextId(state, 'event'), at: state.elapsedMs });
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
}

function pushEffect(state: GardenRunState, effect: Omit<GardenCombatEffect, 'id' | 'at'>) {
  state.effects.push({ ...effect, id: nextId(state, 'effect'), at: state.elapsedMs });
  if (state.effects.length > MAX_EFFECTS) state.effects.splice(0, state.effects.length - MAX_EFFECTS);
}

function stageWaveSize(stage: GardenStageDefinition, wave: number) {
  const endlessScale = stage.endless ? Math.floor(Math.max(0, wave - 8) * 0.9) : 0;
  return Math.max(4, Math.round(3 + wave * 2.2 + stage.difficulty * 1.7 + endlessScale));
}

function cellCenter(column: number, row: number) {
  return {
    x: GARDEN_FIELD_X + column * GARDEN_CELL_WIDTH + GARDEN_CELL_WIDTH / 2,
    y: GARDEN_FIELD_Y + row * GARDEN_CELL_HEIGHT + GARDEN_CELL_HEIGHT / 2,
  };
}

export function createGardenProfile(partial: Partial<GardenProfile> = {}): GardenProfile {
  const prefersReducedMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const completedStages = Array.isArray(partial.completedStages) ? partial.completedStages.filter((id) => typeof id === 'string') : [];
  const highestStage = completedStages.reduce((max, id) => Math.max(max, getGardenStage(id).number), 0) + 1;
  const unlocked = new Set<GardenPlantId>([
    ...gardenUnlockedPlantsForStage(highestStage),
    ...(Array.isArray(partial.unlockedPlants) ? partial.unlockedPlants : []),
  ]);
  return {
    version: GARDEN_DEFENSE_VERSION,
    rank: Math.max(1, Math.floor(partial.rank || 1)),
    experience: Math.max(0, Math.floor(partial.experience || 0)),
    leafTokens: Math.max(0, Math.floor(partial.leafTokens ?? 4)),
    completedStages,
    unlockedPlants: [...unlocked],
    discoveredZombies: Array.isArray(partial.discoveredZombies) ? [...new Set(partial.discoveredZombies)] : ['drifter'],
    plantUpgrades: { ...(partial.plantUpgrades || {}) },
    bestEndlessWave: Math.max(0, Math.floor(partial.bestEndlessWave || 0)),
    totalVictories: Math.max(0, Math.floor(partial.totalVictories || 0)),
    totalDefeated: Math.max(0, Math.floor(partial.totalDefeated || 0)),
    soundEnabled: partial.soundEnabled !== false,
    reducedMotion: typeof partial.reducedMotion === 'boolean' ? partial.reducedMotion : prefersReducedMotion,
  };
}

export function createGardenRun(options: GardenCreateRunOptions = {}): GardenRunState {
  const stage = getGardenStage(options.stageId);
  const seed = (Number.isFinite(options.seed) ? Number(options.seed) : Date.now()) >>> 0;
  return {
    version: GARDEN_DEFENSE_VERSION,
    runId: `garden-${stage.id}-${seed}`,
    stageId: stage.id,
    status: 'ready',
    seed,
    rngState: seed || 1,
    elapsedMs: 0,
    sun: stage.startingSun,
    lives: 1,
    wave: 1,
    totalWaves: stage.totalWaves,
    waveSize: stageWaveSize(stage, 1),
    spawnedThisWave: 0,
    defeatedThisWave: 0,
    nextSpawnInMs: 2600,
    waveBreakMs: 0,
    worldSunInMs: 5200,
    cooldowns: {},
    plants: [],
    zombies: [],
    projectiles: [],
    suns: [],
    mowers: Array.from({ length: GARDEN_ROWS }, (_, row) => ({ row, active: true })),
    events: [],
    effects: [],
    stats: {
      planted: 0,
      defeated: 0,
      sunCollected: 0,
      sunSpent: 0,
      damageDealt: 0,
      plantsLost: 0,
      mowersUsed: 0,
      bossesDefeated: 0,
    },
    sequence: 0,
  };
}

export function startGardenRun(state: GardenRunState): GardenRunState {
  if (state.status !== 'ready' && state.status !== 'paused') return state;
  const next = cloneRun(state);
  next.status = state.status === 'paused' ? (state.statusBeforePause || 'running') : 'running';
  next.statusBeforePause = undefined;
  pushEvent(next, { tone: 'success', title: state.status === 'paused' ? '继续防守' : '庭院防线启动', detail: `第 ${next.wave} 波正在接近` });
  return next;
}

export function pauseGardenRun(state: GardenRunState): GardenRunState {
  if (state.status !== 'running') return state;
  const next = cloneRun(state);
  next.statusBeforePause = state.status;
  next.status = 'paused';
  return next;
}

export function placeGardenPlant(
  state: GardenRunState,
  plantId: GardenPlantId,
  row: number,
  column: number,
  profile: GardenProfile,
): GardenCommandResult {
  if (!['ready', 'running', 'paused'].includes(state.status)) return { state, changed: false, error: '本局已经结束' };
  if (row < 0 || row >= GARDEN_ROWS || column < 0 || column >= GARDEN_COLUMNS) return { state, changed: false, error: '请选择草坪格子' };
  if (!profile.unlockedPlants.includes(plantId)) return { state, changed: false, error: '该植物尚未解锁' };
  if (state.plants.some((plant) => plant.row === row && plant.column === column)) return { state, changed: false, error: '这里已经有植物了' };
  const definition = GARDEN_PLANTS[plantId];
  const stats = getGardenPlantStats(plantId, profile);
  if ((state.cooldowns[plantId] || 0) > 0) return { state, changed: false, error: `${definition.name} 还在准备` };
  if (state.sun < stats.cost) return { state, changed: false, error: `还需要 ${stats.cost - state.sun} 点阳光` };
  const next = cloneRun(state);
  const center = cellCenter(column, row);
  next.sun -= stats.cost;
  next.stats.sunSpent += stats.cost;
  next.stats.planted += 1;
  next.cooldowns[plantId] = definition.cooldownMs;
  next.plants.push({
    id: nextId(next, 'plant'),
    plantId,
    row,
    column,
    x: center.x,
    y: center.y,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    actionInMs: Math.min(1000, Math.max(250, stats.actionIntervalMs * 0.35)),
    level: Math.max(0, Math.min(5, profile.plantUpgrades[plantId] || 0)),
  });
  pushEvent(next, { tone: 'info', title: `部署 ${definition.name}`, detail: `第 ${row + 1} 行 · 第 ${column + 1} 列` });
  return { state: next, changed: true };
}

export function removeGardenPlant(state: GardenRunState, row: number, column: number): GardenCommandResult {
  const index = state.plants.findIndex((plant) => plant.row === row && plant.column === column);
  if (index < 0) return { state, changed: false, error: '这里没有植物' };
  const next = cloneRun(state);
  const [plant] = next.plants.splice(index, 1);
  const refund = Math.round(GARDEN_PLANTS[plant.plantId].cost * 0.2);
  next.sun += refund;
  pushEvent(next, { tone: 'sun', title: '植物已移栽', detail: `返还 ${refund} 阳光` });
  return { state: next, changed: true };
}

export function collectGardenSun(state: GardenRunState, sunId: string): GardenCommandResult {
  const index = state.suns.findIndex((sun) => sun.id === sunId);
  if (index < 0) return { state, changed: false };
  const next = cloneRun(state);
  const [sun] = next.suns.splice(index, 1);
  next.sun += sun.value;
  next.stats.sunCollected += sun.value;
  pushEffect(next, {
    kind: 'sun-collected',
    x: sun.x,
    y: sun.y,
    row: Math.max(0, Math.min(GARDEN_ROWS - 1, Math.floor((sun.y - GARDEN_FIELD_Y) / GARDEN_CELL_HEIGHT))),
    entityId: sun.id,
    value: sun.value,
    intensity: sun.source === 'reward' ? 1.25 : 1,
  });
  return { state: next, changed: true };
}

function spawnSun(state: GardenRunState, value: number, source: GardenSunEntity['source'], x?: number, y?: number) {
  state.suns.push({
    id: nextId(state, 'sun'),
    x: x ?? GARDEN_FIELD_X + 80 + random(state) * (GARDEN_FIELD_WIDTH - 160),
    y: y ?? GARDEN_FIELD_Y + 40 + random(state) * (GARDEN_FIELD_HEIGHT - 80),
    value,
    ageMs: 0,
    source,
  });
}

function weightedZombie(state: GardenRunState, stage: GardenStageDefinition): GardenZombieId {
  const isFinalSpawn = state.wave >= state.totalWaves && state.spawnedThisWave === state.waveSize - 1;
  if (isFinalSpawn && state.wave >= 7) return 'compost-titan';
  const pool = gardenZombiePoolForWave(Math.max(state.wave, Math.ceil(stage.number / 2)), false);
  const roll = random(state);
  const index = Math.min(pool.length - 1, Math.floor(Math.pow(roll, 1.45) * pool.length));
  return pool[index] || 'drifter';
}

function spawnZombie(state: GardenRunState, stage: GardenStageDefinition) {
  const zombieId = weightedZombie(state, stage);
  const definition = GARDEN_ZOMBIES[zombieId];
  const row = Math.min(GARDEN_ROWS - 1, Math.floor(random(state) * GARDEN_ROWS));
  const stageScale = 1 + Math.max(0, stage.difficulty - 1) * 0.12 + Math.max(0, state.wave - 1) * 0.025;
  const maxHp = Math.round(definition.maxHp * stageScale);
  state.zombies.push({
    id: nextId(state, 'zombie'),
    zombieId,
    row,
    x: ZOMBIE_SPAWN_X + random(state) * 54,
    y: cellCenter(0, row).y,
    hp: maxHp,
    maxHp,
    attackInMs: definition.attackIntervalMs,
    abilityInMs: definition.boss ? 3600 : zombieId === 'moth-conductor' ? 4400 : 0,
    slowMultiplier: 1,
    slowRemainingMs: 0,
    tunneled: zombieId === 'mole-miner',
  });
  state.spawnedThisWave += 1;
  if (definition.boss) pushEvent(state, { tone: 'boss', title: `${definition.name} 苏醒`, detail: '首领会震击整行防线' });
}

function anyZombieAhead(state: GardenRunState, plant: GardenPlantEntity) {
  return state.zombies.some((zombie) => zombie.row === plant.row && zombie.x > plant.x && zombie.hp > 0);
}

function fireProjectile(state: GardenRunState, plant: GardenPlantEntity, kind: GardenProjectileEntity['kind'], damage: number, speed: number) {
  const id = nextId(state, 'shot');
  state.projectiles.push({
    id,
    kind,
    row: plant.row,
    x: plant.x + 28,
    y: plant.y - 8,
    speed,
    damage,
    slowMultiplier: kind === 'frost' ? 0.52 : undefined,
    splashRadius: kind === 'ember' ? 86 + plant.level * 9 : undefined,
  });
  pushEffect(state, {
    kind: 'projectile-fired',
    x: plant.x + 28,
    y: plant.y - 8,
    row: plant.row,
    entityId: id,
    variant: kind,
    intensity: Math.max(0.7, Math.min(1.5, damage / 80)),
  });
}

function damageZombie(state: GardenRunState, zombie: GardenZombieEntity, damage: number) {
  let effective = damage;
  if (zombie.zombieId === 'gatekeeper' && zombie.hp > zombie.maxHp * 0.42) effective *= 0.58;
  if (zombie.zombieId === 'mole-miner' && zombie.tunneled) effective *= 0.15;
  zombie.hp -= effective;
  state.stats.damageDealt += Math.max(0, Math.round(effective));
}

function actPlant(state: GardenRunState, plant: GardenPlantEntity, profile: GardenProfile) {
  const definition = GARDEN_PLANTS[plant.plantId];
  const stats = getGardenPlantStats(plant.plantId, profile);
  if (plant.plantId === 'sun-bloom') {
    spawnSun(state, 25 + plant.level * 3, 'plant', plant.x + 4, plant.y - 34);
  } else if (plant.plantId === 'pea-scout' && anyZombieAhead(state, plant)) {
    fireProjectile(state, plant, 'seed', stats.damage, definition.projectileSpeed || 320);
  } else if (plant.plantId === 'frost-bulb' && anyZombieAhead(state, plant)) {
    fireProjectile(state, plant, 'frost', stats.damage, definition.projectileSpeed || 285);
  } else if (plant.plantId === 'ember-melon' && anyZombieAhead(state, plant)) {
    fireProjectile(state, plant, 'ember', stats.damage, definition.projectileSpeed || 235);
  } else if (plant.plantId === 'storm-reed') {
    const targets = state.zombies
      .filter((zombie) => Math.abs(zombie.row - plant.row) <= 1 && zombie.x > plant.x && zombie.hp > 0)
      .sort((a, b) => a.x - b.x)
      .slice(0, 2 + Math.floor(plant.level / 2));
    targets.forEach((target, index) => damageZombie(state, target, stats.damage * Math.max(0.55, 1 - index * 0.18)));
    if (targets[0]) {
      pushEffect(state, {
        kind: 'chain-hit',
        x: targets[0].x,
        y: targets[0].y,
        row: targets[0].row,
        entityId: targets[0].id,
        value: targets.length,
        intensity: 1 + Math.min(0.45, targets.length * 0.12),
      });
    }
  } else if (plant.plantId === 'healer-clover') {
    const allies = state.plants
      .filter((ally) => Math.abs(ally.row - plant.row) <= 1 && Math.abs(ally.column - plant.column) <= 2 && ally.hp < ally.maxHp)
      .sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)
      .slice(0, 2 + Math.floor(plant.level / 2));
    allies.forEach((ally) => { ally.hp = Math.min(ally.maxHp, ally.hp + 90 + plant.level * 24); });
    if (plant.level >= 2) spawnSun(state, 10, 'plant', plant.x, plant.y - 28);
  } else if (plant.plantId === 'chrono-mushroom') {
    const targets = state.zombies.filter((zombie) => zombie.row === plant.row && zombie.x > plant.x);
    targets.forEach((zombie) => {
      damageZombie(state, zombie, stats.damage);
      zombie.slowMultiplier = Math.min(zombie.slowMultiplier, 0.38);
      zombie.slowRemainingMs = Math.max(zombie.slowRemainingMs, 2600 + plant.level * 260);
    });
    if (targets[0]) {
      pushEffect(state, {
        kind: 'chrono-hit',
        x: plant.x + 64,
        y: plant.y,
        row: plant.row,
        entityId: plant.id,
        value: targets.length,
        intensity: 1 + Math.min(0.5, targets.length * 0.08),
      });
    }
  }
  plant.actionInMs += Math.max(420, stats.actionIntervalMs || 10000);
}

function updatePlants(state: GardenRunState, dt: number, profile: GardenProfile) {
  for (const plant of state.plants) {
    if (plant.plantId === 'wall-root' && plant.level >= 3) plant.hp = Math.min(plant.maxHp, plant.hp + dt * 0.004);
    if (GARDEN_PLANTS[plant.plantId].actionIntervalMs <= 0) continue;
    plant.actionInMs -= dt;
    if (plant.actionInMs <= 0) actPlant(state, plant, profile);
  }
}

function updateProjectiles(state: GardenRunState, dt: number) {
  for (const projectile of state.projectiles) {
    projectile.x += projectile.speed * dt / 1000;
    const target = state.zombies
      .filter((zombie) => zombie.row === projectile.row && zombie.hp > 0 && zombie.x >= projectile.x - 34 && zombie.x <= projectile.x + 48)
      .sort((a, b) => a.x - b.x)[0];
    if (!target) continue;
    if (projectile.splashRadius) {
      state.zombies.filter((zombie) => zombie.hp > 0 && Math.abs(zombie.x - target.x) <= projectile.splashRadius! && Math.abs(zombie.row - target.row) <= 1).forEach((zombie) => {
        damageZombie(state, zombie, zombie.id === target.id ? projectile.damage : projectile.damage * 0.58);
      });
    } else {
      damageZombie(state, target, projectile.damage);
    }
    if (projectile.slowMultiplier) {
      target.slowMultiplier = Math.min(target.slowMultiplier, projectile.slowMultiplier);
      target.slowRemainingMs = Math.max(target.slowRemainingMs, 3200);
    }
    pushEffect(state, {
      kind: 'projectile-hit',
      x: target.x,
      y: target.y,
      row: target.row,
      entityId: target.id,
      variant: projectile.kind,
      value: Math.round(projectile.damage),
      intensity: projectile.splashRadius ? 1.35 : 1,
    });
    projectile.x = Number.POSITIVE_INFINITY;
  }
  state.projectiles = state.projectiles.filter((projectile) => Number.isFinite(projectile.x) && projectile.x < ZOMBIE_SPAWN_X + 120);
}

function zombieSpecialAbility(state: GardenRunState, zombie: GardenZombieEntity) {
  if (zombie.zombieId === 'moth-conductor') {
    state.zombies.filter((ally) => ally.id !== zombie.id && Math.abs(ally.row - zombie.row) <= 1 && Math.abs(ally.x - zombie.x) < 240).forEach((ally) => {
      ally.hp = Math.min(ally.maxHp, ally.hp + 90);
    });
    zombie.abilityInMs += 5200;
  } else if (zombie.zombieId === 'compost-titan') {
    const targets = state.plants.filter((plant) => plant.row === zombie.row);
    targets.forEach((plant) => { plant.hp -= 115; });
    pushEffect(state, {
      kind: 'boss-strike',
      x: zombie.x,
      y: zombie.y,
      row: zombie.row,
      entityId: zombie.id,
      value: targets.length,
      intensity: 1.5,
    });
    zombie.abilityInMs += 6200;
    pushEvent(state, { tone: 'danger', title: '古树震击', detail: `第 ${zombie.row + 1} 行防线受到冲击` });
  }
}

function updateZombies(state: GardenRunState, dt: number) {
  for (const zombie of state.zombies) {
    const definition = GARDEN_ZOMBIES[zombie.zombieId];
    if (zombie.slowRemainingMs > 0) {
      zombie.slowRemainingMs -= dt;
      if (zombie.slowRemainingMs <= 0) zombie.slowMultiplier = 1;
    }
    if (zombie.zombieId === 'mole-miner' && zombie.tunneled && zombie.x < GARDEN_FIELD_X + GARDEN_FIELD_WIDTH * 0.58) zombie.tunneled = false;
    if (zombie.abilityInMs > 0) {
      zombie.abilityInMs -= dt;
      if (zombie.abilityInMs <= 0) zombieSpecialAbility(state, zombie);
    }
    const target = state.plants
      .filter((plant) => plant.row === zombie.row && plant.hp > 0 && plant.x <= zombie.x + 12 && zombie.x - plant.x < 60)
      .sort((a, b) => b.x - a.x)[0];
    if (target) {
      zombie.attackInMs -= dt;
      if (zombie.attackInMs <= 0) {
        target.hp -= definition.damage;
        pushEffect(state, {
          kind: 'zombie-bite',
          x: target.x,
          y: target.y,
          row: target.row,
          entityId: target.id,
          value: Math.round(definition.damage),
          intensity: definition.boss ? 1.4 : 1,
        });
        zombie.attackInMs += definition.attackIntervalMs;
      }
      continue;
    }
    let speed = definition.speed * zombie.slowMultiplier;
    if (zombie.zombieId === 'sprinter' && zombie.hp < zombie.maxHp * 0.5) speed *= 1.55;
    zombie.x -= speed * dt / 1000;
  }
  const lostPlants = state.plants.filter((plant) => plant.hp <= 0);
  if (lostPlants.length > 0) state.stats.plantsLost += lostPlants.length;
  state.plants = state.plants.filter((plant) => plant.hp > 0);
}

function resolveDefeated(state: GardenRunState, profile: GardenProfile) {
  const defeated = state.zombies.filter((zombie) => zombie.hp <= 0);
  if (defeated.length === 0) return;
  defeated.forEach((zombie) => {
    const definition = GARDEN_ZOMBIES[zombie.zombieId];
    state.stats.defeated += 1;
    state.defeatedThisWave += 1;
    if (definition.boss) {
      state.stats.bossesDefeated += 1;
      pushEvent(state, { tone: 'boss', title: `${definition.name} 被击退`, detail: '庭院恢复了片刻宁静' });
    }
    if (random(state) < 0.16 || definition.boss) {
      spawnSun(state, definition.rewardSun, 'reward', zombie.x, zombie.y - 28);
    }
  });
  state.zombies = state.zombies.filter((zombie) => zombie.hp > 0);
}

function resolveHouseBreaches(state: GardenRunState) {
  const breached = state.zombies.filter((zombie) => zombie.x <= HOUSE_X);
  for (const zombie of breached) {
    const mower = state.mowers.find((item) => item.row === zombie.row);
    if (mower?.active) {
      mower.active = false;
      mower.triggeredAt = state.elapsedMs;
      state.stats.mowersUsed += 1;
      state.zombies.filter((item) => item.row === zombie.row).forEach((item) => { item.hp = 0; });
      pushEffect(state, {
        kind: 'mower-hit',
        x: HOUSE_X + 34,
        y: zombie.y,
        row: zombie.row,
        entityId: zombie.id,
        intensity: 1.5,
      });
      pushEvent(state, { tone: 'danger', title: `第 ${zombie.row + 1} 行清道器启动`, detail: '本行最后保险已消耗' });
    } else {
      state.lives -= 1;
      zombie.hp = 0;
      if (state.lives <= 0) {
        state.status = 'lost';
        pushEvent(state, { tone: 'danger', title: '温室失守', detail: `坚持到第 ${state.wave} 波` });
      }
    }
  }
}

function updateWave(state: GardenRunState, dt: number, stage: GardenStageDefinition) {
  if (state.waveBreakMs > 0) {
    state.waveBreakMs -= dt;
    if (state.waveBreakMs <= 0) {
      state.wave += 1;
      state.waveSize = stageWaveSize(stage, state.wave);
      state.spawnedThisWave = 0;
      state.defeatedThisWave = 0;
      state.nextSpawnInMs = 1800;
      pushEvent(state, { tone: 'info', title: `第 ${state.wave} 波`, detail: '新的入侵队列已经出现' });
    }
    return;
  }
  if (state.spawnedThisWave < state.waveSize) {
    state.nextSpawnInMs -= dt;
    if (state.nextSpawnInMs <= 0) {
      spawnZombie(state, stage);
      const pressure = Math.max(720, 2500 - state.wave * 90 - stage.difficulty * 120);
      state.nextSpawnInMs += pressure * (0.72 + random(state) * 0.58);
    }
  }
  if (state.spawnedThisWave >= state.waveSize && state.zombies.length === 0) {
    if (!stage.endless && state.wave >= state.totalWaves) {
      state.status = 'won';
      pushEvent(state, { tone: 'success', title: '庭院防守成功', detail: `${state.stats.defeated} 名入侵者被击退` });
    } else {
      state.waveBreakMs = 4200;
      spawnSun(state, 50, 'reward', GARDEN_FIELD_X + GARDEN_FIELD_WIDTH / 2, GARDEN_FIELD_Y + 44);
    }
  }
}

function stepMutable(state: GardenRunState, dt: number, profile: GardenProfile) {
  const stage = getGardenStage(state.stageId);
  state.elapsedMs += dt;
  state.effects = state.effects.filter((effect) => state.elapsedMs - effect.at <= EFFECT_LIFETIME_MS);
  Object.keys(state.cooldowns).forEach((key) => {
    const plantId = key as GardenPlantId;
    state.cooldowns[plantId] = Math.max(0, (state.cooldowns[plantId] || 0) - dt);
  });
  state.suns.forEach((sun) => { sun.ageMs += dt; });
  state.suns = state.suns.filter((sun) => sun.ageMs < SUN_LIFETIME_MS);
  state.worldSunInMs -= dt;
  if (state.worldSunInMs <= 0) {
    spawnSun(state, 25, 'sky');
    state.worldSunInMs += stage.night ? 10500 : 7600;
  }
  updateWave(state, dt, stage);
  updatePlants(state, dt, profile);
  updateProjectiles(state, dt);
  updateZombies(state, dt);
  resolveHouseBreaches(state);
  resolveDefeated(state, profile);
}

export function stepGardenRun(state: GardenRunState, deltaMs: number, profile: GardenProfile): GardenRunState {
  if (state.status !== 'running') return state;
  const next = cloneRun(state);
  let remaining = Math.max(0, Math.min(1000, Number.isFinite(deltaMs) ? deltaMs : 0));
  while (remaining > 0 && next.status === 'running') {
    const dt = Math.min(MAX_STEP_MS, remaining);
    stepMutable(next, dt, profile);
    remaining -= dt;
  }
  return next;
}

export function applyGardenVictory(profile: GardenProfile, run: GardenRunState): GardenProfile {
  if (run.status !== 'won') return profile;
  const stage = getGardenStage(run.stageId);
  const completed = new Set(profile.completedStages);
  const firstClear = !completed.has(stage.id);
  completed.add(stage.id);
  const experience = profile.experience + stage.rewardXp;
  const rank = Math.max(profile.rank, 1 + Math.floor(experience / 500));
  const nextStageNumber = Math.min(GARDEN_STAGES.length, stage.number + 1);
  return createGardenProfile({
    ...profile,
    rank,
    experience,
    leafTokens: profile.leafTokens + stage.rewardLeaves + (firstClear ? 1 : 0),
    completedStages: [...completed],
    unlockedPlants: [...new Set([...profile.unlockedPlants, ...gardenUnlockedPlantsForStage(nextStageNumber)])],
    discoveredZombies: [...new Set([...profile.discoveredZombies])],
    bestEndlessWave: stage.endless ? Math.max(profile.bestEndlessWave, run.wave) : profile.bestEndlessWave,
    totalVictories: profile.totalVictories + 1,
    totalDefeated: profile.totalDefeated + run.stats.defeated,
  });
}

export function upgradeGardenPlant(profile: GardenProfile, plantId: GardenPlantId) {
  if (!profile.unlockedPlants.includes(plantId)) return { profile, changed: false, error: '植物尚未解锁' };
  const level = Math.max(0, Math.floor(profile.plantUpgrades[plantId] || 0));
  if (level >= 5) return { profile, changed: false, error: '已经升到满级' };
  const cost = gardenUpgradeCost(plantId, level);
  if (profile.leafTokens < cost) return { profile, changed: false, error: `还需要 ${cost - profile.leafTokens} 枚叶章` };
  return {
    profile: createGardenProfile({
      ...profile,
      leafTokens: profile.leafTokens - cost,
      plantUpgrades: { ...profile.plantUpgrades, [plantId]: level + 1 },
    }),
    changed: true,
  };
}

export function gardenWaveProgress(state: GardenRunState) {
  if (state.waveBreakMs > 0) return 1;
  if (state.waveSize <= 0) return 0;
  return Math.max(0, Math.min(1, (state.defeatedThisWave + state.spawnedThisWave * 0.25) / (state.waveSize * 1.25)));
}

export function gardenCellFromPoint(x: number, y: number) {
  const column = Math.floor((x - GARDEN_FIELD_X) / GARDEN_CELL_WIDTH);
  const row = Math.floor((y - GARDEN_FIELD_Y) / GARDEN_CELL_HEIGHT);
  if (row < 0 || row >= GARDEN_ROWS || column < 0 || column >= GARDEN_COLUMNS) return null;
  return { row, column };
}
