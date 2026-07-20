import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGardenVictory,
  collectGardenSun,
  createGardenProfile,
  createGardenRun,
  gardenCellFromPoint,
  placeGardenPlant,
  startGardenRun,
  stepGardenRun,
  upgradeGardenPlant,
} from '../src/features/garden-defense/engine.ts';
import { GARDEN_PLANTS, GARDEN_STAGES, getGardenPlantStats } from '../src/features/garden-defense/catalog.ts';
import { GARDEN_FIELD_X, GARDEN_FIELD_Y } from '../src/features/garden-defense/types.ts';

test('garden defense catalog exposes campaign, new plants, and new zombies through deterministic state', () => {
  const profile = createGardenProfile();
  const run = createGardenRun({ stageId: 'garden-01', seed: 42, profile });
  assert.equal(GARDEN_STAGES.length, 15);
  assert.equal(Object.keys(GARDEN_PLANTS).length, 8);
  assert.equal(run.status, 'ready');
  assert.equal(run.wave, 1);
  assert.equal(run.mowers.length, 5);
  assert.deepEqual(profile.unlockedPlants, ['sun-bloom', 'pea-scout']);
});

test('placing plants spends sun, enforces occupancy and cooldown, and supports the shovel refund', () => {
  const profile = createGardenProfile();
  const run = createGardenRun({ seed: 7 });
  const first = placeGardenPlant(run, 'pea-scout', 1, 2, profile);
  assert.equal(first.changed, true);
  assert.equal(first.state.sun, run.sun - GARDEN_PLANTS['pea-scout'].cost);
  assert.equal(first.state.plants[0].row, 1);
  assert.equal(placeGardenPlant(first.state, 'sun-bloom', 1, 2, profile).changed, false);
  assert.match(placeGardenPlant(first.state, 'pea-scout', 2, 2, profile).error || '', /准备/);
});

test('sun plants create collectible sun and collection updates economy stats', () => {
  const profile = createGardenProfile();
  let run = createGardenRun({ seed: 9 });
  run = placeGardenPlant(run, 'sun-bloom', 2, 1, profile).state;
  run = startGardenRun(run);
  run = stepGardenRun(run, 12000, profile);
  assert.ok(run.suns.some((sun) => sun.source === 'plant'));
  const sun = run.suns.find((item) => item.source === 'plant')!;
  const before = run.sun;
  const collected = collectGardenSun(run, sun.id);
  assert.equal(collected.state.sun, before + sun.value);
  assert.equal(collected.state.stats.sunCollected, sun.value);
  assert.equal(collected.state.effects.at(-1)?.kind, 'sun-collected');
  assert.equal(collected.state.effects.at(-1)?.entityId, sun.id);
  assert.equal(collectGardenSun(collected.state, sun.id).changed, false);
});

test('fixed-step simulation is deterministic for a seed and profile', () => {
  const profile = createGardenProfile();
  const build = () => {
    let run = createGardenRun({ seed: 123 });
    run = placeGardenPlant(run, 'pea-scout', 0, 0, profile).state;
    run = startGardenRun(run);
    for (let i = 0; i < 240; i += 1) run = stepGardenRun(run, 50, profile);
    return run;
  };
  const left = build();
  const right = build();
  assert.deepEqual(left, right);
  assert.ok(left.spawnedThisWave > 0);
});

test('plant upgrades consume leaf tokens and improve combat stats', () => {
  const base = createGardenProfile({ leafTokens: 50 });
  const before = getGardenPlantStats('pea-scout', base);
  const result = upgradeGardenPlant(base, 'pea-scout');
  assert.equal(result.changed, true);
  const after = getGardenPlantStats('pea-scout', result.profile);
  assert.ok(after.damage > before.damage);
  assert.ok(after.actionIntervalMs < before.actionIntervalMs);
  assert.ok(result.profile.leafTokens < base.leafTokens);
});

test('victory rewards campaign progress and unlocks the next plant tier', () => {
  const profile = createGardenProfile();
  const run = { ...createGardenRun({ stageId: 'garden-01', seed: 2 }), status: 'won' as const };
  const next = applyGardenVictory(profile, run);
  assert.ok(next.completedStages.includes('garden-01'));
  assert.ok(next.unlockedPlants.includes('frost-bulb'));
  assert.ok(next.leafTokens > profile.leafTokens);
});

test('world coordinates map to the five by nine planting grid', () => {
  assert.deepEqual(gardenCellFromPoint(GARDEN_FIELD_X + 4, GARDEN_FIELD_Y + 4), { row: 0, column: 0 });
  assert.equal(gardenCellFromPoint(GARDEN_FIELD_X - 1, GARDEN_FIELD_Y + 4), null);
});

test('frost projectiles damage and slow an enemy in the same lane', () => {
  const profile = createGardenProfile({ completedStages: ['garden-01'] });
  let run = createGardenRun({ seed: 77 });
  run = placeGardenPlant(run, 'frost-bulb', 0, 0, profile).state;
  const frost = { ...run.plants[0], actionInMs: 0 };
  run = {
    ...run,
    status: 'running',
    plants: [frost],
    nextSpawnInMs: 999999,
    worldSunInMs: 999999,
    zombies: [{
      id: 'frost-target', zombieId: 'pothead', row: 0, x: frost.x + 64, y: frost.y,
      hp: 520, maxHp: 520, attackInMs: 1000, abilityInMs: 0, slowMultiplier: 1, slowRemainingMs: 0,
    }],
  };

  const next = stepGardenRun(run, 100, profile);
  assert.equal(next.zombies.length, 1);
  assert.ok(next.zombies[0].hp < 520);
  assert.equal(next.zombies[0].slowMultiplier, 0.52);
  assert.ok(next.zombies[0].slowRemainingMs > 3000);
  assert.ok(next.effects.some((effect) => effect.kind === 'projectile-fired' && effect.variant === 'frost'));
  assert.ok(next.effects.some((effect) => effect.kind === 'projectile-hit' && effect.variant === 'frost'));
});

test('direct combat abilities emit transient feedback for chain, bite, and boss attacks', () => {
  const stormProfile = createGardenProfile({ completedStages: ['garden-05'] });
  let chainRun = { ...createGardenRun({ seed: 91 }), sun: 999 };
  chainRun = placeGardenPlant(chainRun, 'storm-reed', 1, 1, stormProfile).state;
  const storm = { ...chainRun.plants[0], actionInMs: 0 };
  chainRun = {
    ...chainRun,
    status: 'running',
    plants: [storm],
    nextSpawnInMs: 999999,
    worldSunInMs: 999999,
    zombies: [{
      id: 'chain-target', zombieId: 'pothead', row: 1, x: storm.x + 90, y: storm.y,
      hp: 520, maxHp: 520, attackInMs: 1000, abilityInMs: 0, slowMultiplier: 1, slowRemainingMs: 0,
    }],
  };
  chainRun = stepGardenRun(chainRun, 100, stormProfile);
  assert.ok(chainRun.effects.some((effect) => effect.kind === 'chain-hit'));

  const biteProfile = createGardenProfile();
  let biteRun = { ...createGardenRun({ seed: 92 }), sun: 999 };
  biteRun = placeGardenPlant(biteRun, 'pea-scout', 0, 0, biteProfile).state;
  const bitePlant = { ...biteRun.plants[0], actionInMs: 999999 };
  biteRun = {
    ...biteRun,
    status: 'running',
    plants: [bitePlant],
    nextSpawnInMs: 999999,
    worldSunInMs: 999999,
    zombies: [{
      id: 'bite-zombie', zombieId: 'drifter', row: 0, x: bitePlant.x + 40, y: bitePlant.y,
      hp: 220, maxHp: 220, attackInMs: 0, abilityInMs: 0, slowMultiplier: 1, slowRemainingMs: 0,
    }],
  };
  biteRun = stepGardenRun(biteRun, 100, biteProfile);
  assert.ok(biteRun.effects.some((effect) => effect.kind === 'zombie-bite' && effect.entityId === bitePlant.id));

  const bossRun = stepGardenRun({
    ...createGardenRun({ seed: 93 }),
    status: 'running',
    nextSpawnInMs: 999999,
    worldSunInMs: 999999,
    zombies: [{
      id: 'boss-zombie', zombieId: 'compost-titan', row: 2, x: GARDEN_FIELD_X + 440, y: GARDEN_FIELD_Y + 220,
      hp: 4200, maxHp: 4200, attackInMs: 1000, abilityInMs: 1, slowMultiplier: 1, slowRemainingMs: 0,
    }],
  }, 100, biteProfile);
  assert.ok(bossRun.effects.some((effect) => effect.kind === 'boss-strike'));
});

test('combat feedback is a short-lived presentation queue', () => {
  const profile = createGardenProfile();
  const run = {
    ...createGardenRun({ seed: 94 }),
    status: 'running' as const,
    elapsedMs: 4000,
    nextSpawnInMs: 999999,
    worldSunInMs: 999999,
    effects: [{
      id: 'old-effect', at: 0, kind: 'projectile-hit' as const, x: 400, y: 300, row: 1, variant: 'seed' as const,
    }],
  };
  const next = stepGardenRun(run, 100, profile);
  assert.equal(next.effects.some((effect) => effect.id === 'old-effect'), false);
});

test('a mower clears its lane once and a second breach loses the run', () => {
  const profile = createGardenProfile();
  const breach = (id: string) => ({
    id, zombieId: 'drifter' as const, row: 0, x: GARDEN_FIELD_X - 50, y: GARDEN_FIELD_Y + 40,
    hp: 220, maxHp: 220, attackInMs: 1000, abilityInMs: 0, slowMultiplier: 1, slowRemainingMs: 0,
  });
  let run = {
    ...createGardenRun({ seed: 88 }),
    status: 'running' as const,
    nextSpawnInMs: 999999,
    worldSunInMs: 999999,
    zombies: [breach('first-breach')],
  };

  run = stepGardenRun(run, 100, profile);
  assert.equal(run.status, 'running');
  assert.equal(run.mowers[0].active, false);
  assert.equal(run.stats.mowersUsed, 1);
  assert.equal(run.zombies.length, 0);
  assert.ok(run.effects.some((effect) => effect.kind === 'mower-hit'));

  run = stepGardenRun({ ...run, zombies: [breach('second-breach')] }, 100, profile);
  assert.equal(run.status, 'lost');
  assert.equal(run.lives, 0);
});
