import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const originalAssertMatch = assert.match.bind(assert);
function makeSourceContractWildcardLazy(source: string) {
  const token = '[\\s\\S]*';
  let cursor = 0;
  let output = '';
  while (true) {
    const index = source.indexOf(token, cursor);
    if (index < 0) return output + source.slice(cursor);
    output += source.slice(cursor, index) + token;
    cursor = index + token.length;
    if (source[cursor] !== '?') output += '?';
  }
}

// Source-contract assertions only require ordered fragments to exist. Greedy
// whole-file wildcards become prohibitively expensive as Canvas.tsx grows, so
// make those wildcards lazy without changing the accepted ordering contract.
Object.defineProperty(assert, 'match', {
  configurable: true,
  value(actual: string, expected: RegExp, message?: string) {
    const optimized = expected.source.includes('[\\s\\S]*')
      ? new RegExp(makeSourceContractWildcardLazy(expected.source), expected.flags)
      : expected;
    return originalAssertMatch(actual, optimized, message);
  },
});
import {
  BASE_FARM_DAILY_WATER,
  FARM_ANIMAL_DEFINITIONS,
  FARM_ANIMAL_PRODUCT_DEFINITIONS,
  FARM_BUILDING_DEFINITIONS,
  FARM_CROP_DEFINITIONS,
  FARM_DEFAULT_DECOR_ID,
  FARM_DECOR_DEFINITIONS,
  FARM_FESTIVAL_ORDER_GOLD_MULTIPLIER,
  FARM_FESTIVAL_TASK_ORDER_TARGET,
  FARM_GRID_SIZE,
  FARM_RARE_EVENT_DEFINITIONS,
  FARM_SCARECROW_RADIUS_CELLS,
  FARM_SEASON_DAYS,
  FARM_SEASON_DEFINITIONS,
  FARM_STARTER_DECOR_IDS,
  FARM_STORAGE_BONUS_PER_BUILDING,
  FARM_WATER_PER_WELL,
  MAX_FARM_ANIMALS,
  MAX_FARM_EVENT_LOG,
  MAX_FARM_OBJECTS,
  advanceFarmDay,
  applyFarmTool,
  buildFarmActivityDigest,
  buildFarmActivityFeed,
  buildFarmBeautyRewards,
  buildFarmBeautyScore,
  buildFarmLongTermGoals,
  buildFarmMiniMapMarkers,
  farmMiniMapMarkerMatchesRouteTarget,
  countFarmScarecrowUnprotectedDryCrops,
  buildFarmFocusGoals,
  canCompleteFarmNpcVisit,
  canCompleteFarmOrder,
  completeFarmNpcVisit,
  completeFarmOrder,
  createFarmNpcVisitForDay,
  createFarmRareHarvestEvent,
  createFarmState,
  farmDecorIdForResourceObjectType,
  farmBuildingActivationHint,
  farmDecorActivationHint,
  farmSeasonForDay,
  farmSeasonLabel,
  farmSeasonProgress,
  farmSeasonShortLabel,
  farmToolActionGridKey,
  farmToolSupportsContinuousAction,
  farmWeatherForDay,
  farmWeatherLabel,
  farmWeatherShortLabel,
  formatAnimalProductTotals,
  getActiveFarmFestivalTask,
  getActiveFarmNpcVisit,
  getFarmBuildingEffects,
  getFarmObjectsInViewport,
  isFarmDecorUnlocked,
  placeFarmObject,
  previewFarmPlacement,
  sanitizeFarmCanvasState,
  snapFarmPoint,
} from '../src/utils/farmCanvas.ts';

const require = createRequire(import.meta.url);

function growTurnips(count = 3) {
  let state = createFarmState();
  for (let i = 0; i < count; i += 1) {
    state = applyFarmTool(state, { tool: 'hoe', x: i * FARM_GRID_SIZE, y: 0, id: `plot-${i}` }).state;
    state = applyFarmTool(state, { tool: 'seed', x: i * FARM_GRID_SIZE, y: 0, cropId: 'turnip' }).state;
    state = applyFarmTool(state, { tool: 'water', x: i * FARM_GRID_SIZE, y: 0 }).state;
  }
  state = advanceFarmDay(state);
  for (let i = 0; i < count; i += 1) {
    state = applyFarmTool(state, { tool: 'water', x: i * FARM_GRID_SIZE, y: 0 }).state;
  }
  state = advanceFarmDay(state);
  for (let i = 0; i < count; i += 1) {
    state = applyFarmTool(state, { tool: 'harvest', x: i * FARM_GRID_SIZE, y: 0 }).state;
  }
  return state;
}

test('farm canvas state starts as a sparse flow-coordinate pasture', () => {
  const state = createFarmState();

  assert.equal(state.version, 1);
  assert.equal(state.coordinateMode, 'flow');
  assert.equal(state.gridSize, FARM_GRID_SIZE);
  assert.equal(state.day, 1);
  assert.equal(state.weather, 'sunny');
  assert.equal(state.season, 'spring');
  assert.equal(state.festivalId, undefined);
  assert.equal(state.festivalTasks.length, 0);
  assert.equal(state.npcVisits.length, 1);
  assert.equal(state.npcVisits[0].id, 'npc-visit-1-mira');
  assert.equal(getActiveFarmNpcVisit(state)?.visitorName, '米拉');
  assert.equal(farmWeatherForDay(5), 'rainy');
  assert.equal(farmWeatherForDay(7), 'festival');
  assert.equal(farmWeatherLabel('festival'), '节庆');
  assert.equal(farmWeatherShortLabel('rainy'), '雨');
  assert.equal(FARM_SEASON_DAYS, 28);
  assert.equal(FARM_SEASON_DEFINITIONS.spring.themeLabel, '春日播种');
  assert.equal(farmSeasonForDay(1), 'spring');
  assert.equal(farmSeasonForDay(29), 'summer');
  assert.equal(farmSeasonForDay(57), 'autumn');
  assert.equal(farmSeasonForDay(85), 'winter');
  assert.equal(farmSeasonForDay(113), 'spring');
  assert.equal(farmSeasonLabel('winter'), '冬季');
  assert.equal(farmSeasonShortLabel('summer'), '夏');
  assert.deepEqual(farmSeasonProgress(29), {
    season: 'summer',
    dayInSeason: 1,
    daysTotal: 28,
    nextSeason: 'autumn',
    percent: 4,
  });
  assert.equal(FARM_FESTIVAL_TASK_ORDER_TARGET, 1);
  assert.equal(state.resources.gold, 300);
  assert.equal(state.resources.seeds.turnip, 12);
  assert.equal(state.objects.length, 0);
  assert.equal(state.animals.length, 1);
  assert.equal(state.animals[0].kind, 'chicken');
  assert.equal(state.inventory.animalProducts.egg, undefined);
  assert.equal(FARM_ANIMAL_DEFINITIONS.chicken.productLabel, '鸡蛋');
  assert.equal(FARM_ANIMAL_PRODUCT_DEFINITIONS.milk.label, '牛奶');
  assert.equal(state.orders[0].id, 'tutorial-turnip-order');
  assert.equal(state.rareEvents.length, 0);
  assert.equal(state.eventLog.length, 0);
  assert.equal(state.lastDailySummary, undefined);
  assert.equal(state.stats.rareEventsFound, 0);
  assert.equal(state.stats.buildingsPlaced, 0);
  assert.equal(state.stats.decorPlaced, 0);
  assert.equal(state.selectedBuildingId, 'hut');
  assert.equal(state.selectedDecorId, FARM_DEFAULT_DECOR_ID);
  assert.equal(state.selectedObjectId, undefined);
  assert.ok(FARM_STARTER_DECOR_IDS.includes(FARM_DEFAULT_DECOR_ID));
  assert.deepEqual(snapFarmPoint({ x: 95, y: -95 }), { x: 64, y: -128 });
  assert.deepEqual(snapFarmPoint({ x: 127, y: 127 }), { x: 64, y: 64 });
});

test('farm tools support tilling, planting, watering, advancing days, harvesting, and completing an order', () => {
  let state = growTurnips(3);

  assert.equal(state.day, 3);
  assert.equal(state.inventory.crops.turnip, 3);
  assert.equal(state.stats.plotsTilled, 3);
  assert.equal(state.stats.cropsPlanted, 3);
  assert.equal(state.stats.cropsWatered, 6);
  assert.equal(state.stats.cropsHarvested, 3);
  assert.equal(state.npcVisits.some((visit) => visit.day === 3 && visit.visitorId === 'taro'), true);
  assert.ok(state.discoveredCropIds.includes('turnip'));
  assert.equal(state.eventLog[0].kind, 'crop_harvested');
  assert.ok(state.eventLog.some((event) => event.kind === 'plot_tilled'));
  assert.ok(state.eventLog.some((event) => event.kind === 'day_advanced'));
  assert.ok(state.eventLog.every((event) => !Object.prototype.hasOwnProperty.call(event, 'x')));
  assert.equal(state.lastDailySummary?.fromDay, 2);
  assert.equal(state.lastDailySummary?.toDay, 3);
  assert.equal(state.lastDailySummary?.newMatureCrops, 3);
  assert.equal(state.lastDailySummary?.matureCrops, 3);
  assert.match(state.lastDailySummary?.message || '', /成熟/);

  const result = completeFarmOrder(state, 'tutorial-turnip-order');
  state = result.state;

  assert.equal(result.changed, true);
  assert.equal(result.error, undefined);
  assert.equal(state.inventory.crops.turnip || 0, 0);
  assert.equal(state.resources.gold, 420);
  assert.equal(state.resources.wood, 12);
  assert.equal(state.resources.experience, 30);
  assert.equal(state.stats.ordersCompleted, 1);
  assert.ok(state.unlockedDecorIds.includes('wood-fence'));
  assert.equal(isFarmDecorUnlocked(state, 'wood-fence'), true);
  assert.equal(state.eventLog[0].kind, 'order_completed');
  assert.equal(state.eventLog[0].orderId, 'tutorial-turnip-order');
  assert.equal(state.eventLog[0].amount, 120);
});

test('farm weather waters crops on rainy days and festivals add order gold bonuses', () => {
  let rainyState = createFarmState({ day: 5, weather: 'rainy' });
  rainyState = applyFarmTool(rainyState, { tool: 'hoe', x: 0, y: 0, id: 'rain-plot' }).state;
  rainyState = applyFarmTool(rainyState, { tool: 'seed', x: 0, y: 0, cropId: 'turnip' }).state;

  const rainyNext = advanceFarmDay(rainyState);
  const rainPlot = rainyNext.objects.find((object) => object.id === 'rain-plot');
  assert.equal(rainPlot?.crop?.daysGrown, 1);
  assert.equal(rainPlot?.crop?.dryDays, 0);
  assert.equal(rainyNext.day, 6);
  assert.equal(rainyNext.weather, farmWeatherForDay(6));
  assert.equal(rainyNext.festivalId, undefined);
  assert.equal(rainyNext.lastDailySummary?.weather, 'rainy');
  assert.equal(rainyNext.lastDailySummary?.rainWateredCrops, 1);
  assert.match(rainyNext.lastDailySummary?.message || '', /雨水/);

  const baseGold = 120;
  const festivalBonus = Math.round(baseGold * (FARM_FESTIVAL_ORDER_GOLD_MULTIPLIER - 1));
  let festivalState = sanitizeFarmCanvasState({
    ...growTurnips(3),
    day: 7,
    weather: 'festival',
    festivalId: 'spring-sowing-7',
  });
  const activeTask = getActiveFarmFestivalTask(festivalState);
  assert.equal(activeTask?.title, '春播祭委托');
  assert.equal(activeTask?.kind, 'complete-orders');
  assert.equal(activeTask?.progress, 0);
  assert.equal(activeTask?.target, FARM_FESTIVAL_TASK_ORDER_TARGET);

  const result = completeFarmOrder(festivalState, 'tutorial-turnip-order');
  festivalState = result.state;
  const completedTask = getActiveFarmFestivalTask(festivalState);

  assert.equal(result.changed, true);
  assert.match(result.feedback, /节庆/);
  assert.match(result.feedback, /委托完成/);
  assert.equal(festivalState.resources.gold, 300 + baseGold + festivalBonus);
  assert.equal(festivalState.resources.wood, 15);
  assert.equal(festivalState.resources.experience, 54);
  assert.equal(festivalState.resources.seeds.sunflower, 2);
  assert.equal(completedTask?.completed, true);
  assert.equal(completedTask?.progress, FARM_FESTIVAL_TASK_ORDER_TARGET);
  assert.equal(completedTask?.completedDay, 7);
  assert.equal(festivalState.eventLog[0].amount, baseGold + festivalBonus);
  assert.equal(festivalState.eventLog[0].kind, 'order_completed');

  const festivalNext = advanceFarmDay(festivalState);
  assert.equal(festivalNext.lastDailySummary?.weather, 'festival');
  assert.equal(festivalNext.lastDailySummary?.festivalId, 'spring-sowing-7');
  assert.equal(festivalNext.lastDailySummary?.goldEarned, baseGold + festivalBonus);
  assert.equal(festivalNext.lastDailySummary?.festivalBonusGold, festivalBonus);
  assert.ok(festivalNext.lastDailySummary?.highlights.some((item) => item.includes('节庆订单加成')));
  assert.ok(festivalNext.lastDailySummary?.highlights.some((item) => item.includes('节庆委托完成')));
});

test('farm season kit rotates every 28 days and adds seasonal feedback', () => {
  const day29State = createFarmState({ day: 29 });
  assert.equal(day29State.season, 'summer');
  assert.equal(day29State.weather, farmWeatherForDay(29, 'summer'));

  let state = createFarmState({ day: 28, season: 'spring', weather: farmWeatherForDay(28, 'spring') });
  state = advanceFarmDay(state);

  assert.equal(state.day, 29);
  assert.equal(state.season, 'summer');
  assert.equal(state.weather, farmWeatherForDay(29, 'summer'));
  assert.equal(state.lastDailySummary?.fromDay, 28);
  assert.equal(state.lastDailySummary?.toDay, 29);
  assert.match(state.lastDailySummary?.message || '', /夏季开始了/);
  assert.ok(state.lastDailySummary?.highlights.some((item) => item.includes('换季到夏季')));

  assert.equal(advanceFarmDay(createFarmState({ day: 56, season: 'summer' })).season, 'autumn');
  assert.equal(advanceFarmDay(createFarmState({ day: 84, season: 'autumn' })).season, 'winter');
  assert.equal(advanceFarmDay(createFarmState({ day: 112, season: 'winter' })).season, 'spring');
});

test('farm focus goals recommend the next playable action', () => {
  let state = createFarmState();
  let goals = buildFarmFocusGoals(state, { maxGoals: 3 });

  assert.equal(goals[0].id, 'starter-till');
  assert.equal(goals[0].kind, 'growth');
  assert.deepEqual(goals[0].action, { kind: 'select-tool', tool: 'hoe' });
  assert.equal(goals.some((goal) => goal.id === 'build-board'), true);

  state = applyFarmTool(state, { tool: 'hoe', x: 0, y: 0, id: 'focus-plot' }).state;
  goals = buildFarmFocusGoals(state, { maxGoals: 2 });
  assert.equal(goals[0].id, 'seed-empty-plots');
  assert.deepEqual(goals[0].action, { kind: 'select-tool', tool: 'seed' });

  state = applyFarmTool(state, { tool: 'seed', x: 0, y: 0, cropId: 'turnip' }).state;
  goals = buildFarmFocusGoals(state, { maxGoals: 2 });
  assert.equal(goals[0].id, 'water-today');
  assert.equal(goals[0].kind, 'urgent');
  assert.deepEqual(goals[0].action, { kind: 'select-tool', tool: 'water' });

  let matureState = createFarmState();
  for (let i = 0; i < 3; i += 1) {
    matureState = applyFarmTool(matureState, { tool: 'hoe', x: i * FARM_GRID_SIZE, y: 0, id: `focus-mature-${i}` }).state;
    matureState = applyFarmTool(matureState, { tool: 'seed', x: i * FARM_GRID_SIZE, y: 0, cropId: 'turnip' }).state;
    matureState = applyFarmTool(matureState, { tool: 'water', x: i * FARM_GRID_SIZE, y: 0 }).state;
  }
  matureState = advanceFarmDay(matureState);
  for (let i = 0; i < 3; i += 1) {
    matureState = applyFarmTool(matureState, { tool: 'water', x: i * FARM_GRID_SIZE, y: 0 }).state;
  }
  matureState = advanceFarmDay(matureState);
  goals = buildFarmFocusGoals(matureState, { maxGoals: 2 });
  assert.equal(goals[0].id, 'harvest-ready');
  assert.deepEqual(goals[0].action, { kind: 'jump-mature' });
  assert.equal(goals[0].ready, true);

  const orderGoals = buildFarmFocusGoals(growTurnips(3), { maxGoals: 2 });
  assert.equal(orderGoals[0].id, 'order-tutorial-turnip-order');
  assert.deepEqual(orderGoals[0].action, { kind: 'complete-order', orderId: 'tutorial-turnip-order' });

  const npcState = createFarmState({ inventory: { crops: { turnip: 1 }, animalProducts: {}, decorIds: [] } });
  const npcGoals = buildFarmFocusGoals(npcState, { maxGoals: 2 });
  assert.equal(npcGoals[0].id, 'npc-npc-visit-1-mira');
  assert.equal(npcGoals[0].kind, 'social');
  assert.deepEqual(npcGoals[0].action, { kind: 'complete-npc', visitId: 'npc-visit-1-mira' });

  const scarecrowRiskState = createFarmState({
    resources: { gold: 90, wood: 8, stone: 6, water: 0, seeds: { turnip: 0 } },
    stats: { plotsTilled: 3, cropsPlanted: 1, cropsWatered: 0, cropsHarvested: 0, ordersCompleted: 0, npcVisitsCompleted: 0, rareEventsFound: 0, objectsPlaced: 0, buildingsPlaced: 0, decorPlaced: 0, daysAdvanced: 0 },
    objects: [
      {
        id: 'focus-dry-risk',
        kind: 'plot',
        x: 0,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 1, wateredToday: false, dryDays: 1, stage: 'seed' },
        createdDay: 1,
      },
      {
        id: 'focus-dry-risk-watered',
        kind: 'plot',
        x: FARM_GRID_SIZE,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 1, wateredToday: true, dryDays: 1, stage: 'seed' },
        createdDay: 1,
      },
    ],
  });
  const scarecrowGoals = buildFarmFocusGoals(scarecrowRiskState, { maxGoals: 4 });
  const scarecrowGoal = scarecrowGoals.find((goal) => goal.id === 'build-scarecrow-protection');
  assert.ok(scarecrowGoal);
  assert.equal(scarecrowGoal.kind, 'build');
  assert.match(scarecrowGoal.title, /稻草人/);
  assert.match(scarecrowGoal.detail, /1 块缺水作物/);
  assert.deepEqual(scarecrowGoal.action, { kind: 'select-building', buildingId: 'scarecrow' });
});

test('farm animals produce daily goods and report them in summaries', () => {
  const state = createFarmState({
    animals: [
      { id: 'hen-1', kind: 'chicken', name: '小啾', mood: 'calm', placedDay: 1, productCount: 0 },
      { id: 'cow-1', kind: 'cow', name: '奶泡', mood: 'calm', placedDay: 1, productCount: 0 },
      { id: 'sheep-1', kind: 'sheep', name: '云朵', mood: 'calm', placedDay: 1, productCount: 0 },
    ],
    inventory: {
      crops: {},
      animalProducts: { egg: 2 },
      decorIds: [],
    },
  });

  const next = advanceFarmDay(state);
  assert.equal(next.inventory.animalProducts.egg, 3);
  assert.equal(next.inventory.animalProducts.milk, 1);
  assert.equal(next.inventory.animalProducts.wool, 1);
  assert.equal(formatAnimalProductTotals(next.inventory.animalProducts), '鸡蛋 x3 / 牛奶 x1 / 羊毛 x1');
  assert.equal(next.animals[0].lastProducedDay, 1);
  assert.equal(next.animals[1].lastProducedDay, 1);
  assert.equal(next.animals[2].productCount, 1);
  assert.equal(next.animals.every((animal) => animal.mood === 'happy'), true);
  assert.equal(next.lastDailySummary?.animalProductsProduced, 3);
  assert.equal(next.lastDailySummary?.animalProductSummary, '鸡蛋 x1 / 牛奶 x1 / 羊毛 x1');
  assert.ok(next.lastDailySummary?.highlights.some((item) => item.includes('动物产出')));
  assert.match(next.lastDailySummary?.message || '', /动物小屋|第 2 天/);
});

test('farm npc visits rotate daily, consume requested goods, and report completion', () => {
  let cropState = createFarmState({
    inventory: {
      crops: { turnip: 1 },
      animalProducts: {},
      decorIds: [],
    },
  });
  const cropVisit = getActiveFarmNpcVisit(cropState);
  assert.equal(cropVisit?.id, createFarmNpcVisitForDay(1).id);
  assert.equal(cropVisit?.visitorId, 'mira');
  assert.equal(cropVisit?.requestKind, 'crop');
  assert.equal(cropVisit?.cropId, 'turnip');
  assert.equal(canCompleteFarmNpcVisit(cropState, cropVisit?.id || ''), true);

  const cropResult = completeFarmNpcVisit(cropState, cropVisit?.id || '');
  cropState = cropResult.state;
  assert.equal(cropResult.changed, true);
  assert.equal(cropResult.error, undefined);
  assert.equal(cropState.inventory.crops.turnip || 0, 0);
  assert.equal(cropState.resources.gold, 336);
  assert.equal(cropState.resources.experience, 8);
  assert.equal(cropState.resources.seeds.potato, 1);
  assert.equal(cropState.stats.npcVisitsCompleted, 1);
  assert.equal(cropState.npcVisits[0].completed, true);
  assert.equal(cropState.npcVisits[0].completedDay, 1);
  assert.equal(cropState.eventLog[0].kind, 'npc_request_completed');
  assert.equal(cropState.eventLog[0].npcVisitId, cropVisit?.id);
  assert.equal(canCompleteFarmNpcVisit(cropState, cropVisit?.id || ''), false);

  const summarized = advanceFarmDay(cropState);
  assert.equal(summarized.lastDailySummary?.npcVisitsCompleted, 1);
  assert.ok(summarized.lastDailySummary?.highlights.some((item) => item.includes('来访委托')));
  assert.match(summarized.lastDailySummary?.message || '', /村民来访/);
  assert.equal(getActiveFarmNpcVisit(summarized)?.day, 2);

  const animalVisit = createFarmNpcVisitForDay(3);
  let animalState = createFarmState({
    day: 3,
    inventory: {
      crops: {},
      animalProducts: { egg: 1 },
      decorIds: [],
    },
  });
  assert.equal(animalVisit.visitorId, 'taro');
  assert.equal(getActiveFarmNpcVisit(animalState)?.animalProductId, 'egg');
  const animalResult = completeFarmNpcVisit(animalState, animalVisit.id);
  animalState = animalResult.state;
  assert.equal(animalResult.changed, true);
  assert.equal(animalState.inventory.animalProducts.egg || 0, 0);
  assert.equal(animalState.resources.gold, 348);
  assert.equal(animalState.resources.wood, 10);
  assert.equal(animalState.resources.experience, 10);
  assert.equal(animalState.eventLog[0].npcVisitId, animalVisit.id);
});

test('farm minimap markers summarize mature crops, dry crops, buildings, paths, and ready orders', () => {
  const state = createFarmState({
    resources: { gold: 999, wood: 999, stone: 999, water: 12, experience: 0, seeds: { turnip: 12 } },
    inventory: { crops: { turnip: 3 }, decorIds: [] },
    objects: [
      {
        id: 'plot-mature',
        kind: 'plot',
        x: -FARM_GRID_SIZE,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 2, wateredToday: false, dryDays: 0, stage: 'seed' },
        createdDay: 1,
      },
      {
        id: 'plot-dry',
        kind: 'plot',
        x: 0,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 1, wateredToday: false, dryDays: 1, stage: 'seed' },
        createdDay: 1,
      },
      {
        id: 'plot-withered',
        kind: 'plot',
        x: FARM_GRID_SIZE,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 1, wateredToday: false, dryDays: 3, stage: 'withered' },
        createdDay: 1,
      },
      { id: 'board', kind: 'building', buildingId: 'board', x: FARM_GRID_SIZE * 2, y: 0, widthCells: 2, heightCells: 1, createdDay: 1 },
      { id: 'hut', kind: 'building', buildingId: 'hut', x: FARM_GRID_SIZE * 5, y: 0, widthCells: 3, heightCells: 3, createdDay: 1 },
      { id: 'path', kind: 'decor', decorId: 'stone-path', x: FARM_GRID_SIZE * 9, y: 0, widthCells: 1, heightCells: 1, createdDay: 1 },
      { id: 'tile', kind: 'decor', decorId: 'resource-tile', objectType: 'tile', x: FARM_GRID_SIZE * 10, y: 0, widthCells: 1, heightCells: 1, createdDay: 1 },
    ],
  });

  assert.equal(canCompleteFarmOrder(state, 'tutorial-turnip-order'), true);

  const markers = buildFarmMiniMapMarkers(state);
  const kinds = markers.map((marker) => marker.kind);
  assert.deepEqual(kinds.slice(0, 3), ['order', 'npc', 'mature']);
  assert.ok(kinds.includes('building'));
  assert.ok(kinds.includes('animal'));
  assert.ok(kinds.includes('path'));
  assert.ok(kinds.includes('withered'));
  assert.equal(markers.find((marker) => marker.kind === 'order')?.objectId, 'board');
  assert.equal(markers.find((marker) => marker.kind === 'npc')?.npcVisitId, 'npc-visit-1-mira');
  assert.equal(markers.find((marker) => marker.kind === 'npc')?.visitorId, 'mira');
  assert.equal(markers.find((marker) => marker.kind === 'animal')?.animalId, 'starter-chicken');
  assert.equal(markers.find((marker) => marker.kind === 'order')?.orderId, 'tutorial-turnip-order');
  assert.match(markers.find((marker) => marker.kind === 'mature')?.label || '', /成熟/);
  assert.match(markers.find((marker) => marker.kind === 'dry')?.label || '', /待浇水/);
  assert.match(markers.find((marker) => marker.kind === 'withered')?.label || '', /枯萎/);
  assert.equal(markers.find((marker) => marker.kind === 'mature')?.routeTargets?.includes('mature-crop'), true);
  assert.equal(markers.find((marker) => marker.kind === 'dry')?.routeTargets?.includes('water'), true);
  assert.equal(markers.find((marker) => marker.kind === 'withered')?.routeTargets?.includes('withered-crop'), true);
  assert.equal(markers.find((marker) => marker.kind === 'order')?.routeTargets?.includes('ready-order'), true);
  assert.equal(markers.find((marker) => marker.kind === 'npc')?.routeTargets?.includes('ready-npc'), true);
  assert.equal(markers.find((marker) => marker.objectId === 'hut')?.routeTargets?.includes('day'), true);
  assert.equal(markers.find((marker) => marker.objectId === 'path')?.routeTargets?.includes('beauty'), true);
  assert.equal(farmMiniMapMarkerMatchesRouteTarget(markers.find((marker) => marker.kind === 'mature'), 'mature-crop'), true);
  assert.equal(farmMiniMapMarkerMatchesRouteTarget(markers.find((marker) => marker.kind === 'dry'), 'water'), true);
  assert.equal(farmMiniMapMarkerMatchesRouteTarget(markers.find((marker) => marker.kind === 'withered'), 'withered-crop'), true);
  assert.equal(farmMiniMapMarkerMatchesRouteTarget(markers.find((marker) => marker.kind === 'order'), 'ready-order'), true);
  assert.equal(farmMiniMapMarkerMatchesRouteTarget(markers.find((marker) => marker.kind === 'npc'), 'ready-npc'), true);
  assert.equal(farmMiniMapMarkerMatchesRouteTarget(markers.find((marker) => marker.objectId === 'hut'), 'day'), true);

  const limited = buildFarmMiniMapMarkers(state, { maxMarkers: 3 });
  assert.deepEqual(limited.map((marker) => marker.kind), ['order', 'npc', 'mature']);

  const denseObjects = [
    {
      id: 'dense-mature',
      kind: 'plot',
      x: -FARM_GRID_SIZE * 2,
      y: 0,
      widthCells: 1,
      heightCells: 1,
      crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 2, wateredToday: false, dryDays: 0, stage: 'seed' },
      createdDay: 1,
    },
    ...Array.from({ length: 620 }, (_, index) => ({
      id: `dense-path-${index}`,
      kind: 'decor',
      decorId: 'stone-path',
      x: (index % 40) * FARM_GRID_SIZE,
      y: Math.floor(index / 40) * FARM_GRID_SIZE,
      widthCells: 1,
      heightCells: 1,
      createdDay: 1,
    })),
  ];
  const denseState = createFarmState({ objects: denseObjects, animals: [] });
  const denseMarkers = buildFarmMiniMapMarkers(denseState, { maxMarkers: 24 });
  const clusterMarker = denseMarkers.find((marker) => marker.kind === 'cluster');
  assert.ok(denseMarkers.length <= 24);
  assert.ok(denseMarkers.some((marker) => marker.kind === 'mature'));
  assert.ok(clusterMarker);
  assert.ok((clusterMarker.clusterCount || 0) > 1);
  assert.ok(clusterMarker.clusterKinds?.includes('path'));
  assert.ok(clusterMarker.routeTargets?.includes('beauty'));
  assert.equal(farmMiniMapMarkerMatchesRouteTarget(clusterMarker, 'beauty'), true);
  assert.match(clusterMarker.label, /道路标记 x/);

  const completedState = completeFarmOrder(state, 'tutorial-turnip-order').state;
  assert.equal(canCompleteFarmOrder(completedState, 'tutorial-turnip-order'), false);
  assert.equal(buildFarmMiniMapMarkers(completedState).some((marker) => marker.kind === 'order'), false);
});

test('farm rare harvest events reward overgrown crops and surface star markers', () => {
  const state = createFarmState({
    resources: { gold: 300, wood: 8, stone: 6, water: 12, experience: 0, seeds: { turnip: 12 } },
    objects: [
      {
        id: 'giant-plot',
        kind: 'plot',
        x: 0,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 4, wateredToday: false, dryDays: 0, stage: 'mature' },
        createdDay: 1,
      },
      { id: 'board', kind: 'building', buildingId: 'board', x: FARM_GRID_SIZE * 2, y: 0, widthCells: 2, heightCells: 1, createdDay: 1 },
    ],
  });
  const rarePreview = createFarmRareHarvestEvent(state, state.objects[0], state.objects[0].crop);
  assert.equal(rarePreview?.eventId, 'giant-turnip');

  const result = applyFarmTool(state, { tool: 'harvest', x: 0, y: 0 });
  assert.equal(result.changed, true);
  assert.match(result.feedback || '', /巨大萝卜/);
  assert.equal(result.state.inventory.crops.turnip, 1);
  assert.equal(result.state.resources.gold, 300 + FARM_RARE_EVENT_DEFINITIONS['giant-turnip'].rewards.gold);
  assert.equal(result.state.resources.experience, FARM_RARE_EVENT_DEFINITIONS['giant-turnip'].rewards.experience);
  assert.equal(result.state.resources.seeds.turnip, 14);
  assert.equal(result.state.stats.cropsHarvested, 1);
  assert.equal(result.state.stats.rareEventsFound, 1);
  assert.equal(result.state.rareEvents.length, 1);
  assert.equal(result.state.rareEvents[0].eventId, 'giant-turnip');
  assert.equal(result.state.eventLog[0].kind, 'rare_event');
  assert.equal(result.state.eventLog[0].rareEventId, result.state.rareEvents[0].id);
  assert.equal(result.state.eventLog[1].kind, 'crop_harvested');

  const markers = buildFarmMiniMapMarkers(result.state);
  const rareMarker = markers.find((marker) => marker.kind === 'rare');
  assert.equal(rareMarker?.rareEventId, result.state.rareEvents[0].id);
  assert.match(rareMarker?.label || '', /巨大萝卜/);
  assert.equal(rareMarker?.routeTargets?.includes('rare-event'), true);
  assert.equal(farmMiniMapMarkerMatchesRouteTarget(rareMarker, 'rare-event'), true);

  const next = advanceFarmDay(result.state);
  assert.equal(next.lastDailySummary?.rareEventsFound, 1);
  assert.match(next.lastDailySummary?.rareEventSummary || '', /巨大萝卜/);
  assert.ok(next.lastDailySummary?.highlights.some((item) => item.includes('惊喜')));
});

test('farm day advance produces a compact daily summary without storing coordinates', () => {
  let state = createFarmState();
  state = applyFarmTool(state, { tool: 'hoe', x: 0, y: 0, id: 'summary-plot' }).state;
  state = applyFarmTool(state, { tool: 'seed', x: 0, y: 0, cropId: 'turnip' }).state;
  state = applyFarmTool(state, { tool: 'water', x: 0, y: 0 }).state;

  state = advanceFarmDay(state);
  assert.equal(state.lastDailySummary?.fromDay, 1);
  assert.equal(state.lastDailySummary?.toDay, 2);
  assert.equal(state.lastDailySummary?.wateredCrops, 1);
  assert.equal(state.lastDailySummary?.newMatureCrops, 0);
  assert.equal(state.lastDailySummary?.nextMatureCrops, 1);
  assert.equal(state.lastDailySummary?.readyOrders, 0);
  assert.equal(state.lastDailySummary?.readyNpcVisits, 0);
  assert.equal(state.lastDailySummary?.dailyWaterCapacity, BASE_FARM_DAILY_WATER);
  assert.ok(state.lastDailySummary?.highlights.some((item) => item.includes('预计明天 1 块作物可成熟')));
  assert.equal(Object.prototype.hasOwnProperty.call(state.lastDailySummary, 'x'), false);
  assert.equal(state.eventLog[0].message, state.lastDailySummary?.message);

  state = applyFarmTool(state, { tool: 'water', x: 0, y: 0 }).state;
  state = advanceFarmDay(state);
  assert.equal(state.lastDailySummary?.fromDay, 2);
  assert.equal(state.lastDailySummary?.toDay, 3);
  assert.equal(state.lastDailySummary?.newMatureCrops, 1);
  assert.equal(state.lastDailySummary?.matureCrops, 1);
  assert.ok(state.lastDailySummary?.highlights.some((item) => item.includes('成熟')));

  const readyOrderState = advanceFarmDay(createFarmState({
    inventory: { crops: { turnip: 3 } },
    objects: [
      {
        id: 'dry-summary-plot',
        kind: 'plot',
        x: 0,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'potato', plantedDay: 1, daysGrown: 1, wateredToday: false, dryDays: 1, stage: 'seed' },
        createdDay: 1,
      },
      { id: 'summary-board', kind: 'building', buildingId: 'board', x: FARM_GRID_SIZE * 2, y: 0, widthCells: 2, heightCells: 1, createdDay: 1 },
      { id: 'summary-well', kind: 'building', buildingId: 'well', x: FARM_GRID_SIZE * 5, y: 0, widthCells: 2, heightCells: 2, createdDay: 1 },
    ],
  }));
  assert.equal(readyOrderState.lastDailySummary?.readyOrders, 1);
  assert.equal(readyOrderState.lastDailySummary?.dryCrops, 1);
  assert.equal(readyOrderState.lastDailySummary?.dailyWaterCapacity, BASE_FARM_DAILY_WATER + FARM_WATER_PER_WELL);
  assert.ok(readyOrderState.lastDailySummary?.highlights.some((item) => item.includes('今日还有 1 块地缺水')));
  assert.ok(readyOrderState.lastDailySummary?.highlights.some((item) => item.includes('可交付订单 1 个')));
  assert.ok(readyOrderState.lastDailySummary?.highlights.some((item) => item.includes('水井补水')));

  const witheredSummaryState = advanceFarmDay(createFarmState({
    objects: [
      {
        id: 'withered-summary-plot',
        kind: 'plot',
        x: 0,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 4, wateredToday: false, dryDays: 3, stage: 'withered' },
        createdDay: 1,
      },
    ],
  }));
  assert.equal(witheredSummaryState.lastDailySummary?.witheredCrops, 1);
  assert.match(witheredSummaryState.lastDailySummary?.message || '', /枯萎/);
  assert.ok(witheredSummaryState.lastDailySummary?.highlights.some((item) => item.includes('枯萎')));

  const scarecrowSummaryState = advanceFarmDay(createFarmState({
    objects: [
      {
        id: 'scarecrow-protected-plot',
        kind: 'plot',
        x: 0,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 1, wateredToday: false, dryDays: 2, stage: 'seed' },
        createdDay: 1,
      },
      {
        id: 'scarecrow-far-plot',
        kind: 'plot',
        x: FARM_GRID_SIZE * (FARM_SCARECROW_RADIUS_CELLS + 4),
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 1, wateredToday: false, dryDays: 2, stage: 'seed' },
        createdDay: 1,
      },
      {
        id: 'summary-scarecrow',
        kind: 'building',
        buildingId: 'scarecrow',
        x: FARM_GRID_SIZE,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        createdDay: 1,
      },
    ],
  }));
  const protectedPlot = scarecrowSummaryState.objects.find((object) => object.id === 'scarecrow-protected-plot');
  const farPlot = scarecrowSummaryState.objects.find((object) => object.id === 'scarecrow-far-plot');
  assert.equal(protectedPlot?.crop?.dryDays, 2);
  assert.notEqual(protectedPlot?.crop?.stage, 'withered');
  assert.equal(farPlot?.crop?.dryDays, 3);
  assert.equal(farPlot?.crop?.stage, 'withered');
  assert.equal(scarecrowSummaryState.lastDailySummary?.scarecrowProtectedCrops, 1);
  assert.ok(scarecrowSummaryState.lastDailySummary?.highlights.some((item) => item.includes('稻草人守护 1 块地')));
});

test('farm scarecrow risk count only includes unprotected dry crops', () => {
  const state = createFarmState({
    weather: 'sunny',
    objects: [
      {
        id: 'plot-protected',
        kind: 'plot',
        x: 0,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 1, wateredToday: false, dryDays: 1, stage: 'seed' },
        createdDay: 1,
      },
      {
        id: 'plot-risk',
        kind: 'plot',
        x: FARM_GRID_SIZE * 12,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 1, wateredToday: false, dryDays: 2, stage: 'seed' },
        createdDay: 1,
      },
      {
        id: 'plot-watered',
        kind: 'plot',
        x: FARM_GRID_SIZE * 13,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 1, wateredToday: true, dryDays: 2, stage: 'seed' },
        createdDay: 1,
      },
      {
        id: 'plot-withered',
        kind: 'plot',
        x: FARM_GRID_SIZE * 14,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        crop: { cropId: 'turnip', plantedDay: 1, daysGrown: 1, wateredToday: false, dryDays: 4, stage: 'withered' },
        createdDay: 1,
      },
      {
        id: 'scarecrow',
        kind: 'building',
        buildingId: 'scarecrow',
        x: FARM_GRID_SIZE * 2,
        y: 0,
        widthCells: 1,
        heightCells: 2,
        createdDay: 1,
      },
    ],
  });

  assert.equal(countFarmScarecrowUnprotectedDryCrops(state), 1);
  assert.equal(countFarmScarecrowUnprotectedDryCrops({ ...state, weather: 'rainy' }), 0);
});

test('farm activity feed summarizes recent safe feedback for the HUD', () => {
  const state = createFarmState({
    day: 3,
    inventory: { crops: { turnip: 3 } },
    eventLog: [
      {
        id: 'unsafe-rare',
        kind: 'rare_event',
        day: 3,
        message: 'prompt: hidden https://example.com/rare.png data:image/png;base64,abc C:\\Users\\Secret\\rare.png 巨大萝卜',
        amount: 40,
        cropId: 'turnip',
        rareEventId: 'rare-event-3-giant-turnip-plot',
        createdAt: 300004,
      },
      {
        id: 'order',
        kind: 'order_completed',
        day: 3,
        message: '订单完成 +120金',
        amount: 120,
        orderId: 'tutorial-turnip-order',
        createdAt: 300003,
      },
      {
        id: 'water',
        kind: 'crop_watered',
        day: 3,
        message: '已浇水',
        amount: 1,
        cropId: 'turnip',
        createdAt: 300002,
      },
      {
        id: 'old',
        kind: 'plot_tilled',
        day: 2,
        message: '+1 已开垦',
        amount: 1,
        objectKind: 'plot',
        createdAt: 200001,
      },
    ],
  });

  const feed = buildFarmActivityFeed(state, { maxItems: 3 });
  assert.equal(feed.items.length, 3);
  assert.equal(feed.todayTotal, 3);
  assert.equal(feed.todayRewardTotal, 2);
  assert.match(feed.summary, /今日 3 条记录/);
  assert.equal(feed.items[0].kind, 'rare_event');
  assert.equal(feed.items[0].title, '发现惊喜');
  assert.equal(feed.items[0].tagLabel, '星');
  assert.equal(feed.items[0].tone, 'rare');
  assert.equal(feed.items[0].amountLabel, '+40');
  assert.equal(feed.items[0].rewardLabel, '惊喜奖励');
  assert.equal(feed.items[0].detail.includes('example.com'), false);
  assert.equal(feed.items[0].detail.includes('data:image'), false);
  assert.equal(feed.items[0].detail.includes('Secret'), false);
  assert.equal(feed.items[0].detail.includes('prompt:'), false);
  assert.equal(feed.items[1].tone, 'quest');
  assert.equal(feed.items[1].rewardLabel, '订单奖励');
  assert.equal(feed.items[2].tone, 'water');
  assert.equal(feed.items[2].rewardLabel, undefined);

  const digest = buildFarmActivityDigest(state);
  assert.equal(digest.todayTotal, 3);
  assert.equal(digest.todayRewardTotal, 2);
  assert.equal(digest.target, 6);
  assert.equal(digest.percent, 50);
  assert.equal(digest.tone, 'reward');
  assert.match(digest.badgeLabel, /丰收 \+2/);
  assert.equal(digest.rewardStreak, 2);
  assert.equal(digest.rewardStreakLabel, '连击 x2');
  assert.match(digest.rewardStreakHint || '', /连续正反馈 2 次/);
  assert.equal(digest.rewardStreakTier, 'sprout');
  assert.match(digest.rewardStreakMilestoneLabel || '', /再来 1 次正反馈/);
  assert.equal(digest.rewardStreakMilestoneTarget, 3);
  assert.equal(digest.rewardStreakMilestonePercent, 67);
  assert.equal(digest.rewardStreakMilestoneProgressLabel, '2/3');
  assert.equal(digest.rewardStreakMilestoneCompletionLabel, undefined);
  assert.equal(digest.rewardStreakMilestoneRewardLabel, undefined);
  assert.equal(digest.rewardStreakMilestoneRewardItems, undefined);
  assert.equal(digest.rewardStreakActionKind, 'order');
  assert.equal(digest.rewardStreakActionShortLabel, '去交单');
  assert.match(digest.rewardStreakActionLabel || '', /交付订单/);
  assert.deepEqual(digest.rewardStreakAction, { kind: 'complete-order', orderId: 'tutorial-turnip-order' });
  assert.equal(digest.rewardStreakChestState, 'warming');
  assert.equal(digest.rewardStreakChestTier, 'sprout');
  assert.match(digest.rewardStreakChestLabel || '', /丰收宝箱预热/);
  assert.equal(digest.rewardStreakChestShortLabel, '宝箱热');
  assert.equal(digest.rewardStreakChestProgressLabel, '2/3');
  assert.match(digest.rewardStreakChestRewardLabel || '', /丰收连击徽章/);
  assert.equal(digest.rewardStreakChestPercent, 67);
  assert.equal(digest.rewardStreakChestMeterLabel, '宝箱蓄能 2/3');
  assert.equal(digest.rewardStreakChestChargeLabel, '给宝箱蓄能');
  assert.match(digest.rewardStreakChestChargeHint || '', /执行连击建议/);
  assert.match(digest.headline, /今天已有 3 条农活，2 次正反馈/);
  assert.match(digest.nextHint, /再完成 3 次农活/);
  assert.ok(digest.chips.some((chip) => chip.id === 'rare_event' && chip.label === '发现惊喜' && chip.tone === 'rare'));
  assert.ok(digest.chips.some((chip) => chip.id === 'order_completed' && chip.label === '订单完成' && chip.tone === 'quest'));

  const firstRewardDigest = buildFarmActivityDigest(createFarmState({
    day: 4,
    inventory: { crops: {}, animalProducts: {}, decorIds: [] },
    orders: [],
    npcVisits: [],
    eventLog: [
      {
        id: 'first-harvest',
        kind: 'crop_harvested',
        day: 4,
        message: '收获萝卜 +1',
        amount: 1,
        cropId: 'turnip',
        createdAt: 400001,
      },
    ],
  }));
  assert.equal(firstRewardDigest.rewardStreak, 1);
  assert.equal(firstRewardDigest.rewardStreakLabel, '连击苗头');
  assert.match(firstRewardDigest.rewardStreakHint || '', /再来一次/);
  assert.equal(firstRewardDigest.rewardStreakTier, 'sprout');
  assert.equal(firstRewardDigest.rewardStreakMilestoneLabel, '再来 1 次正反馈，开启今日连击。');
  assert.equal(firstRewardDigest.rewardStreakMilestoneTarget, 2);
  assert.equal(firstRewardDigest.rewardStreakMilestonePercent, 50);
  assert.equal(firstRewardDigest.rewardStreakMilestoneProgressLabel, '1/2');
  assert.equal(firstRewardDigest.rewardStreakActionKind, 'harvest');
  assert.equal(firstRewardDigest.rewardStreakActionShortLabel, '再来一次');
  assert.match(firstRewardDigest.rewardStreakActionLabel || '', /开启今日连击/);
  assert.deepEqual(firstRewardDigest.rewardStreakAction, { kind: 'select-decor', decorId: FARM_DEFAULT_DECOR_ID });
  assert.equal(firstRewardDigest.rewardStreakChestState, 'warming');
  assert.equal(firstRewardDigest.rewardStreakChestTier, 'sprout');
  assert.match(firstRewardDigest.rewardStreakChestLabel || '', /连击宝箱萌芽/);
  assert.equal(firstRewardDigest.rewardStreakChestShortLabel, '宝箱芽');
  assert.equal(firstRewardDigest.rewardStreakChestProgressLabel, '1/2');
  assert.match(firstRewardDigest.rewardStreakChestRewardLabel || '', /下一步行动/);
  assert.equal(firstRewardDigest.rewardStreakChestPercent, 50);
  assert.equal(firstRewardDigest.rewardStreakChestMeterLabel, '宝箱蓄能 1/2');
  assert.equal(firstRewardDigest.rewardStreakChestRemaining, 1);
  assert.equal(firstRewardDigest.rewardStreakChestRemainingLabel, '还差 1 次点亮宝箱');
  assert.equal(firstRewardDigest.rewardStreakChestTrailLabel, '宝箱路线：宝箱萌芽 1/2 · 丰收预热 2/3 · 节庆点亮 5/5');
  assert.equal(firstRewardDigest.rewardStreakChestTrailRewardLabel, '路线奖励：连击提示 -> 丰收徽章 -> 节庆三件套');
  assert.deepEqual(firstRewardDigest.rewardStreakChestTrailItems, [
    { tier: 'sprout', label: '宝箱萌芽', progressLabel: '1/2', state: 'active', rewardLabel: '奖励：今日连击提示和下一步行动。', shortRewardLabel: '连击提示' },
    { tier: 'harvest', label: '丰收预热', progressLabel: '2/3', state: 'next', rewardLabel: '奖励：丰收连击徽章和奖励印章苗头。', shortRewardLabel: '丰收徽章' },
    { tier: 'festival', label: '节庆点亮', progressLabel: '5/5', state: 'next', rewardLabel: '奖励：高光手账、订单气氛、美化收益。', shortRewardLabel: '节庆三件套' },
  ]);
  assert.equal(firstRewardDigest.rewardStreakChestActiveTrailLabel, '当前阶段：宝箱萌芽 1/2');
  assert.equal(firstRewardDigest.rewardStreakChestActiveRewardLabel, '当前奖励：连击提示');
  assert.equal(firstRewardDigest.rewardStreakChestActiveHint, '当前冲刺：连击提示，还差 1 次点亮宝箱。');
  assert.equal(firstRewardDigest.rewardStreakChestNextRewardLabel, '下一段：丰收徽章');
  assert.equal(firstRewardDigest.rewardStreakChestChargeLabel, '给宝箱蓄能');
  assert.equal(firstRewardDigest.rewardStreakChestChargeShortLabel, '蓄能');

  const harvestDigest = buildFarmActivityDigest(createFarmState({
    day: 5,
    eventLog: [
      { id: 'reward-2', kind: 'npc_request_completed', day: 5, message: '完成来访', createdAt: 500002 },
      { id: 'reward-1', kind: 'crop_harvested', day: 5, message: '收获萝卜', createdAt: 500001 },
    ],
  }));
  assert.equal(harvestDigest.rewardStreak, 2);
  assert.equal(harvestDigest.rewardStreakChestActiveTrailLabel, '当前阶段：丰收预热 2/3');
  assert.equal(harvestDigest.rewardStreakChestActiveRewardLabel, '当前奖励：丰收徽章');
  assert.equal(harvestDigest.rewardStreakChestActiveHint, '当前冲刺：丰收徽章，还差 1 次点亮宝箱。');
  assert.equal(harvestDigest.rewardStreakChestNextRewardLabel, '下一段：节庆三件套');

  const emptyDigest = buildFarmActivityDigest(createFarmState({ day: 8, eventLog: [] }));
  assert.equal(emptyDigest.todayTotal, 0);
  assert.equal(emptyDigest.percent, 0);
  assert.equal(emptyDigest.rewardStreak, 0);
  assert.equal(emptyDigest.rewardStreakLabel, undefined);
  assert.equal(emptyDigest.rewardStreakHint, undefined);
  assert.equal(emptyDigest.rewardStreakTier, undefined);
  assert.equal(emptyDigest.rewardStreakMilestoneLabel, undefined);
  assert.equal(emptyDigest.rewardStreakMilestoneTarget, undefined);
  assert.equal(emptyDigest.rewardStreakMilestonePercent, undefined);
  assert.equal(emptyDigest.rewardStreakMilestoneProgressLabel, undefined);
  assert.equal(emptyDigest.rewardStreakMilestoneCompletionLabel, undefined);
  assert.equal(emptyDigest.rewardStreakMilestoneRewardLabel, undefined);
  assert.equal(emptyDigest.rewardStreakMilestoneRewardItems, undefined);
  assert.equal(emptyDigest.rewardStreakActionKind, undefined);
  assert.equal(emptyDigest.rewardStreakActionShortLabel, undefined);
  assert.equal(emptyDigest.rewardStreakActionLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestState, undefined);
  assert.equal(emptyDigest.rewardStreakChestTier, undefined);
  assert.equal(emptyDigest.rewardStreakChestLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestShortLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestProgressLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestRewardLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestCtaLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestClaimLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestNextLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestRewardItems, undefined);
  assert.equal(emptyDigest.rewardStreakChestBurstLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestOpenedSummaryLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestPercent, undefined);
  assert.equal(emptyDigest.rewardStreakChestMeterLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestRemaining, undefined);
  assert.equal(emptyDigest.rewardStreakChestRemainingLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestTrailLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestTrailRewardLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestTrailItems, undefined);
  assert.equal(emptyDigest.rewardStreakChestActiveTrailLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestActiveRewardLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestActiveHint, undefined);
  assert.equal(emptyDigest.rewardStreakChestNextRewardLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestChargeLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestChargeShortLabel, undefined);
  assert.equal(emptyDigest.rewardStreakChestChargeHint, undefined);
  assert.equal(emptyDigest.tone, 'quiet');
  assert.match(emptyDigest.nextHint, /成果条会马上点亮/);

  const festivalDigest = buildFarmActivityDigest(createFarmState({
    day: 9,
    eventLog: [
      { id: 'rare-5', kind: 'rare_event', day: 9, message: '发现惊喜', createdAt: 900005 },
      { id: 'npc-4', kind: 'npc_request_completed', day: 9, message: '完成来访委托', createdAt: 900004 },
      { id: 'decor-3', kind: 'decor_placed', day: 9, message: '放置装饰', createdAt: 900003 },
      { id: 'build-2', kind: 'building_placed', day: 9, message: '盖好小屋', createdAt: 900002 },
      { id: 'order-1', kind: 'order_completed', day: 9, message: '订单完成', createdAt: 900001 },
    ],
  }));
  assert.equal(festivalDigest.rewardStreak, 5);
  assert.equal(festivalDigest.rewardStreakTier, 'festival');
  assert.match(festivalDigest.rewardStreakMilestoneLabel || '', /节庆连击已点亮/);
  assert.equal(festivalDigest.rewardStreakMilestoneTarget, 5);
  assert.equal(festivalDigest.rewardStreakMilestonePercent, 100);
  assert.equal(festivalDigest.rewardStreakMilestoneProgressLabel, '5/5');
  assert.match(festivalDigest.rewardStreakMilestoneCompletionLabel || '', /节庆连击奖励已点亮/);
  assert.match(festivalDigest.rewardStreakMilestoneRewardLabel || '', /节庆奖励/);
  assert.match(festivalDigest.rewardStreakMilestoneRewardLabel || '', /高光/);
  assert.deepEqual(festivalDigest.rewardStreakMilestoneRewardItems, ['高光手账', '订单气氛', '美化收益']);
  assert.equal(festivalDigest.rewardStreakActionKind, 'festival');
  assert.equal(festivalDigest.rewardStreakActionShortLabel, '守连击');
  assert.match(festivalDigest.rewardStreakActionLabel || '', /守住节庆连击/);
  assert.deepEqual(festivalDigest.rewardStreakAction, { kind: 'select-decor', decorId: FARM_DEFAULT_DECOR_ID });
  assert.equal(festivalDigest.rewardStreakChestState, 'ready');
  assert.equal(festivalDigest.rewardStreakChestTier, 'festival');
  assert.match(festivalDigest.rewardStreakChestLabel || '', /节庆宝箱已点亮/);
  assert.equal(festivalDigest.rewardStreakChestShortLabel, '宝箱亮');
  assert.equal(festivalDigest.rewardStreakChestProgressLabel, '5/5');
  assert.match(festivalDigest.rewardStreakChestRewardLabel || '', /高光手账/);
  assert.equal(festivalDigest.rewardStreakChestCtaLabel, '开宝箱');
  assert.match(festivalDigest.rewardStreakChestClaimLabel || '', /开箱奖励已入袋/);
  assert.match(festivalDigest.rewardStreakChestClaimLabel || '', /订单气氛/);
  assert.match(festivalDigest.rewardStreakChestNextLabel || '', /下一轮/);
  assert.match(festivalDigest.rewardStreakChestNextLabel || '', /2 次正反馈/);
  assert.deepEqual(festivalDigest.rewardStreakChestRewardItems, ['高光手账', '订单气氛', '美化收益']);
  assert.equal(festivalDigest.rewardStreakChestBurstLabel, '宝箱奖励 +3');
  assert.match(festivalDigest.rewardStreakChestOpenedSummaryLabel || '', /宝箱奖励 \+3/);
  assert.match(festivalDigest.rewardStreakChestOpenedSummaryLabel || '', /美化收益/);
  assert.equal(festivalDigest.rewardStreakChestPercent, 100);
  assert.equal(festivalDigest.rewardStreakChestMeterLabel, '宝箱蓄能 5/5');
  assert.equal(festivalDigest.rewardStreakChestRemaining, 0);
  assert.equal(festivalDigest.rewardStreakChestRemainingLabel, '已可开箱');
  assert.equal(festivalDigest.rewardStreakChestTrailLabel, '宝箱路线：宝箱萌芽 1/2 · 丰收预热 2/3 · 节庆点亮 5/5');
  assert.equal(festivalDigest.rewardStreakChestTrailRewardLabel, '路线奖励：连击提示 -> 丰收徽章 -> 节庆三件套');
  assert.deepEqual(festivalDigest.rewardStreakChestTrailItems, [
    { tier: 'sprout', label: '宝箱萌芽', progressLabel: '1/2', state: 'done', rewardLabel: '奖励：今日连击提示和下一步行动。', shortRewardLabel: '连击提示' },
    { tier: 'harvest', label: '丰收预热', progressLabel: '2/3', state: 'done', rewardLabel: '奖励：丰收连击徽章和奖励印章苗头。', shortRewardLabel: '丰收徽章' },
    { tier: 'festival', label: '节庆点亮', progressLabel: '5/5', state: 'done', rewardLabel: '奖励：高光手账、订单气氛、美化收益。', shortRewardLabel: '节庆三件套' },
  ]);
  assert.equal(festivalDigest.rewardStreakChestActiveTrailLabel, '当前阶段：节庆点亮 5/5');
  assert.equal(festivalDigest.rewardStreakChestActiveRewardLabel, '当前奖励：节庆三件套');
  assert.equal(festivalDigest.rewardStreakChestActiveHint, '当前冲刺：节庆三件套，已可开箱。');
  assert.equal(festivalDigest.rewardStreakChestNextRewardLabel, '下一轮：连击提示');
  assert.equal(festivalDigest.rewardStreakChestChargeLabel, undefined);
  assert.equal(festivalDigest.rewardStreakChestChargeShortLabel, undefined);
});

test('farm tools reject blocked cells, missing seeds, missing water, and early harvests', () => {
  let state = createFarmState({ resources: { gold: 300, wood: 8, stone: 6, water: 0, experience: 0, seeds: { turnip: 0 } } });

  const seedEmpty = applyFarmTool(state, { tool: 'seed', x: 0, y: 0, cropId: 'turnip' });
  assert.equal(seedEmpty.error, 'missing-plot');

  state = applyFarmTool(state, { tool: 'hoe', x: 0, y: 0, id: 'plot-a' }).state;
  assert.equal(applyFarmTool(state, { tool: 'hoe', x: 0, y: 0 }).error, 'already-tilled');
  assert.equal(applyFarmTool(state, { tool: 'seed', x: 0, y: 0, cropId: 'turnip' }).error, 'missing-seed');

  state = createFarmState();
  state = applyFarmTool(state, { tool: 'hoe', x: 0, y: 0, id: 'plot-b' }).state;
  state = applyFarmTool(state, { tool: 'seed', x: 0, y: 0, cropId: 'turnip' }).state;
  assert.equal(applyFarmTool({ ...state, resources: { ...state.resources, water: 0 } }, { tool: 'water', x: 0, y: 0 }).error, 'missing-water');
  assert.equal(applyFarmTool(state, { tool: 'harvest', x: 0, y: 0 }).error, 'not-ready');
});

test('farm continuous actions are limited to drag-safe tools and dedupe by snapped grid cell', () => {
  assert.equal(farmToolSupportsContinuousAction('hoe'), true);
  assert.equal(farmToolSupportsContinuousAction('seed'), true);
  assert.equal(farmToolSupportsContinuousAction('water'), true);
  assert.equal(farmToolSupportsContinuousAction('harvest'), true);
  assert.equal(farmToolSupportsContinuousAction('shovel'), true);
  assert.equal(farmToolSupportsContinuousAction('delete'), true);
  assert.equal(farmToolSupportsContinuousAction('decor'), true);
  assert.equal(farmToolSupportsContinuousAction('build'), false);
  assert.equal(farmToolSupportsContinuousAction('move'), false);
  assert.equal(farmToolSupportsContinuousAction('select'), false);

  const keyA = farmToolActionGridKey({ tool: 'hoe', x: 8, y: 9 }, FARM_GRID_SIZE);
  const keyB = farmToolActionGridKey({ tool: 'hoe', x: 23, y: 27 }, FARM_GRID_SIZE);
  const keyC = farmToolActionGridKey({ tool: 'hoe', x: FARM_GRID_SIZE + 2, y: 27 }, FARM_GRID_SIZE);
  const keyD = farmToolActionGridKey({ tool: 'water', x: 23, y: 27 }, FARM_GRID_SIZE);
  assert.equal(keyA, 'hoe:0:0');
  assert.equal(keyA, keyB);
  assert.notEqual(keyA, keyC);
  assert.notEqual(keyA, keyD);

  let state = createFarmState();
  const seen = new Set<string>();
  [
    { tool: 'hoe' as const, x: 8, y: 9 },
    { tool: 'hoe' as const, x: 23, y: 27 },
    { tool: 'hoe' as const, x: FARM_GRID_SIZE + 2, y: 27 },
  ].forEach((action) => {
    const key = farmToolActionGridKey(action, state.gridSize);
    if (seen.has(key)) return;
    seen.add(key);
    state = applyFarmTool(state, action).state;
  });
  assert.equal(state.objects.length, 2);
  assert.equal(state.stats.plotsTilled, 2);
  assert.deepEqual(state.objects.map((object) => `${object.x}:${object.y}`), ['0:0', '64:0']);
});

test('farm buildings and decorations use grid occupancy and resource costs', () => {
  let state = createFarmState();
  const hut = placeFarmObject(state, { kind: 'building', buildingId: 'hut', x: 12, y: 14, id: 'hut-1' });

  assert.equal(hut.changed, true);
  assert.equal(hut.feedback, '已建造 小屋 · 每日结算已就绪');
  state = hut.state;
  assert.equal(state.objects[0].x, 0);
  assert.equal(state.objects[0].buildingId, 'hut');
  assert.equal(state.objects[0].widthCells, 3);
  assert.equal(state.resources.gold, 120);
  assert.equal(state.resources.wood, 0);
  assert.equal(state.resources.stone, 2);
  assert.equal(state.selectedBuildingId, 'hut');
  assert.equal(state.stats.objectsPlaced, 1);
  assert.equal(state.stats.buildingsPlaced, 1);
  assert.equal(state.stats.decorPlaced, 0);
  assert.equal(state.eventLog[0].kind, 'building_placed');
  assert.equal(state.eventLog[0].objectKind, 'building');
  assert.equal(state.eventLog[0].message, hut.feedback);

  assert.equal(placeFarmObject(state, { kind: 'building', buildingId: 'well', x: FARM_GRID_SIZE, y: FARM_GRID_SIZE }).error, 'insufficient-resources');
  const richBlockedState = {
    ...state,
    resources: { ...state.resources, gold: 999, wood: 999, stone: 999 },
  };
  assert.equal(placeFarmObject(richBlockedState, { kind: 'building', buildingId: 'well', x: FARM_GRID_SIZE, y: FARM_GRID_SIZE }).error, 'blocked');

  const decor = placeFarmObject(createFarmState(), {
    kind: 'decor',
    decorId: 'sign',
    resourceId: 'resource-123',
    skinId: 'poster',
    x: 192,
    y: 0,
  });
  assert.equal(decor.changed, true);
  assert.match(decor.feedback, /已放置 木牌 · 区域标记已立好/);
  assert.equal(decor.state.objects[0].resourceId, 'resource-123');
  assert.equal(decor.state.objects[0].decorId, 'sign');
  assert.equal(decor.state.selectedDecorId, 'sign');
  assert.equal(decor.state.stats.objectsPlaced, 1);
  assert.equal(decor.state.stats.buildingsPlaced, 0);
  assert.equal(decor.state.stats.decorPlaced, 1);
  assert.equal(decor.state.eventLog[0].kind, 'decor_placed');
  assert.equal(decor.state.eventLog[0].objectKind, 'decor');

  const resourceDecorId = farmDecorIdForResourceObjectType('poster-wall');
  const resourceDecor = placeFarmObject(createFarmState(), {
    kind: 'decor',
    decorId: resourceDecorId,
    resourceId: 'resource_abc-123',
    skinId: 'resource-poster-wall',
    objectType: 'poster-wall',
    x: 256,
    y: 128,
  });
  assert.equal(resourceDecor.changed, true);
  assert.match(resourceDecor.feedback, /已放置 资源海报墙 · 资源海报墙已上墙/);
  assert.equal(resourceDecor.state.objects[0].decorId, resourceDecorId);
  assert.equal(resourceDecor.state.objects[0].resourceId, 'resource_abc-123');
  assert.equal(resourceDecor.state.objects[0].skinId, 'resource-poster-wall');
  assert.equal(resourceDecor.state.objects[0].objectType, 'poster-wall');
  assert.equal((resourceDecor.state.objects[0] as any).fileUrl, undefined);
  assert.equal((resourceDecor.state.objects[0] as any).thumbUrl, undefined);
  assert.equal(isFarmDecorUnlocked(createFarmState(), resourceDecorId), true);

  const selectedResourceDecorState = createFarmState({
    selectedTool: 'decor',
    selectedDecorId: farmDecorIdForResourceObjectType('banner'),
    selectedResourceDecor: {
      resourceId: 'resource-banner-1',
      skinId: 'resource-banner',
      objectType: 'banner',
    },
  });
  const selectedResourceDecor = applyFarmTool(selectedResourceDecorState, { tool: 'decor', x: 384, y: 128 });
  assert.equal(selectedResourceDecor.changed, true);
  assert.equal(selectedResourceDecor.state.objects[0].decorId, farmDecorIdForResourceObjectType('banner'));
  assert.equal(selectedResourceDecor.state.objects[0].resourceId, 'resource-banner-1');
  assert.equal(selectedResourceDecor.state.objects[0].objectType, 'banner');

  const selectedState = createFarmState({
    selectedBuildingId: 'storage',
    selectedDecorId: 'lantern',
    resources: { gold: 999, wood: 999, stone: 999, water: 20, experience: 0, seeds: { turnip: 12 } },
  });
  const selectedBuild = applyFarmTool(selectedState, { tool: 'build', x: 320, y: 0 });
  assert.equal(selectedBuild.changed, true);
  assert.match(selectedBuild.feedback, /已建造 仓库 · 库存容量 \+20/);
  assert.equal(FARM_BUILDING_DEFINITIONS.storage.description, '库存容量 +20');
  assert.equal(FARM_BUILDING_DEFINITIONS.well.description, '每日补水 +12');
  assert.equal(farmBuildingActivationHint('well'), `每日补水 +${FARM_WATER_PER_WELL}`);
  assert.equal(farmBuildingActivationHint('scarecrow'), '守护半径 6 格');
  assert.equal(selectedBuild.state.objects[0].buildingId, 'storage');
  assert.equal(selectedBuild.state.objects[0].widthCells, FARM_BUILDING_DEFINITIONS.storage.widthCells);
  assert.equal(selectedBuild.state.selectedBuildingId, 'storage');

  const readyPreview = previewFarmPlacement(selectedState, { tool: 'build', x: 320, y: 0, buildingId: 'storage' });
  assert.equal(readyPreview.canPlace, true);
  assert.equal(readyPreview.status, 'ready');
  assert.equal(readyPreview.reason, undefined);
  assert.equal(readyPreview.widthCells, FARM_BUILDING_DEFINITIONS.storage.widthCells);
  assert.match(readyPreview.feedback, /可建造/);
  assert.equal(readyPreview.effectPreview, farmBuildingActivationHint('storage'));

  const blockedPreview = previewFarmPlacement(selectedBuild.state, { tool: 'decor', x: 320, y: 0, decorId: 'lantern' });
  assert.equal(blockedPreview.canPlace, false);
  assert.equal(blockedPreview.status, 'blocked');
  assert.equal(blockedPreview.reason, 'blocked');
  assert.match(blockedPreview.feedback, /挡住建筑/);
  assert.equal(blockedPreview.effectPreview, farmDecorActivationHint('lantern'));

  const poorPreview = previewFarmPlacement(createFarmState({
    resources: { gold: 0, wood: 0, stone: 0, water: 20, experience: 0, seeds: { turnip: 12 } },
  }), { tool: 'build', x: 0, y: 0, buildingId: 'well' });
  assert.equal(poorPreview.canPlace, false);
  assert.equal(poorPreview.status, 'insufficient-resources');
  assert.equal(poorPreview.reason, 'insufficient-resources');
  assert.equal(poorPreview.missingResources?.gold, FARM_BUILDING_DEFINITIONS.well.cost.gold);
  assert.equal(poorPreview.missingResources?.wood, FARM_BUILDING_DEFINITIONS.well.cost.wood);
  assert.equal(poorPreview.missingResources?.stone, FARM_BUILDING_DEFINITIONS.well.cost.stone);
  assert.match(poorPreview.feedback, /资源不足/);
  assert.equal(poorPreview.effectPreview, farmBuildingActivationHint('well'));

  const selectedDecor = applyFarmTool(selectedBuild.state, { tool: 'decor', x: 640, y: 0 });
  assert.equal(selectedDecor.changed, true);
  assert.match(selectedDecor.feedback, /已放置 路灯 · 夜间地块更醒目/);
  assert.equal(selectedDecor.state.objects[1].decorId, 'lantern');
  assert.equal(selectedDecor.state.selectedDecorId, 'lantern');
  assert.equal(selectedDecor.state.stats.buildingsPlaced, 1);
  assert.equal(selectedDecor.state.stats.decorPlaced, 1);
  assert.equal(FARM_DECOR_DEFINITIONS.lantern.label, '路灯');
  assert.equal(FARM_DECOR_DEFINITIONS.lantern.description, '夜晚高亮地块');
  assert.equal(farmDecorActivationHint('stone-path'), '道路会连成路线');
  assert.equal(farmDecorActivationHint('resource-banner', 'banner'), '资源旗帜已挂起');

  const lockedFencePreview = previewFarmPlacement(createFarmState(), { tool: 'decor', x: 0, y: 320, decorId: 'wood-fence' });
  assert.equal(isFarmDecorUnlocked(createFarmState(), 'wood-fence'), false);
  assert.equal(lockedFencePreview.canPlace, false);
  assert.equal(lockedFencePreview.reason, 'decor-locked');
  assert.match(lockedFencePreview.feedback, /新手萝卜订单/);
  assert.equal(placeFarmObject(createFarmState(), { kind: 'decor', decorId: 'wood-fence', x: 0, y: 320 }).error, 'decor-locked');

  let effectState = createFarmState({
    resources: { gold: 999, wood: 999, stone: 999, water: 2, experience: 0, seeds: { turnip: 12 } },
  });
  const wellPlaced = placeFarmObject(effectState, { kind: 'building', buildingId: 'well', x: 0, y: 256 });
  assert.match(wellPlaced.feedback, /已建造 水井 · 每日补水 \+12/);
  effectState = wellPlaced.state;
  effectState = placeFarmObject(effectState, { kind: 'building', buildingId: 'storage', x: 192, y: 256 }).state;
  const boardPlaced = placeFarmObject(effectState, { kind: 'building', buildingId: 'board', x: 448, y: 256 });
  assert.match(boardPlaced.feedback, /已建造 公告板 · 可交付订单优先显示/);
  effectState = boardPlaced.state;
  effectState = placeFarmObject(effectState, { kind: 'building', buildingId: 'scarecrow', x: 640, y: 256 }).state;
  const effects = getFarmBuildingEffects(effectState);
  assert.equal(effects.wells, 1);
  assert.equal(effects.storages, 1);
  assert.equal(effects.boards, 1);
  assert.equal(effects.scarecrows, 1);
  assert.equal(effects.hasOrderBoard, true);
  assert.equal(effects.dailyWaterCapacity, BASE_FARM_DAILY_WATER + FARM_WATER_PER_WELL);
  assert.equal(effects.storageCapacityBonus, FARM_STORAGE_BONUS_PER_BUILDING);

  const nextDay = advanceFarmDay({
    ...effectState,
    resources: { ...effectState.resources, water: 0 },
  });
  assert.equal(nextDay.resources.water, BASE_FARM_DAILY_WATER + FARM_WATER_PER_WELL);
  assert.ok(nextDay.lastDailySummary?.highlights.some((item) => item.includes('水井补水')));

  const moveSelect = applyFarmTool(selectedDecor.state, { tool: 'move', x: 320, y: 0 });
  assert.equal(moveSelect.changed, true);
  assert.equal(moveSelect.state.selectedTool, 'move');
  assert.equal(moveSelect.state.selectedObjectId, selectedDecor.state.objects[0].id);
  const moved = applyFarmTool(moveSelect.state, { tool: 'move', x: 896, y: 0 });
  assert.equal(moved.changed, true);
  assert.equal(moved.state.selectedObjectId, undefined);
  assert.equal(moved.state.objects[0].x, 896);

  const blockedMoveSelect = applyFarmTool(moved.state, { tool: 'move', x: 896, y: 0 });
  const blockedMove = applyFarmTool(blockedMoveSelect.state, { tool: 'move', x: 640, y: 0 });
  assert.equal(blockedMove.changed, false);
  assert.equal(blockedMove.error, 'blocked');
});

test('farm long-term goals track real farm progress metrics', () => {
  const initialGoals = buildFarmLongTermGoals(createFarmState());
  assert.deepEqual(initialGoals.map((goal) => goal.id), [
    'starter-route',
    'crop-catalog',
    'farmstead-buildings',
    'orders-10',
    'decor-30',
    'days-7',
  ]);
  assert.equal(initialGoals.length, 6);
  assert.equal(initialGoals.every((goal) => goal.percent >= 0 && goal.percent <= 100), true);
  assert.equal(initialGoals.find((goal) => goal.id === 'days-7')?.current, 1);

  const completeState = createFarmState({
    day: 7,
    discoveredCropIds: Object.keys(FARM_CROP_DEFINITIONS) as Array<keyof typeof FARM_CROP_DEFINITIONS>,
    objects: [
      { id: 'hut', kind: 'building', buildingId: 'hut', x: 0, y: 0, widthCells: 3, heightCells: 3, createdDay: 1 },
      { id: 'well', kind: 'building', buildingId: 'well', x: 256, y: 0, widthCells: 2, heightCells: 2, createdDay: 1 },
      { id: 'storage', kind: 'building', buildingId: 'storage', x: 448, y: 0, widthCells: 3, heightCells: 2, createdDay: 1 },
      { id: 'board', kind: 'building', buildingId: 'board', x: 704, y: 0, widthCells: 2, heightCells: 1, createdDay: 1 },
      { id: 'scarecrow', kind: 'building', buildingId: 'scarecrow', x: 896, y: 0, widthCells: 1, heightCells: 1, createdDay: 1 },
      { id: 'decor-a', kind: 'decor', decorId: 'stone-path', x: 0, y: 256, widthCells: 1, heightCells: 1, createdDay: 1 },
    ],
    stats: {
      plotsTilled: 3,
      cropsPlanted: 3,
      cropsWatered: 3,
      cropsHarvested: 3,
      ordersCompleted: 10,
      npcVisitsCompleted: 0,
      rareEventsFound: 0,
      objectsPlaced: 35,
      buildingsPlaced: 5,
      decorPlaced: 30,
      daysAdvanced: 6,
    },
  });
  const completeGoals = buildFarmLongTermGoals(completeState);
  assert.equal(completeGoals.every((goal) => goal.done), true);
  assert.equal(completeGoals.find((goal) => goal.id === 'starter-route')?.current, 5);
  assert.equal(completeGoals.find((goal) => goal.id === 'crop-catalog')?.target, Object.keys(FARM_CROP_DEFINITIONS).length);
  assert.equal(completeGoals.find((goal) => goal.id === 'farmstead-buildings')?.current, 5);
  assert.equal(completeGoals.find((goal) => goal.id === 'orders-10')?.current, 10);
  assert.equal(completeGoals.find((goal) => goal.id === 'decor-30')?.current, 30);
  assert.equal(completeGoals.find((goal) => goal.id === 'days-7')?.current, 7);
});

test('farm beauty score turns building and decoration layout into soft progression', () => {
  const initial = buildFarmBeautyScore(createFarmState());
  assert.equal(initial.score, 0);
  assert.equal(initial.level, 1);
  assert.equal(initial.title, '朴素空地');
  assert.match(initial.nextHint, /道路连通/);
  assert.equal(initial.factors.length, 6);
  const initialRewards = buildFarmBeautyRewards(createFarmState());
  assert.equal(initialRewards.length, 5);
  assert.equal(initialRewards.filter((reward) => reward.unlocked).length, 1);
  assert.equal(initialRewards[0].id, 'wooden-nameplate');
  assert.equal(initialRewards[0].remainingScore, 0);
  assert.equal(initialRewards.find((reward) => reward.id === 'flower-sticker')?.remainingScore, 25);

  const makeDecor = (index: number, decorId: string, objectType?: 'sign' | 'banner' | 'poster-wall' | 'tile') => ({
    id: `beauty-decor-${index}`,
    kind: 'decor' as const,
    x: index * FARM_GRID_SIZE,
    y: FARM_GRID_SIZE * 8,
    widthCells: 1,
    heightCells: 1,
    decorId,
    objectType,
    resourceId: objectType ? `resource-${index}` : undefined,
    createdDay: 1,
  });
  const makeBuilding = (index: number, buildingId: string) => ({
    id: `beauty-building-${index}`,
    kind: 'building' as const,
    x: index * FARM_GRID_SIZE * 3,
    y: FARM_GRID_SIZE * 11,
    widthCells: FARM_BUILDING_DEFINITIONS[buildingId].widthCells,
    heightCells: FARM_BUILDING_DEFINITIONS[buildingId].heightCells,
    buildingId,
    createdDay: 1,
  });
  const objects = [
    ...Array.from({ length: 6 }, (_, index) => makeDecor(index, 'stone-path')),
    ...Array.from({ length: 4 }, (_, index) => makeDecor(index + 10, 'flower-bed')),
    ...Array.from({ length: 6 }, (_, index) => makeDecor(index + 20, 'wood-fence')),
    ...Array.from({ length: 3 }, (_, index) => makeDecor(index + 30, 'lantern')),
    makeDecor(40, 'resource-sign', 'sign'),
    makeDecor(41, 'resource-banner', 'banner'),
    makeDecor(42, 'resource-poster-wall', 'poster-wall'),
    makeBuilding(0, 'hut'),
    makeBuilding(1, 'well'),
    makeBuilding(2, 'board'),
    makeBuilding(3, 'storage'),
  ];
  const complete = buildFarmBeautyScore(createFarmState({ objects }));
  const factorById = new Map(complete.factors.map((factor) => [factor.id, factor]));

  assert.equal(complete.score, 100);
  assert.equal(complete.level, 5);
  assert.equal(complete.title, '四季名场');
  assert.match(complete.summary, /6\/6/);
  const completeRewards = buildFarmBeautyRewards(createFarmState({ objects }));
  assert.equal(completeRewards.every((reward) => reward.unlocked), true);
  assert.equal(completeRewards.find((reward) => reward.id === 'festival-arch')?.remainingScore, 0);
  assert.equal(factorById.get('paths')?.done, true);
  assert.equal(factorById.get('flowers')?.done, true);
  assert.equal(factorById.get('fences')?.done, true);
  assert.equal(factorById.get('lights')?.done, true);
  assert.equal(factorById.get('buildings')?.done, true);
  assert.equal(factorById.get('resourceDecor')?.done, true);

  const focusGoals = buildFarmFocusGoals(createFarmState({
    objects: [makeDecor(1, 'stone-path')],
    stats: { plotsTilled: 3, cropsPlanted: 3, cropsWatered: 3, cropsHarvested: 3, ordersCompleted: 1 },
  }), { maxGoals: 8 });
  const decorateGoal = focusGoals.find((goal) => goal.id === 'decorate-farm');
  assert.equal(decorateGoal?.kind, 'decorate');
  assert.match(decorateGoal?.detail || '', /漂亮度/);
  assert.match(decorateGoal?.detail || '', /下一档奖励/);
});

test('farm state sanitizer clamps unsafe payloads and viewport queries stay sparse', () => {
  const noisyObjects = Array.from({ length: MAX_FARM_OBJECTS + 5 }, (_, index) => ({
    id: `plot-${index}`,
    kind: 'plot',
    x: index * FARM_GRID_SIZE + 17,
    y: 0,
    widthCells: 1,
    heightCells: 1,
    createdDay: 1,
  }));
  const state = sanitizeFarmCanvasState({
    version: 99,
    coordinateMode: 'viewport',
    gridSize: 0,
    day: -12,
    season: 'bad',
    weather: 'bad-weather',
    festivalId: 'bad id',
    resources: { gold: -5, wood: 2, stone: 1, water: 99999, experience: 7, seeds: { turnip: 2, bad: 100 } },
    inventory: { crops: { turnip: 4, bad: 9 }, animalProducts: { egg: 2, milk: 1, bad: 9 }, decorIds: ['wood-fence', 'wood-fence'] },
    objects: [
      ...noisyObjects,
      { id: 'bad-url', kind: 'decor', x: 0, y: 0, widthCells: 1, heightCells: 1, resourceId: 'data:image/png;base64,abc', createdDay: 1 },
    ],
    animals: [
      { id: 'bad animal id', kind: 'dragon', name: 'bad', mood: 'wild', placedDay: -3, productCount: 999999999 },
      {
        id: 'cow-1',
        kind: 'cow',
        name: '奶牛 https://example.com C:\\Users\\Secret\\cow.png',
        mood: 'happy',
        placedDay: 1,
        lastProducedDay: 99,
        productCount: 3,
      },
      ...Array.from({ length: MAX_FARM_ANIMALS + 2 }, (_, index) => ({
        id: `hen-${index}`,
        kind: 'chicken',
        name: `小鸡${index}`,
        mood: 'calm',
        placedDay: 1,
        productCount: index,
      })),
    ],
    eventLog: Array.from({ length: MAX_FARM_EVENT_LOG + 5 }, (_, index) => ({
      id: `event-${index}`,
      kind: index === 0 ? 'bad-kind' : 'crop_harvested',
      day: -index,
      message: index === 0
        ? 'prompt: secret https://example.com/a.png data:image/png;base64,abc C:\\Users\\Secret\\file.png'
        : `收获记录 ${index}`,
      amount: index,
      cropId: index === 1 ? 'turnip' : 'bad',
      objectKind: index === 2 ? 'decor' : 'bad-kind',
      orderId: 'tutorial-turnip-order',
      npcVisitId: index === 1 ? 'npc-visit-1-mira' : 'bad npc visit id',
      rareEventId: index === 1 ? 'rare-event-1-giant-turnip-plot' : 'bad rare event id',
      createdAt: index,
    })),
    lastDailySummary: {
      id: 'summary-unsafe',
      fromDay: -5,
      toDay: -1,
      message: 'prompt: secret https://example.com/summary data:image/png;base64,abc C:\\Users\\Secret\\summary.png',
      harvestedCrops: -4,
      ordersCompleted: 2,
      goldEarned: 999999999,
      weather: 'bad-weather',
      rainWateredCrops: -1,
      festivalBonusGold: 999999999,
      animalProductsProduced: 999999,
      animalProductSummary: '鸡蛋 x1 https://example.com C:\\Users\\Secret\\egg.png prompt: bad',
      npcVisitsCompleted: 999999,
      rareEventsFound: 999999,
      rareEventSummary: '巨大萝卜 https://example.com C:\\Users\\Secret\\rare.png prompt: bad',
      readyOrders: 999999,
      readyNpcVisits: 999999,
      dailyWaterCapacity: 999999,
      scarecrowProtectedCrops: 999999,
      wateredCrops: 3,
      dryCrops: 4,
      witheredCrops: 5,
      newMatureCrops: 6,
      matureCrops: 7,
      nextMatureCrops: 8,
      highlights: [
        'https://example.com/highlight prompt: hidden',
        'C:\\Users\\Secret\\file.png',
        '正常摘要',
        '4',
        '5',
        '6',
      ],
      createdAt: 0,
    },
    festivalTasks: [
      {
        id: 'bad task id',
        festivalId: 'bad festival id',
        title: '节庆'.repeat(80),
        description: 'prompt: hidden https://example.com/task.png data:image/png;base64,abc C:\\Users\\Secret\\task.png',
        kind: 'bad-kind',
        target: 99,
        progress: 99,
        rewards: {
          gold: 999999999,
          wood: 3,
          seeds: { sunflower: 2, bad: 9 },
          decorIds: ['wood-fence', 'bad id'],
        },
        completed: true,
        completedDay: -2,
      },
    ],
    npcVisits: [
      {
        id: 'bad visit id',
        visitorId: 'bad',
        visitorName: '米拉 https://example.com C:\\Users\\Secret\\npc.png',
        day: -4,
        title: '来访'.repeat(80),
        message: 'prompt: hidden https://example.com/npc.png data:image/png;base64,abc C:\\Users\\Secret\\npc.png',
        requestKind: 'bad-kind',
        cropId: 'bad',
        animalProductId: 'bad',
        amount: 999,
        rewards: {
          gold: 999999999,
          experience: 5,
          seeds: { potato: 2, bad: 9 },
          decorIds: ['wood-fence', 'bad id'],
        },
        completed: true,
        completedDay: 999,
      },
    ],
    rareEvents: [
      {
        id: 'rare-event-1-giant-turnip-plot',
        eventId: 'giant-turnip',
        title: '巨大萝卜 https://example.com C:\\Users\\Secret\\rare.png',
        message: 'prompt: hidden https://example.com/rare.png data:image/png;base64,abc C:\\Users\\Secret\\rare.png',
        day: 99,
        cropId: 'turnip',
        rewards: {
          gold: 999999999,
          experience: 5,
          seeds: { turnip: 2, bad: 9 },
          decorIds: ['wood-fence', 'bad id'],
        },
      },
    ],
    orders: [],
    stats: {
      plotsTilled: -1,
      npcVisitsCompleted: 999999999,
      rareEventsFound: 999999999,
      buildingsPlaced: 999999999,
      decorPlaced: 999999999,
    },
    selectedBuildingId: 'unsafe building',
    selectedDecorId: 'missing-decor',
    selectedObjectId: 'bad id',
  });

  assert.equal(state.version, 1);
  assert.equal(state.coordinateMode, 'flow');
  assert.equal(state.gridSize, FARM_GRID_SIZE);
  assert.equal(state.day, 1);
  assert.equal(state.season, 'spring');
  assert.equal(state.weather, 'sunny');
  assert.equal(state.festivalId, undefined);
  assert.equal(state.resources.gold, 0);
  assert.equal(state.resources.water, 999);
  assert.equal(state.resources.seeds.turnip, 2);
  assert.equal((state.resources.seeds as any).bad, undefined);
  assert.equal(state.inventory.crops.turnip, 4);
  assert.equal(state.inventory.animalProducts.egg, 2);
  assert.equal(state.inventory.animalProducts.milk, 1);
  assert.equal((state.inventory.animalProducts as any).bad, undefined);
  assert.equal(state.inventory.decorIds.length, 1);
  assert.ok(state.animals.length <= MAX_FARM_ANIMALS);
  assert.equal(state.animals[0].id, 'cow-1');
  assert.equal(state.animals[0].kind, 'cow');
  assert.equal(state.animals[0].mood, 'happy');
  assert.equal(state.animals[0].placedDay, 1);
  assert.equal(state.animals[0].lastProducedDay, 1);
  assert.equal(state.animals[0].name.includes('example.com'), false);
  assert.equal(state.animals[0].name.includes('Secret'), false);
  assert.equal(state.objects.length, MAX_FARM_OBJECTS);
  assert.equal(state.objects[0].x, 0);
  assert.equal(state.eventLog.length, MAX_FARM_EVENT_LOG);
  assert.equal(state.selectedBuildingId, 'hut');
  assert.equal(state.selectedDecorId, FARM_DEFAULT_DECOR_ID);
  assert.equal(state.selectedObjectId, undefined);
  assert.equal(state.eventLog[0].kind, 'tool_feedback');
  assert.equal(state.eventLog[0].day, 1);
  assert.equal(state.eventLog[0].message.includes('https://example.com'), false);
  assert.equal(state.eventLog[0].message.includes('data:image'), false);
  assert.equal(state.eventLog[0].message.includes('Secret'), false);
  assert.equal(state.eventLog[0].message.includes('prompt:'), false);
  assert.equal(state.eventLog[1].cropId, 'turnip');
  assert.equal(state.eventLog[1].npcVisitId, 'npc-visit-1-mira');
  assert.equal(state.eventLog[1].rareEventId, 'rare-event-1-giant-turnip-plot');
  assert.equal(state.eventLog[2].objectKind, 'decor');
  assert.equal(state.lastDailySummary?.fromDay, 1);
  assert.equal(state.lastDailySummary?.toDay, 1);
  assert.equal(state.lastDailySummary?.message.includes('example.com'), false);
  assert.equal(state.lastDailySummary?.message.includes('data:image'), false);
  assert.equal(state.lastDailySummary?.message.includes('Secret'), false);
  assert.equal(state.lastDailySummary?.harvestedCrops, 0);
  assert.equal(state.lastDailySummary?.goldEarned, 9999999);
  assert.equal(state.lastDailySummary?.weather, 'sunny');
  assert.equal(state.lastDailySummary?.rainWateredCrops, 0);
  assert.equal(state.lastDailySummary?.festivalBonusGold, 9999999);
  assert.equal(state.lastDailySummary?.animalProductsProduced, 9999);
  assert.equal(state.lastDailySummary?.animalProductSummary?.includes('example.com'), false);
  assert.equal(state.lastDailySummary?.animalProductSummary?.includes('Secret'), false);
  assert.equal(state.lastDailySummary?.npcVisitsCompleted, 9999);
  assert.equal(state.lastDailySummary?.rareEventsFound, 9999);
  assert.equal(state.lastDailySummary?.rareEventSummary?.includes('example.com'), false);
  assert.equal(state.lastDailySummary?.rareEventSummary?.includes('Secret'), false);
  assert.equal(state.lastDailySummary?.readyOrders, 9999);
  assert.equal(state.lastDailySummary?.readyNpcVisits, 9999);
  assert.equal(state.lastDailySummary?.dailyWaterCapacity, 9999);
  assert.equal(state.lastDailySummary?.scarecrowProtectedCrops, 9999);
  assert.equal(state.lastDailySummary?.witheredCrops, 5);
  assert.equal(state.lastDailySummary?.highlights.length, 5);
  assert.equal(state.lastDailySummary?.highlights[0].includes('example.com'), false);
  assert.equal(state.festivalTasks.length, 1);
  assert.equal(state.festivalTasks[0].festivalId, 'festival-1');
  assert.equal(state.festivalTasks[0].kind, 'complete-orders');
  assert.equal(state.festivalTasks[0].target, 9);
  assert.equal(state.festivalTasks[0].progress, 9);
  assert.equal(state.festivalTasks[0].completed, true);
  assert.equal(state.festivalTasks[0].completedDay, 1);
  assert.equal(state.festivalTasks[0].description.includes('example.com'), false);
  assert.equal(state.festivalTasks[0].description.includes('Secret'), false);
  assert.equal(state.festivalTasks[0].rewards.gold, 999999);
  assert.equal(state.festivalTasks[0].rewards.wood, 3);
  assert.equal(state.festivalTasks[0].rewards.seeds?.sunflower, 2);
  assert.equal((state.festivalTasks[0].rewards.seeds as any).bad, undefined);
  assert.deepEqual(state.festivalTasks[0].rewards.decorIds, ['wood-fence']);
  assert.equal(state.npcVisits.length, 1);
  assert.equal(state.npcVisits[0].id, 'npc-visit-1-mira-0');
  assert.equal(state.npcVisits[0].visitorId, 'mira');
  assert.equal(state.npcVisits[0].requestKind, 'crop');
  assert.equal(state.npcVisits[0].cropId, 'turnip');
  assert.equal(state.npcVisits[0].amount, 99);
  assert.equal(state.npcVisits[0].completed, true);
  assert.equal(state.npcVisits[0].completedDay, 1);
  assert.equal(state.npcVisits[0].message.includes('example.com'), false);
  assert.equal(state.npcVisits[0].rewards.gold, 999999);
  assert.equal(state.npcVisits[0].rewards.seeds?.potato, 2);
  assert.equal((state.npcVisits[0].rewards.seeds as any).bad, undefined);
  assert.equal(state.stats.npcVisitsCompleted, 999999);
  assert.equal(state.rareEvents.length, 1);
  assert.equal(state.rareEvents[0].id, 'rare-event-1-giant-turnip-plot');
  assert.equal(state.rareEvents[0].message.includes('example.com'), false);
  assert.equal(state.rareEvents[0].message.includes('Secret'), false);
  assert.equal(state.rareEvents[0].rewards.gold, 999999);
  assert.equal(state.rareEvents[0].rewards.seeds?.turnip, 2);
  assert.equal((state.rareEvents[0].rewards.seeds as any).bad, undefined);
  assert.equal(state.stats.rareEventsFound, 999999);
  assert.equal(state.stats.buildingsPlaced, 999999);
  assert.equal(state.stats.decorPlaced, 999999);

  const resourceState = sanitizeFarmCanvasState({
    objects: [
      {
        id: 'resource-decor-1',
        kind: 'decor',
        decorId: farmDecorIdForResourceObjectType('tile'),
        resourceId: 'resource_tile-1',
        skinId: 'resource-tile',
        objectType: 'tile',
        fileUrl: 'https://example.com/should-not-persist.png',
        thumbUrl: 'https://example.com/thumb.png',
        x: 0,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        createdDay: 1,
      },
      {
        id: 'bad-resource-decor',
        kind: 'decor',
        decorId: farmDecorIdForResourceObjectType('sign'),
        resourceId: 'data:image/png;base64,abc',
        objectType: 'sign',
        x: FARM_GRID_SIZE,
        y: 0,
        widthCells: 1,
        heightCells: 1,
        createdDay: 1,
      },
    ],
    selectedResourceDecor: {
      resourceId: 'resource-poster-1',
      skinId: 'resource-poster-wall',
      objectType: 'poster-wall',
    },
  });
  assert.equal(resourceState.objects[0].resourceId, 'resource_tile-1');
  assert.equal(resourceState.objects[0].objectType, 'tile');
  assert.equal((resourceState.objects[0] as any).fileUrl, undefined);
  assert.equal((resourceState.objects[0] as any).thumbUrl, undefined);
  assert.equal(resourceState.objects[1].resourceId, undefined);
  assert.equal(resourceState.selectedResourceDecor?.resourceId, 'resource-poster-1');
  assert.equal(resourceState.selectedResourceDecor?.objectType, 'poster-wall');

  const unsafeSelectedResource = sanitizeFarmCanvasState({
    selectedResourceDecor: {
      resourceId: 'data:image/png;base64,abc',
      skinId: 'resource-tile',
      objectType: 'tile',
    },
  });
  assert.equal(unsafeSelectedResource.selectedResourceDecor, undefined);

  const visible = getFarmObjectsInViewport(state, { x: -10, y: -10, width: FARM_GRID_SIZE * 2, height: FARM_GRID_SIZE });
  assert.ok(visible.length > 0);
  assert.ok(visible.length < state.objects.length);
});

test('farm canvas types are wired into CanvasData, Canvas persistence, import, and export', () => {
  const types = readFileSync(new URL('../src/types/canvas.ts', import.meta.url), 'utf8');
  const utils = readFileSync(new URL('../src/utils/farmCanvas.ts', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../backend/src/routes/canvas.js', import.meta.url), 'utf8');
  const roadmap = readFileSync(new URL('../roadmap.md', import.meta.url), 'utf8');

  assert.match(types, /export interface FarmCanvasState/);
  assert.match(utils, /export const FARM_SEASON_DAYS = 28/);
  assert.match(utils, /export const FARM_SEASON_DEFINITIONS/);
  assert.match(utils, /export function farmSeasonForDay/);
  assert.match(utils, /effectPreview\?: string/);
  assert.match(utils, /objectType\?: FarmDecorObjectType/);
  assert.match(utils, /const effectPreview = kind === 'building'[\s\S]*farmBuildingActivationHint\(building\?\.id\)[\s\S]*farmDecorActivationHint\(rawDecorId, input\.objectType\)/);
  assert.match(utils, /const nextSeason = farmSeasonForDay\(nextDay\)/);
  assert.match(route, /const FARM_SEASON_DAYS = 28/);
  assert.match(route, /function farmSeasonForDay\(dayInput\)/);
  assert.match(route, /FARM_SEASONS\.includes\(input\.season\) \? input\.season : farmSeasonForDay\(day\)/);
  assert.match(types, /coordinateMode:\s*'flow'/);
  assert.match(types, /eventLog: FarmEventLogItem\[\]/);
  assert.match(types, /lastDailySummary\?: FarmDailySummary/);
  assert.match(types, /readyOrders: number/);
  assert.match(types, /readyNpcVisits: number/);
  assert.match(types, /dailyWaterCapacity: number/);
  assert.match(types, /scarecrowProtectedCrops: number/);
  assert.match(utils, /readyOrders = next\.orders\.filter/);
  assert.match(utils, /scarecrowProtectedCrops = previous\.objects\.filter/);
  assert.match(route, /readyOrders: Math\.round\(clampNumber\(source\.readyOrders/);
  assert.match(route, /scarecrowProtectedCrops: Math\.round\(clampNumber\(source\.scarecrowProtectedCrops/);
  assert.match(types, /export interface FarmFestivalTask/);
  assert.match(types, /festivalTasks: FarmFestivalTask\[\]/);
  assert.match(types, /export interface FarmNpcVisitState/);
  assert.match(types, /npcVisits: FarmNpcVisitState\[\]/);
  assert.match(types, /npc_request_completed/);
  assert.match(types, /export interface FarmRareEventState/);
  assert.match(types, /rareEvents: FarmRareEventState\[\]/);
  assert.match(types, /rare_event/);
  assert.match(types, /export interface FarmLongTermGoal/);
  assert.match(types, /buildingsPlaced: number/);
  assert.match(types, /decorPlaced: number/);
  assert.match(utils, /export interface FarmActivityFeedItem/);
  assert.match(utils, /rewardLabel\?: string/);
  assert.match(utils, /function farmActivityRewardLabel\(kind: FarmEventKind\)/);
  assert.match(utils, /kind === 'rare_event'[\s\S]*return '惊喜奖励'/);
  assert.match(utils, /export function buildFarmActivityFeed/);
  assert.match(utils, /rewardStreak: number/);
  assert.match(utils, /rewardStreakLabel\?: string/);
  assert.match(utils, /rewardStreakHint\?: string/);
  assert.match(utils, /rewardStreakTier\?: FarmActivityRewardStreakTier/);
  assert.match(utils, /rewardStreakMilestoneLabel\?: string/);
  assert.match(utils, /rewardStreakMilestoneTarget\?: number/);
  assert.match(utils, /rewardStreakMilestonePercent\?: number/);
  assert.match(utils, /rewardStreakMilestoneProgressLabel\?: string/);
  assert.match(utils, /rewardStreakMilestoneCompletionLabel\?: string/);
  assert.match(utils, /rewardStreakMilestoneRewardLabel\?: string/);
  assert.match(utils, /rewardStreakMilestoneRewardItems\?: string\[\]/);
  assert.match(utils, /rewardStreakActionKind\?: FarmActivityRewardStreakActionKind/);
  assert.match(utils, /rewardStreakActionShortLabel\?: string/);
  assert.match(utils, /rewardStreakActionLabel\?: string/);
  assert.match(utils, /rewardStreakAction\?: FarmFocusGoalAction/);
  assert.match(utils, /export type FarmActivityRewardStreakChestState = 'warming' \| 'ready'/);
  assert.match(utils, /rewardStreakChestState\?: FarmActivityRewardStreakChestState/);
  assert.match(utils, /rewardStreakChestTier\?: FarmActivityRewardStreakTier/);
  assert.match(utils, /rewardStreakChestLabel\?: string/);
  assert.match(utils, /rewardStreakChestShortLabel\?: string/);
  assert.match(utils, /rewardStreakChestProgressLabel\?: string/);
  assert.match(utils, /rewardStreakChestRewardLabel\?: string/);
  assert.match(utils, /rewardStreakChestCtaLabel\?: string/);
  assert.match(utils, /rewardStreakChestClaimLabel\?: string/);
  assert.match(utils, /rewardStreakChestNextLabel\?: string/);
  assert.match(utils, /rewardStreakChestRewardItems\?: string\[\]/);
  assert.match(utils, /rewardStreakChestBurstLabel\?: string/);
  assert.match(utils, /rewardStreakChestOpenedSummaryLabel\?: string/);
  assert.match(utils, /rewardStreakChestPercent\?: number/);
  assert.match(utils, /rewardStreakChestMeterLabel\?: string/);
  assert.match(utils, /rewardStreakChestRemaining\?: number/);
  assert.match(utils, /rewardStreakChestRemainingLabel\?: string/);
  assert.match(utils, /export type FarmActivityRewardStreakChestTrailState = 'done' \| 'active' \| 'next'/);
  assert.match(utils, /interface FarmActivityRewardStreakChestTrailItem/);
  assert.match(utils, /rewardLabel: string/);
  assert.match(utils, /shortRewardLabel: string/);
  assert.match(utils, /rewardStreakChestTrailLabel\?: string/);
  assert.match(utils, /rewardStreakChestTrailRewardLabel\?: string/);
  assert.match(utils, /rewardStreakChestTrailItems\?: FarmActivityRewardStreakChestTrailItem\[\]/);
  assert.match(utils, /rewardStreakChestActiveTrailLabel\?: string/);
  assert.match(utils, /rewardStreakChestActiveRewardLabel\?: string/);
  assert.match(utils, /rewardStreakChestActiveHint\?: string/);
  assert.match(utils, /rewardStreakChestNextRewardLabel\?: string/);
  assert.match(utils, /rewardStreakChestChargeLabel\?: string/);
  assert.match(utils, /rewardStreakChestChargeShortLabel\?: string/);
  assert.match(utils, /rewardStreakChestChargeHint\?: string/);
  assert.match(utils, /function farmActivityRewardStreakChestActiveTrailItem\(items: FarmActivityRewardStreakChestTrailItem\[\] \| undefined\)/);
  assert.match(utils, /function farmActivityRewardStreakChestActiveHint/);
  assert.match(utils, /function farmActivityRewardStreakMilestoneCompletionLabel\(streak: number\)/);
  assert.match(utils, /function farmActivityRewardStreakMilestoneRewardLabel\(streak: number\)/);
  assert.match(utils, /function farmActivityRewardStreakMilestoneRewardItems\(streak: number\)/);
  assert.match(utils, /function farmActivityRewardStreakChestPreview\(streak: number\)/);
  assert.match(utils, /function farmActivityRewardStreak\(events: FarmEventLogItem\[\]\)/);
  assert.match(utils, /function farmActivityRewardStreakHint\(streak: number\)/);
  assert.match(utils, /function farmActivityRewardStreakTier\(streak: number\)/);
  assert.match(utils, /function farmActivityRewardStreakMilestoneLabel\(streak: number\)/);
  assert.match(utils, /function farmActivityRewardStreakMilestoneProgress\(streak: number\)/);
  assert.match(utils, /function farmActivityRewardStreakAction\(state: FarmCanvasState, streak: number\)/);
  assert.match(utils, /export interface FarmBeautyScore/);
  assert.match(utils, /export interface FarmBeautyReward/);
  assert.match(utils, /FARM_BEAUTY_REWARD_DEFINITIONS/);
  assert.match(utils, /export function buildFarmBeautyScore/);
  assert.match(utils, /export function buildFarmBeautyRewards/);
  assert.match(types, /export interface FarmAnimalState/);
  assert.match(types, /animalProducts: Partial<Record<FarmAnimalProductId, number>>/);
  assert.match(types, /animals: FarmAnimalState\[\]/);
  assert.match(types, /selectedBuildingId\?: string/);
  assert.match(types, /selectedDecorId\?: string/);
  assert.match(types, /selectedObjectId\?: string/);
  assert.match(types, /farmCanvas\?: FarmCanvasState/);
  assert.match(canvas, /import \{[\s\S]*FARM_BUILDING_DEFINITIONS[\s\S]*FARM_DECOR_DEFINITIONS[\s\S]*createFarmState[\s\S]*sanitizeFarmCanvasState[\s\S]*type FarmToolAction[\s\S]*\} from '\.\.\/utils\/farmCanvas'/);
  assert.match(canvas, /const \[farmCanvas, rawSetFarmCanvas\] = useState<FarmCanvasState>/);
  assert.match(canvas, /const setFarmCanvas = useCallback\([\s\S]{0,420}?rawSetFarmCanvas\(next\.value\)/);
  assert.match(canvas, /const authoritativeFarmCanvas = sanitizeFarmCanvasState\(data\.farmCanvas\)/);
  assert.match(canvas, /let renderedState = authoritativeState;[\s\S]{0,900}?mergeConcurrentCanvasPatchState\(existingPending\.baseSnapshot, existingPending, authoritativeState\)/);
  assert.match(canvas, /function persistableCanvasPatchStateFromParts\([\s\S]{0,900}?snapshot: JSON\.stringify\(\{ nodes: persistNodes, edges: persistEdges, creativeDesk, farmCanvas, nextNodeSerialId \}\)/);
  assert.match(canvas, new RegExp('pay' + 'load = \\{ nodes: persistNodes, edges: persistEdges, viewport: getViewport\\(\\), nextNodeSerialId, creativeDesk, farmCanvas \\}'));
  assert.match(canvas, /farmCanvas: sanitizeFarmCanvasState\(data\.farmCanvas\)/);
  assert.match(canvas, /setFarmCanvas\(sanitizeFarmCanvasState\(source\.farmCanvas\)\)/);
  assert.match(canvas, /const message = next\.lastDailySummary\?\.message \|\| '新的一天开始了，已浇水的作物继续成长。'/);
  assert.match(canvas, /setFarmCanvasFeedback\(message\)/);
  assert.match(roadmap, /Phase 3：全画布牧场对象层/);
});

test('farm render layer is mounted with ReactFlow coordinates and event exclusion', () => {
  const utils = readFileSync(new URL('../src/utils/farmCanvas.ts', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
  const layer = readFileSync(new URL('../src/components/FarmCanvasLayer.tsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/components/FarmStoryPanel.tsx', import.meta.url), 'utf8');
  const sound = readFileSync(new URL('../src/utils/farmSound.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles/theme-farm-story.css', import.meta.url), 'utf8')
    .replace(/\r\n?/g, '\n');
  const globalCss = readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8');
  const farmDarkConsoleLockStart = css.indexOf('/* Farm dark console contrast lock. */');
  const farmDarkConsoleLockEnd = css.indexOf('html[data-theme-visual="farm-story"] .react-flow__node', farmDarkConsoleLockStart);
  const farmDarkConsoleLock = farmDarkConsoleLockStart >= 0
    ? css.slice(farmDarkConsoleLockStart, farmDarkConsoleLockEnd > farmDarkConsoleLockStart ? farmDarkConsoleLockEnd : undefined)
    : '';
  const farmDarkHudStart = css.indexOf('html[data-theme-mode="dark"][data-theme-visual="farm-story"] {');
  const farmDarkHudCss = farmDarkHudStart >= 0
    ? css.slice(farmDarkHudStart, farmDarkConsoleLockStart > farmDarkHudStart ? farmDarkConsoleLockStart : undefined)
    : '';
  const farmPanelPlacementHudActionsStart = panel.indexOf('const handleFarmPlacementHudReceiptAction = () => {');
  const farmPanelPlacementHudActionsEnd = panel.indexOf('const handleOpenFarmAnimals = () => {', farmPanelPlacementHudActionsStart);
  const farmPanelPlacementHudActions = farmPanelPlacementHudActionsStart >= 0
    ? panel.slice(farmPanelPlacementHudActionsStart, farmPanelPlacementHudActionsEnd > farmPanelPlacementHudActionsStart ? farmPanelPlacementHudActionsEnd : undefined)
    : '';
  const farmPanelMiniPlacementReceiptStart = panel.indexOf('{farmPlacementHudReceiptLabel && (');
  const farmPanelMiniPlacementReceiptEnd = panel.indexOf('{farmMiniBuildingEffectItems.length > 0 && (', farmPanelMiniPlacementReceiptStart);
  const farmPanelMiniPlacementReceipt = farmPanelMiniPlacementReceiptStart >= 0
    ? panel.slice(farmPanelMiniPlacementReceiptStart, farmPanelMiniPlacementReceiptEnd > farmPanelMiniPlacementReceiptStart ? farmPanelMiniPlacementReceiptEnd : undefined)
    : '';
  const farmPanelMiniBuildingYieldStart = panel.indexOf('{farmMiniBuildingEffectItems.length > 0 && (');
  const farmPanelMiniBuildingYieldEnd = panel.indexOf('{farmBuildingEffectQuestPrimary && (', farmPanelMiniBuildingYieldStart);
  const farmPanelMiniBuildingYield = farmPanelMiniBuildingYieldStart >= 0
    ? panel.slice(farmPanelMiniBuildingYieldStart, farmPanelMiniBuildingYieldEnd > farmPanelMiniBuildingYieldStart ? farmPanelMiniBuildingYieldEnd : undefined)
    : '';
  const farmPanelMiniAnimalButtonsStart = panel.indexOf('{animalCount > 0 && (');
  const farmPanelMiniAnimalButtonsEnd = panel.indexOf('{farmActivityDigest.todayTotal > 0 &&', farmPanelMiniAnimalButtonsStart);
  const farmPanelMiniAnimalButtons = farmPanelMiniAnimalButtonsStart >= 0
    ? panel.slice(farmPanelMiniAnimalButtonsStart, farmPanelMiniAnimalButtonsEnd > farmPanelMiniAnimalButtonsStart ? farmPanelMiniAnimalButtonsEnd : undefined)
    : '';
  const farmPanelMiniFocusActionStart = panel.indexOf('{primaryFarmFocusActionLabel && (');
  const farmPanelMiniFocusActionEnd = panel.indexOf('{primaryFarmFocusActionResourcePreview && (', farmPanelMiniFocusActionStart);
  const farmPanelMiniFocusAction = farmPanelMiniFocusActionStart >= 0
    ? panel.slice(farmPanelMiniFocusActionStart, farmPanelMiniFocusActionEnd > farmPanelMiniFocusActionStart ? farmPanelMiniFocusActionEnd : undefined)
    : '';
  const farmPanelQuickRiskButtonsStart = panel.indexOf('{dryCount > 0 && (');
  const farmPanelQuickRiskButtonsEnd = panel.indexOf('{farmMiniQuickActionFeedback && panelOpen', farmPanelQuickRiskButtonsStart);
  const farmPanelQuickRiskButtons = farmPanelQuickRiskButtonsStart >= 0
    ? panel.slice(farmPanelQuickRiskButtonsStart, farmPanelQuickRiskButtonsEnd > farmPanelQuickRiskButtonsStart ? farmPanelQuickRiskButtonsEnd : undefined)
    : '';
  const farmPanelActivityRewardStreakActionStart = panel.indexOf('const handleFarmActivityRewardStreakAction = () => {');
  const farmPanelActivityRewardStreakActionEnd = panel.indexOf('const handleFarmActivityChestClaimNextAction = () => {', farmPanelActivityRewardStreakActionStart);
  const farmPanelActivityRewardStreakAction = farmPanelActivityRewardStreakActionStart >= 0
    ? panel.slice(farmPanelActivityRewardStreakActionStart, farmPanelActivityRewardStreakActionEnd > farmPanelActivityRewardStreakActionStart ? farmPanelActivityRewardStreakActionEnd : undefined)
    : '';
  const farmPanelActivityChestClaimNextActionStart = panel.indexOf('const handleFarmActivityChestClaimNextAction = () => {');
  const farmPanelActivityChestClaimNextActionEnd = panel.indexOf('const handleFarmActivityChestChargeAction = () => {', farmPanelActivityChestClaimNextActionStart);
  const farmPanelActivityChestClaimNextAction = farmPanelActivityChestClaimNextActionStart >= 0
    ? panel.slice(farmPanelActivityChestClaimNextActionStart, farmPanelActivityChestClaimNextActionEnd > farmPanelActivityChestClaimNextActionStart ? farmPanelActivityChestClaimNextActionEnd : undefined)
    : '';
  const farmPanelActivityChestChargeActionStart = panel.indexOf('const handleFarmActivityChestChargeAction = () => {');
  const farmPanelActivityChestChargeActionEnd = panel.indexOf('const farmActivityRewardDigestRef', farmPanelActivityChestChargeActionStart);
  const farmPanelActivityChestChargeAction = farmPanelActivityChestChargeActionStart >= 0
    ? panel.slice(farmPanelActivityChestChargeActionStart, farmPanelActivityChestChargeActionEnd > farmPanelActivityChestChargeActionStart ? farmPanelActivityChestChargeActionEnd : undefined)
    : '';
  const farmPanelActivityFollowupEffectStart = panel.indexOf('const farmActivityRewardStreakActionReceiptCanvasHint =');
  const farmPanelActivityFollowupEffectEnd = panel.indexOf('const farmActivityChestClaimed = Boolean', farmPanelActivityFollowupEffectStart);
  const farmPanelActivityFollowupEffect = farmPanelActivityFollowupEffectStart >= 0
    ? panel.slice(farmPanelActivityFollowupEffectStart, farmPanelActivityFollowupEffectEnd > farmPanelActivityFollowupEffectStart ? farmPanelActivityFollowupEffectEnd : undefined)
    : '';
  const farmFollowupCanvasHintHandlerStart = canvas.indexOf('const handleFarmFollowupCanvasHint = useCallback');
  const farmFollowupCanvasHintHandlerEnd = canvas.indexOf('  // 选中节点 / 剪贴板', farmFollowupCanvasHintHandlerStart);
  const farmFollowupCanvasHintHandler = farmFollowupCanvasHintHandlerStart >= 0
    ? canvas.slice(farmFollowupCanvasHintHandlerStart, farmFollowupCanvasHintHandlerEnd > farmFollowupCanvasHintHandlerStart ? farmFollowupCanvasHintHandlerEnd : undefined)
    : '';
  const farmPanelPlacementReceiptEffectGuard = panel.indexOf('if (!farmPlacementHudReceiptNextTargetOpenedCanvasHint || !onFollowupCanvasHint)');
  const farmPanelPlacementReceiptEffectStart = panel.lastIndexOf('useEffect(() => {', farmPanelPlacementReceiptEffectGuard);
  const farmPanelPlacementReceiptEffectEnd = panel.indexOf('const farmMiniBuildingEffectTitleLabel =', farmPanelPlacementReceiptEffectStart);
  const farmPanelPlacementReceiptEffect = farmPanelPlacementReceiptEffectStart >= 0
    ? panel.slice(farmPanelPlacementReceiptEffectStart, farmPanelPlacementReceiptEffectEnd > farmPanelPlacementReceiptEffectStart ? farmPanelPlacementReceiptEffectEnd : undefined)
    : '';
  const farmPanelMiniFollowupActionCardStart = panel.indexOf('{farmActivityRewardStreakActionReceiptEchoLabel && farmActivityRewardStreakActionReceiptNextHint && (');
  const farmPanelMiniFollowupActionCardEnd = panel.indexOf('{farmOrderStampFeedbackId && (', farmPanelMiniFollowupActionCardStart);
  const farmPanelMiniFollowupActionCard = farmPanelMiniFollowupActionCardStart >= 0
    ? panel.slice(farmPanelMiniFollowupActionCardStart, farmPanelMiniFollowupActionCardEnd > farmPanelMiniFollowupActionCardStart ? farmPanelMiniFollowupActionCardEnd : undefined)
    : '';
  const farmToolSelectionFeedbackStart = canvas.indexOf('const showFarmToolSelectionFeedback = useCallback');
  const farmToolSelectionFeedbackEnd = canvas.indexOf('const handleFarmGrantDevMaterials = useCallback', farmToolSelectionFeedbackStart);
  const farmToolSelectionFeedbackHandler = farmToolSelectionFeedbackStart >= 0
    ? canvas.slice(farmToolSelectionFeedbackStart, farmToolSelectionFeedbackEnd > farmToolSelectionFeedbackStart ? farmToolSelectionFeedbackEnd : undefined)
    : '';

  assert.match(canvas, /import FarmCanvasLayer, \{ type FarmCanvasFloatingFeedback \} from '\.\/FarmCanvasLayer'/);
  assert.match(canvas, /import \{ farmSoundCueForEvent, farmSoundCueForTool, playFarmActionSound, type FarmSoundCue \} from '\.\.\/utils\/farmSound'/);
  assert.match(canvas, /const \[farmCanvasEditing, setFarmCanvasEditing\] = useState\(false\)/);
  assert.match(canvas, /const \[farmStoryPanelOpen, setFarmStoryPanelOpen\] = useState/);
  assert.match(canvas, /const \[farmStoryPriorityFocusRequestId, setFarmStoryPriorityFocusRequestId\] = useState\(0\)/);
  assert.match(canvas, /const FARM_FOLLOWUP_NOTICE_MS = 5600/);
  assert.match(canvas, /const FARM_FEEDBACK_SCREEN_TOP_GUARD = 176/);
  assert.match(canvas, /const FARM_DEV_TEST_MATERIAL_AMOUNT = 9999/);
  assert.match(canvas, /const FARM_DEV_TEST_WATER_AMOUNT = 999/);
  assert.match(canvas, /FARM_ANIMAL_PRODUCT_DEFINITIONS,/);
  assert.match(canvas, /interface FarmFollowupNotice extends FarmStoryPanelCanvasHint/);
  assert.match(canvas, /const \[farmFloatingFeedbacks, setFarmFloatingFeedbacks\] = useState<FarmCanvasFloatingFeedback\[\]>\(\[\]\)/);
  assert.match(canvas, /const \[farmFollowupNotice, setFarmFollowupNotice\] = useState<FarmFollowupNotice \| null>\(null\)/);
  assert.match(canvas, /const \[farmSoundEnabled, setFarmSoundEnabled\] = useState/);
  assert.match(canvas, /const farmFloatingFeedbackTimersRef = useRef<Map<string, number>>\(new Map\(\)\)/);
  assert.match(canvas, /const farmFollowupNoticeTimerRef = useRef<number \| null>\(null\)/);
  assert.match(canvas, /type FarmActionFeedbackAnchor = \{ x: number; y: number; placement: FarmCanvasFloatingFeedback\['placement'\] \}/);
  assert.match(canvas, /function farmActionFeedbackAnchor\([\s\S]*previous: FarmCanvasState,[\s\S]*next: FarmCanvasState,[\s\S]*action: FarmToolAction[\s\S]*options: \{ screenTopGuard\?: number \} = \{\}[\s\S]*\): FarmActionFeedbackAnchor/);
  assert.match(canvas, /const screenTopGuard = options\.screenTopGuard \?\? FARM_FEEDBACK_SCREEN_TOP_GUARD/);
  assert.match(canvas, /const shouldPlaceBelowForScreen = typeof action\.screenY === 'number' && action\.screenY < screenTopGuard/);
  assert.match(canvas, /shouldPlaceBelowForScreen \|\| fallbackFootprint\.y <= gridSize \? 'below' : 'above'/);
  assert.match(canvas, /function farmActionSnappedPoint\(action: FarmToolAction, gridSize: number\) \{[\s\S]*return snapFarmPoint\(\{ x: action\.x, y: action\.y \}, gridSize\)/);
  assert.match(canvas, /function farmActionFeedbackFootprintForAction\([\s\S]*action: FarmToolAction,[\s\S]*gridSize: number/);
  assert.match(canvas, /FARM_BUILDING_DEFINITIONS\[action\.buildingId \|\| 'hut'\]/);
  assert.match(canvas, /width: Math\.max\(1, building\?\.widthCells \|\| 1\) \* gridSize/);
  assert.match(canvas, /height: Math\.max\(1, building\?\.heightCells \|\| 1\) \* gridSize/);
  assert.match(canvas, /function farmActionFeedbackObjectForAction\([\s\S]*objects: FarmCanvasState\['objects'\],[\s\S]*action: FarmToolAction,[\s\S]*gridSize: number/);
  assert.match(canvas, /const point = farmActionSnappedPoint\(action, gridSize\)/);
  assert.match(canvas, /const fallbackFootprint = farmActionFeedbackFootprintForAction\(action, gridSize\)/);
  assert.match(canvas, /x: fallbackFootprint\.x \+ fallbackFootprint\.width \/ 2/);
  assert.match(canvas, /y: fallbackPlacement === 'above' \? fallbackFootprint\.y : fallbackFootprint\.y \+ fallbackFootprint\.height/);
  assert.match(canvas, /buildFarmActivityDigest,/);
  assert.match(canvas, /buildFarmFocusGoals,/);
  assert.match(canvas, /canCompleteFarmNpcVisit,/);
  assert.match(canvas, /canCompleteFarmOrder,/);
  assert.match(canvas, /countFarmScarecrowUnprotectedDryCrops,/);
  assert.match(canvas, /const farmDevToolsEnabled = isFarmStory && import\.meta\.env\.DEV/);
  assert.match(canvas, /type FarmToolbarConsoleTone = 'water' \| 'order' \| 'visit' \| 'mature' \| 'guard' \| 'focus' \| 'stable'/);
  assert.match(canvas, /const FARM_TOOLBAR_CONSOLE_SECTION_LABELS: Record<FarmToolbarConsoleSection, string>/);
  assert.match(canvas, /function buildFarmToolbarConsoleHint\([\s\S]*stateInput: FarmCanvasState \| undefined,[\s\S]*panelOpen: boolean/);
  assert.match(canvas, /const dryCount = plots\.filter\(\(object\) =>[\s\S]*object\.crop\.stage !== 'mature'[\s\S]*!object\.crop\.wateredToday\)\.length/);
  assert.match(canvas, /const readyOrderCount = state\.orders\.filter\(\(order\) => canCompleteFarmOrder\(state, order\.id\)\)\.length/);
  assert.match(canvas, /const readyNpcVisitCount = state\.npcVisits\.filter\(\(visit\) => !visit\.completed && canCompleteFarmNpcVisit\(state, visit\.id\)\)\.length/);
  assert.match(canvas, /const scarecrowRiskCount = countFarmScarecrowUnprotectedDryCrops\(state\)/);
  assert.match(canvas, /const focusGoal = buildFarmFocusGoals\(state, \{ maxGoals: 1 \}\)\[0\]/);
  assert.match(canvas, /const activityDigest = buildFarmActivityDigest\(state\)/);
  assert.match(canvas, /title: `\$\{panelOpen \? '收起' : '展开'\}牧场控制台：当前优先 \$\{hint\.primary\} · \$\{hint\.secondary\} · \$\{sectionLabel\}`/);
  assert.match(panel, /open\?: boolean/);
  assert.match(panel, /onOpenChange\?: \(open: boolean\) => void/);
  assert.match(panel, /showInlineToggle\?: boolean/);
  assert.match(panel, /priorityFocusRequestId\?: number/);
  assert.match(panel, /devToolsEnabled\?: boolean/);
  assert.match(panel, /onGrantDevMaterials\?: \(\) => void/);
  assert.match(panel, /export default function FarmStoryPanel\(props: FarmStoryPanelProps\) \{\s*if \(props\.visualStyle !== 'farm-story'\) return null;\s*return <FarmStoryPanelRuntime \{\.\.\.props\} \/>;\s*\}/);
  assert.match(panel, /function FarmStoryPanelRuntime\(\{[\s\S]*\}: FarmStoryPanelProps\) \{/);
  assert.ok(
    panel.indexOf('export default function FarmStoryPanel(props: FarmStoryPanelProps)') < panel.indexOf('function FarmStoryPanelRuntime({'),
    'FarmStoryPanel wrapper should guard non-farm themes before mounting the runtime',
  );
  assert.match(panel, /const panelOpen = controlledOpen \?\? internalOpen/);
  assert.match(panel, /const setOpen = useCallback/);
  assert.match(panel, /priorityFocusRequestId = 0/);
  assert.match(panel, /devToolsEnabled = false/);
  assert.match(panel, /showInlineToggle && \(/);
  assert.match(canvas, /const farmStoryToolbarHint = useMemo\([\s\S]*buildFarmToolbarConsoleHint\(farmCanvas, farmStoryPanelOpen\)[\s\S]*\[farmCanvas, farmStoryPanelOpen, isFarmStory\]/);
  assert.match(canvas, /data-farm-control-console-toggle="toolbar"/);
  assert.match(canvas, /className=\{`t8-toolbar-button t8-farm-story-toolbar-toggle/);
  assert.match(canvas, /data-farm-control-console-priority=\{farmStoryToolbarHint\?\.tone\}/);
  assert.match(canvas, /data-farm-control-console-priority-label=\{farmStoryToolbarHint\?\.primary\}/);
  assert.match(canvas, /data-farm-control-console-priority-section=\{farmStoryToolbarHint\?\.section\}/);
  assert.match(canvas, /data-farm-control-console-priority-section-label=\{farmStoryToolbarHint\?\.sectionLabel\}/);
  assert.match(canvas, /data-farm-control-console-priority-count=\{farmStoryToolbarHint\?\.count\}/);
  assert.match(canvas, /data-farm-control-console-state=\{farmStoryPanelOpen \? 'open' : 'closed'\}/);
  assert.match(canvas, /data-farm-control-console-focus-request=\{farmStoryPriorityFocusRequestId \|\| undefined\}/);
  assert.match(canvas, /aria-label=\{farmStoryToolbarHint\?\.title \|\| \(farmStoryPanelOpen \? '收起牧场控制台' : '展开牧场控制台'\)\}/);
  assert.match(canvas, /title=\{farmStoryToolbarHint\?\.title \|\| \(farmStoryPanelOpen \? '收起牧场控制台' : '展开牧场控制台'\)\}/);
  assert.match(canvas, /const nextOpen = !farmStoryPanelOpen[\s\S]*if \(nextOpen\) \{[\s\S]*setRadialSettingsOpen\(false\)[\s\S]*setModelHelpOpen\(false\)[\s\S]*setCreativeDeskEditing\(false\)[\s\S]*setFarmStoryPriorityFocusRequestId\(\(value\) => value \+ 1\)[\s\S]*setFarmStoryPanelOpen\(nextOpen\)/);
  assert.match(canvas, /priorityFocusRequestId=\{farmStoryPriorityFocusRequestId\}/);
  assert.match(canvas, /<span aria-hidden="true" data-farm-toolbar-priority-dot="true" \/>/);
  assert.match(globalCss, /Farm toolbar priority hint v1/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] \.t8-farm-story-toolbar-toggle\[data-farm-control-console-priority\],[\s\S]*\.t8-canvas-shell\[data-theme-visual="farm-story"\] \.t8-farm-story-toolbar-toggle\[data-farm-control-console-priority\] \{[\s\S]*position:\s*relative[\s\S]*overflow:\s*visible[\s\S]*linear-gradient\(180deg, #ffffff, var\(--farm-pastel-bloom-card/);
  assert.match(globalCss, /\.t8-farm-story-toolbar-toggle \[data-farm-toolbar-priority-dot="true"\] \{[\s\S]*position:\s*absolute[\s\S]*width:\s*7px[\s\S]*height:\s*7px/);
  assert.match(globalCss, /\.t8-farm-story-toolbar-toggle\[data-farm-control-console-priority="water"\] \[data-farm-toolbar-priority-dot="true"\]/);
  assert.match(globalCss, /\.t8-farm-story-toolbar-toggle\[data-farm-control-console-priority="order"\] \[data-farm-toolbar-priority-dot="true"\],[\s\S]*\.t8-farm-story-toolbar-toggle\[data-farm-control-console-priority="visit"\] \[data-farm-toolbar-priority-dot="true"\]/);
  assert.match(globalCss, /\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-toolbar-toggle\[data-farm-control-console-priority\]/);
  assert.doesNotMatch(canvas, /<FarmStoryPanel[\s\S]*<ThemeMusicToggle/);
  assert.match(canvas, /showInlineToggle=\{false\}/);
  assert.match(panel, /data-farm-control-console-toggle="inline"/);
  assert.match(panel, /data-farm-control-console-priority=\{farmMonitorBriefTone\}/);
  assert.match(panel, /data-farm-control-console-priority-label=\{farmMonitorBriefPrimary\}/);
  assert.match(panel, /data-farm-control-console-priority-section=\{farmMonitorBriefSection\}/);
  assert.match(panel, /data-farm-control-console-priority-section-label=\{farmMonitorBriefSectionLabel\}/);
  assert.match(panel, /data-farm-control-console-auto-section=\{farmMonitorBriefSection\}/);
  assert.match(panel, /data-farm-control-console-auto-focus=\{panelOpen \? undefined : 'true'\}/);
  assert.match(panel, /const farmPriorityFocusRequestRef = useRef\(priorityFocusRequestId\)/);
  assert.match(panel, /interface FarmControlConsoleFocusReceipt/);
  assert.match(panel, /const \[farmControlConsoleFocusReceipt, setFarmControlConsoleFocusReceipt\] = useState<FarmControlConsoleFocusReceipt \| null>\(null\)/);
  assert.match(panel, /const farmControlConsoleFocusReceiptTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const flashFarmControlConsoleFocusReceipt = useCallback\(\(receipt: FarmControlConsoleFocusReceipt\) => \{[\s\S]*setFarmControlConsoleFocusReceipt\(receipt\)[\s\S]*setFarmControlConsoleFocusReceipt\(null\)/);
  assert.match(panel, /farmControlConsoleFocusReceiptTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmControlConsoleFocusReceiptTimerRef\.current\)[\s\S]*farmControlConsoleFocusReceiptTimerRef\.current = null/);
  assert.match(panel, /useEffect\(\(\) => \{[\s\S]*if \(!priorityFocusRequestId \|\| farmPriorityFocusRequestRef\.current === priorityFocusRequestId\) return[\s\S]*farmPriorityFocusRequestRef\.current = priorityFocusRequestId[\s\S]*setOpen\(true\)[\s\S]*setFarmPanelSectionOpen\(farmMonitorBriefSection, true\)[\s\S]*flashFarmPrioritySection\(farmMonitorBriefSection\)/);
  assert.match(panel, /flashFarmControlConsoleFocusReceipt\(\{[\s\S]*id: priorityFocusRequestId[\s\S]*section: farmMonitorBriefSection[\s\S]*sectionLabel: farmMonitorBriefSectionLabel[\s\S]*primary: farmMonitorBriefPrimary[\s\S]*secondary: farmMonitorBriefSecondary[\s\S]*actionKind: farmMonitorPriorityAction\.kind[\s\S]*routeTarget: farmMonitorPriorityAction\.routeTarget/);
  assert.match(panel, /const farmMonitorPriorityRouteReceiptActive = farmMonitorBriefRouteReceipt === farmMonitorPriorityAction\.kind/);
  assert.match(panel, /const farmControlConsoleFocusRouteReceiptActive = Boolean\([\s\S]*farmControlConsoleFocusReceipt[\s\S]*farmMonitorBriefRouteReceipt === farmControlConsoleFocusReceipt\.actionKind/);
  assert.match(panel, /const farmControlConsoleFocusActionReceiptActive = Boolean\([\s\S]*farmControlConsoleFocusReceipt[\s\S]*farmPriorityActionReceipt === farmControlConsoleFocusReceipt\.actionKind/);
  assert.match(panel, /data-farm-control-console-focus-request=\{priorityFocusRequestId \|\| undefined\}/);
  assert.match(panel, /data-farm-control-console-focus-section=\{farmMonitorBriefSection\}/);
  assert.match(panel, /data-farm-control-console-focus-section-label=\{farmMonitorBriefSectionLabel\}/);
  assert.match(panel, /data-farm-control-console-focus-receipt=\{farmControlConsoleFocusReceipt \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-control-console-focus-receipt-tone=\{farmControlConsoleFocusReceipt\?\.tone\}/);
  assert.match(panel, /data-farm-control-console-focus-route-receipt=\{farmControlConsoleFocusRouteReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-control-console-focus-action-receipt=\{farmControlConsoleFocusActionReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /className="t8-farm-story-panel__control-focus-receipt"/);
  assert.match(panel, /data-farm-control-console-focus-receipt-id=\{farmControlConsoleFocusReceipt\.id\}/);
  assert.match(panel, /data-farm-control-console-focus-receipt-action=\{farmControlConsoleFocusReceipt\.actionKind\}/);
  assert.match(panel, /data-farm-control-console-focus-route-button="true"/);
  assert.match(panel, /data-farm-control-console-focus-route-receipt=\{farmControlConsoleFocusRouteReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-control-console-focus-action-receipt=\{farmControlConsoleFocusActionReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /disabled=\{farmControlConsoleFocusActionReceiptActive\}/);
  assert.match(panel, /farmControlConsoleFocusActionReceiptActive[\s\S]*\? `已接上：\$\{farmControlConsoleFocusReceipt\.primary\}/);
  assert.match(panel, /farmControlConsoleFocusRouteReceiptActive[\s\S]*\? `已指路：\$\{farmControlConsoleFocusReceipt\.routeTitle/);
  assert.match(panel, /flashFarmControlConsoleFocusReceipt\(farmControlConsoleFocusReceipt\)/);
  assert.match(panel, /\{farmControlConsoleFocusActionReceiptActive \? '已接上' : farmControlConsoleFocusRouteReceiptActive \? '已指路' : farmControlConsoleFocusReceipt\.routeLabel \? `看\$\{farmControlConsoleFocusReceipt\.routeLabel\}` : '看路线'\}/);
  assert.match(panel, /data-farm-panel-priority-route-target=\{farmMonitorPriorityAction\.routeTarget\}/);
  assert.match(panel, /data-farm-panel-priority-route-label=\{farmMonitorPriorityAction\.routeLabel\}/);
  assert.match(panel, /data-farm-panel-priority-route-receipt=\{farmMonitorPriorityRouteReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-action-receipt=\{farmMonitorPriorityActionReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /title=\{farmMonitorPriorityActionReceiptActive[\s\S]*\? `当前优先已接上：\$\{farmMonitorPriorityAction\.label\}/);
  assert.match(panel, /\{farmMonitorPriorityActionReceiptActive \? '已接上' : farmMonitorPriorityRouteReceiptActive \? '已指路' : farmMonitorBriefProgressLabel\}/);
  assert.match(panel, /const farmMonitorPriorityActionReceiptActive = farmPriorityActionReceipt === farmMonitorPriorityAction\.kind/);
  assert.match(panel, /const farmPriorityActionRouteReady = farmMonitorPriorityRouteReceiptActive[\s\S]*&& !farmMonitorPriorityActionReceiptActive/);
  assert.match(panel, /const farmPriorityActionButtonTitle = farmMonitorPriorityActionReceiptActive[\s\S]*\? `已接上当前优先：\$\{farmMonitorPriorityAction\.label\}/);
  assert.match(panel, /const farmPriorityActionButtonAriaLabel = farmMonitorPriorityActionReceiptActive[\s\S]*\? `已接上当前优先：\$\{farmMonitorPriorityAction\.label\}/);
  assert.match(panel, /const farmPriorityActionLeadLabel = farmMonitorPriorityActionReceiptActive[\s\S]*\? '已接上当前优先'[\s\S]*: farmPriorityActionRouteReady[\s\S]*\? '路线已亮，再点执行'/);
  assert.match(panel, /const farmPriorityActionStatusLabel = farmMonitorPriorityActionReceiptActive[\s\S]*farmPriorityActionRouteReady[\s\S]*\? '再点执行'/);
  assert.match(panel, /data-farm-panel-priority-action-receipt=\{farmMonitorPriorityActionReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-action-route-receipt=\{farmMonitorPriorityRouteReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-action-route-ready=\{farmPriorityActionRouteReady \? 'true' : undefined\}/);
  assert.match(panel, /title=\{farmPriorityActionButtonTitle\}/);
  assert.match(panel, /aria-label=\{farmPriorityActionButtonAriaLabel\}/);
  assert.match(panel, /aria-disabled=\{farmMonitorPriorityActionReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /disabled=\{farmMonitorPriorityActionReceiptActive\}/);
  assert.match(panel, /if \(farmMonitorPriorityActionReceiptActive\) return;/);
  assert.match(panel, /<small>\{farmPriorityActionLeadLabel\}<\/small>/);
  assert.match(panel, /<mark>\{farmPriorityActionStatusLabel\}<\/mark>/);
  assert.match(panel, /aria-label=\{farmQuickPanelToggleTitle\}/);
  assert.match(panel, /title=\{farmQuickPanelToggleTitle\}/);
  assert.match(panel, /<i aria-hidden="true" data-farm-inline-priority-dot="true" \/>/);
  assert.match(css, /\.t8-farm-story-panel__toggle \{[\s\S]*position:\s*relative[\s\S]*right:\s*auto[\s\S]*top:\s*auto/);
  assert.match(css, /\.t8-farm-story-panel__toggle-label \{[\s\S]*display:\s*none[\s\S]*pointer-events:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__toggle\[data-farm-control-console-priority\] \{[\s\S]*radial-gradient\(circle at 72% 18%[\s\S]*linear-gradient\(180deg, rgba\(255, 255, 255, \.98\)/);
  assert.match(css, /\.t8-farm-story-panel__toggle\[data-farm-control-console-auto-focus="true"\] \{[\s\S]*0 0 0 2px color-mix\(in srgb, var\(--farm-sky, #bfe8ff\) 28%, transparent\)/);
  assert.match(css, /\.t8-farm-story-panel__toggle i\[data-farm-inline-priority-dot="true"\] \{[\s\S]*position:\s*absolute[\s\S]*width:\s*7px[\s\S]*height:\s*7px/);
  assert.match(css, /\.t8-farm-story-panel__toggle\[data-farm-control-console-priority="water"\] i\[data-farm-inline-priority-dot="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__toggle\[data-farm-control-console-priority="order"\] i\[data-farm-inline-priority-dot="true"\],[\s\S]*\.t8-farm-story-panel__toggle\[data-farm-control-console-priority="visit"\] i\[data-farm-inline-priority-dot="true"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__toggle\[data-farm-control-console-priority\] \{[\s\S]*color:\s*var\(--farm-night-text-final, #2e1708\) !important/);
  assert.match(css, /Farm control console focus receipt v1/);
  assert.match(css, /\.t8-farm-story-panel__control-focus-receipt\[data-farm-control-console-focus-receipt="true"\] \{[\s\S]*grid-template-columns:\s*18px minmax\(0, 1fr\) max-content[\s\S]*animation:\s*farm-story-control-focus-receipt-pop/);
  assert.match(css, /\.t8-farm-story-panel__control-focus-receipt\[data-farm-control-console-focus-receipt="true"\] button\[data-farm-control-console-focus-route-button="true"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__control-focus-receipt\[data-farm-control-console-focus-receipt="true"\]/);
  assert.match(css, /Farm control route receipt bridge v1/);
  assert.match(css, /\.t8-farm-story-panel__control-focus-receipt\[data-farm-control-console-focus-route-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__control-focus-receipt\[data-farm-control-console-focus-action-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__control-focus-receipt\[data-farm-control-console-focus-action-receipt="true"\] button\[data-farm-control-console-focus-action-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-card\[data-farm-panel-priority-route-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-card\[data-farm-panel-priority-route-receipt="true"\] mark\[data-farm-panel-priority-progress-chip="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-card\[data-farm-panel-priority-action-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-card\[data-farm-panel-priority-action-receipt="true"\] mark\[data-farm-panel-priority-progress-chip="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-action\[data-farm-panel-priority-action-route-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-action\[data-farm-panel-priority-action-route-ready="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-action\[data-farm-panel-priority-action-route-ready="true"\] mark/);
  assert.match(panel, /data-farm-mini-status="monitor"/);
  assert.match(panel, /data-farm-mini-panel-state=\{panelOpen \? 'open' : 'closed'\}/);
  assert.doesNotMatch(panel, /data-farm-mini-status=\{panelOpen \? 'monitor' : 'collapsed'\}/);
  assert.match(panel, /data-farm-monitor-panel="true"/);
  assert.match(panel, /data-farm-monitor-layout="pasture-dashboard-v1"/);
  assert.match(panel, /data-farm-monitor-density="focused"/);
  assert.match(panel, /type FarmMonitorPriorityTone = 'water' \| 'order' \| 'visit' \| 'mature' \| 'guard' \| 'focus' \| 'stable'/);
  assert.match(panel, /const farmMonitorBriefPrimary = /);
  assert.match(panel, /const farmMonitorBriefSecondary = /);
  assert.match(panel, /const farmMonitorBriefTone: FarmMonitorPriorityTone = /);
  assert.match(panel, /const farmMonitorBriefSection: FarmPanelSectionId = /);
  assert.match(panel, /const farmMonitorBriefProgressLabel = /);
  assert.match(panel, /data-farm-mini-status-item="monitor-brief"/);
  assert.match(panel, /data-farm-monitor-group="brief"/);
  assert.match(panel, /data-farm-monitor-brief-tone=\{farmMonitorBriefTone\}/);
  assert.match(panel, /data-farm-monitor-brief-section=\{farmMonitorBriefSection\}/);
  assert.match(panel, /data-farm-monitor-brief-progress=\{farmMonitorBriefProgressLabel\}/);
  assert.match(panel, /data-farm-monitor-brief-route-button="true"/);
  assert.match(panel, /data-farm-monitor-brief-route-target=\{farmMonitorPriorityAction\.routeTarget\}/);
  assert.match(panel, /data-farm-monitor-brief-route-label=\{farmMonitorPriorityAction\.routeLabel\}/);
  assert.match(panel, /data-farm-monitor-brief-route-receipt=\{farmMonitorBriefRouteReceipt === farmMonitorPriorityAction\.kind \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-monitor-brief-action-receipt=\{farmMonitorPriorityActionReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /title=\{farmMonitorPriorityActionReceiptActive[\s\S]*\? `当前优先已接上：\$\{farmMonitorPriorityAction\.label\}/);
  assert.match(panel, /aria-label=\{farmMonitorPriorityActionReceiptActive[\s\S]*\? `当前优先已接上：\$\{farmMonitorPriorityAction\.label\}，\$\{farmMonitorPriorityAction\.detail\}，打开\$\{farmMonitorBriefSectionLabel\}`[\s\S]*: `优先指路：\$\{farmMonitorBriefPrimary\}，\$\{farmMonitorBriefSecondary\}，打开\$\{farmMonitorBriefSectionLabel\}并定位\$\{farmMonitorPriorityAction\.routeLabel \|\| farmMonitorBriefToneLabel\}`\}/);
  assert.match(panel, /if \(farmMonitorPriorityActionReceiptActive\) \{[\s\S]*setOpen\(true\);[\s\S]*setFarmPanelSectionOpen\(farmMonitorBriefSection, true\);[\s\S]*flashFarmPrioritySection\(farmMonitorBriefSection\);[\s\S]*return;[\s\S]*\}/);
  assert.match(panel, /handleFarmMonitorBriefRoute\(\);/);
  assert.match(panel, /data-farm-monitor-brief-tone-chip="true"/);
  assert.match(panel, /data-farm-monitor-brief-progress-chip="true"/);
  assert.match(panel, /\{farmMonitorPriorityActionReceiptActive \? '已接上' : farmMonitorBriefRouteReceipt === farmMonitorPriorityAction\.kind \? '已指路' : farmMonitorBriefProgressLabel\}/);
  assert.match(panel, /data-farm-panel-priority-card="true"/);
  assert.match(panel, /data-farm-panel-priority-tone=\{farmMonitorBriefTone\}/);
  assert.match(panel, /data-farm-panel-priority-section=\{farmMonitorBriefSection\}/);
  assert.match(panel, /setFarmPanelSectionOpen\(farmMonitorBriefSection, true\)/);
  assert.match(panel, /const \[farmPrioritySectionReceipt, setFarmPrioritySectionReceipt\] = useState<FarmPanelSectionId \| ''>\(''\)/);
  assert.match(panel, /const farmPrioritySectionTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmPrioritySectionScrollFrameRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const \[farmMonitorBriefRouteReceipt, setFarmMonitorBriefRouteReceipt\] = useState<FarmPriorityActionKind \| ''>\(''\)/);
  assert.match(panel, /const farmMonitorBriefRouteTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const flashFarmPrioritySection = useCallback\(\(sectionId: FarmPanelSectionId\) => \{/);
  assert.match(panel, /farmPrioritySectionScrollFrameRef\.current = window\.requestAnimationFrame\(\(\) => \{/);
  assert.match(panel, /priorityElement\?\.scrollIntoView\(\{ block: 'nearest', behavior: priorityScrollBehavior \}\)/);
  assert.match(panel, /data-farm-panel-priority-receipt=\{farmPrioritySectionReceipt === farmMonitorBriefSection \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-section-priority=\{farmMonitorBriefSection === item\.id \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-section-priority-receipt=\{farmPrioritySectionReceipt === item\.id \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-content=\{farmPrioritySectionReceipt === 'tools' \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-content=\{farmPrioritySectionReceipt === 'build' \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-content=\{farmPrioritySectionReceipt === 'focus' \? 'true' : undefined\}/);
  assert.match(panel, /type FarmPriorityActionKind = 'water-route' \| 'order-submit' \| 'visit-deliver' \| 'mature-route' \| 'guard-route' \| 'focus-action' \| 'activity-open'/);
  assert.match(panel, /type FarmPriorityQueueActionKind = FarmPriorityActionKind \| 'focus-next' \| 'activity-next' \| 'order-next' \| 'visit-next'/);
  assert.match(panel, /type FarmPriorityComboSource = 'priority' \| 'queue'/);
  assert.match(panel, /interface FarmPriorityAction/);
  assert.match(panel, /interface FarmPriorityQueueItem/);
  assert.match(panel, /interface FarmPriorityComboReceipt/);
  assert.match(panel, /interface FarmPriorityFlowReceipt/);
  assert.match(panel, /impactLabel: string;/);
  assert.match(panel, /reasonLabel: string;/);
  assert.match(panel, /safetyLabel: string;/);
  assert.match(panel, /const \[farmPriorityActionReceipt, setFarmPriorityActionReceipt\] = useState<FarmPriorityActionKind \| ''>\(''\)/);
  assert.match(panel, /const \[farmPriorityQueueReceipt, setFarmPriorityQueueReceipt\] = useState<string>\(''\)/);
  assert.match(panel, /const \[farmPriorityQueueRouteReceipt, setFarmPriorityQueueRouteReceipt\] = useState<string>\(''\)/);
  assert.match(panel, /const \[farmPriorityComboReceipt, setFarmPriorityComboReceipt\] = useState<FarmPriorityComboReceipt \| null>\(null\)/);
  assert.match(panel, /const \[farmPriorityFlowReceipt, setFarmPriorityFlowReceipt\] = useState<FarmPriorityFlowReceipt \| null>\(null\)/);
  assert.match(panel, /const farmPriorityActionTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmPriorityQueueTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmPriorityQueueRouteTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmPriorityComboTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmPriorityFlowTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmMonitorPriorityAction: FarmPriorityAction = /);
  assert.match(panel, /const farmPriorityQueueItems: FarmPriorityQueueItem\[\] = /);
  assert.match(panel, /const farmPriorityQueueRoutePreviewItem = farmPriorityQueueItems\.find\(\(item\) => item\.routeTarget\)/);
  assert.match(panel, /const farmPriorityComboExcludedQueueId = farmPriorityComboReceipt\?\.source === 'queue' \? farmPriorityQueueReceipt : ''/);
  assert.match(panel, /const farmPriorityComboNextItem = farmPriorityComboReceipt[\s\S]*farmPriorityQueueItems\.find\(\(item\) => item\.id !== farmPriorityComboExcludedQueueId && item\.routeTarget\)/);
  assert.match(panel, /const farmPriorityComboNextRouteReceipt = Boolean\(/);
  assert.match(panel, /const farmPriorityComboNextMode = farmPriorityComboNextItem/);
  assert.match(panel, /const farmPriorityComboNextActionLabel = farmPriorityComboNextItem/);
  assert.match(panel, /const farmPriorityComboNextButtonLabel = farmPriorityComboNextItem/);
  assert.match(panel, /farmPriorityComboNextRouteReceipt[\s\S]*\? farmPriorityComboNextActionLabel/);
  assert.match(panel, /const farmPriorityFlowNextRouteReceipt = Boolean\(/);
  assert.match(panel, /const farmPriorityFlowNextLiveItem = farmPriorityFlowReceipt\?\.nextItemId/);
  assert.match(panel, /const farmPriorityFlowNextStale = Boolean\(farmPriorityFlowReceipt\?\.nextItemId && !farmPriorityFlowNextLiveItem\)/);
  assert.match(panel, /const farmPriorityFlowNextActionReady = Boolean\(farmPriorityFlowNextLiveItem && farmPriorityFlowNextRouteReceipt\)/);
  assert.match(panel, /const farmPriorityFlowNextMode = farmPriorityFlowReceipt\?\.nextLabel/);
  assert.match(panel, /const farmPriorityFlowNextActionLabel = farmPriorityFlowNextLiveItem/);
  assert.match(panel, /const farmPriorityFlowNextButtonLabel = farmPriorityFlowReceipt\?\.nextLabel/);
  assert.match(panel, /farmPriorityFlowNextStale[\s\S]*\? '队列已刷新'/);
  assert.match(panel, /farmPriorityFlowNextActionReady[\s\S]*\? farmPriorityFlowNextActionLabel/);
  assert.match(panel, /const farmPriorityFlowMiniNextLabel = farmPriorityFlowReceipt\?\.nextLabel/);
  assert.match(panel, /const farmPriorityFlowMiniTitle = farmPriorityFlowReceipt/);
  assert.match(panel, /farmPriorityFlowNextActionReady[\s\S]*\? `\$\{farmPriorityFlowNextActionLabel\}可接上`/);
  assert.match(panel, /const farmPriorityReceiptNextSnapshot = \(item\?: FarmPriorityQueueItem\) => item/);
  assert.match(panel, /const flashFarmPriorityAction = useCallback\(\(kind: FarmPriorityActionKind\) => \{/);
  assert.match(panel, /const flashFarmMonitorBriefRoute = useCallback\(\(kind: FarmPriorityActionKind\) => \{/);
  assert.match(panel, /setFarmMonitorBriefRouteReceipt\(kind\)/);
  assert.match(panel, /setFarmMonitorBriefRouteReceipt\(''\)/);
  assert.match(panel, /const flashFarmPriorityQueue = useCallback\(\(itemId: string\) => \{/);
  assert.match(panel, /const flashFarmPriorityQueueRoute = useCallback\(\(itemId: string\) => \{/);
  assert.match(panel, /const flashFarmPriorityCombo = useCallback\(\(actionLabel: string, source: FarmPriorityComboSource\) => \{/);
  assert.match(panel, /const flashFarmPriorityFlowReceipt = useCallback\(\(receipt: Omit<FarmPriorityFlowReceipt, 'id'>\) => \{/);
  assert.match(panel, /const nextCount = Math\.min\(\(current\?\.count \|\| 0\) \+ 1, 9\)/);
  assert.match(panel, /const comboLabel = nextCount >= 5 \? '丰收连击' : nextCount >= 3 \? '顺手连击' : '节奏接上'/);
  assert.match(panel, /const handleFarmMonitorPriorityAction = \(\) => \{/);
  assert.match(panel, /const handleFarmMonitorBriefRoute = \(\) => \{/);
  assert.match(panel, /setOpen\(true\);\s*setFarmPanelSectionOpen\(farmMonitorPriorityAction\.section, true\);\s*flashFarmPrioritySection\(farmMonitorPriorityAction\.section\);\s*flashFarmMonitorBriefRoute\(farmMonitorPriorityAction\.kind\);/);
  assert.match(panel, /message: `优先指路：\$\{farmMonitorPriorityAction\.label\} · \$\{farmMonitorPriorityAction\.detail\}`/);
  assert.match(panel, /const handleFarmPriorityQueueAction = \(item: FarmPriorityQueueItem\) => \{/);
  assert.match(panel, /const handleFarmPriorityQueueRoutePreview = \(item: FarmPriorityQueueItem\) => \{/);
  assert.match(panel, /const handleFarmPriorityFlowReceiptNextRoute = \(\) => \{/);
  assert.match(panel, /if \(farmPriorityFlowNextStale\) return;/);
  assert.match(panel, /if \(farmPriorityFlowNextActionReady && farmPriorityFlowNextLiveItem\) \{\s*handleFarmPriorityQueueAction\(farmPriorityFlowNextLiveItem\);\s*return;\s*\}/);
  assert.match(panel, /handleFarmMonitorPriorityAction\(\);/);
  assert.match(panel, /handleFarmPriorityQueueAction\(item\);/);
  assert.match(panel, /handleFarmPriorityQueueRoutePreview\(farmPriorityQueueRoutePreviewItem\);/);
  assert.match(panel, /flashFarmPriorityCombo\(farmMonitorPriorityAction\.label, 'priority'\);/);
  assert.match(panel, /flashFarmPriorityCombo\(item\.actionLabel \|\| item\.label, 'queue'\);/);
  assert.match(panel, /flashFarmPriorityFlowReceipt\(\{[\s\S]*source: 'priority'[\s\S]*\.\.\.farmPriorityReceiptNextSnapshot\(nextItemAfterPriority\)/);
  assert.match(panel, /flashFarmPriorityFlowReceipt\(\{[\s\S]*source: 'queue'[\s\S]*\.\.\.farmPriorityReceiptNextSnapshot\(nextItemAfterQueue\)/);
  assert.match(panel, /data-farm-panel-priority-action="true"/);
  assert.match(panel, /data-farm-panel-priority-action-kind=\{farmMonitorPriorityAction\.kind\}/);
  assert.match(panel, /data-farm-panel-priority-action-section=\{farmMonitorPriorityAction\.section\}/);
  assert.match(panel, /data-farm-panel-priority-action-route-target=\{farmMonitorPriorityAction\.routeTarget\}/);
  assert.match(panel, /data-farm-panel-priority-action-receipt=\{farmMonitorPriorityActionReceiptActive \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-combo="true"/);
  assert.match(panel, /data-farm-panel-priority-combo-count=\{farmPriorityComboReceipt\.count\}/);
  assert.match(panel, /data-farm-panel-priority-combo-source=\{farmPriorityComboReceipt\.source\}/);
  assert.match(panel, /data-farm-panel-priority-combo-next-item=\{farmPriorityComboNextItem\?\.id\}/);
  assert.match(panel, /data-farm-panel-priority-combo-next-route=\{farmPriorityComboNextItem\?\.routeTarget\}/);
  assert.match(panel, /data-farm-panel-priority-combo-next-label=\{farmPriorityComboNextItem\?\.label\}/);
  assert.match(panel, /data-farm-panel-priority-combo-next-mode=\{farmPriorityComboNextMode\}/);
  assert.match(panel, /data-farm-panel-priority-combo-next-action-kind=\{farmPriorityComboNextItem\?\.kind\}/);
  assert.match(panel, /data-farm-panel-priority-combo-next="true"/);
  assert.match(panel, /data-farm-panel-priority-combo-next-action-button=\{farmPriorityComboNextRouteReceipt \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-combo-next-route-button=\{farmPriorityComboNextItem\.routeTarget \? 'true' : undefined\}/);
  assert.match(panel, /if \(farmPriorityComboNextRouteReceipt\) \{\s*handleFarmPriorityQueueAction\(farmPriorityComboNextItem\);\s*return;\s*\}/);
  assert.match(panel, /handleFarmPriorityQueueRoutePreview\(farmPriorityComboNextItem\);/);
  assert.match(panel, /data-farm-mini-priority-combo=\{farmPriorityComboReceipt \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-priority-combo-next=\{farmPriorityComboNextItem\?\.label \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-priority-combo-next-mode=\{farmPriorityComboNextMode\}/);
  assert.match(panel, /data-farm-mini-priority-combo-route-receipt=\{farmPriorityComboNextRouteReceipt \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-priority-flow=\{farmPriorityFlowReceipt \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-priority-flow-action=\{farmPriorityFlowReceipt\?\.actionLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-priority-flow-next-mode=\{farmPriorityFlowNextMode\}/);
  assert.match(panel, /data-farm-mini-priority-flow-next-live=\{farmPriorityFlowNextLiveItem \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-priority-flow-next-stale=\{farmPriorityFlowNextStale \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-priority-flow-route-receipt=\{farmPriorityFlowNextRouteReceipt \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-priority-flow-next-status=\{farmPriorityFlowMiniNextLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="priority-combo"/);
  assert.match(panel, /data-farm-mini-status-item="priority-flow"/);
  assert.match(panel, /data-farm-monitor-group="combo"/);
  assert.match(panel, /data-farm-monitor-group="flow"/);
  assert.match(panel, /刚接上 \$\{farmPriorityFlowReceipt \? `\$\{farmPriorityFlowReceipt\.actionLabel\}，\$\{farmPriorityFlowMiniNextLabel \|\| '节奏稳定'\}` : '暂无'\}/);
  assert.match(panel, /已指路 \$\{farmPriorityComboNextItem\.routeLabel \|\| farmPriorityComboNextItem\.label\}/);
  assert.match(panel, /可接上/);
  assert.match(panel, /data-farm-panel-priority-flow-receipt="true"/);
  assert.match(panel, /data-farm-panel-priority-flow-source=\{farmPriorityFlowReceipt\.source\}/);
  assert.match(panel, /data-farm-panel-priority-flow-next=\{farmPriorityFlowReceipt\.nextLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-panel-priority-flow-next-route=\{farmPriorityFlowReceipt\.nextRouteTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-panel-priority-flow-next-live=\{farmPriorityFlowNextLiveItem \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-flow-next-stale=\{farmPriorityFlowNextStale \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-flow-next-mode=\{farmPriorityFlowNextMode\}/);
  assert.match(panel, /data-farm-panel-priority-flow-next-route-receipt=\{farmPriorityFlowNextRouteReceipt \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-flow-meta="true"/);
  assert.match(panel, /data-farm-panel-priority-flow-next-button="true"/);
  assert.match(panel, /data-farm-panel-priority-flow-next-action-button=\{farmPriorityFlowNextActionReady \? 'true' : undefined\}/);
  assert.match(panel, /disabled=\{farmPriorityFlowNextStale\}/);
  assert.match(panel, /handleFarmPriorityFlowReceiptNextRoute\(\);/);
  assert.match(panel, /data-farm-panel-priority-queue="true"/);
  assert.match(panel, /data-farm-panel-priority-queue-count=\{farmPriorityQueueItems\.length\}/);
  assert.match(panel, /data-farm-panel-priority-queue-empty=\{farmPriorityQueueItems\.length === 0 \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-queue-route-preview=\{farmPriorityQueueRoutePreviewItem\?\.id\}/);
  assert.match(panel, /data-farm-panel-priority-queue-route-receipt=\{farmPriorityQueueRouteReceipt \|\| undefined\}/);
  assert.match(panel, /data-farm-panel-priority-queue-route-button="true"/);
  assert.match(panel, /disabled=\{!farmPriorityQueueRoutePreviewItem\}/);
  assert.match(panel, /data-farm-panel-priority-queue-empty-note="true"/);
  assert.match(panel, /farmPriorityQueueItems\.slice\(0, 3\)\.map\(\(item\) => \(/);
  assert.match(panel, /data-farm-panel-priority-queue-item=\{item\.id\}/);
  assert.match(panel, /data-farm-panel-priority-queue-kind=\{item\.kind\}/);
  assert.match(panel, /data-farm-panel-priority-queue-section=\{item\.section\}/);
  assert.match(panel, /data-farm-panel-priority-queue-route-target=\{item\.routeTarget\}/);
  assert.match(panel, /data-farm-panel-priority-queue-receipt=\{farmPriorityQueueReceipt === item\.id \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-priority-queue-impact-label=\{item\.impactLabel\}/);
  assert.match(panel, /data-farm-panel-priority-queue-reason-label=\{item\.reasonLabel\}/);
  assert.match(panel, /data-farm-panel-priority-queue-safety-label=\{item\.safetyLabel\}/);
  assert.match(panel, /data-farm-panel-priority-queue-meta="true"/);
  assert.match(panel, /data-farm-panel-priority-queue-impact="true"/);
  assert.match(panel, /data-farm-panel-priority-queue-reason="true"/);
  assert.match(panel, /data-farm-panel-priority-queue-safety="true"/);
  assert.match(panel, /data-farm-panel-priority-queue-action-label="true"/);
  assert.match(panel, /farmPriorityQueueItems\.some\(\(current\) => current\.id === item\.id\)/);
  assert.match(panel, /impactLabel: `进度 \$\{goal\.progress\}\/\$\{goal\.target\}`/);
  assert.match(panel, /impactLabel: `缺水 \$\{dryCount\}块`/);
  assert.match(panel, /safetyLabel: waterAmount > 0 \? '点了切水壶' : '只打开线索'/);
  assert.match(panel, /reasonLabel: orderReady \? `奖励 \$\{currentOrderRewardLabel\}` : '先看差料'/);
  assert.match(panel, /reasonLabel: npcVisitReady \? `谢礼 \$\{formatFarmReward\(activeNpcVisit\.rewards\)\}` : '先看材料'/);
  assert.ok(panel.includes("focusQueueItem(primaryFarmFocus, `queue-focus-${primaryFarmFocus.id}`, 'focus-next', 'focus', '目标：');"));
  assert.ok(panel.includes("focusQueueItem(farmActivityRewardStreakGoal, `queue-activity-${farmActivityRewardStreakGoal.id}`, 'activity-next', 'activity', '连击：');"));
  assert.match(panel, /kind: 'order-next'/);
  assert.match(panel, /kind: 'visit-next'/);
  assert.match(panel, /routeTarget: waterAmount > 0 \? 'water' : 'building-yield-summary'/);
  assert.match(panel, /onSelectTool\?\.\('water'\)/);
  assert.match(panel, /if \(waterAmount > 0\) \{[\s\S]*onSelectTool\?\.\('water'\)[\s\S]*return;[\s\S]*\}[\s\S]*handleOpenFarmBuildingEffects\(\)/);
  assert.match(panel, /onSelectTool\?\.\('harvest'\)/);
  assert.match(panel, /onJumpToMature\?\.\(\)/);
  assert.match(panel, /handleFarmCompleteCurrentOrder\(\)/);
  assert.match(panel, /flashFarmNpcDelivery\(activeNpcVisit\.id\)/);
  assert.match(panel, /onCompleteNpcVisit\?\.\(activeNpcVisit\.id\)/);
  assert.match(panel, /onSelectBuilding\?\.\('scarecrow'\)/);
  assert.match(panel, /handleFarmFocusAction\(primaryFarmFocus\)/);
  assert.match(panel, /data-farm-monitor-rail="compact-clean-v2"/);
  assert.match(panel, /data-farm-monitor-active-label=\{farmMonitorBriefPrimary\}/);
  assert.match(panel, /data-farm-monitor-active-summary=\{farmMonitorBriefSecondary\}/);
  assert.match(panel, /data-farm-monitor-brief-label-chip="true">优先<\/strong>/);
  assert.match(panel, /data-farm-monitor-group="rhythm"/);
  assert.match(panel, /data-farm-monitor-group="resource"/);
  assert.match(panel, /data-farm-monitor-group="agenda"/);
  assert.match(panel, /data-farm-monitor-group="tool"/);
  assert.match(panel, /<strong>牧场控制台<\/strong>/);
  assert.match(panel, /<em>操作<\/em>/);
  assert.match(css, /\.t8-farm-story-panel \{[\s\S]*--farm-control-panel-width:\s*min\(420px, calc\(100vw - 32px\)\)/);
  assert.match(css, /--farm-top-rail-clearance:\s*clamp\(720px, 42vw, 900px\)/);
  assert.match(css, /\.t8-farm-story-panel \{[\s\S]*flex:\s*0 0 auto/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \{[\s\S]*position:\s*fixed[\s\S]*left:\s*12px[\s\S]*right:\s*max\(calc\(var\(--farm-control-panel-width\) \+ 54px\), var\(--farm-top-rail-clearance\)\)[\s\S]*top:\s*56px[\s\S]*bottom:\s*auto[\s\S]*max-width:\s*none/);
  assert.match(css, /\.t8-farm-story-panel:not\(\.is-open\) \.t8-farm-story-panel__mini-status \{[\s\S]*right:\s*max\(calc\(var\(--farm-control-panel-width\) \+ 54px\), var\(--farm-top-rail-clearance\)\)/);
  assert.match(css, /\.t8-main-layout\[data-sidebar-collapsed="false"\] \.t8-farm-story-panel__mini-status \{[\s\S]*left:\s*calc\(var\(--t8-sidebar-width, 256px\) \+ 12px\)/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \{[\s\S]*display:\s*flex[\s\S]*flex-wrap:\s*nowrap[\s\S]*min-height:\s*60px[\s\S]*max-height:\s*60px/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before \{[\s\S]*content:\s*"FARM STORY\\A牧场看板"/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] button\[data-farm-mini-status-item\] \{[\s\S]*pointer-events:\s*none[\s\S]*cursor:\s*default/);
  const farmMiniDesktopMediaStart = css.indexOf('@media (min-width: 760px) {');
  assert.ok(farmMiniDesktopMediaStart >= 0, 'Farm mini status desktop media query should exist');
  const farmMiniDesktopMediaBlock = css.slice(farmMiniDesktopMediaStart, farmMiniDesktopMediaStart + 360);
  assert.match(farmMiniDesktopMediaBlock, /\.t8-farm-story-panel__mini-status,[\s\S]*\.t8-farm-story-panel:not\(\.is-open\) \.t8-farm-story-panel__mini-status/);
  assert.match(farmMiniDesktopMediaBlock, /right:\s*max\(calc\(var\(--farm-control-panel-width\) \+ 54px\), var\(--farm-top-rail-clearance\)\)/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \{[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \{[\s\S]*display:\s*flex[\s\S]*flex-wrap:\s*wrap/);
  assert.match(css, /\.t8-farm-story-panel__panel \{[\s\S]*position:\s*fixed[\s\S]*right:\s*18px[\s\S]*top:\s*104px[\s\S]*width:\s*var\(--farm-control-panel-width\)[\s\S]*max-height:\s*calc\(100vh - 120px\)[\s\S]*display:\s*flex[\s\S]*flex-direction:\s*column[\s\S]*overflow:\s*auto/);
  assert.match(css, /\.t8-farm-story-panel__stats \{[\s\S]*display:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__tools \{[\s\S]*order:\s*2/);
  assert.match(css, /\.t8-farm-story-panel__palette \{[\s\S]*order:\s*3/);
  assert.match(css, /\[data-farm-mini-status-item="dry"\][\s\S]*order:\s*10/);
  assert.match(css, /\[data-farm-mini-status-item="withered"\][\s\S]*order:\s*10/);
  assert.match(css, /\[data-farm-mini-status-item="focus-action"\][\s\S]*order:\s*11/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-status-item="activity-streak-milestone"\][\s\S]*display:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-status-item\^="building-"\][\s\S]*display:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-status-item="animal"\][\s\S]*display:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item="beauty-route"\][\s\S]*display:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item="focus-action"\][\s\S]*display:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item="tool"\][\s\S]*display:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item="wood"\][\s\S]*display:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item="stone"\][\s\S]*display:\s*none/);
  assert.match(css, /Farm command deck polish v2/);
  assert.match(css, /--farm-command-deck-clearance:\s*clamp\(780px, 40vw, 1040px\)/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-rail="compact-clean-v2"\] \{[\s\S]*right:\s*max\(calc\(var\(--farm-control-panel-width\) \+ 72px\), var\(--farm-command-deck-clearance\)\)[\s\S]*min-height:\s*var\(--farm-command-deck-strip-height\)[\s\S]*max-height:\s*var\(--farm-command-deck-strip-height\)/);
  assert.doesNotMatch(css, /\.t8-farm-story-panel:not\(\.is-open\) \.t8-farm-story-panel__mini-status\[data-farm-monitor-rail="compact-clean-v2"\] \{[^}]*right:\s*var\(--farm-command-deck-clearance\) !important/);
  assert.match(css, /\[data-farm-monitor-brief-label-chip="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-rail="compact-clean-v2"\] \[data-farm-monitor-group="brief"\] \{[\s\S]*display:\s*inline-grid !important[\s\S]*grid-template-columns:\s*14px max-content minmax\(52px, 1fr\) max-content max-content/);
  assert.match(css, /Farm browser QA readable header brand v1/);
  assert.match(css, /\.t8-farm-story-panel__panel\[data-farm-panel-readable="large"\] \.t8-farm-story-panel__header span \{[\s\S]*font-size:\s*11px !important[\s\S]*line-height:\s*1\.12/);
  assert.match(globalCss, /Farm browser QA readable header brand v1/);
  assert.match(globalCss, /\.t8-canvas-shell\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__panel\[data-farm-panel-readable="large"\] \.t8-farm-story-panel__header span \{[\s\S]*font-size:\s*11px !important[\s\S]*-webkit-text-fill-color:\s*currentColor !important/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-mirror="top-monitor"\]\[data-farm-quick-actions-density="compact-readable"\] \{[\s\S]*right:\s*var\(--farm-command-deck-clearance\)[\s\S]*top:\s*calc\(56px \+ var\(--farm-command-deck-strip-height\) \+ var\(--farm-command-deck-gap\)\)/);
  const farmQuickToolBlock = panel.match(/const FARM_TOOLS = \[([\s\S]*?)\];/);
  assert.ok(farmQuickToolBlock, 'Farm quick tool registry should be statically visible');
  [
    ['select', '选择'],
    ['hoe', '锄地'],
    ['seed', '播种'],
    ['water', '浇水'],
    ['harvest', '收获'],
    ['shovel', '铲除'],
    ['build', '建造'],
    ['decor', '装饰'],
    ['move', '移动'],
    ['delete', '删除'],
  ].forEach(([toolId, label]) => {
    assert.match(farmQuickToolBlock[1], new RegExp(`id: '${toolId}' as const, label: '${label}'`));
  });
  assert.match(panel, /FARM_TOOLS\.map\(\(tool\) =>/);
  assert.doesNotMatch(panel, /FARM_TOOLS\.slice/);
  const farmQuickFullStripStart = css.indexOf('/* Farm quick action full strip v1. */');
  assert.ok(farmQuickFullStripStart > css.indexOf('/* Farm browser QA quick action clearance v1. */'));
  const farmQuickFullStripCss = css.slice(farmQuickFullStripStart);
  assert.match(farmQuickFullStripCss, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-mirror="top-monitor"\]\[data-farm-quick-actions-density="compact-readable"\] \{[\s\S]*grid-template-columns:\s*repeat\(6, minmax\(0, max-content\)\)[\s\S]*overflow-x:\s*visible !important[\s\S]*overflow-y:\s*visible !important[\s\S]*max-height:\s*none !important/);
  assert.match(farmQuickFullStripCss, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-mirror="top-monitor"\]\[data-farm-quick-actions-density="compact-readable"\] button \{[\s\S]*min-width:\s*58px !important[\s\S]*max-height:\s*none !important/);
  assert.match(css, /button\[data-farm-quick-panel-toggle="true"\]/);
  assert.match(css, /button\[data-farm-quick-panel-state="open"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__mini-status\[data-farm-monitor-rail="compact-clean-v2"\]/);
  assert.match(css, /Farm quick panel priority hint v1/);
  assert.match(css, /button\[data-farm-quick-panel-toggle="true"\]\[data-farm-quick-panel-priority\] \{[\s\S]*grid-template-columns:\s*16px max-content minmax\(48px, 96px\) max-content[\s\S]*max-width:\s*226px/);
  assert.match(css, /button\[data-farm-quick-panel-toggle="true"\]\[data-farm-quick-panel-priority-open="true"\]/);
  assert.match(css, /button\[data-farm-quick-panel-auto-focus="true"\] \{[\s\S]*border-color:\s*color-mix\(in srgb, var\(--farm-sky, #bfe8ff\) 62%, var\(--farm-leaf\)\)/);
  assert.match(css, /button\[data-farm-quick-panel-auto-focus="true"\] em \{[\s\S]*linear-gradient\(180deg, rgba\(255, 255, 255, \.96\), color-mix\(in srgb, var\(--farm-mint, #dff5c1\) 76%, var\(--farm-sky, #bfe8ff\)\)\)/);
  assert.match(css, /b\[data-farm-quick-panel-priority-chip="true"\] \{[\s\S]*max-width:\s*96px[\s\S]*font-size:\s*11px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /button\[data-farm-quick-panel-priority="water"\] b\[data-farm-quick-panel-priority-chip="true"\]/);
  assert.match(css, /button\[data-farm-quick-panel-priority="order"\] b\[data-farm-quick-panel-priority-chip="true"\],[\s\S]*button\[data-farm-quick-panel-priority="visit"\] b\[data-farm-quick-panel-priority-chip="true"\]/);
  assert.match(css, /button\[data-farm-quick-panel-priority="stable"\] b\[data-farm-quick-panel-priority-chip="true"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-mirror="top-monitor"\] button\[data-farm-quick-panel-toggle="true"\]\[data-farm-quick-panel-priority\],[\s\S]*\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-mirror="top-monitor"\] b\[data-farm-quick-panel-priority-chip="true"\] \{[\s\S]*color:\s*var\(--farm-night-text-final, #2e1708\) !important/);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*button\[data-farm-quick-panel-toggle="true"\]\[data-farm-quick-panel-priority\] \{[\s\S]*max-width:\s*188px/);
  assert.match(panel, /const FARM_PANEL_SECTION_STORAGE_KEY = 't8-farm-story-panel-sections-v1'/);
  assert.match(panel, /type FarmPanelSectionId = 'feedback' \| 'season' \| 'focus' \| 'beauty' \| 'guide' \| 'tools' \| 'build' \| 'building' \| 'animals' \| 'visits' \| 'summary' \| 'activity' \| 'actions'/);
  assert.match(panel, /function readFarmPanelSectionExpanded\(\): FarmPanelSectionExpandedState/);
  assert.match(panel, /const \[farmPanelSectionExpanded, setFarmPanelSectionExpanded\] = useState<FarmPanelSectionExpandedState>\(readFarmPanelSectionExpanded\)/);
  assert.match(panel, /window\.localStorage\.setItem\(FARM_PANEL_SECTION_STORAGE_KEY, JSON\.stringify\(farmPanelSectionExpanded\)\)/);
  assert.match(panel, /const activeEntry = Object\.entries\(parsed\)\.find\(\(\[key, value\]\) => FARM_PANEL_SECTION_ID_SET\.has\(key\) && value === true\)/);
  assert.match(panel, /type FarmPanelSectionPresetId = 'priority' \| 'daily' \| 'close-all'/);
  assert.match(panel, /interface FarmPanelSectionPresetReceipt/);
  assert.match(panel, /presetId: FarmPanelSectionPresetId;/);
  assert.match(panel, /targetSection\?: FarmPanelSectionId;/);
  assert.match(panel, /const FARM_PANEL_DAILY_SECTION_IDS: FarmPanelSectionId\[\] = \['feedback', 'focus', 'tools', 'activity'\]/);
  assert.match(panel, /const \[farmPanelSectionPresetReceipt, setFarmPanelSectionPresetReceipt\] = useState<FarmPanelSectionPresetReceipt \| null>\(null\)/);
  assert.match(panel, /const farmPanelSectionPresetTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const flashFarmPanelSectionPreset = useCallback\(\(receipt: FarmPanelSectionPresetReceipt\) => \{/);
  assert.match(panel, /setFarmPanelSectionPresetReceipt\(receipt\)/);
  assert.match(panel, /setFarmPanelSectionPresetReceipt\(null\)/);
  assert.match(panel, /farmPanelSectionPresetTimerRef\.current = window\.setTimeout\(\(\) => \{/);
  assert.match(panel, /if \(farmPanelSectionPresetTimerRef\.current !== null\) \{\s*window\.clearTimeout\(farmPanelSectionPresetTimerRef\.current\);\s*farmPanelSectionPresetTimerRef\.current = null;\s*\}/);
  assert.match(panel, /const farmPanelOpenSectionCount = FARM_PANEL_SECTION_IDS\.filter\(\(id\) => isFarmPanelSectionExpanded\(id\)\)\.length/);
  assert.match(panel, /const farmPanelDailyOpenSectionCount = FARM_PANEL_DAILY_SECTION_IDS\.filter\(\(id\) => isFarmPanelSectionExpanded\(id\)\)\.length/);
  assert.match(panel, /const farmPanelPriorityPresetActive = farmPanelOpenSectionCount === 1 && isFarmPanelSectionExpanded\(farmMonitorBriefSection\)/);
  assert.match(panel, /const applyFarmPanelSectionPreset = \(presetId: FarmPanelSectionPresetId\) => \{/);
  assert.match(panel, /const activeFarmPanelSectionId = FARM_PANEL_SECTION_IDS\.find\(\(id\) => isFarmPanelSectionExpanded\(id\)\) \|\| ''/);
  assert.match(panel, /const activeFarmPanelSectionItem = farmPanelSectionItems\.find\(\(item\) => item\.id === activeFarmPanelSectionId\)/);
  assert.match(panel, /const farmPanelRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(panel, /useEffect\(\(\) => \{[\s\S]*!panelOpen \|\| !activeFarmPanelSectionId[\s\S]*panelElement\.dataset\.farmPanelLayout !== 'split-detail'[\s\S]*panelElement\.scrollTo\(\{ top: 0, left: 0, behavior: 'auto' \}\)[\s\S]*\}, \[activeFarmPanelSectionId, panelOpen\]\)/);
  assert.match(panel, /const syncDetailHeight = \(\) => \{[\s\S]*panelElement\.style\.setProperty\('--farm-panel-detail-height', `\$\{panelElement\.getBoundingClientRect\(\)\.height\}px`\)/);
  assert.match(panel, /const resizeObserver = typeof ResizeObserver !== 'undefined' \? new ResizeObserver\(syncDetailHeight\) : null/);
  assert.match(panel, /panelElement\.style\.removeProperty\('--farm-panel-detail-height'\)/);
  assert.match(panel, /setFarmPanelSectionExpanded\(\(current\) => \{[\s\S]*if \(!expanded\) return current\[id\] === true \? \{\} : current;[\s\S]*return \{ \[id\]: true \};[\s\S]*\}\)/);
  assert.match(panel, /setFarmPanelSectionExpanded\(\(current\) => current\[id\] === true \? \{\} : \{ \[id\]: true \}\)/);
  assert.match(panel, /setFarmPanelSectionExpanded\(\(\) => presetSection \? \{ \[presetSection\]: true \} : \{\}\)/);
  assert.match(panel, /flashFarmPanelSectionPreset\(\{[\s\S]*presetId,[\s\S]*label: presetId === 'priority' \? '已打开优先' : presetId === 'daily' \? '常用已切换' : '已全部收起'/);
  assert.match(panel, /detail: presetId === 'priority'[\s\S]*\? `\$\{farmMonitorBriefSectionLabel\} · \$\{farmMonitorBriefPrimary\}`[\s\S]*: presetId === 'daily'[\s\S]*\? `单栏展开：\$\{presetSectionLabel\}`[\s\S]*: '控制台已整理，保留顶部看板'/);
  assert.match(panel, /count: presetSection \? 1 : 0/);
  assert.match(panel, /targetSection: presetSection/);
  assert.match(panel, /flashFarmPrioritySection\(farmMonitorBriefSection\)/);
  assert.match(panel, /data-farm-panel-section-presets="true"/);
  assert.match(panel, /data-farm-panel-section-presets-open-count=\{farmPanelOpenSectionCount\}/);
  assert.match(panel, /data-farm-panel-section-presets-daily-count=\{farmPanelDailyOpenSectionCount\}/);
  assert.match(panel, /data-farm-panel-section-presets-priority=\{farmMonitorBriefSection\}/);
  assert.match(panel, /data-farm-panel-section-presets-receipt=\{farmPanelSectionPresetReceipt\?\.presetId \|\| undefined\}/);
  assert.match(panel, /data-farm-panel-section-presets-receipt-count=\{farmPanelSectionPresetReceipt\?\.count\}/);
  assert.match(panel, /data-farm-panel-section-presets-receipt-target=\{farmPanelSectionPresetReceipt\?\.targetSection\}/);
  assert.match(panel, /data-farm-panel-section-preset="priority"/);
  assert.match(panel, /data-farm-panel-section-preset-receipt=\{farmPanelSectionPresetReceipt\?\.presetId === 'priority' \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-section-preset-target=\{farmMonitorBriefSection\}/);
  assert.match(panel, /applyFarmPanelSectionPreset\('priority'\)/);
  assert.match(panel, /data-farm-panel-section-preset="daily"/);
  assert.match(panel, /data-farm-panel-section-preset-receipt=\{farmPanelSectionPresetReceipt\?\.presetId === 'daily' \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-section-preset-count=\{farmPanelDailyOpenSectionCount\}/);
  assert.match(panel, /applyFarmPanelSectionPreset\('daily'\)/);
  assert.match(panel, /data-farm-panel-section-preset="close-all"/);
  assert.match(panel, /data-farm-panel-section-preset-receipt=\{farmPanelSectionPresetReceipt\?\.presetId === 'close-all' \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-panel-section-preset-disabled=\{farmPanelOpenSectionCount === 0 \? 'true' : undefined\}/);
  assert.match(panel, /applyFarmPanelSectionPreset\('close-all'\)/);
  assert.match(panel, /data-farm-panel-section-preset-receipt-card="true"/);
  assert.match(panel, /data-farm-panel-section-preset-receipt-id=\{farmPanelSectionPresetReceipt\.presetId\}/);
  assert.match(panel, /data-farm-panel-section-preset-receipt-count=\{farmPanelSectionPresetReceipt\.count\}/);
  assert.match(panel, /data-farm-panel-section-preset-receipt-target=\{farmPanelSectionPresetReceipt\.targetSection\}/);
  assert.match(panel, /role="status"[\s\S]*aria-live="polite"/);
  assert.match(panel, /data-farm-panel-section-switchboard="true"/);
  assert.match(panel, /data-farm-panel-section-layout="compact-list"/);
  assert.match(panel, /data-farm-panel-layout="split-detail"/);
  assert.match(panel, /<section[\s\S]*ref=\{farmPanelRef\}[\s\S]*className="t8-farm-story-panel__panel"/);
  assert.match(panel, /data-farm-panel-active-section=\{activeFarmPanelSectionId \|\| undefined\}/);
  assert.match(panel, /data-farm-panel-section-detail-label=\{activeFarmPanelSectionItem\?\.label \|\| undefined\}/);
  assert.match(panel, /className="t8-farm-story-panel__detail-rail"[\s\S]*data-farm-panel-detail-rail="true"[\s\S]*data-farm-panel-detail-rail-active=\{activeFarmPanelSectionId \|\| undefined\}/);
  assert.match(panel, /data-farm-panel-section-detail-head="true"/);
  assert.match(panel, /data-farm-panel-section-detail-collapse="true"/);
  assert.match(panel, /setFarmPanelSectionOpen\(activeFarmPanelSectionItem\.id, false\)/);
  assert.match(css, /Farm panel split detail rail v1/);
  assert.ok(css.includes('.t8-farm-story-panel__panel:not([data-farm-section-build-open="true"]) .t8-farm-story-panel__detail-rail > .t8-farm-story-panel__palette,'));
  assert.ok(css.includes('.t8-farm-story-panel__panel:not([data-farm-section-actions-open="true"]) .t8-farm-story-panel__detail-rail > .t8-farm-story-panel__footer {\n  display: none;\n}'));
  assert.match(css, /\.t8-farm-story-panel__panel\[data-farm-panel-layout="split-detail"\] \{[\s\S]*width:\s*var\(--farm-control-panel-width\)[\s\S]*display:\s*flex[\s\S]*overflow-x:\s*hidden[\s\S]*scrollbar-gutter:\s*stable/);
  assert.match(css, /\.t8-farm-story-panel__panel\[data-farm-panel-layout="split-detail"\] > \.t8-farm-story-panel__detail-rail \{[\s\S]*position:\s*fixed[\s\S]*right:\s*calc\(18px \+ var\(--farm-control-panel-width\) \+ 12px\)[\s\S]*height:\s*var\(--farm-panel-detail-height, auto\)[\s\S]*overflow:\s*auto[\s\S]*scrollbar-gutter:\s*stable/);
  assert.match(css, /\.t8-farm-story-panel__panel\[data-farm-panel-layout="split-detail"\]:not\(\[data-farm-panel-active-section\]\) > \.t8-farm-story-panel__detail-rail \{[\s\S]*display:\s*none[\s\S]*pointer-events:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__panel\[data-farm-panel-layout="split-detail"\] > \.t8-farm-story-panel__detail-rail > \.t8-farm-story-panel__daily-route \{[\s\S]*order:\s*90/);
  assert.match(panel, /data-farm-panel-section-toggle=\{item\.id\}/);
  assert.match(panel, /data-farm-panel-section-label=\{item\.label\}/);
  assert.match(panel, /data-farm-panel-section-summary=\{item\.summary\}/);
  assert.match(panel, /aria-expanded=\{expanded\}/);
  assert.match(panel, /data-farm-section-tools-open=\{isFarmPanelSectionExpanded\('tools'\) \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-quick-actions="true"/);
  assert.match(panel, /data-farm-quick-actions-layout="toolbar-ribbon"/);
  assert.match(panel, /data-farm-quick-actions-mirror="top-monitor"/);
  assert.match(panel, /data-farm-quick-actions-density="compact-readable"/);
  assert.match(panel, /data-farm-quick-panel-toggle="true"/);
  assert.match(panel, /data-farm-quick-panel-state=\{panelOpen \? 'open' : 'closed'\}/);
  assert.match(panel, /const farmQuickPanelToggleBadge = panelOpen \? '收起' : farmMonitorBriefToneLabel/);
  assert.match(panel, /const farmQuickPanelToggleTitle = `\$\{panelOpen \? '收起' : '展开'\}牧场控制台：当前优先 \$\{farmMonitorBriefPrimary\} · \$\{farmMonitorBriefSecondary\} · \$\{farmMonitorBriefSectionLabel\}`/);
  assert.match(panel, /data-farm-quick-panel-priority=\{farmMonitorBriefTone\}/);
  assert.match(panel, /data-farm-quick-panel-priority-label=\{farmMonitorBriefPrimary\}/);
  assert.match(panel, /data-farm-quick-panel-priority-section=\{farmMonitorBriefSection\}/);
  assert.match(panel, /data-farm-quick-panel-priority-section-label=\{farmMonitorBriefSectionLabel\}/);
  assert.match(panel, /data-farm-quick-panel-priority-open=\{isFarmPanelSectionExpanded\(farmMonitorBriefSection\) \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-quick-panel-auto-section=\{farmMonitorBriefSection\}/);
  assert.match(panel, /data-farm-quick-panel-auto-section-label=\{farmMonitorBriefSectionLabel\}/);
  assert.match(panel, /data-farm-quick-panel-auto-focus=\{panelOpen \? undefined : 'true'\}/);
  assert.match(panel, /aria-label=\{farmQuickPanelToggleTitle\}/);
  assert.match(panel, /title=\{farmQuickPanelToggleTitle\}/);
  assert.match(panel, /const handleFarmQuickPanelToggle = \(\) => \{/);
  assert.match(panel, /const nextOpen = !panelOpen/);
  assert.match(panel, /if \(nextOpen\) \{\s*setFarmPanelSectionOpen\(farmMonitorBriefSection, true\);\s*flashFarmPrioritySection\(farmMonitorBriefSection\);\s*\}/);
  assert.match(panel, /setOpen\(nextOpen\)/);
  assert.doesNotMatch(panel, /setOpen\(\(value\) => !value\)/);
  assert.match(panel, /handleFarmQuickPanelToggle\(\);/);
  assert.match(panel, /data-farm-control-console-priority=\{farmMonitorBriefTone\}/);
  assert.match(panel, /data-farm-control-console-priority-section=\{farmMonitorBriefSection\}/);
  assert.match(panel, /data-farm-control-console-auto-focus=\{panelOpen \? undefined : 'true'\}/);
  assert.match(panel, /<i aria-hidden="true" data-farm-inline-priority-dot="true" \/>/);
  assert.match(panel, /<span>控制台<\/span>/);
  assert.match(panel, /<b data-farm-quick-panel-priority-chip="true">\{farmMonitorBriefPrimary\}<\/b>/);
  assert.match(panel, /<em>\{farmQuickPanelToggleBadge\}<\/em>/);
  assert.match(panel, /data-farm-quick-tool-id=\{tool\.id\}/);
  assert.match(panel, /data-farm-quick-tool-label=\{tool\.label\}/);
  assert.match(panel, /data-farm-quick-tool-summary=\{badge\?\.label \|\| '可用'\}/);
  assert.match(panel, /data-farm-quick-tool-independent-action="true"/);
  assert.match(panel, /interface FarmQuickToolRouteHint/);
  assert.match(panel, /interface FarmQuickToolAssistHint/);
  assert.match(panel, /function farmQuickToolRouteHint\(/);
  assert.match(panel, /function farmQuickToolAssistHint\(/);
  assert.match(panel, /const \[farmQuickToolRouteReceipt, setFarmQuickToolRouteReceipt\] = useState<FarmTool \| ''>\(''\)/);
  assert.match(panel, /const \[farmQuickToolAssistReceipt, setFarmQuickToolAssistReceipt\] = useState<FarmTool \| ''>\(''\)/);
  assert.match(panel, /const farmQuickToolRouteTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmQuickToolAssistTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const quickRoute = farmQuickToolRouteHint\(tool\.id,/);
  assert.match(panel, /const quickAssist = farmQuickToolAssistHint\(tool\.id,/);
  assert.match(panel, /data-farm-quick-tool-route-target=\{quickRoute\?\.routeTarget\}/);
  assert.match(panel, /data-farm-quick-tool-route-label=\{quickRoute\?\.routeLabel\}/);
  assert.match(panel, /data-farm-quick-tool-route-receipt=\{farmQuickToolRouteReceipt === tool\.id \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-quick-tool-assist-label=\{quickAssist\?\.label\}/);
  assert.match(panel, /data-farm-quick-tool-assist-target=\{quickAssist\?\.routeTarget\}/);
  assert.match(panel, /data-farm-quick-tool-assist-receipt=\{farmQuickToolAssistReceipt === tool\.id \? 'true' : undefined\}/);
  assert.match(panel, /handleFarmQuickToolAction\(tool\.id, quickRoute, quickAssist\)/);
  assert.doesNotMatch(panel, /const handleFarmQuickToolAction = \(tool: FarmTool, quickRoute\?: FarmQuickToolRouteHint, quickAssist\?: FarmQuickToolAssistHint\) => \{\s*setFarmPanelSectionOpen\('tools'\)/);
  assert.match(panel, /data-farm-quick-tool-route-label="true"/);
  assert.match(panel, /data-farm-quick-tool-assist-label="true"/);
  assert.match(panel, /data-farm-panel-readable="large"/);
  assert.match(panel, /className="t8-farm-story-panel__sr-only t8-farm-story-panel__mini-placement-target-live"/);
  assert.match(panel, /data-farm-sr-only-lock="mini-placement-target-live"/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions \{[\s\S]*position:\s*fixed[\s\S]*top:\s*124px[\s\S]*width:\s*fit-content/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions button \{[\s\S]*font-size:\s*13px/);
  assert.match(css, /Farm compact section switchboard v1/);
  assert.match(css, /\.t8-farm-story-panel__section-switchboard\[data-farm-panel-section-layout="compact-list"\] \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*1fr[\s\S]*gap:\s*4px[\s\S]*padding:\s*6px/);
  assert.match(css, /\.t8-farm-story-panel__section-switchboard\[data-farm-panel-section-layout="compact-list"\] button \{[\s\S]*min-height:\s*28px[\s\S]*grid-template-columns:\s*22px minmax\(74px, max-content\) minmax\(0, 1fr\) 18px[\s\S]*padding:\s*3px 6px[\s\S]*text-align:\s*left/);
  assert.match(css, /\.t8-farm-story-panel__section-switchboard\[data-farm-panel-section-layout="compact-list"\] span \{[\s\S]*font-size:\s*14px[\s\S]*line-height:\s*1\.15/);
  assert.match(css, /\.t8-farm-story-panel__section-switchboard\[data-farm-panel-section-layout="compact-list"\] small \{[\s\S]*font-size:\s*12px[\s\S]*line-height:\s*1\.12/);
  assert.match(css, /\.t8-farm-story-panel__section-switchboard\[data-farm-panel-section-layout="compact-list"\] em \{[\s\S]*grid-column:\s*4[\s\S]*justify-self:\s*end[\s\S]*align-self:\s*center/);
  assert.doesNotMatch(css, /\.t8-farm-story-panel__section-switchboard\[data-farm-panel-section-layout="compact-list"\] button \{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /Farm section preset compass v1/);
  assert.match(css, /\.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)[\s\S]*padding:\s*5px/);
  assert.match(css, /\.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] button \{[\s\S]*min-height:\s*30px[\s\S]*grid-template-columns:\s*15px minmax\(28px, max-content\) minmax\(0, 1fr\)[\s\S]*font-family:\s*var\(--farm-ui-font, inherit\)/);
  assert.match(css, /\.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] button\[data-farm-panel-section-preset-active="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] button\[data-farm-panel-section-preset="priority"\]/);
  assert.match(css, /\.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] button:disabled/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] \{[\s\S]*var\(--farm-night-card-final, #fffdf0\) !important[\s\S]*color:\s*var\(--farm-night-text-final, #2e1708\) !important/);
  assert.match(css, /Farm section preset receipt v1/);
  assert.match(css, /\.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\]\[data-farm-panel-section-presets-receipt\] \{[\s\S]*border-color:\s*color-mix\(in srgb, var\(--farm-sky, #bfe8ff\) 56%, var\(--farm-leaf\)\)/);
  assert.match(css, /\.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] button\[data-farm-panel-section-preset-receipt="true"\] \{[\s\S]*border-color:\s*color-mix\(in srgb, var\(--farm-leaf\) 70%, var\(--farm-sky, #bfe8ff\)\)/);
  assert.match(css, /\.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] p\[data-farm-panel-section-preset-receipt-card="true"\] \{[\s\S]*grid-column:\s*1 \/ -1[\s\S]*grid-template-columns:\s*16px minmax\(0, 1fr\) max-content[\s\S]*animation:\s*farm-story-section-preset-receipt-pop/);
  assert.match(css, /\.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] p\[data-farm-panel-section-preset-receipt-id="close-all"\]/);
  assert.match(css, /@keyframes farm-story-section-preset-receipt-pop/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] button\[data-farm-panel-section-preset-receipt="true"\],[\s\S]*\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__section-presets\[data-farm-panel-section-presets="true"\] p\[data-farm-panel-section-preset-receipt-card="true"\] \{[\s\S]*color:\s*var\(--farm-night-text-final, #2e1708\) !important/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*p\[data-farm-panel-section-preset-receipt-card="true"\] \{[\s\S]*animation:\s*none/);
  assert.match(css, /Farm readable console and ribbon v1/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] > \.t8-farm-story-panel__mini-placement-target-live,[\s\S]*\.t8-farm-story-panel__mini-placement-target-live\[data-farm-sr-only-lock="mini-placement-target-live"\] \{[\s\S]*display:\s*block !important[\s\S]*inline-size:\s*1px !important[\s\S]*-webkit-text-fill-color:\s*transparent !important[\s\S]*pointer-events:\s*none !important/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-layout="toolbar-ribbon"\] \{[\s\S]*display:\s*grid[\s\S]*grid-auto-flow:\s*column[\s\S]*grid-auto-columns:\s*max-content[\s\S]*overflow-x:\s*auto[\s\S]*max-height:\s*44px/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-layout="toolbar-ribbon"\] button \{[\s\S]*min-height:\s*32px[\s\S]*grid-template-columns:\s*16px max-content minmax\(18px, max-content\)[\s\S]*font-size:\s*14px/);
  assert.match(css, /Farm quick tool route hints v1/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-layout="toolbar-ribbon"\] button\[data-farm-quick-tool-route-target\] \{[\s\S]*grid-template-columns:\s*16px max-content minmax\(18px, max-content\) minmax\(22px, max-content\)/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-layout="toolbar-ribbon"\] i\[data-farm-quick-tool-route-label="true"\] \{[\s\S]*font-size:\s*11px[\s\S]*font-style:\s*normal/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-layout="toolbar-ribbon"\] button\[data-farm-quick-tool-route-receipt="true"\] i\[data-farm-quick-tool-route-label="true"\]::after \{[\s\S]*content:\s*"已指路"/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-layout="toolbar-ribbon"\] i\[data-farm-quick-tool-route-label="true"\] \{[\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important/);
  assert.match(css, /Farm quick tool assist hints v1/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-layout="toolbar-ribbon"\] button\[data-farm-quick-tool-assist-label\] \{[\s\S]*grid-template-columns:\s*16px max-content minmax\(18px, max-content\) minmax\(24px, max-content\)/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-layout="toolbar-ribbon"\] i\[data-farm-quick-tool-assist-label="true"\] \{[\s\S]*font-size:\s*11px[\s\S]*font-style:\s*normal/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-layout="toolbar-ribbon"\] button\[data-farm-quick-tool-assist-receipt="true"\] i\[data-farm-quick-tool-assist-label="true"\]::after \{[\s\S]*content:\s*"已提示"/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-layout="toolbar-ribbon"\] i\[data-farm-quick-tool-assist-label="true"\] \{[\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important/);
  assert.match(css, /Farm monitor dashboard strip v1/);
  assert.match(css, /\.t8-farm-story-panel \{[\s\S]*--farm-monitor-toolbar-clearance:\s*clamp\(760px, 38vw, 960px\)/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \{[\s\S]*right:\s*max\(calc\(var\(--farm-control-panel-width\) \+ 72px\), var\(--farm-monitor-toolbar-clearance\)\) !important[\s\S]*display:\s*grid[\s\S]*grid-auto-flow:\s*column[\s\S]*grid-auto-columns:\s*minmax\(88px, max-content\)[\s\S]*min-height:\s*58px[\s\S]*max-height:\s*58px/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\]::before \{[\s\S]*flex:\s*none[\s\S]*min-width:\s*112px[\s\S]*font-size:\s*13px/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-monitor-group="brief"\] \{[\s\S]*min-width:\s*150px[\s\S]*max-width:\s*220px/);
  assert.match(css, /Farm priority dashboard action bridge v1/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-monitor-brief-tone\] \{[\s\S]*grid-template-columns:\s*15px minmax\(0, max-content\) minmax\(54px, 1fr\) max-content max-content/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] i\[data-farm-monitor-brief-tone-chip="true"\] \{[\s\S]*font-size:\s*11px[\s\S]*border-radius:\s*999px/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] mark\[data-farm-monitor-brief-progress-chip="true"\] \{[\s\S]*font-size:\s*11px[\s\S]*border-radius:\s*999px/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] button\[data-farm-monitor-brief-route-button="true"\] \{[\s\S]*pointer-events:\s*auto !important[\s\S]*cursor:\s*pointer !important/);
  assert.match(css, /button\[data-farm-monitor-brief-route-button="true"\]:hover,[\s\S]*button\[data-farm-monitor-brief-route-button="true"\]:focus-visible \{[\s\S]*transform:\s*translateY\(-1px\)[\s\S]*outline:\s*2px solid/);
  assert.match(css, /button\[data-farm-monitor-brief-route-receipt="true"\] \{[\s\S]*border-color:\s*color-mix\(in srgb, var\(--farm-leaf\) 72%, var\(--farm-sky\)\)/);
  assert.match(css, /button\[data-farm-monitor-brief-route-receipt="true"\] mark\[data-farm-monitor-brief-progress-chip="true"\] \{[\s\S]*color:\s*color-mix\(in srgb, var\(--farm-leaf\) 82%, var\(--farm-readable-ink\)\)/);
  assert.match(css, /button\[data-farm-monitor-brief-action-receipt="true"\] \{[\s\S]*border-color:\s*color-mix\(in srgb, var\(--farm-leaf\) 76%, var\(--farm-wheat/);
  assert.match(css, /button\[data-farm-monitor-brief-action-receipt="true"\] mark\[data-farm-monitor-brief-progress-chip="true"\] \{[\s\S]*color:\s*color-mix\(in srgb, var\(--farm-leaf\) 90%, var\(--farm-readable-ink\)\)/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] button\[data-farm-monitor-brief-route-button="true"\],[\s\S]*button\[data-farm-monitor-brief-route-button="true"\] :where\(b, strong, small, i, mark, svg\) \{[\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important/);
  assert.match(css, /\.t8-farm-story-panel__priority-action\[data-farm-panel-priority-action-receipt="true"\] \{[\s\S]*cursor:\s*default[\s\S]*opacity:\s*1/);
  assert.match(css, /\.t8-farm-story-panel__priority-action\[data-farm-panel-priority-action-receipt="true"\] mark \{[\s\S]*color:\s*color-mix\(in srgb, var\(--farm-leaf\) 90%, var\(--farm-readable-ink\)\)/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__priority-action\[data-farm-panel-priority-action-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-card\[data-farm-panel-priority-card="true"\] \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*18px minmax\(0, 1fr\) max-content max-content/);
  assert.match(css, /\.t8-farm-story-panel__priority-card\[data-farm-panel-priority-tone="water"\]/);
  assert.match(css, /Farm priority section locator v1/);
  assert.match(css, /\.t8-farm-story-panel__priority-card\[data-farm-panel-priority-receipt="true"\] \{[\s\S]*border-color:\s*color-mix\(in srgb, var\(--farm-leaf\) 68%, var\(--farm-sky\)\)/);
  assert.match(css, /\.t8-farm-story-panel__section-switchboard\[data-farm-panel-section-layout="compact-list"\] button\[data-farm-panel-section-priority="true"\] \{[\s\S]*border-color:\s*color-mix\(in srgb, var\(--farm-sky\) 60%, var\(--farm-readable-line\)\)/);
  assert.match(css, /\.t8-farm-story-panel__section-switchboard\[data-farm-panel-section-layout="compact-list"\] button\[data-farm-panel-section-priority="true"\]::before \{[\s\S]*position:\s*absolute[\s\S]*pointer-events:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__section-switchboard\[data-farm-panel-section-layout="compact-list"\] button\[data-farm-panel-section-priority-receipt="true"\] \{[\s\S]*box-shadow:[\s\S]*rgba\(89, 143, 83, \.18\)/);
  assert.match(css, /\.t8-farm-story-panel \[data-farm-panel-priority-content="true"\] \{[\s\S]*outline:\s*2px solid color-mix\(in srgb, var\(--farm-sky\) 58%, transparent\)/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__priority-card\[data-farm-panel-priority-card="true"\][\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important/);
  assert.match(css, /Farm priority action bridge v1/);
  assert.match(css, /\.t8-farm-story-panel__priority-action\[data-farm-panel-priority-action="true"\] \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*18px minmax\(0, 1fr\) max-content/);
  assert.match(css, /\.t8-farm-story-panel__priority-action\[data-farm-panel-priority-action-receipt="true"\] \{[\s\S]*border-color:\s*color-mix\(in srgb, var\(--farm-leaf\) 70%, var\(--farm-sky\)\)/);
  assert.match(css, /\.t8-farm-story-panel__priority-action\[data-farm-panel-priority-action-kind="water-route"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__priority-action\[data-farm-panel-priority-action="true"\][\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important/);
  assert.match(css, /Farm priority combo receipt v1/);
  assert.match(css, /\.t8-farm-story-panel__priority-combo\[data-farm-panel-priority-combo="true"\] \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*16px minmax\(0, 1fr\) max-content/);
  assert.match(css, /\.t8-farm-story-panel__priority-combo\[data-farm-panel-priority-combo-source="queue"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-combo\[data-farm-panel-priority-combo-count="3"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-combo\[data-farm-panel-priority-combo-count="5"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-combo mark\[data-farm-panel-priority-combo-next="true"\]/);
  assert.match(css, /Farm priority combo next route v1/);
  assert.match(css, /\.t8-farm-story-panel__priority-combo i\[data-farm-panel-priority-combo-next-label="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-combo button\[data-farm-panel-priority-combo-next="true"\] \{[\s\S]*min-height:\s*24px/);
  assert.match(css, /\.t8-farm-story-panel__priority-combo\[data-farm-panel-priority-combo-next-route\]/);
  assert.match(css, /Farm priority combo two-step action v1/);
  assert.match(css, /\.t8-farm-story-panel__priority-combo\[data-farm-panel-priority-combo-next-mode="action"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-combo button\[data-farm-panel-priority-combo-next-action-button="true"\]/);
  assert.match(css, /Farm monitor priority combo chip v1/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item\]:not\(\[data-farm-mini-status-item="monitor-brief"\]\):not\(\[data-farm-mini-status-item="day"\]\):not\(\[data-farm-mini-status-item="season"\]\):not\(\[data-farm-mini-status-item="weather"\]\):not\(\[data-farm-mini-status-item="gold"\]\):not\(\[data-farm-mini-status-item="seed"\]\):not\(\[data-farm-mini-status-item="water"\]\):not\(\[data-farm-mini-status-item="daily-route"\]\):not\(\[data-farm-mini-status-item="morning-combo"\]\):not\(\[data-farm-mini-status-item="priority-combo"\]\):not\(\[data-farm-mini-status-item="priority-flow"\]\) \{[\s\S]*display:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-monitor-group="combo"\] \{[\s\S]*display:\s*inline-grid !important[\s\S]*min-width:\s*150px/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-mini-priority-combo-route-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-mini-priority-combo-next-mode="action"\]/);
  assert.match(css, /Farm monitor priority flow chip v1/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-monitor-group="flow"\] \{[\s\S]*display:\s*inline-grid !important[\s\S]*min-width:\s*166px/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-mini-priority-flow-route-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-mini-priority-flow-next-mode="action"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-mini-priority-flow-next-mode="stale"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-monitor-group="flow"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__priority-combo\[data-farm-panel-priority-combo="true"\][\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important/);
  assert.match(css, /@keyframes farm-story-priority-combo-pop/);
  assert.match(css, /Farm priority flow receipt v1/);
  assert.match(css, /\.t8-farm-story-panel__priority-flow-receipt\[data-farm-panel-priority-flow-receipt="true"\] \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*16px minmax\(0, 1fr\) max-content/);
  assert.match(css, /\.t8-farm-story-panel__priority-flow-receipt\[data-farm-panel-priority-flow-source="queue"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-flow-receipt i\[data-farm-panel-priority-flow-meta="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-flow-receipt button\[data-farm-panel-priority-flow-next-button="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-flow-receipt button\[data-farm-panel-priority-flow-next-route-receipt="true"\]/);
  assert.match(css, /Farm priority flow two-step action v1/);
  assert.match(css, /\.t8-farm-story-panel__priority-flow-receipt\[data-farm-panel-priority-flow-next-mode="action"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-flow-receipt\[data-farm-panel-priority-flow-next-mode="stale"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-flow-receipt button\[data-farm-panel-priority-flow-next-action-button="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-flow-receipt button\[data-farm-panel-priority-flow-next-stale="true"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__priority-flow-receipt\[data-farm-panel-priority-flow-receipt="true"\][\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important/);
  assert.match(css, /@keyframes farm-story-priority-flow-receipt/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.t8-farm-story-panel__priority-flow-receipt\[data-farm-panel-priority-flow-receipt="true"\][\s\S]*animation:\s*none/);
  assert.match(css, /Farm priority queue bridge v1/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue\[data-farm-panel-priority-queue="true"\] \{[\s\S]*display:\s*grid[\s\S]*gap:\s*5px/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue button\[data-farm-panel-priority-queue-item\] \{[\s\S]*grid-template-columns:\s*16px minmax\(0, 1fr\) max-content/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue button\[data-farm-panel-priority-queue-receipt="true"\] \{[\s\S]*border-color:\s*color-mix\(in srgb, var\(--farm-leaf\) 68%, var\(--farm-sky\)\)/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue button\[data-farm-panel-priority-queue-kind="water-route"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__priority-queue\[data-farm-panel-priority-queue="true"\][\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important/);
  assert.match(css, /Farm priority queue route preview v1/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue\[data-farm-panel-priority-queue-empty="true"\] \{[\s\S]*border-style:\s*dashed/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue button\[data-farm-panel-priority-queue-route-button="true"\] \{[\s\S]*min-height:\s*24px/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue\[data-farm-panel-priority-queue-route-receipt\] button\[data-farm-panel-priority-queue-route-button="true"\] \{[\s\S]*border-color:\s*color-mix\(in srgb, var\(--farm-sky\) 68%, var\(--farm-leaf\)\)/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue \[data-farm-panel-priority-queue-empty-note="true"\] \{[\s\S]*display:\s*grid/);
  assert.match(css, /Farm priority queue expectation chips v1/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue button\[data-farm-panel-priority-queue-item\] \.t8-farm-story-panel__priority-queue-meta\[data-farm-panel-priority-queue-meta="true"\] \{[\s\S]*display:\s*flex[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue \.t8-farm-story-panel__priority-queue-meta\[data-farm-panel-priority-queue-meta="true"\] small\[data-farm-panel-priority-queue-impact="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue \.t8-farm-story-panel__priority-queue-meta\[data-farm-panel-priority-queue-meta="true"\] small\[data-farm-panel-priority-queue-reason="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__priority-queue \.t8-farm-story-panel__priority-queue-meta\[data-farm-panel-priority-queue-meta="true"\] i\[data-farm-panel-priority-queue-safety="true"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__priority-queue \.t8-farm-story-panel__priority-queue-meta\[data-farm-panel-priority-queue-meta="true"\] :where\(small, i\) \{[\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] \[data-farm-monitor-group="resource"\] \{[\s\S]*min-width:\s*92px/);
  assert.match(css, /\.t8-farm-story-panel__quick-actions\[data-farm-quick-actions-mirror="top-monitor"\] \{[\s\S]*right:\s*var\(--farm-monitor-toolbar-clearance\) !important[\s\S]*max-width:\s*min\(980px, calc\(100vw - var\(--farm-monitor-toolbar-clearance\) - 24px\)\) !important/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\][\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__mini-status\[data-farm-monitor-layout="pasture-dashboard-v1"\] :where\(button, span, b, strong, small, em, i, mark\)[\s\S]*opacity:\s*1 !important/);
  assert.match(css, /\.t8-farm-story-panel__panel\[data-farm-panel-readable="large"\] \{[\s\S]*font-size:\s*14px[\s\S]*line-height:\s*1\.46/);
  assert.match(css, /\.t8-farm-story-panel__panel\[data-farm-panel-readable="large"\] :where\(p, li, label, button, input, select, textarea\) \{[\s\S]*font-size:\s*13px[\s\S]*line-height:\s*1\.45/);
  assert.match(css, /\.t8-farm-story-panel__panel\[data-farm-panel-readable="large"\] :where\(small, em, i, mark\) \{[\s\S]*font-size:\s*12px[\s\S]*line-height:\s*1\.28/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__panel\[data-farm-panel-readable="large"\] :where\(button, span, b, strong, small, em, i, mark, p, li, label\) \{[\s\S]*color:\s*var\(--farm-readable-ink, #2e1708\) !important[\s\S]*opacity:\s*1 !important/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item="mature"\],[\s\S]*\[data-farm-mini-status-item="ready-npc"\][\s\S]*display:\s*none/);
  assert.match(css, /--farm-ui-font:\s*"Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", "Source Han Sans SC", system-ui, sans-serif/);
  assert.match(css, /--farm-ui-panel:\s*var\(--farm-paper\)/);
  assert.match(css, /--farm-ui-text:\s*var\(--farm-wood-dark\)/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \{[\s\S]*--farm-ui-panel:\s*#fff3d1[\s\S]*--farm-ui-text:\s*#3f250f/);
  assert.match(css, /\.t8-farm-story-panel__panel \{[\s\S]*font-family:\s*var\(--farm-ui-font\)[\s\S]*font-size:\s*13px[\s\S]*line-height:\s*1\.36/);
  assert.match(css, /\.t8-farm-story-panel__panel :where\(p, li\) \{[\s\S]*font-size:\s*13px[\s\S]*line-height:\s*1\.42/);
  assert.match(css, /\.t8-farm-story-panel__panel :where\(small, em, mark, i\) \{[\s\S]*font-size:\s*11px[\s\S]*line-height:\s*1\.24/);
  assert.match(css, /\.t8-farm-story-panel__focus > b,[\s\S]*\.t8-farm-story-panel__season-head strong[\s\S]*font-size:\s*14px[\s\S]*line-height:\s*1\.28/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item\]:not\(\[data-farm-mini-status-item="monitor-brief"\]\):not\(\[data-farm-mini-status-item="day"\]\):not\(\[data-farm-mini-status-item="season"\]\):not\(\[data-farm-mini-status-item="weather"\]\):not\(\[data-farm-mini-status-item="gold"\]\):not\(\[data-farm-mini-status-item="seed"\]\):not\(\[data-farm-mini-status-item="water"\]\):not\(\[data-farm-mini-status-item="daily-route"\]\):not\(\[data-farm-mini-status-item="morning-combo"\]\):not\(\[data-farm-mini-status-item="priority-combo"\]\):not\(\[data-farm-mini-status-item="priority-flow"\]\) \{[\s\S]*display:\s*none/);
  assert.match(css, /Farm fresh toolbar refresh/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] \.t8-topbar,[\s\S]*html\[data-theme-visual="farm-story"\] \[data-topbar\] \{[\s\S]*background:[\s\S]*var\(--farm-fresh-rail\)/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] \.t8-topbar button,[\s\S]*html\[data-theme-visual="farm-story"\] \.t8-topbar-status-chip \{[\s\S]*background:[\s\S]*var\(--farm-fresh-control\)[\s\S]*color:\s*var\(--farm-fresh-text\)/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] \.t8-toolbar-panel \{[\s\S]*background:[\s\S]*var\(--farm-fresh-control-rail\)/);
  assert.match(css, /\.t8-farm-story-toolbar-toggle \{[\s\S]*color:\s*var\(--farm-leaf\)/);
  assert.match(css, /\.t8-farm-story-toolbar-toggle\.is-active \{[\s\S]*background:[\s\S]*var\(--farm-fresh-active\)/);
  assert.match(css, /\.t8-farm-story-panel__header \{[\s\S]*background:[\s\S]*var\(--farm-fresh-panel-head\)[\s\S]*color:\s*var\(--farm-fresh-text\)/);
  assert.match(css, /Farm fresh airy topbar polish/);
  assert.match(css, /--farm-fresh-air:\s*#fffef6/);
  assert.match(css, /--farm-fresh-air-control:\s*linear-gradient\(180deg, #ffffff, #f4fbeb\)/);
  assert.match(css, /--farm-fresh-ink:\s*#24462b/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\]\) \{[\s\S]*background:\s*linear-gradient\(180deg, var\(--farm-fresh-mint\), var\(--farm-fresh-air\)\) !important[\s\S]*box-shadow:[\s\S]*rgba\(87, 134, 75, 0\.12\)/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] :where\(\.t8-topbar button, \[data-topbar\] button, \.t8-topbar-status-chip, \.t8-toolbar-button\) \{[\s\S]*background:\s*var\(--farm-fresh-air-control\) !important[\s\S]*color:\s*var\(--farm-fresh-ink\) !important/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] \.t8-toolbar-panel \{[\s\S]*background:[\s\S]*var\(--farm-fresh-air\) !important[\s\S]*backdrop-filter:\s*blur\(10px\)/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\],[\s\S]*\.t8-farm-story-panel__quick-actions \{[\s\S]*background:[\s\S]*var\(--farm-fresh-air\)[\s\S]*border-color:\s*var\(--farm-fresh-line\)/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before,[\s\S]*\.t8-farm-story-panel__header \{[\s\S]*background:\s*linear-gradient\(180deg, #f8fff3, #e8f7d8\)[\s\S]*color:\s*var\(--farm-fresh-ink\)/);
  assert.match(css, /\.t8-farm-story-panel__section-switchboard button \{[\s\S]*background:\s*var\(--farm-fresh-air-control\)[\s\S]*color:\s*var\(--farm-fresh-ink\)/);
  assert.match(css, /Farm fresh terminal bar refresh/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] \.t8-topbar :where\(button, \.px-btn, \.px-chip, \.t8-topbar-status-chip\),[\s\S]*\.t8-canvas-shell\[data-theme-visual="farm-story"\] \.t8-canvas-toolbar :where\(button, \.t8-toolbar-button\) \{[\s\S]*background:[\s\S]*var\(--farm-fresh-air-control\) !important[\s\S]*color:\s*var\(--farm-fresh-ink\) !important/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] \.t8-toolbar-panel,[\s\S]*\.t8-canvas-shell\[data-theme-visual="farm-story"\] \.t8-canvas-toolbar \{[\s\S]*background:[\s\S]*var\(--farm-fresh-air\) !important[\s\S]*box-shadow:[\s\S]*rgba\(87, 134, 75, 0\.1\)/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before,[\s\S]*\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__header \{[\s\S]*background:[\s\S]*var\(--farm-fresh-panel-head\) !important[\s\S]*color:\s*var\(--farm-fresh-ink\) !important/);
  assert.match(css, /Farm fresh sidebar and canvas chrome refresh/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] :where\(\.t8-sidebar, \.t8-sidebar-toggle\) \{[\s\S]*background:[\s\S]*var\(--farm-fresh-air\) !important[\s\S]*color:\s*var\(--farm-fresh-ink\) !important/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] \.t8-sidebar :where\(\.px-group-title, \[class\*="group-title"\], \.t8-sidebar-node, \.px-chip, \[class\*="rounded-full"\]\) \{[\s\S]*background:[\s\S]*var\(--farm-fresh-air-control\) !important[\s\S]*border-color:\s*var\(--farm-fresh-line\) !important/);
  assert.match(css, /html\[data-theme-visual="farm-story"\] \.t8-sidebar-search-box \{[\s\S]*background:[\s\S]*var\(--farm-fresh-air-control\) !important[\s\S]*color:\s*var\(--farm-fresh-ink\) !important/);
  assert.match(css, /\.t8-canvas-shell\[data-theme-visual="farm-story"\] :where\(\.react-flow__controls, \.react-flow__minimap\) \{[\s\S]*background:[\s\S]*var\(--farm-fresh-air\) !important[\s\S]*border-color:\s*var\(--farm-fresh-line\) !important/);
  assert.match(css, /\.t8-canvas-shell\[data-theme-visual="farm-story"\] \.react-flow__controls-button \{[\s\S]*background:[\s\S]*var\(--farm-fresh-air-control\) !important[\s\S]*color:\s*var\(--farm-fresh-ink\) !important/);
  assert.match(globalCss, /Farm story pastel chrome final override/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \.t8-app-shell \.t8-topbar\) \{[\s\S]*#f8fff1[\s\S]*#edf9df[\s\S]*color:\s*#21452a !important/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] \.t8-topbar :where\(button, \.px-btn, \.px-chip, \.t8-topbar-status-chip\),[\s\S]*\.t8-canvas-shell\[data-theme-visual="farm-story"\] \.t8-canvas-toolbar :where\(button, \.t8-toolbar-button\) \{[\s\S]*#fffdf8[\s\S]*#f0f9e6[\s\S]*color:\s*#21452a !important/);
  assert.match(globalCss, /\.t8-canvas-shell\[data-theme-visual="farm-story"\] :where\(\.t8-toolbar-panel, \.t8-canvas-toolbar\) \{[\s\S]*rgba\(255, 253, 246, 0\.94\)[\s\S]*border-color:\s*#b9dda7 !important/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\([\s\S]*\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\],[\s\S]*\.t8-farm-story-panel__quick-actions,[\s\S]*\.t8-farm-story-panel__section-switchboard[\s\S]*\) \{[\s\S]*border-color:\s*#b9dda7 !important[\s\S]*#fffdf8[\s\S]*#edf9df/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\([\s\S]*\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before,[\s\S]*\.t8-farm-story-panel__header[\s\S]*\) \{[\s\S]*#fbfff6[\s\S]*#e6f6d6[\s\S]*color:\s*#21452a !important/);
  assert.match(globalCss, /Farm story pastel air polish v2/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] \{[\s\S]*--farm-final-air:\s*#fbfff6[\s\S]*--farm-final-water:\s*#dff5f2[\s\S]*--farm-final-ink:\s*#1f452a/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\], \.t8-app-shell \.t8-topbar\) \{[\s\S]*background:[\s\S]*var\(--farm-final-water\)[\s\S]*var\(--farm-final-air\)[\s\S]*box-shadow:[\s\S]*rgba\(62, 128, 82, 0\.09\)/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] \.t8-topbar :where\(button, \.px-btn, \.px-chip, \.t8-topbar-status-chip, \.t8-btn\),[\s\S]*\.t8-canvas-shell\[data-theme-visual="farm-story"\] \.t8-canvas-toolbar :where\(button, \.t8-toolbar-button\) \{[\s\S]*background:[\s\S]*#ffffff[\s\S]*#f7fdf0[\s\S]*color:\s*var\(--farm-final-ink\) !important/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before,[\s\S]*html\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__header \{[\s\S]*background:[\s\S]*#ffffff[\s\S]*#eef9e4[\s\S]*box-shadow:[\s\S]*rgba\(62, 128, 82, 0\.08\)/);
  assert.match(globalCss, /Farm story meadow chrome v3/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] \.t8-topbar :where\([\s\S]*\.px-btn--yellow,[\s\S]*\.px-btn--peach,[\s\S]*\.px-btn--pink,[\s\S]*\.px-btn--mint,[\s\S]*\.px-btn--ghost,[\s\S]*\.px-chip--yellow,[\s\S]*\.px-chip--pink,[\s\S]*\.px-chip--mint[\s\S]*\) \{[\s\S]*background:[\s\S]*var\(--farm-meadow-card\)[\s\S]*color:\s*var\(--farm-meadow-ink\) !important[\s\S]*box-shadow:[\s\S]*rgba\(49, 119, 74, 0\.07\)/);
  assert.match(globalCss, /\.t8-canvas-shell\[data-theme-visual="farm-story"\] :where\([\s\S]*\.t8-canvas-toolbar,[\s\S]*\.t8-toolbar-panel,[\s\S]*\.t8-control-stack[\s\S]*\) \{[\s\S]*background:[\s\S]*var\(--farm-meadow-panel\)[\s\S]*border-color:\s*var\(--farm-meadow-line\) !important/);
  assert.match(globalCss, /\.t8-canvas-shell\[data-theme-visual="farm-story"\] :where\([\s\S]*\.t8-toolbar-button,[\s\S]*\.t8-mini-icon-button,[\s\S]*\.t8-control-rail-help[\s\S]*\) \{[\s\S]*background:[\s\S]*var\(--farm-meadow-card\)[\s\S]*color:\s*var\(--farm-meadow-ink\) !important/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__header \{[\s\S]*background:[\s\S]*var\(--farm-meadow-head\)[\s\S]*border-color:\s*var\(--farm-meadow-line\) !important[\s\S]*box-shadow:[\s\S]*rgba\(49, 119, 74, 0\.08\)/);
  assert.match(globalCss, /Farm story spring chrome v4/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] \{[\s\S]*--farm-spring-air:\s*#fdfff8[\s\S]*--farm-spring-water:\s*#e7faf5[\s\S]*--farm-spring-ink:\s*#173f2d/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\], \.t8-app-shell \.t8-topbar\) \{[\s\S]*linear-gradient\(90deg, var\(--farm-spring-water\) 0%, var\(--farm-spring-air\) 42%, var\(--farm-spring-mint\) 100%\) !important[\s\S]*rgba\(46, 126, 80, 0\.08\)/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\]\) :where\([\s\S]*\.px-btn--yellow,[\s\S]*\.px-btn--peach,[\s\S]*\.px-btn--pink,[\s\S]*\.px-btn--mint,[\s\S]*\.px-btn--sky,[\s\S]*\.px-btn--violet,[\s\S]*\.px-btn--ghost,[\s\S]*\.px-chip--yellow,[\s\S]*\.px-chip--pink,[\s\S]*\.px-chip--mint[\s\S]*\) \{[\s\S]*background:[\s\S]*var\(--farm-spring-card\)[\s\S]*color:\s*var\(--farm-spring-ink\) !important/);
  assert.match(globalCss, /\.t8-canvas-shell\[data-theme-visual="farm-story"\] :where\([\s\S]*\.t8-canvas-toolbar,[\s\S]*\.t8-toolbar-panel,[\s\S]*\.t8-control-stack[\s\S]*\) \{[\s\S]*background:[\s\S]*var\(--farm-spring-panel\)[\s\S]*border-color:\s*var\(--farm-spring-line\) !important/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\(\.t8-farm-story-panel__header, \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before\) \{[\s\S]*background:[\s\S]*var\(--farm-spring-head\)[\s\S]*color:\s*var\(--farm-spring-ink\) !important/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] \.t8-sidebar :where\(\.px-group-title, \[class\*="group-title"\], \.t8-sidebar-node, \.px-chip\) \{[\s\S]*background:[\s\S]*var\(--farm-spring-card\)/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] \.t8-sidebar :where\(\.px-group-title, \[class\*="group-title"\], \.t8-sidebar-node, \.px-chip\) \{[\s\S]*border-color:\s*var\(--farm-spring-line\) !important/);
  assert.match(globalCss, /Farm story fresh meadow final guard/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] \{[\s\S]*--farm-fresh-meadow-air:\s*#fbfff8[\s\S]*--farm-fresh-meadow-water:\s*#e8fbf5[\s\S]*--farm-fresh-meadow-ink:\s*#153f2e/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\], \.t8-app-shell \.t8-topbar\) \{[\s\S]*linear-gradient\(90deg, var\(--farm-fresh-meadow-water\) 0%, var\(--farm-fresh-meadow-air\) 46%, var\(--farm-fresh-meadow-mint\) 100%\) !important[\s\S]*rgba\(45, 118, 78, 0\.07\)/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\]\) :where\([\s\S]*\.px-btn--yellow,[\s\S]*\.px-btn--peach,[\s\S]*\.px-btn--pink,[\s\S]*\.px-chip--yellow,[\s\S]*\.px-chip--mint[\s\S]*\) \{[\s\S]*background:[\s\S]*var\(--farm-fresh-meadow-card\)[\s\S]*color:\s*var\(--farm-fresh-meadow-ink\) !important[\s\S]*rgba\(45, 118, 78, 0\.055\)/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-farm-story-panel__header, \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before\) \{[\s\S]*background:[\s\S]*var\(--farm-fresh-meadow-head\)[\s\S]*color:\s*var\(--farm-fresh-meadow-ink\) !important/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\], \.t8-farm-story-panel__quick-actions, \.t8-farm-story-panel__section-switchboard\) \{[\s\S]*background:[\s\S]*var\(--farm-fresh-meadow-panel\)[\s\S]*border-color:\s*var\(--farm-fresh-meadow-line\) !important/);
  assert.match(globalCss, /Farm story fresh orchard chrome final guard/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] \{[\s\S]*--farm-fresh-orchard-air:\s*#fdfff8[\s\S]*--farm-fresh-orchard-water:\s*#e9fbf6[\s\S]*--farm-fresh-orchard-ink:\s*#123d2b[\s\S]*--farm-wood:\s*#9dcf90[\s\S]*--farm-paper:\s*var\(--farm-fresh-orchard-air\)/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\], \.t8-app-shell \.t8-topbar\) \{[\s\S]*linear-gradient\(90deg, var\(--farm-fresh-orchard-water\) 0%, var\(--farm-fresh-orchard-air\) 48%, var\(--farm-fresh-orchard-mint\) 100%\) !important[\s\S]*rgba\(39, 121, 77, 0\.06\)/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\]\) :where\([\s\S]*\.px-btn--yellow,[\s\S]*\.px-chip--yellow,[\s\S]*\[class\*="bg-amber-"\],[\s\S]*\[class\*="border-amber-"\],[\s\S]*\[class\*="text-amber-"\][\s\S]*\),[\s\S]*\[data-theme-visual="farm-story"\] :where\([\s\S]*\.t8-canvas-toolbar,[\s\S]*\.t8-toolbar-panel,[\s\S]*\.t8-control-stack[\s\S]*\) :where\([\s\S]*\.t8-toolbar-button,[\s\S]*\.react-flow__controls-button[\s\S]*\) \{[\s\S]*background:[\s\S]*var\(--farm-fresh-orchard-card\)[\s\S]*color:\s*var\(--farm-fresh-orchard-ink\) !important/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-farm-story-panel__header, \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before\) \{[\s\S]*background:[\s\S]*var\(--farm-fresh-orchard-head\)[\s\S]*color:\s*var\(--farm-fresh-orchard-ink\) !important/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\], \.t8-canvas-toolbar, \.t8-toolbar-panel, \.t8-control-stack\) :where\(button, a, \[role="button"\], \.px-chip, \.t8-topbar-status-chip, \.t8-toolbar-button\) :where\(span, b, strong, small, em, i, svg\) \{[\s\S]*-webkit-text-fill-color:\s*currentColor !important[\s\S]*opacity:\s*1 !important/);
  assert.match(globalCss, /Farm story dew garden chrome v5/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] \{[\s\S]*--farm-dew-air:\s*#fbfffb[\s\S]*--farm-dew-water:\s*#e5fbfb[\s\S]*--farm-dew-ink:\s*#173b31[\s\S]*--farm-wood:\s*#b8dcc8[\s\S]*--farm-wheat:\s*#edf8dc/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\], \.t8-app-shell \.t8-topbar, \.t8-canvas-toolbar, \.t8-toolbar-panel, \.t8-control-stack\) \{[\s\S]*background:[\s\S]*var\(--farm-dew-water\)[\s\S]*var\(--farm-dew-air\)[\s\S]*var\(--farm-dew-mint\)[\s\S]*box-shadow:[\s\S]*var\(--farm-dew-shadow\)/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\], \.t8-canvas-toolbar, \.t8-toolbar-panel, \.t8-control-stack\) :where\([\s\S]*\.px-btn--yellow,[\s\S]*\.px-chip--yellow,[\s\S]*\[class\*="bg-yellow-"\],[\s\S]*\[class\*="bg-amber-"\],[\s\S]*\[class\*="text-yellow-"\],[\s\S]*\[class\*="text-amber-"\][\s\S]*\) \{[\s\S]*background:[\s\S]*var\(--farm-dew-card\)[\s\S]*color:\s*var\(--farm-dew-ink\) !important/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-farm-story-panel__header, \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before, \.t8-sidebar :where\(\.px-group-title, \[class\*="group-title"\]\)\) \{[\s\S]*background:[\s\S]*var\(--farm-dew-head\)[\s\S]*color:\s*var\(--farm-dew-ink\) !important[\s\S]*text-shadow:\s*none !important/);
  assert.match(globalCss, /\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\], \.t8-canvas-toolbar, \.t8-toolbar-panel, \.t8-control-stack, \.t8-farm-story-panel__header\) :where\(button, a, \[role="button"\], \.px-btn, \.px-chip, \.t8-toolbar-button, \.t8-topbar-status-chip\) \{[\s\S]*min-height:\s*28px[\s\S]*font-weight:\s*700/);
  assert.match(globalCss, /Farm story botanical chrome v6/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\],[\s\S]*\[data-theme-visual="farm-story"\] \{[\s\S]*--farm-botanical-air:\s*#fbfff8[\s\S]*--farm-botanical-mist:\s*#eefbf6[\s\S]*--farm-botanical-ink:\s*#173d32[\s\S]*--farm-wood:\s*#b7dfc4[\s\S]*--px-yellow:\s*var\(--farm-botanical-mint\)/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\], \.t8-app-shell \.t8-topbar\),[\s\S]*\.t8-canvas-shell\[data-theme-visual="farm-story"\] :where\(\.t8-canvas-toolbar, \.t8-toolbar-panel, \.t8-control-stack\) \{[\s\S]*background:[\s\S]*var\(--farm-botanical-mist\)[\s\S]*var\(--farm-botanical-air\)[\s\S]*var\(--farm-botanical-mint\)[\s\S]*box-shadow:[\s\S]*var\(--farm-botanical-shadow\)/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\]\) :where\([\s\S]*\.px-btn--yellow,[\s\S]*\.px-chip--yellow,[\s\S]*\[class\*="bg-amber-"\],[\s\S]*\[class\*="bg-yellow-"\][\s\S]*\),[\s\S]*\.t8-canvas-shell\[data-theme-visual="farm-story"\] :where\(\.t8-canvas-toolbar, \.t8-toolbar-panel, \.t8-control-stack\) :where\([\s\S]*\.t8-farm-story-toolbar-toggle,[\s\S]*\.react-flow__controls-button[\s\S]*\) \{[\s\S]*background:[\s\S]*var\(--farm-botanical-card\)[\s\S]*color:\s*var\(--farm-botanical-ink\) !important[\s\S]*box-shadow:[\s\S]*rgba\(25, 118, 89, 0\.05\)/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\(\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before, \.t8-farm-story-panel__header\),[\s\S]*\.t8-canvas-shell\[data-theme-visual="farm-story"\] :where\(\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before, \.t8-farm-story-panel__header\) \{[\s\S]*background:[\s\S]*var\(--farm-botanical-head\)[\s\S]*color:\s*var\(--farm-botanical-ink\) !important[\s\S]*box-shadow:[\s\S]*rgba\(25, 118, 89, 0\.055\)/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :where\(\.t8-topbar, \[data-topbar\], \.t8-canvas-toolbar, \.t8-toolbar-panel, \.t8-control-stack, \.t8-farm-story-panel__header\) :where\([\s\S]*span,[\s\S]*small,[\s\S]*em,[\s\S]*svg[\s\S]*\) \{[\s\S]*text-shadow:\s*none !important[\s\S]*filter:\s*none !important[\s\S]*opacity:\s*1 !important/);
  assert.match(globalCss, /Farm story pastel bloom chrome v7/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\],[\s\S]*\[data-theme-visual="farm-story"\] \{[\s\S]*--farm-pastel-bloom-air:\s*#fcfff9[\s\S]*--farm-pastel-bloom-water:\s*#e6fbf8[\s\S]*--farm-pastel-bloom-petal:\s*#fff4ec[\s\S]*--farm-pastel-bloom-ink:\s*#163f35[\s\S]*--farm-wood:\s*#c9ecd4[\s\S]*--px-yellow:\s*var\(--farm-pastel-bloom-mint\)/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :is\(\.t8-topbar, \[data-topbar\]\) :is\([\s\S]*\.px-btn--yellow,[\s\S]*\.px-chip--yellow,[\s\S]*\[class\*="bg-amber-"\],[\s\S]*\[class\*="bg-yellow-"\][\s\S]*\),[\s\S]*\.t8-canvas-shell\[data-theme-visual="farm-story"\] :is\(\.t8-canvas-toolbar, \.t8-toolbar-panel, \.t8-control-stack\) :is\([\s\S]*\.t8-toolbar-button,[\s\S]*\.t8-farm-story-toolbar-toggle[\s\S]*\) \{[\s\S]*background:[\s\S]*var\(--farm-pastel-bloom-card\)[\s\S]*color:\s*var\(--farm-pastel-bloom-ink\) !important[\s\S]*text-shadow:\s*none !important/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :is\(\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\]::before, \.t8-farm-story-panel__header\),[\s\S]*\[data-farm-panel-night-readable="true"\] :is\(\.t8-farm-story-panel__mini-status::before, \.t8-farm-story-panel__header\) \{[\s\S]*background:[\s\S]*var\(--farm-pastel-bloom-head\)[\s\S]*color:\s*var\(--farm-pastel-bloom-ink\) !important[\s\S]*box-shadow:[\s\S]*rgba\(46, 126, 92, 0\.045\)/);
  assert.match(globalCss, /html\[data-theme-visual="farm-story"\] :is\(\.t8-topbar, \[data-topbar\], \.t8-canvas-toolbar, \.t8-toolbar-panel, \.t8-control-stack, \.t8-farm-story-panel__header\) :is\(button, a, \[role="button"\], \.px-btn, \.px-chip, \.t8-btn, \.t8-toolbar-button, \.t8-topbar-status-chip\) :is\(span, b, strong, small, em, i, svg\) \{[\s\S]*-webkit-text-fill-color:\s*currentColor !important[\s\S]*filter:\s*none !important[\s\S]*opacity:\s*1 !important/);
  assert.match(panel, /interface FarmDailyRouteStep \{/);
  assert.match(panel, /type FarmMorningBriefAction = FarmFocusGoalAction \| \{ kind: 'open-animals' \} \| \{ kind: 'open-building' \}/);
  assert.match(panel, /interface FarmMorningBriefItem \{/);
  assert.match(panel, /function buildFarmDailyRouteSteps\(goals: FarmFocusGoal\[], counts: FarmSummaryActionReceiptNextCounts\): FarmDailyRouteStep\[]/);
  assert.match(panel, /const farmDailyRouteSteps = buildFarmDailyRouteSteps\(farmFocusGoals, \{/);
  assert.match(panel, /const farmTomorrowRouteSteps = dailySummary \? farmDailyRouteSteps\.slice\(0, 3\) : \[\]/);
  assert.match(panel, /const farmTomorrowRouteSummaryLabel = farmTomorrowRouteSteps\.map\(\(step\) =>/);
  assert.match(panel, /const farmMorningBriefItems = \(\[/);
  assert.match(panel, /const farmMorningKickstartItem = farmMorningBriefItems\[0\]/);
  assert.match(panel, /const farmMorningFollowupItem = farmMorningBriefItems\[1\]/);
  assert.match(panel, /const farmMorningKickstartSummary = farmMorningKickstartItem/);
  assert.match(panel, /const farmMorningFollowupSummary = farmMorningFollowupItem/);
  assert.match(panel, /const farmDailyRouteMonitorLabel = farmDailyRouteSteps\.map\(\(step\) =>/);
  assert.match(panel, /const \[farmDailyRouteReceipt, setFarmDailyRouteReceipt\] = useState\(''\)/);
  assert.match(panel, /const \[farmDailyRouteWrapupReceipt, setFarmDailyRouteWrapupReceipt\] = useState<FarmDailyRouteWrapupReceipt \| null>\(null\)/);
  assert.match(panel, /const \[farmTomorrowRouteReceipt, setFarmTomorrowRouteReceipt\] = useState\(''\)/);
  assert.match(panel, /const \[farmMorningBriefReceipt, setFarmMorningBriefReceipt\] = useState\(''\)/);
  assert.match(panel, /const farmDailyRouteReceiptTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmDailyRouteWrapupReceiptTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmTomorrowRouteReceiptTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmMorningBriefReceiptTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /interface FarmDailyRouteWrapupReceipt \{/);
  assert.match(panel, /function handleFarmDailyRouteStepAction\(step: FarmDailyRouteStep\)/);
  assert.match(panel, /function handleFarmTomorrowRouteStepAction\(step: FarmDailyRouteStep\)/);
  assert.match(panel, /function handleFarmMorningBriefAction\(item: FarmMorningBriefItem\)/);
  assert.match(panel, /if \(item\.action\.kind === 'open-animals'\) handleOpenFarmAnimals\(\)/);
  assert.match(panel, /if \(item\.action\.kind === 'open-building'\) handleOpenFarmBuildingEffects\(\)/);
  assert.match(panel, /data-farm-mini-daily-route=\{farmDailyRouteMonitorLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-daily-route-count=\{farmDailyRouteSteps\.length \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-daily-route-complete=\{farmDailyRouteCompleteReceipt \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-daily-route-complete-title=\{farmDailyRouteCompleteTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-daily-route-focus-mode=\{farmDailyRouteFocusMode \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-daily-route-focus-stage=\{farmDailyRouteFocusStageLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-daily-route-focus-label=\{farmDailyRouteFocusLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-daily-route-focus-target=\{farmDailyRouteFocusTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-daily-route-focus-title=\{farmDailyRouteFocusTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="daily-route"/);
  assert.match(panel, /className="t8-farm-story-panel__mini-daily-route"/);
  assert.match(panel, /data-farm-mini-daily-route-focus-meta="true"/);
  assert.match(panel, /data-farm-mini-daily-route-complete-chip="true"/);
  assert.match(panel, /路线完成/);
  assert.doesNotMatch(panel, /<button[\s\S]{0,240}data-farm-mini-status-item="daily-route"/);
  assert.match(panel, /data-farm-daily-route="true"/);
  assert.match(panel, /data-farm-daily-route-step=\{step\.id\}/);
  assert.match(panel, /data-farm-daily-route-target=\{step\.routeTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-daily-route-receipt=\{farmDailyRouteReceipt === step\.id \? 'true' : undefined\}/);
  assert.match(panel, /handleFarmDailyRouteStepAction\(step\)/);
  assert.match(panel, /const farmDailyRouteReceiptIndex = farmDailyRouteReceipt/);
  assert.match(panel, /const farmDailyRouteNextStep = farmDailyRouteReceiptIndex >= 0/);
  assert.match(panel, /const farmDailyRouteCompleteReceipt = farmDailyRouteReceiptIndex >= 0 && !farmDailyRouteNextStep && farmDailyRouteSteps\.length > 0/);
  assert.match(panel, /const farmDailyRouteFocusMode = farmDailyRouteWrapupReceipt/);
  assert.match(panel, /const farmDailyRouteCompleteTitle = farmDailyRouteCompleteReceipt/);
  assert.match(panel, /const farmDailyRouteWrapupTitle = farmDailyRouteCompleteReceipt/);
  assert.match(panel, /const farmDailyRouteWrapupReceiptTitle = farmDailyRouteWrapupReceipt/);
  assert.match(panel, /const farmDailyRouteWrapupNextStep = farmDailyRouteWrapupReceipt \? farmTomorrowRouteSteps\[0\] : undefined/);
  assert.match(panel, /const farmDailyRouteWrapupNextTitle = farmDailyRouteWrapupNextStep/);
  assert.match(panel, /function flashFarmDailyRouteWrapupReceipt\(\)/);
  assert.match(panel, /setFarmDailyRouteWrapupReceipt\(\{[\s\S]*summaryLabel: farmDailyRouteSummaryLabel \|\| `\$\{farmDailyRouteSteps\.length\}步`[\s\S]*stepCount: farmDailyRouteSteps\.length[\s\S]*fromDay: farmCanvas\?\.day \|\| 1[\s\S]*toDay: \(farmCanvas\?\.day \|\| 1\) \+ 1/);
  assert.match(panel, /function handleFarmDailyRouteWrapupAction\(\)/);
  assert.match(panel, /flashFarmDailyRouteWrapupReceipt\(\);[\s\S]*handleFarmGoalAction\(\{ kind: 'advance-day' \}\)/);
  assert.match(panel, /handleFarmGoalAction\(\{ kind: 'advance-day' \}\)/);
  assert.match(panel, /message: `今日收尾：路线 \$\{farmDailyRouteSteps\.length\} 步完成，过一天查看明日总结`/);
  assert.match(panel, /routeTarget: 'day'/);
  assert.match(panel, /routeLabel: farmRouteLabelForTarget\('day'\)/);
  assert.match(panel, /data-farm-daily-route-next="true"/);
  assert.match(panel, /data-farm-daily-route-next-from=\{farmDailyRouteReceipt\}/);
  assert.match(panel, /data-farm-daily-route-next-step=\{farmDailyRouteNextStep\.id\}/);
  assert.match(panel, /data-farm-daily-route-next-target=\{farmDailyRouteNextStep\.routeTarget \|\| undefined\}/);
  assert.match(panel, /handleFarmDailyRouteStepAction\(farmDailyRouteNextStep\)/);
  assert.match(panel, /data-farm-daily-route-complete="true"/);
  assert.match(panel, /data-farm-daily-route-complete-count=\{farmDailyRouteSteps\.length\}/);
  assert.match(panel, /data-farm-daily-route-complete-summary=\{farmDailyRouteSummaryLabel \|\| undefined\}/);
  assert.match(panel, /role="status"/);
  assert.match(panel, /aria-live="polite"/);
  assert.match(panel, /<b>今日路线完成<\/b>/);
  assert.match(panel, /data-farm-daily-route-wrapup="true"/);
  assert.match(panel, /data-farm-daily-route-wrapup-action="advance-day"/);
  assert.match(panel, /data-farm-daily-route-wrapup-target="day"/);
  assert.match(panel, /title=\{farmDailyRouteWrapupTitle\}/);
  assert.match(panel, /aria-label=\{farmDailyRouteWrapupTitle\}/);
  assert.match(panel, /handleFarmDailyRouteWrapupAction\(\)/);
  assert.match(panel, /<b>今日收尾<\/b>/);
  assert.match(panel, /<small>过一天查看明日总结<\/small>/);
  assert.match(panel, /className="t8-farm-story-panel__daily-route-wrapup-receipt"/);
  assert.match(panel, /data-farm-daily-route-wrapup-receipt="true"/);
  assert.match(panel, /data-farm-daily-route-wrapup-receipt-summary=\{farmDailyRouteWrapupReceipt\.summaryLabel\}/);
  assert.match(panel, /data-farm-daily-route-wrapup-receipt-morning-count=\{farmMorningBriefItems\.length\}/);
  assert.match(panel, /data-farm-daily-route-wrapup-receipt-route-count=\{farmTomorrowRouteSteps\.length\}/);
  assert.match(panel, /title=\{farmDailyRouteWrapupReceiptTitle\}/);
  assert.match(panel, /aria-label=\{farmDailyRouteWrapupReceiptTitle\}/);
  assert.match(panel, /<b>收尾已完成<\/b>/);
  assert.match(panel, /data-farm-daily-route-wrapup-next="true"/);
  assert.match(panel, /data-farm-daily-route-wrapup-next-step=\{farmDailyRouteWrapupNextStep\.id\}/);
  assert.match(panel, /data-farm-daily-route-wrapup-next-target=\{farmDailyRouteWrapupNextStep\.routeTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-daily-route-wrapup-next-receipt=\{farmTomorrowRouteReceipt === farmDailyRouteWrapupNextStep\.id \? 'true' : undefined\}/);
  assert.match(panel, /title=\{farmDailyRouteWrapupNextTitle\}/);
  assert.match(panel, /handleFarmTomorrowRouteStepAction\(farmDailyRouteWrapupNextStep\)/);
  assert.match(panel, /<b>接明日开局<\/b>/);
  assert.match(panel, /data-farm-summary-tomorrow-route="true"/);
  assert.match(panel, /data-farm-summary-tomorrow-route-count=\{farmTomorrowRouteSteps\.length\}/);
  assert.match(panel, /data-farm-summary-tomorrow-route-summary=\{farmTomorrowRouteSummaryLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-tomorrow-route-step=\{step\.id\}/);
  assert.match(panel, /data-farm-summary-tomorrow-route-target=\{step\.routeTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-tomorrow-route-label=\{step\.routeLabel\}/);
  assert.match(panel, /data-farm-summary-tomorrow-route-receipt=\{farmTomorrowRouteReceipt === step\.id \? 'true' : undefined\}/);
  assert.match(panel, /handleFarmTomorrowRouteStepAction\(step\)/);
  assert.match(panel, /data-farm-summary-morning-brief="true"/);
  assert.match(panel, /data-farm-summary-morning-brief-count=\{farmMorningBriefItems\.length\}/);
  assert.match(panel, /data-farm-summary-morning-brief-item=\{item\.id\}/);
  assert.match(panel, /data-farm-summary-morning-brief-tone=\{item\.tone\}/);
  assert.match(panel, /data-farm-summary-morning-brief-route-target=\{item\.routeTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-morning-brief-receipt=\{farmMorningBriefReceipt === item\.id \? 'true' : undefined\}/);
  assert.match(panel, /handleFarmMorningBriefAction\(item\)/);
  assert.match(panel, /data-farm-summary-morning-kickstart="true"/);
  assert.match(panel, /data-farm-summary-morning-kickstart-item=\{farmMorningKickstartItem\.id\}/);
  assert.match(panel, /data-farm-summary-morning-kickstart-tone=\{farmMorningKickstartItem\.tone\}/);
  assert.match(panel, /data-farm-summary-morning-kickstart-route-target=\{farmMorningKickstartItem\.routeTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-morning-kickstart-receipt=\{farmMorningBriefReceipt === farmMorningKickstartItem\.id \? 'true' : undefined\}/);
  assert.match(panel, /handleFarmMorningBriefAction\(farmMorningKickstartItem\)/);
  assert.match(panel, /data-farm-summary-morning-followup="true"/);
  assert.match(panel, /farmMorningBriefReceipt === farmMorningKickstartItem\.id/);
  assert.match(panel, /data-farm-summary-morning-followup-item=\{farmMorningFollowupItem\.id\}/);
  assert.match(panel, /data-farm-summary-morning-followup-tone=\{farmMorningFollowupItem\.tone\}/);
  assert.match(panel, /data-farm-summary-morning-followup-route-target=\{farmMorningFollowupItem\.routeTarget \|\| undefined\}/);
  assert.match(panel, /handleFarmMorningBriefAction\(farmMorningFollowupItem\)/);
  assert.match(panel, /const farmMorningComboReceipt = Boolean\(/);
  assert.match(panel, /farmMorningBriefReceipt === farmMorningFollowupItem\.id/);
  assert.match(panel, /const farmMorningComboSummary = farmMorningComboReceipt/);
  assert.match(panel, /const farmMorningComboRouteStep = farmMorningComboReceipt/);
  assert.match(panel, /data-farm-summary-morning-combo="true"/);
  assert.match(panel, /data-farm-summary-morning-combo-summary=\{farmMorningComboSummary \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-morning-combo-reward=\{farmMorningComboRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-morning-combo-route="true"/);
  assert.match(panel, /data-farm-summary-morning-combo-route-stage=\{farmMorningComboRouteStep\.stageLabel\}/);
  assert.match(panel, /data-farm-summary-morning-combo-route-target=\{farmMorningComboRouteStep\.routeTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-morning-combo-route-receipt=\{farmDailyRouteReceipt === farmMorningComboRouteStep\.id \? 'true' : undefined\}/);
  assert.match(panel, /handleFarmDailyRouteStepAction\(farmMorningComboRouteStep\)/);
  assert.match(panel, /data-farm-mini-morning-combo=\{farmMorningComboReceipt \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-morning-combo-summary=\{farmMorningComboReceipt \? farmMorningComboSummary \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-morning-combo-reward=\{farmMorningComboReceipt \? farmMorningComboRewardLabel \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="morning-combo"/);
  assert.match(panel, /data-farm-mini-morning-combo-receipt="true"/);
  assert.match(panel, /晨报二连完成/);
  assert.match(css, /\.t8-farm-story-panel__daily-route \{[\s\S]*display:\s*grid/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-steps \{[\s\S]*display:\s*grid/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-step \{[\s\S]*grid-template-columns:\s*30px minmax\(0, 1fr\) auto/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-step\[data-farm-daily-route-receipt="true"\] \{[\s\S]*animation:\s*farm-story-daily-route-receipt/);
  assert.match(css, /@keyframes farm-story-daily-route-receipt/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-next \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*24px minmax\(0, 1fr\) auto/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-next\[data-farm-daily-route-next="true"\] \{[\s\S]*animation:\s*farm-story-daily-route-next/);
  assert.match(css, /@keyframes farm-story-daily-route-next/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-complete \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*24px minmax\(0, 1fr\) auto[\s\S]*background:[\s\S]*var\(--farm-mint/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-complete\[data-farm-daily-route-complete="true"\] \{[\s\S]*animation:\s*farm-story-daily-route-complete/);
  assert.match(css, /@keyframes farm-story-daily-route-complete/);
  assert.match(css, /prefers-reduced-motion:[\s\S]*\.t8-farm-story-panel__daily-route-complete/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-wrapup \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*24px minmax\(0, 1fr\) auto[\s\S]*background:[\s\S]*var\(--farm-sky/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-wrapup:hover,[\s\S]*\.t8-farm-story-panel__daily-route-wrapup:focus-visible \{[\s\S]*transform:\s*translateY\(-1px\)/);
  assert.match(css, /prefers-reduced-motion:[\s\S]*\.t8-farm-story-panel__daily-route-wrapup/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-wrapup-receipt \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*26px minmax\(0, 1fr\) auto[\s\S]*background:[\s\S]*var\(--farm-mint/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-wrapup-receipt\[data-farm-daily-route-wrapup-receipt="true"\] \{[\s\S]*animation:\s*farm-story-daily-route-wrapup-receipt/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-wrapup-next \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*22px minmax\(0, 1fr\) auto[\s\S]*background:[\s\S]*var\(--farm-water/);
  assert.match(css, /\.t8-farm-story-panel__daily-route-wrapup-next\[data-farm-daily-route-wrapup-next-receipt="true"\] \{[\s\S]*animation:\s*farm-story-daily-route-wrapup-next-receipt/);
  assert.match(css, /@keyframes farm-story-daily-route-wrapup-next-receipt/);
  assert.match(css, /@keyframes farm-story-daily-route-wrapup-receipt/);
  assert.match(css, /prefers-reduced-motion:[\s\S]*\.t8-farm-story-panel__daily-route-wrapup-receipt/);
  assert.match(css, /prefers-reduced-motion:[\s\S]*\.t8-farm-story-panel__daily-route-wrapup-next/);
  assert.match(css, /\.t8-farm-story-panel__tomorrow-route \{[\s\S]*display:\s*grid/);
  assert.match(css, /\.t8-farm-story-panel__tomorrow-route-steps button \{[\s\S]*grid-template-columns:\s*34px minmax\(0, 1fr\) auto auto/);
  assert.match(css, /\.t8-farm-story-panel__tomorrow-route-steps button\[data-farm-summary-tomorrow-route-receipt="true"\] \{[\s\S]*animation:\s*farm-story-tomorrow-route-receipt/);
  assert.match(css, /@keyframes farm-story-tomorrow-route-receipt/);
  assert.match(css, /\.t8-farm-story-panel__morning-brief \{[\s\S]*display:\s*grid/);
  assert.match(css, /\.t8-farm-story-panel__morning-brief-items button \{[\s\S]*grid-template-columns:\s*26px minmax\(0, 1fr\) auto/);
  assert.match(css, /\.t8-farm-story-panel__morning-brief-items button\[data-farm-summary-morning-brief-receipt="true"\] \{[\s\S]*animation:\s*farm-story-morning-brief-receipt/);
  assert.match(css, /@keyframes farm-story-morning-brief-receipt/);
  assert.match(css, /\.t8-farm-story-panel__morning-kickstart \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*34px minmax\(0, 1fr\) auto/);
  assert.match(css, /\.t8-farm-story-panel__morning-kickstart\[data-farm-summary-morning-kickstart-receipt="true"\] \{[\s\S]*animation:\s*farm-story-morning-kickstart-receipt/);
  assert.match(css, /@keyframes farm-story-morning-kickstart-receipt/);
  assert.match(css, /\.t8-farm-story-panel__morning-followup \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*22px minmax\(0, 1fr\) auto/);
  assert.match(css, /\.t8-farm-story-panel__morning-followup\[data-farm-summary-morning-followup-active="true"\] \{[\s\S]*animation:\s*farm-story-morning-followup-slide/);
  assert.match(css, /@keyframes farm-story-morning-followup-slide/);
  assert.match(css, /\.t8-farm-story-panel__morning-combo \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*24px minmax\(0, 1fr\) auto/);
  assert.match(css, /\.t8-farm-story-panel__morning-combo\[data-farm-summary-morning-combo="true"\] \{[\s\S]*animation:\s*farm-story-morning-combo-pop/);
  assert.match(css, /@keyframes farm-story-morning-combo-pop/);
  assert.match(css, /\.t8-farm-story-panel__morning-combo-route \{[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*22px minmax\(0, 1fr\) auto/);
  assert.match(css, /\.t8-farm-story-panel__morning-combo-route\[data-farm-summary-morning-combo-route-receipt="true"\] \{[\s\S]*animation:\s*farm-story-morning-combo-route/);
  assert.match(css, /@keyframes farm-story-morning-combo-route/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item="morning-combo"\] \{[\s\S]*display:\s*inline-flex[\s\S]*animation:\s*farm-story-mini-morning-combo/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item="daily-route"\] \{[\s\S]*display:\s*inline-flex[\s\S]*pointer-events:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-daily-route-complete="true"\] \[data-farm-mini-status-item="daily-route"\] \{[\s\S]*background:[\s\S]*var\(--farm-mint/);
  assert.match(css, /\.t8-farm-story-panel__mini-daily-route small\[data-farm-mini-daily-route-complete-chip="true"\] \{[\s\S]*color:[\s\S]*var\(--farm-leaf/);
  assert.match(css, /Farm mini daily route focus capsule v1/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] \[data-farm-mini-status-item="daily-route"\]\[data-farm-mini-daily-route-focus-mode\] \{[\s\S]*max-width:\s*min\(260px, 22vw\)/);
  assert.match(css, /\.t8-farm-story-panel__mini-daily-route i\[data-farm-mini-daily-route-focus-stage="true"\] \{[\s\S]*border-radius:\s*999px/);
  assert.match(css, /\.t8-farm-story-panel__mini-daily-route\[data-farm-mini-daily-route-focus-mode="next"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-daily-route\[data-farm-mini-daily-route-focus-mode="tomorrow"\]/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] \.t8-farm-story-panel__mini-daily-route\[data-farm-mini-daily-route-focus-mode\] :where\(b, small, i\)/);
  assert.match(css, /Farm monitor calm whitelist v1/);
  assert.match(css, /\[data-farm-mini-status-item\]:not\(\[data-farm-mini-status-item="monitor-brief"\]\):not\(\[data-farm-mini-status-item="day"\]\):not\(\[data-farm-mini-status-item="season"\]\):not\(\[data-farm-mini-status-item="weather"\]\):not\(\[data-farm-mini-status-item="gold"\]\):not\(\[data-farm-mini-status-item="seed"\]\):not\(\[data-farm-mini-status-item="water"\]\):not\(\[data-farm-mini-status-item="daily-route"\]\):not\(\[data-farm-mini-status-item="morning-combo"\]\):not\(\[data-farm-mini-status-item="priority-combo"\]\):not\(\[data-farm-mini-status-item="priority-flow"\]\) \{[\s\S]*display:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-daily-route b \{[\s\S]*max-width:\s*min\(360px, 28vw\)/);
  assert.match(css, /@keyframes farm-story-mini-morning-combo/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__panel,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions \{[\s\S]*background:[\s\S]*var\(--farm-ui-panel\)[\s\S]*color:\s*var\(--farm-ui-text\)/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard button,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__focus \{[\s\S]*background:[\s\S]*var\(--farm-ui-card\)[\s\S]*color:\s*var\(--farm-ui-text\)/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \{[\s\S]*--farm-ui-panel-solid:\s*#fff8df[\s\S]*--farm-ui-text-strong:\s*#2e1708[\s\S]*--farm-ui-muted-strong:\s*#5f3b18/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] :where\(span, button\[data-farm-mini-status-item\]\) \{[\s\S]*background:[\s\S]*var\(--farm-ui-card-solid\) !important[\s\S]*color:\s*var\(--farm-ui-text-strong\) !important[\s\S]*opacity:\s*1 !important/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions button,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard button \{[\s\S]*background:[\s\S]*var\(--farm-ui-card-solid\) !important[\s\S]*color:\s*var\(--farm-ui-text-strong\) !important[\s\S]*text-shadow:\s*none/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions button\.is-unavailable,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status button:disabled \{[\s\S]*opacity:\s*1 !important[\s\S]*filter:\s*none !important[\s\S]*color:\s*var\(--farm-ui-text-strong\) !important/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__panel :where\(small, em, mark, i\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard small,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions button em \{[\s\S]*font-size:\s*12px[\s\S]*color:\s*var\(--farm-ui-muted-strong\) !important/);
  assert.match(farmDarkHudCss, /Farm dark HUD final contrast guard/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\],[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard \{[\s\S]*background:[\s\S]*var\(--farm-ui-panel-solid\) !important[\s\S]*color:\s*var\(--farm-ui-text-strong\) !important/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] > :where\(span, button\[data-farm-mini-status-item\]\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions button,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard button \{[\s\S]*background:[\s\S]*var\(--farm-ui-card-solid\) !important[\s\S]*-webkit-text-fill-color:\s*var\(--farm-ui-text-strong\) !important[\s\S]*opacity:\s*1 !important/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] > :where\(span, button\[data-farm-mini-status-item\]\) :where\(b, strong, span, small, em, i, mark\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions button :where\(b, strong, span, small, em, i, mark\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard button :where\(b, strong, span, small, em, i, mark\) \{[\s\S]*font-size:\s*12px[\s\S]*font-weight:\s*900[\s\S]*opacity:\s*1 !important/);
  assert.match(farmDarkHudCss, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions button\.is-unavailable,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard button:disabled,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status\[data-farm-mini-status="monitor"\] button:disabled \{[\s\S]*background:[\s\S]*var\(--farm-ui-chip-solid\) !important[\s\S]*filter:\s*none !important/);
  assert.match(farmDarkConsoleLock, /Farm dark console contrast lock/);
  assert.match(farmDarkConsoleLock, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel \{[\s\S]*--farm-paper:\s*#fff8df[\s\S]*--farm-ui-text:\s*#2e1708[\s\S]*color-scheme:\s*light/);
  assert.match(farmDarkConsoleLock, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel\.is-muted \.t8-farm-story-panel__panel \{[\s\S]*opacity:\s*1 !important/);
  assert.match(farmDarkConsoleLock, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__panel > :not\(\.t8-farm-story-panel__header\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__summary-action-receipt,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__npc-delivery-receipt,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__order-reward-pocket \{[\s\S]*background:[\s\S]*var\(--farm-ui-card-solid\) !important[\s\S]*color:\s*var\(--farm-ui-text-strong\) !important/);
  assert.match(farmDarkConsoleLock, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__panel > :not\(\.t8-farm-story-panel__header\) :where\(p, li, label, b, strong, span, button\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status :where\(b, strong, span\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions button :where\(span, b, strong\) \{[\s\S]*-webkit-text-fill-color:\s*var\(--farm-ui-text-strong\) !important[\s\S]*font-weight:\s*800/);
  assert.match(farmDarkConsoleLock, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__panel > :not\(\.t8-farm-story-panel__header\) :where\(small, em, i, mark\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status :where\(small, em, i, mark\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions button em,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard small \{[\s\S]*-webkit-text-fill-color:\s*var\(--farm-ui-muted-strong\) !important[\s\S]*font-size:\s*12px !important[\s\S]*line-height:\s*1\.25/);
  assert.match(farmDarkConsoleLock, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__summary-actions button,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__tools button,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__palette button,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quest-reward,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__summary-metrics span \{[\s\S]*background:[\s\S]*var\(--farm-ui-chip-solid\) !important[\s\S]*opacity:\s*1 !important/);
  assert.match(farmDarkConsoleLock, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel :where\(button:disabled, \.is-unavailable, \[aria-disabled="true"\]\) \{[\s\S]*opacity:\s*1 !important[\s\S]*filter:\s*none !important[\s\S]*-webkit-text-fill-color:\s*var\(--farm-ui-text-strong\) !important/);
  assert.match(farmDarkConsoleLock, /Farm dark HUD terminal readability lock/);
  assert.match(farmDarkConsoleLock, /--farm-night-readable-panel:\s*#fff8df/);
  assert.match(farmDarkConsoleLock, /--farm-night-readable-text:\s*#2e1708/);
  assert.match(farmDarkConsoleLock, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__panel > :not\(\.t8-farm-story-panel__header\) \{[\s\S]*background:[\s\S]*var\(--farm-night-readable-panel\) !important[\s\S]*color:\s*var\(--farm-night-readable-text\) !important[\s\S]*opacity:\s*1 !important/);
  assert.match(farmDarkConsoleLock, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__mini-status :where\(span, button, b, strong, small, em, i, mark\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions :where\(button, span, b, strong, small, em, i, mark\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard :where\(button, span, b, strong, small, em, i, mark\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__panel :where\(p, li, label, button, span, b, strong, small, em, i, mark\) \{[\s\S]*-webkit-text-fill-color:\s*currentColor !important[\s\S]*text-shadow:\s*none !important/);
  assert.match(farmDarkConsoleLock, /html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel :where\(button:disabled, \.is-unavailable, \[aria-disabled="true"\]\),[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__quick-actions button\.is-unavailable,[\s\S]*html\[data-theme-mode="dark"\]\[data-theme-visual="farm-story"\] \.t8-farm-story-panel__section-switchboard button:disabled \{[\s\S]*background:[\s\S]*var\(--farm-night-readable-chip\) !important[\s\S]*opacity:\s*1 !important/);
  assert.match(canvas, /<FarmStoryPanel[\s\S]*themeMode=\{theme\}[\s\S]*farmCanvas=\{farmCanvas\}/);
  assert.match(canvas, /<FarmStoryPanel[\s\S]*devToolsEnabled=\{farmDevToolsEnabled\}[\s\S]*onGrantDevMaterials=\{handleFarmGrantDevMaterials\}/);
  assert.match(canvas, /className="t8-canvas-shell[\s\S]*data-theme-visual=\{visualStyle\}[\s\S]*data-theme-mode=\{theme\}/);
  assert.match(panel, /themeMode\?: ThemeMode \| string/);
  assert.match(panel, /data-farm-panel-night-readable=\{themeMode === 'dark' \? 'true' : undefined\}/);
  assert.match(panel, /data-theme-mode=\{themeMode\}/);
  assert.match(css, /Farm dark panel self readability lock/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] :where\(\.t8-farm-story-panel__mini-status, \.t8-farm-story-panel__quick-actions, \.t8-farm-story-panel__section-switchboard, \.t8-farm-story-panel__panel\)[\s\S]*background:[\s\S]*#fff8df !important[\s\S]*color:\s*#2e1708 !important/);
  assert.match(css, /\[data-farm-panel-night-readable="true"\] :where\(\.t8-farm-story-panel__mini-status, \.t8-farm-story-panel__quick-actions, \.t8-farm-story-panel__section-switchboard, \.t8-farm-story-panel__panel\) :where\(button, span, b, strong, small, em, i, mark, p, li, label\)[\s\S]*-webkit-text-fill-color:\s*currentColor !important[\s\S]*opacity:\s*1 !important/);
  assert.match(css, /\.t8-farm-story-panel__mini-status > \.t8-farm-story-panel__mini-placement-target-live \{[\s\S]*position:\s*absolute !important[\s\S]*min-width:\s*0 !important[\s\S]*padding:\s*0 !important[\s\S]*border:\s*0 !important[\s\S]*background:\s*transparent !important[\s\S]*box-shadow:\s*none !important/);
  assert.match(css, /\.t8-farm-story-panel__panel:not\(\[data-farm-section-tools-open="true"\]\) > \.t8-farm-story-panel__tools,[\s\S]*display:\s*none/);
  assert.match(panel, /<b>第\{farmCanvas\?\.day \|\| 1\}天<\/b>/);
  assert.match(panel, /<b>\{seasonDefinition\.label\}<\/b>/);
  assert.match(panel, /<b>\{weatherTitle\}<\/b>/);
  assert.match(panel, /<b>来访 \{readyNpcVisitCount\}<\/b>/);
  assert.match(css, /\.t8-farm-canvas-object\.is-connect-fence\.is-decor-wood-fence \.t8-farm-canvas-object__decor \{[\s\S]*width:\s*16px[\s\S]*height:\s*16px/);
  assert.match(css, /\.t8-farm-canvas-object\[data-farm-object-placement-receipt\] \.t8-farm-canvas-object__badge \{[\s\S]*width:\s*max-content[\s\S]*overflow:\s*visible/);
  assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*\.t8-farm-story-panel__mini-status \{[\s\S]*right:\s*12px[\s\S]*\.t8-farm-story-panel__panel \{[\s\S]*left:\s*12px[\s\S]*right:\s*12px[\s\S]*width:\s*auto/);
  assert.match(canvas, /interface FarmContinuousFeedbackBatch/);
  assert.match(canvas, /placementEcho\?: string/);
  assert.match(canvas, /const farmContinuousFeedbackBatchRef = useRef<FarmContinuousFeedbackBatch \| null>\(null\)/);
  assert.match(canvas, /const MAX_FARM_FLOATING_FEEDBACKS = 8/);
  assert.match(canvas, /const FARM_FLOATING_FEEDBACK_MS = 1350/);
  assert.match(canvas, /const FARM_SOUND_ENABLED_STORAGE_KEY = 't8-farm-story-sfx-enabled'/);
  assert.match(canvas, /function farmFeedbackToneForTool/);
  assert.match(canvas, /function compactFarmFloatingMessage/);
  assert.match(canvas, /function farmContinuousFeedbackLabel/);
  assert.match(canvas, /function findNewFarmPlacedObjectId\([\s\S]*previous: FarmCanvasState[\s\S]*next: FarmCanvasState[\s\S]*tool: FarmToolAction\['tool'\]/);
  assert.match(canvas, /tool !== 'build' && tool !== 'decor'[\s\S]*expectedKind = tool === 'build' \? 'building' : 'decor'[\s\S]*placedObject\?\.id \|\| null/);
  assert.match(canvas, /beautyGain\?: number/);
  assert.match(canvas, /beautyRewardTitle\?: string/);
  assert.match(canvas, /beautyRewardCount\?: number/);
  assert.match(canvas, /function farmBeautyGainForAction\([\s\S]*previous: FarmCanvasState[\s\S]*next: FarmCanvasState[\s\S]*tool: FarmToolAction\['tool'\]/);
  assert.match(canvas, /tool !== 'build' && tool !== 'decor'[\s\S]*buildFarmBeautyScore\(previous\)\.score[\s\S]*buildFarmBeautyScore\(next\)\.score/);
  assert.match(canvas, /function farmBeautyRewardUnlockForAction\([\s\S]*buildFarmBeautyRewards\(previous\)[\s\S]*buildFarmBeautyRewards\(next\)[\s\S]*newlyUnlocked\[0\]\.title/);
  assert.match(canvas, /const playFarmSound = useCallback\(\(cue: FarmSoundCue\)/);
  assert.match(canvas, /const handleFarmToggleSound = useCallback/);
  assert.match(canvas, /playFarmActionSound\('select', \{ enabled: true \}\)/);
  assert.match(canvas, /const pushFarmFloatingFeedback = useCallback/);
  assert.match(canvas, /const flushFarmContinuousFeedback = useCallback/);
  assert.match(canvas, /const queueFarmContinuousFeedback = useCallback/);
  assert.match(canvas, /const beautySuffix = batch\.beautyGain \? ` · 漂亮度 \+\$\{batch\.beautyGain\}` : ''/);
  assert.match(canvas, /const beautyRewardSuffix = batch\.beautyRewardCount/);
  assert.match(canvas, /const placementSuffix = batch\.placementEcho \? ` · \$\{batch\.placementEcho\}` : ''/);
  assert.match(canvas, /message: `\$\{batch\.label\} x\$\{batch\.count\}\$\{placementSuffix\}\$\{beautySuffix\}\$\{beautyRewardSuffix\}`/);
  assert.match(canvas, /tone: batch\.beautyGain \|\| batch\.beautyRewardCount \? 'reward' : batch\.tone/);
  assert.match(canvas, /const beautyGain = Math\.max\(0, Math\.round\(Number\(entry\.beautyGain\) \|\| 0\)\)/);
  assert.match(canvas, /const beautyRewardCount = Math\.max\(0, Math\.round\(Number\(entry\.beautyRewardCount\) \|\| 0\)\)/);
  assert.match(canvas, /placementEcho: entry\.placementEcho \|\| \(current && current\.tool === entry\.tool \? current\.placementEcho : undefined\)/);
  assert.match(canvas, /window\.setTimeout\(\(\) => \{[\s\S]*flushFarmContinuousFeedback\(\);[\s\S]*\}, 320\)/);
  assert.match(canvas, /\.slice\(0, MAX_FARM_FLOATING_FEEDBACKS\)/);
  assert.match(canvas, /window\.setTimeout\(\(\) => \{[\s\S]*setFarmFloatingFeedbacks\(\(prev\) => prev\.filter/);
  assert.match(canvas, /farmFloatingFeedbackTimersRef\.current\.forEach\(\(timerId\) => window\.clearTimeout\(timerId\)\)/);
  assert.match(canvas, /farmContinuousFeedbackBatchRef\.current\?\.timerId/);
  assert.match(canvas, /const farmMatureJumpIndexRef = useRef\(0\)/);
  assert.match(canvas, /const FARM_JUMP_HIGHLIGHT_MS = 900/);
  assert.match(canvas, /const \[farmJumpHighlightObjectId, setFarmJumpHighlightObjectId\] = useState<string \| null>\(null\)/);
  assert.match(canvas, /const farmJumpHighlightTimerRef = useRef<number \| null>\(null\)/);
  assert.match(canvas, /const flashFarmObject = useCallback\(\(objectId: string\) => \{[\s\S]*setFarmJumpHighlightObjectId\(objectId\)[\s\S]*FARM_JUMP_HIGHLIGHT_MS/);
  assert.match(canvas, /interface FarmToolSelectionFeedback/);
  assert.match(canvas, /function formatFarmSelectionResourceShortage/);
  assert.match(canvas, /function buildFarmToolSelectionFeedback\(/);
  assert.match(canvas, /function farmPlacementEchoForAction\(feedback: string, tool: FarmToolAction\['tool'\]\) \{[\s\S]*if \(tool === 'build' && feedback\.startsWith\('已建造 '\)\) return feedback\.replace\(\/\^已建造\\s\*\/, '落成：'\);[\s\S]*if \(tool === 'decor' && feedback\.startsWith\('已放置 '\)\) return feedback\.replace\(\/\^已放置\\s\*\/, '布置：'\);[\s\S]*return '';[\s\S]*\}/);
  assert.match(canvas, /播种工具：\$\{cropLabel\}种子 x\$\{seedCount\}/);
  assert.match(canvas, /水桶已空，过一天或建水井补水/);
  assert.match(canvas, /建造目标：\$\{building\.label\}，资源不足/);
  assert.match(canvas, /装饰目标：\$\{decor\.label\}，点击画布放置/);
  assert.match(canvas, /function farmMiniMapMarkerFeedback\(marker: FarmMiniMapMarker\)/);
  assert.match(canvas, /function farmMiniMapMarkerTone\(kind: FarmMiniMapMarker\['kind'\]\): FarmCanvasFloatingFeedback\['tone'\]/);
  assert.match(canvas, /function farmMiniMapMarkerSoundCue\(kind: FarmMiniMapMarker\['kind'\]\): FarmSoundCue/);
  assert.match(canvas, /type FarmMiniMapRouteHintTarget/);
  assert.match(canvas, /farmMiniMapMarkerMatchesRouteTarget/);
  assert.match(canvas, /const FARM_MINIMAP_ROUTE_HINT_MS = 1600/);
  assert.match(canvas, /const \[farmMiniMapRouteHint, setFarmMiniMapRouteHint\] = useState/);
  assert.match(canvas, /const farmMiniMapRouteHintTimerRef = useRef<number \| null>\(null\)/);
  assert.match(canvas, /interface FarmMiniMapRouteHint \{[\s\S]*anchor\?: \{ x: number; y: number \}/);
  assert.match(canvas, /function findNearestFarmMiniMapRouteHintMarker\([\s\S]*markers: FarmMiniMapRenderableMarker\[\][\s\S]*anchor\?: \{ x: number; y: number \}[\s\S]*Math\.hypot/);
  assert.match(canvas, /const flashFarmMiniMapRouteHint = useCallback\(\(target: FarmMiniMapRouteHintTarget \| undefined, label = '', anchor\?: \{ x: number; y: number \}\) => \{[\s\S]*setFarmMiniMapRouteHint\(\{[\s\S]*target,[\s\S]*label,[\s\S]*anchor,[\s\S]*id: `farm-route-\$\{Date\.now\(\)\}`[\s\S]*FARM_MINIMAP_ROUTE_HINT_MS/);
  assert.match(canvas, /hint\.routeTarget[\s\S]*flashFarmMiniMapRouteHint\(hint\.routeTarget, hint\.routeLabel \|\| hint\.message, center\)/);
  assert.match(canvas, /const farmMiniMapRouteHintMarker = useMemo\(\(\) => \{[\s\S]*findNearestFarmMiniMapRouteHintMarker\(farmMiniMapRouteHintMarkers, farmMiniMapRouteHint\?\.anchor\)/);
  assert.match(canvas, /useEffect\(\(\) => \{[\s\S]*message: `路线暂无目标：\$\{farmMiniMapRouteHint\.label\}`[\s\S]*setCenter\(centerX, centerY, \{ zoom, duration: 420 \}\)[\s\S]*farmMiniMapRouteHint\.target === 'withered-crop'[\s\S]*selectedTool: 'shovel'[\s\S]*farmMiniMapRouteHintMarker\.objectId[\s\S]*flashFarmObject\(farmMiniMapRouteHintMarker\.objectId\)[\s\S]*message: `已点亮路线：\$\{farmMiniMapRouteHint\.label \|\| farmMiniMapRouteHintMarker\.label\} · \$\{farmMiniMapRouteHintCountLabel\}`/);
  assert.match(canvas, /const continuousLabel = result\.changed && !result\.error && farmToolSupportsContinuousAction\(action\.tool\)/);
  assert.match(canvas, /const placementEcho = result\.changed && !result\.error[\s\S]*\? farmPlacementEchoForAction\(result\.feedback, action\.tool\)[\s\S]*: ''/);
  assert.match(canvas, /const beautyGain = result\.changed && !result\.error[\s\S]*farmBeautyGainForAction\(prev, result\.state, action\.tool\)/);
  assert.match(canvas, /const beautyRewardUnlock = result\.changed && !result\.error[\s\S]*farmBeautyRewardUnlockForAction\(prev, result\.state, action\.tool\)/);
  assert.match(canvas, /const feedbackAnchor = farmActionFeedbackAnchor\(prev, result\.state, action\)/);
  assert.match(canvas, /queueFarmContinuousFeedback\(\{[\s\S]*label: continuousLabel[\s\S]*tone[\s\S]*placementEcho[\s\S]*beautyGain[\s\S]*beautyRewardTitle[\s\S]*beautyRewardCount/);
  assert.match(canvas, /queueFarmContinuousFeedback\(\{[\s\S]*x: feedbackAnchor\.x,[\s\S]*y: feedbackAnchor\.y,[\s\S]*placement: feedbackAnchor\.placement/);
  assert.match(canvas, /flushFarmContinuousFeedback\(\);[\s\S]*pushFarmFloatingFeedback\(\{[\s\S]*x: feedbackAnchor\.x,[\s\S]*y: feedbackAnchor\.y,[\s\S]*placement: feedbackAnchor\.placement,[\s\S]*message: placementEcho \|\| result\.feedback/);
  assert.match(canvas, /const handleFarmCancelContinuousAction = useCallback\(\(reason: 'escape' \| 'contextmenu' \| 'blur'\) => \{[\s\S]*flushFarmContinuousFeedback\(\)/);
  assert.match(canvas, /已暂停连续农活/);
  assert.match(canvas, /右键已取消连续农活/);
  assert.match(canvas, /const handleFarmCancelContinuousAction[\s\S]*tone: 'warning'[\s\S]*playFarmSound\('select'\)/);
  assert.match(canvas, /const handleFarmFinishContinuousAction = useCallback\(\(\) => \{[\s\S]*flushFarmContinuousFeedback\(\);[\s\S]*\}, \[flushFarmContinuousFeedback\]\)/);
  assert.match(canvas, /const tone = farmFeedbackToneForTool\(action\.tool, Boolean\(result\.error\)\)/);
  assert.match(canvas, /playFarmSound\(result\.changed && !result\.error[\s\S]*farmSoundCueForEvent\(result\.state\.eventLog\[0\]\?\.kind\)[\s\S]*farmSoundCueForTool\(action\.tool, Boolean\(result\.error\)\)/);
  assert.match(canvas, /if \(beautyGain > 0 && !continuousLabel\)[\s\S]*message: `漂亮度 \+\$\{beautyGain\}`[\s\S]*tone: 'reward'/);
  assert.match(canvas, /if \(beautyRewardUnlock && !continuousLabel\)[\s\S]*message: beautyRewardUnlock\.count > 1[\s\S]*`解锁美化奖励：\$\{beautyRewardUnlock\.title\}`[\s\S]*tone: 'reward'/);
  assert.match(canvas, /const placedObjectId = findNewFarmPlacedObjectId\(prev, result\.state, action\.tool\);[\s\S]*if \(placedObjectId\) flashFarmObject\(placedObjectId\);[\s\S]*trackFarmAchievementsFromEvents/);
  assert.match(canvas, /\}, \[flashFarmObject, flushFarmContinuousFeedback, playFarmSound, pushFarmFloatingFeedback, queueFarmContinuousFeedback, trackFarmAchievementsFromEvents\]\)/);
  assert.match(canvas, /farmToolSupportsContinuousAction/);
  assert.match(canvas, /按住拖动可连续操作/);
  assert.match(canvas, /按住拖动可连续放置/);
  assert.match(canvas, /const handleFarmJumpToMature = useCallback\(\(\) => \{[\s\S]*object\.kind === 'plot' && object\.crop\?\.stage === 'mature'[\s\S]*当前没有成熟作物[\s\S]*tone: 'warning'[\s\S]*setCenter\([\s\S]*\{ zoom, duration: 420 \}[\s\S]*selectedTool: 'harvest'[\s\S]*flashFarmObject\(target\.id\)[\s\S]*message: `成熟作物 \$\{index \+ 1\}\/\$\{matureObjects\.length\}`[\s\S]*tone: 'reward'[\s\S]*playFarmSound\('harvest'\)/);
  assert.match(canvas, /const handleFarmMiniMapMarkerClick = useCallback\(\(event: ReactMouseEvent<HTMLButtonElement>, marker: FarmMiniMapRenderableMarker\) => \{[\s\S]*event\.preventDefault\(\)[\s\S]*setCenter\(centerX, centerY, \{ zoom, duration: 420 \}\)[\s\S]*marker\.kind === 'mature'[\s\S]*selectedTool: 'harvest'[\s\S]*marker\.kind === 'dry'[\s\S]*selectedTool: 'water'[\s\S]*marker\.kind === 'withered'[\s\S]*selectedTool: 'shovel'[\s\S]*flashFarmObject\(marker\.objectId\)[\s\S]*farmMiniMapMarkerTone\(marker\.kind\)[\s\S]*playFarmSound\(farmMiniMapMarkerSoundCue\(marker\.kind\)\)/);
  assert.match(canvas, /const handleFarmAdvanceDay = useCallback\(\(\) => \{[\s\S]*pushFarmFloatingFeedback\(\{[\s\S]*tone: next\.lastDailySummary\?\.newMatureCrops \? 'reward' : 'success'/);
  assert.match(canvas, /const handleFarmCompleteOrder = useCallback\(\(orderId: string\) => \{[\s\S]*pushFarmFloatingFeedback\(\{[\s\S]*tone: result\.error \? 'warning' : 'reward'/);
  assert.match(farmToolSelectionFeedbackHandler, /setFarmCanvasFeedback\(feedback\.message\)/);
  assert.match(farmToolSelectionFeedbackHandler, /playFarmSound\('select'\)/);
  assert.doesNotMatch(farmToolSelectionFeedbackHandler, /getFarmViewportCenter/);
  assert.doesNotMatch(farmToolSelectionFeedbackHandler, /pushFarmFloatingFeedback/);
  assert.match(canvas, /const handleFarmGrantDevMaterials = useCallback\(\(\) => \{[\s\S]*if \(!import\.meta\.env\.DEV\) return;[\s\S]*const cropIds = Object\.keys\(FARM_CROP_DEFINITIONS\) as FarmCropId\[\];[\s\S]*const animalProductIds = Object\.keys\(FARM_ANIMAL_PRODUCT_DEFINITIONS\) as FarmAnimalProductId\[\];[\s\S]*gold: FARM_DEV_TEST_MATERIAL_AMOUNT,[\s\S]*water: FARM_DEV_TEST_WATER_AMOUNT,[\s\S]*discoveredCropIds: cropIds,[\s\S]*unlockedDecorIds: decorIds/);
  assert.match(canvas, /setFarmCanvasFeedback\('开发环境测试材料已补齐：金币\/木材\/石头\/种子\/作物\/动物产物 9999，水量 999，装饰全解锁。'\)/);
  assert.match(canvas, /const handleFarmSelectTool = useCallback\(\(tool: FarmTool\) => \{[\s\S]*showFarmToolSelectionFeedback\(buildFarmToolSelectionFeedback\(tool, nextFarmCanvas\)\)/);
  assert.match(canvas, /const handleFarmSelectBuilding = useCallback\(\(buildingId: string\) => \{/);
  assert.match(canvas, /selectedTool:\s*'build'/);
  assert.match(canvas, /selectedBuildingId:\s*building\.id/);
  assert.match(canvas, /showFarmToolSelectionFeedback\(buildFarmToolSelectionFeedback\('build', nextFarmCanvas\)\)/);
  assert.match(canvas, /const handleFarmSelectDecor = useCallback\(\(decorId: string\) => \{/);
  assert.match(canvas, /selectedTool:\s*'decor'/);
  assert.match(canvas, /selectedDecorId:\s*decor\.id/);
  assert.match(canvas, /FARM_DEFAULT_DECOR_ID/);
  assert.match(canvas, /showFarmToolSelectionFeedback\(buildFarmToolSelectionFeedback\('decor', nextFarmCanvas\)\)/);
  assert.match(canvas, /resourceDecorLabel: `\$\{resource\.title \|\| resource\.id\} -> \$\{typeLabel\}`/);
  assert.match(canvas, /<FarmStoryPanel[\s\S]*farmCanvas=\{farmCanvas\}[\s\S]*editing=\{farmCanvasEditing\}[\s\S]*onSelectTool=\{handleFarmSelectTool\}/);
  assert.match(panel, /devToolsEnabled && onGrantDevMaterials && \([\s\S]*className="t8-farm-story-panel__dev-materials"[\s\S]*data-farm-dev-materials="9999"[\s\S]*data-farm-dev-only="true"[\s\S]*onGrantDevMaterials\(\)[\s\S]*DEV 9999/);
  assert.match(canvas, /onSelectBuilding=\{handleFarmSelectBuilding\}/);
  assert.match(canvas, /onSelectDecor=\{handleFarmSelectDecor\}/);
  assert.match(canvas, /onJumpToMature=\{handleFarmJumpToMature\}/);
  assert.match(canvas, /soundEnabled=\{farmSoundEnabled\}/);
  assert.match(canvas, /onToggleSound=\{handleFarmToggleSound\}/);
  assert.match(canvas, /<FarmCanvasLayer[\s\S]*farmCanvas=\{farmCanvas\}[\s\S]*editing=\{farmCanvasEditing\}[\s\S]*visualStyle=\{visualStyle\}[\s\S]*feedbacks=\{farmFloatingFeedbacks\}[\s\S]*onAction=\{handleFarmCanvasAction\}[\s\S]*onCancelContinuousAction=\{handleFarmCancelContinuousAction\}[\s\S]*onFinishContinuousAction=\{handleFarmFinishContinuousAction\}/);

  assert.match(utils, /export interface FarmToolAction \{[\s\S]*screenX\?: number;[\s\S]*screenY\?: number;/);
  assert.match(layer, /const buildFarmToolAction = useCallback\(\(x: number, y: number, screenX\?: number, screenY\?: number\): FarmToolAction =>/);
  assert.match(layer, /screenX,[\s\S]*screenY,/);
  assert.match(layer, /const action = buildFarmToolAction\(point\.x, point\.y, event\.clientX, event\.clientY\)/);
  assert.match(layer, /placement\?: 'above' \| 'below'/);
  assert.match(layer, /data-farm-feedback-placement=\{feedback\.placement \|\| 'above'\}/);
  assert.match(css, /Farm canvas feedback anchor placement v1/);
  assert.match(css, /\.t8-farm-canvas-feedback\[data-farm-feedback-placement="above"\] \{/);
  assert.match(css, /\.t8-farm-canvas-feedback\[data-farm-feedback-placement="below"\] \{/);
  assert.match(css, /\.t8-farm-canvas-feedback\[data-farm-feedback-placement="below"\]::before \{[\s\S]*top:\s*-7px[\s\S]*border-left:\s*2px solid var\(--farm-wood\)[\s\S]*border-top:\s*2px solid var\(--farm-wood\)/);

  assert.match(panel, /farmCanvas\?: FarmCanvasState/);
  assert.match(panel, /soundEnabled\?: boolean/);
  assert.match(panel, /onToggleSound\?: \(enabled: boolean\) => void/);
  assert.match(panel, /onSelectBuilding\?: \(buildingId: string\) => void/);
  assert.match(panel, /onSelectDecor\?: \(decorId: string\) => void/);
  assert.match(panel, /FARM_BUILDING_DEFINITIONS/);
  assert.match(panel, /FARM_DECOR_DEFINITIONS/);
  assert.match(panel, /FARM_ANIMAL_DEFINITIONS/);
  assert.match(panel, /FARM_ANIMAL_PRODUCT_DEFINITIONS/);
  assert.match(panel, /formatAnimalProductTotals/);
  assert.match(panel, /FARM_DEFAULT_DECOR_ID/);
  assert.match(panel, /farmWeatherLabel/);
  assert.match(panel, /farmWeatherShortLabel/);
  assert.match(panel, /FARM_SEASON_DEFINITIONS/);
  assert.match(panel, /farmSeasonProgress/);
  assert.match(panel, /farmSeasonShortLabel/);
  assert.match(panel, /buildFarmBeautyScore/);
  assert.match(panel, /buildFarmBeautyRewards/);
  assert.match(panel, /type FarmBeautyReward/);
  assert.match(panel, /buildFarmFocusGoals/);
  assert.match(panel, /type FarmFocusGoal/);
  assert.match(panel, /const seasonProgress = farmSeasonProgress\(farmCanvas\?\.day \|\| 1\)/);
  assert.match(panel, /t8-farm-story-panel__season/);
  assert.match(panel, /ref=\{farmSeasonRef\}[\s\S]*className="t8-farm-story-panel__season"[\s\S]*data-farm-season-focus=\{farmSeasonDetailOpened \? 'true' : undefined\}[\s\S]*data-farm-season-pulse=\{farmSeasonDetailPulseId \|\| undefined\}[\s\S]*tabIndex=\{-1\}/);
  assert.match(panel, /farmSeasonDetailOpened && \([\s\S]*<em data-farm-season-located-feedback="true">已定位<\/em>[\s\S]*\)/);
  assert.match(panel, /data-farm-season-weather="true"[\s\S]*天气 \{farmWeatherShortLabel\(currentWeather\)\}/);
  assert.match(panel, /data-farm-season=\{currentSeason\}/);
  assert.match(panel, /下一季：\{nextSeasonLabel\}/);
  assert.match(panel, /const farmBeautyScore = buildFarmBeautyScore\(farmCanvas\)/);
  assert.match(panel, /const farmBeautyRewards = buildFarmBeautyRewards\(farmCanvas\)/);
  assert.match(panel, /const nextBeautyReward: FarmBeautyReward \| undefined = farmBeautyRewards\.find/);
  assert.match(panel, /const \[farmBeautyRewardRouteReceipt, setFarmBeautyRewardRouteReceipt\] = useState\(''\)/);
  assert.match(panel, /const farmBeautyRewardRouteTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmBeautyRewardRouteTarget: FarmStoryPanelRouteHintTarget = 'beauty'/);
  assert.match(panel, /const farmBeautyRewardRouteLabel = farmRouteLabelForTarget\(farmBeautyRewardRouteTarget\)/);
  assert.match(panel, /const farmBeautyRewardRouteCountLabel = nextBeautyReward[\s\S]*`差\$\{nextBeautyReward\.remainingScore\}分`[\s\S]*`\$\{farmBeautyScore\.score\}分`/);
  assert.match(panel, /const farmBeautyRewardRouteRewardLabel = nextBeautyReward \? nextBeautyReward\.title : '美化满级'/);
  assert.match(panel, /const farmBeautyRewardRouteTitle = nextBeautyReward[\s\S]*美化奖励路线：冲\$\{nextBeautyReward\.title\}[\s\S]*地图找\$\{farmBeautyRewardRouteLabel\}[\s\S]*奖励已全部解锁/);
  assert.match(panel, /const flashFarmBeautyRewardRouteHint = \(label: string\) => \{[\s\S]*setFarmBeautyRewardRouteReceipt\(label\)[\s\S]*setFarmBeautyRewardRouteReceipt\(''\)[\s\S]*farmBeautyRewardRouteTimerRef\.current = null/);
  assert.match(panel, /const handleFarmBeautyRewardRouteHintAction = \(\) => \{[\s\S]*flashFarmBeautyRewardRouteHint\('已指路'\)[\s\S]*message: `美化奖励路线：\$\{farmBeautyRewardRouteRewardLabel\} · \$\{farmBeautyRewardRouteCountLabel\}`[\s\S]*routeTarget: farmBeautyRewardRouteTarget[\s\S]*routeLabel: farmBeautyRewardRouteLabel[\s\S]*routeTitle: farmBeautyRewardRouteTitle/);
  assert.match(panel, /const currentWeather = farmCanvas\?\.weather \|\| 'sunny'/);
  assert.match(panel, /const MiniWeatherIcon = farmWeatherIcon\(currentWeather\)/);
  assert.match(panel, /t8-farm-story-panel__beauty/);
  assert.match(panel, /ref=\{farmBeautyRef\}[\s\S]*className=\{`t8-farm-story-panel__beauty is-level-\$\{farmBeautyScore\.level\}`\}[\s\S]*data-farm-beauty-focus=\{farmBeautyDetailOpened \? 'true' : undefined\}[\s\S]*data-farm-beauty-pulse=\{farmBeautyDetailPulseId \|\| undefined\}[\s\S]*tabIndex=\{-1\}/);
  assert.match(panel, /farmBeautyDetailOpened && \([\s\S]*<em data-farm-beauty-located-feedback="true">已定位<\/em>[\s\S]*\)/);
  assert.match(panel, /牧场漂亮度/);
  assert.match(panel, /美化奖励/);
  assert.match(panel, /data-farm-beauty-reward=\{reward\.id\}/);
  assert.match(panel, /data-farm-beauty-reward-next=\{nextBeautyReward\?\.id === reward\.id \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-beauty-reward-remaining=\{reward\.unlocked \? undefined : reward\.remainingScore\}/);
  assert.match(panel, /data-farm-beauty-reward-route-chip="true"[\s\S]*\{reward\.remainingScore\}分/);
  assert.match(panel, /data-farm-beauty-factor=\{factor\.id\}/);
  assert.match(panel, /const farmFocusGoals = buildFarmFocusGoals\(farmCanvas, \{ maxGoals: 3 \}\)/);
  assert.match(panel, /const primaryFarmFocus = farmFocusGoals\[0\]/);
  assert.match(panel, /const primaryFarmFocusReady = Boolean\(primaryFarmFocus\?\.ready\)/);
  assert.match(panel, /const primaryFarmFocusComplete = Boolean\(primaryFarmFocus && primaryFarmFocus\.percent >= 100\)/);
  assert.match(panel, /const primaryFarmFocusStatusLabel = primaryFarmFocusComplete \? '已完成' : primaryFarmFocusReady \? '可执行' : '推进中'/);
  assert.match(panel, /function farmMiniFocusActionLabel\(goal\?: FarmFocusGoal\)/);
  assert.match(panel, /goal\.action\.kind === 'select-tool'[\s\S]*farmToolOption\(goal\.action\.tool\)\.label/);
  assert.match(panel, /goal\.action\.kind === 'complete-order'[\s\S]*return '交单'/);
  assert.match(panel, /function farmMiniFocusActionIcon\(goal: FarmFocusGoal\)/);
  assert.match(panel, /goal\.action\.tool === 'water'[\s\S]*return Droplets/);
  assert.match(panel, /goal\.action\.tool === 'harvest'[\s\S]*return Wheat/);
  assert.match(panel, /goal\.action\.kind === 'complete-order'[\s\S]*return Package/);
  assert.match(panel, /goal\.action\.kind === 'complete-npc'[\s\S]*return UserRound/);
  assert.match(panel, /const primaryFarmFocusActionLabel = farmMiniFocusActionLabel\(primaryFarmFocus\)/);
  assert.match(panel, /const farmMiniQuickActionBusy = Boolean\(farmMiniQuickActionFeedback\)/);
  assert.match(panel, /function farmMiniActionResourceTargets\(feedback: FarmMiniQuickActionFeedback \| null\): string\[\]/);
  assert.match(panel, /feedback\.tool === 'water'[\s\S]*return \['water'\]/);
  assert.match(panel, /feedback\.tool === 'seed'[\s\S]*return \['seed'\]/);
  assert.match(panel, /feedback\.actionKind === 'select-building' && feedback\.buildingId === 'scarecrow'[\s\S]*return \['wood', 'stone', 'scarecrow'\]/);
  assert.match(panel, /feedback\.actionKind === 'select-building'[\s\S]*return \['wood', 'stone'\]/);
  assert.match(panel, /feedback\.actionKind === 'complete-order'[\s\S]*return \['gold'\]/);
  assert.match(panel, /function farmMiniResourceFeedbackLabel\(targets: string\[\], feedback: FarmMiniQuickActionFeedback \| null\): string/);
  assert.match(panel, /targets\.includes\('scarecrow'\)[\s\S]*resourceLabel = '木石\/守护'/);
  assert.match(panel, /targets\.includes\('wood'\) && targets\.includes\('stone'\)[\s\S]*resourceLabel = '木石'/);
  assert.match(panel, /targets\.includes\('water'\)[\s\S]*resourceLabel = '水量'/);
  assert.match(panel, /targets\.includes\('gold'\)[\s\S]*resourceLabel = '金币'/);
  assert.match(panel, /function farmMiniActivityFeedbackLabel\(feedback: FarmMiniQuickActionFeedback \| null\): string/);
  assert.match(panel, /return `今日 · \$\{feedback\.label\}`/);
  assert.match(panel, /function buildFarmMiniQuickActionSummaryLabel\(/);
  assert.match(panel, /resourceLabel && `资源：\$\{resourceLabel\}`/);
  assert.match(panel, /activityLabel && `今日：\$\{activityLabel\}`/);
  assert.match(panel, /focusTitle && `小目标：\$\{focusTitle\}`/);
  assert.match(panel, /const farmMiniQuickActionResourceTargets = farmMiniActionResourceTargets\(farmMiniQuickActionFeedback\)/);
  assert.match(panel, /const farmMiniQuickActionResourceFeedbackLabel = farmMiniResourceFeedbackLabel\(farmMiniQuickActionResourceTargets, farmMiniQuickActionFeedback\)/);
  assert.match(panel, /const farmMiniQuickActionActivityFeedbackLabel = farmMiniActivityFeedbackLabel\(farmMiniQuickActionFeedback\)/);
  assert.match(panel, /const farmMiniQuickActionSummaryLabel = buildFarmMiniQuickActionSummaryLabel\(/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptLabel = farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocusActionLabel/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptDetails = \[[\s\S]*farmMiniQuickActionResourceFeedbackLabel \? `资源：\$\{farmMiniQuickActionResourceFeedbackLabel\}` : ''[\s\S]*farmMiniQuickActionActivityFeedbackLabel \? `今日：\$\{farmMiniQuickActionActivityFeedbackLabel\}` : ''[\s\S]*\.filter\(Boolean\)/);
  assert.match(panel, /primaryFarmFocusProgressPreview \? `进度：\$\{farmActivityEmptyForecastReceiptProgressStateLabel \? `\$\{farmActivityEmptyForecastReceiptProgressStateLabel\} ` : ''\}\$\{primaryFarmFocusProgressPreview\}` : ''/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptTitle = farmActivityEmptyForecastReceiptDetails\.length > 0[\s\S]*`预期已确认：\$\{farmActivityEmptyForecastReceiptLabel\} · \$\{farmActivityEmptyForecastReceiptDetails\.join\(' · '\)\}`[\s\S]*`预期已确认：\$\{farmActivityEmptyForecastReceiptLabel\}`/);
  assert.match(panel, /const farmMiniQuickActionReceiptItems = farmMiniQuickActionDetailItems\.filter\(\(item\) => item\.id !== 'result'\)/);
  assert.match(panel, /const primaryFarmFocusActionResourceTargets = primaryFarmFocus\?\.action \? farmActionResourceTargets\(primaryFarmFocus\.action\) : \[\]/);
  assert.match(panel, /const primaryFarmFocusActionResourcePreview = farmActionResourcePreviewLabel\(primaryFarmFocusActionResourceTargets\)/);
  assert.match(panel, /const primaryFarmFocusForecastItems = \[[\s\S]*id: 'action'[\s\S]*tone: 'action'[\s\S]*label: `下一步：\$\{primaryFarmFocus\.actionLabel\}`[\s\S]*actionable: true[\s\S]*id: 'resource'[\s\S]*tone: 'resource'[\s\S]*label: primaryFarmFocusActionResourcePreview[\s\S]*id: 'progress'[\s\S]*tone: 'progress'[\s\S]*label: primaryFarmFocusProgressPreview[\s\S]*\.filter\(\(item\): item is \{ id: string; tone: 'action' \| 'resource' \| 'progress'; label: string; actionable\?: boolean \} => Boolean\(item\)\)/);
  assert.match(panel, /const handleFarmFocusAction = \(goal: FarmFocusGoal\) =>/);
  assert.match(panel, /const handleFarmFocusAction = \(goal: FarmFocusGoal\) => \{[\s\S]*if \(farmMiniQuickActionBusy\) return;[\s\S]*const actionLabel = farmMiniFocusActionLabel\(goal\) \|\| goal\.actionLabel;[\s\S]*handleFarmGoalAction\(goal\.action\);[\s\S]*flashFarmMiniQuickAction\(goal, actionLabel\)/);
  assert.match(panel, /action\.kind === 'select-tool'[\s\S]*onSelectTool\?\.\(action\.tool\)/);
  assert.match(panel, /action\.kind === 'jump-mature'[\s\S]*onJumpToMature\?\.\(\)/);
  assert.match(panel, /action\.kind === 'complete-order'[\s\S]*onCompleteOrder\?\.\(action\.orderId\)/);
  assert.match(panel, /action\.kind === 'complete-npc'[\s\S]*onCompleteNpcVisit\?\.\(action\.visitId\)/);
  assert.match(panel, /action\.kind === 'select-building'[\s\S]*onSelectBuilding\?\.\(action\.buildingId\)/);
  assert.match(panel, /action\.kind === 'select-decor'[\s\S]*onSelectDecor\?\.\(action\.decorId\)/);
  assert.match(panel, /action\.kind === 'advance-day'[\s\S]*onAdvanceDay\?\.\(\)/);
  assert.match(panel, /t8-farm-story-panel__focus/);
  assert.match(panel, /data-farm-focus-goal=\{primaryFarmFocus\.id\}/);
  assert.match(panel, /className=\{`t8-farm-story-panel__focus is-\$\{primaryFarmFocus\.kind\}`\}[\s\S]*data-farm-focus-goal=\{primaryFarmFocus\.id\}[\s\S]*data-farm-focus-progress-preview=\{primaryFarmFocusProgressPreview \|\| undefined\}[\s\S]*data-farm-focus-next-progress=\{primaryFarmFocus \? primaryFarmFocusNextProgress : undefined\}[\s\S]*data-farm-focus-next-percent=\{primaryFarmFocus \? primaryFarmFocusNextPercent : undefined\}[\s\S]*data-farm-focus-action-resource-targets=\{primaryFarmFocusActionResourceTargets\.join\(' '\) \|\| undefined\}[\s\S]*data-farm-focus-action-resource-preview=\{primaryFarmFocusActionResourcePreview \|\| undefined\}/);
  assert.match(panel, /data-farm-focus-progress-preview=\{primaryFarmFocusProgressPreview \|\| undefined\}/);
  assert.match(panel, /data-farm-focus-next-progress=\{primaryFarmFocus \? primaryFarmFocusNextProgress : undefined\}/);
  assert.match(panel, /data-farm-focus-next-percent=\{primaryFarmFocus \? primaryFarmFocusNextPercent : undefined\}/);
  assert.match(panel, /data-farm-focus-action-resource-targets=\{primaryFarmFocusActionResourceTargets\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-focus-action-resource-preview=\{primaryFarmFocusActionResourcePreview \|\| undefined\}/);
  assert.match(panel, /aria-label=\{`牧场今日小目标：\$\{primaryFarmFocus\.title\}，\$\{primaryFarmFocus\.progress\}\/\$\{primaryFarmFocus\.target\}，\$\{primaryFarmFocusStatusLabel\}，\$\{primaryFarmFocusProgressPreview\}，下一步 \$\{primaryFarmFocus\.actionLabel\}\$\{primaryFarmFocusActionResourcePreview \? `，\$\{primaryFarmFocusActionResourcePreview\}` : ''\}`\}/);
  assert.match(panel, /title=\{`今日小目标：\$\{primaryFarmFocus\.title\} · \$\{primaryFarmFocusProgressPreview\} · 下一步：\$\{primaryFarmFocus\.actionLabel\}\$\{primaryFarmFocusActionResourcePreview \? ` · \$\{primaryFarmFocusActionResourcePreview\}` : ''\}`\}/);
  assert.match(panel, /今日小目标/);
  assert.match(panel, /<strong[\s\S]*data-farm-focus-head-progress-preview=\{primaryFarmFocusProgressPreview \|\| undefined\}[\s\S]*data-farm-focus-head-next-progress=\{primaryFarmFocus \? primaryFarmFocusNextProgress : undefined\}[\s\S]*data-farm-focus-head-next-percent=\{primaryFarmFocus \? primaryFarmFocusNextPercent : undefined\}[\s\S]*title=\{`小目标 \$\{primaryFarmFocus\.progress\}\/\$\{primaryFarmFocus\.target\} · \$\{primaryFarmFocusProgressPreview\}`\}/);
  assert.match(panel, /primaryFarmFocusProgressPreview && \([\s\S]*data-farm-focus-head-progress-preview="true"[\s\S]*\{primaryFarmFocusProgressPreview\}/);
  assert.match(panel, /primaryFarmFocusForecastItems\.length > 0 && \([\s\S]*className="t8-farm-story-panel__focus-forecast"[\s\S]*data-farm-focus-forecast="true"[\s\S]*data-farm-focus-forecast-progress=\{primaryFarmFocusProgressPreview \|\| undefined\}[\s\S]*data-farm-focus-forecast-resource=\{primaryFarmFocusActionResourcePreview \|\| undefined\}[\s\S]*data-farm-focus-forecast-action=\{primaryFarmFocus\.actionLabel\}[\s\S]*aria-label=\{`小目标预期：\$\{primaryFarmFocusForecastItems\.map\(\(item\) => item\.label\)\.join\('，'\)\}`\}/);
  assert.match(panel, /primaryFarmFocusForecastItems\.map\(\(item\) => \([\s\S]*item\.actionable \? \([\s\S]*<button[\s\S]*key=\{item\.id\}[\s\S]*data-farm-focus-forecast-item="true"[\s\S]*data-farm-focus-forecast-tone=\{item\.tone\}[\s\S]*data-farm-focus-forecast-actionable="true"[\s\S]*data-farm-focus-forecast-busy=\{farmMiniQuickActionBusy \? 'true' : undefined\}[\s\S]*disabled=\{farmMiniQuickActionBusy\}[\s\S]*aria-label=\{`执行小目标摘要动作：\$\{item\.label\}`\}[\s\S]*title=\{`\$\{item\.label\} · \$\{primaryFarmFocusProgressPreview\}`\}[\s\S]*handleFarmFocusAction\(primaryFarmFocus\)/);
  assert.match(panel, /item\.actionable \? \([\s\S]*\) : \([\s\S]*<small[\s\S]*key=\{item\.id\}[\s\S]*data-farm-focus-forecast-item="true"[\s\S]*data-farm-focus-forecast-tone=\{item\.tone\}[\s\S]*\{item\.label\}/);
  assert.match(panel, /farmMiniQuickActionFeedback && \([\s\S]*className="t8-farm-story-panel__focus-forecast-receipt"[\s\S]*data-farm-focus-forecast-receipt="true"[\s\S]*data-farm-focus-forecast-receipt-kind=\{farmMiniQuickActionFeedback\.kind\}[\s\S]*data-farm-focus-forecast-receipt-action=\{farmMiniQuickActionFeedback\.actionKind\}[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*已执行：\{farmMiniQuickActionSummaryLabel \|\| farmMiniQuickActionFeedback\.label\}/);
  assert.match(panel, /className="t8-farm-story-panel__focus-forecast-receipt"[\s\S]*<MiniQuickActionIcon size=\{10\} aria-hidden="true" \/>[\s\S]*<span>已执行：\{farmMiniQuickActionSummaryLabel \|\| farmMiniQuickActionFeedback\.label\}<\/span>/);
  assert.match(panel, /farmMiniQuickActionReceiptItems\.map\(\(item\) => \{[\s\S]*return \([\s\S]*<em[\s\S]*key=\{item\.id\}[\s\S]*data-farm-focus-forecast-receipt-chip=\{item\.id\}[\s\S]*title=\{`\$\{item\.title\}：\$\{item\.label\}`\}[\s\S]*aria-hidden="true"[\s\S]*\{item\.title\}：\{item\.label\}[\s\S]*<\/em>[\s\S]*\);[\s\S]*\}\)/);
  assert.match(panel, /farmMiniQuickActionReceiptItems\.map\(\(item\) => \{[\s\S]*const receiptActionFeedbackActive = farmSummaryDetailActionFeedbackItemId === item\.id && Boolean\(farmSummaryDetailActionFeedback\)[\s\S]*if \(item\.action\) \{[\s\S]*const action = item\.action[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-focus-forecast-receipt-chip=\{item\.id\}[\s\S]*data-farm-focus-forecast-receipt-chip-actionable="true"[\s\S]*data-farm-focus-forecast-receipt-chip-action-kind=\{item\.actionKind \|\| undefined\}[\s\S]*data-farm-focus-forecast-receipt-chip-resource-targets=\{item\.actionResourceTargets\?\.join\(' '\) \|\| undefined\}[\s\S]*data-farm-focus-forecast-receipt-chip-resource-preview=\{item\.actionResourcePreview \|\| undefined\}/);
  assert.match(panel, /data-farm-focus-forecast-receipt-chip-active=\{receiptActionFeedbackActive \? 'true' : undefined\}[\s\S]*data-farm-focus-forecast-receipt-chip-result=\{receiptActionFeedbackActive \? farmSummaryDetailActionFeedback : undefined\}[\s\S]*data-farm-focus-forecast-receipt-chip-cooldown=\{receiptActionFeedbackActive \? 'true' : undefined\}[\s\S]*title=\{receiptActionFeedbackActive \? `刚刚继续：\$\{farmSummaryDetailActionFeedback\}` : `继续：\$\{item\.actionLabel \|\| item\.label\}`\}[\s\S]*aria-label=\{receiptActionFeedbackActive \? `刚刚继续：\$\{farmSummaryDetailActionFeedback\}` : `继续小目标：\$\{item\.actionLabel \|\| item\.label\}`\}/);
  assert.match(panel, /disabled=\{receiptActionFeedbackActive\}[\s\S]*aria-disabled=\{receiptActionFeedbackActive \? 'true' : undefined\}[\s\S]*onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*if \(receiptActionFeedbackActive\) return;[\s\S]*handleFarmGoalAction\(action\);[\s\S]*flashFarmSummaryDetailAction\(item\.actionLabel \|\| '继续小目标', item\.id\)[\s\S]*\}\}/);
  assert.match(panel, /className="t8-farm-story-panel__focus-progress"[\s\S]*data-farm-focus-progress-preview=\{primaryFarmFocusProgressPreview \|\| undefined\}[\s\S]*data-farm-focus-next-progress=\{primaryFarmFocus \? primaryFarmFocusNextProgress : undefined\}[\s\S]*data-farm-focus-next-percent=\{primaryFarmFocus \? primaryFarmFocusNextPercent : undefined\}[\s\S]*title=\{`小目标进度 \$\{primaryFarmFocus\.percent\}% · \$\{primaryFarmFocusProgressPreview\}`\}/);
  assert.match(panel, /primaryFarmFocusProgressPreview && \([\s\S]*data-farm-focus-progress-forecast-bar="true"[\s\S]*width: `\$\{primaryFarmFocusNextPercent\}%`/);
  assert.match(panel, /data-farm-focus-progress-current="true"[\s\S]*width: `\$\{primaryFarmFocus\.percent\}%`/);
  assert.match(panel, /data-farm-focus-action-resource-targets=\{primaryFarmFocusActionResourceTargets\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-focus-action-resource-preview=\{primaryFarmFocusActionResourcePreview \|\| undefined\}/);
  assert.match(panel, /data-farm-focus-action-progress-preview=\{primaryFarmFocusProgressPreview \|\| undefined\}/);
  assert.match(panel, /data-farm-focus-action-next-progress=\{primaryFarmFocus \? primaryFarmFocusNextProgress : undefined\}/);
  assert.match(panel, /data-farm-focus-action-target=\{primaryFarmFocus\.target\}/);
  assert.match(panel, /aria-label=\{`执行牧场小目标：\$\{primaryFarmFocus\.title\} · \$\{primaryFarmFocusProgressPreview\}`\}/);
  assert.match(panel, /title=\{`\$\{primaryFarmFocus\.actionLabel\} · \$\{primaryFarmFocusProgressPreview\}`\}/);
  assert.match(panel, /primaryFarmFocusActionResourcePreview && \([\s\S]*data-farm-focus-action-resource="true"[\s\S]*\{primaryFarmFocusActionResourcePreview\}/);
  assert.match(panel, /primaryFarmFocusProgressPreview && \([\s\S]*data-farm-focus-action-progress="true"[\s\S]*\{primaryFarmFocusProgressPreview\}/);
  assert.match(panel, /data-farm-focus-next=\{goal\.kind\}/);
  assert.match(panel, /function farmWeatherIcon/);
  assert.match(panel, /getActiveFarmFestivalTask/);
  assert.match(panel, /formatFarmReward/);
  assert.match(panel, /getFarmBuildingEffects/);
  assert.match(panel, /isFarmDecorUnlocked/);
  assert.match(panel, /Volume2/);
  assert.match(panel, /VolumeX/);
  assert.match(panel, /t8-farm-story-panel__sound/);
  assert.match(panel, /aria-label=\{soundEnabled \? '关闭牧场音效' : '开启牧场音效'\}/);
  assert.match(panel, /const FARM_REWARD_BURST_MS = 1700/);
  assert.match(panel, /const \[farmRewardBursts, setFarmRewardBursts\] = useState<FarmRewardBurst\[\]>\(\[\]\)/);
  assert.match(panel, /const farmRewardSnapshotRef = useRef<FarmRewardSnapshot \| null>\(null\)/);
  assert.match(panel, /const pushFarmRewardBurst = useCallback/);
  assert.match(panel, /goldDelta = snapshot\.gold - previous\.gold/);
  assert.match(panel, /experienceDelta = snapshot\.experience - previous\.experience/);
  assert.match(panel, /newlyDiscovered = snapshot\.discoveredCropIds\.filter/);
  assert.match(panel, /animalProductDelta/);
  assert.match(panel, /动物产出：/);
  assert.match(panel, /pushFarmRewardBurst\(\{ kind: 'gold', label: `金币 \+\$\{goldDelta\}` \}\)/);
  assert.match(panel, /pushFarmRewardBurst\(\{ kind: 'experience', label: `经验 \+\$\{experienceDelta\}` \}\)/);
  assert.match(panel, /图鉴点亮/);
  assert.match(panel, /t8-farm-story-panel__reward-bursts/);
  assert.match(panel, /data-farm-reward-kind=\{burst\.kind\}/);
  assert.match(panel, /type FarmRewardBurstKind = 'gold' \| 'experience' \| 'catalog' \| 'quest' \| 'animal' \| 'npc' \| 'rare' \| 'beauty' \| 'festival'/);
  assert.match(panel, /function farmRewardBurstIcon\(kind: FarmRewardBurstKind\) \{/);
  assert.match(panel, /case 'gold':[\s\S]*return Coins/);
  assert.match(panel, /case 'animal':[\s\S]*return PawPrint/);
  assert.match(panel, /case 'festival':[\s\S]*return Flag/);
  assert.match(panel, /function farmRewardKindLabel\(kind: FarmRewardBurstKind\) \{/);
  assert.match(panel, /case 'catalog':[\s\S]*return '图鉴奖励'/);
  assert.match(panel, /case 'animal':[\s\S]*return '动物产出'/);
  assert.match(panel, /case 'festival':[\s\S]*return '节庆奖励'/);
  assert.match(panel, /const BurstIcon = farmRewardBurstIcon\(burst\.kind\)/);
  assert.match(panel, /const rewardKindLabel = farmRewardKindLabel\(burst\.kind\)/);
  assert.match(panel, /<BurstIcon size=\{10\} aria-hidden="true" \/>/);
  assert.match(panel, /<small data-farm-reward-burst-kind-label="true">\{rewardKindLabel\}<\/small>/);
  assert.match(panel, /data-farm-reward-kind-label=\{rewardKindLabel\}/);
  assert.match(panel, /aria-label=\{`\$\{rewardKindLabel\}：\$\{burst\.label\}`\}/);
  assert.match(panel, /completedFestivalTasks: Array<\{ id: string; rewardLabel: string \}>/);
  assert.match(panel, /completedFestivalTasks: farmCanvas\.festivalTasks[\s\S]*filter\(\(task\) => task\.completed\)[\s\S]*map\(\(task\) => \(\{ id: task\.id, rewardLabel: formatFarmReward\(task\.rewards\) \}\)\)/);
  assert.match(panel, /const newlyCompletedFestivalTasks = snapshot\.completedFestivalTasks\.filter\([\s\S]*!previous\.completedFestivalTasks\.some\(\(task\) => task\.id === completedTask\.id\)/);
  assert.match(panel, /pushFarmRewardBurst\(\{[\s\S]*kind: 'festival'[\s\S]*label: newlyCompletedFestivalTasks\.length === 1[\s\S]*`节庆谢礼：\$\{firstFestivalTask\.rewardLabel\}`/);
  assert.match(panel, /beautyRewardIds: string\[\]/);
  assert.match(panel, /newlyUnlockedBeauty = snapshot\.beautyRewardIds\.filter/);
  assert.match(panel, /pushFarmRewardBurst\(\{[\s\S]*kind: 'beauty'/);
  assert.match(panel, /interface FarmTutorialStep/);
  assert.match(panel, /function buildFarmTutorialSteps\(farmCanvas: FarmCanvasState \| undefined\)/);
  assert.match(panel, /buildFarmLongTermGoals/);
  assert.match(panel, /farmLongTermGoals = buildFarmLongTermGoals\(farmCanvas\)/);
  assert.match(panel, /data-farm-long-goal=\{goal\.id\}/);
  assert.match(panel, /interface FarmLongGoalActionHint/);
  assert.match(panel, /function farmLongGoalActionHint\([\s\S]*goal: FarmLongTermGoal[\s\S]*farmCanvas: FarmCanvasState \| undefined/);
  assert.match(panel, /const farmLongGoalActionHints = new Map\(farmLongTermGoals\.map\(\(goal\) => \[goal\.id, farmLongGoalActionHint\(goal, farmCanvas/);
  assert.match(panel, /const \[farmLongGoalActionReceiptId, setFarmLongGoalActionReceiptId\] = useState\(''\)/);
  assert.match(panel, /const farmLongGoalActionTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /function handleFarmLongGoalAction\(goal: FarmLongTermGoal, actionHint: FarmLongGoalActionHint\)/);
  assert.match(panel, /onFollowupCanvasHint\?\.\(\{[\s\S]*message: `手账路线：\$\{goal\.title\} -> \$\{actionHint\.routeLabel\}`[\s\S]*routeTarget: actionHint\.routeTarget/);
  assert.match(panel, /data-farm-long-goal-action-label=\{actionHint\?\.label\}/);
  assert.match(panel, /data-farm-long-goal-route-target=\{actionHint\?\.routeTarget\}/);
  assert.match(panel, /data-farm-long-goal-route-label=\{actionHint\?\.routeLabel\}/);
  assert.match(panel, /data-farm-long-goal-action-receipt=\{farmLongGoalActionReceiptId === goal\.id \? 'true' : undefined\}/);
  assert.match(panel, /className="t8-farm-story-panel__long-goal-action"[\s\S]*data-farm-long-goal-action-kind=\{actionHint\.action\.kind\}[\s\S]*data-farm-long-goal-action-route-target=\{actionHint\.routeTarget\}/);
  assert.match(panel, /stats\?\.plotsTilled/);
  assert.match(panel, /stats\?\.cropsPlanted/);
  assert.match(panel, /stats\?\.cropsWatered/);
  assert.match(panel, /stats\?\.cropsHarvested/);
  assert.match(panel, /stats\?\.ordersCompleted/);
  assert.match(panel, /const farmTutorialCompletionRef = useRef<Set<string> \| null>\(null\)/);
  assert.match(panel, /任务完成：\$\{step\.label\}/);
  assert.match(panel, /const farmTutorialSteps = buildFarmTutorialSteps\(farmCanvas\)/);
  assert.match(panel, /const farmTutorialActiveStep = farmTutorialSteps\.find/);
  assert.match(panel, /t8-farm-story-panel__tutorial/);
  assert.match(panel, /t8-farm-story-panel__long-goals/);
  assert.match(panel, /role="progressbar"/);
  assert.match(panel, /data-farm-tutorial-step=\{step\.id\}/);
  assert.match(panel, /function formatFarmBuildCost/);
  assert.match(panel, /function formatFarmBuildShortage/);
  assert.match(panel, /function formatFarmBuildingEffectHint\(buildingId: string\)/);
  assert.match(panel, /function formatFarmBuildMeta/);
  assert.match(panel, /function formatFarmDecorCategory/);
  assert.match(panel, /function formatFarmDecorEffectHint\(decor: \{ category: string; description: string \}\)/);
  assert.match(panel, /const farmBuildingOptions = Object\.values\(FARM_BUILDING_DEFINITIONS\)/);
  assert.match(panel, /const farmDecorOptions = Object\.values\(FARM_DECOR_DEFINITIONS\)/);
  assert.match(panel, /const selectedBuildingId = farmCanvas\?\.selectedBuildingId \|\| 'hut'/);
  assert.match(panel, /const selectedDecorId = farmCanvas\?\.selectedDecorId \|\| FARM_DEFAULT_DECOR_ID/);
  assert.match(panel, /const farmBuildingEffects = getFarmBuildingEffects\(farmCanvas\)/);
  assert.match(panel, /farmBuildingEffects\.hasOrderBoard[\s\S]*farmCanvas\?\.orders\.find\(\(order\) => canCompleteOrder\(farmCanvas, order\.id\)\)/);
  assert.match(panel, /const farmBuildingEffectItems = \[/);
  assert.match(panel, /dailyWaterCapacity/);
  assert.match(panel, /storageCapacityBonus/);
  assert.match(panel, /scarecrowRadiusCells/);
  assert.match(panel, /supportLabel: '补水'/);
  assert.match(panel, /supportTone: 'water'/);
  assert.match(panel, /supportLabel: '容量'/);
  assert.match(panel, /supportTone: 'storage'/);
  assert.match(panel, /supportLabel: '订单'/);
  assert.match(panel, /supportTone: 'board'/);
  assert.match(panel, /supportLabel: '守护'/);
  assert.match(panel, /supportTone: 'scarecrow'/);
  assert.match(panel, /supportLabel: '日结'/);
  assert.match(panel, /supportTone: 'home'/);
  assert.match(panel, /statusLabel: '补水中'/);
  assert.match(panel, /statusLabel: '扩容中'/);
  assert.match(panel, /statusLabel: '派单中'/);
  assert.match(panel, /statusLabel: '守护中'/);
  assert.match(panel, /statusLabel: '可日结'/);
  assert.match(panel, /const farmMiniBuildingEffectItems = \(\[/);
  assert.match(panel, /const farmMiniBuildingEffectSummaryLabel = farmMiniBuildingEffectItems\.map\(\(item\) => `\$\{item\.label\}：\$\{item\.yieldLabel\}`\)\.join\(' \/ '\)/);
  assert.match(panel, /const farmMiniBuildingEffectTargetLabel = farmMiniBuildingEffectItems\.map\(\(item\) => `\$\{item\.label\}目标：\$\{item\.nextTargetLabel\}`\)\.join\(' \/ '\)/);
  assert.match(panel, /const farmMiniBuildingEffectPrimaryTarget = farmMiniBuildingEffectItems\[0\]/);
  assert.match(panel, /const farmMiniBuildingEffectPrimaryTargetLabel = farmMiniBuildingEffectPrimaryTarget \? farmMiniBuildingEffectPrimaryTarget\.nextTargetLabel : ''/);
  assert.match(panel, /const farmMiniBuildingEffectPrimaryTargetTone = farmMiniBuildingEffectPrimaryTarget\?\.supportTone \|\| ''/);
  assert.match(panel, /const farmPlacementHudReceiptNextTarget: FarmPlacementHudReceiptNextTarget = farmPlacementHudReceiptKind === 'decor'[\s\S]*\? 'beauty'[\s\S]*: farmPlacementHudReceiptKind === 'building'[\s\S]*\? farmMiniBuildingEffectPrimaryTargetTone === 'water'[\s\S]*\? 'water'[\s\S]*: farmMiniBuildingEffectPrimaryTargetTone === 'board' && readyOrderCount > 0[\s\S]*\? 'ready-order'[\s\S]*: farmMiniBuildingEffectPrimaryTargetTone === 'scarecrow' && scarecrowRiskCount > 0[\s\S]*\? 'scarecrow-risk'[\s\S]*: farmMiniBuildingEffectPrimaryTargetTone === 'home'[\s\S]*\? 'day'[\s\S]*: 'building-yield-summary'[\s\S]*: ''/);
  assert.match(panel, /const farmPlacementHudReceiptNextLabel = farmPlacementHudReceiptKind === 'building'[\s\S]*\? \(farmMiniBuildingEffectPrimaryTargetLabel \? `追\$\{farmMiniBuildingEffectPrimaryTargetLabel\}` : '看收益'\)[\s\S]*: farmPlacementHudReceiptKind === 'decor'[\s\S]*\? \(nextBeautyReward \? `差\$\{nextBeautyReward\.remainingScore\}分` : '满美化'\)[\s\S]*: ''/);
  assert.match(panel, /const farmPlacementHudReceiptNextTitle = farmPlacementHudReceiptKind === 'building'[\s\S]*\? \(farmBuildingEffectSummaryNextLabel \? `收益目标：\$\{farmBuildingEffectSummaryNextLabel\}` : '查看建筑收益'\)[\s\S]*: farmPlacementHudReceiptKind === 'decor'[\s\S]*\? \(nextBeautyReward \? `下一档美化：\$\{nextBeautyReward\.title\}，还差 \$\{nextBeautyReward\.remainingScore\} 分` : '美化奖励已全部解锁'\)[\s\S]*: ''/);
  assert.match(panel, /const farmPlacementHudReceiptNextTargetTitle = farmPlacementHudReceiptNextTarget && farmPlacementHudReceiptNextTitle[\s\S]*\? `接入目标：\$\{farmPlacementHudReceiptNextTitle\}`[\s\S]*: ''/);
  assert.match(panel, /const farmPlacementHudReceiptNextTargetOpened = farmPlacementHudReceiptNextTarget === 'water'[\s\S]*\? farmWaterToolOpened[\s\S]*: farmPlacementHudReceiptNextTarget === 'ready-order'[\s\S]*\? farmOrderLocateOpened[\s\S]*: farmPlacementHudReceiptNextTarget === 'scarecrow-risk'[\s\S]*\? farmScarecrowRiskSelected[\s\S]*: farmPlacementHudReceiptNextTarget === 'day'[\s\S]*\? farmSummaryOpened[\s\S]*: farmPlacementHudReceiptNextTarget === 'beauty'[\s\S]*\? farmBeautyDetailOpened[\s\S]*: farmPlacementHudReceiptNextTarget === 'building-yield-summary'[\s\S]*\? farmBuildingEffectOpened[\s\S]*: false/);
  assert.match(panel, /const farmPlacementHudReceiptNextTargetOpenedTitle = farmPlacementHudReceiptNextTargetOpened && farmPlacementHudReceiptNextTitle[\s\S]*\? `目标已接入：\$\{farmPlacementHudReceiptNextTitle\}`[\s\S]*: ''/);
  assert.match(panel, /const farmPlacementHudReceiptNextTargetCanvasTarget: FarmFocusActionNextTarget \| undefined = farmPlacementHudReceiptNextTarget === 'water'[\s\S]*\? 'water'[\s\S]*: farmPlacementHudReceiptNextTarget === 'ready-order'[\s\S]*\? 'reward'[\s\S]*: farmPlacementHudReceiptNextTarget === 'scarecrow-risk'[\s\S]*\? 'scarecrow'[\s\S]*: farmPlacementHudReceiptNextTarget === 'day'[\s\S]*\? 'day'[\s\S]*: farmPlacementHudReceiptNextTarget === 'beauty'[\s\S]*\? 'decor'[\s\S]*: farmPlacementHudReceiptNextTarget === 'building-yield-summary'[\s\S]*\? 'build'[\s\S]*: undefined/);
  assert.match(panel, /const farmPlacementHudReceiptNextTargetOpenedCanvasTone = farmFocusActionCanvasTone\(farmPlacementHudReceiptNextTargetCanvasTarget\)/);
  assert.match(panel, /const farmPlacementHudReceiptNextTargetOpenedCanvasHint = farmPlacementHudReceiptNextTargetOpenedTitle[\s\S]*\? `接入完成：\$\{farmPlacementHudReceiptNextTitle\}`[\s\S]*: ''/);
  assert.match(panel, /const farmPlacementHudReceiptFollowupLabel = farmPlacementHudReceiptNextTargetOpened[\s\S]*farmPlacementHudReceiptNextTarget === 'water'[\s\S]*'继续补水'[\s\S]*farmPlacementHudReceiptNextTarget === 'ready-order'[\s\S]*'去交订单'[\s\S]*farmPlacementHudReceiptNextTarget === 'scarecrow-risk'[\s\S]*'补守护'[\s\S]*farmPlacementHudReceiptNextTarget === 'day'[\s\S]*'过一天'[\s\S]*farmPlacementHudReceiptNextTarget === 'beauty'[\s\S]*'继续美化'[\s\S]*farmPlacementHudReceiptNextTarget === 'building-yield-summary'[\s\S]*'看收益'[\s\S]*''[\s\S]*: ''/);
  assert.match(panel, /const farmPlacementHudReceiptFollowupTitle = farmPlacementHudReceiptFollowupLabel && farmPlacementHudReceiptNextTitle[\s\S]*\? `接入完成：\$\{farmPlacementHudReceiptFollowupLabel\} · \$\{farmPlacementHudReceiptNextTitle\}`[\s\S]*: ''/);
  assert.match(panel, /const farmPlacementHudReceiptFollowupTarget = farmPlacementHudReceiptFollowupLabel \? farmPlacementHudReceiptNextTarget : ''/);
  assert.match(panel, /const farmPlacementHudReceiptFollowupCountLabel = farmPlacementHudReceiptFollowupTarget === 'water'[\s\S]*dryCount > 0 \? `\$\{dryCount\}块` : ''[\s\S]*farmPlacementHudReceiptFollowupTarget === 'ready-order'[\s\S]*readyOrderCount > 0 \? `\$\{readyOrderCount\}单` : ''[\s\S]*farmPlacementHudReceiptFollowupTarget === 'scarecrow-risk'[\s\S]*scarecrowRiskCount > 0 \? `\$\{scarecrowRiskCount\}处` : ''[\s\S]*farmPlacementHudReceiptFollowupTarget === 'day'[\s\S]*`\第\$\{\(farmCanvas\?\.day \|\| 1\) \+ 1\}天`[\s\S]*farmPlacementHudReceiptFollowupTarget === 'beauty'[\s\S]*nextBeautyReward \? `差\$\{nextBeautyReward\.remainingScore\}分` : `\$\{farmBeautyScore\.score\}分`[\s\S]*farmPlacementHudReceiptFollowupTarget === 'building-yield-summary'[\s\S]*farmMiniBuildingEffectItems\.length > 0 \? `\$\{farmMiniBuildingEffectItems\.length\}项` : ''[\s\S]*''/);
  assert.match(panel, /const farmPlacementHudReceiptFollowupResourceLabel = farmPlacementHudReceiptFollowupTarget === 'water'[\s\S]*waterAmount > 0 \? `水量\$\{waterAmount\}` : '水量不足'[\s\S]*farmPlacementHudReceiptFollowupTarget === 'ready-order'[\s\S]*currentOrderRewardLabel \? `奖励\$\{currentOrderRewardLabel\}` : ''[\s\S]*farmPlacementHudReceiptFollowupTarget === 'scarecrow-risk'[\s\S]*'木材\/石头'[\s\S]*farmPlacementHudReceiptFollowupTarget === 'day'[\s\S]*farmMiniBuildingEffectSummaryLabel \? `日结\$\{farmMiniBuildingEffectSummaryLabel\}` : ''[\s\S]*farmPlacementHudReceiptFollowupTarget === 'beauty'[\s\S]*nextBeautyReward \? `美化\$\{nextBeautyReward\.title\}` : '美化满级'[\s\S]*farmPlacementHudReceiptFollowupTarget === 'building-yield-summary'[\s\S]*farmMiniBuildingEffectPrimaryTarget\?\.nextTargetLabel \? `目标\$\{farmMiniBuildingEffectPrimaryTarget\.nextTargetLabel\}` : farmMiniBuildingEffectSummaryLabel[\s\S]*''/);
  assert.match(panel, /const farmPlacementHudReceiptFollowupRouteLabel = farmPlacementHudReceiptFollowupTarget === 'water'[\s\S]*\? '地图看缺水'[\s\S]*farmPlacementHudReceiptFollowupTarget === 'ready-order'[\s\S]*\? '地图看订单'[\s\S]*farmPlacementHudReceiptFollowupTarget === 'scarecrow-risk'[\s\S]*\? '地图看守护'[\s\S]*farmPlacementHudReceiptFollowupTarget === 'day'[\s\S]*\? '回看日结'[\s\S]*farmPlacementHudReceiptFollowupTarget === 'beauty'[\s\S]*\? '地图看美化'[\s\S]*farmPlacementHudReceiptFollowupTarget === 'building-yield-summary'[\s\S]*\? '地图看建效'[\s\S]*: ''/);
  assert.match(panel, /const farmPlacementHudReceiptFollowupRouteTitle = farmPlacementHudReceiptFollowupRouteLabel[\s\S]*\? `路线指引：\$\{farmPlacementHudReceiptFollowupRouteLabel\}\$\{farmPlacementHudReceiptFollowupCountLabel \? ` · 目标 \$\{farmPlacementHudReceiptFollowupCountLabel\}` : ''\}\$\{farmPlacementHudReceiptFollowupResourceLabel \? ` · 预期 \$\{farmPlacementHudReceiptFollowupResourceLabel\}` : ''\}`[\s\S]*: ''/);
  assert.match(panel, /export type FarmStoryPanelRouteHintTarget = 'water' \| 'withered-crop' \| 'ready-order' \| 'ready-npc' \| 'mature-crop' \| 'rare-event' \| 'scarecrow-risk' \| 'day' \| 'beauty' \| 'building-yield-summary'/);
  assert.match(panel, /routeTarget\?: FarmStoryPanelRouteHintTarget/);
  assert.match(panel, /function farmRouteTargetForFocusAction\(action\?: FarmFocusGoalAction\): FarmStoryPanelRouteHintTarget \| undefined/);
  assert.match(panel, /action\.tool === 'shovel'[\s\S]*return 'withered-crop'/);
  assert.match(panel, /action\.kind === 'jump-mature'[\s\S]*return 'mature-crop'/);
  assert.match(panel, /action\.kind === 'complete-npc'[\s\S]*return 'ready-npc'/);
  assert.match(panel, /case 'withered-crop':[\s\S]*return '枯萎'/);
  assert.match(panel, /handleFarmMiniDryWaterAction[\s\S]*routeTarget: 'water'[\s\S]*routeLabel: '缺水'[\s\S]*routeTitle: `自动定位最近缺水作物/);
  assert.match(panel, /handleFarmMiniWitheredShovelAction[\s\S]*routeTarget: 'withered-crop'[\s\S]*routeLabel: '枯萎'[\s\S]*routeTitle: `自动定位最近枯萎作物/);
  assert.match(panel, /handleFarmMiniScarecrowRiskAction[\s\S]*routeTarget: 'scarecrow-risk'[\s\S]*routeLabel: '守护'[\s\S]*routeTitle: `自动定位最近未守护作物/);
  assert.match(panel, /const summaryActionRouteTarget = farmRouteTargetForFocusAction\(action\.action\)/);
  assert.match(panel, /data-farm-summary-action-route-target=\{summaryActionRouteTarget \|\| undefined\}/);
  assert.match(panel, /onFollowupCanvasHint\?\.\(\{[\s\S]*routeTarget: summaryActionRouteTarget[\s\S]*routeLabel: summaryActionRouteLabel/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptRouteTarget = farmActivityRewardStreakGoal\?\.action \? farmRouteTargetForFocusAction\(farmActivityRewardStreakGoal\.action\) : undefined/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptRouteLabel = farmRouteLabelForTarget\(farmActivityRewardStreakActionReceiptRouteTarget\)/);
  assert.match(panel, /routeLabel\?: string/);
  assert.match(panel, /routeTitle\?: string/);
  assert.match(panel, /const \[farmPlacementFollowupActionReceipt, setFarmPlacementFollowupActionReceipt\] = useState\(''\)/);
  assert.match(panel, /const \[farmPlacementRouteHintReceipt, setFarmPlacementRouteHintReceipt\] = useState\(''\)/);
  assert.match(panel, /const farmPlacementFollowupActionTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmPlacementRouteHintTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmPlacementFollowupActionBusy = Boolean\(farmPlacementFollowupActionReceipt\)/);
  assert.match(panel, /const flashFarmPlacementFollowupAction = \(label: string\) => \{[\s\S]*setFarmPlacementFollowupActionReceipt\(label\)[\s\S]*setFarmPlacementFollowupActionReceipt\(''\)[\s\S]*farmPlacementFollowupActionTimerRef\.current = null/);
  assert.match(panel, /const flashFarmPlacementRouteHint = \(label: string\) => \{[\s\S]*setFarmPlacementRouteHintReceipt\(label\)[\s\S]*setFarmPlacementRouteHintReceipt\(''\)[\s\S]*farmPlacementRouteHintTimerRef\.current = null/);
  assert.match(panel, /const handleFarmPlacementHudReceiptRouteHintAction = \(\) => \{[\s\S]*if \(!farmPlacementHudReceiptFollowupRouteLabel\) return[\s\S]*flashFarmPlacementRouteHint\('已指路'\)[\s\S]*message: `路线：\$\{farmPlacementHudReceiptFollowupRouteLabel\}\$\{farmPlacementHudReceiptFollowupCountLabel \? ` · 目标 \$\{farmPlacementHudReceiptFollowupCountLabel\}` : ''\}\$\{farmPlacementHudReceiptFollowupResourceLabel \? ` · 预期 \$\{farmPlacementHudReceiptFollowupResourceLabel\}` : ''\} · \$\{farmPlacementHudReceiptNextTitle\}`[\s\S]*tone: farmPlacementHudReceiptNextTargetOpenedCanvasTone/);
  assert.match(panel, /routeTarget: farmPlacementHudReceiptFollowupTarget \|\| undefined/);
  assert.match(panel, /routeLabel: farmPlacementHudReceiptFollowupRouteLabel/);
  assert.match(panel, /routeTitle: farmPlacementHudReceiptFollowupRouteTitle/);
  assert.match(panel, /const handleFarmPlacementHudReceiptFollowupAction = \(\) => \{[\s\S]*if \(!farmPlacementHudReceiptFollowupLabel \|\| farmPlacementFollowupActionBusy\) return[\s\S]*const receiptLabel = `已接上：\$\{farmPlacementHudReceiptFollowupLabel\}`[\s\S]*const followupDetail = `\$\{farmPlacementHudReceiptFollowupCountLabel \? ` · 目标 \$\{farmPlacementHudReceiptFollowupCountLabel\}` : ''\}\$\{farmPlacementHudReceiptFollowupResourceLabel \? ` · 预期 \$\{farmPlacementHudReceiptFollowupResourceLabel\}` : ''\}`[\s\S]*flashFarmPlacementFollowupAction\(receiptLabel\)[\s\S]*message: `\$\{receiptLabel\} · \$\{farmPlacementHudReceiptNextTitle\}\$\{followupDetail\}`[\s\S]*tone: farmPlacementHudReceiptNextTargetOpenedCanvasTone/);
  assert.match(panel, /farmPlacementHudReceiptFollowupTarget === 'water'[\s\S]*onSelectTool\?\.\('water'\)[\s\S]*farmPlacementHudReceiptFollowupTarget === 'ready-order'[\s\S]*currentOrder && orderReady[\s\S]*handleFarmCompleteCurrentOrder\(\)[\s\S]*farmPlacementHudReceiptFollowupTarget === 'scarecrow-risk'[\s\S]*onSelectBuilding\?\.\('scarecrow'\)[\s\S]*farmPlacementHudReceiptFollowupTarget === 'day'[\s\S]*onAdvanceDay\?\.\(\)[\s\S]*farmPlacementHudReceiptFollowupTarget === 'beauty'[\s\S]*onSelectDecor\?\.\(selectedDecorId\)[\s\S]*farmPlacementHudReceiptFollowupTarget === 'building-yield-summary'[\s\S]*handleOpenFarmBuildingEffects\(\)/);
  assert.match(panel, /const farmMiniBuildingEffectTitleLabel = `建筑收益：\$\{farmMiniBuildingEffectSummaryLabel \|\| '暂无'\}；目标：\$\{farmMiniBuildingEffectTargetLabel \|\| '暂无'\}`/);
  assert.match(panel, /id: 'well'[\s\S]*label: `井\$\{farmBuildingEffects\.wells\}`[\s\S]*icon: Droplets/);
  assert.match(panel, /id: 'storage'[\s\S]*label: `仓\$\{farmBuildingEffects\.storages\}`[\s\S]*icon: Package/);
  assert.match(panel, /id: 'board'[\s\S]*label: `板\$\{farmBuildingEffects\.boards\}`[\s\S]*icon: Flag/);
  assert.match(panel, /id: 'scarecrow'[\s\S]*label: `守\$\{farmBuildingEffects\.scarecrows\}`[\s\S]*icon: Hammer/);
  assert.match(panel, /t8-farm-story-panel__palette/);
  assert.match(panel, /data-farm-palette-kind="building"/);
  assert.match(panel, /data-farm-palette-kind="decor"/);
  assert.match(panel, /building\.description/);
  assert.match(panel, /decor\.description/);
  assert.match(panel, /const buildSize = `\$\{building\.widthCells\}x\$\{building\.heightCells\}`/);
  assert.match(panel, /const buildCost = formatFarmBuildCost\(building\.cost\)/);
  assert.match(panel, /const buildEffect = formatFarmBuildingEffectHint\(building\.id\)/);
  assert.match(panel, /data-farm-palette-building=\{building\.id\}/);
  assert.match(panel, /data-farm-palette-size=\{buildSize\}/);
  assert.match(panel, /data-farm-palette-shortage=\{shortage \|\| undefined\}/);
  assert.match(panel, /t8-farm-story-panel__palette-card-head/);
  assert.match(panel, /t8-farm-story-panel__palette-tags/);
  assert.match(panel, /data-farm-palette-tag="cost"/);
  assert.match(panel, /data-farm-palette-tag="effect"/);
  assert.match(panel, /className=\{`\$\{selectedBuildingId === building\.id \? 'is-active' : ''\}\$\{shortage \? ' is-short' : ''\}`\.trim\(\)\}/);
  assert.match(panel, /const unlocked = isFarmDecorUnlocked\(farmCanvas, decor\.id\)/);
  assert.match(panel, /const decorCategory = formatFarmDecorCategory\(decor\.category\)/);
  assert.match(panel, /const decorEffect = formatFarmDecorEffectHint\(decor\)/);
  assert.match(panel, /const decorStatus = unlocked \? decor\.description : decor\.unlockHint \|\| '完成订单解锁'/);
  assert.match(panel, /type FarmDecorOption = \(typeof FARM_DECOR_DEFINITIONS\)\[string\]/);
  assert.match(panel, /interface FarmDecorUnlockRouteHint/);
  assert.match(panel, /function farmDecorUnlockRouteHint\(\s*decor: FarmDecorOption,\s*farmCanvas: FarmCanvasState \| undefined,\s*\): FarmDecorUnlockRouteHint/);
  assert.match(panel, /const \[farmDecorUnlockRouteReceipt, setFarmDecorUnlockRouteReceipt\] = useState\(''\)/);
  assert.match(panel, /const farmDecorUnlockRouteTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /function handleFarmDecorUnlockRoute\(decor: FarmDecorOption, routeHint: FarmDecorUnlockRouteHint\)/);
  assert.match(panel, /message: `装饰解锁：\$\{decor\.label\} -> \$\{routeHint\.routeLabel\}`/);
  assert.match(panel, /routeTarget: routeHint\.routeTarget/);
  assert.match(panel, /const decorUnlockRoute = unlocked \? undefined : farmDecorUnlockRouteHint\(decor, farmCanvas\)/);
  assert.match(panel, /const decorUnlockRouteReceiptActive = farmDecorUnlockRouteReceipt === decor\.id/);
  assert.match(panel, /data-farm-palette-decor=\{decor\.id\}/);
  assert.match(panel, /data-farm-palette-decor-category=\{decor\.category\}/);
  assert.match(panel, /data-farm-palette-unlocked=\{unlocked \? 'true' : 'false'\}/);
  assert.match(panel, /data-farm-palette-unlock-route-target=\{decorUnlockRoute\?\.routeTarget\}/);
  assert.match(panel, /className="t8-farm-story-panel__palette-unlock-route"[\s\S]*data-farm-palette-unlock-route-decor=\{decor\.id\}[\s\S]*data-farm-palette-unlock-route-target=\{decorUnlockRoute\.routeTarget\}/);
  assert.match(panel, /data-farm-palette-tag="shape"/);
  assert.match(panel, /aria-disabled=\{!unlocked\}/);
  assert.match(panel, /if \(!unlocked\) return/);
  assert.match(panel, /onSelectBuilding\?\.\(building\.id\)/);
  assert.match(panel, /onSelectDecor\?\.\(decor\.id\)/);
  assert.match(panel, /t8-farm-story-panel__building-effects/);
  assert.match(panel, /const farmBuildingEffectSummaryLabel = farmBuildingEffectItems\.length > 0 \? `已生效 \$\{farmBuildingEffectItems\.length\} 项` : ''/);
  assert.match(panel, /const farmBuildingEffectSummaryDetailLabel = farmBuildingEffectItems\.map\(\(item\) => item\.supportLabel\)\.join\(' \/ '\)/);
  assert.match(panel, /const farmBuildingEffectSummaryDetailItems = farmBuildingEffectItems\.map\(\(item\) => \(\{ id: item\.id, label: item\.supportLabel, tone: item\.supportTone, yieldLabel: item\.yieldLabel, nextTargetLabel: item\.nextTargetLabel \}\)\)/);
  assert.match(panel, /const farmBuildingEffectSummaryYieldLabel = farmBuildingEffectSummaryDetailItems\.map\(\(item\) => `\$\{item\.label\}：\$\{item\.yieldLabel\}`\)\.join\(' \/ '\)/);
  assert.match(panel, /const farmBuildingEffectSummaryNextLabel = farmBuildingEffectSummaryDetailItems\.map\(\(item\) => `\$\{item\.label\}目标：\$\{item\.nextTargetLabel\}`\)\.join\(' \/ '\)/);
  assert.match(panel, /const farmBuildingEffectQuestItems = farmBuildingEffectItems\.map\(\(item\) => \{[\s\S]*const routeTarget: FarmStoryPanelRouteHintTarget = item\.supportTone === 'water'[\s\S]*\? 'water'[\s\S]*item\.supportTone === 'board' && readyOrderCount > 0[\s\S]*\? 'ready-order'[\s\S]*item\.supportTone === 'scarecrow' && scarecrowRiskCount > 0[\s\S]*\? 'scarecrow-risk'[\s\S]*item\.supportTone === 'home'[\s\S]*\? 'day'[\s\S]*: 'building-yield-summary'/);
  assert.match(panel, /const farmBuildingEffectQuestPrimary = farmBuildingEffectQuestItems\.find\(\(item\) => item\.routeTarget !== 'building-yield-summary'\) \|\| farmBuildingEffectQuestItems\[0\]/);
  assert.match(panel, /const farmBuildingEffectQuestPrimaryTitle = farmBuildingEffectQuestPrimary[\s\S]*\? `建筑任务链：\$\{farmBuildingEffectQuestPrimary\.label\} · \$\{farmBuildingEffectQuestPrimary\.actionLabel\} · 地图找\$\{farmBuildingEffectQuestPrimary\.routeLabel\}/);
  assert.match(panel, /type FarmPlacementHudReceiptNextTarget = FarmStoryPanelRouteHintTarget \| ''/);
  assert.match(panel, /function farmPlacementHudReceiptKindFromFeedback\(feedback\?: string\): FarmPlacementHudReceiptKind/);
  assert.match(panel, /if \(feedback\.includes\('落成：'\)\) return 'building'/);
  assert.match(panel, /if \(feedback\.includes\('布置：'\)\) return 'decor'/);
  assert.match(panel, /function farmPlacementHudReceiptSourceFromFeedback\(feedback\?: string\)/);
  assert.match(panel, /feedback\.match\(\/\(\?:落成\|布置\)：\(\[\^·\\n\]\+\)\/\)/);
  assert.match(panel, /const farmPlacementHudReceiptKind = farmPlacementHudReceiptKindFromFeedback\(feedback\)/);
  assert.match(panel, /const farmPlacementHudReceiptSource = farmPlacementHudReceiptSourceFromFeedback\(feedback\)/);
  assert.match(panel, /const farmPlacementHudReceiptLabel = farmPlacementHudReceiptKind === 'building' \? '收益接入' : farmPlacementHudReceiptKind === 'decor' \? '美化接入' : ''/);
  assert.match(panel, /const farmPlacementHudReceiptTitle = farmPlacementHudReceiptLabel && farmPlacementHudReceiptSource[\s\S]*\? `刚刚\$\{farmPlacementHudReceiptSource\} · \$\{farmPlacementHudReceiptLabel\}`/);
  assert.match(panel, /const farmPlacementHudReceiptActionLabel = farmPlacementHudReceiptKind === 'building' \? '查看收益' : farmPlacementHudReceiptKind === 'decor' \? '看美化' : ''/);
  assert.match(panel, /const farmPlacementHudReceiptCanvasTone = farmFocusActionCanvasTone\([\s\S]*farmPlacementHudReceiptKind === 'building' \? 'build' : farmPlacementHudReceiptKind === 'decor' \? 'decor' : undefined[\s\S]*\)/);
  assert.match(panel, /const farmPlacementHudReceiptCanvasHint = farmPlacementHudReceiptTitle && farmPlacementHudReceiptActionLabel[\s\S]*\? `\$\{farmPlacementHudReceiptTitle\} · \$\{farmPlacementHudReceiptActionLabel\}`[\s\S]*: farmPlacementHudReceiptTitle/);
  assert.match(panel, /const \[farmBuildingEffectPulseId, setFarmBuildingEffectPulseId\] = useState\(''\)/);
  assert.match(panel, /const \[farmBuildingEffectQuestRouteReceipt, setFarmBuildingEffectQuestRouteReceipt\] = useState\(''\)/);
  assert.match(panel, /const \[farmAnimalProductPulseId, setFarmAnimalProductPulseId\] = useState\(''\)/);
  assert.match(panel, /const farmBuildingEffectsRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(panel, /const farmBuildingEffectQuestRouteTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmAnimalsRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(panel, /const farmBuildingEffectOpened = Boolean\(farmBuildingEffectPulseId\)/);
  assert.match(panel, /const farmAnimalProductOpened = Boolean\(farmAnimalProductPulseId\)/);
  assert.match(panel, /const handleOpenFarmBuildingEffects = \(\) => \{[\s\S]*setOpen\(true\)[\s\S]*setFarmBuildingEffectPulseId\(`building-effect-\$\{Date\.now\(\)\}`\)[\s\S]*farmBuildingEffectsElement\?\.scrollIntoView\(\{ block: 'nearest', behavior: buildingEffectScrollBehavior \}\)[\s\S]*farmBuildingEffectsElement\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /const flashFarmBuildingEffectQuestRouteHint = \(label: string\) => \{[\s\S]*setFarmBuildingEffectQuestRouteReceipt\(label\)[\s\S]*setFarmBuildingEffectQuestRouteReceipt\(''\)/);
  assert.match(panel, /const handleFarmBuildingEffectQuestRouteHintAction = \(item: typeof farmBuildingEffectQuestItems\[number\] \| undefined = farmBuildingEffectQuestPrimary\) => \{[\s\S]*if \(!item\?\.routeTarget \|\| !item\.routeLabel\) return[\s\S]*flashFarmBuildingEffectQuestRouteHint\('已指路'\)[\s\S]*message: `建筑任务链：\$\{item\.routeLabel\}/);
  assert.match(panel, /const farmBuildingEffectQuestRouteTitle = item\.title[\s\S]*routeTarget: item\.routeTarget[\s\S]*routeLabel: item\.routeLabel[\s\S]*routeTitle: farmBuildingEffectQuestRouteTitle/);
  assert.match(farmPanelPlacementHudActions, /const handleFarmPlacementHudReceiptAction = \(\) => \{[\s\S]*if \(farmPlacementHudReceiptCanvasHint\) \{[\s\S]*onFollowupCanvasHint\?\.\(\{[\s\S]*message: `已定位：\$\{farmPlacementHudReceiptCanvasHint\}`,[\s\S]*tone: farmPlacementHudReceiptCanvasTone,[\s\S]*\}\);[\s\S]*\}[\s\S]*if \(farmPlacementHudReceiptKind === 'building'\) \{[\s\S]*handleOpenFarmBuildingEffects\(\);[\s\S]*return;[\s\S]*\}[\s\S]*if \(farmPlacementHudReceiptKind === 'decor'\) \{[\s\S]*handleOpenFarmBeautyDetail\(\);[\s\S]*\}[\s\S]*\}/);
  assert.match(panel, /const handleOpenFarmAnimals = \(\) => \{[\s\S]*setOpen\(true\)[\s\S]*setFarmAnimalProductPulseId\(`animal-product-\$\{Date\.now\(\)\}`\)[\s\S]*farmAnimalsElement\?\.scrollIntoView\(\{ block: 'nearest', behavior: animalProductScrollBehavior \}\)[\s\S]*farmAnimalsElement\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /aria-label=\{`建筑效果，\$\{farmBuildingEffectSummaryLabel\}，\$\{farmBuildingEffectSummaryYieldLabel\}`\}/);
  assert.match(panel, /ref=\{farmBuildingEffectsRef\}/);
  assert.match(panel, /data-farm-building-effect-scroll-target="true"/);
  assert.match(panel, /data-farm-building-effect-focus=\{farmBuildingEffectPulseId \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-building-effect-pulse=\{farmBuildingEffectPulseId \|\| undefined\}/);
  assert.match(panel, /tabIndex=\{-1\}/);
  assert.match(panel, /data-farm-building-effect-count=\{farmBuildingEffectItems\.length\}/);
  assert.match(panel, /data-farm-building-effect-summary=\{farmBuildingEffectSummaryLabel\}/);
  assert.match(panel, /data-farm-building-effect-summary-detail=\{farmBuildingEffectSummaryDetailLabel\}/);
  assert.match(panel, /data-farm-building-effect-summary-yields=\{farmBuildingEffectSummaryYieldLabel\}/);
  assert.match(panel, /data-farm-building-effect-summary-next=\{farmBuildingEffectSummaryNextLabel\}/);
  assert.match(panel, /data-farm-building-effect-summary-detail-tones=\{farmBuildingEffectSummaryDetailItems\.map\(\(item\) => item\.tone\)\.join\(' '\)\}/);
  assert.match(panel, /data-farm-building-effect-quest-route-target=\{farmBuildingEffectQuestPrimary\?\.routeTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-building-effect-quest-route-label=\{farmBuildingEffectQuestPrimary\?\.routeLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-building-effect-quest-route-receipt=\{farmBuildingEffectQuestRouteReceipt \|\| undefined\}/);
  assert.match(panel, /<em data-farm-building-effect-summary="true">\{farmBuildingEffectSummaryLabel\}<\/em>/);
  assert.match(panel, /<small[\s\S]*data-farm-building-effect-summary-detail="true"[\s\S]*aria-label=\{`建筑支持收益：\$\{farmBuildingEffectSummaryYieldLabel\}`\}[\s\S]*title=\{farmBuildingEffectSummaryYieldLabel\}/);
  assert.match(panel, /farmBuildingEffectSummaryDetailItems\.map\(\(item\) => \([\s\S]*<b[\s\S]*key=\{item\.id\}[\s\S]*data-farm-building-effect-summary-token=\{item\.tone\}[\s\S]*data-farm-building-effect-summary-token-yield=\{item\.yieldLabel\}[\s\S]*title=\{`\$\{item\.label\}：\$\{item\.yieldLabel\}`\}[\s\S]*aria-label=\{`\$\{item\.label\}：\$\{item\.yieldLabel\}`\}[\s\S]*<span>\{item\.label\}<\/span>[\s\S]*<em data-farm-building-effect-summary-token-yield-text="true">\{item\.yieldLabel\}<\/em>[\s\S]*<\/b>[\s\S]*\)\)/);
  assert.match(panel, /farmBuildingEffectQuestPrimary && \([\s\S]*className="t8-farm-story-panel__building-effect-chain"[\s\S]*data-farm-building-effect-chain="true"[\s\S]*data-farm-building-effect-chain-route-target=\{farmBuildingEffectQuestPrimary\.routeTarget\}[\s\S]*data-farm-building-effect-chain-route-label=\{farmBuildingEffectQuestPrimary\.routeLabel\}[\s\S]*data-farm-building-effect-chain-action=\{farmBuildingEffectQuestPrimary\.actionLabel\}[\s\S]*建筑任务链/);
  assert.match(panel, /data-farm-building-effect-chain-route-hint="true"[\s\S]*onClick=\{\(event\) => \{[\s\S]*handleFarmBuildingEffectQuestRouteHintAction\(farmBuildingEffectQuestPrimary\)[\s\S]*`地图找\$\{farmBuildingEffectQuestPrimary\.routeLabel\}`/);
  assert.match(panel, /farmBuildingEffectOpened && \([\s\S]*className="t8-farm-story-panel__building-effect-receipt"[\s\S]*data-farm-building-effect-receipt="true"[\s\S]*data-farm-building-effect-receipt-summary=\{farmBuildingEffectSummaryYieldLabel\}[\s\S]*data-farm-building-effect-receipt-next=\{farmBuildingEffectSummaryNextLabel\}[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*title=\{`建筑收益已生效：\$\{farmBuildingEffectSummaryYieldLabel\}，目标：\$\{farmBuildingEffectSummaryNextLabel\}`\}[\s\S]*aria-label=\{`建筑收益已生效：\$\{farmBuildingEffectSummaryYieldLabel\}，目标：\$\{farmBuildingEffectSummaryNextLabel\}`\}[\s\S]*<Sparkles size=\{10\} \/>[\s\S]*收益已生效[\s\S]*<b>\{farmBuildingEffectSummaryLabel\}<\/b>/);
  assert.match(panel, /farmBuildingEffectSummaryDetailItems\.map\(\(item\) => \([\s\S]*<em[\s\S]*key=\{item\.id\}[\s\S]*data-farm-building-effect-receipt-token=\{item\.tone\}[\s\S]*data-farm-building-effect-receipt-token-yield=\{item\.yieldLabel\}[\s\S]*data-farm-building-effect-receipt-token-next=\{item\.nextTargetLabel\}[\s\S]*title=\{`\$\{item\.label\}：\$\{item\.yieldLabel\}，目标：\$\{item\.nextTargetLabel\}`\}[\s\S]*aria-label=\{`\$\{item\.label\}：\$\{item\.yieldLabel\}，目标：\$\{item\.nextTargetLabel\}`\}[\s\S]*<span>\{item\.label\}<\/span>[\s\S]*<b>\{item\.yieldLabel\}<\/b>[\s\S]*<i[\s\S]*data-farm-building-effect-receipt-token-next="true"[\s\S]*data-farm-building-effect-receipt-token-next-tone=\{item\.tone\}[\s\S]*>\{item\.nextTargetLabel\}<\/i>[\s\S]*<\/em>[\s\S]*\)\)/);
  assert.match(panel, /data-farm-building-effect=\{item\.id\}/);
  assert.match(panel, /const farmBuildingEffectQuestItem = farmBuildingEffectQuestItems\.find\(\(quest\) => quest\.id === item\.id\)/);
  assert.match(panel, /data-farm-building-effect-support=\{item\.supportTone\}/);
  assert.match(panel, /data-farm-building-effect-support-label=\{item\.supportLabel\}/);
  assert.match(panel, /data-farm-building-effect-status-label=\{item\.statusLabel\}/);
  assert.match(panel, /data-farm-building-effect-action-hint=\{item\.actionHint\}/);
  assert.match(panel, /data-farm-building-effect-yield-label=\{item\.yieldLabel\}/);
  assert.match(panel, /data-farm-building-effect-yield-tone=\{item\.yieldTone\}/);
  assert.match(panel, /data-farm-building-effect-yield-stamp-label=\{item\.yieldStampLabel\}/);
  assert.match(panel, /data-farm-building-effect-chain-route-target=\{farmBuildingEffectQuestItem\?\.routeTarget \|\| undefined\}/);
  assert.match(panel, /farmBuildingEffectQuestItem && \([\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-building-effect-row-route-hint="true"[\s\S]*data-farm-building-effect-row-route-target=\{farmBuildingEffectQuestItem\.routeTarget\}[\s\S]*handleFarmBuildingEffectQuestRouteHintAction\(farmBuildingEffectQuestItem\)[\s\S]*图\{farmBuildingEffectQuestItem\.routeLabel\}/);
  assert.match(panel, /data-farm-building-effect-receipt-active=\{farmBuildingEffectOpened \? 'true' : undefined\}/);
  assert.match(panel, /statusLabel: '补水中', actionHint: '明天补水', yieldLabel: `水量 \$\{farmBuildingEffects\.dailyWaterCapacity\}`, yieldTone: 'water', yieldStampLabel: '已生效'/);
  assert.match(panel, /statusLabel: '扩容中', actionHint: '可多囤货', yieldLabel: `容量 \+\$\{farmBuildingEffects\.storageCapacityBonus\}`, yieldTone: 'storage', yieldStampLabel: '已生效'/);
  assert.match(panel, /statusLabel: '派单中', actionHint: '看订单', yieldLabel: '订单优先', yieldTone: 'board', yieldStampLabel: '已生效'/);
  assert.match(panel, /statusLabel: '守护中', actionHint: '看范围', yieldLabel: `半径 \$\{farmBuildingEffects\.scarecrowRadiusCells\}`, yieldTone: 'scarecrow', yieldStampLabel: '已生效'/);
  assert.match(panel, /statusLabel: '可日结', actionHint: '过天结算', yieldLabel: '可过天', yieldTone: 'home', yieldStampLabel: '已生效'/);
  assert.match(panel, /const farmBuildingEffectAccessibleLabel = `建筑效果：\$\{item\.label\} · \$\{item\.supportLabel\} · \$\{item\.value\} · \$\{item\.statusLabel\} · \$\{item\.actionHint\} · \$\{item\.yieldLabel\} · \$\{item\.yieldStampLabel\}`/);
  assert.match(panel, /const farmBuildingEffectWaterRefillLabel = farmBuildingEffects\.dailyWaterCapacity > waterAmount[\s\S]*\? `补\$\{farmBuildingEffects\.dailyWaterCapacity - waterAmount\}水`[\s\S]*: '已满'/);
  assert.match(panel, /const farmBuildingEffectReadyOrderLabel = readyOrderCount > 0 \? `\$\{readyOrderCount\}单` : '候单'/);
  assert.match(panel, /const farmBuildingEffectScarecrowTargetLabel = scarecrowRiskCount > 0 \? `\$\{scarecrowRiskCount\}处` : '已守'/);
  assert.match(panel, /nextTargetLabel: farmBuildingEffectWaterRefillLabel/);
  assert.match(panel, /nextTargetLabel: `\+\$\{farmBuildingEffects\.storageCapacityBonus\}容`/);
  assert.match(panel, /nextTargetLabel: farmBuildingEffectReadyOrderLabel/);
  assert.match(panel, /nextTargetLabel: farmBuildingEffectScarecrowTargetLabel/);
  assert.match(panel, /nextTargetLabel: `D\$\{farmCanvas\?\.day \|\| 1\}`/);
  assert.match(panel, /filter\(\(item\): item is \{[\s\S]*nextTargetLabel: string[\s\S]*\} => Boolean\(item\)\)/);
  assert.match(panel, /title=\{farmBuildingEffectAccessibleLabel\}/);
  assert.match(panel, /aria-label=\{farmBuildingEffectAccessibleLabel\}/);
  assert.match(panel, /<em data-farm-building-effect-support=\{item\.supportTone\}>\{item\.supportLabel\}<\/em>/);
  assert.match(panel, /<strong data-farm-building-effect-status="true">\{item\.statusLabel\}<\/strong>/);
  assert.match(panel, /<i data-farm-building-effect-hint="true">\{item\.actionHint\}<\/i>/);
  assert.match(panel, /<small data-farm-building-effect-yield="true">\{item\.yieldLabel\}<\/small>/);
  assert.match(panel, /<mark data-farm-building-effect-yield-stamp="true">\{item\.yieldStampLabel\}<\/mark>/);
  assert.match(panel, /farmBuildingEffectOpened && \([\s\S]*<mark[\s\S]*data-farm-building-effect-row-receipt="true"[\s\S]*data-farm-building-effect-row-receipt-tone=\{item\.supportTone\}[\s\S]*title=\{`\$\{item\.label\}收益已入账：\$\{item\.yieldLabel\}，下一步：\$\{item\.actionHint\}，目标：\$\{item\.nextTargetLabel\}`\}[\s\S]*aria-label=\{`\$\{item\.label\}收益已入账：\$\{item\.yieldLabel\}，下一步：\$\{item\.actionHint\}，目标：\$\{item\.nextTargetLabel\}`\}[\s\S]*已入账[\s\S]*<\/mark>[\s\S]*\)/);
  assert.match(panel, /farmBuildingEffectOpened && \([\s\S]*data-farm-building-effect-row-receipt="true"[\s\S]*<span>已入账<\/span>[\s\S]*<b data-farm-building-effect-row-receipt-yield="true">\{item\.yieldLabel\}<\/b>[\s\S]*<i data-farm-building-effect-row-receipt-hint="true">\{item\.actionHint\}<\/i>[\s\S]*<em[\s\S]*data-farm-building-effect-row-receipt-next="true"[\s\S]*data-farm-building-effect-row-receipt-next-tone=\{item\.supportTone\}[\s\S]*>\{item\.nextTargetLabel\}<\/em>[\s\S]*<\/mark>[\s\S]*\)/);
  assert.match(panel, /const visibleFarmAnimals = \(farmCanvas\?\.animals \|\| \[\]\)\.slice\(0, 4\)/);
  assert.match(panel, /visibleFarmAnimals\.length > 0 && \([\s\S]*ref=\{farmAnimalsRef\}[\s\S]*className="t8-farm-story-panel__animals"[\s\S]*data-farm-animal-product-scroll-target="true"[\s\S]*data-farm-animal-product-focus=\{farmAnimalProductPulseId \? 'true' : undefined\}[\s\S]*data-farm-animal-product-pulse=\{farmAnimalProductPulseId \|\| undefined\}[\s\S]*data-farm-animal-mood-summary=\{farmAnimalMoodSummaryLabel \|\| undefined\}[\s\S]*data-farm-animal-mood-tone=\{farmAnimalMoodTone \|\| undefined\}[\s\S]*data-farm-animal-product-ready=\{totalAnimalProducts > 0 \? 'true' : undefined\}[\s\S]*data-farm-animal-next-products=\{farmAnimalNextProductSummary \|\| undefined\}[\s\S]*data-farm-animal-next-products-count=\{farmAnimalNextProductCount \|\| undefined\}[\s\S]*data-farm-animal-next-products-actionable=\{farmAnimalNextProductCount > 0 \? 'true' : undefined\}[\s\S]*tabIndex=\{-1\}[\s\S]*aria-label=\{`动物小屋，心情：\$\{farmAnimalMoodSummaryLabel \|\| '暂无'\}，产物：\$\{animalProductSummary\}，明早：\$\{farmAnimalNextProductSummary \|\| '暂无'\}`\}/);
  assert.match(panel, /const animalCount = farmCanvas\?\.animals\.length \|\| 0/);
  assert.match(panel, /const farmAnimalProductionDay = farmCanvas\?\.day \|\| 1/);
  assert.match(panel, /const farmAnimalNextProductTotals = \(farmCanvas\?\.animals \|\| \[\]\)\.reduce\(\(totals, animal\) => \{[\s\S]*const definition = FARM_ANIMAL_DEFINITIONS\[animal\.kind\];[\s\S]*if \(!definition \|\| animal\.placedDay > farmAnimalProductionDay \|\| animal\.lastProducedDay === farmAnimalProductionDay\) return totals;[\s\S]*totals\[definition\.productId\] = \(totals\[definition\.productId\] \|\| 0\) \+ definition\.dailyAmount;[\s\S]*return totals;[\s\S]*\}, \{\} as Partial<Record<FarmAnimalProductId, number>>\)/);
  assert.match(panel, /const farmAnimalNextProductSummary = formatAnimalProductTotals\(farmAnimalNextProductTotals\)/);
  assert.match(panel, /const farmAnimalNextProductCount = sumValues\(farmAnimalNextProductTotals\)/);
  assert.match(panel, /const farmAnimalProductReceiptCount = dailySummary\?\.animalProductsProduced \|\| 0/);
  assert.match(panel, /const farmAnimalProductReceiptSummary = farmAnimalProductReceiptCount > 0[\s\S]*\? dailySummary\?\.animalProductSummary \|\| `动物产出 x\$\{farmAnimalProductReceiptCount\}`[\s\S]*: ''/);
  assert.match(panel, /const farmAnimalMoodCounts = \(farmCanvas\?\.animals \|\| \[\]\)\.reduce\(\(counts, animal\) => \{[\s\S]*counts\[animal\.mood\] \+= 1;[\s\S]*return counts;[\s\S]*\}, \{ happy: 0, calm: 0, hungry: 0 \} as Record<FarmAnimalMood, number>\)/);
  assert.match(panel, /const farmAnimalMoodSummaryLabel = \[[\s\S]*farmAnimalMoodCounts\.hungry > 0 \? `饿\$\{farmAnimalMoodCounts\.hungry\}` : ''[\s\S]*farmAnimalMoodCounts\.happy > 0 \? `开心\$\{farmAnimalMoodCounts\.happy\}` : ''[\s\S]*farmAnimalMoodCounts\.calm > 0 \? `安静\$\{farmAnimalMoodCounts\.calm\}` : ''[\s\S]*\]\.filter\(Boolean\)\.join\(' \/ '\)/);
  assert.match(panel, /const farmAnimalMoodPreviewLabel =[\s\S]*farmAnimalMoodCounts\.hungry > 0[\s\S]*\? `饿\$\{farmAnimalMoodCounts\.hungry\}`[\s\S]*: farmAnimalMoodCounts\.happy > 0[\s\S]*\? `开心\$\{farmAnimalMoodCounts\.happy\}`[\s\S]*: farmAnimalMoodCounts\.calm > 0[\s\S]*\? `安静\$\{farmAnimalMoodCounts\.calm\}`[\s\S]*: ''/);
  assert.match(panel, /const farmAnimalMoodTone =[\s\S]*farmAnimalMoodCounts\.hungry > 0[\s\S]*\? 'hungry'[\s\S]*: farmAnimalMoodCounts\.happy > 0[\s\S]*\? 'happy'[\s\S]*: farmAnimalMoodCounts\.calm > 0[\s\S]*\? 'calm'[\s\S]*: ''/);
  assert.match(panel, /const farmAnimalMoodHintLabel =[\s\S]*farmAnimalMoodCounts\.hungry > 0[\s\S]*\? `留意 \$\{farmAnimalMoodCounts\.hungry\} 只饿了的动物`[\s\S]*: farmAnimalMoodCounts\.happy > 0[\s\S]*\? `开心 \$\{farmAnimalMoodCounts\.happy\} 只，产物更有盼头`[\s\S]*: animalCount > 0[\s\S]*\? '小屋安静运转'[\s\S]*: ''/);
  assert.match(panel, /const totalSeedCount = sumValues\(farmCanvas\?\.resources\.seeds\)/);
  assert.match(panel, /const farmMiniAnimalProductPreviewLabel = totalAnimalProducts > 0 \? compactFarmHudFeedback\(animalProductSummary, 12\) : ''/);
  assert.match(panel, /const farmMiniAnimalProductReceiptPreviewLabel = farmAnimalProductReceiptCount > 0 \? compactFarmHudFeedback\(farmAnimalProductReceiptSummary, 12\) : ''/);
  assert.match(panel, /const farmMiniAnimalNextProductPreviewLabel = farmAnimalNextProductCount > 0 \? compactFarmHudFeedback\(farmAnimalNextProductSummary, 12\) : ''/);
  assert.match(panel, /const waterAmount = farmCanvas\?\.resources\.water \|\| 0/);
  assert.match(panel, /const woodAmount = farmCanvas\?\.resources\.wood \|\| 0/);
  assert.match(panel, /const stoneAmount = farmCanvas\?\.resources\.stone \|\| 0/);
  assert.match(panel, /t8-farm-story-panel__animals/);
  assert.match(panel, /className="t8-farm-story-panel__animals-head"[\s\S]*data-farm-animal-mood-tone=\{farmAnimalMoodTone \|\| undefined\}[\s\S]*data-farm-animal-product-ready=\{totalAnimalProducts > 0 \? 'true' : undefined\}[\s\S]*data-farm-animal-next-products=\{farmAnimalNextProductSummary \|\| undefined\}[\s\S]*data-farm-animal-next-products-actionable=\{farmAnimalNextProductCount > 0 \? 'true' : undefined\}[\s\S]*farmAnimalMoodHintLabel && \([\s\S]*<em data-farm-animal-mood-hint="true">\{farmAnimalMoodHintLabel\}<\/em>[\s\S]*farmAnimalNextProductSummary && \([\s\S]*<i data-farm-animal-next-products="true">明早 \{farmAnimalNextProductSummary\}<\/i>[\s\S]*farmAnimalNextProductCount > 0 && \([\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-animal-next-products-action="true"[\s\S]*data-farm-animal-next-products-action-count=\{farmAnimalNextProductCount\}[\s\S]*data-farm-animal-next-products-action-summary=\{farmAnimalNextProductSummary\}[\s\S]*title=\{`推进到下一天，收取预计产出 \$\{farmAnimalNextProductSummary\}`\}[\s\S]*aria-label=\{`推进到下一天并收取动物预计产出，\$\{farmAnimalNextProductSummary\}`\}[\s\S]*event\.stopPropagation\(\);[\s\S]*onAdvanceDay\?\.\(\);[\s\S]*<CalendarDays size=\{10\} \/>[\s\S]*<span>过天收取<\/span>[\s\S]*<em>明\{farmAnimalNextProductCount\}<\/em>[\s\S]*<\/button>[\s\S]*\)/);
  assert.match(panel, /data-farm-animal-product-receipt=\{farmAnimalProductReceiptSummary \|\| undefined\}/);
  assert.match(panel, /data-farm-animal-product-receipt-count=\{farmAnimalProductReceiptCount \|\| undefined\}/);
  assert.match(panel, /farmAnimalProductReceiptSummary && \([\s\S]*<small[\s\S]*data-farm-animal-product-receipt="true"[\s\S]*data-farm-animal-product-receipt-count=\{farmAnimalProductReceiptCount\}[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*title=\{`刚收取动物产出：\$\{farmAnimalProductReceiptSummary\}`\}[\s\S]*aria-label=\{`刚收取动物产出，\$\{farmAnimalProductReceiptSummary\}`\}[\s\S]*<Sparkles size=\{10\} \/>[\s\S]*<span>刚收取<\/span>[\s\S]*<b>\{farmAnimalProductReceiptSummary\}<\/b>[\s\S]*<\/small>[\s\S]*\)/);
  assert.match(panel, /data-farm-animal-product-located=\{farmAnimalProductOpened \? 'true' : undefined\}/);
  assert.match(panel, /farmAnimalProductOpened && \([\s\S]*<em data-farm-animal-product-located-badge="true">已定位<\/em>[\s\S]*\)/);
  assert.match(panel, /const animalNextProductReady = animal\.placedDay <= farmAnimalProductionDay && animal\.lastProducedDay !== farmAnimalProductionDay/);
  assert.match(panel, /const animalProducedToday = animal\.lastProducedDay === farmAnimalProductionDay && animal\.productCount > 0/);
  assert.match(panel, /<li[\s\S]*key=\{animal\.id\}[\s\S]*data-farm-animal-kind=\{animal\.kind\}[\s\S]*data-farm-animal-mood=\{animal\.mood\}[\s\S]*data-farm-animal-product-ready=\{animal\.productCount > 0 \? 'true' : undefined\}[\s\S]*data-farm-animal-next-product-ready=\{animalNextProductReady \? 'true' : undefined\}[\s\S]*data-farm-animal-produced-today=\{animalProducedToday \? 'true' : undefined\}[\s\S]*title=\{`\$\{definition\.label\} \$\{animal\.name\}：\$\{farmAnimalMoodLabel\(animal\.mood\)\}，\$\{definition\.productLabel\} x\$\{animal\.productCount\}，今日\$\{animalProducedToday \? ` \+\$\{definition\.dailyAmount\}` : ' 未新增'\}，明早\$\{animalNextProductReady \? ` \+\$\{definition\.dailyAmount\}` : ' 待休息'\}`\}[\s\S]*aria-label=\{`\$\{definition\.label\} \$\{animal\.name\}：\$\{farmAnimalMoodLabel\(animal\.mood\)\}，\$\{definition\.productLabel\} x\$\{animal\.productCount\}，今日\$\{animalProducedToday \? ` \+\$\{definition\.dailyAmount\}` : ' 未新增'\}，明早\$\{animalNextProductReady \? ` \+\$\{definition\.dailyAmount\}` : ' 待休息'\}`\}[\s\S]*<em data-farm-animal-mood-chip="true">\{farmAnimalMoodLabel\(animal\.mood\)\}<\/em>[\s\S]*<mark data-farm-animal-product-chip="true">\{definition\.productLabel\} x\{animal\.productCount\}<\/mark>[\s\S]*animalProducedToday && \([\s\S]*<i data-farm-animal-today-product-chip="true">今日 \+\{definition\.dailyAmount\}<\/i>[\s\S]*\)[\s\S]*animalNextProductReady && \([\s\S]*<i data-farm-animal-next-product-chip="true">明早 \+\{definition\.dailyAmount\}<\/i>/);
  assert.match(panel, /onSelectTool\?: \(tool: FarmTool\) => void/);
  assert.match(panel, /onJumpToMature\?: \(\) => void/);
  assert.match(panel, /function farmToolOption\(tool: FarmTool\)/);
  assert.match(panel, /const selectedToolOption = farmToolOption\(selectedTool\)/);
  assert.match(panel, /const SelectedToolIcon = selectedToolOption\.icon/);
  assert.match(panel, /const \[farmToolDetailPulseId, setFarmToolDetailPulseId\] = useState\(''\)/);
  assert.match(panel, /const \[farmSummaryPulseId, setFarmSummaryPulseId\] = useState\(''\)/);
  assert.match(panel, /const farmToolsRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(panel, /const farmSummaryRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(panel, /const farmToolDetailPulseTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmToolDetailScrollFrameRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmSummaryPulseTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmSummaryScrollFrameRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmToolDetailOpened = Boolean\(farmToolDetailPulseId\)/);
  assert.match(panel, /const farmSummaryOpened = Boolean\(farmSummaryPulseId\)/);
  assert.match(panel, /const witheredCount = farmCanvas\?\.objects\.filter\(\(object\) => object\.crop\?\.stage === 'withered'\)\.length \|\| 0/);
  assert.match(panel, /const dryCount = farmCanvas\?\.objects\.filter\(\(object\) =>[\s\S]*object\.crop\.dryDays > 0[\s\S]*object\.crop\.stage !== 'withered'[\s\S]*\)\.length \|\| 0/);
  assert.match(panel, /const scarecrowRiskCount = countFarmScarecrowUnprotectedDryCrops\(farmCanvas\)/);
  assert.match(panel, /const handleFarmMiniScarecrowRiskAction = \(\) => \{[\s\S]*setFarmScarecrowRiskPulseId\(`scarecrow-risk-\$\{Date\.now\(\)\}`\)[\s\S]*onSelectBuilding\?\.\('scarecrow'\)[\s\S]*\}/);
  assert.match(panel, /const readyOrderCount = farmCanvas[\s\S]*farmCanvas\.orders\.filter\(\(order\) => canCompleteOrder\(farmCanvas, order\.id\)\)\.length/);
  assert.match(panel, /const readyNpcVisitCount = farmCanvas[\s\S]*farmCanvas\.npcVisits\.filter\(\(visit\) => !visit\.completed && canCompleteFarmNpcVisit\(farmCanvas, visit\.id\)\)\.length/);
  assert.match(panel, /const dailySummary = farmCanvas\?\.lastDailySummary/);
  assert.match(panel, /showDailySummary = visualStyle === 'farm-story'/);
  assert.match(panel, /dailySummary\.rainWateredCrops/);
  assert.match(panel, /dailySummary\.festivalBonusGold/);
  assert.match(panel, /dailySummary\.animalProductsProduced/);
  assert.match(panel, /dailySummary\.rareEventsFound/);
  assert.match(panel, /t8-farm-story-panel__festival-task/);
  assert.match(panel, /节庆委托/);
  assert.match(panel, /event\.key === 'Escape'[\s\S]*setDismissedSummaryId\(dailySummary\.id\)/);
  assert.match(panel, /const farmActivityFeed = buildFarmActivityFeed\(farmCanvas, \{ maxItems: 3 \}\)/);
  assert.match(panel, /const farmActivityDigest = buildFarmActivityDigest\(farmCanvas\)/);
  assert.match(panel, /type FarmLiveFeedbackKind = 'action' \| 'reward' \| 'quest' \| 'ready' \| 'mature' \| 'water' \| 'cleanup' \| 'build'/);
  assert.match(panel, /type FarmSummaryActionTone = 'mature' \| 'water' \| 'cleanup' \| 'ready' \| 'quest' \| 'build'/);
  assert.match(panel, /type FarmFocusGoalAction/);
  assert.match(panel, /action\?: FarmFocusGoalAction/);
  assert.match(panel, /actionLabel\?: string/);
  assert.match(panel, /type FarmSummaryDetailActionKind = 'tool' \| 'water' \| 'seed' \| 'harvest' \| 'cleanup' \| 'order' \| 'npc' \| 'build' \| 'decor' \| 'day' \| 'mature'/);
  assert.match(panel, /type FarmActionResourceTarget = 'gold' \| 'seed' \| 'water' \| 'wood' \| 'stone' \| 'mature' \| 'withered' \| 'beauty' \| 'day' \| 'scarecrow'/);
  assert.match(panel, /function farmSummaryDetailActionKind\(action\?: FarmFocusGoalAction\): FarmSummaryDetailActionKind/);
  assert.match(panel, /action\.kind === 'select-tool'[\s\S]*action\.tool === 'water'[\s\S]*return 'water'/);
  assert.match(panel, /action\.kind === 'complete-order'[\s\S]*return 'order'/);
  assert.match(panel, /action\.kind === 'complete-npc'[\s\S]*return 'npc'/);
  assert.match(panel, /function farmActionResourceTargets\(action\?: FarmFocusGoalAction\): FarmActionResourceTarget\[\]/);
  assert.match(panel, /action\.kind === 'select-tool'[\s\S]*action\.tool === 'water'[\s\S]*return \['water'\]/);
  assert.match(panel, /action\.kind === 'select-building' && action\.buildingId === 'scarecrow'[\s\S]*return \['wood', 'stone', 'scarecrow'\]/);
  assert.match(panel, /action\.kind === 'select-building'[\s\S]*return \['wood', 'stone'\]/);
  assert.match(panel, /action\.kind === 'advance-day'[\s\S]*return \['day', 'water'\]/);
  assert.match(panel, /function farmActionResourcePreviewLabel\(targets: FarmActionResourceTarget\[\]\): string/);
  assert.match(panel, /targets\.includes\('wood'\) && targets\.includes\('stone'\)[\s\S]*labels\.push\('木石'\)/);
  assert.match(panel, /targets\.includes\('scarecrow'\)[\s\S]*labels\.push\('守护'\)/);
  assert.match(panel, /function farmSummaryActionFeedbackLabel\(action: FarmSummaryActionItem\): string/);
  assert.match(panel, /const summaryAction = action\.action/);
  assert.match(panel, /summaryAction\.kind === 'select-building' && summaryAction\.buildingId === 'scarecrow'[\s\S]*return '已选择稻草人'/);
  assert.match(panel, /summaryAction\.kind === 'select-tool'[\s\S]*summaryAction\.tool === 'water'[\s\S]*return '已切到水壶'/);
  assert.match(panel, /function farmSummaryActionReceiptNextHint\(action: FarmSummaryActionItem\): string/);
  assert.match(panel, /summaryAction\.kind === 'select-tool'[\s\S]*summaryAction\.tool === 'water'[\s\S]*return '下一步：点缺水作物浇水'/);
  assert.match(panel, /summaryAction\.kind === 'select-tool'[\s\S]*summaryAction\.tool === 'shovel'[\s\S]*return '下一步：点枯萎地块清理'/);
  assert.match(panel, /summaryAction\.kind === 'jump-mature'[\s\S]*return '下一步：点成熟作物收获'/);
  assert.match(panel, /summaryAction\.kind === 'select-building' && summaryAction\.buildingId === 'scarecrow'[\s\S]*return '下一步：放到缺水区旁守护作物'/);
  assert.match(panel, /summaryAction\.kind === 'complete-order'[\s\S]*return '下一步：查看金币和节庆奖励'/);
  assert.match(panel, /summaryAction\.kind === 'complete-npc'[\s\S]*return '下一步：查看来访奖励'/);
  assert.match(panel, /function farmFocusActionNextHint\(action\?: FarmFocusGoalAction\): string/);
  assert.match(panel, /function farmFocusActionNextHint\(action\?: FarmFocusGoalAction\): string[\s\S]*if \(!action\) return ''/);
  assert.match(panel, /function farmFocusActionNextHint\(action\?: FarmFocusGoalAction\): string[\s\S]*action\.kind === 'select-tool'[\s\S]*action\.tool === 'water'[\s\S]*return '下一步：点缺水作物浇水'/);
  assert.match(panel, /function farmFocusActionNextHint\(action\?: FarmFocusGoalAction\): string[\s\S]*action\.tool === 'shovel'[\s\S]*return '下一步：点枯萎地块清理'/);
  assert.match(panel, /function farmFocusActionNextHint\(action\?: FarmFocusGoalAction\): string[\s\S]*action\.kind === 'select-building' && action\.buildingId === 'scarecrow'[\s\S]*return '下一步：放到缺水区旁守护作物'/);
  assert.match(panel, /function farmFocusActionNextHint\(action\?: FarmFocusGoalAction\): string[\s\S]*action\.kind === 'complete-order'[\s\S]*return '下一步：查看金币和节庆奖励'/);
  assert.match(panel, /function farmFocusActionNextHint\(action\?: FarmFocusGoalAction\): string[\s\S]*action\.kind === 'select-decor'[\s\S]*return '下一步：布置装饰提升漂亮度'/);
  assert.match(panel, /type FarmFocusActionNextTarget = 'water' \| 'cleanup' \| 'seed' \| 'harvest' \| 'build' \| 'scarecrow' \| 'reward' \| 'social' \| 'decor' \| 'day' \| 'action'/);
  assert.match(panel, /function farmFocusActionNextTarget\(action\?: FarmFocusGoalAction\): FarmFocusActionNextTarget \| undefined/);
  assert.match(panel, /function farmFocusActionNextTarget\(action\?: FarmFocusGoalAction\): FarmFocusActionNextTarget \| undefined[\s\S]*if \(!action\) return undefined/);
  assert.match(panel, /function farmFocusActionNextTarget\(action\?: FarmFocusGoalAction\): FarmFocusActionNextTarget \| undefined[\s\S]*action\.kind === 'select-tool'[\s\S]*action\.tool === 'water'[\s\S]*return 'water'/);
  assert.match(panel, /function farmFocusActionNextTarget\(action\?: FarmFocusGoalAction\): FarmFocusActionNextTarget \| undefined[\s\S]*action\.tool === 'shovel'[\s\S]*return 'cleanup'/);
  assert.match(panel, /function farmFocusActionNextTarget\(action\?: FarmFocusGoalAction\): FarmFocusActionNextTarget \| undefined[\s\S]*action\.kind === 'select-building' && action\.buildingId === 'scarecrow'[\s\S]*return 'scarecrow'/);
  assert.match(panel, /function farmFocusActionNextTarget\(action\?: FarmFocusGoalAction\): FarmFocusActionNextTarget \| undefined[\s\S]*action\.kind === 'complete-order'[\s\S]*return 'reward'/);
  assert.match(panel, /function farmFocusActionNextTarget\(action\?: FarmFocusGoalAction\): FarmFocusActionNextTarget \| undefined[\s\S]*action\.kind === 'complete-npc'[\s\S]*return 'social'/);
  assert.match(panel, /function farmFocusActionNextBadgeLabel\(action\?: FarmFocusGoalAction\): string/);
  assert.match(panel, /function farmFocusActionNextBadgeLabel\(action\?: FarmFocusGoalAction\): string[\s\S]*if \(!action\) return ''/);
  assert.match(panel, /function farmFocusActionNextBadgeLabel\(action\?: FarmFocusGoalAction\): string[\s\S]*action\.kind === 'select-tool'[\s\S]*action\.tool === 'water'[\s\S]*return '浇水'/);
  assert.match(panel, /function farmFocusActionNextBadgeLabel\(action\?: FarmFocusGoalAction\): string[\s\S]*action\.tool === 'shovel'[\s\S]*return '清理'/);
  assert.match(panel, /function farmFocusActionNextBadgeLabel\(action\?: FarmFocusGoalAction\): string[\s\S]*action\.kind === 'select-building' && action\.buildingId === 'scarecrow'[\s\S]*return '守护'/);
  assert.match(panel, /function farmFocusActionNextBadgeLabel\(action\?: FarmFocusGoalAction\): string[\s\S]*action\.kind === 'complete-order'[\s\S]*return '奖励'/);
  assert.match(panel, /function farmFocusActionNextBadgeLabel\(action\?: FarmFocusGoalAction\): string[\s\S]*action\.kind === 'complete-npc'[\s\S]*return '来访'/);
  assert.match(panel, /function farmSummaryActionReceiptNextBadgeLabel\(action: FarmSummaryActionItem\): string/);
  assert.match(panel, /summaryAction\.kind === 'select-tool'[\s\S]*summaryAction\.tool === 'water'[\s\S]*return '浇水'/);
  assert.match(panel, /summaryAction\.kind === 'select-tool'[\s\S]*summaryAction\.tool === 'shovel'[\s\S]*return '清理'/);
  assert.match(panel, /summaryAction\.kind === 'jump-mature'[\s\S]*return '收获'/);
  assert.match(panel, /summaryAction\.kind === 'select-building' && summaryAction\.buildingId === 'scarecrow'[\s\S]*return '守护'/);
  assert.match(panel, /summaryAction\.kind === 'complete-order'[\s\S]*return '奖励'/);
  assert.match(panel, /summaryAction\.kind === 'complete-npc'[\s\S]*return '来访'/);
  assert.match(panel, /interface FarmSummaryActionReceiptNextCounts/);
  assert.match(panel, /dryCount: number/);
  assert.match(panel, /witheredCount: number/);
  assert.match(panel, /matureCount: number/);
  assert.match(panel, /scarecrowRiskCount: number/);
  assert.match(panel, /readyOrderCount: number/);
  assert.match(panel, /readyNpcVisitCount: number/);
  assert.match(panel, /function farmSummaryActionReceiptNextCountLabel\(action: FarmSummaryActionItem, counts: FarmSummaryActionReceiptNextCounts\): string/);
  assert.match(panel, /summaryAction\.kind === 'select-tool'[\s\S]*summaryAction\.tool === 'water'[\s\S]*return counts\.dryCount > 0 \? `\$\{counts\.dryCount\}块` : ''/);
  assert.match(panel, /summaryAction\.kind === 'select-tool'[\s\S]*summaryAction\.tool === 'shovel'[\s\S]*return counts\.witheredCount > 0 \? `\$\{counts\.witheredCount\}块` : ''/);
  assert.match(panel, /summaryAction\.kind === 'jump-mature'[\s\S]*return counts\.matureCount > 0 \? `\$\{counts\.matureCount\}个` : ''/);
  assert.match(panel, /summaryAction\.kind === 'select-building' && summaryAction\.buildingId === 'scarecrow'[\s\S]*return counts\.scarecrowRiskCount > 0 \? `\$\{counts\.scarecrowRiskCount\}处` : ''/);
  assert.match(panel, /summaryAction\.kind === 'complete-order'[\s\S]*return counts\.readyOrderCount > 0 \? `\$\{counts\.readyOrderCount\}单` : ''/);
  assert.match(panel, /summaryAction\.kind === 'complete-npc'[\s\S]*return counts\.readyNpcVisitCount > 0 \? `\$\{counts\.readyNpcVisitCount\}访` : ''/);
  assert.match(panel, /interface FarmLiveFeedbackItem[\s\S]*icon: typeof Sparkles[\s\S]*rewardKind\?: FarmRewardBurstKind[\s\S]*rewardKindLabel\?: string/);
  assert.match(panel, /interface FarmSummaryActionItem/);
  assert.match(panel, /icon: typeof Sparkles/);
  assert.match(panel, /const farmSummaryActions: FarmSummaryActionItem\[\] =/);
  assert.match(panel, /dailySummary && matureCount > 0[\s\S]*icon: Wheat[\s\S]*action: \{ kind: 'jump-mature' \}/);
  assert.match(panel, /dailySummary && dailySummary\.dryCrops > 0[\s\S]*icon: Droplets[\s\S]*action: \{ kind: 'select-tool', tool: 'water' \}/);
  assert.match(panel, /dailySummary && dailySummary\.witheredCrops > 0[\s\S]*icon: Shovel[\s\S]*action: \{ kind: 'select-tool', tool: 'shovel' \}/);
  assert.match(panel, /dailySummary && scarecrowRiskCount > 0[\s\S]*id: 'summary-scarecrow-risk'[\s\S]*label: `补稻草人 \$\{scarecrowRiskCount\}`[\s\S]*title: `选择稻草人，守护 \$\{scarecrowRiskCount\} 块缺水作物`[\s\S]*tone: 'build'[\s\S]*icon: Hammer[\s\S]*action: \{ kind: 'select-building', buildingId: 'scarecrow' \}/);
  assert.match(panel, /dailySummary && dailySummary\.readyOrders > 0 && orderReady && currentOrder[\s\S]*icon: Package[\s\S]*action: \{ kind: 'complete-order', orderId: currentOrder\.id \}/);
  assert.match(panel, /dailySummary && dailySummary\.readyNpcVisits > 0 && npcVisitReady && activeNpcVisit[\s\S]*icon: UserRound[\s\S]*action: \{ kind: 'complete-npc', visitId: activeNpcVisit\.id \}/);
  assert.match(panel, /function compactFarmHudFeedback\(value: unknown, maxLength = 34\)/);
  assert.match(panel, /const farmLiveFeedbackItems: FarmLiveFeedbackItem\[\] =/);
  assert.match(panel, /feedback \? \{ id: 'current-feedback'[\s\S]*icon: Sparkles/);
  assert.match(panel, /farmRewardBursts\[0\] \? \{ id: `reward-\$\{farmRewardBursts\[0\]\.id\}`[\s\S]*rewardKind: farmRewardBursts\[0\]\.kind[\s\S]*rewardKindLabel: farmRewardKindLabel\(farmRewardBursts\[0\]\.kind\)[\s\S]*icon: farmRewardBurstIcon\(farmRewardBursts\[0\]\.kind\)/);
  assert.match(panel, /witheredCount > 0[\s\S]*kind: 'cleanup'[\s\S]*label: `枯萎作物 x\$\{witheredCount\}`[\s\S]*icon: Shovel[\s\S]*action: \{ kind: 'select-tool', tool: 'shovel' \}[\s\S]*actionLabel: '切到铲子'/);
  assert.match(panel, /dryCount > 0[\s\S]*kind: 'water'[\s\S]*label: `缺水作物 x\$\{dryCount\}`[\s\S]*icon: Droplets[\s\S]*action: \{ kind: 'select-tool', tool: 'water' \}[\s\S]*actionLabel: '切到水壶'/);
  assert.match(panel, /scarecrowRiskCount > 0[\s\S]*id: 'scarecrow-risk-build'[\s\S]*kind: 'build'[\s\S]*label: `补稻草人 x\$\{scarecrowRiskCount\}`[\s\S]*icon: Hammer[\s\S]*action: \{ kind: 'select-building', buildingId: 'scarecrow' \}[\s\S]*actionLabel: '选择稻草人'/);
  assert.match(panel, /orderReady && currentOrder[\s\S]*kind: 'ready'[\s\S]*icon: Package[\s\S]*action: \{ kind: 'complete-order', orderId: currentOrder\.id \}/);
  assert.match(panel, /npcVisitReady && activeNpcVisit[\s\S]*kind: 'quest'[\s\S]*icon: UserRound[\s\S]*action: \{ kind: 'complete-npc', visitId: activeNpcVisit\.id \}/);
  assert.match(panel, /matureCount > 0[\s\S]*kind: 'mature'[\s\S]*icon: Wheat[\s\S]*action: \{ kind: 'jump-mature' \}/);
  assert.match(panel, /const handleFarmGoalAction = \(action: FarmFocusGoalAction\) =>/);
  assert.match(panel, /interface FarmMiniQuickActionFeedback/);
  assert.match(panel, /actionKind: FarmFocusGoalAction\['kind'\]/);
  assert.match(panel, /buildingId\?: string/);
  assert.match(panel, /tool\?: FarmTool/);
  assert.match(panel, /icon: typeof Sparkles/);
  assert.match(panel, /const \[farmMiniQuickActionFeedback, setFarmMiniQuickActionFeedback\] = useState<FarmMiniQuickActionFeedback \| null>\(null\)/);
  assert.match(panel, /const farmMiniQuickActionTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const flashFarmMiniQuickAction = \(goal: FarmFocusGoal, actionLabel: string\) =>/);
  assert.match(panel, /setFarmMiniQuickActionFeedback\(\{[\s\S]*label: `已\$\{actionLabel\}`[\s\S]*kind: goal\.kind/);
  assert.match(panel, /actionKind: goal\.action\.kind/);
  assert.match(panel, /buildingId: goal\.action\.kind === 'select-building' \? goal\.action\.buildingId : undefined/);
  assert.match(panel, /tool: goal\.action\.kind === 'select-tool' \? goal\.action\.tool : undefined/);
  assert.match(panel, /icon: farmMiniFocusActionIcon\(goal\)/);
  assert.match(panel, /window\.setTimeout\(\(\) => \{[\s\S]*setFarmMiniQuickActionFeedback\(null\)[\s\S]*farmMiniQuickActionTimerRef\.current = null[\s\S]*\}, 1200\)/);
  assert.match(panel, /const handleFarmMiniFocusAction = \(\) => \{[\s\S]*!primaryFarmFocus \|\| !primaryFarmFocusActionLabel \|\| farmMiniQuickActionBusy[\s\S]*handleFarmGoalAction\(primaryFarmFocus\.action\);[\s\S]*flashFarmMiniQuickAction\(primaryFarmFocus, primaryFarmFocusActionLabel\)/);
  assert.match(panel, /const handleFarmLiveFeedbackAction = \(item: FarmLiveFeedbackItem\) =>/);
  assert.match(panel, /if \(farmSummaryDetailActionFeedbackItemId === item\.id && farmSummaryDetailActionFeedback\) return/);
  assert.match(panel, /flashFarmSummaryDetailAction\(item\.actionLabel \|\| '执行', item\.id\)/);
  assert.match(panel, /action: \{ kind: 'complete-order', orderId: currentOrder\.id \}/);
  assert.match(panel, /action: \{ kind: 'complete-npc', visitId: activeNpcVisit\.id \}/);
  assert.match(panel, /action: \{ kind: 'jump-mature' \}/);
  assert.match(panel, /data-farm-live-feedback-count=\{farmLiveFeedbackItems\.length\}/);
  assert.match(panel, /data-farm-feedback-kind=\{item\.kind\}/);
  assert.match(panel, /data-farm-reward-kind=\{item\.rewardKind \|\| undefined\}/);
  assert.match(panel, /data-farm-reward-kind-label=\{item\.rewardKindLabel \|\| undefined\}/);
  assert.match(panel, /title=\{item\.rewardKindLabel \? `\$\{item\.rewardKindLabel\}：\$\{item\.label\}` : item\.label\}/);
  assert.match(panel, /data-farm-feedback-action=\{item\.action\.kind\}/);
  assert.match(panel, /data-farm-feedback-action-busy=\{liveFeedbackActionActive \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-feedback-action-result=\{liveFeedbackActionActive \? farmSummaryDetailActionFeedback : undefined\}/);
  assert.match(panel, /const MiniQuickActionIcon = farmMiniQuickActionFeedback\?\.icon \|\| Sparkles/);
  assert.match(panel, /const ItemIcon = item\.icon/);
  assert.match(panel, /const liveFeedbackResourceTargets = item\.action \? farmActionResourceTargets\(item\.action\) : \[\]/);
  assert.match(panel, /const liveFeedbackResourcePreview = item\.action \? farmActionResourcePreviewLabel\(liveFeedbackResourceTargets\) : ''/);
  assert.match(panel, /const liveFeedbackForecasts = \[liveFeedbackResourcePreview, liveFeedbackProgressPreview\]\.filter\(Boolean\)\.join\('，'\)/);
  assert.match(panel, /const liveFeedbackActionDescription = liveFeedbackForecasts[\s\S]*liveFeedbackForecasts[\s\S]*item\.actionLabel \|\| '执行'/);
  assert.match(panel, /const liveFeedbackActionActive = farmSummaryDetailActionFeedbackItemId === item\.id && Boolean\(farmSummaryDetailActionFeedback\)/);
  assert.match(panel, /const liveFeedbackContent = liveFeedbackActionActive \? \([\s\S]*<Sparkles size=\{10\} \/>[\s\S]*<span>\{`已执行：\$\{farmSummaryDetailActionFeedback\}`\}<\/span>[\s\S]*\) : content/);
  assert.match(panel, /<ItemIcon size=\{10\} \/>/);
  assert.match(panel, /item\.rewardKindLabel && \([\s\S]*<small data-farm-live-reward-kind-label="true">\{item\.rewardKindLabel\}<\/small>[\s\S]*\)/);
  assert.match(panel, /liveFeedbackResourcePreview && \([\s\S]*<em data-farm-feedback-action-resource="true">\{liveFeedbackResourcePreview\.replace\('预期：', ''\)\}<\/em>[\s\S]*\)/);
  assert.match(panel, /data-farm-feedback-action-resource-targets=\{liveFeedbackResourceTargets\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-feedback-action-resource-preview=\{liveFeedbackResourcePreview \|\| undefined\}/);
  assert.match(panel, /disabled=\{liveFeedbackActionActive\}[\s\S]*aria-disabled=\{liveFeedbackActionActive \? 'true' : undefined\}/);
  assert.match(panel, /aria-label=\{liveFeedbackActionActive \? `刚刚执行：\$\{farmSummaryDetailActionFeedback\}` : liveFeedbackActionDescription\}/);
  assert.match(panel, /title=\{liveFeedbackActionActive \? `刚刚执行：\$\{farmSummaryDetailActionFeedback\}` : liveFeedbackActionDescription\}/);
  assert.match(panel, /handleFarmLiveFeedbackAction\(item\)/);
  assert.match(panel, /className="t8-farm-story-panel__live-feedback-item is-actionable"/);
  assert.match(panel, /aria-atomic="true"/);
  assert.match(panel, /t8-farm-story-panel__mini-status/);
  assert.match(panel, /data-farm-mini-status="monitor"/);
  assert.match(panel, /data-farm-mini-panel-state=\{panelOpen \? 'open' : 'closed'\}/);
  assert.doesNotMatch(panel, /data-farm-mini-status=\{panelOpen \? 'monitor' : 'collapsed'\}/);
  assert.match(panel, /data-farm-mini-day=\{farmCanvas\?\.day \|\| 1\}/);
  assert.match(panel, /data-farm-mini-season=\{currentSeason\}/);
  assert.match(panel, /data-farm-mini-weather=\{currentWeather\}/);
  assert.match(panel, /data-farm-mini-gold=\{farmCanvas\?\.resources\.gold \|\| 0\}/);
  assert.match(panel, /data-farm-mini-seeds=\{totalSeedCount\}/);
  assert.match(panel, /data-farm-mini-water=\{waterAmount\}/);
  assert.match(panel, /data-farm-mini-wood=\{woodAmount\}/);
  assert.match(panel, /data-farm-mini-stone=\{stoneAmount\}/);
  assert.match(panel, /data-farm-mini-buildings=\{farmBuildingEffects\.totalBuildings\}/);
  assert.match(panel, /data-farm-mini-wells=\{farmBuildingEffects\.wells\}/);
  assert.match(panel, /data-farm-mini-storages=\{farmBuildingEffects\.storages\}/);
  assert.match(panel, /data-farm-mini-boards=\{farmBuildingEffects\.boards\}/);
  assert.match(panel, /data-farm-mini-scarecrows=\{farmBuildingEffects\.scarecrows\}/);
  assert.match(panel, /data-farm-mini-building-yields=\{farmMiniBuildingEffectSummaryLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-building-targets=\{farmMiniBuildingEffectTargetLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt=\{farmPlacementHudReceiptLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-kind=\{farmPlacementHudReceiptKind \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-source=\{farmPlacementHudReceiptSource \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-title=\{farmPlacementHudReceiptTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-canvas-hint=\{farmPlacementHudReceiptCanvasHint \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-canvas-tone=\{farmPlacementHudReceiptLabel \? farmPlacementHudReceiptCanvasTone : undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next=\{farmPlacementHudReceiptNextLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-title=\{farmPlacementHudReceiptNextTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target=\{farmPlacementHudReceiptNextTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target-title=\{farmPlacementHudReceiptNextTargetTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target-opened=\{farmPlacementHudReceiptNextTargetOpened \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target-opened-title=\{farmPlacementHudReceiptNextTargetOpenedTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target-opened-canvas-hint=\{farmPlacementHudReceiptNextTargetOpenedCanvasHint \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target-opened-canvas-tone=\{farmPlacementHudReceiptNextTargetOpenedCanvasHint \? farmPlacementHudReceiptNextTargetOpenedCanvasTone : undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup=\{farmPlacementHudReceiptFollowupLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-title=\{farmPlacementHudReceiptFollowupTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-target=\{farmPlacementHudReceiptFollowupTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-route=\{farmPlacementHudReceiptFollowupTarget \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-route-label=\{farmPlacementHudReceiptFollowupRouteLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-route-title=\{farmPlacementHudReceiptFollowupRouteTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-route-receipt=\{farmPlacementRouteHintReceipt \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-action-receipt=\{farmPlacementFollowupActionReceipt \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-action-count=\{farmPlacementHudReceiptFollowupCountLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-action-resource=\{farmPlacementHudReceiptFollowupResourceLabel \|\| undefined\}/);
  assert.match(panel, /aria-label=\{`牧场折叠状态[\s\S]*当前工具 \$\{selectedToolOption\.label\}\$\{farmPlacementHudReceiptNextTargetTitle \? `，\$\{farmPlacementHudReceiptNextTargetTitle\}` : ''\}\$\{farmPlacementHudReceiptNextTargetOpenedTitle \? `，\$\{farmPlacementHudReceiptNextTargetOpenedTitle\}` : ''\}\$\{farmPlacementHudReceiptFollowupTitle \? `，\$\{farmPlacementHudReceiptFollowupTitle\}` : ''\}`\}/);
  assert.match(panel, /title=\{farmMiniBuildingEffectTitleLabel\}/);
  assert.match(panel, /data-farm-mini-scarecrow-risk=\{scarecrowRiskCount\}/);
  assert.match(panel, /data-farm-mini-animals=\{animalCount\}/);
  assert.match(panel, /data-farm-mini-animal-products=\{totalAnimalProducts\}/);
  assert.match(panel, /data-farm-mini-animal-mood-summary=\{farmAnimalMoodSummaryLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-animal-mood-preview=\{farmAnimalMoodPreviewLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-animal-mood-tone=\{farmAnimalMoodTone \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-animal-product-summary=\{animalProductSummary \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-animal-product-preview=\{farmMiniAnimalProductPreviewLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-animal-product-receipt=\{farmAnimalProductReceiptSummary \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-animal-product-receipt-count=\{farmAnimalProductReceiptCount \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-animal-product-receipt-preview=\{farmMiniAnimalProductReceiptPreviewLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-animal-next-products=\{farmAnimalNextProductSummary \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-animal-next-products-count=\{farmAnimalNextProductCount \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-animal-next-products-preview=\{farmMiniAnimalNextProductPreviewLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-beauty-score=\{farmBeautyScore\.score\}/);
  assert.match(panel, /data-farm-mini-beauty-level=\{farmBeautyScore\.level\}/);
  assert.match(panel, /data-farm-mini-mature=\{matureCount\}/);
  assert.match(panel, /data-farm-mini-dry=\{dryCount\}/);
  assert.match(panel, /data-farm-mini-withered=\{witheredCount\}/);
  assert.match(panel, /data-farm-mini-ready-orders=\{readyOrderCount\}/);
  assert.match(panel, /data-farm-mini-ready-npc=\{readyNpcVisitCount\}/);
  assert.match(panel, /data-farm-mini-activity-count=\{farmActivityDigest\.todayTotal\}/);
  assert.match(panel, /data-farm-mini-activity-rewards=\{farmActivityDigest\.todayRewardTotal\}/);
  assert.match(panel, /data-farm-mini-activity-percent=\{farmActivityDigest\.percent\}/);
  assert.match(panel, /data-farm-mini-activity-tone=\{farmActivityDigest\.tone\}/);
  assert.match(panel, /data-farm-mini-activity-action-linked=\{farmMiniQuickActionBusy \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-action-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-feedback-label=\{farmMiniQuickActionActivityFeedbackLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-action-summary=\{farmMiniQuickActionSummaryLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-id=\{primaryFarmFocus\?\.id \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-kind=\{primaryFarmFocus\?\.kind \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-progress=\{primaryFarmFocus\?\.progress \?\? undefined\}/);
  assert.match(panel, /data-farm-mini-focus-target=\{primaryFarmFocus\?\.target \?\? undefined\}/);
  assert.match(panel, /data-farm-mini-focus-percent=\{primaryFarmFocus\?\.percent \?\? undefined\}/);
  assert.match(panel, /data-farm-mini-focus-progress-preview=\{primaryFarmFocusProgressPreview \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-next-progress=\{primaryFarmFocus \? primaryFarmFocusNextProgress : undefined\}/);
  assert.match(panel, /data-farm-mini-focus-next-percent=\{primaryFarmFocus \? primaryFarmFocusNextPercent : undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action=\{primaryFarmFocusActionLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-flash=\{farmMiniQuickActionBusy \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-busy=\{farmMiniQuickActionBusy \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-feedback=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-feedback-kind=\{farmMiniQuickActionFeedback\?\.kind \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-feedback-action=\{farmMiniQuickActionFeedback\?\.actionKind \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-feedback-tool=\{farmMiniQuickActionFeedback\?\.tool \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-resource-feedback-targets=\{farmMiniQuickActionResourceTargets\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-resource-feedback-label=\{farmMiniQuickActionResourceFeedbackLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-ready=\{primaryFarmFocusReady \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-focus-complete=\{primaryFarmFocusComplete \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-tool=\{selectedTool\}/);
  assert.match(panel, /const farmMiniToolFlash = Boolean\(farmMiniQuickActionFeedback\?\.tool && farmMiniQuickActionFeedback\.tool === selectedTool\)/);
  assert.match(panel, /data-farm-mini-tool-flash=\{farmMiniToolFlash \? 'true' : undefined\}/);
  assert.match(panel, /aria-label=\{`牧场折叠状态：第 \$\{farmCanvas\?\.day \|\| 1\} 天[\s\S]*稻草人待守护 \$\{scarecrowRiskCount\}[\s\S]*动物 \$\{animalCount\}，产物 \$\{totalAnimalProducts\}，明早产物 \$\{farmAnimalNextProductSummary \|\| '暂无'\}，今日动物产出 \$\{farmAnimalProductReceiptSummary \|\| '暂无'\}[\s\S]*小目标 \$\{primaryFarmFocus \? `\$\{primaryFarmFocus\.title\} \$\{primaryFarmFocus\.progress\}\/\$\{primaryFarmFocus\.target\} \$\{primaryFarmFocusStatusLabel\}` : '暂无'\}，下一步 \$\{primaryFarmFocusActionLabel \|\| '暂无'\}，当前工具 \$\{selectedToolOption\.label\}\$\{farmPlacementHudReceiptNextTargetTitle \? `，\$\{farmPlacementHudReceiptNextTargetTitle\}` : ''\}\$\{farmPlacementHudReceiptNextTargetOpenedTitle \? `，\$\{farmPlacementHudReceiptNextTargetOpenedTitle\}` : ''\}\$\{farmPlacementHudReceiptFollowupTitle \? `，\$\{farmPlacementHudReceiptFollowupTitle\}` : ''\}`\}/);
  assert.match(panel, /aria-label=\{`牧场折叠状态：[\s\S]*建筑收益 \$\{farmMiniBuildingEffectSummaryLabel \|\| '暂无'\}[\s\S]*`\}/);
  assert.match(panel, /aria-label=\{`牧场折叠状态：[\s\S]*建筑目标 \$\{farmMiniBuildingEffectTargetLabel \|\| '暂无'\}[\s\S]*`\}/);
  assert.match(panel, /data-farm-mini-status-item="day"/);
  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="day"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-summary-opened=\{farmSummaryOpened \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast=\{primaryFarmFocusActionResourceTargets\.includes\('day'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast-preview=\{primaryFarmFocusActionResourceTargets\.includes\('day'\) \? primaryFarmFocusActionResourcePreview \|\| undefined : undefined\}[\s\S]*data-farm-mini-resource-forecast-action=\{primaryFarmFocusActionResourceTargets\.includes\('day'\) \? farmMiniFocusActionBaseLabel \|\| undefined : undefined\}[\s\S]*handleOpenFarmSummary\(\)[\s\S]*第\{farmCanvas\?\.day \|\| 1\}天/);
  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="season"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-season-opened=\{farmSeasonDetailOpened \? 'true' : undefined\}[\s\S]*title=\{farmSeasonDetailOpened \? `已定位季节：\$\{seasonDefinition\.label\}` : `查看季节：\$\{seasonDefinition\.label\}`\}[\s\S]*aria-label=\{farmSeasonDetailOpened \? `已定位季节：\$\{seasonDefinition\.label\}` : `查看季节：\$\{seasonDefinition\.label\}`\}[\s\S]*handleOpenFarmSeasonDetail\(\)[\s\S]*\{seasonDefinition\.label\}/);
  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="weather"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-weather-opened=\{farmSeasonDetailOpened \? 'true' : undefined\}[\s\S]*title=\{farmSeasonDetailOpened \? `已定位天气：\$\{weatherTitle\}` : `查看天气：\$\{weatherTitle\}`\}[\s\S]*aria-label=\{farmSeasonDetailOpened \? `已定位天气：\$\{weatherTitle\}` : `查看天气：\$\{weatherTitle\}`\}[\s\S]*handleOpenFarmSeasonDetail\(\)[\s\S]*<MiniWeatherIcon size=\{11\} \/>[\s\S]*\{weatherTitle\}/);
  assert.match(panel, /data-farm-mini-status-item="gold"[\s\S]*data-farm-mini-resource-linked=\{farmMiniQuickActionResourceTargets\.includes\('gold'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-linked-result=\{farmMiniQuickActionResourceTargets\.includes\('gold'\) \? farmMiniQuickActionFeedback\?\.label \|\| undefined : undefined\}/);
  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="seed"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-seed-tool-opened=\{farmSeedToolOpened \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-linked=\{farmMiniQuickActionResourceTargets\.includes\('seed'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-linked-result=\{farmMiniQuickActionResourceTargets\.includes\('seed'\) \? farmMiniQuickActionFeedback\?\.label \|\| undefined : undefined\}[\s\S]*disabled=\{totalSeedCount === 0\}[\s\S]*aria-disabled=\{totalSeedCount === 0\}[\s\S]*title=\{farmSeedToolOpened \? `已切到播种，种子 \$\{totalSeedCount\}` : totalSeedCount > 0 \? `切到播种，种子 \$\{totalSeedCount\}` : '没有可播种子'\}[\s\S]*handleFarmMiniSeedToolAction\(\)[\s\S]*种子 \{totalSeedCount\}/);
  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="water"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-water-tool-opened=\{farmWaterToolOpened \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-linked=\{farmMiniQuickActionResourceTargets\.includes\('water'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-linked-result=\{farmMiniQuickActionResourceTargets\.includes\('water'\) \? farmMiniQuickActionFeedback\?\.label \|\| undefined : undefined\}[\s\S]*disabled=\{waterAmount === 0\}[\s\S]*aria-disabled=\{waterAmount === 0\}[\s\S]*title=\{farmWaterToolOpened \? `已切到水壶，水量 \$\{waterAmount\}` : waterAmount > 0 \? `切到水壶，水量 \$\{waterAmount\}` : '水量不足'\}[\s\S]*handleFarmMiniWaterToolAction\(\)[\s\S]*水量 \{waterAmount\}/);
  for (const target of ['day', 'water', 'building-yield-summary', 'beauty', 'scarecrow-risk', 'ready-order']) {
    assert.match(
      panel,
      new RegExp(`data-farm-mini-status-item="${target}"[\\s\\S]*data-farm-mini-placement-followup-route=\\{farmPlacementHudReceiptFollowupTarget === '${target}' \\? 'true' : undefined\\}[\\s\\S]*data-farm-mini-placement-followup-route-count=\\{farmPlacementHudReceiptFollowupTarget === '${target}' \\? farmPlacementHudReceiptFollowupCountLabel \\|\\| undefined : undefined\\}[\\s\\S]*data-farm-mini-placement-followup-route-resource=\\{farmPlacementHudReceiptFollowupTarget === '${target}' \\? farmPlacementHudReceiptFollowupResourceLabel \\|\\| undefined : undefined\\}`),
    );
  }
  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="wood"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-wood-build-opened=\{farmWoodBuildOpened \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-linked=\{farmMiniQuickActionResourceTargets\.includes\('wood'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-linked-result=\{farmMiniQuickActionResourceTargets\.includes\('wood'\) \? farmMiniQuickActionFeedback\?\.label \|\| undefined : undefined\}[\s\S]*title=\{farmWoodBuildOpened \? `已切到建造，\$\{selectedBuildingDefinition\.label\} · 木材 \$\{woodAmount\}` : `切到建造，\$\{selectedBuildingDefinition\.label\} · 木材 \$\{woodAmount\}`\}[\s\S]*handleFarmMiniBuildToolAction\('wood'\)[\s\S]*木材 \{woodAmount\}/);
  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="stone"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-stone-build-opened=\{farmStoneBuildOpened \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-linked=\{farmMiniQuickActionResourceTargets\.includes\('stone'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-linked-result=\{farmMiniQuickActionResourceTargets\.includes\('stone'\) \? farmMiniQuickActionFeedback\?\.label \|\| undefined : undefined\}[\s\S]*title=\{farmStoneBuildOpened \? `已切到建造，\$\{selectedBuildingDefinition\.label\} · 石头 \$\{stoneAmount\}` : `切到建造，\$\{selectedBuildingDefinition\.label\} · 石头 \$\{stoneAmount\}`\}[\s\S]*handleFarmMiniBuildToolAction\('stone'\)[\s\S]*石头 \{stoneAmount\}/);
  assert.match(panel, /data-farm-mini-status-item="gold"[\s\S]*data-farm-mini-resource-forecast=\{primaryFarmFocusActionResourceTargets\.includes\('gold'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast-preview=\{primaryFarmFocusActionResourceTargets\.includes\('gold'\) \? primaryFarmFocusActionResourcePreview \|\| undefined : undefined\}[\s\S]*data-farm-mini-resource-forecast-action=\{primaryFarmFocusActionResourceTargets\.includes\('gold'\) \? farmMiniFocusActionBaseLabel \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="seed"[\s\S]*data-farm-mini-resource-forecast=\{primaryFarmFocusActionResourceTargets\.includes\('seed'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast-preview=\{primaryFarmFocusActionResourceTargets\.includes\('seed'\) \? primaryFarmFocusActionResourcePreview \|\| undefined : undefined\}[\s\S]*data-farm-mini-resource-forecast-action=\{primaryFarmFocusActionResourceTargets\.includes\('seed'\) \? farmMiniFocusActionBaseLabel \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="water"[\s\S]*data-farm-mini-resource-forecast=\{primaryFarmFocusActionResourceTargets\.includes\('water'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast-preview=\{primaryFarmFocusActionResourceTargets\.includes\('water'\) \? primaryFarmFocusActionResourcePreview \|\| undefined : undefined\}[\s\S]*data-farm-mini-resource-forecast-action=\{primaryFarmFocusActionResourceTargets\.includes\('water'\) \? farmMiniFocusActionBaseLabel \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="wood"[\s\S]*data-farm-mini-resource-forecast=\{primaryFarmFocusActionResourceTargets\.includes\('wood'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast-preview=\{primaryFarmFocusActionResourceTargets\.includes\('wood'\) \? primaryFarmFocusActionResourcePreview \|\| undefined : undefined\}[\s\S]*data-farm-mini-resource-forecast-action=\{primaryFarmFocusActionResourceTargets\.includes\('wood'\) \? farmMiniFocusActionBaseLabel \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="stone"[\s\S]*data-farm-mini-resource-forecast=\{primaryFarmFocusActionResourceTargets\.includes\('stone'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast-preview=\{primaryFarmFocusActionResourceTargets\.includes\('stone'\) \? primaryFarmFocusActionResourcePreview \|\| undefined : undefined\}[\s\S]*data-farm-mini-resource-forecast-action=\{primaryFarmFocusActionResourceTargets\.includes\('stone'\) \? farmMiniFocusActionBaseLabel \|\| undefined : undefined\}/);
  assert.match(panel, /farmMiniQuickActionResourceFeedbackLabel &&[\s\S]*className="t8-farm-story-panel__mini-resource-feedback"[\s\S]*data-farm-mini-status-item="resource-feedback"[\s\S]*data-farm-mini-resource-feedback-targets=\{farmMiniQuickActionResourceTargets\.join\(' '\)\}[\s\S]*data-farm-mini-resource-feedback-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}[\s\S]*资源联动：\$\{farmMiniQuickActionResourceFeedbackLabel\}[\s\S]*aria-hidden="true"[\s\S]*<Sparkles size=\{10\} \/>[\s\S]*\{farmMiniQuickActionResourceFeedbackLabel\}/);
  assert.match(farmPanelMiniPlacementReceipt, /farmPlacementHudReceiptLabel && \([\s\S]*<button[\s\S]*type="button"[\s\S]*className="t8-farm-story-panel__mini-placement-receipt"[\s\S]*data-farm-mini-status-item="placement-receipt"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-placement-receipt-action=\{farmPlacementHudReceiptKind\}[\s\S]*data-farm-mini-placement-receipt-source=\{farmPlacementHudReceiptSource \|\| undefined\}[\s\S]*data-farm-mini-placement-receipt-label=\{farmPlacementHudReceiptLabel\}[\s\S]*data-farm-mini-placement-receipt-canvas-hint=\{farmPlacementHudReceiptCanvasHint \|\| undefined\}[\s\S]*data-farm-mini-placement-receipt-canvas-tone=\{farmPlacementHudReceiptCanvasTone\}[\s\S]*title=\{`\$\{farmPlacementHudReceiptCanvasHint\} · 画布提示\$\{farmPlacementHudReceiptNextTargetTitle \? ` · \$\{farmPlacementHudReceiptNextTargetTitle\}` : ''\}\$\{farmPlacementHudReceiptNextTargetOpenedTitle \? ` · \$\{farmPlacementHudReceiptNextTargetOpenedTitle\}` : ''\}\$\{farmPlacementHudReceiptFollowupTitle \? ` · \$\{farmPlacementHudReceiptFollowupTitle\}` : ''\}`\}[\s\S]*aria-label=\{`\$\{farmPlacementHudReceiptCanvasHint\}，画布同步提示\$\{farmPlacementHudReceiptNextTargetTitle \? `，\$\{farmPlacementHudReceiptNextTargetTitle\}` : ''\}\$\{farmPlacementHudReceiptNextTargetOpenedTitle \? `，\$\{farmPlacementHudReceiptNextTargetOpenedTitle\}` : ''\}\$\{farmPlacementHudReceiptFollowupTitle \? `，\$\{farmPlacementHudReceiptFollowupTitle\}` : ''\}`\}[\s\S]*handleFarmPlacementHudReceiptAction\(\)[\s\S]*<Sparkles size=\{10\} \/>[\s\S]*<b>\{farmPlacementHudReceiptLabel\}<\/b>[\s\S]*farmPlacementHudReceiptSource && \([\s\S]*<small data-farm-mini-placement-receipt-source-text="true">\{farmPlacementHudReceiptSource\}<\/small>[\s\S]*\)[\s\S]*<em data-farm-mini-placement-receipt-action-text="true">\{farmPlacementHudReceiptActionLabel\}<\/em>[\s\S]*<\/button>[\s\S]*\)/);
  assert.match(panel, /data-farm-mini-placement-receipt-next=\{farmPlacementHudReceiptNextLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-title=\{farmPlacementHudReceiptNextTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target=\{farmPlacementHudReceiptNextTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target-title=\{farmPlacementHudReceiptNextTargetTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target-opened=\{farmPlacementHudReceiptNextTargetOpened \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target-opened-title=\{farmPlacementHudReceiptNextTargetOpenedTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target-opened-canvas-hint=\{farmPlacementHudReceiptNextTargetOpenedCanvasHint \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-next-target-opened-canvas-tone=\{farmPlacementHudReceiptNextTargetOpenedCanvasHint \? farmPlacementHudReceiptNextTargetOpenedCanvasTone : undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup=\{farmPlacementHudReceiptFollowupLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-title=\{farmPlacementHudReceiptFollowupTitle \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-placement-receipt-followup-target=\{farmPlacementHudReceiptFollowupTarget \|\| undefined\}/);
  assert.match(panel, /title=\{`\$\{farmPlacementHudReceiptCanvasHint\} · 画布提示\$\{farmPlacementHudReceiptNextTargetTitle \? ` · \$\{farmPlacementHudReceiptNextTargetTitle\}` : ''\}\$\{farmPlacementHudReceiptNextTargetOpenedTitle \? ` · \$\{farmPlacementHudReceiptNextTargetOpenedTitle\}` : ''\}\$\{farmPlacementHudReceiptFollowupTitle \? ` · \$\{farmPlacementHudReceiptFollowupTitle\}` : ''\}`\}/);
  assert.match(panel, /farmPlacementHudReceiptNextTargetTitle && \([\s\S]*className="t8-farm-story-panel__sr-only t8-farm-story-panel__mini-placement-target-live"[\s\S]*data-farm-mini-placement-receipt-next-target-live="true"[\s\S]*data-farm-mini-placement-receipt-next-target-live-target=\{farmPlacementHudReceiptNextTarget\}[\s\S]*\{farmPlacementHudReceiptNextTargetTitle\}[\s\S]*<\/span>/);
  assert.match(panel, /farmPlacementHudReceiptNextLabel && \([\s\S]*<i[\s\S]*data-farm-mini-placement-receipt-next-text="true"[\s\S]*title=\{farmPlacementHudReceiptNextTargetTitle \|\| farmPlacementHudReceiptNextTitle\}[\s\S]*\{farmPlacementHudReceiptNextLabel\}[\s\S]*<\/i>[\s\S]*\)/);
  assert.match(panel, /farmPlacementHudReceiptNextTargetOpenedTitle && \([\s\S]*<strong[\s\S]*data-farm-mini-placement-receipt-next-target-opened-chip="true"[\s\S]*title=\{farmPlacementHudReceiptNextTargetOpenedTitle\}[\s\S]*已接入[\s\S]*<\/strong>[\s\S]*\)/);
  assert.match(panel, /farmPlacementHudReceiptFollowupLabel && \([\s\S]*<i[\s\S]*data-farm-mini-placement-receipt-followup-text="true"[\s\S]*title=\{farmPlacementHudReceiptFollowupTitle\}[\s\S]*\{farmPlacementHudReceiptFollowupLabel\}[\s\S]*<\/i>[\s\S]*\)/);
  assert.match(panel, /farmPlacementHudReceiptFollowupLabel && \([\s\S]*className="t8-farm-story-panel__mini-placement-followup-action"[\s\S]*data-farm-mini-status-item="placement-followup"[\s\S]*data-farm-mini-placement-receipt-followup-action="true"[\s\S]*data-farm-mini-placement-receipt-followup-action-target=\{farmPlacementHudReceiptFollowupTarget \|\| undefined\}[\s\S]*data-farm-mini-placement-receipt-followup-action-receipt=\{farmPlacementFollowupActionReceipt \|\| undefined\}[\s\S]*data-farm-mini-placement-receipt-followup-action-count=\{farmPlacementHudReceiptFollowupCountLabel \|\| undefined\}[\s\S]*data-farm-mini-placement-receipt-followup-action-resource=\{farmPlacementHudReceiptFollowupResourceLabel \|\| undefined\}[\s\S]*disabled=\{farmPlacementFollowupActionBusy\}[\s\S]*aria-disabled=\{farmPlacementFollowupActionBusy \? 'true' : undefined\}[\s\S]*handleFarmPlacementHudReceiptFollowupAction\(\)[\s\S]*\{farmPlacementFollowupActionReceipt \? '已接上' : farmPlacementHudReceiptFollowupLabel\}[\s\S]*data-farm-mini-placement-followup-action-count="true"[\s\S]*\{farmPlacementHudReceiptFollowupCountLabel\}[\s\S]*data-farm-mini-placement-followup-action-resource="true"[\s\S]*\{farmPlacementHudReceiptFollowupResourceLabel\}/);
  assert.match(panel, /farmPlacementHudReceiptFollowupRouteLabel && \([\s\S]*className="t8-farm-story-panel__mini-placement-route-hint"[\s\S]*data-farm-mini-status-item="placement-route"[\s\S]*data-farm-mini-placement-receipt-followup-route-hint="true"[\s\S]*data-farm-mini-placement-receipt-followup-route-hint-target=\{farmPlacementHudReceiptFollowupTarget \|\| undefined\}[\s\S]*data-farm-mini-placement-receipt-followup-route-hint-title=\{farmPlacementHudReceiptFollowupRouteTitle \|\| undefined\}[\s\S]*data-farm-mini-placement-receipt-followup-route-hint-count=\{farmPlacementHudReceiptFollowupCountLabel \|\| undefined\}[\s\S]*data-farm-mini-placement-receipt-followup-route-hint-resource=\{farmPlacementHudReceiptFollowupResourceLabel \|\| undefined\}[\s\S]*data-farm-mini-placement-receipt-followup-route-hint-receipt=\{farmPlacementRouteHintReceipt \|\| undefined\}[\s\S]*handleFarmPlacementHudReceiptRouteHintAction\(\)[\s\S]*\{farmPlacementRouteHintReceipt \|\| farmPlacementHudReceiptFollowupRouteLabel\}[\s\S]*data-farm-mini-placement-route-hint-count="true"[\s\S]*\{farmPlacementHudReceiptFollowupCountLabel\}/);
  assert.match(panel, /farmPlacementHudReceiptKind === 'building'[\s\S]*handleFarmPlacementHudReceiptAction\(\);[\s\S]*return;[\s\S]*handleOpenFarmBuildingEffects\(\);/);
  assert.match(panel, /farmPlacementHudReceiptKind === 'decor'[\s\S]*handleFarmPlacementHudReceiptAction\(\);[\s\S]*return;[\s\S]*handleOpenFarmBeautyDetail\(\);/);
  assert.match(farmPanelMiniBuildingYield, /farmMiniBuildingEffectItems\.length > 0 &&[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="building-yield-summary"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-building-yield-count=\{farmMiniBuildingEffectItems\.length\}[\s\S]*data-farm-mini-building-yield-summary=\{farmMiniBuildingEffectSummaryLabel\}[\s\S]*data-farm-mini-building-yield-targets=\{farmMiniBuildingEffectTargetLabel\}[\s\S]*data-farm-mini-building-yield-primary-target=\{farmMiniBuildingEffectPrimaryTargetLabel \|\| undefined\}[\s\S]*data-farm-mini-building-yield-primary-tone=\{farmMiniBuildingEffectPrimaryTargetTone \|\| undefined\}[\s\S]*data-farm-mini-building-yield-opened=\{farmBuildingEffectOpened \? 'true' : undefined\}[\s\S]*data-farm-mini-building-yield-placement-receipt=\{farmPlacementHudReceiptKind === 'building' \? farmPlacementHudReceiptLabel : undefined\}[\s\S]*data-farm-mini-building-yield-placement-source=\{farmPlacementHudReceiptKind === 'building' \? farmPlacementHudReceiptSource \|\| undefined : undefined\}[\s\S]*title=\{`查看\$\{farmMiniBuildingEffectTitleLabel\}`\}[\s\S]*aria-label=\{`查看\$\{farmMiniBuildingEffectTitleLabel\}`\}[\s\S]*handleOpenFarmBuildingEffects\(\)[\s\S]*<Sparkles size=\{11\} \/>[\s\S]*建效\{farmMiniBuildingEffectItems\.length\}[\s\S]*farmPlacementHudReceiptKind === 'building' && \([\s\S]*<small data-farm-mini-placement-receipt-text="true">\{farmPlacementHudReceiptLabel\}<\/small>[\s\S]*\)[\s\S]*<small data-farm-mini-building-yield-targets-text="true">目标\{farmMiniBuildingEffectItems\.length\}<\/small>[\s\S]*farmMiniBuildingEffectPrimaryTargetLabel && \([\s\S]*<small data-farm-mini-building-yield-primary-target-text="true">\{farmMiniBuildingEffectPrimaryTargetLabel\}<\/small>/);
  assert.match(panel, /data-farm-mini-building-quest-route-target=\{farmBuildingEffectQuestPrimary\?\.routeTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-building-quest-route-label=\{farmBuildingEffectQuestPrimary\?\.routeLabel \|\| undefined\}/);
  assert.match(panel, /farmBuildingEffectQuestPrimary && \([\s\S]*className="t8-farm-story-panel__mini-building-quest-route-hint"[\s\S]*data-farm-mini-status-item="building-quest-route"[\s\S]*data-farm-mini-building-quest-route-hint="true"[\s\S]*data-farm-mini-building-quest-route-target=\{farmBuildingEffectQuestPrimary\.routeTarget\}[\s\S]*data-farm-mini-building-quest-route-label=\{farmBuildingEffectQuestPrimary\.routeLabel\}[\s\S]*data-farm-mini-building-quest-route-receipt=\{farmBuildingEffectQuestRouteReceipt \|\| undefined\}[\s\S]*handleFarmBuildingEffectQuestRouteHintAction\(farmBuildingEffectQuestPrimary\)[\s\S]*\{farmBuildingEffectQuestRouteReceipt \|\| `地图找\$\{farmBuildingEffectQuestPrimary\.routeLabel\}`\}/);
  assert.match(panel, /farmMiniBuildingEffectItems\.map\(\(item\) =>/);
  assert.match(panel, /const MiniBuildingIcon = item\.icon/);
  assert.match(panel, /data-farm-mini-status-item=\{`building-\$\{item\.id\}`\}/);
  assert.match(panel, /data-farm-mini-building-effect=\{item\.id\}/);
  assert.match(panel, /data-farm-mini-building-effect-support=\{item\.supportTone\}/);
  assert.match(panel, /data-farm-mini-building-effect-yield=\{item\.yieldLabel\}/);
  assert.match(panel, /data-farm-mini-building-effect-next=\{item\.nextTargetLabel\}/);
  assert.match(panel, /data-farm-mini-building-effect-next-tone=\{item\.supportTone\}/);
  assert.match(panel, /title=\{`\$\{item\.title\} · \$\{item\.yieldLabel\} · 目标 \$\{item\.nextTargetLabel\}`\}/);
  assert.match(panel, /aria-label=\{`\$\{item\.title\} · \$\{item\.yieldLabel\} · 目标 \$\{item\.nextTargetLabel\}`\}/);
  assert.match(panel, /<MiniBuildingIcon size=\{11\} \/>[\s\S]*<b>\{item\.label\}<\/b>[\s\S]*<em data-farm-mini-building-effect-yield-text="true">\{item\.yieldLabel\}<\/em>[\s\S]*<i data-farm-mini-building-effect-next-text="true">\{item\.nextTargetLabel\}<\/i>/);
  assert.match(farmPanelMiniAnimalButtons, /animalCount > 0[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="animal"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-animal-mood-summary=\{farmAnimalMoodSummaryLabel \|\| undefined\}[\s\S]*data-farm-mini-animal-mood-preview=\{farmAnimalMoodPreviewLabel \|\| undefined\}[\s\S]*data-farm-mini-animal-mood-tone=\{farmAnimalMoodTone \|\| undefined\}[\s\S]*data-farm-mini-animal-opened=\{farmAnimalProductOpened \? 'true' : undefined\}[\s\S]*title=\{`查看动物 \$\{animalCount\} · 心情 \$\{farmAnimalMoodSummaryLabel \|\| '暂无'\}`\}[\s\S]*aria-label=\{`查看动物 \$\{animalCount\}，心情 \$\{farmAnimalMoodSummaryLabel \|\| '暂无'\}`\}[\s\S]*handleOpenFarmAnimals\(\)[\s\S]*畜\{animalCount\}[\s\S]*farmAnimalMoodPreviewLabel && \([\s\S]*<small data-farm-mini-animal-mood-preview-text="true">\{farmAnimalMoodPreviewLabel\}<\/small>/);
  assert.match(farmPanelMiniAnimalButtons, /totalAnimalProducts > 0[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="animal-product"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-animal-product-summary=\{animalProductSummary\}[\s\S]*data-farm-mini-animal-product-preview=\{farmMiniAnimalProductPreviewLabel \|\| undefined\}[\s\S]*data-farm-mini-animal-product-opened=\{farmAnimalProductOpened \? 'true' : undefined\}[\s\S]*title=\{`查看动物产物 \$\{totalAnimalProducts\} · \$\{animalProductSummary \|\| '待收集'\}`\}[\s\S]*aria-label=\{`查看动物产物 \$\{totalAnimalProducts\}，\$\{animalProductSummary \|\| '待收集'\}`\}[\s\S]*handleOpenFarmAnimals\(\)[\s\S]*产\{totalAnimalProducts\}[\s\S]*farmMiniAnimalProductPreviewLabel && \([\s\S]*<small data-farm-mini-animal-product-preview-text="true">\{farmMiniAnimalProductPreviewLabel\}<\/small>/);
  assert.match(farmPanelMiniAnimalButtons, /farmAnimalProductReceiptCount > 0[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="animal-product-receipt"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-animal-product-receipt=\{farmAnimalProductReceiptSummary\}[\s\S]*data-farm-mini-animal-product-receipt-count=\{farmAnimalProductReceiptCount\}[\s\S]*data-farm-mini-animal-product-receipt-preview=\{farmMiniAnimalProductReceiptPreviewLabel \|\| undefined\}[\s\S]*data-farm-mini-animal-product-receipt-opened=\{farmAnimalProductOpened \? 'true' : undefined\}[\s\S]*title=\{`查看今日动物产出 \$\{farmAnimalProductReceiptCount\} · \$\{farmAnimalProductReceiptSummary \|\| '暂无'\}`\}[\s\S]*aria-label=\{`查看今日动物产出 \$\{farmAnimalProductReceiptCount\}，\$\{farmAnimalProductReceiptSummary \|\| '暂无'\}`\}[\s\S]*handleOpenFarmAnimals\(\)[\s\S]*今\{farmAnimalProductReceiptCount\}[\s\S]*farmMiniAnimalProductReceiptPreviewLabel && \([\s\S]*<small data-farm-mini-animal-product-receipt-preview-text="true">\{farmMiniAnimalProductReceiptPreviewLabel\}<\/small>/);
  assert.match(farmPanelMiniAnimalButtons, /farmAnimalNextProductCount > 0[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="animal-next-product"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-animal-next-products=\{farmAnimalNextProductSummary\}[\s\S]*data-farm-mini-animal-next-products-count=\{farmAnimalNextProductCount\}[\s\S]*data-farm-mini-animal-next-products-preview=\{farmMiniAnimalNextProductPreviewLabel \|\| undefined\}[\s\S]*data-farm-mini-animal-next-products-opened=\{farmAnimalProductOpened \? 'true' : undefined\}[\s\S]*title=\{`查看明早动物产出 \$\{farmAnimalNextProductCount\} · \$\{farmAnimalNextProductSummary \|\| '暂无'\}`\}[\s\S]*aria-label=\{`查看明早动物产出 \$\{farmAnimalNextProductCount\}，\$\{farmAnimalNextProductSummary \|\| '暂无'\}`\}[\s\S]*handleOpenFarmAnimals\(\)[\s\S]*明\{farmAnimalNextProductCount\}[\s\S]*farmMiniAnimalNextProductPreviewLabel && \([\s\S]*<small data-farm-mini-animal-next-products-preview-text="true">\{farmMiniAnimalNextProductPreviewLabel\}<\/small>/);
  assert.match(panel, /farmActivityDigest\.todayTotal > 0[\s\S]*data-farm-mini-status-item="activity"[\s\S]*data-farm-mini-activity-tone=\{farmActivityDigest\.tone\}[\s\S]*data-farm-mini-activity-action-linked=\{farmMiniQuickActionBusy \? 'true' : undefined\}[\s\S]*data-farm-mini-activity-action-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}[\s\S]*刚刚计入：\$\{farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocusActionLabel\}[\s\S]*今日成果 \$\{farmActivityDigest\.todayTotal\}\/\$\{farmActivityDigest\.target\}[\s\S]*活\{farmActivityDigest\.todayTotal\}/);
  assert.match(panel, /farmMiniQuickActionActivityFeedbackLabel &&[\s\S]*className="t8-farm-story-panel__mini-activity-feedback"[\s\S]*data-farm-mini-status-item="activity-feedback"[\s\S]*data-farm-mini-activity-feedback-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}[\s\S]*今日成果：\$\{farmMiniQuickActionActivityFeedbackLabel\}[\s\S]*aria-hidden="true"[\s\S]*<Sparkles size=\{10\} \/>[\s\S]*\{farmMiniQuickActionActivityFeedbackLabel\}/);
  assert.match(panel, /farmActivityDigest\.todayRewardTotal > 0[\s\S]*data-farm-mini-status-item="activity-reward"[\s\S]*data-farm-mini-activity-tone=\{farmActivityDigest\.tone\}[\s\S]*今日正反馈 \$\{farmActivityDigest\.todayRewardTotal\}[\s\S]*奖\{farmActivityDigest\.todayRewardTotal\}/);
  assert.match(panel, /primaryFarmFocus &&[\s\S]*data-farm-mini-status-item="focus"[\s\S]*data-farm-mini-focus-kind=\{primaryFarmFocus\.kind\}[\s\S]*data-farm-mini-focus-ready=\{primaryFarmFocusReady \? 'true' : undefined\}[\s\S]*data-farm-mini-focus-complete=\{primaryFarmFocusComplete \? 'true' : undefined\}[\s\S]*data-farm-mini-focus-action-linked=\{farmMiniQuickActionBusy \? 'true' : undefined\}[\s\S]*data-farm-mini-focus-action-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}[\s\S]*刚刚推进：\$\{farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocusActionLabel\}[\s\S]*<Flag size=\{11\} \/>[\s\S]*目\{primaryFarmFocus\.progress\}\/\{primaryFarmFocus\.target\}/);
  assert.match(farmPanelMiniFocusAction, /primaryFarmFocusActionLabel &&[\s\S]*data-farm-mini-status-item="focus-action"[\s\S]*data-farm-mini-focus-kind=\{primaryFarmFocus\?\.kind\}[\s\S]*data-farm-mini-focus-ready=\{primaryFarmFocusReady \? 'true' : undefined\}[\s\S]*data-farm-mini-focus-complete=\{primaryFarmFocusComplete \? 'true' : undefined\}[\s\S]*title=\{farmMiniFocusActionTitle\}[\s\S]*farmMiniQuickActionBusy \? <MiniQuickActionIcon size=\{11\} \/> : <Sparkles size=\{11\} \/>[\s\S]*farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocusActionLabel : primaryFarmFocusActionLabel/);
  assert.match(farmPanelMiniFocusAction, /primaryFarmFocusActionLabel &&[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-focus-action-clickable="true"[\s\S]*data-farm-mini-focus-action-fired=\{farmMiniQuickActionBusy \? 'true' : undefined\}[\s\S]*data-farm-mini-focus-action-busy=\{farmMiniQuickActionBusy \? 'true' : undefined\}[\s\S]*disabled=\{farmMiniQuickActionBusy\}[\s\S]*aria-disabled=\{farmMiniQuickActionBusy \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-summary=\{farmMiniQuickActionSummaryLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-resource-targets=\{primaryFarmFocusActionResourceTargets\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-resource-preview=\{primaryFarmFocusActionResourcePreview \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-progress-preview=\{primaryFarmFocusProgressPreview \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-next-progress=\{primaryFarmFocus \? primaryFarmFocusNextProgress : undefined\}/);
  assert.match(panel, /data-farm-mini-focus-action-target=\{primaryFarmFocus\?\.target \?\? undefined\}/);
  assert.match(panel, /const farmMiniFocusActionBaseLabel = primaryFarmFocus\?\.actionLabel \|\| primaryFarmFocusActionLabel/);
  assert.match(panel, /const primaryFarmFocusNextProgress = primaryFarmFocus \? Math\.min\(primaryFarmFocus\.target, primaryFarmFocus\.progress \+ 1\) : 0/);
  assert.match(panel, /const primaryFarmFocusNextPercent = primaryFarmFocus \? Math\.round\(\(primaryFarmFocusNextProgress \/ Math\.max\(1, primaryFarmFocus\.target\)\) \* 100\) : 0/);
  assert.match(panel, /const primaryFarmFocusProgressPreview = primaryFarmFocus[\s\S]*primaryFarmFocusComplete \? '已完成' : `预计：\$\{primaryFarmFocusNextProgress\}\/\$\{primaryFarmFocus\.target\}`/);
  assert.match(panel, /const farmMiniFocusActionResourceSuffix = primaryFarmFocusActionResourcePreview \? ` · \$\{primaryFarmFocusActionResourcePreview\}` : ''/);
  assert.match(panel, /const farmMiniFocusActionProgressSuffix = primaryFarmFocusProgressPreview \? ` · \$\{primaryFarmFocusProgressPreview\}` : ''/);
  assert.match(panel, /const farmMiniFocusActionTitle = farmMiniQuickActionBusy[\s\S]*`刚刚执行：\$\{farmMiniQuickActionSummaryLabel \|\| farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocusActionLabel\}\$\{farmMiniFocusActionResourceSuffix\}\$\{farmMiniFocusActionProgressSuffix\}`[\s\S]*`下一步：\$\{farmMiniFocusActionBaseLabel\}\$\{farmMiniFocusActionResourceSuffix\}\$\{farmMiniFocusActionProgressSuffix\}`/);
  assert.match(panel, /const farmMiniFocusActionAriaLabel = farmMiniQuickActionBusy[\s\S]*`刚刚执行：\$\{farmMiniQuickActionSummaryLabel \|\| farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocusActionLabel\}\$\{farmMiniFocusActionResourceSuffix\}\$\{farmMiniFocusActionProgressSuffix\}`[\s\S]*`执行今日小目标：\$\{farmMiniFocusActionBaseLabel\}\$\{farmMiniFocusActionResourceSuffix\}\$\{farmMiniFocusActionProgressSuffix\}`/);
  assert.match(panel, /title=\{farmMiniFocusActionTitle\}/);
  assert.match(panel, /aria-label=\{farmMiniFocusActionAriaLabel\}/);
  assert.match(farmPanelMiniFocusAction, /primaryFarmFocusActionLabel &&[\s\S]*onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*handleFarmMiniFocusAction\(\);[\s\S]*\}\}/);
  assert.match(farmPanelMiniFocusAction, /farmMiniQuickActionBusy \? <MiniQuickActionIcon size=\{11\} \/> : <Sparkles size=\{11\} \/>/);
  assert.match(farmPanelMiniFocusAction, /<b>\{farmMiniQuickActionBusy \? farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocusActionLabel : primaryFarmFocusActionLabel\}<\/b>/);
  assert.match(panel, /primaryFarmFocusActionResourcePreview && \([\s\S]*data-farm-mini-focus-action-resource="true"[\s\S]*\{primaryFarmFocusActionResourcePreview\}/);
  assert.match(panel, /primaryFarmFocusProgressPreview && \([\s\S]*data-farm-mini-focus-action-progress="true"[\s\S]*\{primaryFarmFocusProgressPreview\}/);
  assert.match(css, /\[data-farm-mini-focus-action-progress="true"\]/);
  assert.match(css, /button\[data-farm-mini-focus-action-progress-preview\]/);
  assert.match(panel, /data-farm-mini-status-item="focus"[\s\S]*data-farm-mini-focus-progress-forecast=\{primaryFarmFocusProgressPreview \? 'true' : undefined\}[\s\S]*data-farm-mini-focus-progress-preview=\{primaryFarmFocusProgressPreview \|\| undefined\}[\s\S]*data-farm-mini-focus-next-progress=\{primaryFarmFocus \? primaryFarmFocusNextProgress : undefined\}[\s\S]*data-farm-mini-focus-next-percent=\{primaryFarmFocus \? primaryFarmFocusNextPercent : undefined\}[\s\S]*预计推进：\$\{primaryFarmFocusProgressPreview\}/);
  assert.match(panel, /className="t8-farm-story-panel__mini-focus-meter"[\s\S]*data-farm-mini-focus-progress-forecast=\{primaryFarmFocusProgressPreview \? 'true' : undefined\}[\s\S]*data-farm-mini-focus-progress-preview=\{primaryFarmFocusProgressPreview \|\| undefined\}[\s\S]*data-farm-mini-focus-next-progress=\{primaryFarmFocus \? primaryFarmFocusNextProgress : undefined\}[\s\S]*data-farm-mini-focus-next-percent=\{primaryFarmFocus \? primaryFarmFocusNextPercent : undefined\}/);
  assert.match(panel, /primaryFarmFocusProgressPreview && \([\s\S]*data-farm-mini-focus-progress-forecast-bar="true"[\s\S]*width: `\$\{primaryFarmFocusNextPercent\}%`/);
  assert.match(css, /\[data-farm-mini-status-item="focus"\]\[data-farm-mini-focus-progress-forecast="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-focus-meter\[data-farm-mini-focus-progress-forecast="true"\]/);
  assert.match(css, /\[data-farm-mini-focus-progress-forecast-bar="true"\]/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]::before/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]\[data-farm-mini-status-item="gold"\]/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]\[data-farm-mini-status-item="seed"\]/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]\[data-farm-mini-status-item="water"\]/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]\[data-farm-mini-status-item="wood"\]/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]\[data-farm-mini-status-item="stone"\]/);
  assert.match(panel, /data-farm-mini-status-item="beauty"[\s\S]*data-farm-mini-resource-forecast=\{primaryFarmFocusActionResourceTargets\.includes\('beauty'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast-preview=\{primaryFarmFocusActionResourceTargets\.includes\('beauty'\) \? primaryFarmFocusActionResourcePreview \|\| undefined : undefined\}[\s\S]*data-farm-mini-resource-forecast-action=\{primaryFarmFocusActionResourceTargets\.includes\('beauty'\) \? farmMiniFocusActionBaseLabel \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="mature"[\s\S]*data-farm-mini-resource-forecast=\{primaryFarmFocusActionResourceTargets\.includes\('mature'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast-preview=\{primaryFarmFocusActionResourceTargets\.includes\('mature'\) \? primaryFarmFocusActionResourcePreview \|\| undefined : undefined\}[\s\S]*data-farm-mini-resource-forecast-action=\{primaryFarmFocusActionResourceTargets\.includes\('mature'\) \? farmMiniFocusActionBaseLabel \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="withered"[\s\S]*data-farm-mini-resource-forecast=\{primaryFarmFocusActionResourceTargets\.includes\('withered'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast-preview=\{primaryFarmFocusActionResourceTargets\.includes\('withered'\) \? primaryFarmFocusActionResourcePreview \|\| undefined : undefined\}[\s\S]*data-farm-mini-resource-forecast-action=\{primaryFarmFocusActionResourceTargets\.includes\('withered'\) \? farmMiniFocusActionBaseLabel \|\| undefined : undefined\}/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]\[data-farm-mini-status-item="day"\]/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]\[data-farm-mini-status-item="beauty"\]/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]\[data-farm-mini-status-item="mature"\]/);
  assert.match(css, /\[data-farm-mini-resource-forecast="true"\]\[data-farm-mini-status-item="withered"\]/);
  assert.match(css, /@keyframes farm-story-mini-resource-forecast/);
  assert.match(css, /prefers-reduced-motion[\s\S]*\[data-farm-mini-resource-forecast="true"\]/);
  assert.match(panel, /farmMiniQuickActionFeedback &&[\s\S]*className="t8-farm-story-panel__mini-action-feedback"[\s\S]*data-farm-mini-status-item="focus-action-feedback"[\s\S]*data-farm-mini-focus-action-feedback-action=\{farmMiniQuickActionFeedback\.actionKind\}[\s\S]*data-farm-mini-focus-action-feedback-tool=\{farmMiniQuickActionFeedback\.tool\}[\s\S]*data-farm-mini-focus-action-summary=\{farmMiniQuickActionSummaryLabel \|\| undefined\}[\s\S]*刚刚执行：\$\{farmMiniQuickActionSummaryLabel \|\| farmMiniQuickActionFeedback\.label\}[\s\S]*aria-hidden="true"[\s\S]*<MiniQuickActionIcon size=\{11\} \/>[\s\S]*\{farmMiniQuickActionFeedback\.label\}/);
  assert.match(panel, /farmMiniQuickActionSummaryLabel &&[\s\S]*<button[\s\S]*type="button"[\s\S]*className="t8-farm-story-panel__mini-action-summary"[\s\S]*data-farm-mini-status-item="summary-feedback"[\s\S]*data-farm-mini-focus-action-summary=\{farmMiniQuickActionSummaryLabel\}[\s\S]*title=\{`完整回执：\$\{farmMiniQuickActionSummaryLabel\} · 点击展开牧场面板`\}[\s\S]*aria-label=\{`查看完整回执：\$\{farmMiniQuickActionSummaryLabel\}`\}[\s\S]*onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*setOpen\(true\);[\s\S]*\}\}[\s\S]*<Sparkles size=\{10\} \/>[\s\S]*<b>回执：\{farmMiniQuickActionSummaryLabel\}<\/b>[\s\S]*<\/button>/);
  assert.match(panel, /farmMiniQuickActionFeedback && panelOpen && farmMiniQuickActionSummaryLabel &&[\s\S]*className="t8-farm-story-panel__summary-detail"[\s\S]*data-farm-summary-detail="true"[\s\S]*data-farm-mini-focus-action-summary=\{farmMiniQuickActionSummaryLabel\}[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*title=\{`刚刚执行：\$\{farmMiniQuickActionSummaryLabel\}`\}[\s\S]*<Sparkles size=\{12\} \/>[\s\S]*<span>刚刚执行<\/span>[\s\S]*<b>\{farmMiniQuickActionSummaryLabel\}<\/b>/);
  assert.match(panel, /const farmMiniQuickActionDetailItems = \(\[[\s\S]*id: 'result'[\s\S]*label: farmMiniQuickActionFeedback\?\.label[\s\S]*title: '结果'[\s\S]*id: 'resource'[\s\S]*label: farmMiniQuickActionResourceFeedbackLabel[\s\S]*title: '资源'[\s\S]*id: 'activity'[\s\S]*label: farmMiniQuickActionActivityFeedbackLabel[\s\S]*title: '今日'[\s\S]*id: 'focus'[\s\S]*label: primaryFarmFocus\?\.title[\s\S]*title: '小目标'[\s\S]*action: primaryFarmFocus\?\.action[\s\S]*actionLabel: primaryFarmFocusActionLabel \? `继续\$\{primaryFarmFocusActionLabel\}` : '继续小目标'/);
  assert.match(panel, /actionKind: primaryFarmFocus\?\.action \? farmSummaryDetailActionKind\(primaryFarmFocus\.action\) : undefined/);
  assert.match(panel, /actionResourceTargets: primaryFarmFocusActionResourceTargets/);
  assert.match(panel, /actionResourcePreview: primaryFarmFocusActionResourcePreview/);
  assert.match(panel, /className="t8-farm-story-panel__summary-detail-chips"[\s\S]*aria-label="刚刚执行拆分回执"[\s\S]*farmMiniQuickActionDetailItems\.map\(\(item\) => \{[\s\S]*const chipContent = \([\s\S]*<small>\{item\.title\}<\/small>[\s\S]*<em>\{item\.label\}<\/em>[\s\S]*item\.actionResourcePreview && \([\s\S]*data-farm-summary-detail-chip-resource="true"[\s\S]*\{item\.actionResourcePreview\}[\s\S]*<span key=\{item\.id\} data-farm-summary-detail-chip=\{item\.id\} title=\{`\$\{item\.title\}：\$\{item\.label\}`\}>[\s\S]*\{chipContent\}/);
  assert.match(panel, /if \(item\.action\) \{[\s\S]*const action = item\.action;[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-summary-detail-chip=\{item\.id\}[\s\S]*data-farm-summary-detail-chip-actionable="true"[\s\S]*onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*handleFarmGoalAction\(action\);[\s\S]*\}\}/);
  assert.match(panel, /const \[farmSummaryDetailActionFeedback, setFarmSummaryDetailActionFeedback\] = useState\(''\)/);
  assert.match(panel, /const \[farmSummaryDetailActionFeedbackItemId, setFarmSummaryDetailActionFeedbackItemId\] = useState\(''\)/);
  assert.match(panel, /const farmSummaryDetailActionTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /farmSummaryDetailActionTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmSummaryDetailActionTimerRef\.current\)[\s\S]*farmSummaryDetailActionTimerRef\.current = null/);
  assert.match(panel, /const flashFarmSummaryDetailAction = \(label: string, itemId = ''\) => \{[\s\S]*setFarmSummaryDetailActionFeedback\(label\)[\s\S]*setFarmSummaryDetailActionFeedbackItemId\(itemId\)[\s\S]*farmSummaryDetailActionTimerRef\.current = window\.setTimeout\(\(\) => \{[\s\S]*setFarmSummaryDetailActionFeedback\(''\)[\s\S]*setFarmSummaryDetailActionFeedbackItemId\(''\)[\s\S]*farmSummaryDetailActionTimerRef\.current = null[\s\S]*\}, 1200\)/);
  assert.match(panel, /data-farm-summary-detail-action-feedback=\{farmSummaryDetailActionFeedback \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-detail-action-feedback-item-id=\{farmSummaryDetailActionFeedbackItemId \|\| undefined\}/);
  assert.match(panel, /const actionFeedbackActive = farmSummaryDetailActionFeedbackItemId === item\.id && Boolean\(farmSummaryDetailActionFeedback\)/);
  assert.match(panel, /const actionChipContent = actionFeedbackActive \? \([\s\S]*<small>已继续<\/small>[\s\S]*<em>\{farmSummaryDetailActionFeedback\}<\/em>[\s\S]*\) : chipContent/);
  assert.match(panel, /data-farm-summary-detail-chip-active=\{actionFeedbackActive \? 'true' : undefined\}[\s\S]*data-farm-summary-detail-chip-result=\{actionFeedbackActive \? farmSummaryDetailActionFeedback : undefined\}[\s\S]*title=\{actionFeedbackActive \? `刚刚继续：\$\{farmSummaryDetailActionFeedback\}` : `\$\{item\.title\}：\$\{item\.label\} · \$\{item\.actionLabel \|\| '执行'\}`\}[\s\S]*aria-label=\{actionFeedbackActive \? `刚刚继续：\$\{farmSummaryDetailActionFeedback\}` : `\$\{item\.actionLabel \|\| '执行'\}：\$\{item\.label\}`\}/);
  assert.match(panel, /data-farm-summary-detail-chip-action-kind=\{item\.actionKind \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-detail-chip-resource-targets=\{item\.actionResourceTargets\?\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-detail-chip-resource-preview=\{item\.actionResourcePreview \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-detail-chip-cooldown=\{actionFeedbackActive \? 'true' : undefined\}[\s\S]*disabled=\{actionFeedbackActive\}[\s\S]*aria-disabled=\{actionFeedbackActive \? 'true' : undefined\}/);
  assert.match(panel, /onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*if \(actionFeedbackActive\) return;[\s\S]*handleFarmGoalAction\(action\);[\s\S]*flashFarmSummaryDetailAction\(item\.actionLabel \|\| '继续小目标', item\.id\)[\s\S]*\{actionChipContent\}/);
  assert.match(panel, /farmSummaryDetailActionFeedback && \([\s\S]*className="t8-farm-story-panel__summary-detail-action-feedback"[\s\S]*data-farm-summary-detail-action-feedback-chip="true"[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*刚刚继续：\$\{farmSummaryDetailActionFeedback\}[\s\S]*<Sparkles size=\{10\} \/>[\s\S]*<em>已继续<\/em>[\s\S]*<b>\{farmSummaryDetailActionFeedback\}<\/b>/);
  assert.match(css, /button\[data-farm-summary-detail-chip-actionable="true"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-actionable="true"\]:hover/);
  assert.match(css, /button\[data-farm-summary-detail-chip-actionable="true"\]:focus-visible/);
  assert.match(css, /button\[data-farm-summary-detail-chip-action-kind="water"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-action-kind="order"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-action-kind="npc"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-action-kind="build"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-action-kind="decor"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-action-kind="day"\]/);
  assert.match(css, /\[data-farm-summary-detail-chip-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-resource-targets~="water"\] \[data-farm-summary-detail-chip-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-resource-targets~="gold"\] \[data-farm-summary-detail-chip-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-resource-targets~="wood"\] \[data-farm-summary-detail-chip-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-active="true"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-cooldown="true"\]/);
  assert.match(css, /button\[data-farm-summary-detail-chip-cooldown="true"\]:hover[\s\S]*transform: none/);
  assert.match(css, /button\[data-farm-summary-detail-chip-cooldown="true"\]::after/);
  assert.match(css, /animation:\s*farm-story-summary-detail-chip-cooldown 1\.2s linear both/);
  assert.match(css, /@keyframes farm-story-summary-detail-chip-active/);
  assert.match(css, /@keyframes farm-story-summary-detail-chip-cooldown/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*button\[data-farm-summary-detail-chip-active="true"\][\s\S]*animation: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*button\[data-farm-summary-detail-chip-cooldown="true"\]::after[\s\S]*animation: none/);
  assert.match(css, /\.t8-farm-story-panel__summary-detail-action-feedback/);
  assert.match(css, /@keyframes farm-story-summary-detail-action-feedback/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.t8-farm-story-panel__summary-detail-action-feedback[\s\S]*animation: none/);
  assert.match(panel, /farmMiniQuickActionFeedback &&[\s\S]*className="t8-farm-story-panel__mini-action-live"[\s\S]*data-farm-mini-status-item="focus-action-live"[\s\S]*data-farm-mini-focus-action-summary=\{farmMiniQuickActionSummaryLabel \|\| undefined\}[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*刚刚执行：\{farmMiniQuickActionSummaryLabel \|\| farmMiniQuickActionFeedback\.label\}/);
  assert.match(panel, /primaryFarmFocus &&[\s\S]*className="t8-farm-story-panel__mini-focus-meter"[\s\S]*data-farm-mini-status-item="focus-meter"[\s\S]*data-farm-mini-focus-kind=\{primaryFarmFocus\.kind\}[\s\S]*data-farm-mini-focus-ready=\{primaryFarmFocusReady \? 'true' : undefined\}[\s\S]*data-farm-mini-focus-complete=\{primaryFarmFocusComplete \? 'true' : undefined\}[\s\S]*data-farm-mini-focus-action-linked=\{farmMiniQuickActionBusy \? 'true' : undefined\}[\s\S]*data-farm-mini-focus-action-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}[\s\S]*刚刚推进：\$\{farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocusActionLabel\}[\s\S]*小目标进度 \$\{primaryFarmFocus\.percent\}%[\s\S]*aria-hidden="true"[\s\S]*width: `\$\{primaryFarmFocus\.percent\}%`/);
  assert.match(panel, /farmActivityDigest\.todayTotal > 0[\s\S]*className="t8-farm-story-panel__mini-activity-meter"[\s\S]*data-farm-mini-status-item="activity-meter"[\s\S]*data-farm-mini-activity-action-linked=\{farmMiniQuickActionBusy \? 'true' : undefined\}[\s\S]*data-farm-mini-activity-action-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}[\s\S]*刚刚计入：\$\{farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocusActionLabel\}[\s\S]*今日成果进度 \$\{farmActivityDigest\.percent\}%[\s\S]*aria-hidden="true"[\s\S]*width: `\$\{farmActivityDigest\.percent\}%`/);
  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="beauty"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-beauty-opened=\{farmBeautyDetailOpened \? 'true' : undefined\}[\s\S]*data-farm-mini-beauty-placement-receipt=\{farmPlacementHudReceiptKind === 'decor' \? farmPlacementHudReceiptLabel : undefined\}[\s\S]*data-farm-mini-beauty-placement-source=\{farmPlacementHudReceiptKind === 'decor' \? farmPlacementHudReceiptSource \|\| undefined : undefined\}[\s\S]*title=\{farmBeautyDetailOpened \? `已定位漂亮度 \$\{farmBeautyScore\.score\}\/100 · \$\{farmBeautyScore\.title\}` : primaryFarmFocusActionResourceTargets\.includes\('beauty'\) \? `查看漂亮度 \$\{farmBeautyScore\.score\}\/100 · \$\{farmBeautyScore\.title\} · 预计影响：\$\{farmMiniFocusActionBaseLabel\} · \$\{primaryFarmFocusActionResourcePreview\}` : `查看漂亮度 \$\{farmBeautyScore\.score\}\/100 · \$\{farmBeautyScore\.title\}`\}[\s\S]*aria-label=\{farmBeautyDetailOpened \? `已定位漂亮度 \$\{farmBeautyScore\.score\}\/100 · \$\{farmBeautyScore\.title\}` : `查看漂亮度 \$\{farmBeautyScore\.score\}\/100 · \$\{farmBeautyScore\.title\}`\}[\s\S]*handleOpenFarmBeautyDetail\(\)[\s\S]*美\{farmBeautyScore\.score\}[\s\S]*farmPlacementHudReceiptKind === 'decor' && \([\s\S]*<small data-farm-mini-placement-receipt-text="true">\{farmPlacementHudReceiptLabel\}<\/small>/);
  assert.match(panel, /data-farm-mini-beauty-reward-route-target=\{farmBeautyRewardRouteTarget\}/);
  assert.match(panel, /data-farm-mini-beauty-reward-route-reward=\{farmBeautyRewardRouteRewardLabel\}/);
  assert.match(panel, /data-farm-mini-beauty-reward-route-count=\{farmBeautyRewardRouteCountLabel\}/);
  assert.match(panel, /className="t8-farm-story-panel__mini-beauty-route-hint"[\s\S]*data-farm-mini-status-item="beauty-route"[\s\S]*data-farm-mini-beauty-reward-route-hint="true"[\s\S]*handleFarmBeautyRewardRouteHintAction\(\)[\s\S]*\{farmBeautyRewardRouteReceipt \|\| `地图找\$\{farmBeautyRewardRouteLabel\}`\}/);
  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="mature"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-mature-opened=\{farmMatureJumpOpened \? 'true' : undefined\}[\s\S]*disabled=\{matureCount === 0\}[\s\S]*aria-disabled=\{matureCount === 0\}[\s\S]*title=\{farmMatureJumpOpened \? `已定位成熟作物 \$\{matureCount\}` : `跳转成熟作物 \$\{matureCount\}`\}[\s\S]*handleFarmMiniMatureJump\(\)[\s\S]*成熟 \{matureCount\}/);
  assert.match(farmPanelQuickRiskButtons, /dryCount > 0[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="dry"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-dry-water-opened=\{farmDryWaterOpened \? 'true' : undefined\}[\s\S]*title=\{farmDryWaterOpened \? `已切到水壶，处理缺水作物 \$\{dryCount\}` : `切到水壶，处理缺水作物 \$\{dryCount\}`\}[\s\S]*aria-label=\{farmDryWaterOpened \? `已切到水壶，处理缺水作物 \$\{dryCount\}` : `切到水壶，处理缺水作物 \$\{dryCount\}`\}[\s\S]*handleFarmMiniDryWaterAction\(\)[\s\S]*缺水 \{dryCount\}/);
  assert.match(farmPanelQuickRiskButtons, /scarecrowRiskCount > 0[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="scarecrow-risk"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-scarecrow-risk-alert="true"[\s\S]*data-farm-mini-scarecrow-risk-selected=\{farmScarecrowRiskSelected \? 'true' : undefined\}[\s\S]*aria-label=\{farmScarecrowRiskSelected \? `已选择稻草人建造，守护 \$\{scarecrowRiskCount\} 块缺水作物` : `选择稻草人建造，守护 \$\{scarecrowRiskCount\} 块缺水作物`\}[\s\S]*handleFarmMiniScarecrowRiskAction\(\)[\s\S]*守护 \{scarecrowRiskCount\}/);
  assert.match(farmPanelQuickRiskButtons, /witheredCount > 0[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="withered"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-withered-shovel-opened=\{farmWitheredShovelOpened \? 'true' : undefined\}[\s\S]*data-farm-mini-resource-forecast=\{primaryFarmFocusActionResourceTargets\.includes\('withered'\) \? 'true' : undefined\}[\s\S]*handleFarmMiniWitheredShovelAction\(\)[\s\S]*枯萎 \{witheredCount\}/);
  assert.match(farmPanelQuickRiskButtons, /readyOrderCount > 0[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="ready-order"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-ready-order-opened=\{farmOrderLocateOpened \? 'true' : undefined\}[\s\S]*title=\{`查看可交付订单 \$\{readyOrderCount\}`\}[\s\S]*aria-label=\{`查看可交付订单 \$\{readyOrderCount\}`\}[\s\S]*handleOpenFarmOrder\(\)[\s\S]*订单 \{readyOrderCount\}/);
  assert.match(panel, /readyNpcVisitCount > 0[\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="ready-npc"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-ready-npc-opened=\{farmNpcVisitOpened \? 'true' : undefined\}[\s\S]*title=\{`查看可交付来访 \$\{readyNpcVisitCount\}`\}[\s\S]*aria-label=\{`查看可交付来访 \$\{readyNpcVisitCount\}`\}[\s\S]*handleOpenFarmNpcVisit\(\)[\s\S]*来访 \{readyNpcVisitCount\}/);
  assert.match(panel, /<button[\s\S]*type="button"[\s\S]*data-farm-mini-status-item="tool"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-tool-opened=\{farmToolDetailOpened \? 'true' : undefined\}[\s\S]*title=\{farmToolDetailOpened \? `已定位工具：\$\{selectedToolOption\.label\}` : farmMiniToolFlash \? `刚切换工具：\$\{selectedToolOption\.label\} · 点击查看工具栏` : `查看工具栏：\$\{selectedToolOption\.label\}`\}[\s\S]*aria-label=\{farmToolDetailOpened \? `已定位工具：\$\{selectedToolOption\.label\}` : `查看工具栏：\$\{selectedToolOption\.label\}`\}[\s\S]*handleOpenFarmTools\(\)[\s\S]*<SelectedToolIcon size=\{11\} \/>[\s\S]*<b>\{selectedToolOption\.label\}<\/b>[\s\S]*<\/button>/);
  assert.match(panel, /data-farm-mini-tool-id=\{selectedTool\}/);
  assert.match(panel, /data-farm-mini-tool-flash=\{farmMiniToolFlash \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-tool-opened=\{farmToolDetailOpened \? 'true' : undefined\}/);
  assert.match(panel, /interface FarmToolBadge/);
  assert.match(panel, /type FarmToolBadgeTone = 'neutral' \| 'ready' \| 'warning' \| 'seed' \| 'water' \| 'mature' \| 'build' \| 'decor'/);
  assert.match(panel, /function buildFarmToolBadge\(/);
  assert.match(panel, /const badge = buildFarmToolBadge\(tool\.id/);
  assert.match(panel, /data-farm-tool-id=\{tool\.id\}/);
  assert.match(panel, /data-farm-tool-badge=\{badge\?\.label\}/);
  assert.match(panel, /data-farm-tool-badge-tone=\{badge\?\.tone\}/);
  assert.match(panel, /data-farm-tool-badge-empty=\{badge\?\.empty \? 'true' : undefined\}/);
  assert.match(panel, /const unavailable = Boolean\(badge\?\.empty\)/);
  assert.match(panel, /is-badge-empty is-unavailable/);
  assert.match(panel, /data-farm-tool-unavailable=\{unavailable \? 'true' : undefined\}/);
  assert.match(panel, /当前条件不足，点击查看提示/);
  assert.match(panel, /条件不足，点击查看提示/);
  assert.match(panel, /ref=\{farmToolsRef\}[\s\S]*className="t8-farm-story-panel__tools"[\s\S]*data-farm-tools-focus=\{farmToolDetailOpened \? 'true' : undefined\}[\s\S]*data-farm-tools-pulse=\{farmToolDetailPulseId \|\| undefined\}[\s\S]*tabIndex=\{-1\}[\s\S]*aria-label=\{`牧场工具栏，当前工具：\$\{selectedToolOption\.label\}`\}/);
  assert.match(panel, /farmToolDetailOpened && \([\s\S]*className="t8-farm-story-panel__tools-located"[\s\S]*data-farm-tools-located-feedback="true"[\s\S]*工具栏已定位/);
  assert.match(panel, /t8-farm-story-panel__tool-main/);
  assert.match(panel, /t8-farm-story-panel__tool-badge/);
  assert.match(panel, /label:\s*`种子 \$\{seedCount\}`/);
  assert.match(panel, /label:\s*`水量 \$\{water\}`/);
  assert.match(panel, /label:\s*`成熟 \$\{matureCount\}`/);
  assert.match(panel, /label:\s*'缺种'/);
  assert.match(panel, /label:\s*'缺水'/);
  assert.match(panel, /t8-farm-story-panel__activity/);
  assert.match(panel, /data-farm-activity-count=\{farmActivityFeed\.todayTotal\}/);
  assert.match(panel, /data-farm-activity-kind=\{item\.kind\}/);
  assert.match(panel, /data-farm-activity-tone=\{item\.tone\}/);
  assert.match(panel, /item\.rewardLabel && <em data-farm-activity-reward-label="true">\{item\.rewardLabel\}<\/em>/);
  assert.match(panel, /t8-farm-story-panel__activity-digest is-\$\{farmActivityDigest\.tone\}/);
  assert.match(panel, /data-farm-activity-digest=\{farmActivityDigest\.tone\}/);
  assert.match(panel, /data-farm-activity-percent=\{farmActivityDigest\.percent\}/);
  assert.match(panel, /data-farm-activity-digest-rewards=\{farmActivityDigest\.todayRewardTotal\}/);
  assert.match(panel, /data-farm-activity-reward-streak=\{farmActivityDigest\.rewardStreak \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-hint=\{farmActivityDigest\.rewardStreakHint \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-tier=\{farmActivityDigest\.rewardStreakTier \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-milestone=\{farmActivityDigest\.rewardStreakMilestoneLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-target=\{farmActivityDigest\.rewardStreakMilestoneTarget \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-percent=\{farmActivityDigest\.rewardStreakMilestonePercent \?\? undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-progress=\{farmActivityDigest\.rewardStreakMilestoneProgressLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-complete=\{farmActivityDigest\.rewardStreakMilestonePercent === 100 \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-completion=\{farmActivityDigest\.rewardStreakMilestoneCompletionLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-state=\{farmActivityDigest\.rewardStreakChestState \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-tier=\{farmActivityDigest\.rewardStreakChestTier \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-progress=\{farmActivityDigest\.rewardStreakChestProgressLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-reward=\{farmActivityDigest\.rewardStreakChestRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-cta=\{farmActivityDigest\.rewardStreakChestCtaLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-claim=\{farmActivityDigest\.rewardStreakChestClaimLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-next=\{farmActivityDigest\.rewardStreakChestNextLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-items=\{farmActivityDigest\.rewardStreakChestRewardItems\?\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-burst=\{farmActivityDigest\.rewardStreakChestBurstLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-opened-summary=\{farmActivityDigest\.rewardStreakChestOpenedSummaryLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-percent=\{farmActivityDigest\.rewardStreakChestPercent \?\? undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-meter=\{farmActivityDigest\.rewardStreakChestMeterLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-charge=\{farmActivityDigest\.rewardStreakChestChargeLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-charge-hint=\{farmActivityDigest\.rewardStreakChestChargeHint \|\| undefined\}/);
  assert.match(panel, /const farmActivityStreakMeterRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(panel, /const farmActivityCompletionRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(panel, /const farmActivityActionRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(panel, /const farmActivityChestRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(panel, /const \[farmActivityChestClaimPulseId, setFarmActivityChestClaimPulseId\] = useState\(''\)/);
  assert.match(panel, /const farmActivityChestClaimTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const \[farmActivityChestChargeReceipt, setFarmActivityChestChargeReceipt\] = useState\(''\)/);
  assert.match(panel, /const farmActivityChestChargeReceiptTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const \[farmActivityChestClaimNextReceipt, setFarmActivityChestClaimNextReceipt\] = useState\(''\)/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmActivityRewardStreakGoal: FarmFocusGoal \| undefined = farmActivityDigest\.rewardStreakAction \?/);
  assert.match(panel, /const farmMiniActivityStreakChestLabel = farmActivityDigest\.rewardStreakChestShortLabel \|\| farmActivityDigest\.rewardStreakChestLabel \|\| ''/);
  assert.match(panel, /const farmActivityChestClaimed = Boolean\(farmActivityChestClaimPulseId\)/);
  assert.match(panel, /const \[farmActivityRewardStreakActionReceipt, setFarmActivityRewardStreakActionReceipt\] = useState\(''\)/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /if \(farmActivityRewardStreakActionReceiptTimerRef\.current !== null\) \{[\s\S]*window\.clearTimeout\(farmActivityRewardStreakActionReceiptTimerRef\.current\);[\s\S]*farmActivityRewardStreakActionReceiptTimerRef\.current = null;[\s\S]*\}/);
  assert.match(panel, /if \(farmActivityChestClaimNextReceiptTimerRef\.current !== null\) \{[\s\S]*window\.clearTimeout\(farmActivityChestClaimNextReceiptTimerRef\.current\);[\s\S]*farmActivityChestClaimNextReceiptTimerRef\.current = null;[\s\S]*\}/);
  assert.match(panel, /if \(farmActivityChestChargeReceiptTimerRef\.current !== null\) \{[\s\S]*window\.clearTimeout\(farmActivityChestChargeReceiptTimerRef\.current\);[\s\S]*farmActivityChestChargeReceiptTimerRef\.current = null;[\s\S]*\}/);
  assert.match(farmPanelActivityRewardStreakAction, /const handleFarmActivityRewardStreakAction = \(\) => \{[\s\S]*if \(!farmActivityRewardStreakGoal \|\| farmMiniQuickActionBusy\) \{[\s\S]*handleOpenFarmActivity\('action'\);[\s\S]*return;[\s\S]*\}[\s\S]*handleFarmFocusAction\(farmActivityRewardStreakGoal\);[\s\S]*handleOpenFarmActivity\('action'\);[\s\S]*\}/);
  assert.match(panel, /setFarmActivityRewardStreakActionReceipt\(`建议已执行：\$\{farmActivityRewardStreakGoal\.actionLabel\}`\)/);
  assert.match(farmPanelActivityChestClaimNextAction, /const handleFarmActivityChestClaimNextAction = \(\) => \{[\s\S]*if \(!farmActivityRewardStreakGoal \|\| farmMiniQuickActionBusy\) \{[\s\S]*handleOpenFarmActivity\('action'\);[\s\S]*return;[\s\S]*\}[\s\S]*setFarmActivityChestClaimNextReceipt\(`续连击已确认：\$\{farmActivityRewardStreakGoal\.actionLabel\}`\)[\s\S]*handleFarmActivityRewardStreakAction\(\);[\s\S]*\}/);
  assert.match(panel, /const farmActivityRewardDigestRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(panel, /const farmActivityStreakRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(panel, /const farmActivityMilestoneRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(panel, /type FarmActivityFocusTarget = 'section' \| 'reward-digest' \| 'streak' \| 'milestone' \| 'completion' \| 'streak-meter' \| 'action' \| 'chest' \| ''/);
  assert.match(panel, /const \[farmActivityFocusTarget, setFarmActivityFocusTarget\] = useState<FarmActivityFocusTarget>\(''\)/);
  assert.match(panel, /const farmActivitySectionOpened = farmActivityFocusTarget === 'section'/);
  assert.match(panel, /const farmActivityRewardDigestOpened = farmActivityFocusTarget === 'reward-digest'/);
  assert.match(panel, /const farmActivityStreakOpened = farmActivityFocusTarget === 'streak'/);
  assert.match(panel, /const farmActivityMilestoneOpened = farmActivityFocusTarget === 'milestone'/);
  assert.match(panel, /const handleOpenFarmActivity = \(focusTarget: FarmActivityFocusTarget = 'section'\) =>/);
  assert.match(panel, /setFarmActivityFocusTarget\(focusTarget\)/);
  assert.match(panel, /setFarmActivityDetailPulseId\(''\)[\s\S]*setFarmActivityFocusTarget\(''\)/);
  assert.match(panel, /const farmActivityElement = focusTarget === 'reward-digest'[\s\S]*farmActivityRewardDigestRef\.current \|\| farmActivityRef\.current[\s\S]*focusTarget === 'streak'[\s\S]*farmActivityStreakRef\.current \|\| farmActivityRef\.current[\s\S]*focusTarget === 'milestone'[\s\S]*farmActivityMilestoneRef\.current \|\| farmActivityRef\.current[\s\S]*focusTarget === 'streak-meter'[\s\S]*farmActivityStreakMeterRef\.current \|\| farmActivityRef\.current[\s\S]*focusTarget === 'completion'[\s\S]*farmActivityCompletionRef\.current \|\| farmActivityRef\.current[\s\S]*focusTarget === 'action'[\s\S]*farmActivityActionRef\.current \|\| farmActivityRef\.current[\s\S]*focusTarget === 'chest'[\s\S]*farmActivityChestRef\.current \|\| farmActivityRef\.current[\s\S]*: farmActivityRef\.current/);
  assert.match(panel, /const farmActivityLocatedLabel = farmActivityFocusTarget === 'streak-meter'[\s\S]*\? '已定位进度'[\s\S]*: farmActivityFocusTarget === 'completion'[\s\S]*\? '已定位完成'[\s\S]*: farmActivityFocusTarget === 'action'[\s\S]*\? '已定位建议'[\s\S]*: farmActivityFocusTarget === 'chest'[\s\S]*\? '已定位宝箱'[\s\S]*: farmActivityFocusTarget === 'reward-digest'[\s\S]*\? '已定位奖励'[\s\S]*: farmActivityFocusTarget === 'streak'[\s\S]*\? '已定位连击'[\s\S]*: farmActivityFocusTarget === 'milestone'[\s\S]*\? '已定位里程碑'[\s\S]*: '已定位成果'/);
  assert.match(panel, /data-farm-mini-status-item="activity-streak-meter"[\s\S]*handleOpenFarmActivity\('streak-meter'\)/);
  assert.match(panel, /data-farm-mini-status-item="activity-streak-completion"[\s\S]*handleOpenFarmActivity\('completion'\)/);
  assert.match(panel, /data-farm-mini-status-item="activity-streak-chest"[\s\S]*handleFarmActivityChestAction\(\)/);
  assert.match(panel, /data-farm-mini-activity-streak-meter-opened=\{farmActivityFocusTarget === 'streak-meter' \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-completion-opened=\{farmActivityFocusTarget === 'completion' \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-opened=\{farmActivityFocusTarget === 'chest' \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-state=\{farmActivityDigest\.rewardStreakChestState \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-progress=\{farmActivityDigest\.rewardStreakChestProgressLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claimed=\{farmActivityChestClaimed \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-cta=\{farmActivityDigest\.rewardStreakChestCtaLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-items=\{farmActivityDigest\.rewardStreakChestRewardItems\?\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-burst=\{farmActivityDigest\.rewardStreakChestBurstLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-opened-summary=\{farmActivityDigest\.rewardStreakChestOpenedSummaryLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-percent=\{farmActivityDigest\.rewardStreakChestPercent \?\? undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-meter=\{farmActivityDigest\.rewardStreakChestMeterLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-remaining=\{farmActivityDigest\.rewardStreakChestRemaining \?\? undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-remaining-label=\{farmActivityDigest\.rewardStreakChestRemainingLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-trail=\{farmActivityDigest\.rewardStreakChestTrailLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-trail-reward=\{farmActivityDigest\.rewardStreakChestTrailRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-active-stage=\{farmActivityDigest\.rewardStreakChestActiveTrailLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-active-reward=\{farmActivityDigest\.rewardStreakChestActiveRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-charge=\{farmActivityDigest\.rewardStreakChestChargeLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-charge-short=\{farmActivityDigest\.rewardStreakChestChargeShortLabel \|\| undefined\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestLabel &&[\s\S]*className="t8-farm-story-panel__mini-activity-streak-chest"[\s\S]*data-farm-mini-status-item="activity-streak-chest"[\s\S]*data-farm-mini-status-clickable="true"[\s\S]*data-farm-mini-activity-streak-chest-remaining-label=\{farmActivityDigest\.rewardStreakChestRemainingLabel \|\| undefined\}[\s\S]*title=\{farmActivityChestClaimed[\s\S]*开箱已入袋[\s\S]*farmActivityDigest\.rewardStreakChestState === 'ready'[\s\S]*aria-label=\{farmActivityChestClaimed[\s\S]*开箱已入袋[\s\S]*handleFarmActivityChestAction\(\)[\s\S]*<Package size=\{10\} \/>[\s\S]*\{farmActivityChestClaimed \? '已入袋' : farmMiniActivityStreakChestLabel\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action=\{farmActivityChestClaimed && farmActivityRewardStreakGoal \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-kind=\{farmActivityChestClaimed \? farmActivityDigest\.rewardStreakActionKind \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-route-target=\{farmActivityChestClaimed \? farmActivityRewardStreakActionRouteTarget \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-route-label=\{farmActivityChestClaimed \? farmActivityRewardStreakActionRouteLabel \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt=\{farmActivityChestClaimNextReceipt \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt-resource=\{farmActivityChestClaimNextReceipt && farmActivityRewardStreakActionResourcePreview \? farmActivityRewardStreakActionResourcePreview : undefined\}/);
  assert.match(panel, /const farmActivityRewardStreakActionResourceTargets = farmActivityRewardStreakGoal\?\.action \? farmActionResourceTargets\(farmActivityRewardStreakGoal\.action\) : \[\]/);
  assert.match(panel, /const farmActivityRewardStreakActionResourcePreview = farmActionResourcePreviewLabel\(farmActivityRewardStreakActionResourceTargets\)/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptNextLabel = farmActivityDigest\.rewardStreakChestNextRewardLabel \|\| farmActivityDigest\.rewardStreakChestNextLabel \|\| farmActivityDigest\.rewardStreakChestActiveHint \|\| ''/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptNextShortLabel = farmActivityChestClaimNextReceiptNextLabel[\s\S]*\.replace\('下一段：', '下段 '\)[\s\S]*\.replace\('下一轮：', '下轮 '\)[\s\S]*\.replace\('当前冲刺：', '冲 '\)/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptProgressTarget = farmActivityDigest\.rewardStreakMilestoneTarget \|\| farmActivityRewardStreakGoal\?\.target \|\| 0/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptProgressValue = farmActivityChestClaimNextReceiptProgressTarget[\s\S]*\? Math\.min\(farmActivityDigest\.rewardStreak \+ 1, farmActivityChestClaimNextReceiptProgressTarget\)[\s\S]*: 0/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptProgressLabel = farmActivityRewardStreakGoal \? '连击 \+1' : ''/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptProgressTitle = farmActivityChestClaimNextReceiptProgressTarget[\s\S]*\? `预计连击进度：\$\{farmActivityChestClaimNextReceiptProgressValue\}\/\$\{farmActivityChestClaimNextReceiptProgressTarget\}`[\s\S]*: ''/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptProgressState = farmActivityChestClaimNextReceiptProgressTarget && farmActivityChestClaimNextReceiptProgressValue >= farmActivityChestClaimNextReceiptProgressTarget \? 'complete' : 'next'/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptMilestoneTitle = farmActivityChestClaimNextReceiptProgressState === 'complete' \? '本次续连击将点亮里程碑' : ''/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptMilestoneLabel = farmActivityChestClaimNextReceiptMilestoneTitle \? '本次点亮' : ''/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptRewardItems = farmActivityChestClaimNextReceiptMilestoneTitle && farmActivityChestClaimNextReceiptProgressTarget >= 5[\s\S]*\? \['高光手账', '订单气氛', '美化收益'\][\s\S]*: \[\]/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptRewardLabel = farmActivityChestClaimNextReceiptMilestoneTitle[\s\S]*\? farmActivityChestClaimNextReceiptRewardItems\.length[\s\S]*\? `奖励x\$\{farmActivityChestClaimNextReceiptRewardItems\.length\}`[\s\S]*: farmActivityDigest\.rewardStreakChestActiveRewardLabel\?\.replace\('当前奖励：', '奖励 '\) \|\| farmActivityDigest\.rewardStreakChestRewardLabel\?\.replace\('预览：', '奖励 '\) \|\| ''[\s\S]*: ''/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptRewardTitle = farmActivityChestClaimNextReceiptRewardLabel[\s\S]*\? `本次点亮奖励：\$\{farmActivityChestClaimNextReceiptRewardItems\.length \? farmActivityChestClaimNextReceiptRewardItems\.join\('、'\) : farmActivityChestClaimNextReceiptRewardLabel\.replace\('奖励 ', ''\)\}`[\s\S]*: ''/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptRewardShortItems = farmActivityChestClaimNextReceiptRewardItems\.map\(\(item\) =>[\s\S]*item\.replace\('手账', ''\)\.replace\('气氛', ''\)\.replace\('收益', ''\)[\s\S]*\)/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptRewardPocketLabel = farmActivityChestClaimNextReceiptRewardShortItems\.length \? '已入袋' : ''/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptRewardPocketTitle = farmActivityChestClaimNextReceiptRewardPocketLabel[\s\S]*\? `本次点亮奖励已入袋：\$\{farmActivityChestClaimNextReceiptRewardItems\.join\('、'\)\}`[\s\S]*: ''/);
  assert.match(panel, /type FarmMiniRewardPocketTarget = 'beauty' \| 'ready-order' \| 'activity-streak-reward'/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptRewardPocketTargets = farmActivityChestClaimNextReceiptRewardItems\.reduce<Array<FarmMiniRewardPocketTarget>>\(\(targets, item\) =>[\s\S]*item\.includes\('美化'\)[\s\S]*target = 'beauty'[\s\S]*item\.includes\('订单'\)[\s\S]*target = 'ready-order'[\s\S]*item\.includes\('手账'\)[\s\S]*target = 'activity-streak-reward'[\s\S]*targets\.push\(target\)[\s\S]*\}, \[\]\)/);
  assert.match(panel, /const farmActivityChestClaimNextReceiptRewardPocketTargetsLabel = farmActivityChestClaimNextReceiptRewardPocketTargets\.length[\s\S]*\? `入袋点亮：\$\{farmActivityChestClaimNextReceiptRewardPocketTargets\.map\(\(target\) =>[\s\S]*target === 'beauty' \? '漂亮度'[\s\S]*: target === 'ready-order' \? '订单'[\s\S]*: '奖励印章'[\s\S]*\)\.join\('、'\)\}`[\s\S]*: ''/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-resource-targets=\{farmActivityChestClaimed \? farmActivityRewardStreakActionResourceTargets\.join\(' '\) \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-resource-preview=\{farmActivityChestClaimed \? farmActivityRewardStreakActionResourcePreview \|\| undefined : undefined\}/);
  assert.match(panel, /data-farm-mini-reward-pocket-targets=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTargets\.length \? farmActivityChestClaimNextReceiptRewardPocketTargets\.join\(' '\) : undefined\}/);
  assert.match(panel, /data-farm-mini-reward-pocket-targets-label=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTargetsLabel \? farmActivityChestClaimNextReceiptRewardPocketTargetsLabel : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt-next=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptNextLabel \? farmActivityChestClaimNextReceiptNextLabel : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt-progress=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptProgressTitle \? farmActivityChestClaimNextReceiptProgressTitle : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt-progress-state=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptProgressTitle \? farmActivityChestClaimNextReceiptProgressState : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt-milestone=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptMilestoneTitle \? farmActivityChestClaimNextReceiptMilestoneTitle : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardTitle \? farmActivityChestClaimNextReceiptRewardTitle : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-items=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardItems\.length \? farmActivityChestClaimNextReceiptRewardItems\.join\(' '\) : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTitle \? farmActivityChestClaimNextReceiptRewardPocketTitle : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket-targets=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTargets\.length \? farmActivityChestClaimNextReceiptRewardPocketTargets\.join\(' '\) : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket-targets-label=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTargetsLabel \? farmActivityChestClaimNextReceiptRewardPocketTargetsLabel : undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="beauty"[\s\S]*data-farm-mini-reward-pocket-target=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTargets\.includes\('beauty'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-reward-pocket-target-label=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTargets\.includes\('beauty'\) \? farmActivityChestClaimNextReceiptRewardPocketTargetsLabel : undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="activity-streak-reward"[\s\S]*data-farm-mini-reward-pocket-target=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTargets\.includes\('activity-streak-reward'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-reward-pocket-target-label=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTargets\.includes\('activity-streak-reward'\) \? farmActivityChestClaimNextReceiptRewardPocketTargetsLabel : undefined\}/);
  assert.match(panel, /data-farm-mini-status-item="ready-order"[\s\S]*data-farm-mini-reward-pocket-target=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTargets\.includes\('ready-order'\) \? 'true' : undefined\}[\s\S]*data-farm-mini-reward-pocket-target-label=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTargets\.includes\('ready-order'\) \? farmActivityChestClaimNextReceiptRewardPocketTargetsLabel : undefined\}/);
  assert.match(panel, /title=\{farmActivityChestClaimed[\s\S]*farmActivityRewardStreakGoal[\s\S]*下一轮继续：\$\{farmActivityRewardStreakGoal\.actionLabel\}\$\{farmActivityRewardStreakActionResourcePreview \? ` · \$\{farmActivityRewardStreakActionResourcePreview\}` : ''\}/);
  assert.match(panel, /aria-label=\{farmActivityChestClaimed[\s\S]*farmActivityRewardStreakGoal[\s\S]*开箱已入袋，继续今日成果连击，\$\{farmActivityRewardStreakGoal\.actionLabel\}\$\{farmActivityRewardStreakActionResourcePreview \? `，\$\{farmActivityRewardStreakActionResourcePreview\}` : ''\}/);
  assert.match(panel, /onClick=\{\(event\) => \{[\s\S]*if \(farmActivityChestClaimed && farmActivityRewardStreakGoal\) \{[\s\S]*handleFarmActivityChestClaimNextAction\(\);[\s\S]*return;[\s\S]*\}[\s\S]*handleFarmActivityChestAction\(\)/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestRemainingLabel && \([\s\S]*data-farm-mini-activity-streak-chest-remaining-label="true"[\s\S]*\{farmActivityDigest\.rewardStreakChestRemainingLabel\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestTrailItems\?\.length && \([\s\S]*data-farm-mini-activity-streak-chest-trail="true"[\s\S]*data-farm-mini-activity-streak-chest-trail-continued=\{farmActivityChestClaimNextReceipt \? 'true' : undefined\}[\s\S]*data-farm-mini-activity-streak-chest-trail-continued-label=\{farmActivityChestClaimNextReceipt \|\| undefined\}[\s\S]*data-farm-mini-activity-streak-chest-trail-followup-receipt=\{farmActivityRewardStreakActionReceiptFollowupLabel \? 'true' : undefined\}[\s\S]*data-farm-mini-activity-streak-chest-trail-followup-receipt-label=\{farmActivityRewardStreakActionReceiptFollowupLabel \|\| undefined\}[\s\S]*title=\{`\$\{farmActivityDigest\.rewardStreakChestTrailLabel\}\$\{farmActivityDigest\.rewardStreakChestTrailRewardLabel \? ` · \$\{farmActivityDigest\.rewardStreakChestTrailRewardLabel\}` : ''\}\$\{farmActivityChestClaimNextReceipt \? ` · \$\{farmActivityChestClaimNextReceipt\}` : ''\}\$\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTitle \? ` · \$\{farmActivityChestClaimNextReceiptRewardPocketTitle\}` : ''\}\$\{farmActivityRewardStreakActionReceiptFollowupLabel \? ` · \$\{farmActivityRewardStreakActionReceiptFollowupLabel\}` : ''\}`\}[\s\S]*farmActivityDigest\.rewardStreakChestTrailItems\.map\(\(item\) => \([\s\S]*data-farm-mini-activity-streak-chest-trail-item=\{item\.tier\}[\s\S]*data-farm-mini-activity-streak-chest-trail-state=\{item\.state\}[\s\S]*data-farm-mini-activity-streak-chest-trail-reward=\{item\.shortRewardLabel\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-trail-pocketed=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTitle \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-trail-pocketed-label=\{farmActivityChestClaimNextReceipt && farmActivityChestClaimNextReceiptRewardPocketTitle \? farmActivityChestClaimNextReceiptRewardPocketTitle : undefined\}/);
  assert.match(panel, /title=\{`\$\{farmActivityDigest\.rewardStreakChestTrailLabel\}[\s\S]*farmActivityChestClaimNextReceiptRewardPocketTitle[\s\S]*`\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestActiveRewardLabel && \([\s\S]*data-farm-mini-activity-streak-chest-active-reward="true"[\s\S]*\{farmActivityDigest\.rewardStreakChestActiveRewardLabel\.replace\('当前奖励：', ''\)\}/);
  assert.match(panel, /data-farm-mini-activity-streak-chest-burst="true"[\s\S]*\{farmActivityDigest\.rewardStreakChestBurstLabel\}/);
  assert.match(panel, /farmActivityChestClaimed && farmActivityRewardStreakGoal && \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-label="true"[\s\S]*\{farmMiniQuickActionBusy \? farmMiniQuickActionFeedback\?\.label \|\| '续连击中' : `续\$\{farmActivityRewardStreakGoal\.actionLabel\}`\}/);
  assert.match(panel, /farmActivityChestClaimed && farmActivityRewardStreakActionRouteLabel && \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-route="true"[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-route-target=\{farmActivityRewardStreakActionRouteTarget \|\| undefined\}[\s\S]*\{farmActivityRewardStreakActionReceiptRouteReceipt \|\| `图\$\{farmActivityRewardStreakActionRouteLabel\}`\}/);
  assert.match(panel, /farmActivityChestClaimed && farmActivityRewardStreakActionResourcePreview && \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-resource="true"[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-resource-targets=\{farmActivityRewardStreakActionResourceTargets\.join\(' '\) \|\| undefined\}[\s\S]*\{farmActivityRewardStreakActionResourcePreview\.replace\('预期：', ''\)\}/);
  assert.match(panel, /farmActivityChestClaimed && farmActivityRewardStreakActionRouteLabel && \([\s\S]*className="t8-farm-story-panel__mini-chest-route-hint"[\s\S]*data-farm-mini-status-item="activity-chest-route"[\s\S]*data-farm-mini-activity-streak-chest-route-hint="true"[\s\S]*data-farm-mini-activity-streak-chest-route-target=\{farmActivityRewardStreakActionRouteTarget \|\| undefined\}[\s\S]*data-farm-mini-activity-streak-chest-route-label=\{farmActivityRewardStreakActionRouteLabel \|\| undefined\}[\s\S]*handleFarmActivityRewardStreakRouteHintAction\(\)[\s\S]*\{farmActivityRewardStreakActionReceiptRouteReceipt \|\| `地图找\$\{farmActivityRewardStreakActionRouteLabel\}`\}/);
  assert.match(panel, /title=\{`\$\{farmActivityChestClaimNextReceipt\}\$\{farmActivityRewardStreakActionResourcePreview \? ` · \$\{farmActivityRewardStreakActionResourcePreview\}` : ''\}\$\{farmActivityChestClaimNextReceiptProgressTitle \? ` · \$\{farmActivityChestClaimNextReceiptProgressTitle\}` : ''\}\$\{farmActivityChestClaimNextReceiptMilestoneTitle \? ` · \$\{farmActivityChestClaimNextReceiptMilestoneTitle\}` : ''\}\$\{farmActivityChestClaimNextReceiptRewardTitle \? ` · \$\{farmActivityChestClaimNextReceiptRewardTitle\}` : ''\}\$\{farmActivityChestClaimNextReceiptRewardPocketTitle \? ` · \$\{farmActivityChestClaimNextReceiptRewardPocketTitle\}` : ''\}\$\{farmActivityChestClaimNextReceiptRewardPocketFollowupLabel \? ` · 收纳后下一步：\$\{farmActivityChestClaimNextReceiptRewardPocketFollowupLabel\}` : ''\}\$\{farmActivityChestClaimNextReceiptNextLabel \? ` · \$\{farmActivityChestClaimNextReceiptNextLabel\}` : ''\}`\}/);
  assert.match(panel, /farmActivityChestClaimNextReceipt && \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt="true"[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-resource=\{farmActivityRewardStreakActionResourcePreview \|\| undefined\}[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*<Sparkles size=\{9\} \/>[\s\S]*\{farmActivityChestClaimNextReceipt\}[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-resource-label="true"[\s\S]*\{farmActivityRewardStreakActionResourcePreview\.replace\('预期：', ''\)\}/);
  assert.match(panel, /farmActivityChestClaimNextReceiptProgressTitle && \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-progress-label="true"[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-progress-state=\{farmActivityChestClaimNextReceiptProgressState\}[\s\S]*title=\{farmActivityChestClaimNextReceiptProgressTitle\}[\s\S]*\{farmActivityChestClaimNextReceiptProgressLabel\}/);
  assert.match(panel, /farmActivityChestClaimNextReceiptMilestoneTitle && \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-milestone-label="true"[\s\S]*title=\{farmActivityChestClaimNextReceiptMilestoneTitle\}[\s\S]*\{farmActivityChestClaimNextReceiptMilestoneLabel\}/);
  assert.match(panel, /farmActivityChestClaimNextReceiptRewardLabel && \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-label="true"[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-items=\{farmActivityChestClaimNextReceiptRewardItems\.join\(' '\) \|\| undefined\}[\s\S]*title=\{farmActivityChestClaimNextReceiptRewardTitle\}[\s\S]*\{farmActivityChestClaimNextReceiptRewardLabel\}/);
  assert.match(panel, /farmActivityChestClaimNextReceiptRewardShortItems\.length > 0 && \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-stamps="true"[\s\S]*aria-label=\{`本次点亮奖励印章：\$\{farmActivityChestClaimNextReceiptRewardItems\.join\('、'\)\}`\}[\s\S]*farmActivityChestClaimNextReceiptRewardShortItems\.map\(\(item, index\) => \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-stamp=\{farmActivityChestClaimNextReceiptRewardItems\[index\]\}[\s\S]*style=\{\{ '--farm-mini-reward-stamp-index': index \} as CSSProperties\}[\s\S]*\{item\}/);
  assert.match(panel, /farmActivityChestClaimNextReceiptRewardPocketLabel && \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket-label="true"[\s\S]*title=\{farmActivityChestClaimNextReceiptRewardPocketTitle\}[\s\S]*\{farmActivityChestClaimNextReceiptRewardPocketLabel\}/);
  assert.match(panel, /farmActivityChestClaimNextReceiptNextLabel && \([\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-next-label="true"[\s\S]*title=\{`续连击下一段：\$\{farmActivityChestClaimNextReceiptNextLabel\}`\}[\s\S]*\{farmActivityChestClaimNextReceiptNextShortLabel\}/);
  assert.match(panel, /data-farm-activity-reward-streak-reward=\{farmActivityDigest\.rewardStreakMilestoneRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-items=\{farmActivityDigest\.rewardStreakMilestoneRewardItems\?\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-action=\{farmActivityDigest\.rewardStreakActionKind \|\| undefined\}/);
  assert.match(panel, /ref=\{farmActivityRewardDigestRef\}[\s\S]*data-farm-activity-reward-digest-focus=\{farmActivityFocusTarget === 'reward-digest' \? 'true' : undefined\}[\s\S]*data-farm-activity-reward-digest-pulse=\{farmActivityFocusTarget === 'reward-digest' \? farmActivityDetailPulseId \|\| undefined : undefined\}[\s\S]*tabIndex=\{-1\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakLabel && \([\s\S]*<em[\s\S]*ref=\{farmActivityStreakRef\}[\s\S]*data-farm-activity-reward-streak="true"[\s\S]*data-farm-activity-reward-streak-focus=\{farmActivityFocusTarget === 'streak' \? 'true' : undefined\}[\s\S]*data-farm-activity-reward-streak-pulse=\{farmActivityFocusTarget === 'streak' \? farmActivityDetailPulseId \|\| undefined : undefined\}[\s\S]*tabIndex=\{-1\}[\s\S]*\{farmActivityDigest\.rewardStreakLabel\}[\s\S]*<\/em>[\s\S]*\)/);
  assert.match(panel, /farmActivityFocusTarget === 'reward-digest' && \([\s\S]*data-farm-activity-reward-digest-located="true"[\s\S]*已定位奖励/);
  assert.match(panel, /data-farm-activity-reward-digest-located="true"[\s\S]*<Sparkles size=\{9\}[\s\S]*已定位奖励/);
  assert.match(panel, /data-farm-activity-reward-digest-located-label="已定位奖励"/);
  assert.match(panel, /title="今日成果已定位：已定位奖励"/);
  assert.match(panel, /farmActivityFocusTarget === 'streak' && \([\s\S]*data-farm-activity-reward-streak-located="true"[\s\S]*已定位连击/);
  assert.match(panel, /data-farm-activity-reward-streak-located="true"[\s\S]*<Sparkles size=\{9\}[\s\S]*已定位连击/);
  assert.match(panel, /data-farm-activity-reward-streak-located-label="已定位连击"/);
  assert.match(panel, /title="今日成果已定位：已定位连击"/);
  assert.match(panel, /farmActivityDigest\.rewardStreakHint && \([\s\S]*<small data-farm-activity-reward-streak-hint="true">\{farmActivityDigest\.rewardStreakHint\}<\/small>[\s\S]*\)/);
  assert.match(panel, /farmActivityDigest\.rewardStreakMilestoneLabel && \([\s\S]*<small[\s\S]*ref=\{farmActivityMilestoneRef\}[\s\S]*data-farm-activity-reward-streak-milestone="true"[\s\S]*data-farm-activity-reward-streak-milestone-focus=\{farmActivityFocusTarget === 'milestone' \? 'true' : undefined\}[\s\S]*data-farm-activity-reward-streak-milestone-pulse=\{farmActivityFocusTarget === 'milestone' \? farmActivityDetailPulseId \|\| undefined : undefined\}[\s\S]*tabIndex=\{-1\}[\s\S]*\{farmActivityDigest\.rewardStreakMilestoneLabel\}[\s\S]*<\/small>[\s\S]*\)/);
  assert.match(panel, /farmActivityFocusTarget === 'milestone' && \([\s\S]*data-farm-activity-reward-streak-milestone-located="true"[\s\S]*已定位里程碑/);
  assert.match(panel, /data-farm-activity-reward-streak-milestone-located="true"[\s\S]*<Sparkles size=\{9\}[\s\S]*已定位里程碑/);
  assert.match(panel, /data-farm-activity-reward-streak-milestone-located-label="已定位里程碑"/);
  assert.match(panel, /title="今日成果已定位：已定位里程碑"/);
  assert.match(panel, /farmActivityDigest\.rewardStreakMilestonePercent !== undefined && farmActivityDigest\.rewardStreakMilestoneProgressLabel && \([\s\S]*className="t8-farm-story-panel__activity-streak-meter"[\s\S]*ref=\{farmActivityStreakMeterRef\}[\s\S]*data-farm-activity-reward-streak-meter="true"[\s\S]*data-farm-activity-reward-streak-tier=\{farmActivityDigest\.rewardStreakTier \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-complete=\{farmActivityDigest\.rewardStreakMilestonePercent === 100 \? 'true' : undefined\}[\s\S]*role="progressbar"[\s\S]*aria-valuemax=\{farmActivityDigest\.rewardStreakMilestoneTarget \|\| 1\}[\s\S]*aria-valuenow=\{Math\.min\(farmActivityDigest\.rewardStreak, farmActivityDigest\.rewardStreakMilestoneTarget \|\| farmActivityDigest\.rewardStreak\)\}[\s\S]*aria-valuetext=\{farmActivityDigest\.rewardStreakMilestoneProgressLabel\}[\s\S]*title=\{`今日连击里程碑：\$\{farmActivityDigest\.rewardStreakMilestoneProgressLabel\} · \$\{farmActivityDigest\.rewardStreakMilestoneLabel \|\| '保持正反馈'\}`\}[\s\S]*tabIndex=\{-1\}[\s\S]*width: `\$\{farmActivityDigest\.rewardStreakMilestonePercent\}%`[\s\S]*\{farmActivityDigest\.rewardStreakMilestoneProgressLabel\}[\s\S]*farmActivityDigest\.rewardStreakMilestonePercent === 100 && \([\s\S]*<strong data-farm-activity-reward-streak-complete="true">已点亮<\/strong>/);
  assert.match(panel, /data-farm-activity-reward-streak-meter-focus=\{farmActivityFocusTarget === 'streak-meter' \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-meter-pulse=\{farmActivityFocusTarget === 'streak-meter' \? farmActivityDetailPulseId \|\| undefined : undefined\}/);
  assert.match(panel, /farmActivityFocusTarget === 'streak-meter' && \([\s\S]*<em[\s\S]*key=\{farmActivityDetailPulseId \|\| 'reward-streak-meter-located'\}[\s\S]*data-farm-activity-reward-streak-meter-located="true"[\s\S]*data-farm-activity-reward-streak-meter-located-pulse=\{farmActivityFocusTarget === 'streak-meter' \? farmActivityDetailPulseId \|\| undefined : undefined\}[\s\S]*<Sparkles size=\{9\} \/>[\s\S]*已定位进度[\s\S]*<\/em>/);
  assert.match(panel, /data-farm-activity-reward-streak-meter-located-label="已定位进度"/);
  assert.match(panel, /title="今日成果已定位：已定位进度"/);
  assert.match(panel, /farmActivityDigest\.rewardStreakMilestoneCompletionLabel && \([\s\S]*<small[\s\S]*ref=\{farmActivityCompletionRef\}[\s\S]*data-farm-activity-reward-streak-completion="true"[\s\S]*data-farm-activity-reward-streak-completion-focus=\{farmActivityFocusTarget === 'completion' \? 'true' : undefined\}[\s\S]*data-farm-activity-reward-streak-completion-pulse=\{farmActivityFocusTarget === 'completion' \? farmActivityDetailPulseId \|\| undefined : undefined\}[\s\S]*tabIndex=\{-1\}[\s\S]*\{farmActivityDigest\.rewardStreakMilestoneCompletionLabel\}[\s\S]*<\/small>[\s\S]*\)/);
  assert.match(panel, /farmActivityFocusTarget === 'completion' && \([\s\S]*<em[\s\S]*key=\{farmActivityDetailPulseId \|\| 'reward-streak-completion-located'\}[\s\S]*data-farm-activity-reward-streak-completion-located="true"[\s\S]*data-farm-activity-reward-streak-completion-located-pulse=\{farmActivityFocusTarget === 'completion' \? farmActivityDetailPulseId \|\| undefined : undefined\}[\s\S]*<Sparkles size=\{9\} \/>[\s\S]*已定位完成[\s\S]*<\/em>/);
  assert.match(panel, /data-farm-activity-reward-streak-completion-located-label="已定位完成"/);
  assert.match(panel, /title="今日成果已定位：已定位完成"/);
  assert.match(panel, /farmActivityDetailOpened && \([\s\S]*className="t8-farm-story-panel__activity-located"[\s\S]*key=\{farmActivityDetailPulseId \|\| 'activity-located'\}[\s\S]*data-farm-activity-located-feedback="true"[\s\S]*data-farm-activity-located-target=\{farmActivityFocusTarget \|\| 'section'\}[\s\S]*data-farm-activity-located-label=\{farmActivityLocatedLabel\}[\s\S]*data-farm-activity-located-pulse=\{farmActivityDetailPulseId \|\| undefined\}[\s\S]*title=\{`最近农活已定位：\$\{farmActivityLocatedLabel\}`\}[\s\S]*<Sparkles size=\{9\} \/>[\s\S]*\{farmActivityLocatedLabel\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestLabel && \([\s\S]*className="t8-farm-story-panel__activity-streak-chest"[\s\S]*ref=\{farmActivityChestRef\}[\s\S]*data-farm-activity-reward-streak-chest="true"[\s\S]*data-farm-activity-reward-streak-chest-state=\{farmActivityDigest\.rewardStreakChestState \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-tier=\{farmActivityDigest\.rewardStreakChestTier \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-progress=\{farmActivityDigest\.rewardStreakChestProgressLabel \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-reward=\{farmActivityDigest\.rewardStreakChestRewardLabel \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-claim=\{farmActivityDigest\.rewardStreakChestClaimLabel \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-next=\{farmActivityDigest\.rewardStreakChestNextLabel \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-remaining=\{farmActivityDigest\.rewardStreakChestRemaining \?\? undefined\}[\s\S]*data-farm-activity-reward-streak-chest-remaining-label=\{farmActivityDigest\.rewardStreakChestRemainingLabel \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-charge-receipt=\{farmActivityChestChargeReceipt \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-claimed=\{farmActivityChestClaimed \? 'true' : undefined\}[\s\S]*data-farm-activity-reward-streak-chest-focus=\{farmActivityFocusTarget === 'chest' \? 'true' : undefined\}[\s\S]*tabIndex=\{-1\}[\s\S]*\{farmActivityDigest\.rewardStreakChestLabel\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-trail=\{farmActivityDigest\.rewardStreakChestTrailLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-trail-reward=\{farmActivityDigest\.rewardStreakChestTrailRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-active-stage=\{farmActivityDigest\.rewardStreakChestActiveTrailLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-active-reward=\{farmActivityDigest\.rewardStreakChestActiveRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-active-hint=\{farmActivityDigest\.rewardStreakChestActiveHint \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-next-reward=\{farmActivityDigest\.rewardStreakChestNextRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-chest-located="true"[\s\S]*已定位宝箱/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestState === 'ready' && \([\s\S]*data-farm-activity-reward-streak-chest-cta="true"[\s\S]*onClick=\{\(event\) => \{[\s\S]*handleFarmActivityChestAction\(\);[\s\S]*\}\}[\s\S]*\{farmActivityChestClaimed \? '已入袋' : farmActivityDigest\.rewardStreakChestCtaLabel \|\| '开宝箱'\}/);
  assert.match(panel, /farmActivityChestClaimed && farmActivityDigest\.rewardStreakChestClaimLabel && \([\s\S]*data-farm-activity-reward-streak-chest-claim-receipt="true"[\s\S]*\{farmActivityDigest\.rewardStreakChestClaimLabel\}/);
  assert.match(panel, /farmActivityChestClaimed && farmActivityDigest\.rewardStreakChestRewardItems\?\.length && \([\s\S]*data-farm-activity-reward-streak-chest-reward-items="true"[\s\S]*farmActivityDigest\.rewardStreakChestRewardItems\.map\(\(item\) => \([\s\S]*data-farm-activity-reward-streak-chest-reward-item=\{item\}/);
  assert.match(panel, /farmActivityChestClaimed && farmActivityRewardStreakGoal && \([\s\S]*data-farm-activity-reward-streak-chest-claim-next-action="true"[\s\S]*data-farm-activity-reward-streak-chest-claim-next-action-kind=\{farmActivityDigest\.rewardStreakActionKind \|\| undefined\}[\s\S]*disabled=\{farmMiniQuickActionBusy\}[\s\S]*handleFarmActivityRewardStreakAction\(\)[\s\S]*\{farmMiniQuickActionBusy \? farmMiniQuickActionFeedback\?\.label \|\| '继续中' : `下一轮继续\$\{farmActivityRewardStreakGoal\.actionLabel\}`\}/);
  assert.match(panel, /farmActivityChestClaimed && farmActivityRewardStreakActionRouteLabel && \([\s\S]*data-farm-activity-reward-streak-chest-route-hint="true"[\s\S]*data-farm-activity-reward-streak-chest-route-target=\{farmActivityRewardStreakActionRouteTarget \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-route-label=\{farmActivityRewardStreakActionRouteLabel \|\| undefined\}[\s\S]*handleFarmActivityRewardStreakRouteHintAction\(\)[\s\S]*\{farmActivityRewardStreakActionReceiptRouteReceipt \|\| `地图找\$\{farmActivityRewardStreakActionRouteLabel\}`\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestPercent !== undefined && farmActivityDigest\.rewardStreakChestProgressLabel && \([\s\S]*className="t8-farm-story-panel__activity-streak-chest-meter"[\s\S]*data-farm-activity-reward-streak-chest-meter="true"[\s\S]*role="progressbar"[\s\S]*aria-valuenow=\{farmActivityDigest\.rewardStreakChestPercent\}[\s\S]*width: `\$\{farmActivityDigest\.rewardStreakChestPercent\}%`[\s\S]*\{farmActivityDigest\.rewardStreakChestProgressLabel\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestRemainingLabel && \([\s\S]*data-farm-activity-reward-streak-chest-remaining-label="true"[\s\S]*data-farm-activity-reward-streak-chest-remaining=\{farmActivityDigest\.rewardStreakChestRemaining \?\? undefined\}[\s\S]*\{farmActivityDigest\.rewardStreakChestRemainingLabel\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestTrailItems\?\.length && \([\s\S]*className="t8-farm-story-panel__activity-streak-chest-trail"[\s\S]*data-farm-activity-reward-streak-chest-trail="true"[\s\S]*data-farm-activity-reward-streak-chest-trail-reward=\{farmActivityDigest\.rewardStreakChestTrailRewardLabel \|\| undefined\}[\s\S]*role="list"[\s\S]*farmActivityDigest\.rewardStreakChestTrailItems\.map\(\(item\) => \([\s\S]*data-farm-activity-reward-streak-chest-trail-item=\{item\.tier\}[\s\S]*data-farm-activity-reward-streak-chest-trail-state=\{item\.state\}[\s\S]*data-farm-activity-reward-streak-chest-trail-reward=\{item\.shortRewardLabel\}[\s\S]*\{item\.label\}[\s\S]*\{item\.progressLabel\}[\s\S]*data-farm-activity-reward-streak-chest-trail-reward-label="true"[\s\S]*\{item\.shortRewardLabel\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestActiveHint && \([\s\S]*className="t8-farm-story-panel__activity-streak-chest-active"[\s\S]*data-farm-activity-reward-streak-chest-active="true"[\s\S]*data-farm-activity-reward-streak-chest-active-stage=\{farmActivityDigest\.rewardStreakChestActiveTrailLabel \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-active-reward=\{farmActivityDigest\.rewardStreakChestActiveRewardLabel \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-next-reward=\{farmActivityDigest\.rewardStreakChestNextRewardLabel \|\| undefined\}[\s\S]*\{farmActivityDigest\.rewardStreakChestActiveHint\}/);
  assert.match(farmPanelActivityChestChargeAction, /const handleFarmActivityChestChargeAction = \(\) => \{/);
  assert.match(farmPanelActivityChestChargeAction, /if \(!farmActivityRewardStreakGoal \|\| farmMiniQuickActionBusy\) \{/);
  assert.match(farmPanelActivityChestChargeAction, /handleOpenFarmActivity\('chest'\);/);
  assert.match(farmPanelActivityChestChargeAction, /setFarmActivityRewardStreakActionReceipt\(`宝箱蓄能：\$\{farmActivityRewardStreakGoal\.actionLabel\}`\)/);
  assert.match(farmPanelActivityChestChargeAction, /setFarmActivityChestChargeReceipt\(`蓄能已确认：\$\{farmActivityRewardStreakGoal\.actionLabel\}`\)/);
  assert.match(farmPanelActivityChestChargeAction, /handleFarmFocusAction\(farmActivityRewardStreakGoal\);/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestState === 'warming' && farmActivityDigest\.rewardStreakChestChargeLabel && \([\s\S]*data-farm-activity-reward-streak-chest-charge-cta="true"[\s\S]*data-farm-activity-reward-streak-chest-charge-reward=\{farmActivityDigest\.rewardStreakChestActiveRewardLabel \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-charge-next=\{farmActivityDigest\.rewardStreakChestNextRewardLabel \|\| undefined\}[\s\S]*disabled=\{!farmActivityRewardStreakGoal \|\| farmMiniQuickActionBusy\}[\s\S]*handleFarmActivityChestChargeAction\(\)[\s\S]*\{farmMiniQuickActionBusy \? farmMiniQuickActionFeedback\?\.label \|\| '蓄能中' : farmActivityDigest\.rewardStreakChestChargeLabel\}[\s\S]*data-farm-activity-reward-streak-chest-charge-reward-label="true"[\s\S]*\{farmActivityDigest\.rewardStreakChestActiveRewardLabel\.replace\('当前奖励：', '冲 '\)\}/);
  assert.match(panel, /farmActivityChestChargeReceipt && \([\s\S]*data-farm-activity-reward-streak-chest-charge-receipt="true"[\s\S]*data-farm-activity-reward-streak-chest-charge-receipt-reward=\{farmActivityDigest\.rewardStreakChestActiveRewardLabel \|\| undefined\}[\s\S]*data-farm-activity-reward-streak-chest-charge-receipt-next=\{farmActivityDigest\.rewardStreakChestNextRewardLabel \|\| undefined\}[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*<Sparkles size=\{9\} \/>[\s\S]*\{farmActivityChestChargeReceipt\}[\s\S]*data-farm-activity-reward-streak-chest-charge-receipt-progress="true"[\s\S]*\{farmActivityDigest\.rewardStreakChestMeterLabel\}[\s\S]*data-farm-activity-reward-streak-chest-charge-receipt-remaining="true"[\s\S]*\{farmActivityDigest\.rewardStreakChestRemainingLabel\}[\s\S]*data-farm-activity-reward-streak-chest-charge-receipt-reward-label="true"[\s\S]*\{farmActivityDigest\.rewardStreakChestActiveRewardLabel\.replace\('当前奖励：', '冲 '\)\}[\s\S]*data-farm-activity-reward-streak-chest-charge-receipt-next-label="true"[\s\S]*\{farmActivityDigest\.rewardStreakChestNextRewardLabel\.replace\('下一段：', '下段 '\)\.replace\('下一轮：', '下轮 '\)\}/);
  assert.match(panel, /farmActivityChestChargeReceipt && farmActivityRewardStreakGoal && \([\s\S]*data-farm-activity-reward-streak-chest-charge-receipt-next-action="true"[\s\S]*disabled=\{farmMiniQuickActionBusy\}[\s\S]*handleFarmActivityChestChargeAction\(\)[\s\S]*\{farmMiniQuickActionBusy \? farmMiniQuickActionFeedback\?\.label \|\| '稍后继续' : `继续\$\{farmActivityRewardStreakGoal\.actionLabel\}`\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakChestNextLabel && \([\s\S]*data-farm-activity-reward-streak-chest-next-label="true"[\s\S]*\{farmActivityDigest\.rewardStreakChestNextLabel\}/);
  assert.match(panel, /farmActivityDigest\.rewardStreakMilestoneRewardLabel && \([\s\S]*<small data-farm-activity-reward-streak-reward="true">\{farmActivityDigest\.rewardStreakMilestoneRewardLabel\}<\/small>[\s\S]*\)/);
  assert.match(panel, /farmActivityDigest\.rewardStreakMilestoneRewardItems\?\.length && \([\s\S]*className="t8-farm-story-panel__activity-streak-reward-items"[\s\S]*data-farm-activity-reward-streak-items="true"[\s\S]*farmActivityDigest\.rewardStreakMilestoneRewardItems\.map\(\(item\) => \([\s\S]*<b key=\{item\}>\{item\}<\/b>/);
  assert.match(panel, /farmActivityDigest\.rewardStreakActionLabel && \([\s\S]*<small[\s\S]*ref=\{farmActivityActionRef\}[\s\S]*data-farm-activity-reward-streak-action="true"[\s\S]*data-farm-activity-reward-streak-action-focus=\{farmActivityFocusTarget === 'action' \? 'true' : undefined\}[\s\S]*data-farm-activity-reward-streak-action-pulse=\{farmActivityFocusTarget === 'action' \? farmActivityDetailPulseId \|\| undefined : undefined\}[\s\S]*tabIndex=\{-1\}[\s\S]*\{farmActivityDigest\.rewardStreakActionLabel\}[\s\S]*<\/small>[\s\S]*\)/);
  assert.match(panel, /farmActivityRewardStreakGoal && \([\s\S]*<button[\s\S]*type="button"[\s\S]*data-farm-activity-reward-streak-action-cta="true"[\s\S]*data-farm-activity-reward-streak-action-cta-kind=\{farmActivityDigest\.rewardStreakActionKind \|\| undefined\}[\s\S]*disabled=\{farmMiniQuickActionBusy\}[\s\S]*handleFarmActivityRewardStreakAction\(\)[\s\S]*\{farmMiniQuickActionBusy \? farmMiniQuickActionFeedback\?\.label \|\| '已执行建议' : farmActivityRewardStreakGoal\.actionLabel\}/);
  assert.match(panel, /farmActivityRewardStreakActionReceipt && \([\s\S]*className="t8-farm-story-panel__activity-action-receipt"[\s\S]*data-farm-activity-reward-streak-action-receipt="true"[\s\S]*data-farm-activity-reward-streak-action-receipt-kind=\{farmActivityDigest\.rewardStreakActionKind \|\| undefined\}[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*<Sparkles size=\{9\} \/>[\s\S]*建议已执行[\s\S]*<b>\{farmActivityRewardStreakActionReceipt\}<\/b>/);
  assert.match(panel, /data-farm-mini-activity-streak-action-receipt=\{farmActivityRewardStreakActionReceipt \|\| undefined\}/);
  assert.match(panel, /const \[farmActivityRewardStreakActionReceiptFollowup, setFarmActivityRewardStreakActionReceiptFollowup\] = useState\(''\)/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptFollowupLabel = farmActivityRewardStreakActionReceiptFollowup[\s\S]*\? farmActivityRewardStreakActionReceiptFollowup\.startsWith\('继续'\)[\s\S]*\? `已接上\$\{farmActivityRewardStreakActionReceiptFollowup\.replace\(\/\^继续\/, ''\)\}`[\s\S]*: `已接上\$\{farmActivityRewardStreakActionReceiptFollowup\}`[\s\S]*: ''/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptEchoLabel = farmActivityRewardStreakActionReceiptFollowup[\s\S]*\? farmActivityRewardStreakActionReceiptFollowup\.startsWith\('继续'\)[\s\S]*\? `刚刚接上\$\{farmActivityRewardStreakActionReceiptFollowup\.replace\(\/\^继续\/, ''\)\}`[\s\S]*: farmActivityRewardStreakActionReceiptFollowup\.startsWith\('回到'\)[\s\S]*\? `刚刚接上\$\{farmActivityRewardStreakActionReceiptFollowup\.replace\(\/\^回到\/, ''\)\}`[\s\S]*: `刚刚接上\$\{farmActivityRewardStreakActionReceiptFollowup\}`[\s\S]*: ''/);
  assert.match(panel, /const rewardPocketActionFollowup = farmActivityChestClaimNextReceiptRewardPocketFollowupLabel;[\s\S]*setFarmActivityRewardStreakActionReceiptFollowup\(rewardPocketActionFollowup\);[\s\S]*setFarmActivityRewardStreakActionReceiptFollowup\(''\)/);
  assert.match(panel, /data-farm-mini-activity-followup-receipt=\{farmActivityRewardStreakActionReceiptEchoLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-followup-resource-targets=\{farmActivityRewardStreakActionReceiptEchoLabel && farmActivityRewardStreakActionResourceTargets\.length \? farmActivityRewardStreakActionResourceTargets\.join\(' '\) : undefined\}/);
  assert.match(panel, /data-farm-mini-followup-resource-preview=\{farmActivityRewardStreakActionReceiptEchoLabel && farmActivityRewardStreakActionResourcePreview \? farmActivityRewardStreakActionResourcePreview : undefined\}/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptNextHint = farmActivityRewardStreakGoal\?\.action \? farmFocusActionNextHint\(farmActivityRewardStreakGoal\.action\) : ''/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptNextTarget = farmActivityRewardStreakGoal\?\.action \? farmFocusActionNextTarget\(farmActivityRewardStreakGoal\.action\) : undefined/);
  assert.match(panel, /const farmActivityRewardStreakActionRouteTarget = farmActivityRewardStreakActionReceiptRouteTarget/);
  assert.match(panel, /const farmActivityRewardStreakActionRouteLabel = farmActivityRewardStreakActionReceiptRouteLabel/);
  assert.match(panel, /const handleFarmActivityRewardStreakRouteHintAction = \(\) => \{[\s\S]*if \(!farmActivityRewardStreakActionRouteTarget \|\| !farmActivityRewardStreakActionRouteLabel\) return[\s\S]*flashFarmActivityRewardStreakRouteHint\('已指路'\)[\s\S]*routeTarget: farmActivityRewardStreakActionRouteTarget[\s\S]*routeLabel: farmActivityRewardStreakActionRouteLabel[\s\S]*routeTitle: farmActivityRewardStreakActionReceiptNextTitle/);
  assert.match(panel, /interface FarmStoryPanelCanvasHint \{[\s\S]*message: string;[\s\S]*tone: FarmCanvasFloatingFeedback\['tone'\];[\s\S]*\}/);
  assert.match(panel, /onFollowupCanvasHint\?: \(hint: FarmStoryPanelCanvasHint\) => void/);
  assert.match(panel, /function farmFocusActionCanvasTone\(target: FarmFocusActionNextTarget \| undefined\): FarmCanvasFloatingFeedback\['tone'\] \{[\s\S]*if \(target === 'water'\) return 'water';[\s\S]*if \(target === 'harvest' \|\| target === 'reward' \|\| target === 'social'\) return 'reward';[\s\S]*if \(target === 'build' \|\| target === 'scarecrow' \|\| target === 'decor'\) return 'build';[\s\S]*if \(target === 'cleanup'\) return 'warning';[\s\S]*return 'success';[\s\S]*\}/);
  assert.match(panel, /const farmFollowupCanvasHintKeyRef = useRef\(''\)/);
  assert.match(panel, /const farmPlacementReceiptCanvasHintKeyRef = useRef\(''\)/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptNextBadgeLabel = farmActivityRewardStreakGoal\?\.action \? farmFocusActionNextBadgeLabel\(farmActivityRewardStreakGoal\.action\) : ''/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptNextCountLabel = farmActivityRewardStreakGoal\?\.action[\s\S]*\? farmFocusActionNextCountLabel\(farmActivityRewardStreakGoal\.action, \{[\s\S]*dryCount,[\s\S]*witheredCount,[\s\S]*matureCount,[\s\S]*scarecrowRiskCount,[\s\S]*readyOrderCount,[\s\S]*readyNpcVisitCount,[\s\S]*\}\)[\s\S]*: ''/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptCanvasHint = farmActivityRewardStreakActionReceiptEchoLabel && farmActivityRewardStreakActionReceiptNextHint[\s\S]*\? `\$\{farmActivityRewardStreakActionReceiptEchoLabel\} · \$\{farmActivityRewardStreakActionReceiptNextHint\.replace\('下一步：', ''\)\}\$\{farmActivityRewardStreakActionReceiptNextCountLabel \? ` · \$\{farmActivityRewardStreakActionReceiptNextCountLabel\}` : ''\}`[\s\S]*: ''/);
  assert.match(panel, /const farmActivityRewardStreakActionReceiptCanvasTone = farmFocusActionCanvasTone\(farmActivityRewardStreakActionReceiptNextTarget\)/);
  assert.match(farmPanelActivityFollowupEffect, /useEffect\(\(\) => \{[\s\S]*if \(!farmActivityRewardStreakActionReceiptCanvasHint \|\| !onFollowupCanvasHint\) \{[\s\S]*farmFollowupCanvasHintKeyRef\.current = '';[\s\S]*return;[\s\S]*\}[\s\S]*const canvasHintKey = `\$\{farmActivityRewardStreakActionReceiptCanvasHint\}\|\$\{farmActivityRewardStreakActionResourcePreview\}`;[\s\S]*if \(farmFollowupCanvasHintKeyRef\.current === canvasHintKey\) return;[\s\S]*farmFollowupCanvasHintKeyRef\.current = canvasHintKey;[\s\S]*onFollowupCanvasHint\(\{[\s\S]*message: farmActivityRewardStreakActionReceiptCanvasHint,[\s\S]*tone: farmActivityRewardStreakActionReceiptCanvasTone,[\s\S]*\}\);[\s\S]*\}, \[[\s\S]*farmActivityRewardStreakActionReceiptCanvasHint,[\s\S]*farmActivityRewardStreakActionReceiptCanvasTone,[\s\S]*farmActivityRewardStreakActionResourcePreview,[\s\S]*onFollowupCanvasHint,[\s\S]*\]\)/);
  assert.match(farmPanelPlacementReceiptEffect, /useEffect\(\(\) => \{[\s\S]*if \(!farmPlacementHudReceiptNextTargetOpenedCanvasHint \|\| !onFollowupCanvasHint\) \{[\s\S]*farmPlacementReceiptCanvasHintKeyRef\.current = '';[\s\S]*return;[\s\S]*\}[\s\S]*const canvasHintKey = `\$\{farmPlacementHudReceiptKind\}:\$\{farmPlacementHudReceiptSource\}:\$\{farmPlacementHudReceiptNextTarget\}:\$\{farmPlacementHudReceiptNextTargetOpenedCanvasHint\}`;[\s\S]*if \(farmPlacementReceiptCanvasHintKeyRef\.current === canvasHintKey\) return;[\s\S]*farmPlacementReceiptCanvasHintKeyRef\.current = canvasHintKey;[\s\S]*onFollowupCanvasHint\(\{[\s\S]*message: farmPlacementHudReceiptNextTargetOpenedCanvasHint,[\s\S]*tone: farmPlacementHudReceiptNextTargetOpenedCanvasTone,[\s\S]*\}\);[\s\S]*\}, \[[\s\S]*farmPlacementHudReceiptNextTargetOpenedCanvasHint,[\s\S]*farmPlacementHudReceiptNextTargetOpenedCanvasTone,[\s\S]*onFollowupCanvasHint,[\s\S]*\]\)/);
  assert.match(panel, /farmActivityRewardStreakActionReceiptEchoLabel && farmActivityRewardStreakActionReceiptNextHint && \([\s\S]*className="t8-farm-story-panel__mini-followup-action-card"[\s\S]*data-farm-mini-status-item="followup-action-card"[\s\S]*data-farm-mini-followup-action-card="true"[\s\S]*data-farm-mini-followup-action-route-target=\{farmActivityRewardStreakActionReceiptRouteTarget \|\| undefined\}[\s\S]*data-farm-mini-followup-action-route-label=\{farmActivityRewardStreakActionReceiptRouteLabel \|\| undefined\}[\s\S]*data-farm-mini-followup-action-target=\{farmActivityRewardStreakActionReceiptNextTarget \|\| undefined\}[\s\S]*data-farm-mini-followup-action-badge=\{farmActivityRewardStreakActionReceiptNextBadgeLabel \|\| undefined\}[\s\S]*data-farm-mini-followup-action-count=\{farmActivityRewardStreakActionReceiptNextCountLabel \|\| undefined\}[\s\S]*data-farm-mini-followup-action-resource-targets=\{farmActivityRewardStreakActionResourceTargets\.join\(' '\) \|\| undefined\}[\s\S]*data-farm-mini-followup-action-resource-preview=\{farmActivityRewardStreakActionResourcePreview \|\| undefined\}[\s\S]*routeTarget: farmActivityRewardStreakActionReceiptRouteTarget[\s\S]*routeLabel: farmActivityRewardStreakActionReceiptRouteLabel[\s\S]*handleOpenFarmActivity\('action'\)[\s\S]*data-farm-mini-followup-action-route-hint="true"[\s\S]*\{farmActivityRewardStreakActionReceiptRouteReceipt \|\| '地图找目标'\}[\s\S]*\{farmActivityRewardStreakActionReceiptNextHint\.replace\('下一步：', ''\)\}/);
  assert.match(panel, /data-farm-mini-followup-action-canvas-hint=\{farmActivityRewardStreakActionReceiptCanvasHint \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-followup-action-canvas-tone=\{farmActivityRewardStreakActionReceiptCanvasTone \|\| undefined\}/);
  assert.match(farmPanelMiniFollowupActionCard, /onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*if \(farmActivityRewardStreakActionReceiptCanvasHint\) \{[\s\S]*onFollowupCanvasHint\?\.\(\{[\s\S]*message: `已定位：\$\{farmActivityRewardStreakActionReceiptCanvasHint\}`,[\s\S]*tone: farmActivityRewardStreakActionReceiptCanvasTone,[\s\S]*\}\);[\s\S]*\}[\s\S]*handleOpenFarmActivity\('action'\);[\s\S]*\}\}/);
  assert.match(canvas, /const handleFarmFollowupCanvasHint = useCallback\(\(hint: FarmStoryPanelCanvasHint\) => \{/);
  assert.match(canvas, /setFarmCanvasFeedback\(hint\.message\)/);
  assert.match(farmFollowupCanvasHintHandler, /setFarmFollowupNotice\(\{[\s\S]*\.\.\.hint,[\s\S]*id: noticeId,[\s\S]*createdAt: Date\.now\(\),[\s\S]*\}\)/);
  assert.match(farmFollowupCanvasHintHandler, /window\.setTimeout\(\(\) => \{[\s\S]*setFarmFollowupNotice\(\(current\) => \(current\?\.id === noticeId \? null : current\)\)/);
  assert.match(farmFollowupCanvasHintHandler, /const center = getFarmViewportCenter\(\)/);
  assert.match(canvas, /hint\.routeTarget[\s\S]*flashFarmMiniMapRouteHint\(hint\.routeTarget, hint\.routeLabel \|\| hint\.message, center\)/);
  assert.doesNotMatch(farmFollowupCanvasHintHandler, /pushFarmFloatingFeedback/);
  assert.match(canvas, /\}, \[flashFarmMiniMapRouteHint, getFarmViewportCenter\]\)/);
  assert.match(canvas, /<FarmStoryPanel[\s\S]*onFollowupCanvasHint=\{handleFarmFollowupCanvasHint\}/);
  assert.match(canvas, /const farmTopNotice = useMemo<FarmFollowupNotice \| null>\(\(\) => \{[\s\S]*if \(!isFarmStory\) return null;[\s\S]*if \(farmFollowupNotice\) return farmFollowupNotice;[\s\S]*message: farmCanvasFeedback \|\| '点击工具后，在画布空白处开始经营。'[\s\S]*routeTitle: '当前提示'/);
  assert.match(canvas, /\{isFarmStory && farmTopNotice && \(/);
  assert.match(canvas, /data-canvas-floating-ui="farm-followup-notice"/);
  assert.match(canvas, /data-farm-followup-notice="top-quick-board"/);
  assert.match(canvas, /data-farm-followup-notice-state=\{farmFollowupNotice \? 'active' : 'idle'\}/);
  assert.match(canvas, /className=\{`t8-farm-followup-notice is-\$\{farmTopNotice\.tone\}`\}/);
  assert.match(canvas, /<span>牧场公告<\/span>/);
  assert.match(canvas, /\{farmTopNotice\.routeTitle \|\| farmTopNotice\.routeLabel \|\| '下一步提示'\}/);
  assert.match(panel, /data-farm-mini-followup-action-count="true"[\s\S]*\{farmActivityRewardStreakActionReceiptNextCountLabel\}/);
  assert.match(panel, /data-farm-mini-followup-action-resource="true"[\s\S]*\{farmActivityRewardStreakActionResourcePreview\.replace\('预期：', ''\)\}/);
  assert.match(panel, /data-farm-mini-action-live-followup-receipt="true"[\s\S]*\{farmActivityRewardStreakActionReceiptEchoLabel\}/);
  assert.match(panel, /data-farm-activity-followup-receipt=\{farmActivityRewardStreakActionReceiptEchoLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-mini-reward-pocket-followup-action-receipt=\{farmActivityRewardStreakActionReceiptFollowupLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-reward-streak-action-receipt-followup=\{farmActivityRewardStreakActionReceiptFollowupLabel \|\| undefined\}/);
  assert.match(panel, /farmActivityRewardStreakActionReceiptFollowupLabel && \([\s\S]*data-farm-activity-reward-streak-action-receipt-followup-label="true"[\s\S]*\{farmActivityRewardStreakActionReceiptFollowupLabel\}/);
  assert.match(panel, /farmActivityRewardStreakActionReceipt && \([\s\S]*data-farm-activity-reward-streak-action-receipt-next="true"[\s\S]*\{farmActivityDigest\.rewardStreakMilestoneProgressLabel \|\| farmActivityDigest\.rewardStreakMilestoneLabel \|\| '继续连击'\}/);
  assert.match(panel, /const \[farmOrderStampFeedbackId, setFarmOrderStampFeedbackId\] = useState\(''\)/);
  assert.match(panel, /const \[farmOrderLocatePulseId, setFarmOrderLocatePulseId\] = useState\(''\)/);
  assert.match(panel, /const \[farmMatureJumpPulseId, setFarmMatureJumpPulseId\] = useState\(''\)/);
  assert.match(panel, /const \[farmDryWaterPulseId, setFarmDryWaterPulseId\] = useState\(''\)/);
  assert.match(panel, /const \[farmWitheredShovelPulseId, setFarmWitheredShovelPulseId\] = useState\(''\)/);
  assert.match(panel, /const \[farmScarecrowRiskPulseId, setFarmScarecrowRiskPulseId\] = useState\(''\)/);
  assert.match(panel, /const \[farmNpcDeliveryFeedbackId, setFarmNpcDeliveryFeedbackId\] = useState\(''\)/);
  assert.match(panel, /const \[farmNpcVisitPulseId, setFarmNpcVisitPulseId\] = useState\(''\)/);
  assert.match(panel, /const \[farmBeautyDetailPulseId, setFarmBeautyDetailPulseId\] = useState\(''\)/);
  assert.match(panel, /const \[farmSeasonDetailPulseId, setFarmSeasonDetailPulseId\] = useState\(''\)/);
  assert.match(panel, /const farmOrderRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(panel, /const farmBeautyRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(panel, /const farmSeasonRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(panel, /const farmOrderStampTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmOrderLocatePulseTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmOrderLocateScrollFrameRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmMatureJumpTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmDryWaterTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmWitheredShovelTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmScarecrowRiskTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmNpcDeliveryTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmNpcVisitRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(panel, /const farmNpcVisitPulseTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmNpcVisitScrollFrameRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmBeautyDetailPulseTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmBeautyDetailScrollFrameRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmSeasonDetailPulseTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmSeasonDetailScrollFrameRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const flashFarmOrderStamp = useCallback\(\(orderId: string\) => \{/);
  assert.match(panel, /const flashFarmNpcDelivery = useCallback\(\(visitId: string\) => \{/);
  assert.match(panel, /setFarmOrderStampFeedbackId\(orderId\)/);
  assert.match(panel, /setFarmNpcDeliveryFeedbackId\(visitId\)/);
  assert.match(panel, /setFarmOrderStampFeedbackId\(''\)/);
  assert.match(panel, /setFarmNpcDeliveryFeedbackId\(''\)/);
  assert.match(panel, /const currentOrderRewardLabel = currentOrder \? formatFarmReward\(currentOrder\.rewards\) : ''/);
  assert.match(panel, /const farmOrderStampActive = Boolean\(currentOrder && farmOrderStampFeedbackId === currentOrder\.id\)/);
  assert.match(panel, /const farmOrderLocateOpened = Boolean\(farmOrderLocatePulseId\)/);
  assert.match(panel, /const farmMatureJumpOpened = Boolean\(farmMatureJumpPulseId\)/);
  assert.match(panel, /const farmDryWaterOpened = Boolean\(farmDryWaterPulseId\)/);
  assert.match(panel, /const farmSeedToolOpened = Boolean\(farmSeedToolPulseId\)/);
  assert.match(panel, /const farmWaterToolOpened = Boolean\(farmWaterToolPulseId\)/);
  assert.match(panel, /const farmWoodBuildOpened = Boolean\(farmWoodBuildPulseId\)/);
  assert.match(panel, /const farmStoneBuildOpened = Boolean\(farmStoneBuildPulseId\)/);
  assert.match(panel, /const farmWitheredShovelOpened = Boolean\(farmWitheredShovelPulseId\)/);
  assert.match(panel, /const farmScarecrowRiskSelected = Boolean\(farmScarecrowRiskPulseId\)/);
  assert.match(panel, /const farmNpcDeliveryActive = Boolean\(activeNpcVisit && farmNpcDeliveryFeedbackId === activeNpcVisit\.id\)/);
  assert.match(panel, /const farmNpcVisitOpened = Boolean\(farmNpcVisitPulseId\)/);
  assert.match(panel, /const farmBeautyDetailOpened = Boolean\(farmBeautyDetailPulseId\)/);
  assert.match(panel, /const farmSeasonDetailOpened = Boolean\(farmSeasonDetailPulseId\)/);
  assert.match(panel, /const festivalTaskReadyViaOrder = Boolean\([\s\S]*activeFestivalTask\.kind === 'complete-orders'[\s\S]*orderReady[\s\S]*currentOrder[\s\S]*\)/);
  assert.match(panel, /const festivalTaskNextProgress = activeFestivalTask[\s\S]*festivalTaskReadyViaOrder \? 1 : 0[\s\S]*activeFestivalTask\.target/);
  assert.match(panel, /const festivalTaskCompletesViaOrder = Boolean\([\s\S]*festivalTaskNextProgress >= activeFestivalTask\.target[\s\S]*\)/);
  assert.match(panel, /const festivalTaskCompletionLabel = festivalTaskCompletesViaOrder \? '交单后完成' : ''/);
  assert.match(panel, /const festivalTaskForecastTone = festivalTaskCompletesViaOrder \? 'complete' : festivalTaskReadyViaOrder \? 'progress' : ''/);
  assert.match(panel, /const festivalTaskForecastLabel = festivalTaskReadyViaOrder[\s\S]*`\$\{festivalTaskCompletesViaOrder \? '交付订单完成节庆' : '交付订单推进节庆'\} \$\{festivalTaskNextProgress\}\/\$\{activeFestivalTask\.target\}`/);
  assert.match(panel, /const currentOrderFestivalCompletes = Boolean\([\s\S]*festivalTaskNextProgress >= activeFestivalTask\.target[\s\S]*\)/);
  assert.match(panel, /const currentOrderFestivalLinkLabel = festivalTaskReadyViaOrder && activeFestivalTask[\s\S]*currentOrderFestivalCompletes \? `完成节庆 \$\{festivalTaskNextProgress\}\/\$\{activeFestivalTask\.target\}` : `推进节庆 \$\{festivalTaskNextProgress\}\/\$\{activeFestivalTask\.target\}`/);
  assert.match(panel, /const currentOrderFestivalRewardLabel = currentOrderFestivalCompletes \? festivalTaskRewardLabel : ''/);
  assert.match(panel, /const farmOrderStampFeedbackLabel = farmOrderStampActive \? currentOrderFestivalRewardLabel \? '节庆奖入袋' : '盖章中' : ''/);
  assert.match(panel, /const farmOrderSubmitLabel = farmOrderStampActive \? farmOrderStampFeedbackLabel : currentOrderFestivalRewardLabel \? '交单领节庆奖' : currentOrderFestivalCompletes \? '交单完成节庆' : '完成订单'/);
  assert.match(panel, /const farmOrderSubmitTitle = farmOrderStampActive[\s\S]*currentOrderFestivalRewardLabel \? `节庆奖励领取中：\$\{currentOrderFestivalRewardLabel\}` : `订单盖章中：\$\{currentOrderRewardLabel\}`[\s\S]*currentOrderFestivalRewardLabel \? `交单后领取节庆奖励：\$\{currentOrderRewardLabel\} · 节庆额外奖励：\$\{currentOrderFestivalRewardLabel\}`[\s\S]*'订单材料不足'/);
  assert.match(panel, /const farmOrderRewardTitle = `订单奖励：\$\{currentOrderRewardLabel\}\$\{currentOrderFestivalLinkLabel \? ` · \$\{currentOrderFestivalLinkLabel\}` : ''\}\$\{currentOrderFestivalRewardLabel \? ` · 节庆额外奖励：\$\{currentOrderFestivalRewardLabel\}` : ''\}\$\{farmOrderStampFeedbackLabel \? ` · 回执：\$\{farmOrderStampFeedbackLabel\}` : ''\}`/);
  assert.match(panel, /farmOrderStampTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmOrderStampTimerRef\.current\)/);
  assert.match(panel, /farmOrderLocatePulseTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmOrderLocatePulseTimerRef\.current\)/);
  assert.match(panel, /farmOrderLocateScrollFrameRef\.current !== null[\s\S]*window\.cancelAnimationFrame\(farmOrderLocateScrollFrameRef\.current\)/);
  assert.match(panel, /const handleOpenFarmOrder = \(\) => \{[\s\S]*setOpen\(true\)[\s\S]*setFarmOrderLocatePulseId\(`order-locate-\$\{Date\.now\(\)\}`\)[\s\S]*const farmOrderElement = farmOrderRef\.current[\s\S]*const orderScrollBehavior: ScrollBehavior = prefersReducedOrderMotion \? 'auto' : 'smooth'[\s\S]*farmOrderElement\?\.scrollIntoView\(\{ block: 'nearest', behavior: orderScrollBehavior \}\)[\s\S]*farmOrderElement\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /farmMatureJumpTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmMatureJumpTimerRef\.current\)/);
  assert.match(panel, /farmDryWaterTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmDryWaterTimerRef\.current\)/);
  assert.match(panel, /farmWitheredShovelTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmWitheredShovelTimerRef\.current\)/);
  assert.match(panel, /farmScarecrowRiskTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmScarecrowRiskTimerRef\.current\)/);
  assert.match(panel, /const handleFarmMiniMatureJump = \(\) => \{[\s\S]*if \(matureCount === 0\) return[\s\S]*setFarmMatureJumpPulseId\(`mature-jump-\$\{Date\.now\(\)\}`\)[\s\S]*onJumpToMature\?\.\(\)/);
  assert.match(panel, /const handleFarmMiniDryWaterAction = \(\) => \{[\s\S]*if \(dryCount === 0\) return[\s\S]*setFarmDryWaterPulseId\(`dry-water-\$\{Date\.now\(\)\}`\)[\s\S]*onSelectTool\?\.\('water'\)/);
  assert.match(panel, /const handleFarmMiniWitheredShovelAction = \(\) => \{[\s\S]*if \(witheredCount === 0\) return[\s\S]*setFarmWitheredShovelPulseId\(`withered-shovel-\$\{Date\.now\(\)\}`\)[\s\S]*onSelectTool\?\.\('shovel'\)/);
  assert.match(panel, /farmNpcDeliveryTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmNpcDeliveryTimerRef\.current\)/);
  assert.match(panel, /farmNpcVisitPulseTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmNpcVisitPulseTimerRef\.current\)/);
  assert.match(panel, /farmNpcVisitScrollFrameRef\.current !== null[\s\S]*window\.cancelAnimationFrame\(farmNpcVisitScrollFrameRef\.current\)/);
  assert.match(panel, /farmBeautyDetailPulseTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmBeautyDetailPulseTimerRef\.current\)/);
  assert.match(panel, /farmBeautyDetailScrollFrameRef\.current !== null[\s\S]*window\.cancelAnimationFrame\(farmBeautyDetailScrollFrameRef\.current\)/);
  assert.match(panel, /const handleOpenFarmBeautyDetail = \(\) => \{[\s\S]*setOpen\(true\)[\s\S]*setFarmBeautyDetailPulseId\(`beauty-detail-\$\{Date\.now\(\)\}`\)[\s\S]*const farmBeautyElement = farmBeautyRef\.current[\s\S]*const beautyScrollBehavior: ScrollBehavior = prefersReducedBeautyMotion \? 'auto' : 'smooth'[\s\S]*farmBeautyElement\?\.scrollIntoView\(\{ block: 'nearest', behavior: beautyScrollBehavior \}\)[\s\S]*farmBeautyElement\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /farmSeasonDetailPulseTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmSeasonDetailPulseTimerRef\.current\)/);
  assert.match(panel, /farmSeasonDetailScrollFrameRef\.current !== null[\s\S]*window\.cancelAnimationFrame\(farmSeasonDetailScrollFrameRef\.current\)/);
  assert.match(panel, /const handleOpenFarmSeasonDetail = \(\) => \{[\s\S]*setOpen\(true\)[\s\S]*setFarmSeasonDetailPulseId\(`season-detail-\$\{Date\.now\(\)\}`\)[\s\S]*const farmSeasonElement = farmSeasonRef\.current[\s\S]*const seasonScrollBehavior: ScrollBehavior = prefersReducedSeasonMotion \? 'auto' : 'smooth'[\s\S]*farmSeasonElement\?\.scrollIntoView\(\{ block: 'nearest', behavior: seasonScrollBehavior \}\)[\s\S]*farmSeasonElement\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /farmToolDetailPulseTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmToolDetailPulseTimerRef\.current\)/);
  assert.match(panel, /farmToolDetailScrollFrameRef\.current !== null[\s\S]*window\.cancelAnimationFrame\(farmToolDetailScrollFrameRef\.current\)/);
  assert.match(panel, /const handleOpenFarmTools = \(\) => \{[\s\S]*setOpen\(true\)[\s\S]*setFarmToolDetailPulseId\(`tool-detail-\$\{Date\.now\(\)\}`\)[\s\S]*const farmToolsElement = farmToolsRef\.current[\s\S]*const toolScrollBehavior: ScrollBehavior = prefersReducedToolMotion \? 'auto' : 'smooth'[\s\S]*farmToolsElement\?\.scrollIntoView\(\{ block: 'nearest', behavior: toolScrollBehavior \}\)[\s\S]*farmToolsElement\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /farmSummaryPulseTimerRef\.current !== null[\s\S]*window\.clearTimeout\(farmSummaryPulseTimerRef\.current\)/);
  assert.match(panel, /farmSummaryScrollFrameRef\.current !== null[\s\S]*window\.cancelAnimationFrame\(farmSummaryScrollFrameRef\.current\)/);
  assert.match(panel, /const handleOpenFarmSummary = \(\) => \{[\s\S]*setOpen\(true\)[\s\S]*setDismissedSummaryId\(''\)[\s\S]*setFarmSummaryPulseId\(`summary-detail-\$\{Date\.now\(\)\}`\)[\s\S]*const farmSummaryElement = farmSummaryRef\.current[\s\S]*const summaryScrollBehavior: ScrollBehavior = prefersReducedSummaryMotion \? 'auto' : 'smooth'[\s\S]*farmSummaryElement\?\.scrollIntoView\(\{ block: 'nearest', behavior: summaryScrollBehavior \}\)[\s\S]*farmSummaryElement\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /const handleOpenFarmNpcVisit = \(\) => \{[\s\S]*setOpen\(true\)[\s\S]*setFarmNpcVisitPulseId\(`npc-visit-\$\{Date\.now\(\)\}`\)[\s\S]*const farmNpcElement = farmNpcVisitRef\.current[\s\S]*const npcScrollBehavior: ScrollBehavior = prefersReducedNpcMotion \? 'auto' : 'smooth'[\s\S]*farmNpcElement\?\.scrollIntoView\(\{ block: 'nearest', behavior: npcScrollBehavior \}\)[\s\S]*farmNpcElement\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(panel, /今日成果/);
  assert.match(panel, /farmActivityDigest\.badgeLabel/);
  assert.match(panel, /farmActivityDigest\.headline/);
  assert.match(panel, /farmActivityDigest\.nextHint/);
  assert.match(panel, /data-farm-activity-chip=\{chip\.id\}/);
  assert.match(panel, /data-farm-activity-empty="true"/);
  assert.match(panel, /primaryFarmFocus && \([\s\S]*data-farm-activity-empty-focus="true"[\s\S]*data-farm-activity-empty-focus-kind=\{primaryFarmFocus\.kind\}[\s\S]*data-farm-activity-empty-focus-kind-label=\{farmFocusGoalKindLabel\(primaryFarmFocus\.kind\)\}[\s\S]*data-farm-activity-empty-focus-label=\{primaryFarmFocus\.title\}[\s\S]*data-farm-activity-empty-focus-status=\{primaryFarmFocusStatusLabel\}[\s\S]*data-farm-activity-empty-focus-ready=\{primaryFarmFocusReady \? 'true' : undefined\}[\s\S]*data-farm-activity-empty-focus-complete=\{primaryFarmFocusComplete \? 'true' : undefined\}[\s\S]*data-farm-activity-empty-focus-progress=\{`\$\{primaryFarmFocus\.progress\}\/\$\{primaryFarmFocus\.target\}`\}[\s\S]*title=\{`当前小目标：\$\{primaryFarmFocus\.title\} · \$\{primaryFarmFocus\.progress\}\/\$\{primaryFarmFocus\.target\} · \$\{primaryFarmFocusStatusLabel\}`\}/);
  assert.match(panel, /data-farm-activity-empty-focus-action-linked=\{farmMiniQuickActionBusy \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-activity-empty-focus-action-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}/);
  assert.match(panel, /<Flag size=\{10\} \/>[\s\S]*<span>\{primaryFarmFocus\.title\}<\/span>[\s\S]*<i data-farm-activity-empty-focus-kind-chip="true">\{farmFocusGoalKindLabel\(primaryFarmFocus\.kind\)\}<\/i>[\s\S]*<small>\{primaryFarmFocus\.progress\}\/\{primaryFarmFocus\.target\}<\/small>[\s\S]*<em data-farm-activity-empty-focus-status-chip="true">\{primaryFarmFocusStatusLabel\}<\/em>/);
  assert.match(panel, /const farmActivityEmptyForecastLabels = primaryFarmFocusForecastItems\.map\(\(item\) => item\.label\)/);
  assert.match(panel, /const farmActivityEmptyForecastBusyLabel = farmMiniQuickActionBusy[\s\S]*\? farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocusActionLabel[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastBusyMetaLabel = farmMiniQuickActionBusy[\s\S]*\? \[primaryFarmFocusActionResourcePreview, primaryFarmFocusProgressPreview\]\.filter\(Boolean\)\.join\(' · '\)[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastBusyMetaStateLabel = farmActivityEmptyForecastBusyMetaLabel && farmActivityEmptyForecastReceiptProgressStateLabel[\s\S]*\? farmActivityEmptyForecastReceiptProgressStateLabel[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastBusyMetaAccessibleLabel = \[farmActivityEmptyForecastBusyMetaStateLabel, farmActivityEmptyForecastBusyMetaLabel\]\.filter\(Boolean\)\.join\(' · '\)/);
  assert.match(panel, /const farmActivityEmptyForecastBusyMetaAriaLabel = \[farmActivityEmptyForecastBusyMetaStateLabel, farmActivityEmptyForecastBusyMetaLabel\]\.filter\(Boolean\)\.join\('，'\)/);
  assert.match(panel, /const farmActivityEmptyForecastBusyMetaTitleSuffix = farmActivityEmptyForecastBusyMetaAccessibleLabel \? ` · \$\{farmActivityEmptyForecastBusyMetaAccessibleLabel\}` : ''/);
  assert.match(panel, /const farmActivityEmptyForecastBusyMetaAriaSuffix = farmActivityEmptyForecastBusyMetaAriaLabel \? `，\$\{farmActivityEmptyForecastBusyMetaAriaLabel\}` : ''/);
  assert.match(panel, /const farmActivityEmptyForecastActionProgressTitleSuffix = primaryFarmFocusProgressPreview[\s\S]*\? farmActivityEmptyForecastReceiptProgressStateLabel[\s\S]*\? ` · \$\{farmActivityEmptyForecastReceiptProgressStateLabel\} \$\{primaryFarmFocusProgressPreview\}`[\s\S]*: ` · \$\{primaryFarmFocusProgressPreview\}`[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastActionProgressAriaSuffix = primaryFarmFocusProgressPreview[\s\S]*\? farmActivityEmptyForecastReceiptProgressStateLabel[\s\S]*\? `，\$\{farmActivityEmptyForecastReceiptProgressStateLabel\}\$\{primaryFarmFocusProgressPreview\}`[\s\S]*: `，\$\{primaryFarmFocusProgressPreview\}`[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastActionProgressValueTitle = primaryFarmFocusProgressPreview[\s\S]*\? farmActivityEmptyForecastReceiptProgressStateLabel[\s\S]*\? `进度 \$\{farmActivityEmptyForecastReceiptProgressStateLabel\} \$\{primaryFarmFocusProgressPreview\}`[\s\S]*: `进度 \$\{primaryFarmFocusProgressPreview\}`[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastTitle = farmActivityEmptyForecastBusyLabel[\s\S]*\? `空状态小目标预期正在执行：\$\{farmActivityEmptyForecastBusyLabel\}\$\{farmActivityEmptyForecastBusyMetaTitleSuffix\} · \$\{farmActivityEmptyForecastText\}`[\s\S]*: `空状态小目标预期：\$\{farmActivityEmptyForecastText\}`/);
  assert.match(panel, /const farmActivityEmptyForecastAriaLabel = farmActivityEmptyForecastBusyLabel[\s\S]*\? `空状态小目标预期正在执行：\$\{farmActivityEmptyForecastBusyLabel\}\$\{farmActivityEmptyForecastBusyMetaAriaSuffix\}，\$\{farmActivityEmptyForecastAccessibleText\}`[\s\S]*: `空状态小目标预期：\$\{farmActivityEmptyForecastAccessibleText\}`/);
  assert.match(panel, /primaryFarmFocus && primaryFarmFocusForecastItems\.length > 0 && \([\s\S]*className="t8-farm-story-panel__activity-empty-forecast"[\s\S]*data-farm-activity-empty-forecast="true"[\s\S]*data-farm-activity-empty-forecast-count=\{primaryFarmFocusForecastItems\.length\}[\s\S]*data-farm-activity-empty-forecast-linked=\{farmMiniQuickActionBusy \? 'true' : undefined\}[\s\S]*data-farm-activity-empty-forecast-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}[\s\S]*data-farm-activity-empty-forecast-busy-label=\{farmActivityEmptyForecastBusyLabel \|\| undefined\}[\s\S]*data-farm-activity-empty-forecast-busy-meta=\{farmActivityEmptyForecastBusyMetaLabel \|\| undefined\}[\s\S]*data-farm-activity-empty-forecast-busy-progress-state=\{farmActivityEmptyForecastBusyMetaLabel \? farmActivityEmptyForecastReceiptProgressState : undefined\}[\s\S]*title=\{farmActivityEmptyForecastTitle\}[\s\S]*aria-label=\{farmActivityEmptyForecastAriaLabel\}[\s\S]*primaryFarmFocusForecastItems\.map\(\(item\) => \([\s\S]*data-farm-activity-empty-forecast-item=\{item\.id\}[\s\S]*data-farm-activity-empty-forecast-tone=\{item\.tone\}[\s\S]*\{item\.label\}/);
  assert.match(panel, /data-farm-activity-empty-forecast-busy-label=\{farmActivityEmptyForecastBusyLabel \|\| undefined\}[\s\S]*data-farm-activity-empty-forecast-busy-meta=\{farmActivityEmptyForecastBusyMetaLabel \|\| undefined\}[\s\S]*data-farm-activity-empty-forecast-busy-progress-state=\{farmActivityEmptyForecastBusyMetaLabel \? farmActivityEmptyForecastReceiptProgressState : undefined\}[\s\S]*title=\{farmActivityEmptyForecastTitle\}[\s\S]*aria-label=\{farmActivityEmptyForecastAriaLabel\}/);
  assert.match(panel, /data-farm-activity-empty-forecast-busy-progress-label=\{farmActivityEmptyForecastBusyMetaLabel \? farmActivityEmptyForecastReceiptProgressStateLabel \|\| undefined : undefined\}/);
  assert.match(panel, /primaryFarmFocusForecastItems\.map\(\(item\) => \([\s\S]*item\.actionable \? \([\s\S]*<button[\s\S]*key=\{item\.id\}[\s\S]*data-farm-activity-empty-forecast-item=\{item\.id\}[\s\S]*data-farm-activity-empty-forecast-tone=\{item\.tone\}[\s\S]*data-farm-activity-empty-forecast-actionable="true"[\s\S]*data-farm-activity-empty-forecast-busy=\{farmMiniQuickActionBusy \? 'true' : undefined\}[\s\S]*data-farm-activity-empty-forecast-busy-label=\{farmMiniQuickActionBusy \? farmMiniQuickActionFeedback\?\.label \|\| item\.label : undefined\}[\s\S]*disabled=\{farmMiniQuickActionBusy\}[\s\S]*aria-label=\{farmMiniQuickActionBusy[\s\S]*\? `正在执行最近农活预期动作：\$\{farmMiniQuickActionFeedback\?\.label \|\| item\.label\}\$\{farmActivityEmptyForecastActionProgressAriaSuffix\}`[\s\S]*: `执行最近农活预期动作：\$\{item\.label\}\$\{farmActivityEmptyForecastActionProgressAriaSuffix\}`[\s\S]*\}[\s\S]*title=\{farmMiniQuickActionBusy[\s\S]*\? `正在执行：\$\{farmMiniQuickActionFeedback\?\.label \|\| item\.label\}\$\{farmActivityEmptyForecastActionProgressTitleSuffix\}`[\s\S]*: `\$\{item\.label\}\$\{farmActivityEmptyForecastActionProgressTitleSuffix\}`[\s\S]*\}[\s\S]*handleFarmFocusAction\(primaryFarmFocus\)/);
  assert.match(panel, /data-farm-activity-empty-forecast-action-progress-state=\{primaryFarmFocusProgressPreview \? farmActivityEmptyForecastReceiptProgressState : undefined\}/);
  assert.match(panel, /data-farm-activity-empty-forecast-action-progress-label=\{primaryFarmFocusProgressPreview \? farmActivityEmptyForecastReceiptProgressStateLabel \|\| undefined : undefined\}/);
  assert.match(panel, /primaryFarmFocusProgressPreview && \([\s\S]*data-farm-activity-empty-forecast-action-progress-value="true"[\s\S]*data-farm-activity-empty-forecast-action-progress-value-label=\{farmActivityEmptyForecastReceiptProgressStateLabel \|\| undefined\}[\s\S]*data-farm-activity-empty-forecast-action-progress-value-title=\{farmActivityEmptyForecastActionProgressValueTitle \|\| undefined\}[\s\S]*title=\{farmActivityEmptyForecastActionProgressValueTitle\}[\s\S]*\{primaryFarmFocusProgressPreview\}/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptProgressState = primaryFarmFocusComplete[\s\S]*\? 'complete'[\s\S]*: primaryFarmFocusReady[\s\S]*\? 'ready'[\s\S]*: primaryFarmFocusProgressPreview[\s\S]*\? 'next'[\s\S]*: undefined/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptProgressStateLabel = farmActivityEmptyForecastReceiptProgressState === 'complete'[\s\S]*\? '完成'[\s\S]*: farmActivityEmptyForecastReceiptProgressState === 'ready'[\s\S]*\? '可做'[\s\S]*: farmActivityEmptyForecastReceiptProgressState === 'next'[\s\S]*\? '预计'[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextHint = primaryFarmFocus\?\.action[\s\S]*\? farmFocusActionNextHint\(primaryFarmFocus\.action\)[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextTarget = primaryFarmFocus\?\.action[\s\S]*\? farmFocusActionNextTarget\(primaryFarmFocus\.action\)[\s\S]*: undefined/);
  assert.match(panel, /function farmFocusActionNextTargetLabel\(target: FarmFocusActionNextTarget \| undefined\) \{[\s\S]*case 'water':[\s\S]*return '浇水'[\s\S]*case 'cleanup':[\s\S]*return '清理'[\s\S]*case 'scarecrow':[\s\S]*return '守护'[\s\S]*case 'reward':[\s\S]*return '奖励'[\s\S]*case 'social':[\s\S]*return '来访'/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextTargetLabel = farmFocusActionNextTargetLabel\(farmActivityEmptyForecastReceiptNextTarget\)/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextBadgeLabel = primaryFarmFocus\?\.action[\s\S]*\? farmFocusActionNextBadgeLabel\(primaryFarmFocus\.action\)[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextBadgeTitle = farmActivityEmptyForecastReceiptNextBadgeLabel[\s\S]*\? `行动 \$\{farmActivityEmptyForecastReceiptNextBadgeLabel\}`[\s\S]*: ''/);
  assert.match(panel, /function farmFocusActionNextCountLabel\(action: FarmFocusGoalAction \| undefined, counts: FarmSummaryActionReceiptNextCounts\): string \{[\s\S]*if \(!action\) return ''[\s\S]*action\.tool === 'water'[\s\S]*`\$\{counts\.dryCount\}块`[\s\S]*action\.tool === 'shovel'[\s\S]*`\$\{counts\.witheredCount\}块`[\s\S]*action\.tool === 'harvest'[\s\S]*`\$\{counts\.matureCount\}个`[\s\S]*action\.kind === 'jump-mature'[\s\S]*`\$\{counts\.matureCount\}个`[\s\S]*action\.buildingId === 'scarecrow'[\s\S]*`\$\{counts\.scarecrowRiskCount\}处`[\s\S]*action\.kind === 'complete-order'[\s\S]*`\$\{counts\.readyOrderCount\}单`[\s\S]*action\.kind === 'complete-npc'[\s\S]*`\$\{counts\.readyNpcVisitCount\}访`/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextCountLabel = primaryFarmFocus\?\.action[\s\S]*\? farmFocusActionNextCountLabel\(primaryFarmFocus\.action, \{[\s\S]*dryCount,[\s\S]*witheredCount,[\s\S]*matureCount,[\s\S]*scarecrowRiskCount,[\s\S]*readyOrderCount,[\s\S]*readyNpcVisitCount,[\s\S]*\}\)[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextCountTitle = farmActivityEmptyForecastReceiptNextCountLabel[\s\S]*\? `目标 \$\{farmActivityEmptyForecastReceiptNextCountLabel\}`[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextAccessibleTypeLabel = farmActivityEmptyForecastReceiptNextTargetLabel[\s\S]*\? `类型 \$\{farmActivityEmptyForecastReceiptNextTargetLabel\}`[\s\S]*: ''/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextAccessibleHint = \[[\s\S]*farmActivityEmptyForecastReceiptNextAccessibleTypeLabel,[\s\S]*farmActivityEmptyForecastReceiptNextHint,[\s\S]*farmActivityEmptyForecastReceiptNextCountLabel \? `目标 \$\{farmActivityEmptyForecastReceiptNextCountLabel\}` : '',[\s\S]*\]\.filter\(Boolean\)\.join\('，'\)/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextTypeTitle = \[[\s\S]*farmActivityEmptyForecastReceiptNextAccessibleTypeLabel,[\s\S]*farmActivityEmptyForecastReceiptNextHint \? `下一步 \$\{farmActivityEmptyForecastReceiptNextHint\}` : '',[\s\S]*farmActivityEmptyForecastReceiptNextCountLabel \? `目标 \$\{farmActivityEmptyForecastReceiptNextCountLabel\}` : '',[\s\S]*\]\.filter\(Boolean\)\.join\(' · '\)/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextTypeCountTitle = \[[\s\S]*farmActivityEmptyForecastReceiptNextCountTitle,[\s\S]*farmActivityEmptyForecastReceiptNextAccessibleTypeLabel,[\s\S]*farmActivityEmptyForecastReceiptNextHint \? `下一步 \$\{farmActivityEmptyForecastReceiptNextHint\}` : '',[\s\S]*\]\.filter\(Boolean\)\.join\(' · '\)/);
  assert.match(panel, /farmActivityEmptyForecastReceiptNextAccessibleTypeLabel && \([\s\S]*data-farm-activity-empty-forecast-receipt-chip="next-type"[\s\S]*data-farm-activity-empty-forecast-receipt-next-type-target=\{farmActivityEmptyForecastReceiptNextTarget\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-type-label=\{farmActivityEmptyForecastReceiptNextTargetLabel \|\| undefined\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-type-title=\{farmActivityEmptyForecastReceiptNextTypeTitle \|\| undefined\}[\s\S]*title=\{farmActivityEmptyForecastReceiptNextTypeTitle\}[\s\S]*\{farmActivityEmptyForecastReceiptNextAccessibleTypeLabel\}/);
  assert.match(panel, /farmActivityEmptyForecastReceiptNextCountLabel && \([\s\S]*data-farm-activity-empty-forecast-receipt-next-type-count="true"[\s\S]*data-farm-activity-empty-forecast-receipt-next-type-count-target=\{farmActivityEmptyForecastReceiptNextTarget\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-type-count-target-label=\{farmActivityEmptyForecastReceiptNextTargetLabel \|\| undefined\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-type-count-label=\{farmActivityEmptyForecastReceiptNextCountLabel\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-type-count-next=\{farmActivityEmptyForecastReceiptNextHint \|\| undefined\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-type-count-title=\{farmActivityEmptyForecastReceiptNextTypeCountTitle \|\| undefined\}[\s\S]*title=\{farmActivityEmptyForecastReceiptNextTypeCountTitle\}[\s\S]*\{farmActivityEmptyForecastReceiptNextCountLabel\}/);
  assert.match(panel, /const farmActivityEmptyForecastReceiptNextCopyTitle = farmActivityEmptyForecastReceiptNextHint[\s\S]*\? farmActivityEmptyForecastReceiptNextTargetLabel[\s\S]*\? `下一步 \$\{farmActivityEmptyForecastReceiptNextTargetLabel\}：\$\{farmActivityEmptyForecastReceiptNextHint\}`[\s\S]*: `下一步 \$\{farmActivityEmptyForecastReceiptNextHint\}`[\s\S]*: ''/);
  assert.match(panel, /farmActivityEmptyForecastReceiptNextAccessibleHint \? farmActivityEmptyForecastReceiptNextAccessibleHint : ''/);
  assert.match(panel, /farmMiniQuickActionBusy && \([\s\S]*<em[\s\S]*data-farm-activity-empty-forecast-receipt="true"[\s\S]*data-farm-activity-empty-forecast-receipt-label=\{farmActivityEmptyForecastReceiptLabel\}[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*title=\{farmActivityEmptyForecastReceiptTitle\}[\s\S]*aria-label=\{farmActivityEmptyForecastReceiptTitle\}[\s\S]*预期已确认[\s\S]*<b data-farm-activity-empty-forecast-receipt-result="true">\{farmActivityEmptyForecastReceiptLabel\}<\/b>[\s\S]*farmActivityEmptyForecastReceiptDetails\.length > 0 && \([\s\S]*data-farm-activity-empty-forecast-receipt-chips="true"[\s\S]*farmMiniQuickActionResourceFeedbackLabel && \([\s\S]*data-farm-activity-empty-forecast-receipt-chip="resource"[\s\S]*资源 \{farmMiniQuickActionResourceFeedbackLabel\}[\s\S]*farmMiniQuickActionActivityFeedbackLabel && \([\s\S]*data-farm-activity-empty-forecast-receipt-chip="activity"[\s\S]*今日 \{farmMiniQuickActionActivityFeedbackLabel\}[\s\S]*primaryFarmFocusProgressPreview && \([\s\S]*data-farm-activity-empty-forecast-receipt-chip="progress"[\s\S]*data-farm-activity-empty-forecast-receipt-progress-state=\{farmActivityEmptyForecastReceiptProgressState\}[\s\S]*进度 \{primaryFarmFocusProgressPreview\}[\s\S]*<\/em>[\s\S]*\)/);
  assert.match(panel, /data-farm-activity-empty-forecast-receipt-progress-state-label=\{farmActivityEmptyForecastReceiptProgressStateLabel \|\| undefined\}/);
  assert.match(panel, /farmActivityEmptyForecastReceiptProgressStateLabel && \([\s\S]*data-farm-activity-empty-forecast-receipt-progress-state-label="true"[\s\S]*\{farmActivityEmptyForecastReceiptProgressStateLabel\}/);
  assert.match(panel, /data-farm-activity-empty-forecast-receipt-progress-value="true"[\s\S]*进度 \{primaryFarmFocusProgressPreview\}/);
  assert.match(panel, /farmActivityEmptyForecastReceiptNextHint && \([\s\S]*data-farm-activity-empty-forecast-receipt-next="true"[\s\S]*data-farm-activity-empty-forecast-receipt-next-target=\{farmActivityEmptyForecastReceiptNextTarget\}[\s\S]*title=\{farmActivityEmptyForecastReceiptNextAccessibleHint\}[\s\S]*farmActivityEmptyForecastReceiptNextBadgeLabel && \([\s\S]*data-farm-activity-empty-forecast-receipt-next-badge="true"[\s\S]*data-farm-activity-empty-forecast-receipt-next-badge-target=\{farmActivityEmptyForecastReceiptNextTarget\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-badge-label=\{farmActivityEmptyForecastReceiptNextBadgeLabel\}[\s\S]*title=\{farmActivityEmptyForecastReceiptNextBadgeTitle\}[\s\S]*\{farmActivityEmptyForecastReceiptNextBadgeLabel\}[\s\S]*farmActivityEmptyForecastReceiptNextCountLabel && \([\s\S]*data-farm-activity-empty-forecast-receipt-next-count="true"[\s\S]*data-farm-activity-empty-forecast-receipt-next-count-target=\{farmActivityEmptyForecastReceiptNextTarget\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-count-label=\{farmActivityEmptyForecastReceiptNextCountLabel\}[\s\S]*title=\{farmActivityEmptyForecastReceiptNextCountTitle\}[\s\S]*\{farmActivityEmptyForecastReceiptNextCountLabel\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-copy="true"[\s\S]*data-farm-activity-empty-forecast-receipt-next-copy-target=\{farmActivityEmptyForecastReceiptNextTarget\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-copy-target-label=\{farmActivityEmptyForecastReceiptNextTargetLabel \|\| undefined\}[\s\S]*data-farm-activity-empty-forecast-receipt-next-copy-label=\{farmActivityEmptyForecastReceiptNextHint\}[\s\S]*title=\{farmActivityEmptyForecastReceiptNextCopyTitle\}[\s\S]*\{farmActivityEmptyForecastReceiptNextHint\}/);
  assert.match(panel, /primaryFarmFocus && \([\s\S]*data-farm-activity-empty-action="true"[\s\S]*data-farm-activity-empty-action-kind=\{primaryFarmFocus\.action\.kind\}[\s\S]*data-farm-activity-empty-action-label=\{primaryFarmFocus\.actionLabel\}[\s\S]*data-farm-activity-empty-action-resource-targets=\{primaryFarmFocusActionResourceTargets\.join\(' '\) \|\| undefined\}[\s\S]*data-farm-activity-empty-action-resource-preview=\{primaryFarmFocusActionResourcePreview \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-empty-action-fired=\{farmMiniQuickActionBusy \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-activity-empty-action-busy=\{farmMiniQuickActionBusy \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-activity-empty-action-result=\{farmMiniQuickActionFeedback\?\.label \|\| undefined\}/);
  assert.match(panel, /data-farm-activity-empty-action-progress-preview=\{primaryFarmFocusProgressPreview \|\| undefined\}/);
  assert.match(panel, /farmMiniQuickActionBusy \? <MiniQuickActionIcon size=\{10\} \/> : <Sparkles size=\{10\} \/>/);
  assert.match(panel, /<b>\{farmMiniQuickActionBusy \? `已执行：\$\{farmMiniQuickActionFeedback\?\.label \|\| primaryFarmFocus\.actionLabel\}` : `先做：\$\{primaryFarmFocus\.actionLabel\}`\}<\/b>/);
  assert.match(panel, /title=\{`没有农活记录，先执行：\$\{primaryFarmFocus\.actionLabel\}\$\{primaryFarmFocusActionResourcePreview \? ` · \$\{primaryFarmFocusActionResourcePreview\}` : ''\}`\}/);
  assert.match(panel, /aria-label=\{`没有农活记录，先执行今日小目标：\$\{primaryFarmFocus\.actionLabel\}\$\{primaryFarmFocusActionResourcePreview \? `，\$\{primaryFarmFocusActionResourcePreview\}` : ''\}`\}/);
  assert.match(panel, /data-farm-activity-empty-action="true"[\s\S]*onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);[\s\S]*handleFarmFocusAction\(primaryFarmFocus\);[\s\S]*\}\}/);
  assert.match(panel, /primaryFarmFocusActionResourcePreview && \([\s\S]*data-farm-activity-empty-action-resource="true"[\s\S]*\{primaryFarmFocusActionResourcePreview\}/);
  assert.match(panel, /primaryFarmFocusProgressPreview && \([\s\S]*data-farm-activity-empty-action-progress="true"[\s\S]*\{primaryFarmFocusProgressPreview\}/);
  assert.match(panel, /id:\s*'shovel'[\s\S]*label:\s*'铲除'/);
  assert.match(panel, /id:\s*'decor'[\s\S]*label:\s*'装饰'/);
  assert.match(panel, /id:\s*'move'[\s\S]*label:\s*'移动'/);
  assert.match(panel, /onJumpToMature\?\.\(\)/);
  assert.match(panel, /onToggleEditing\?\.\(!editing\)/);
  assert.match(panel, /onAdvanceDay\?\.\(\)/);
  assert.match(panel, /onCompleteOrder\?\.\(currentOrder\.id\)/);
  assert.match(panel, /ref=\{farmOrderRef\}[\s\S]*className=\{`t8-farm-story-panel__quest[\s\S]*data-farm-order-focus=\{farmOrderLocateOpened \? 'true' : undefined\}[\s\S]*data-farm-order-pulse=\{farmOrderLocatePulseId \|\| undefined\}[\s\S]*tabIndex=\{-1\}/);
  assert.match(panel, /className="t8-farm-story-panel__quest-reward"/);
  assert.match(panel, /data-farm-order-reward=\{currentOrderRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-order-festival-link=\{currentOrderFestivalLinkLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-order-festival-completes=\{currentOrderFestivalCompletes \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-order-festival-reward=\{currentOrderFestivalRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-order-stamp-active=\{farmOrderStampActive \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-order-stamp-feedback-label=\{farmOrderStampFeedbackLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-order-located=\{farmOrderLocateOpened \? 'true' : undefined\}/);
  assert.match(panel, /aria-label=\{farmOrderRewardTitle\}/);
  assert.match(panel, /title=\{farmOrderRewardTitle\}/);
  assert.match(panel, /interface FarmOrderRewardPocketReceipt/);
  assert.match(panel, /nextActionLabel: string/);
  assert.match(panel, /nextActionTitle: string/);
  assert.match(panel, /action\?: FarmFocusGoalAction/);
  assert.match(panel, /const \[farmOrderRewardPocketReceipt, setFarmOrderRewardPocketReceipt\] = useState<FarmOrderRewardPocketReceipt \| null>\(null\)/);
  assert.match(panel, /const \[farmOrderRewardRouteReceipt, setFarmOrderRewardRouteReceipt\] = useState\(''\)/);
  assert.match(panel, /const \[farmOrderRewardNextActionReceipt, setFarmOrderRewardNextActionReceipt\] = useState\(''\)/);
  assert.match(panel, /const farmOrderRewardPocketTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmOrderRewardRouteTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /const farmOrderRewardNextActionTimerRef = useRef<number \| null>\(null\)/);
  assert.match(panel, /function buildFarmOrderRewardPocketReceipt\(orderId: string\): FarmOrderRewardPocketReceipt \| null/);
  assert.match(panel, /farmFocusGoals\.find\(\(goal\) => !\(goal\.action\.kind === 'complete-order' && goal\.action\.orderId === order\.id\)\) \|\| primaryFarmFocus/);
  assert.match(panel, /action: nextFocus\?\.action/);
  assert.match(panel, /function flashFarmOrderRewardPocket\(orderId: string\)/);
  assert.match(panel, /function handleFarmOrderRewardPocketRouteHint\(\)/);
  assert.match(panel, /message: `订单奖励路线：\$\{farmOrderRewardPocketReceipt\.routeLabel\}/);
  assert.match(panel, /routeTarget: farmOrderRewardPocketReceipt\.routeTarget[\s\S]*routeLabel: farmOrderRewardPocketReceipt\.routeLabel[\s\S]*routeTitle: farmOrderRewardPocketReceipt\.routeTitle/);
  assert.match(panel, /function handleFarmOrderRewardPocketNextAction\(\)/);
  assert.match(panel, /if \(!farmOrderRewardPocketReceipt\?\.action\) return/);
  assert.match(panel, /setFarmOrderRewardNextActionReceipt\(farmOrderRewardPocketReceipt\.nextActionLabel \|\| '已接上'\)/);
  assert.match(panel, /handleFarmGoalAction\(farmOrderRewardPocketReceipt\.action\)/);
  assert.match(panel, /function handleFarmCompleteCurrentOrder\(\)/);
  assert.match(panel, /flashFarmOrderRewardPocket\(currentOrder\.id\)/);
  assert.match(panel, /farmOrderStampActive && \([\s\S]*<em[\s\S]*data-farm-order-stamp-feedback="true"[\s\S]*data-farm-order-stamp-festival-reward=\{currentOrderFestivalRewardLabel \|\| undefined\}[\s\S]*>\{farmOrderStampFeedbackLabel\}<\/em>[\s\S]*\)/);
  assert.match(panel, /farmOrderLocateOpened && !farmOrderStampActive && \([\s\S]*<em data-farm-order-located-feedback="true">已定位<\/em>[\s\S]*\)/);
  assert.match(panel, /currentOrderFestivalLinkLabel && \([\s\S]*<em data-farm-order-festival-link="true">\{currentOrderFestivalLinkLabel\}<\/em>[\s\S]*\)/);
  assert.match(panel, /currentOrderFestivalRewardLabel && \([\s\S]*<i data-farm-order-festival-reward="true">节庆奖励 \{currentOrderFestivalRewardLabel\}<\/i>[\s\S]*\)/);
  assert.match(panel, /farmOrderRewardPocketReceipt && \([\s\S]*className="t8-farm-story-panel__order-reward-pocket"[\s\S]*data-farm-order-reward-pocket="true"[\s\S]*奖励入袋[\s\S]*\{farmOrderRewardPocketReceipt\.rewardLabel\}/);
  assert.match(panel, /data-farm-order-reward-pocket-route-hint="true"[\s\S]*onClick=\{\(event\) => \{[\s\S]*handleFarmOrderRewardPocketRouteHint\(\)[\s\S]*地图找\{farmOrderRewardPocketReceipt\.routeLabel\}/);
  assert.match(panel, /data-farm-order-reward-pocket-next-action="true"[\s\S]*data-farm-order-reward-pocket-next-action-kind=\{farmOrderRewardPocketReceipt\.action\.kind\}[\s\S]*onClick=\{\(event\) => \{[\s\S]*handleFarmOrderRewardPocketNextAction\(\)[\s\S]*\{farmOrderRewardNextActionReceipt \? '已接上' : farmOrderRewardPocketReceipt\.nextActionLabel\}/);
  assert.match(panel, /disabled=\{!orderReady \|\| farmOrderStampActive\}/);
  assert.match(panel, /aria-disabled=\{!orderReady \|\| farmOrderStampActive\}/);
  assert.match(panel, /data-farm-order-button-festival-link=\{currentOrderFestivalLinkLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-order-button-festival-completes=\{currentOrderFestivalCompletes \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-order-button-festival-reward=\{currentOrderFestivalRewardLabel \|\| undefined\}/);
  assert.match(panel, /title=\{farmOrderSubmitTitle\}/);
  assert.match(panel, /if \(currentOrder && !farmOrderStampActive\) \{[\s\S]*handleFarmCompleteCurrentOrder\(\)/);
  assert.match(panel, /\{farmOrderSubmitLabel\}/);
  assert.match(panel, /data-farm-festival-task-ready-via-order=\{festivalTaskReadyViaOrder \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-festival-task-next-progress=\{activeFestivalTask \? festivalTaskNextProgress : undefined\}/);
  assert.match(panel, /data-farm-festival-task-next-percent=\{activeFestivalTask \? festivalTaskNextPercent : undefined\}/);
  assert.match(panel, /data-farm-festival-task-completes-via-order=\{festivalTaskCompletesViaOrder \? 'true' : undefined\}/);
  assert.match(panel, /festivalTaskCompletionLabel && \([\s\S]*<em data-farm-festival-task-completion-badge="true">\{festivalTaskCompletionLabel\}<\/em>[\s\S]*\)/);
  assert.match(panel, /festivalTaskReadyViaOrder && \([\s\S]*className="t8-farm-story-panel__festival-task-forecast"[\s\S]*data-farm-festival-task-forecast="order"[\s\S]*data-farm-festival-task-forecast-tone=\{festivalTaskForecastTone \|\| undefined\}[\s\S]*data-farm-festival-task-reward=\{festivalTaskRewardLabel \|\| undefined\}[\s\S]*\{festivalTaskForecastLabel\}/);
  assert.match(panel, /ref=\{farmNpcVisitRef\}[\s\S]*data-farm-npc-focus=\{farmNpcVisitOpened \? 'true' : undefined\}[\s\S]*data-farm-npc-pulse=\{farmNpcVisitPulseId \|\| undefined\}[\s\S]*tabIndex=\{-1\}/);
  assert.match(panel, /data-farm-npc-delivery-active=\{farmNpcDeliveryActive \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-npc-reward=\{formatFarmReward\(activeNpcVisit\.rewards\)\}/);
  assert.match(panel, /const farmNpcDeliveryReceiptNextFocus = farmNpcDeliveryActive && activeNpcVisit[\s\S]*goal\.action\.kind === 'complete-npc' && goal\.action\.visitId === activeNpcVisit\.id[\s\S]*\|\| primaryFarmFocus[\s\S]*: primaryFarmFocus/);
  assert.match(panel, /const farmNpcDeliveryReceiptRewardLabel = activeNpcVisit \? formatFarmReward\(activeNpcVisit\.rewards\) : ''/);
  assert.match(panel, /const farmNpcDeliveryReceiptRouteTarget = farmNpcDeliveryReceiptNextFocus\?\.action \? farmRouteTargetForFocusAction\(farmNpcDeliveryReceiptNextFocus\.action\) : undefined/);
  assert.match(panel, /const farmNpcDeliveryReceiptRouteLabel = farmRouteLabelForTarget\(farmNpcDeliveryReceiptRouteTarget\)/);
  assert.match(panel, /const handleFarmNpcDeliveryReceiptRouteHint = \(\) => \{[\s\S]*if \(!farmNpcDeliveryReceiptRouteTarget \|\| !farmNpcDeliveryReceiptRouteLabel\) return[\s\S]*message: `来访谢礼路线：\$\{farmNpcDeliveryReceiptRouteLabel\}/);
  assert.match(panel, /routeTarget: farmNpcDeliveryReceiptRouteTarget[\s\S]*routeLabel: farmNpcDeliveryReceiptRouteLabel[\s\S]*routeTitle: farmNpcDeliveryReceiptRouteTitle/);
  assert.match(panel, /data-farm-npc-delivery-reward=\{farmNpcDeliveryActive \? farmNpcDeliveryReceiptRewardLabel \|\| undefined : undefined\}/);
  assert.match(panel, /interface FarmNpcBondPreview/);
  assert.match(panel, /function farmNpcBondPreview\(visit: FarmNpcVisitState \| undefined, farmCanvas: FarmCanvasState \| undefined\): FarmNpcBondPreview \| null/);
  assert.match(panel, /const farmNpcBond = farmNpcBondPreview\(activeNpcVisit, farmCanvas\)/);
  assert.match(panel, /data-farm-npc-bond-level=\{farmNpcBond\?\.levelLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-npc-bond-progress=\{farmNpcBond\?\.progressLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-npc-bond-next-reward=\{farmNpcBond\?\.nextRewardLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-npc-bond-after-delivery=\{farmNpcDeliveryActive && farmNpcBond \? farmNpcBond\.afterDeliveryLabel : undefined\}/);
  assert.match(panel, /farmNpcBond && \([\s\S]*className="t8-farm-story-panel__npc-bond"[\s\S]*data-farm-npc-bond="true"[\s\S]*data-farm-npc-bond-ready=\{npcVisitReady \? 'true' : undefined\}[\s\S]*data-farm-npc-bond-level=\{farmNpcBond\.levelLabel\}[\s\S]*data-farm-npc-bond-progress=\{farmNpcBond\.progressLabel\}[\s\S]*data-farm-npc-bond-next-reward=\{farmNpcBond\.nextRewardLabel\}[\s\S]*熟络/);
  assert.match(panel, /farmNpcDeliveryActive && farmNpcBond\.afterDeliveryLabel && \([\s\S]*data-farm-npc-bond-after-delivery="true"[\s\S]*\{farmNpcBond\.afterDeliveryLabel\}/);
  assert.match(panel, /interface FarmNpcBondMilestoneReward/);
  assert.match(panel, /function farmNpcBondMilestoneReward\(visit: FarmNpcVisitState \| undefined, farmCanvas: FarmCanvasState \| undefined\): FarmNpcBondMilestoneReward \| null/);
  assert.match(panel, /const farmNpcBondMilestone = farmNpcBondMilestoneReward\(activeNpcVisit, farmCanvas\)/);
  assert.match(panel, /data-farm-npc-bond-milestone=\{farmNpcBondMilestone\?\.targetLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-npc-bond-milestone-reward=\{farmNpcBondMilestone\?\.rewardLabel \|\| undefined\}/);
  assert.match(panel, /farmNpcBondMilestone && \([\s\S]*className="t8-farm-story-panel__npc-bond-milestone"[\s\S]*data-farm-npc-bond-milestone="true"[\s\S]*data-farm-npc-bond-milestone-target=\{farmNpcBondMilestone\.targetLabel\}[\s\S]*data-farm-npc-bond-milestone-reward=\{farmNpcBondMilestone\.rewardLabel\}[\s\S]*熟络礼物[\s\S]*\{farmNpcBondMilestone\.storyLabel\}/);
  assert.match(panel, /interface FarmNpcReturnPromisePreview/);
  assert.match(panel, /function farmNpcReturnPromisePreview\(visit: FarmNpcVisitState \| undefined, farmCanvas: FarmCanvasState \| undefined\): FarmNpcReturnPromisePreview \| null/);
  assert.match(panel, /const farmNpcReturnPromise = farmNpcReturnPromisePreview\(activeNpcVisit, farmCanvas\)/);
  assert.match(panel, /data-farm-npc-return-promise=\{farmNpcReturnPromise\?\.promiseLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-npc-return-promise-tone=\{farmNpcReturnPromise\?\.tone \|\| undefined\}/);
  assert.match(panel, /data-farm-npc-return-promise-next=\{farmNpcReturnPromise\?\.nextVisitLabel \|\| undefined\}/);
  assert.match(panel, /farmNpcReturnPromise && \([\s\S]*className="t8-farm-story-panel__npc-return-promise"[\s\S]*data-farm-npc-return-promise="true"[\s\S]*data-farm-npc-return-promise-tone=\{farmNpcReturnPromise\.tone\}[\s\S]*下次来访[\s\S]*\{farmNpcReturnPromise\.promiseLabel\}[\s\S]*data-farm-npc-return-promise-story="true"[\s\S]*\{farmNpcReturnPromise\.storyLabel\}/);
  assert.match(panel, /type FarmNpcPrepHintAction = 'deliver' \| 'harvest' \| 'water' \| 'plant' \| 'wait-day' \| 'animal'/);
  assert.match(panel, /interface FarmNpcPrepHintPreview/);
  assert.match(panel, /function farmNpcPrepHintPreview\(visit: FarmNpcVisitState \| undefined, farmCanvas: FarmCanvasState \| undefined, ready: boolean\): FarmNpcPrepHintPreview \| null/);
  assert.match(panel, /const farmNpcPrepHint = farmNpcPrepHintPreview\(activeNpcVisit, farmCanvas, npcVisitReady\)/);
  assert.match(panel, /const handleFarmNpcPrepHintAction = \(\) => \{[\s\S]*if \(!farmNpcPrepHint \|\| !activeNpcVisit\) return[\s\S]*if \(farmNpcPrepHint\.action === 'deliver'[\s\S]*flashFarmNpcDelivery\(activeNpcVisit\.id\)[\s\S]*onCompleteNpcVisit\?\.\(activeNpcVisit\.id\)[\s\S]*if \(farmNpcPrepHint\.action === 'animal'\) \{[\s\S]*handleOpenFarmAnimals\(\)/);
  assert.match(panel, /data-farm-npc-prep-status=\{farmNpcPrepHint\?\.statusLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-npc-prep-action=\{farmNpcPrepHint\?\.action \|\| undefined\}/);
  assert.match(panel, /data-farm-npc-prep-tone=\{farmNpcPrepHint\?\.tone \|\| undefined\}/);
  assert.match(panel, /farmNpcPrepHint && \([\s\S]*className="t8-farm-story-panel__npc-prep-hint"[\s\S]*data-farm-npc-prep-hint="true"[\s\S]*data-farm-npc-prep-tone=\{farmNpcPrepHint\.tone\}[\s\S]*备货提示[\s\S]*\{farmNpcPrepHint\.statusLabel\}[\s\S]*data-farm-npc-prep-story="true"[\s\S]*\{farmNpcPrepHint\.storyLabel\}[\s\S]*data-farm-npc-prep-action-button="true"[\s\S]*\{farmNpcPrepHint\.actionLabel\}/);
  assert.match(panel, /data-farm-npc-delivery-route-target=\{farmNpcDeliveryActive \? farmNpcDeliveryReceiptRouteTarget \|\| undefined : undefined\}/);
  assert.match(panel, /farmNpcDeliveryActive && \([\s\S]*className="t8-farm-story-panel__npc-delivery-receipt"[\s\S]*data-farm-npc-delivery-receipt="true"[\s\S]*谢礼入袋[\s\S]*\{farmNpcDeliveryReceiptRewardLabel\}/);
  assert.match(panel, /data-farm-npc-delivery-receipt-route-hint="true"[\s\S]*onClick=\{\(event\) => \{[\s\S]*handleFarmNpcDeliveryReceiptRouteHint\(\)[\s\S]*地图找\{farmNpcDeliveryReceiptRouteLabel\}/);
  assert.match(panel, /farmNpcDeliveryActive && \([\s\S]*<em data-farm-npc-delivery-feedback="true">交付中<\/em>[\s\S]*\)/);
  assert.match(panel, /farmNpcVisitOpened && !farmNpcDeliveryActive && \([\s\S]*<em data-farm-npc-located-feedback="true">已定位<\/em>[\s\S]*\)/);
  assert.match(panel, /disabled=\{!npcVisitReady \|\| farmNpcDeliveryActive\}/);
  assert.match(panel, /aria-disabled=\{!npcVisitReady \|\| farmNpcDeliveryActive\}/);
  assert.match(panel, /if \(!farmNpcDeliveryActive\) \{[\s\S]*flashFarmNpcDelivery\(activeNpcVisit\.id\)[\s\S]*onCompleteNpcVisit\?\.\(activeNpcVisit\.id\)/);
  assert.match(panel, /\{farmNpcDeliveryActive \? '交付中' : activeNpcVisit\.completed \? '已完成' : npcVisitReady \? '交付委托' : '材料不足'\}/);
  assert.match(panel, /t8-farm-story-panel__summary/);
  assert.match(panel, /ref=\{farmSummaryRef\}[\s\S]*className="t8-farm-story-panel__summary"[\s\S]*data-farm-summary-id=\{dailySummary\.id\}[\s\S]*data-farm-summary-focus=\{farmSummaryOpened \? 'true' : undefined\}[\s\S]*data-farm-summary-pulse=\{farmSummaryPulseId \|\| undefined\}[\s\S]*tabIndex=\{-1\}[\s\S]*aria-label=\{`每日总结：D\$\{dailySummary\.fromDay\} 到 D\$\{dailySummary\.toDay\}，\$\{dailySummary\.message\}`\}/);
  assert.match(panel, /farmSummaryOpened && \([\s\S]*className="t8-farm-story-panel__summary-located"[\s\S]*data-farm-summary-located-feedback="true"[\s\S]*已定位总结/);
  assert.match(panel, /dailySummary\.witheredCrops > 0[\s\S]*枯萎 \{dailySummary\.witheredCrops\}/);
  assert.match(panel, /t8-farm-story-panel__summary-actions/);
  assert.match(panel, /aria-label="每日总结快捷行动"/);
  assert.match(panel, /data-farm-summary-action=\{action\.action\.kind\}/);
  assert.match(panel, /data-farm-summary-action-tone=\{action\.tone\}/);
  assert.match(panel, /const summaryActionResourceTargets = farmActionResourceTargets\(action\.action\)/);
  assert.match(panel, /const summaryActionResourcePreview = farmActionResourcePreviewLabel\(summaryActionResourceTargets\)/);
  assert.match(panel, /const summaryActionResourceLabel = summaryActionResourcePreview\.replace\('预期：', ''\)/);
  assert.match(panel, /const summaryActionFeedbackActive = farmSummaryDetailActionFeedbackItemId === action\.id && Boolean\(farmSummaryDetailActionFeedback\)/);
  assert.match(panel, /const summaryActionFeedbackLabel = farmSummaryActionFeedbackLabel\(action\)/);
  assert.match(panel, /const summaryActionFeedbackTitle = summaryActionFeedbackActive[\s\S]*\? `刚刚执行：\$\{farmSummaryDetailActionFeedback\}\$\{summaryActionResourceLabel \? ` · \$\{summaryActionResourceLabel\}` : ''\}`[\s\S]*: action\.title/);
  assert.match(panel, /data-farm-summary-action-resource-targets=\{summaryActionResourceTargets\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-action-resource-preview=\{summaryActionResourcePreview \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-action-resource-label=\{summaryActionResourceLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-action-feedback=\{summaryActionFeedbackActive \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-summary-action-result=\{summaryActionFeedbackActive \? farmSummaryDetailActionFeedback : undefined\}/);
  assert.match(panel, /data-farm-summary-action-cooldown=\{summaryActionFeedbackActive \? 'true' : undefined\}/);
  assert.match(panel, /disabled=\{summaryActionFeedbackActive\}/);
  assert.match(panel, /aria-disabled=\{summaryActionFeedbackActive \? 'true' : undefined\}/);
  assert.match(panel, /title=\{summaryActionFeedbackTitle\}/);
  assert.match(panel, /aria-label=\{summaryActionFeedbackTitle\}/);
  assert.match(panel, /summaryActionResourcePreview && \([\s\S]*data-farm-summary-action-resource="true"[\s\S]*summaryActionResourcePreview\.replace\('预期：', ''\)/);
  assert.match(panel, /summaryActionFeedbackActive \? \([\s\S]*<Sparkles size=\{10\} \/>[\s\S]*<span>\{farmSummaryDetailActionFeedback\}<\/span>[\s\S]*summaryActionResourceLabel && \([\s\S]*data-farm-summary-action-resource="true"[\s\S]*data-farm-summary-action-resource-feedback="true"[\s\S]*\{summaryActionResourceLabel\}/);
  assert.match(panel, /data-farm-summary-action-feedback-stamp="true"[\s\S]*已执行/);
  assert.match(panel, /const farmSummaryActionReceipt = farmSummaryDetailActionFeedback[\s\S]*farmSummaryActions\.find\(\(action\) => action\.id === farmSummaryDetailActionFeedbackItemId\)/);
  assert.match(panel, /const farmSummaryActionReceiptResourceTargets = farmSummaryActionReceipt[\s\S]*farmActionResourceTargets\(farmSummaryActionReceipt\.action\)/);
  assert.match(panel, /const farmSummaryActionReceiptResourceLabel = farmSummaryActionReceipt[\s\S]*farmActionResourcePreviewLabel\(farmSummaryActionReceiptResourceTargets\)\.replace\('预期：', ''\)/);
  assert.match(panel, /const farmSummaryActionReceiptTitle = farmSummaryActionReceipt[\s\S]*`每日总结刚执行：\$\{farmSummaryDetailActionFeedback\}\$\{farmSummaryActionReceiptResourceLabel \? ` · \$\{farmSummaryActionReceiptResourceLabel\}` : ''\}`/);
  assert.match(panel, /const farmSummaryActionReceiptNextHintText = farmSummaryActionReceipt[\s\S]*farmSummaryActionReceiptNextHint\(farmSummaryActionReceipt\)/);
  assert.match(panel, /const farmSummaryActionReceiptNextBadgeText = farmSummaryActionReceipt[\s\S]*farmSummaryActionReceiptNextBadgeLabel\(farmSummaryActionReceipt\)/);
  assert.match(panel, /const farmSummaryActionReceiptNextCountText = farmSummaryActionReceipt[\s\S]*farmSummaryActionReceiptNextCountLabel\(farmSummaryActionReceipt, \{[\s\S]*dryCount[\s\S]*witheredCount[\s\S]*matureCount[\s\S]*scarecrowRiskCount[\s\S]*readyOrderCount[\s\S]*readyNpcVisitCount[\s\S]*\}\)/);
  assert.match(panel, /const farmSummaryActionReceiptNextAccessibleHint = farmSummaryActionReceiptNextCountText[\s\S]*`\$\{farmSummaryActionReceiptNextHintText\}，目标 \$\{farmSummaryActionReceiptNextCountText\}`[\s\S]*farmSummaryActionReceiptNextHintText/);
  assert.match(panel, /const farmSummaryActionReceiptAccessibleTitle = farmSummaryActionReceiptNextAccessibleHint[\s\S]*`\$\{farmSummaryActionReceiptTitle\}，\$\{farmSummaryActionReceiptNextAccessibleHint\}`[\s\S]*farmSummaryActionReceiptTitle/);
  assert.match(panel, /farmSummaryActionReceipt && \([\s\S]*className="t8-farm-story-panel__summary-action-receipt"[\s\S]*data-farm-summary-action-receipt="true"/);
  assert.match(panel, /data-farm-summary-action-receipt-item-id=\{farmSummaryDetailActionFeedbackItemId\}/);
  assert.match(panel, /data-farm-summary-action-receipt-targets=\{farmSummaryActionReceiptResourceTargets\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-action-receipt-resource-label=\{farmSummaryActionReceiptResourceLabel \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-action-receipt-next=\{farmSummaryActionReceiptNextHintText \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-action-receipt-next-badge-label=\{farmSummaryActionReceiptNextBadgeText \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-action-receipt-next-count-label=\{farmSummaryActionReceiptNextCountText \|\| undefined\}/);
  assert.match(panel, /role="status"[\s\S]*aria-live="polite"[\s\S]*title=\{farmSummaryActionReceiptAccessibleTitle\}[\s\S]*aria-label=\{farmSummaryActionReceiptAccessibleTitle\}[\s\S]*刚执行[\s\S]*\{farmSummaryDetailActionFeedback\}/);
  assert.match(panel, /data-farm-summary-action-receipt-resource="true"[\s\S]*\{farmSummaryActionReceiptResourceLabel\}/);
  assert.match(panel, /data-farm-summary-action-receipt-stamp="true"[\s\S]*已执行/);
  assert.match(panel, /farmSummaryActionReceiptNextHintText && \([\s\S]*data-farm-summary-action-receipt-next-hint="true"[\s\S]*\{farmSummaryActionReceiptNextHintText\}/);
  assert.match(panel, /data-farm-summary-action-receipt-next-hint="true"[\s\S]*data-farm-summary-action-receipt-next-targets=\{farmSummaryActionReceiptResourceTargets\.join\(' '\) \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-action-receipt-next-hint="true"[\s\S]*data-farm-summary-action-receipt-next-count-label=\{farmSummaryActionReceiptNextCountText \|\| undefined\}/);
  assert.match(panel, /data-farm-summary-action-receipt-next-badge="true"[\s\S]*\{farmSummaryActionReceiptNextBadgeText\}/);
  assert.match(panel, /farmSummaryActionReceiptNextCountText && \([\s\S]*data-farm-summary-action-receipt-next-count="true"[\s\S]*\{farmSummaryActionReceiptNextCountText\}/);
  assert.match(panel, /const ActionIcon = action\.icon/);
  assert.match(panel, /<ActionIcon size=\{10\} \/>/);
  assert.match(panel, /handleFarmGoalAction\(action\.action\)/);
  assert.match(panel, /if \(summaryActionFeedbackActive\) return;[\s\S]*handleFarmGoalAction\(action\.action\);[\s\S]*flashFarmSummaryDetailAction\(summaryActionFeedbackLabel, action\.id\)/);
  assert.match(panel, /关闭每日总结/);
  assert.match(panel, /t8-farm-story-panel__log/);
  assert.match(panel, /data-farm-event-kind=\{item\.kind\}/);
  assert.match(panel, /订单完成盖章/);

  assert.match(layer, /import \{ useReactFlow, ViewportPortal \} from '@xyflow\/react'/);
  assert.match(layer, /FARM_BUILDING_DEFINITIONS/);
  assert.match(layer, /FARM_DEFAULT_DECOR_ID/);
  assert.match(layer, /FARM_DECOR_DEFINITIONS/);
  assert.match(layer, /FARM_SCARECROW_RADIUS_CELLS/);
  assert.match(layer, /FARM_VIEWPORT_RENDER_MARGIN/);
  assert.match(layer, /farmToolActionGridKey/);
  assert.match(layer, /farmToolSupportsContinuousAction/);
  assert.match(layer, /previewFarmPlacement/);
  assert.match(layer, /snapFarmPoint/);
  assert.match(layer, /type FarmPlacementPreview/);
  assert.match(layer, /useState<FarmPlacementPreview \| null>/);
  assert.match(layer, /type FarmToolGhostTool = Exclude<FarmTool, 'select' \| 'build' \| 'decor'>/);
  assert.match(layer, /type FarmToolGhostStatus = 'ready' \| 'target' \| 'blocked' \| 'invalid'/);
  assert.match(layer, /interface FarmToolGhostPreview/);
  assert.match(layer, /useState<FarmToolGhostPreview \| null>/);
  assert.match(layer, /const farmContinuousActionRef = useRef<FarmContinuousActionSession \| null>\(null\)/);
  assert.match(layer, /type FarmCanvasConnectionKind = 'path' \| 'fence'/);
  assert.match(layer, /function farmObjectConnectionKind\(object: FarmCanvasObject\): FarmCanvasConnectionKind \| null/);
  assert.match(layer, /function buildFarmObjectConnectionMap\(objects: FarmCanvasObject\[\], gridSize: number\)/);
  assert.match(layer, /function farmObjectConnection\([\s\S]*north[\s\S]*east[\s\S]*south[\s\S]*west/);
  assert.match(layer, /objectConnectionClassName\(connection \|\| null\)/);
  assert.match(layer, /buildFarmObjectConnectionMap\(visibleObjects, farmCanvas\.gridSize \|\| 64\)/);
  assert.doesNotMatch(layer, /buildFarmObjectConnectionMap\(farmCanvas\.objects/);
  assert.match(layer, /object\.kind === 'building'[\s\S]*FARM_BUILDING_DEFINITIONS/);
  assert.match(layer, /object\.kind === 'decor'[\s\S]*FARM_DECOR_DEFINITIONS/);
  assert.match(layer, /is-building-\$\{object\.buildingId\}/);
  assert.match(layer, /is-decor-\$\{object\.decorId\}/);
  assert.match(layer, /selectedObjectId === object\.id \? ' is-selected' : ''/);
  assert.match(layer, /highlightedObjectId === object\.id \? ' is-jump-highlight' : ''/);
  assert.match(layer, /function farmObjectPlacementReceiptLabel\(object: FarmCanvasObject, highlightedObjectId\?: string \| null\) \{[\s\S]*if \(highlightedObjectId !== object\.id\) return '';[\s\S]*if \(object\.kind === 'building'\) return '落成';[\s\S]*if \(object\.kind === 'decor'\) return '布置';[\s\S]*return '';[\s\S]*\}/);
  assert.match(layer, /data-farm-object-highlighted=\{highlightedObjectId === object\.id \? 'true' : undefined\}/);
  assert.match(layer, /function farmCropStageLabel\(stage\?: FarmCropStage\)/);
  assert.match(layer, /function farmObjectStatusKey\(object: FarmCanvasObject, hasResourceImage = false\)/);
  assert.match(layer, /function farmObjectStatusLabel\(object: FarmCanvasObject, resourceDecor\?: FarmCanvasResourceDecorItem, hasResourceImage = false\)/);
  assert.match(layer, /isFarmPlotNeedingScarecrowProtection/);
  assert.match(layer, /const farmViewportBounds = useMemo\(\(\) => \{/);
  assert.match(layer, /const visibleObjects = useMemo\(\(\) => getFarmObjectsInViewport\(farmCanvas, farmViewportBounds\), \[farmCanvas, farmViewportBounds\]\)/);
  assert.match(layer, /const farmScarecrowRenderMargin = FARM_VIEWPORT_RENDER_MARGIN \+ FARM_SCARECROW_RADIUS_CELLS \* \(farmCanvas\.gridSize \|\| 64\)/);
  assert.match(layer, /const scarecrowObjects = useMemo\([\s\S]*getFarmObjectsInViewport\(farmCanvas, farmViewportBounds, farmScarecrowRenderMargin\)[\s\S]*buildingId === 'scarecrow'/);
  assert.doesNotMatch(layer, /farmCanvas\.objects\.filter\(\(object\) => object\.kind === 'building' && object\.buildingId === 'scarecrow'/);
  assert.match(layer, /const protectedByScarecrow = isFarmPlotNeedingScarecrowProtection\(object, farmCanvas, scarecrowObjects\)/);
  assert.match(layer, /const scarecrowCoverageSource = object\.kind === 'building' && object\.buildingId === 'scarecrow'/);
  assert.match(layer, /protectedByScarecrow \? 'protected' : farmObjectStatusKey/);
  assert.match(layer, /protectedByScarecrow \? '稻草人守护' : farmObjectStatusLabel/);
  assert.match(layer, /object\.crop\.stage === 'mature'[\s\S]*return 'mature'/);
  assert.match(layer, /object\.crop\.wateredToday \? 'watered' : 'dry'/);
  assert.match(layer, /export interface FarmCanvasFloatingFeedback/);
  assert.match(layer, /feedbacks\?: FarmCanvasFloatingFeedback\[\]/);
  assert.match(layer, /highlightedObjectId\?: string \| null/);
  assert.match(layer, /onCancelContinuousAction\?: \(reason: 'escape' \| 'contextmenu' \| 'blur'\) => void/);
  assert.match(layer, /onFinishContinuousAction\?: \(\) => void/);
  assert.match(layer, /export default function FarmCanvasLayer\(props: FarmCanvasLayerProps\) \{\s*if \(props\.visualStyle !== 'farm-story'\) return null;\s*return <FarmCanvasLayerRuntime \{\.\.\.props\} \/>;\s*\}/);
  assert.match(layer, /function FarmCanvasLayerRuntime\(\{[\s\S]*\}: FarmCanvasLayerProps\) \{/);
  assert.ok(
    layer.indexOf('export default function FarmCanvasLayer(props: FarmCanvasLayerProps)') < layer.indexOf('function FarmCanvasLayerRuntime({'),
    'FarmCanvasLayer wrapper should guard non-farm themes before mounting the runtime',
  );
  assert.match(layer, /feedbacks = \[\]/);
  assert.match(layer, /highlightedObjectId = null/);
  assert.match(layer, /const FARM_CANVAS_EXCLUSION_SELECTOR = \[/);
  assert.match(layer, /\.react-flow__node/);
  assert.match(layer, /\.react-flow__handle/);
  assert.match(layer, /\.react-flow__minimap/);
  assert.match(layer, /\[data-canvas-floating-ui\]/);
  assert.match(layer, /getFarmObjectsInViewport\(farmCanvas/);
  assert.match(layer, /data-farm-visible-object-count=\{visibleObjects\.length\}/);
  assert.match(layer, /data-farm-virtualized=\{visibleObjects\.length < farmCanvas\.objects\.length \? 'true' : undefined\}/);
  assert.match(layer, /data-farm-render-margin=\{FARM_VIEWPORT_RENDER_MARGIN\}/);
  assert.match(layer, /data-farm-connection-object-count=\{visibleObjects\.length\}/);
  assert.match(layer, /data-farm-scarecrow-object-count=\{scarecrowObjects\.length\}/);
  assert.match(layer, /data-farm-scarecrow-render-margin=\{farmScarecrowRenderMargin\}/);
  assert.match(layer, /\{visibleObjects\.map\(\(object\) => \{/);
  assert.match(layer, /screenToFlowPosition\(\{ x: event\.clientX, y: event\.clientY \}\)/);
  assert.match(layer, /activeTool === 'select'/);
  assert.match(layer, /buildingId: activeTool === 'build' \? \(farmCanvas\.selectedBuildingId \|\| 'hut'\) : undefined/);
  assert.match(layer, /decorId: activeTool === 'decor' \? \(farmCanvas\.selectedDecorId \|\| FARM_DEFAULT_DECOR_ID\) : undefined/);
  assert.match(layer, /const canPreviewPlacement = editing[\s\S]*activeTool === 'build' \|\| activeTool === 'decor'/);
  assert.match(layer, /document\.addEventListener\('pointermove', handlePointerMove, true\)/);
  assert.match(layer, /document\.addEventListener\('keydown', handleKeyDown, true\)/);
  assert.match(layer, /event\.key !== 'Escape'/);
  assert.match(layer, /onAction\(\{ tool: 'select', x: 0, y: 0 \}\)/);
  assert.match(layer, /document\.addEventListener\('pointerdown', handlePointerDown, true\)/);
  assert.match(layer, /document\.addEventListener\('pointermove', handlePointerMove, true\)/);
  assert.match(layer, /document\.addEventListener\('pointerup', handlePointerEnd, true\)/);
  assert.match(layer, /document\.addEventListener\('pointercancel', handlePointerEnd, true\)/);
  assert.match(layer, /farmContinuousActionRef\.current = null;[\s\S]*onFinishContinuousAction\?\.\(\)/);
  assert.match(layer, /const cancelFarmContinuousAction = \(reason: 'escape' \| 'contextmenu' \| 'blur'\) => \{[\s\S]*onCancelContinuousAction\?\.\(reason\)/);
  assert.match(layer, /event\.button === 2 && cancelFarmContinuousAction\('contextmenu'\)/);
  assert.match(layer, /document\.addEventListener\('keydown', handleKeyDown, true\)/);
  assert.match(layer, /window\.addEventListener\('contextmenu', handleContextMenu, true\)/);
  assert.match(layer, /window\.addEventListener\('blur', handleWindowBlur\)/);
  assert.match(layer, /cancelFarmContinuousAction\('escape'\)/);
  assert.match(layer, /cancelFarmContinuousAction\('blur'\)/);
  assert.match(layer, /farmToolSupportsContinuousAction\(activeTool\)/);
  assert.match(layer, /farmToolActionGridKey\(action, farmCanvas\.gridSize\)/);
  assert.match(layer, /event\.stopImmediatePropagation\?\.\(\)/);
  assert.match(layer, /function farmPlacementStatusLabel\(status: FarmPlacementPreview\['status'\]\)/);
  assert.match(layer, /function farmPlacementStatusIcon\(status: FarmPlacementPreview\['status'\]\)/);
  assert.match(layer, /function farmPlacementShowsScarecrowCoverage\(preview: FarmPlacementPreview\)/);
  assert.match(layer, /preview\.kind === 'building' && preview\.buildingId === 'scarecrow'/);
  assert.match(layer, /function farmPlacementInlineStyle\(preview: FarmPlacementPreview, gridSize: number\)/);
  assert.match(layer, /style\['--farm-scarecrow-range-size'\] = `\$\{FARM_SCARECROW_RADIUS_CELLS \* gridSize \* 2\}px`/);
  assert.match(layer, /function isFarmToolGhostTool\(tool: FarmTool\): tool is FarmToolGhostTool/);
  assert.match(layer, /function farmToolGhostLabel\(tool: FarmToolGhostTool\)/);
  assert.match(layer, /function farmToolGhostIcon\(tool: FarmToolGhostTool\)/);
  assert.match(layer, /function findFarmToolGhostTarget\(objects: FarmCanvasObject\[\], x: number, y: number, gridSize: number\)/);
  assert.match(layer, /function findFarmToolGhostAreaBlocker/);
  assert.match(layer, /function buildFarmToolGhostPreview\([\s\S]*tool: FarmToolGhostTool/);
  assert.match(layer, /const canPreviewFarmTool = editing[\s\S]*activeTool !== 'select'/);
  assert.match(layer, /<ViewportPortal>/);
  assert.match(layer, /setFarmToolGhostPreview\(null\)/);
  assert.match(layer, /setFarmToolGhostPreview\(isFarmToolGhostTool\(activeTool\)[\s\S]*buildFarmToolGhostPreview\(farmCanvas, activeTool, point\.x, point\.y\)/);
  assert.match(layer, /t8-farm-canvas-tool-ghost is-\$\{farmToolGhostPreview\.tool\} is-\$\{farmToolGhostPreview\.status\}/);
  assert.match(layer, /data-farm-tool-preview-tool=\{farmToolGhostPreview\.tool\}/);
  assert.match(layer, /data-farm-tool-preview-status=\{farmToolGhostPreview\.status\}/);
  assert.match(layer, /data-farm-tool-preview-can-act=\{farmToolGhostPreview\.status === 'ready' \? 'true' : 'false'\}/);
  assert.match(layer, /data-farm-tool-preview-target-status=\{farmToolGhostPreview\.targetStatus \|\| undefined\}/);
  assert.match(layer, /data-farm-tool-preview-object-id=\{farmToolGhostPreview\.objectId \|\| undefined\}/);
  assert.match(layer, /data-farm-tool-preview-crop-id=\{farmToolGhostPreview\.cropId \|\| undefined\}/);
  assert.match(layer, /t8-farm-canvas-tool-ghost__cell/);
  assert.match(layer, /t8-farm-canvas-tool-ghost__icon/);
  assert.match(layer, /t8-farm-canvas-tool-ghost__copy/);
  assert.match(layer, /t8-farm-canvas-placement is-\$\{farmPlacementPreview\.status\}/);
  assert.match(layer, /is-\$\{farmPlacementPreview\.kind\}/);
  assert.match(layer, /farmPlacementPreview\.canPlace \? ' can-place' : ' cannot-place'/);
  assert.match(layer, /data-farm-placement-status=\{farmPlacementPreview\.status\}/);
  assert.match(layer, /data-farm-placement-can-place=\{farmPlacementPreview\.canPlace \? 'true' : 'false'\}/);
  assert.match(layer, /data-farm-placement-reason=\{farmPlacementPreview\.reason \|\| undefined\}/);
  assert.match(layer, /data-farm-placement-effect-preview=\{farmPlacementPreview\.effectPreview \|\| undefined\}/);
  assert.match(layer, /data-farm-placement-missing-gold=\{farmPlacementPreview\.missingResources\?\.gold/);
  assert.match(layer, /data-farm-placement-scarecrow-coverage=\{farmPlacementShowsScarecrowCoverage\(farmPlacementPreview\) \? 'true' : undefined\}/);
  assert.match(layer, /data-farm-placement-scarecrow-radius-cells=\{farmPlacementShowsScarecrowCoverage\(farmPlacementPreview\) \? FARM_SCARECROW_RADIUS_CELLS : undefined\}/);
  assert.match(layer, /style=\{farmPlacementInlineStyle\(farmPlacementPreview, farmCanvas\.gridSize\)\}/);
  assert.match(layer, /t8-farm-canvas-placement__scarecrow-range/);
  assert.match(layer, /t8-farm-canvas-placement__footprint/);
  assert.match(layer, /t8-farm-canvas-placement__icon/);
  assert.match(layer, /farmPlacementPreview\.effectPreview && \([\s\S]*className="t8-farm-canvas-placement__effect"[\s\S]*data-farm-placement-effect-preview-chip="true"[\s\S]*\{farmPlacementPreview\.effectPreview\}/);
  assert.match(layer, /t8-farm-canvas-placement__size/);
  assert.match(layer, /const objectLabel = getObjectLabel\(object\)/);
  assert.match(layer, /const objectStatus = protectedByScarecrow \? '稻草人守护' : farmObjectStatusLabel\(object, resourceDecor, Boolean\(resourceImageUrl\)\)/);
  assert.match(layer, /const objectStatusKey = protectedByScarecrow \? 'protected' : farmObjectStatusKey\(object, Boolean\(resourceImageUrl\)\)/);
  assert.match(layer, /const placementReceiptLabel = farmObjectPlacementReceiptLabel\(object, highlightedObjectId\)/);
  assert.match(layer, /const objectStyle: CSSProperties & \{ '--farm-resource-image'\?: string; '--farm-scarecrow-range-size'\?: string \}/);
  assert.match(layer, /objectStyle\['--farm-scarecrow-range-size'\] = `\$\{FARM_SCARECROW_RADIUS_CELLS \* farmCanvas\.gridSize \* 2\}px`/);
  assert.match(layer, /data-farm-object-type=\{object\.buildingId \|\| object\.decorId \|\| object\.kind\}/);
  assert.match(layer, /data-farm-object-label=\{objectLabel\}/);
  assert.match(layer, /data-farm-object-status=\{objectStatusKey\}/);
  assert.match(layer, /data-farm-object-status-label=\{objectStatus\}/);
  assert.match(layer, /data-farm-object-protected=\{protectedByScarecrow \? 'scarecrow' : undefined\}/);
  assert.match(layer, /data-farm-scarecrow-coverage=\{scarecrowCoverageSource \? 'true' : undefined\}/);
  assert.match(layer, /data-farm-scarecrow-radius-cells=\{scarecrowCoverageSource \? FARM_SCARECROW_RADIUS_CELLS : undefined\}/);
  assert.match(layer, /data-farm-crop-stage=\{object\.crop\?\.stage \|\| undefined\}/);
  assert.match(layer, /data-farm-crop-watered=\{object\.crop \? \(object\.crop\.wateredToday \? 'true' : 'false'\) : undefined\}/);
  assert.match(layer, /data-farm-connect-kind=\{connection\?\.kind \|\| undefined\}/);
  assert.match(layer, /data-farm-connect-n=\{connection\?\.north \? 'true' : undefined\}/);
  assert.match(layer, /data-farm-connect-e=\{connection\?\.east \? 'true' : undefined\}/);
  assert.match(layer, /data-farm-connect-s=\{connection\?\.south \? 'true' : undefined\}/);
  assert.match(layer, /data-farm-connect-w=\{connection\?\.west \? 'true' : undefined\}/);
  assert.match(layer, /resourceDecorItems\?: FarmCanvasResourceDecorItem\[\]/);
  assert.match(layer, /resourceDecorById/);
  assert.match(layer, /resourceId: activeTool === 'decor' \? farmCanvas\.selectedResourceDecor\?\.resourceId : undefined/);
  assert.match(layer, /objectClassName\(object, farmCanvas\.selectedObjectId, Boolean\(resourceImageUrl\), highlightedObjectId, connection\)/);
  assert.match(layer, /data-farm-resource-id=\{object\.resourceId \|\| undefined\}/);
  assert.match(layer, /data-farm-object-placement-receipt=\{placementReceiptLabel \|\| undefined\}/);
  assert.match(layer, /t8-farm-canvas-object__badge/);
  assert.match(layer, /t8-farm-canvas-object__scarecrow-range/);
  assert.match(layer, /className="t8-farm-canvas-object__placement-receipt"[\s\S]*data-farm-object-placement-receipt-label="true"[\s\S]*\{placementReceiptLabel\}/);
  assert.match(layer, /<b>\{objectLabel\}<\/b>/);
  assert.match(layer, /<small>\{objectStatus\}<\/small>/);
  assert.match(layer, /data-farm-object-count=\{farmCanvas\.objects\.length\}/);
  assert.match(layer, /data-farm-season=\{farmCanvas\.season\}/);
  assert.match(layer, /data-farm-weather=\{farmCanvas\.weather\}/);
  assert.match(layer, /feedbacks\.slice\(0, 8\)\.map/);
  assert.match(layer, /t8-farm-canvas-feedback is-\$\{feedback\.tone\}/);
  assert.match(layer, /data-farm-feedback-id=\{feedback\.id\}/);
  assert.match(canvas, /highlightedObjectId=\{farmJumpHighlightObjectId\}/);
  assert.match(canvas, /data-farm-minimap-clickable="true"/);
  assert.match(canvas, /data-farm-minimap-route-hint-target=\{farmMiniMapRouteHint\?\.target \|\| undefined\}/);
  assert.match(canvas, /data-farm-minimap-route-hint-label=\{farmMiniMapRouteHint\?\.label \|\| undefined\}/);
  assert.match(canvas, /const farmMiniMapRouteHintMarkers = useMemo/);
  assert.match(canvas, /const farmMiniMapRouteHintCountLabel = useMemo/);
  assert.match(canvas, /data-farm-minimap-route-hint-count=\{farmMiniMapRouteHint \? farmMiniMapRouteHintMarkers\.length : undefined\}/);
  assert.match(canvas, /data-farm-minimap-route-hint-count-label=\{farmMiniMapRouteHint \? farmMiniMapRouteHintCountLabel : undefined\}/);
  assert.match(canvas, /data-farm-minimap-route-hint-empty=\{farmMiniMapRouteHint && farmMiniMapRouteHintMarkers\.length === 0 \? 'true' : undefined\}/);
  assert.match(canvas, /data-farm-minimap-route-hint-marker-id=\{farmMiniMapRouteHintMarker\?\.id \|\| undefined\}/);
  assert.match(canvas, /const markerRouteHint = farmMiniMapRouteHint \? farmMiniMapMarkerMatchesRouteTarget\(marker, farmMiniMapRouteHint\.target\) : false/);
  assert.match(canvas, /const markerRouteHintStep = markerRouteHint \? farmMiniMapRouteHintMarkers\.findIndex\(\(routeMarker\) => routeMarker\.id === marker\.id\) \+ 1 : 0/);
  assert.match(canvas, /data-farm-minimap-route-targets=\{marker\.routeTargets\?\.join\(' '\) \|\| undefined\}/);
  assert.match(canvas, /data-farm-minimap-route-hint=\{markerRouteHint \? 'true' : undefined\}/);
  assert.match(canvas, /data-farm-minimap-route-hint-active=\{markerRouteHint && marker\.id === farmMiniMapRouteHintMarker\?\.id \? 'true' : undefined\}/);
  assert.match(canvas, /data-farm-minimap-route-hint-step=\{markerRouteHintStep \|\| undefined\}/);
  assert.match(canvas, /aria-label=\{`定位\$\{marker\.label\}`\}/);
  assert.match(canvas, /onPointerDownCapture=\{\(event\) => \{[\s\S]*event\.preventDefault\(\)[\s\S]*event\.stopPropagation\(\)/);
  assert.match(canvas, /onClick=\{\(event\) => handleFarmMiniMapMarkerClick\(event, marker\)\}/);
  assert.match(css, /\.t8-farm-canvas-object\.is-jump-highlight/);
  assert.match(css, /@keyframes t8-farm-jump-highlight/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.t8-farm-canvas-object\.is-jump-highlight[\s\S]*animation: none/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.t8-farm-canvas-object__placement-receipt[\s\S]*animation: none/);
  assert.match(css, /\.t8-farm-minimap-marker \{[\s\S]*pointer-events:\s*auto/);
  assert.match(css, /\.t8-farm-minimap-marker:focus-visible/);
  assert.match(css, /Farm followup notice board v1/);
  assert.match(css, /\.t8-farm-followup-notice\[data-farm-followup-notice="top-quick-board"\] \{[\s\S]*--farm-followup-quickbar-left:\s*12px[\s\S]*--farm-followup-board-left:\s*calc\(var\(--farm-followup-quickbar-left\) \+ var\(--farm-followup-quickbar-width\) \+ 12px\)[\s\S]*position:\s*fixed[\s\S]*top:\s*calc\(56px \+ var\(--farm-command-deck-strip-height, 52px\) \+ var\(--farm-command-deck-gap, 6px\)\)/);
  assert.match(css, /\.t8-main-layout\[data-sidebar-collapsed="false"\] \.t8-farm-followup-notice\[data-farm-followup-notice="top-quick-board"\] \{[\s\S]*--farm-followup-quickbar-left:\s*calc\(var\(--t8-sidebar-width, 256px\) \+ 12px\)/);
  assert.match(css, /\.t8-farm-followup-notice\[data-farm-followup-notice="top-quick-board"\] \{[\s\S]*grid-template-columns:\s*7px 28px minmax\(0, 1fr\) max-content/);
  assert.match(css, /\.t8-farm-followup-notice__copy span[\s\S]*font-weight:\s*950/);
  assert.match(css, /\.t8-farm-followup-notice em \{[\s\S]*border-radius:\s*999px/);
  assert.match(css, /@keyframes farm-story-followup-board-in/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.t8-farm-followup-notice\[data-farm-followup-notice="top-quick-board"\][\s\S]*animation: none/);
  assert.match(css, /Farm dev-only material grant v1/);
  assert.match(css, /\.t8-farm-story-panel__dev-materials\[data-farm-dev-materials="9999"\] \{[\s\S]*border:\s*1px dashed[\s\S]*white-space:\s*nowrap/);

  assert.match(sound, /export type FarmSoundCue/);
  assert.match(sound, /FARM_SOUND_PROFILES/);
  assert.match(sound, /farmSoundCueForEvent/);
  assert.match(sound, /kind === 'rare_event'[\s\S]*return 'harvest'/);
  assert.match(sound, /farmSoundCueForTool/);
  assert.match(sound, /playFarmActionSound/);
  assert.match(sound, /AudioContext/);
  assert.match(sound, /options\.enabled === false/);
  assert.match(sound, /lastFarmSoundAt/);

  assert.match(css, /\.t8-farm-canvas-layer \{[\s\S]*pointer-events:\s*none/);
  assert.match(css, /\.t8-farm-canvas-layer\.is-editing \.t8-farm-canvas-object \{[\s\S]*pointer-events:\s*auto/);
  assert.match(css, /data-farm-season="summer"[\s\S]*\.t8-farm-canvas-object\.is-plot/);
  assert.match(css, /data-farm-season="autumn"[\s\S]*\.t8-farm-canvas-object\.is-decor-flower-bed/);
  assert.match(css, /data-farm-season="winter"[\s\S]*\.t8-farm-canvas-object/);
  assert.match(css, /\.t8-farm-canvas-object \{/);
  assert.match(css, /\.t8-farm-canvas-object\.is-plot\.is-stage-mature/);
  assert.match(css, /\.t8-farm-canvas-object\.is-selected/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building/);
  assert.match(css, /\.t8-farm-canvas-object__badge \{/);
  assert.match(css, /\.t8-farm-canvas-object__badge \{[\s\S]*box-sizing:\s*border-box[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.t8-farm-canvas-object__placement-receipt \{/);
  assert.match(css, /\.t8-farm-canvas-object\[data-farm-object-placement-receipt\] \{[\s\S]*overflow:\s*visible/);
  assert.match(css, /\.t8-farm-canvas-object__placement-receipt \{[\s\S]*width:\s*max-content[\s\S]*max-width:\s*min\(220px, calc\(100vw - 48px\)\)[\s\S]*height:\s*auto[\s\S]*white-space:\s*normal[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(css, /data-farm-object-placement-receipt="落成"[\s\S]*\.t8-farm-canvas-object__placement-receipt/);
  assert.match(css, /data-farm-object-placement-receipt="布置"[\s\S]*\.t8-farm-canvas-object__placement-receipt/);
  assert.match(css, /@keyframes farm-story-placement-receipt-pop/);
  assert.match(css, /\.t8-farm-canvas-object__badge b/);
  assert.match(css, /\.t8-farm-canvas-layer\.is-editing \.t8-farm-canvas-object:hover \.t8-farm-canvas-object__badge/);
  assert.match(css, /\.t8-farm-canvas-object\.is-selected \.t8-farm-canvas-object__badge/);
  assert.match(css, /data-farm-object-status="mature"[\s\S]*\.t8-farm-canvas-object__badge/);
  assert.match(css, /data-farm-object-status="dry"[\s\S]*\.t8-farm-canvas-object__badge/);
  assert.match(css, /data-farm-object-status="protected"[\s\S]*\.t8-farm-canvas-object__badge/);
  assert.match(css, /data-farm-object-protected="scarecrow"[\s\S]*content:\s*"守"/);
  assert.match(css, /\.t8-farm-canvas-object__scarecrow-range/);
  assert.match(css, /--farm-scarecrow-range-size/);
  assert.match(css, /data-farm-scarecrow-coverage="true"[\s\S]*\.t8-farm-canvas-object__scarecrow-range/);
  assert.match(css, /data-farm-object-status="resource-missing"[\s\S]*\.t8-farm-canvas-object__badge/);
  assert.match(css, /Farm canvas building pixel art v2/);
  assert.doesNotMatch(css, /linear-gradient\(45deg, transparent 0 42%, var\(--farm-barn\) 43% 58%, transparent 59%\)/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building \{[\s\S]*--farm-building-outline:\s*var\(--farm-wood-dark\)[\s\S]*--farm-building-shadow:/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-hut \{[\s\S]*--farm-building-roof:\s*#bf6a3c[\s\S]*--farm-building-door:\s*#7b5536/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-storage \{[\s\S]*--farm-building-roof:\s*#8f6641[\s\S]*--farm-building-wall:\s*#c88f55/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-well \{[\s\S]*--farm-building-roof:\s*#7fae8f[\s\S]*--farm-building-accent:\s*var\(--farm-water\)/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-board \{[\s\S]*--farm-building-roof:\s*#8c623a[\s\S]*--farm-building-wall:\s*#fff4d2/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-scarecrow \{[\s\S]*--farm-building-roof:\s*#d8a84f[\s\S]*--farm-building-wall:\s*#f0c35e/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-well/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-board/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-hut \.t8-farm-canvas-object__building::after \{[\s\S]*linear-gradient\(90deg, var\(--farm-building-window\)/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-storage \.t8-farm-canvas-object__building::after \{[\s\S]*repeating-linear-gradient\(90deg/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-well \.t8-farm-canvas-object__building::after \{[\s\S]*radial-gradient\(ellipse at 50% 34%, var\(--farm-building-accent\)/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-board \.t8-farm-canvas-object__building::after \{[\s\S]*box-shadow:\s*0 -8px 0/);
  assert.match(css, /\.t8-farm-canvas-object\.is-building-scarecrow \.t8-farm-canvas-object__building::after \{[\s\S]*radial-gradient\(circle at 50% 44%, var\(--farm-building-head\)/);
  assert.match(css, /\.t8-farm-canvas-object\.is-decor/);
  assert.match(css, /\.t8-farm-canvas-object\.is-connect-path/);
  assert.match(css, /\.t8-farm-canvas-object\.is-connect-fence/);
  assert.match(css, /\.t8-farm-canvas-object\.is-connect-fence \{[\s\S]*--farm-fence-rail:\s*6px[\s\S]*--farm-fence-post:\s*7px/);
  assert.match(css, /\.t8-farm-canvas-object\.is-connect-path\.is-connect-e::before/);
  assert.match(css, /\.t8-farm-canvas-object\.is-connect-path\.is-connect-s::after/);
  assert.match(css, /\.t8-farm-canvas-object\.is-connect-fence\.is-connect-e::before/);
  assert.match(css, /\.t8-farm-canvas-object\.is-connect-fence\.is-connect-s::after/);
  assert.match(css, /\.t8-farm-canvas-object\.is-decor-wood-fence/);
  assert.match(css, /\.t8-farm-canvas-object\.is-connect-fence\.is-connect-e::before,[\s\S]*\.t8-farm-canvas-object\.is-connect-fence\.is-connect-w::before \{[\s\S]*top:\s*calc\(50% - var\(--farm-fence-rail\)\)[\s\S]*height:\s*calc\(var\(--farm-fence-rail\) \* 2\)/);
  assert.match(css, /\.t8-farm-canvas-object\.is-connect-fence\.is-connect-s::after,[\s\S]*\.t8-farm-canvas-object\.is-connect-fence\.is-connect-n::after \{[\s\S]*left:\s*calc\(50% - var\(--farm-fence-rail\)\)[\s\S]*width:\s*calc\(var\(--farm-fence-rail\) \* 2\)/);
  assert.match(css, /\.t8-farm-canvas-object\.is-decor-wood-fence \.t8-farm-canvas-object__decor \{[\s\S]*width:\s*36px[\s\S]*height:\s*22px/);
  assert.match(css, /\.t8-farm-canvas-object\.is-decor-lantern/);
  assert.match(css, /\.t8-farm-canvas-object\.is-resource-decor/);
  assert.match(css, /\.t8-farm-canvas-object\.is-resource-banner/);
  assert.match(css, /\.t8-farm-canvas-object\.is-resource-missing/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost__cell/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost__icon/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost__copy/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-ready/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-target/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-blocked/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-invalid/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-hoe/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-seed/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-water/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-harvest/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-shovel/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-delete/);
  assert.match(css, /\.t8-farm-canvas-tool-ghost\.is-move/);
  assert.match(css, /@keyframes farm-story-tool-ghost-pulse/);
  assert.match(css, /prefers-reduced-motion[\s\S]*\.t8-farm-canvas-tool-ghost__cell/);
  assert.match(css, /\.t8-farm-canvas-placement/);
  assert.match(css, /\.t8-farm-canvas-placement \{[\s\S]*overflow:\s*visible/);
  assert.match(css, /\.t8-farm-canvas-placement__footprint/);
  assert.match(css, /\.t8-farm-canvas-placement__scarecrow-range/);
  assert.match(css, /data-farm-placement-scarecrow-coverage="true"[\s\S]*\.t8-farm-canvas-placement__scarecrow-range/);
  assert.match(css, /\.t8-farm-canvas-placement__icon/);
  assert.match(css, /\.t8-farm-canvas-placement__content \{[\s\S]*position:\s*absolute[\s\S]*left:\s*50%[\s\S]*top:\s*calc\(100% \+ 5px\)[\s\S]*max-width:\s*min\(240px, calc\(100vw - 48px\)\)/);
  assert.match(css, /\.t8-farm-canvas-placement__effect/);
  assert.match(css, /data-farm-placement-effect-preview-chip="true"/);
  assert.match(css, /\.t8-farm-canvas-placement\.is-ready \.t8-farm-canvas-placement__effect/);
  assert.match(css, /\.t8-farm-canvas-placement__size/);
  assert.match(css, /\.t8-farm-canvas-placement\.is-ready/);
  assert.match(css, /\.t8-farm-canvas-placement\.is-blocked/);
  assert.match(css, /\.t8-farm-canvas-placement\.is-insufficient-resources/);
  assert.match(css, /\.t8-farm-canvas-placement\.cannot-place/);
  assert.match(css, /\.t8-farm-canvas-feedback/);
  assert.match(css, /\.t8-farm-canvas-feedback \{[\s\S]*width:\s*max-content[\s\S]*max-width:\s*min\(280px, calc\(100vw - 36px\)\)[\s\S]*white-space:\s*normal[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.t8-farm-canvas-feedback\.is-water/);
  assert.match(css, /\.t8-farm-canvas-feedback\.is-reward/);
  assert.match(css, /@keyframes farm-story-feedback-pop/);
  assert.match(css, /prefers-reduced-motion[\s\S]*\.t8-farm-canvas-feedback/);
  assert.match(css, /\.t8-farm-story-panel__activity-head/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest\[data-farm-activity-reward-digest-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest:focus-visible/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest \[data-farm-activity-reward-digest-located="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest \[data-farm-activity-reward-streak-located="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest \[data-farm-activity-reward-streak-milestone-located="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest \[data-farm-activity-reward-digest-located="true"\] svg/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest \[data-farm-activity-reward-streak-located="true"\] svg/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest \[data-farm-activity-reward-streak-milestone-located="true"\] svg/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest-head em\[data-farm-activity-reward-streak="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest-head em\[data-farm-activity-reward-streak="true"\]\[data-farm-activity-reward-streak-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest-head em\[data-farm-activity-reward-streak="true"\]:focus-visible/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest-head em\[data-farm-activity-reward-streak="true"\] \{[\s\S]*max-width:\s*74px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest small\[data-farm-activity-reward-streak-hint="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest small\[data-farm-activity-reward-streak-hint="true"\] \{[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest\[data-farm-activity-reward-streak-tier="festival"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest small\[data-farm-activity-reward-streak-milestone="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest small\[data-farm-activity-reward-streak-milestone="true"\]\[data-farm-activity-reward-streak-milestone-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest small\[data-farm-activity-reward-streak-milestone="true"\]:focus-visible/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest small\[data-farm-activity-reward-streak-milestone="true"\] \{[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /@keyframes farm-story-activity-anchor-focus/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*data-farm-activity-reward-digest-focus="true"[\s\S]*data-farm-activity-reward-streak-focus="true"[\s\S]*data-farm-activity-reward-streak-milestone-focus="true"[\s\S]*data-farm-activity-reward-digest-located="true"[\s\S]*data-farm-activity-reward-streak-located="true"[\s\S]*data-farm-activity-reward-streak-milestone-located="true"[\s\S]*animation:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest\.is-reward/);
  assert.match(css, /\.t8-farm-story-panel__activity-digest\.is-busy/);
  assert.match(css, /\.t8-farm-story-panel__activity-meter/);
  assert.match(css, /\.t8-farm-story-panel__activity-chips/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-focus="true"\] svg/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-focus-kind-chip="true"\]/);
  assert.match(css, /\[data-farm-activity-empty-focus-kind="urgent"\] \[data-farm-activity-empty-focus-kind-chip="true"\]/);
  assert.match(css, /\[data-farm-activity-empty-focus-kind="reward"\] \[data-farm-activity-empty-focus-kind-chip="true"\]/);
  assert.match(css, /\[data-farm-activity-empty-focus-kind="build"\] \[data-farm-activity-empty-focus-kind-chip="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-focus="true"\] small/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-focus-status-chip="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-item\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-actionable="true"\] \{[\s\S]*border:\s*0[\s\S]*cursor:\s*pointer[\s\S]*transition:\s*transform \.14s ease, box-shadow \.14s ease, filter \.14s ease/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-actionable="true"\]::after \{[\s\S]*content:\s*"可做"[\s\S]*font-size:\s*7px/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-action-progress-label\]::after \{[\s\S]*content:\s*attr\(data-farm-activity-empty-forecast-action-progress-label\)/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-action-progress-value="true"\] \{[\s\S]*max-width:\s*34px[\s\S]*cursor:\s*help[\s\S]*text-overflow:\s*ellipsis[\s\S]*transition:\s*transform \.14s ease, box-shadow \.14s ease, filter \.14s ease/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-action-progress-value="true"\]:hover \{[\s\S]*transform:\s*translateY\(-1px\) scale\(1\.06\)[\s\S]*filter:\s*saturate\(1\.12\)[\s\S]*box-shadow:/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-farm-activity-empty-forecast-action-progress-value="true"\],[\s\S]*\[data-farm-activity-empty-forecast-action-progress-value="true"\]:hover \{[\s\S]*transition:\s*none[\s\S]*transform:\s*none[\s\S]*filter:\s*none/);
  assert.match(css, /\[data-farm-activity-empty-forecast-actionable="true"\]:focus-visible \[data-farm-activity-empty-forecast-action-progress-value="true"\] \{[\s\S]*outline:\s*1px solid color-mix\(in srgb, currentColor 42%, transparent\)[\s\S]*box-shadow:/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-action-progress-state="next"\] \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-sky\)/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-action-progress-state="ready"\] \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-leaf\)/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-action-progress-state="complete"\] \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-gold\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-actionable="true"\]:hover:not\(:disabled\),[\s\S]*\[data-farm-activity-empty-forecast-actionable="true"\]:focus-visible \{[\s\S]*transform:\s*translateY\(-1px\)[\s\S]*box-shadow:/);
  assert.match(css, /\[data-farm-activity-empty-forecast-actionable="true"\]:disabled \{[\s\S]*cursor:\s*not-allowed[\s\S]*opacity:\s*\.72/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast\[data-farm-activity-empty-forecast-busy-label\]::before \{[\s\S]*content:\s*"执行中 " attr\(data-farm-activity-empty-forecast-busy-label\)[\s\S]*order:\s*-2[\s\S]*max-width:\s*100%[\s\S]*text-overflow:\s*ellipsis[\s\S]*animation:\s*farm-story-activity-empty-forecast-busy-ticket/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast\[data-farm-activity-empty-forecast-busy-label\]::before \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-water\) 22%, var\(--farm-cream\)\)[\s\S]*box-shadow:/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast\[data-farm-activity-empty-forecast-busy-meta\]::after \{[\s\S]*content:\s*attr\(data-farm-activity-empty-forecast-busy-meta\)[\s\S]*order:\s*-1[\s\S]*max-width:\s*100%[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast\[data-farm-activity-empty-forecast-busy-meta\]::after \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-wheat\) 20%, var\(--farm-cream\)\)[\s\S]*box-shadow:/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast\[data-farm-activity-empty-forecast-busy-progress-label\]::after \{[\s\S]*content:\s*attr\(data-farm-activity-empty-forecast-busy-progress-label\) " · " attr\(data-farm-activity-empty-forecast-busy-meta\)/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast\[data-farm-activity-empty-forecast-busy-progress-state="next"\]::after \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-sky\)/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast\[data-farm-activity-empty-forecast-busy-progress-state="ready"\]::after \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-leaf\)/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast\[data-farm-activity-empty-forecast-busy-progress-state="complete"\]::after \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-gold\)/);
  assert.match(css, /@keyframes farm-story-activity-empty-forecast-busy-ticket/);
  assert.match(css, /\[data-farm-activity-empty-forecast-busy="true"\] \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-sky\) 26%, var\(--farm-cream\)\)[\s\S]*box-shadow:/);
  assert.match(css, /\[data-farm-activity-empty-forecast-busy="true"\]::after \{[\s\S]*content:\s*"执行中"[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-water\) 24%, var\(--farm-cream\)\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.t8-farm-story-panel__activity-empty-forecast\[data-farm-activity-empty-forecast-busy-label\]::before[\s\S]*animation:\s*none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-farm-activity-empty-forecast-actionable="true"\][\s\S]*\[data-farm-activity-empty-forecast-actionable="true"\]:hover:not\(:disabled\)[\s\S]*\[data-farm-activity-empty-forecast-actionable="true"\]:focus-visible[\s\S]*transition: none[\s\S]*transform: none/);
  assert.match(css, /\[data-farm-activity-empty-forecast-tone="action"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-tone="resource"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-tone="progress"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast\[data-farm-activity-empty-forecast-linked="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-receipt-result="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \[data-farm-activity-empty-forecast-receipt-chips="true"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-chip="resource"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-chip="activity"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-chip="progress"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-chip="next-type"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-chip="next-type"\] \{[\s\S]*display:\s*inline-flex[\s\S]*align-items:\s*center[\s\S]*gap:\s*3px[\s\S]*max-width:\s*92px/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-chip="next-type"\] \{[\s\S]*animation:\s*farm-story-activity-empty-forecast-next-type-pop/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-chip="next-type"\] \{[\s\S]*cursor:\s*help[\s\S]*transition:\s*transform \.16s ease, box-shadow \.16s ease, background \.16s ease/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-count="true"\] \{[\s\S]*flex:\s*0 0 auto[\s\S]*max-width:\s*30px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-count="true"\] \{[\s\S]*cursor:\s*help[\s\S]*transition:\s*transform \.14s ease, box-shadow \.14s ease, filter \.14s ease/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-count="true"\]:hover \{[\s\S]*transform:\s*translateY\(-1px\) scale\(1\.06\)[\s\S]*filter:\s*saturate\(1\.12\)[\s\S]*box-shadow:/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-count-target="water"\] \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-sky\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-count-target="cleanup"\] \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-soil\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-count-target="scarecrow"\] \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-wood\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-count-target="reward"\] \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-gold\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-count-target="social"\] \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-berry\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-chip="next-type"\]:hover \{[\s\S]*transform:\s*translateY\(-1px\) scale\(1\.04\)[\s\S]*box-shadow:/);
  assert.match(css, /@keyframes farm-story-activity-empty-forecast-next-type-pop/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-farm-activity-empty-forecast-receipt-chip="next-type"\][\s\S]*\[data-farm-activity-empty-forecast-receipt-chip="next-type"\]:hover[\s\S]*\[data-farm-activity-empty-forecast-receipt-next-type-count="true"\][\s\S]*\[data-farm-activity-empty-forecast-receipt-next-type-count="true"\]:hover[\s\S]*animation: none[\s\S]*transition: none[\s\S]*transform: none/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-target="water"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-target="cleanup"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-target="scarecrow"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-target="reward"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-target="social"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-target="water"\]:hover \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-sky\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-target="cleanup"\]:hover \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-soil\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-target="scarecrow"\]:hover \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-wood\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-target="reward"\]:hover \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-gold\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-type-target="social"\]:hover \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-berry\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-progress-state="ready"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-progress-state="complete"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-progress-state-label="true"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-progress-value="true"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next="true"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-target="water"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-target="cleanup"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-target="scarecrow"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-target="reward"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-target="social"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-badge="true"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy="true"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-count="true"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-count-target="water"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-count-target="cleanup"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-count-target="scarecrow"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-count-target="reward"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-count-target="social"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-badge-target="water"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-badge-target="cleanup"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-badge-target="scarecrow"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-badge-target="reward"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-badge-target="social"\]/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-badge="true"\] \{[\s\S]*animation:\s*farm-story-activity-empty-forecast-next-badge-pop/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-badge="true"\] \{[\s\S]*cursor:\s*help[\s\S]*transition:\s*transform \.16s ease, box-shadow \.16s ease, background \.16s ease/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-badge="true"\]:hover \{[\s\S]*transform:\s*translateY\(-1px\) scale\(1\.04\)[\s\S]*box-shadow:/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy="true"\] \{[\s\S]*cursor:\s*help[\s\S]*transition:\s*background \.16s ease, box-shadow \.16s ease, color \.16s ease/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy="true"\]:hover \{[\s\S]*background:[\s\S]*box-shadow:/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target-label\]::before \{[\s\S]*content:\s*attr\(data-farm-activity-empty-forecast-receipt-next-copy-target-label\) "："/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target-label\]::before \{[\s\S]*display:\s*inline-block[\s\S]*margin-right:\s*2px[\s\S]*padding:\s*0 3px[\s\S]*border-radius:\s*999px[\s\S]*box-shadow:/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target="water"\]::before \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-sky\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target="cleanup"\]::before \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-soil\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target="scarecrow"\]::before \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-wood\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target="reward"\]::before \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-gold\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target="social"\]::before \{[\s\S]*background:\s*color-mix\(in srgb, var\(--farm-berry\)/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target="water"\]:hover/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target="cleanup"\]:hover/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target="scarecrow"\]:hover/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target="reward"\]:hover/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-copy-target="social"\]:hover/);
  assert.match(css, /@keyframes farm-story-activity-empty-forecast-next-badge-pop/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-count="true"\] \{[\s\S]*animation:\s*farm-story-activity-empty-forecast-next-count-pop/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-count="true"\] \{[\s\S]*cursor:\s*help[\s\S]*transition:\s*transform \.16s ease, box-shadow \.16s ease, background \.16s ease/);
  assert.match(css, /\[data-farm-activity-empty-forecast-receipt-next-count="true"\]:hover \{[\s\S]*transform:\s*translateY\(-1px\) scale\(1\.04\)[\s\S]*box-shadow:/);
  assert.match(css, /@keyframes farm-story-activity-empty-forecast-next-count-pop/);
  assert.match(css, /@keyframes farm-story-activity-empty-forecast-confirm/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-farm-activity-empty-forecast-receipt-next-badge="true"\][\s\S]*animation: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-farm-activity-empty-forecast-receipt-next-badge="true"\][\s\S]*transition: none[\s\S]*transform: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-farm-activity-empty-forecast-receipt-next-copy="true"\][\s\S]*transition: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-farm-activity-empty-forecast-receipt-next-count="true"\][\s\S]*animation: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\[data-farm-activity-empty-forecast-receipt-next-count="true"\][\s\S]*transition: none[\s\S]*transform: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*data-farm-activity-empty-forecast-linked="true"[\s\S]*animation: none/);
  assert.match(css, /data-farm-activity-empty-focus-ready="true"[\s\S]*data-farm-activity-empty-focus-status-chip="true"/);
  assert.match(css, /data-farm-activity-empty-focus-complete="true"[\s\S]*data-farm-activity-empty-focus-status-chip="true"/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-focus-action-linked="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-focus-action-linked="true"\]::after[\s\S]*content:\s*"已推进"/);
  assert.match(css, /@keyframes farm-story-activity-empty-focus-linked/);
  assert.match(css, /data-farm-activity-empty-focus-kind="urgent"/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-action="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-action-fired="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-action="true"\] svg/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-action-resource="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-action-progress="true"\]/);
  assert.match(css, /@keyframes farm-story-activity-empty-action-feedback/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*data-farm-activity-empty-action-fired="true"[\s\S]*animation: none/);
  assert.match(css, /\.t8-farm-story-panel__activity-copy em\[data-farm-activity-reward-label="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-copy em\[data-farm-activity-reward-label="true"\] \{[\s\S]*max-width:\s*78px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__activity-tag/);
  assert.match(css, /data-farm-activity-tone="water"/);
  assert.match(css, /data-farm-activity-tone="reward"/);
  assert.match(css, /\.t8-farm-story-panel__activity-copy/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-label/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item > svg/);
  assert.match(css, /button\.t8-farm-story-panel__live-feedback-item/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\.is-actionable:hover/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\.is-actionable:focus-visible/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\[data-farm-feedback-action-busy="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\[data-farm-feedback-action-result\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\[data-farm-feedback-action-busy="true"\]::after/);
  assert.match(css, /animation:\s*farm-story-live-feedback-cooldown 1\.2s linear both/);
  assert.match(css, /@keyframes farm-story-live-feedback-cooldown/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.t8-farm-story-panel__live-feedback-item\[data-farm-feedback-action-busy="true"\]::after[\s\S]*animation: none/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item small/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item em\[data-farm-feedback-action-resource="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item em\[data-farm-feedback-action-progress="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\[data-farm-feedback-action-focus-linked="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\[data-farm-feedback-action-progress-result\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\[data-farm-feedback-action-completes-focus\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item em\[data-farm-feedback-action-completes-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item em\[data-farm-feedback-action-completion-result="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback\[data-farm-live-feedback-completion-notice\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="select-tool"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="jump-mature"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="complete-order"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="complete-npc"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="select-building"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="select-decor"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="advance-day"\]/);
  assert.match(css, /data-farm-feedback-action-resource-targets~="water"/);
  assert.match(css, /data-farm-feedback-action-resource-targets~="gold"/);
  assert.match(css, /data-farm-feedback-action-resource-targets~="seed"/);
  assert.match(css, /data-farm-feedback-action-resource-targets~="beauty"/);
  assert.match(css, /data-farm-feedback-action-resource-targets~="wood"/);
  assert.match(css, /data-farm-feedback-action-resource-targets~="stone"/);
  assert.match(css, /data-farm-feedback-action-resource-targets~="mature"/);
  assert.match(css, /data-farm-feedback-action-resource-targets~="withered"/);
  assert.match(css, /data-farm-feedback-action-resource-targets~="day"/);
  assert.match(css, /data-farm-feedback-action="select-tool"/);
  assert.match(css, /data-farm-feedback-action="jump-mature"/);
  assert.match(css, /data-farm-feedback-action="complete-order"/);
  assert.match(css, /data-farm-feedback-action="complete-npc"/);
  assert.match(css, /data-farm-feedback-action="select-building"/);
  assert.match(css, /data-farm-feedback-action="select-decor"/);
  assert.match(css, /data-farm-feedback-action="advance-day"/);
  assert.match(panel, /function farmFocusActionMatches\(left\?: FarmFocusGoalAction, right\?: FarmFocusGoalAction\)/);
  assert.match(panel, /const liveFeedbackFocusLinked = item\.action \? farmFocusActionMatches\(item\.action, primaryFarmFocus\?\.action\) : false/);
  assert.match(panel, /const liveFeedbackProgressPreview = liveFeedbackFocusLinked \? primaryFarmFocusProgressPreview : ''/);
  assert.match(panel, /liveFeedbackProgressPreview[\s\S]*\{liveFeedbackProgressPreview\.replace\('预计：', '进度 '\)\}/);
  assert.match(panel, /data-farm-feedback-action-focus-linked=\{liveFeedbackFocusLinked \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-feedback-action-progress-preview=\{liveFeedbackProgressPreview \|\| undefined\}/);
  assert.match(panel, /data-farm-feedback-action-next-progress=\{liveFeedbackFocusLinked && primaryFarmFocus \? primaryFarmFocusNextProgress : undefined\}/);
  assert.match(panel, /data-farm-feedback-action-target=\{liveFeedbackFocusLinked && primaryFarmFocus \? primaryFarmFocus\.target : undefined\}/);
  assert.match(panel, /const liveFeedbackProgressResult = liveFeedbackActionActive && liveFeedbackFocusLinked[\s\S]*liveFeedbackProgressPreview\.replace\('预计：', '已推进 '\)/);
  assert.match(panel, /liveFeedbackProgressResult && \([\s\S]*data-farm-feedback-action-progress-result="true"[\s\S]*\{liveFeedbackProgressResult\}/);
  assert.match(panel, /data-farm-feedback-action-progress-result=\{liveFeedbackProgressResult \|\| undefined\}/);
  assert.match(panel, /const liveFeedbackCompletesFocus = liveFeedbackFocusLinked && primaryFarmFocus[\s\S]*primaryFarmFocusNextProgress >= primaryFarmFocus\.target[\s\S]*!primaryFarmFocusComplete/);
  assert.match(panel, /const liveFeedbackCompletionResult = liveFeedbackActionActive && liveFeedbackCompletesFocus \? '已达成目标' : ''/);
  assert.match(panel, /liveFeedbackCompletesFocus && \([\s\S]*data-farm-feedback-action-completes-focus="true"[\s\S]*将完成/);
  assert.match(panel, /liveFeedbackCompletionResult && \([\s\S]*data-farm-feedback-action-completion-result="true"[\s\S]*\{liveFeedbackCompletionResult\}/);
  assert.match(panel, /data-farm-feedback-action-completes-focus=\{liveFeedbackCompletesFocus \? 'true' : undefined\}/);
  assert.match(panel, /data-farm-feedback-action-completion-result=\{liveFeedbackCompletionResult \|\| undefined\}/);
  assert.match(panel, /interface FarmLiveFeedbackCompletionReceipt[\s\S]*itemId: string[\s\S]*goalId: string[\s\S]*goalTitle: string[\s\S]*icon: typeof Sparkles[\s\S]*goalKind: FarmFocusGoal\['kind'\][\s\S]*goalKindLabel: string[\s\S]*resourceTargets: FarmActionResourceTarget\[\][\s\S]*resourceLabel: string[\s\S]*progress: number[\s\S]*target: number[\s\S]*progressLabel: string[\s\S]*summaryLabel: string[\s\S]*actionKind\?: FarmFocusGoalAction\['kind'\]/);
  assert.match(panel, /function farmFocusGoalKindLabel\(kind: FarmFocusGoal\['kind'\]\)/);
  assert.match(panel, /case 'urgent':[\s\S]*return '紧急'[\s\S]*case 'growth':[\s\S]*return '成长'[\s\S]*case 'reward':[\s\S]*return '收获'[\s\S]*case 'social':[\s\S]*return '来访'[\s\S]*case 'build':[\s\S]*return '建造'[\s\S]*case 'decorate':[\s\S]*return '装饰'[\s\S]*case 'season':[\s\S]*return '换季'/);
  assert.match(panel, /function farmLiveFeedbackCompletionSummaryLabel\(receipt: Pick<FarmLiveFeedbackCompletionReceipt, 'goalTitle' \| 'actionLabel' \| 'goalKindLabel' \| 'progressLabel' \| 'resourceLabel'>\)/);
  assert.match(panel, /const resourcePart = receipt\.resourceLabel \? `，资源 \$\{receipt\.resourceLabel\}` : ''/);
  assert.match(panel, /return `小目标完成：\$\{receipt\.goalTitle\}，动作 \$\{receipt\.actionLabel\}，类型 \$\{receipt\.goalKindLabel\}，\$\{receipt\.progressLabel\}\$\{resourcePart\}`/);
  assert.match(panel, /function FarmLiveFeedbackCompletionIcon\(\{ icon: CompletionIcon \}: \{ icon: typeof Sparkles \}\)/);
  assert.match(panel, /<CompletionIcon size=\{11\} data-farm-live-feedback-completion-icon="true" aria-hidden="true" \/>/);
  assert.match(panel, /const \[farmLiveFeedbackCompletionReceipt, setFarmLiveFeedbackCompletionReceipt\] = useState<FarmLiveFeedbackCompletionReceipt \| null>\(null\)/);
  assert.match(panel, /setFarmLiveFeedbackCompletionReceipt\(null\)/);
  assert.match(panel, /const farmLiveFeedbackCompletionResourceTargets = farmActionResourceTargets\(item\.action\)/);
  assert.match(panel, /const farmLiveFeedbackCompletionResourceLabel = farmActionResourcePreviewLabel\(farmLiveFeedbackCompletionResourceTargets\)\.replace\('预期：', ''\)/);
  assert.match(panel, /const completionReceipt = item\.action && primaryFarmFocus[\s\S]*farmFocusActionMatches\(item\.action, primaryFarmFocus\.action\)[\s\S]*primaryFarmFocusNextProgress >= primaryFarmFocus\.target[\s\S]*!primaryFarmFocusComplete[\s\S]*goalKind: primaryFarmFocus\.kind[\s\S]*goalKindLabel: farmFocusGoalKindLabel\(primaryFarmFocus\.kind\)[\s\S]*resourceTargets: farmLiveFeedbackCompletionResourceTargets[\s\S]*resourceLabel: farmLiveFeedbackCompletionResourceLabel[\s\S]*progress: Math\.min\(primaryFarmFocusNextProgress, primaryFarmFocus\.target\)[\s\S]*target: primaryFarmFocus\.target[\s\S]*progressLabel: `达成 \$\{Math\.min\(primaryFarmFocusNextProgress, primaryFarmFocus\.target\)\}\/\$\{primaryFarmFocus\.target\}`[\s\S]*summaryLabel: farmLiveFeedbackCompletionSummaryLabel/);
  assert.match(panel, /const completionReceipt = item\.action && primaryFarmFocus[\s\S]*icon: item\.icon[\s\S]*goalKind: primaryFarmFocus\.kind/);
  assert.match(panel, /setFarmLiveFeedbackCompletionReceipt\(completionReceipt\)/);
  assert.match(panel, /const farmLiveFeedbackCompletionNotice = farmLiveFeedbackCompletionReceipt &&[\s\S]*farmSummaryDetailActionFeedbackItemId === farmLiveFeedbackCompletionReceipt\.itemId[\s\S]*Boolean\(farmSummaryDetailActionFeedback\)[\s\S]*\? farmLiveFeedbackCompletionReceipt[\s\S]*: null/);
  assert.match(panel, /data-farm-live-feedback-completion-notice=\{farmLiveFeedbackCompletionNotice \? 'true' : undefined\}/);
  assert.match(panel, /farmLiveFeedbackCompletionNotice && \([\s\S]*className="t8-farm-story-panel__live-feedback-completion-notice"[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*aria-label=\{farmLiveFeedbackCompletionNotice\.summaryLabel\}[\s\S]*data-farm-live-feedback-completion-goal=\{farmLiveFeedbackCompletionNotice\.goalId\}[\s\S]*data-farm-live-feedback-completion-kind=\{farmLiveFeedbackCompletionNotice\.goalKind\}[\s\S]*data-farm-live-feedback-completion-resources=\{farmLiveFeedbackCompletionNotice\.resourceTargets\.join\(' '\) \|\| undefined\}[\s\S]*data-farm-live-feedback-completion-summary=\{farmLiveFeedbackCompletionNotice\.summaryLabel\}[\s\S]*\{farmLiveFeedbackCompletionNotice\.goalTitle\}/);
  assert.match(panel, /title=\{farmLiveFeedbackCompletionNotice\.summaryLabel\}/);
  assert.match(panel, /<FarmLiveFeedbackCompletionIcon icon=\{farmLiveFeedbackCompletionNotice\.icon\} \/>/);
  assert.match(panel, /<b data-farm-live-feedback-completion-kind="true">\{farmLiveFeedbackCompletionNotice\.goalKindLabel\}<\/b>/);
  assert.match(panel, /<em data-farm-live-feedback-completion-action-label="true">\{farmLiveFeedbackCompletionNotice\.actionLabel\}<\/em>/);
  assert.match(panel, /<small data-farm-live-feedback-completion-progress="true">\{farmLiveFeedbackCompletionNotice\.progressLabel\}<\/small>/);
  assert.match(panel, /farmLiveFeedbackCompletionNotice\.resourceLabel && \([\s\S]*<i data-farm-live-feedback-completion-resource="true">\{farmLiveFeedbackCompletionNotice\.resourceLabel\}<\/i>[\s\S]*\)/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice b\[data-farm-live-feedback-completion-kind="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice \[data-farm-live-feedback-completion-icon="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="select-tool"\] \[data-farm-live-feedback-completion-icon="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="jump-mature"\] \[data-farm-live-feedback-completion-icon="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="complete-order"\] \[data-farm-live-feedback-completion-icon="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="complete-npc"\] \[data-farm-live-feedback-completion-icon="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="select-building"\] \[data-farm-live-feedback-completion-icon="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="select-decor"\] \[data-farm-live-feedback-completion-icon="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-action="advance-day"\] \[data-farm-live-feedback-completion-icon="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-kind="urgent"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-kind="growth"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-kind="reward"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-kind="social"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-kind="build"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-kind="decorate"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice\[data-farm-live-feedback-completion-kind="season"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice em\[data-farm-live-feedback-completion-action-label="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice small\[data-farm-live-feedback-completion-progress="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice i\[data-farm-live-feedback-completion-resource="true"\]/);
  assert.match(css, /data-farm-live-feedback-completion-resources~="water"/);
  assert.match(css, /data-farm-live-feedback-completion-resources~="gold"/);
  assert.match(css, /data-farm-live-feedback-completion-resources~="seed"/);
  assert.match(css, /data-farm-live-feedback-completion-resources~="wood"/);
  assert.match(css, /data-farm-live-feedback-completion-resources~="stone"/);
  assert.match(css, /data-farm-live-feedback-completion-resources~="mature"/);
  assert.match(css, /data-farm-live-feedback-completion-resources~="withered"/);
  assert.match(css, /data-farm-live-feedback-completion-resources~="beauty"/);
  assert.match(css, /data-farm-live-feedback-completion-resources~="day"/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice \{[\s\S]*max-width:\s*100%[\s\S]*flex-wrap:\s*wrap/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice span \{[\s\S]*flex:\s*1 1 96px[\s\S]*max-width:\s*100%/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__live-feedback-completion-notice \{[\s\S]*gap:\s*4px[\s\S]*padding:\s*4px 5px/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__live-feedback-completion-notice b\[data-farm-live-feedback-completion-kind="true"\][\s\S]*max-width:\s*40px[\s\S]*\.t8-farm-story-panel__live-feedback-completion-notice em\[data-farm-live-feedback-completion-action-label="true"\][\s\S]*max-width:\s*58px[\s\S]*\.t8-farm-story-panel__live-feedback-completion-notice small\[data-farm-live-feedback-completion-progress="true"\][\s\S]*max-width:\s*54px[\s\S]*\.t8-farm-story-panel__live-feedback-completion-notice i\[data-farm-live-feedback-completion-resource="true"\][\s\S]*max-width:\s*52px/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-completion-notice::after/);
  assert.match(css, /animation:\s*farm-story-live-feedback-harvest-glint 1\.2s ease-out both/);
  assert.match(css, /@keyframes farm-story-live-feedback-harvest-glint/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.t8-farm-story-panel__live-feedback-completion-notice::after[\s\S]*animation: none/);
  assert.match(css, /data-farm-feedback-kind="reward"/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item small\[data-farm-live-reward-kind-label="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item small\[data-farm-live-reward-kind-label="true"\] \{[\s\S]*max-width:\s*68px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\[data-farm-reward-kind="festival"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\[data-farm-reward-kind="festival"\] > svg/);
  assert.match(css, /data-farm-feedback-kind="mature"/);
  assert.match(css, /data-farm-feedback-kind="water"/);
  assert.match(css, /data-farm-feedback-kind="cleanup"/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\[data-farm-feedback-kind="build"\]/);
  assert.match(css, /\.t8-farm-story-panel__live-feedback-item\[data-farm-feedback-action-resource-targets~="scarecrow"\] \[data-farm-feedback-action-resource="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status/);
  assert.match(css, /\.t8-farm-story-panel__mini-status::before/);
  assert.match(css, /\.t8-farm-story-panel__mini-status span/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \{[\s\S]*flex-wrap:\s*wrap/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__mini-status \{[\s\S]*left:\s*8px[\s\S]*right:\s*8px[\s\S]*width:\s*auto[\s\S]*max-height:\s*88px[\s\S]*overflow:\s*hidden/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__mini-status::before \{[\s\S]*display:\s*none/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*data-farm-mini-status-item="wood"[\s\S]*data-farm-mini-status-item="focus-meter"[\s\S]*data-farm-mini-status-item="activity-meter"[\s\S]*display:\s*none/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*data-farm-mini-status-item="resource-feedback"[\s\S]*data-farm-mini-status-item="activity-feedback"[\s\S]*max-width:\s*96px/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*data-farm-mini-status-item="resource-feedback"[\s\S]*data-farm-mini-status-item="activity-feedback"[\s\S]*>\s*b \{[\s\S]*max-width:\s*72px/);
  assert.match(css, /@media \(max-width: 430px\) \{[\s\S]*\.t8-farm-story-panel__mini-status \{[\s\S]*left:\s*8px[\s\S]*right:\s*8px[\s\S]*width:\s*auto[\s\S]*max-height:\s*76px/);
  assert.match(css, /@media \(max-width: 430px\) \{[\s\S]*data-farm-mini-status-item="activity"[\s\S]*data-farm-mini-status-item="activity-reward"[\s\S]*display:\s*none/);
  assert.match(css, /@media \(max-width: 430px\) \{[\s\S]*data-farm-mini-status-item="resource-feedback"[\s\S]*data-farm-mini-status-item="activity-feedback"[\s\S]*data-farm-mini-status-item="focus-action-feedback"[\s\S]*display:\s*none/);
  assert.match(css, /data-farm-mini-status-item="season"/);
  assert.match(css, /data-farm-mini-status-item="weather"/);
  assert.match(css, /button\[data-farm-mini-status-item="season"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="weather"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="season"\]\[data-farm-mini-season-opened="true"\]::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /button\[data-farm-mini-status-item="weather"\]\[data-farm-mini-weather-opened="true"\]::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /@keyframes farm-story-mini-season-located/);
  assert.match(css, /@keyframes farm-story-mini-seed-tool/);
  assert.match(css, /@keyframes farm-story-mini-water-tool/);
  assert.match(css, /@keyframes farm-story-mini-build-tool/);
  assert.match(css, /data-farm-mini-status-item="gold"/);
  assert.match(css, /data-farm-mini-status-item="seed"/);
  assert.match(css, /data-farm-mini-status-item="water"/);
  assert.match(css, /button\[data-farm-mini-status-item="seed"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="water"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="seed"\]\[data-farm-mini-seed-tool-opened="true"\]::after[\s\S]*content:\s*"已切播种"/);
  assert.match(css, /button\[data-farm-mini-status-item="water"\]\[data-farm-mini-water-tool-opened="true"\]::after[\s\S]*content:\s*"已切水壶"/);
  assert.match(css, /data-farm-mini-status-item="wood"/);
  assert.match(css, /data-farm-mini-status-item="stone"/);
  assert.match(css, /button\[data-farm-mini-status-item="wood"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="stone"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="wood"\]\[data-farm-mini-wood-build-opened="true"\]::after[\s\S]*content:\s*"已切建造"/);
  assert.match(css, /button\[data-farm-mini-status-item="stone"\]\[data-farm-mini-stone-build-opened="true"\]::after[\s\S]*content:\s*"已切建造"/);
  assert.match(css, /data-farm-mini-building-effect="well"/);
  assert.match(css, /data-farm-mini-building-effect="storage"/);
  assert.match(css, /data-farm-mini-building-effect="board"/);
  assert.match(css, /data-farm-mini-building-effect="scarecrow"/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-building-yields\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-building-yields\] \{[\s\S]*animation:\s*farm-story-mini-building-yield-glow/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-placement-receipt\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-placement-receipt-kind="building"\] \[data-farm-mini-status-item="building-yield-summary"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-placement-receipt-kind="decor"\] \[data-farm-mini-status-item="beauty"\]/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target="water"[\s\S]*data-farm-mini-status-item="water"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target="ready-order"[\s\S]*data-farm-mini-status-item="ready-order"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target="scarecrow-risk"[\s\S]*data-farm-mini-status-item="scarecrow-risk"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target="day"[\s\S]*data-farm-mini-status-item="day"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target="beauty"[\s\S]*data-farm-mini-status-item="beauty"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target="building-yield-summary"[\s\S]*data-farm-mini-status-item="building-yield-summary"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target[\s\S]*::after[\s\S]*content:\s*"目标"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target-opened="true"[\s\S]*data-farm-mini-placement-receipt-next-target="water"[\s\S]*data-farm-mini-status-item="water"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target-opened="true"[\s\S]*data-farm-mini-placement-receipt-next-target="ready-order"[\s\S]*data-farm-mini-status-item="ready-order"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target-opened="true"[\s\S]*data-farm-mini-placement-receipt-next-target="scarecrow-risk"[\s\S]*data-farm-mini-status-item="scarecrow-risk"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target-opened="true"[\s\S]*data-farm-mini-placement-receipt-next-target="day"[\s\S]*data-farm-mini-status-item="day"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target-opened="true"[\s\S]*data-farm-mini-placement-receipt-next-target="beauty"[\s\S]*data-farm-mini-status-item="beauty"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target-opened="true"[\s\S]*data-farm-mini-placement-receipt-next-target="building-yield-summary"[\s\S]*data-farm-mini-status-item="building-yield-summary"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target-opened[\s\S]*::after[\s\S]*content:\s*"已接入"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target-opened-chip="true"/);
  assert.match(css, /data-farm-mini-placement-receipt-next-target-opened="true"[\s\S]*t8-farm-story-panel__mini-placement-receipt/);
  assert.match(css, /data-farm-mini-placement-receipt-followup[\s\S]*t8-farm-story-panel__mini-placement-receipt/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-text="true"/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-target="water"[\s\S]*data-farm-mini-placement-receipt-followup-text="true"/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-target="beauty"[\s\S]*data-farm-mini-placement-receipt-followup-text="true"/);
  assert.match(css, /\.t8-farm-story-panel__mini-placement-followup-action/);
  assert.match(css, /button\.t8-farm-story-panel__mini-placement-followup-action\[data-farm-mini-placement-receipt-followup-action="true"\]/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-action-target="water"/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-action-target="beauty"/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-action-receipt/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-action-count/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-action-resource/);
  assert.match(css, /data-farm-mini-placement-followup-action-count="true"/);
  assert.match(css, /data-farm-mini-placement-followup-action-resource="true"/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-route="true"\]\[data-farm-mini-placement-receipt-followup-target="water"\][\s\S]*data-farm-mini-status-item="water"/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-route="true"\]\[data-farm-mini-placement-receipt-followup-target="ready-order"\][\s\S]*data-farm-mini-status-item="ready-order"/);
  assert.match(css, /data-farm-mini-placement-followup-route="true"[\s\S]*content:\s*"预期 " attr\(data-farm-mini-placement-followup-route-count\) " · " attr\(data-farm-mini-placement-followup-route-resource\)/);
  assert.match(css, /@keyframes farm-story-mini-placement-followup-route/);
  assert.match(css, /\.t8-farm-story-panel__mini-placement-route-hint/);
  assert.match(css, /button\.t8-farm-story-panel__mini-placement-route-hint\[data-farm-mini-placement-receipt-followup-route-hint="true"\]/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-route-hint-target="water"/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-route-hint-target="ready-order"/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-route-hint-target="scarecrow-risk"/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-route-hint-receipt/);
  assert.match(css, /data-farm-mini-placement-route-hint-count="true"/);
  assert.match(css, /@keyframes farm-story-mini-placement-route-hint/);
  assert.match(css, /data-farm-mini-placement-receipt-followup-route-receipt[\s\S]*data-farm-mini-placement-followup-route="true"[\s\S]*::after[\s\S]*content:\s*"已指路"/);
  assert.match(css, /@keyframes farm-story-mini-placement-route-target-receipt/);
  assert.match(css, /\.t8-farm-minimap-markers\[data-farm-minimap-route-hint-target\]/);
  assert.match(css, /\.t8-farm-minimap-markers\[data-farm-minimap-route-hint-target\]::after[\s\S]*content:\s*"路线 " attr\(data-farm-minimap-route-hint-label\) " · " attr\(data-farm-minimap-route-hint-count-label\)/);
  assert.match(css, /\.t8-farm-minimap-markers\[data-farm-minimap-route-hint-empty="true"\]/);
  assert.match(css, /\.t8-farm-minimap-marker\[data-farm-minimap-route-hint="true"\]/);
  assert.match(css, /\.t8-farm-minimap-marker\[data-farm-minimap-route-hint-step\]::before[\s\S]*content:\s*attr\(data-farm-minimap-route-hint-step\)/);
  assert.match(css, /\.t8-farm-minimap-marker\[data-farm-minimap-route-hint-active="true"\]::before[\s\S]*content:\s*"指"/);
  assert.match(css, /@keyframes farm-story-minimap-route-hint/);
  assert.match(css, /prefers-reduced-motion[\s\S]*data-farm-minimap-route-hint="true"[\s\S]*animation:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-placement-target-live \{[\s\S]*clip-path:\s*inset\(50%\)[\s\S]*pointer-events:\s*none/);
  assert.match(css, /\[data-farm-mini-placement-receipt-text="true"\]/);
  assert.match(css, /data-farm-mini-building-yield-placement-receipt/);
  assert.match(css, /data-farm-mini-beauty-placement-receipt/);
  assert.match(css, /\.t8-farm-story-panel__mini-placement-receipt/);
  assert.match(css, /button\.t8-farm-story-panel__mini-placement-receipt\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /data-farm-mini-placement-receipt-action="building"/);
  assert.match(css, /data-farm-mini-placement-receipt-action="decor"/);
  assert.match(css, /\[data-farm-mini-placement-receipt-source-text="true"\]/);
  assert.match(css, /\[data-farm-mini-placement-receipt-action-text="true"\]/);
  assert.match(css, /\[data-farm-mini-placement-receipt-next-text="true"\]/);
  assert.match(css, /data-farm-mini-placement-receipt-action="building"[\s\S]*\[data-farm-mini-placement-receipt-next-text="true"\]/);
  assert.match(css, /data-farm-mini-placement-receipt-action="decor"[\s\S]*\[data-farm-mini-placement-receipt-next-text="true"\]/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__mini-placement-receipt \{[\s\S]*max-width:\s*108px/);
  assert.match(css, /@keyframes farm-story-mini-placement-receipt-pulse/);
  assert.match(css, /data-farm-mini-status-item="building-yield-summary"/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-status-item="building-yield-summary"\] \{[\s\S]*max-width:\s*96px[\s\S]*box-shadow:/);
  assert.match(css, /button\[data-farm-mini-status-item="building-yield-summary"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="building-yield-summary"\]:hover[\s\S]*transform:\s*translateY\(-1px\)/);
  assert.match(css, /button\[data-farm-mini-status-item="building-yield-summary"\]:focus-visible[\s\S]*outline:\s*2px solid var\(--farm-sky\)/);
  assert.match(css, /button\[data-farm-mini-status-item="building-yield-summary"\]\[data-farm-mini-building-yield-opened="true"\]::after[\s\S]*content:\s*"已展开"/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-status-item="building-yield-summary"\] b \{[\s\S]*max-width:\s*58px/);
  assert.match(css, /\.t8-farm-story-panel__mini-building-quest-route-hint/);
  assert.match(css, /\.t8-farm-story-panel__mini-building-quest-route-hint\[data-farm-mini-building-quest-route-receipt\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-yield-targets\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-yield-targets-text\] \{[\s\S]*max-width:\s*42px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-yield-primary-target\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-yield-primary-target-text\] \{[\s\S]*max-width:\s*38px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-yield-primary-tone="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-yield-primary-tone="storage"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-yield-primary-tone="board"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-yield-primary-tone="scarecrow"\]/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__mini-status \[data-farm-mini-status-item="building-yield-summary"\] \{[\s\S]*max-width:\s*84px/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__mini-status \[data-farm-mini-building-yield-targets-text\] \{[\s\S]*max-width:\s*34px/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__mini-status \[data-farm-mini-building-yield-primary-target-text\] \{[\s\S]*max-width:\s*30px/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-effect-yield\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-effect-yield-text\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-effect-yield-text\] \{[\s\S]*max-width:\s*42px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-effect-next\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-chain/);
  assert.match(css, /\[data-farm-building-effect-chain-route-hint="true"\]/);
  assert.match(css, /\[data-farm-building-effect-row-route-hint="true"\]/);
  assert.match(css, /@keyframes farm-story-building-effect-chain-route/);
  assert.match(css, /prefers-reduced-motion[\s\S]*\.t8-farm-story-panel__building-effect-chain[\s\S]*animation:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-effect-next-text\] \{[\s\S]*max-width:\s*34px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-effect-next-tone="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-effect-next-tone="storage"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-effect-next-tone="board"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-building-effect-next-tone="scarecrow"\]/);
  assert.match(css, /@keyframes farm-story-mini-building-yield-glow/);
  assert.match(css, /data-farm-mini-status-item="animal"/);
  assert.match(css, /data-farm-mini-status-item="animal-product"/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-animal-mood-summary\] \{[\s\S]*max-width:\s*104px[\s\S]*box-shadow:/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-animal-mood-preview-text\] \{[\s\S]*max-width:\s*42px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\[data-farm-mini-animal-mood-tone="happy"\]/);
  assert.match(css, /\[data-farm-mini-animal-mood-tone="calm"\]/);
  assert.match(css, /\[data-farm-mini-animal-mood-tone="hungry"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="animal"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="animal"\]:hover[\s\S]*transform:\s*translateY\(-1px\)/);
  assert.match(css, /button\[data-farm-mini-status-item="animal"\]\[data-farm-mini-animal-opened="true"\]::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-animal-product-summary\] \{[\s\S]*max-width:\s*104px[\s\S]*box-shadow:/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-animal-product-preview-text\] \{[\s\S]*max-width:\s*48px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /button\[data-farm-mini-status-item="animal-product"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="animal-product"\]:hover[\s\S]*transform:\s*translateY\(-1px\)/);
  assert.match(css, /button\[data-farm-mini-status-item="animal-product"\]\[data-farm-mini-animal-product-opened="true"\]::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /data-farm-mini-status-item="animal-product-receipt"/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-animal-product-receipt\] \{[\s\S]*max-width:\s*112px[\s\S]*box-shadow:/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-animal-product-receipt-preview-text\] \{[\s\S]*max-width:\s*54px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /button\[data-farm-mini-status-item="animal-product-receipt"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="animal-product-receipt"\]:hover[\s\S]*transform:\s*translateY\(-1px\)/);
  assert.match(css, /button\[data-farm-mini-status-item="animal-product-receipt"\]\[data-farm-mini-animal-product-receipt-opened="true"\]::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /data-farm-mini-status-item="animal-next-product"/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-animal-next-products\] \{[\s\S]*max-width:\s*112px[\s\S]*box-shadow:/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \[data-farm-mini-animal-next-products-preview-text\] \{[\s\S]*max-width:\s*54px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /button\[data-farm-mini-status-item="animal-next-product"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="animal-next-product"\]:hover[\s\S]*transform:\s*translateY\(-1px\)/);
  assert.match(css, /button\[data-farm-mini-status-item="animal-next-product"\]\[data-farm-mini-animal-next-products-opened="true"\]::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /\.t8-farm-story-panel__animals\[data-farm-animal-product-focus="true"\] \{[\s\S]*animation:\s*farm-story-animal-product-focus/);
  assert.match(css, /\.t8-farm-story-panel__animals:focus-visible \{[\s\S]*outline:\s*3px solid var\(--farm-sky\)/);
  assert.match(css, /\.t8-farm-story-panel__animals\[data-farm-animal-mood-tone="hungry"\] \.t8-farm-story-panel__animals-head em\[data-farm-animal-mood-hint\]/);
  assert.match(css, /\.t8-farm-story-panel__animals\[data-farm-animal-mood-tone="happy"\] \.t8-farm-story-panel__animals-head em\[data-farm-animal-mood-hint\]/);
  assert.match(css, /\.t8-farm-story-panel__animals\[data-farm-animal-product-ready="true"\] \.t8-farm-story-panel__animals-head strong/);
  assert.match(css, /\.t8-farm-story-panel__animals\[data-farm-animal-next-products\] \.t8-farm-story-panel__animals-head i\[data-farm-animal-next-products\]/);
  assert.match(css, /@keyframes farm-story-animal-product-focus/);
  assert.match(css, /data-farm-mini-status-item="activity"/);
  assert.match(css, /data-farm-mini-status-item="activity-reward"/);
  assert.match(css, /data-farm-mini-status-item="focus"/);
  assert.match(css, /data-farm-mini-status-item="focus-action"/);
  assert.match(css, /data-farm-mini-status-item="focus-action-live"/);
  assert.match(css, /data-farm-mini-resource-linked="true"/);
  assert.match(css, /\[data-farm-mini-resource-linked-kind="gold"\]/);
  assert.match(css, /\[data-farm-mini-resource-linked-kind="seed"\]/);
  assert.match(css, /\[data-farm-mini-resource-linked-kind="water"\]/);
  assert.match(css, /\[data-farm-mini-resource-linked-kind="wood"\]/);
  assert.match(css, /\[data-farm-mini-resource-linked-kind="stone"\]/);
  assert.match(css, /@keyframes farm-story-mini-resource-linked/);
  assert.match(css, /prefers-reduced-motion[\s\S]*data-farm-mini-resource-linked="true"/);
  assert.match(css, /prefers-reduced-motion[\s\S]*\.t8-farm-story-panel__mini-status\[data-farm-mini-building-yields\][\s\S]*\.t8-farm-story-panel__mini-status\[data-farm-mini-placement-receipt\][\s\S]*animation:\s*none/);
  assert.match(css, /data-farm-mini-status-item="resource-feedback"/);
  assert.match(css, /data-farm-mini-resource-feedback-targets~="water"/);
  assert.match(css, /data-farm-mini-resource-feedback-targets~="gold"/);
  assert.match(css, /data-farm-mini-resource-feedback-targets~="seed"/);
  assert.match(css, /data-farm-mini-resource-feedback-targets~="wood"/);
  assert.match(css, /data-farm-mini-resource-feedback-targets~="stone"/);
  assert.match(css, /data-farm-mini-resource-feedback-targets~="scarecrow"/);
  assert.match(css, /@keyframes farm-story-mini-resource-feedback/);
  assert.match(css, /prefers-reduced-motion[\s\S]*data-farm-mini-status-item="resource-feedback"/);
  assert.match(css, /data-farm-mini-focus-kind="urgent"/);
  assert.match(css, /data-farm-mini-focus-kind="reward"/);
  assert.match(css, /data-farm-mini-focus-kind="decorate"/);
  assert.match(css, /data-farm-mini-focus-ready="true"/);
  assert.match(css, /data-farm-mini-focus-complete="true"/);
  assert.match(css, /data-farm-mini-focus-action-linked="true"/);
  assert.match(css, /\[data-farm-mini-status-item="focus-action"\]\[data-farm-mini-focus-kind="urgent"\]/);
  assert.match(css, /\[data-farm-mini-status-item="focus-action"\]\[data-farm-mini-focus-ready="true"\]/);
  assert.match(css, /\[data-farm-mini-status-item="focus-action"\]\[data-farm-mini-focus-complete="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="focus-action"\]\[data-farm-mini-focus-action-busy="true"\]::after/);
  assert.match(css, /button\[data-farm-mini-status-item="focus-action"\]\[data-farm-mini-focus-action-result\] > svg/);
  assert.match(css, /button\[data-farm-mini-status-item="focus-action"\]\[data-farm-mini-focus-action-result\] > b \{[\s\S]*max-width:\s*56px/);
  assert.match(css, /button\[data-farm-mini-status-item="focus-action"\]\[data-farm-mini-focus-action-resource-preview\]/);
  assert.match(css, /\[data-farm-mini-focus-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-mini-focus-action-resource-targets~="water"\] \[data-farm-mini-focus-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-mini-focus-action-resource-targets~="gold"\] \[data-farm-mini-focus-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-mini-focus-action-resource-targets~="wood"\] \[data-farm-mini-focus-action-resource="true"\]/);
  assert.match(css, /animation:\s*farm-story-mini-action-cooldown 1\.2s linear both/);
  assert.match(css, /@keyframes farm-story-mini-action-cooldown/);
  assert.match(css, /\.t8-farm-story-panel__mini-focus-meter/);
  assert.match(css, /\.t8-farm-story-panel__mini-focus-meter i/);
  assert.match(css, /\.t8-farm-story-panel__mini-focus-meter\[data-farm-mini-focus-kind="urgent"\] i/);
  assert.match(css, /\.t8-farm-story-panel__mini-focus-meter\[data-farm-mini-focus-ready="true"\] i/);
  assert.match(css, /\.t8-farm-story-panel__mini-focus-meter\[data-farm-mini-focus-complete="true"\] i/);
  assert.match(css, /\[data-farm-mini-status-item="focus"\]\[data-farm-mini-focus-action-linked="true"\]/);
  assert.match(css, /\[data-farm-mini-status-item="focus"\]\[data-farm-mini-focus-action-linked="true"\]::before/);
  assert.match(css, /\.t8-farm-story-panel__mini-focus-meter\[data-farm-mini-focus-action-linked="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-focus-meter\[data-farm-mini-focus-action-linked="true"\] i/);
  assert.match(css, /@keyframes farm-story-mini-focus-linked/);
  assert.match(css, /prefers-reduced-motion[\s\S]*data-farm-mini-focus-action-linked="true"/);
  assert.match(css, /\.t8-farm-story-panel__mini-activity-meter/);
  assert.match(css, /\.t8-farm-story-panel__mini-activity-meter i/);
  assert.match(css, /\.t8-farm-story-panel__mini-activity-meter\[data-farm-mini-activity-tone="busy"\] i/);
  assert.match(css, /data-farm-mini-activity-tone="reward"/);
  assert.match(css, /\[data-farm-mini-status-item="activity"\]\[data-farm-mini-activity-action-linked="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-activity-meter\[data-farm-mini-activity-action-linked="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-activity-meter\[data-farm-mini-activity-action-linked="true"\] i/);
  assert.match(css, /@keyframes farm-story-mini-activity-linked/);
  assert.match(css, /\[data-farm-mini-status-item="activity-feedback"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="activity"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="activity"\]\[data-farm-mini-activity-opened="true"\]::after[\s\S]*content:\s*"看成果"/);
  assert.match(css, /@keyframes farm-story-mini-activity-located/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-reward"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-reward"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-reward"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-reward"\]\[data-farm-mini-activity-reward-digest-opened="true"\]::after[\s\S]*content:\s*"看奖励"/);
  assert.match(css, /@keyframes farm-story-mini-activity-reward-located/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak"\]\[data-farm-mini-activity-streak-opened="true"\]::after[\s\S]*content:\s*"看连击"/);
  assert.match(css, /@keyframes farm-story-mini-activity-streak-located/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-milestone"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-milestone"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-milestone"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-milestone"\]\[data-farm-mini-activity-streak-milestone-opened="true"\]::after[\s\S]*content:\s*"看里程碑"/);
  assert.match(css, /@keyframes farm-story-mini-activity-streak-milestone-located/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-meter"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-meter"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-meter"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-meter"\]\[data-farm-mini-activity-streak-meter-opened="true"\]::after[\s\S]*content:\s*"看进度"/);
  assert.match(css, /@keyframes farm-story-mini-activity-streak-meter-located/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-meter em\[data-farm-activity-reward-streak-meter-located="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-meter em\[data-farm-activity-reward-streak-meter-located="true"\] svg/);
  assert.match(css, /\[data-farm-activity-reward-streak-meter-located-pulse\][\s\S]*animation:\s*farm-story-activity-anchor-focus/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-completion"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-completion"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-completion"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-completion"\]\[data-farm-mini-activity-streak-completion-opened="true"\]::after[\s\S]*content:\s*"看完成"/);
  assert.match(css, /@keyframes farm-story-mini-activity-streak-completion-located/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-chest"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-chest"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-chest"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-chest"\]\[data-farm-mini-activity-streak-chest-opened="true"\]::after[\s\S]*content:\s*"看宝箱"/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-chest"\]\[data-farm-mini-activity-streak-chest-claimed="true"\]::after[\s\S]*content:\s*"已入袋"/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-chest"\]\[data-farm-mini-activity-streak-chest-claim-next-action="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-chest"\]\[data-farm-mini-activity-streak-chest-claim-next-action="true"\]::after[\s\S]*content:\s*"续连击"/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-streak-chest"\]\[data-farm-mini-activity-streak-chest-claim-next-action-receipt\]::after[\s\S]*content:\s*"已续上"/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-route="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-chest-route-hint/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-route-hint="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-route-hint="true"\]/);
  assert.match(css, /@keyframes farm-story-mini-chest-route-hint/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-burst="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-remaining-label="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-trail="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-trail-item\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-trail-reward\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-trail-continued="true"\]/);
  assert.match(css, /farm-story-mini-activity-streak-chest-trail-continued/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-trail-pocketed="true"\]/);
  assert.match(css, /farm-story-mini-activity-streak-chest-trail-pocketed/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-trail-followup-receipt="true"\]/);
  assert.match(css, /farm-story-mini-activity-streak-chest-trail-followup-receipt/);
  assert.match(css, /\[data-farm-mini-activity-followup-receipt\]/);
  assert.match(css, /\[data-farm-mini-followup-resource-targets~="gold"\] \[data-farm-mini-status-item="gold"\]/);
  assert.match(css, /\[data-farm-mini-followup-resource-targets~="seed"\] \[data-farm-mini-status-item="seed"\]/);
  assert.match(css, /\[data-farm-mini-followup-resource-targets~="water"\] \[data-farm-mini-status-item="water"\]/);
  assert.match(css, /\[data-farm-mini-followup-resource-targets~="wood"\] \[data-farm-mini-status-item="wood"\]/);
  assert.match(css, /\[data-farm-mini-followup-resource-targets~="stone"\] \[data-farm-mini-status-item="stone"\]/);
  assert.match(css, /\[data-farm-mini-followup-resource-targets~="mature"\] \[data-farm-mini-status-item="mature"\]/);
  assert.match(css, /\[data-farm-mini-followup-resource-targets~="withered"\] \[data-farm-mini-status-item="withered"\]/);
  assert.match(css, /\[data-farm-mini-followup-resource-targets~="beauty"\] \[data-farm-mini-status-item="beauty"\]/);
  assert.match(css, /\[data-farm-mini-followup-resource-targets~="day"\] \[data-farm-mini-status-item="day"\]/);
  assert.match(css, /@keyframes farm-story-mini-followup-resource-target/);
  assert.match(css, /button\[data-farm-mini-status-item="followup-action-card"\]\[data-farm-mini-followup-action-card="true"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-target="water"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-target="cleanup"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-target="seed"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-target="harvest"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-target="build"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-target="scarecrow"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-target="reward"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-target="social"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-target="decor"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-target="day"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-count="true"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-resource="true"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-route-target="mature-crop"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-route-target="ready-npc"\]/);
  assert.match(css, /\[data-farm-mini-followup-action-route-hint="true"\]/);
  assert.match(css, /@keyframes farm-story-mini-followup-action-card/);
  assert.match(css, /@keyframes farm-story-mini-followup-route-hint/);
  assert.match(css, /\[data-farm-mini-action-live-followup-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-meter\[data-farm-activity-followup-receipt\]/);
  assert.match(css, /@keyframes farm-story-activity-followup-receipt/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-active-reward="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-label="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-resource="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-resource-label="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-next-label="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-progress-label="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-progress-state="complete"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-milestone-label="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-label="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-items\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-stamps="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-stamp\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket-label="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket-target-label="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket-targets\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket-followup-label="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-reward-pocket-collected="true"\] \[data-farm-mini-activity-streak-chest-claim-next-action-label="true"\]/);
  assert.match(css, /\[data-farm-mini-activity-streak-chest-claim-next-action-followup-target="true"\]/);
  assert.match(css, /@keyframes farm-story-mini-reward-pocket-followup/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-reward-pocket-targets~="beauty"\] \[data-farm-mini-status-item="beauty"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-reward-pocket-targets~="ready-order"\] \[data-farm-mini-status-item="ready-order"\]/);
  assert.match(css, /\.t8-farm-story-panel__mini-status\[data-farm-mini-reward-pocket-targets~="activity-streak-reward"\] \[data-farm-mini-status-item="activity-streak-reward"\]/);
  assert.match(css, /\[data-farm-mini-reward-pocket-target="true"\]::before/);
  assert.match(css, /\[data-farm-mini-reward-pocket-target-opened="true"\]::after[\s\S]*content:\s*"已收纳"/);
  assert.match(css, /@keyframes farm-story-mini-reward-pocket-collected/);
  assert.match(css, /@keyframes farm-story-mini-reward-pocket-target/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-milestone-label="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-label="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-stamp/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket-label="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket-target-label="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-receipt-reward-pocket-followup-label="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-followup-target="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-claim-next-action-route="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-route-hint="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-activity-reward-streak-chest-route-hint="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-reward-pocket-target="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-reward-pocket-target-opened="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-trail-continued="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-trail-pocketed="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-streak-chest-trail-followup-receipt="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-activity-followup-receipt/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-followup-resource-targets/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-followup-action-card="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-action-live-followup-receipt="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-activity-followup-receipt/);
  assert.match(css, /data-farm-mini-status-item="activity-streak-chest"\]\[data-farm-mini-activity-streak-chest-state="ready"/);
  assert.match(css, /@keyframes farm-story-mini-activity-streak-chest-located/);
  assert.match(css, /@keyframes farm-story-mini-activity-streak-chest-claim/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-action"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-action"\]\[data-farm-mini-activity-streak-action-opened="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-action"\]\[data-farm-mini-reward-pocket-followup-action="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-action"\]\[data-farm-mini-reward-pocket-followup-action="true"\]::after[\s\S]*content:\s*"可继续"/);
  assert.match(css, /@keyframes farm-story-mini-reward-pocket-action-followup/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-action"\]\[data-farm-mini-reward-pocket-followup-action-receipt\]/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-action"\]\[data-farm-mini-reward-pocket-followup-action-receipt\]::after[\s\S]*content:\s*"已接上"/);
  assert.match(css, /data-farm-activity-reward-streak-action-receipt-followup-label="true"/);
  assert.match(css, /@keyframes farm-story-mini-reward-pocket-followup-receipt/);
  assert.match(css, /data-farm-activity-reward-streak-action-focus="true"/);
  assert.match(css, /data-farm-activity-reward-streak-action-cta="true"/);
  assert.match(css, /data-farm-activity-reward-streak-action-receipt="true"/);
  assert.match(css, /button\[data-farm-mini-status-item="activity-action"\]\[data-farm-mini-activity-streak-action-receipt\]::after[\s\S]*content:\s*"已执行"/);
  assert.match(css, /data-farm-activity-reward-streak-action-receipt-next="true"/);
  assert.match(css, /@keyframes farm-story-mini-activity-action-receipt/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-reward-pocket-followup-action="true"/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*data-farm-mini-reward-pocket-followup-action-receipt/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest \{[\s\S]*min-width:\s*0[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest > \* \{[\s\S]*max-width:\s*100%/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest\[data-farm-activity-reward-streak-chest-state="ready"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest\[data-farm-activity-reward-streak-chest-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest\[data-farm-activity-reward-streak-chest-claimed="true"\]/);
  assert.match(css, /button\[data-farm-activity-reward-streak-chest-cta="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-claim-receipt="true"\]/);
  assert.match(css, /button\[data-farm-activity-reward-streak-chest-claim-next-action="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-reward-items="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-reward-item\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest-meter\[data-farm-activity-reward-streak-chest-meter="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest-meter\[data-farm-activity-reward-streak-chest-meter="true"\] i/);
  assert.match(css, /button\[data-farm-activity-reward-streak-chest-charge-cta="true"\]/);
  assert.match(css, /button\[data-farm-activity-reward-streak-chest-charge-cta="true"\] \{[\s\S]*min-width:\s*0[\s\S]*max-width:\s*100%[\s\S]*overflow:\s*hidden/);
  assert.match(css, /button\[data-farm-activity-reward-streak-chest-charge-cta="true"\]:hover/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-charge-reward-label="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-charge-receipt="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-charge-receipt-progress="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-charge-receipt-remaining="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-charge-receipt-reward-label="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-charge-receipt-next-label="true"\]/);
  assert.match(css, /button\[data-farm-activity-reward-streak-chest-charge-receipt-next-action="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest button\[data-farm-activity-reward-streak-chest-charge-receipt-next-action="true"\] \{[\s\S]*min-width:\s*0[\s\S]*max-width:\s*100%[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-remaining-label="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest-trail/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-trail-item\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-trail-reward-label="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-trail-state="active"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-streak-chest-active\[data-farm-activity-reward-streak-chest-active="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-active-reward-label="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-next-reward-label="true"\]/);
  assert.match(css, /\[data-farm-activity-reward-streak-chest-next-label="true"\]/);
  assert.match(css, /@keyframes farm-story-activity-streak-chest-located/);
  assert.match(css, /@keyframes farm-story-activity-streak-chest-claim/);
  assert.match(css, /@keyframes farm-story-activity-streak-chest-charge-receipt/);
  assert.match(css, /@keyframes farm-story-activity-streak-chest-reward-pop/);
  assert.match(css, /prefers-reduced-motion[\s\S]*data-farm-activity-reward-streak-chest-charge-receipt="true"/);
  assert.match(css, /prefers-reduced-motion[\s\S]*data-farm-activity-reward-streak-chest-reward-item/);
  assert.match(css, /data-farm-mini-status-item="activity-streak-completion"\]\[data-farm-mini-activity-reward-streak-tier="sprout"/);
  assert.match(css, /data-farm-mini-status-item="activity-streak-completion"\]\[data-farm-mini-activity-reward-streak-tier="harvest"/);
  assert.match(css, /data-farm-mini-status-item="activity-streak-completion"\]\[data-farm-mini-activity-reward-streak-tier="festival"/);
  assert.match(css, /\[data-farm-mini-status-item="activity-feedback"\] b/);
  assert.match(css, /@keyframes farm-story-mini-activity-feedback/);
  assert.match(css, /prefers-reduced-motion[\s\S]*data-farm-mini-activity-action-linked="true"/);
  assert.match(css, /prefers-reduced-motion[\s\S]*data-farm-mini-status-item="activity-feedback"/);
  assert.match(css, /\[data-farm-mini-status-item="summary-feedback"\] \{[\s\S]*max-width:\s*180px[\s\S]*pointer-events:\s*auto[\s\S]*cursor:\s*pointer[\s\S]*animation:\s*farm-story-mini-summary-feedback 1\.2s ease-out both/);
  assert.match(css, /button\[data-farm-mini-status-item="summary-feedback"\]:hover[\s\S]*transform:\s*translateY\(-1px\)/);
  assert.match(css, /button\[data-farm-mini-status-item="summary-feedback"\]:focus-visible[\s\S]*outline:\s*2px solid var\(--farm-sky\)/);
  assert.match(css, /\[data-farm-mini-status-item="summary-feedback"\] b \{[\s\S]*max-width:\s*154px/);
  assert.match(css, /@keyframes farm-story-mini-summary-feedback/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*data-farm-mini-status-item="summary-feedback"[\s\S]*max-width:\s*126px/);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*data-farm-mini-status-item="summary-feedback"[\s\S]*display:\s*none/);
  assert.match(css, /data-farm-mini-status-item="beauty"/);
  assert.match(css, /button\[data-farm-mini-status-item="beauty"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="beauty"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="beauty"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="beauty"\]\[data-farm-mini-beauty-opened="true"\]::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /\.t8-farm-story-panel__mini-beauty-route-hint/);
  assert.match(css, /\.t8-farm-story-panel__beauty\[data-farm-beauty-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__beauty-head em\[data-farm-beauty-located-feedback="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__beauty-reward-route/);
  assert.match(css, /\[data-farm-beauty-reward-route-hint="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__beauty-reward\[data-farm-beauty-reward-next="true"\]/);
  assert.match(css, /\[data-farm-beauty-reward-route-chip="true"\]/);
  assert.match(css, /@keyframes farm-story-mini-beauty-located/);
  assert.match(css, /@keyframes farm-story-beauty-focus/);
  assert.match(css, /@keyframes farm-story-beauty-located-feedback/);
  assert.match(css, /@keyframes farm-story-beauty-reward-route/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*button\[data-farm-mini-status-item="beauty"\]\[data-farm-mini-beauty-opened="true"\]::after[\s\S]*\.t8-farm-story-panel__beauty\[data-farm-beauty-focus="true"\][\s\S]*\.t8-farm-story-panel__beauty-head em\[data-farm-beauty-located-feedback="true"\][\s\S]*animation:\s*none/);
  assert.match(css, /data-farm-mini-status-item="mature"/);
  assert.match(css, /button\[data-farm-mini-status-item="mature"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="mature"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="mature"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="mature"\]\[data-farm-mini-mature-opened="true"\]::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /@keyframes farm-story-mini-mature-located/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*button\[data-farm-mini-status-item="mature"\]\[data-farm-mini-mature-opened="true"\]::after[\s\S]*animation:\s*none/);
  assert.match(css, /data-farm-mini-status-item="dry"/);
  assert.match(css, /button\[data-farm-mini-status-item="dry"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="dry"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="dry"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="dry"\]\[data-farm-mini-dry-water-opened="true"\]::after[\s\S]*content:\s*"已切水壶"/);
  assert.match(css, /@keyframes farm-story-mini-dry-water/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*button\[data-farm-mini-status-item="dry"\]\[data-farm-mini-dry-water-opened="true"\]::after[\s\S]*animation:\s*none/);
  assert.match(css, /data-farm-mini-status-item="scarecrow-risk"/);
  assert.match(css, /\[data-farm-mini-status-item="scarecrow-risk"\]\[data-farm-mini-scarecrow-risk-alert="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="scarecrow-risk"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="scarecrow-risk"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="scarecrow-risk"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="scarecrow-risk"\]\[data-farm-mini-scarecrow-risk-selected="true"\]::after[\s\S]*content:\s*"已选稻草人"/);
  assert.match(css, /@keyframes farm-story-mini-scarecrow-risk/);
  assert.match(css, /@keyframes farm-story-mini-scarecrow-selected/);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*data-farm-mini-status-item="scarecrow-risk"[\s\S]*display:\s*none/);
  assert.match(css, /prefers-reduced-motion[\s\S]*data-farm-mini-status-item="scarecrow-risk"/);
  assert.match(css, /data-farm-mini-status-item="withered"/);
  assert.match(css, /button\[data-farm-mini-status-item="withered"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="withered"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="withered"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="withered"\]\[data-farm-mini-withered-shovel-opened="true"\]::after[\s\S]*content:\s*"已切铲子"/);
  assert.match(css, /@keyframes farm-story-mini-withered-shovel/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*button\[data-farm-mini-status-item="withered"\]\[data-farm-mini-withered-shovel-opened="true"\]::after[\s\S]*animation:\s*none/);
  assert.match(css, /data-farm-mini-status-item="ready-order"/);
  assert.match(css, /button\[data-farm-mini-status-item="ready-order"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="ready-order"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="ready-order"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="ready-order"\]\[data-farm-mini-ready-order-opened="true"\]::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /data-farm-mini-status-item="ready-npc"/);
  assert.match(css, /button\[data-farm-mini-status-item="ready-npc"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="ready-npc"\]:hover/);
  assert.match(css, /button\[data-farm-mini-status-item="ready-npc"\]:focus-visible/);
  assert.match(css, /button\[data-farm-mini-status-item="ready-npc"\]\[data-farm-mini-ready-npc-opened="true"\]::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /button\[data-farm-mini-status-item="tool"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /\[data-farm-mini-status-item="tool"\]\[data-farm-mini-tool-flash="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="tool"\]\[data-farm-mini-tool-opened="true"\]::after[\s\S]*content:\s*"工具栏"/);
  assert.match(css, /animation:\s*farm-story-mini-tool-flash 1\.2s ease-out both/);
  assert.match(css, /animation:\s*farm-story-mini-tool-located 1\.2s ease-out both/);
  assert.match(css, /@keyframes farm-story-mini-tool-flash/);
  assert.match(css, /@keyframes farm-story-mini-tool-located/);
  assert.match(css, /\.t8-farm-story-panel__tools\[data-farm-tools-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__tools:focus-visible/);
  assert.match(css, /\.t8-farm-story-panel__tools-located\[data-farm-tools-located-feedback="true"\]/);
  assert.match(css, /@keyframes farm-story-tools-focus/);
  assert.match(css, /@keyframes farm-story-tools-located-feedback/);
  assert.match(css, /button\[data-farm-mini-status-item="day"\]\[data-farm-mini-status-clickable="true"\]/);
  assert.match(css, /button\[data-farm-mini-status-item="day"\]\[data-farm-mini-summary-opened="true"\]::after[\s\S]*content:\s*"看总结"/);
  assert.match(css, /@keyframes farm-story-mini-summary-located/);
  assert.match(css, /\.t8-farm-story-panel__summary\[data-farm-summary-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-located\[data-farm-summary-located-feedback="true"\]/);
  assert.match(css, /@keyframes farm-story-summary-focus/);
  assert.match(css, /@keyframes farm-story-summary-located-feedback/);
  assert.match(css, /\.t8-farm-story-panel__activity\[data-farm-activity-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-located\[data-farm-activity-located-feedback="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-located\[data-farm-activity-located-feedback="true"\] svg/);
  assert.match(css, /\.t8-farm-story-panel__activity-located\[data-farm-activity-located-pulse\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-located\[data-farm-activity-located-target="reward-digest"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-located\[data-farm-activity-located-target="streak"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-located\[data-farm-activity-located-target="milestone"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-located\[data-farm-activity-located-target="streak-meter"\]/);
  assert.match(css, /\.t8-farm-story-panel__activity-located\[data-farm-activity-located-target="completion"\]/);
  assert.match(css, /@keyframes farm-story-activity-focus/);
  assert.match(css, /@keyframes farm-story-activity-located-feedback/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*data-farm-activity-located-pulse[\s\S]*animation: none/);
  assert.match(css, /\.t8-farm-story-panel__mini-action-live \{[\s\S]*clip-path:\s*inset\(50%\)[\s\S]*pointer-events:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__tool-main/);
  assert.match(css, /\.t8-farm-story-panel__tool-badge/);
  assert.match(css, /data-farm-tool-badge-tone="seed"/);
  assert.match(css, /data-farm-tool-badge-tone="water"/);
  assert.match(css, /data-farm-tool-badge-tone="mature"/);
  assert.match(css, /data-farm-tool-badge-tone="warning"/);
  assert.match(css, /\.t8-farm-story-panel__tools button\.has-badge/);
  assert.match(css, /\.t8-farm-story-panel__tools button\.is-unavailable/);
  assert.match(css, /cursor:\s*help/);
  assert.match(css, /\.t8-farm-story-panel__tools button\.is-unavailable::after/);
  assert.match(css, /\.t8-farm-story-panel__tools button\.is-active\.is-unavailable/);
  assert.match(css, /\.t8-farm-story-panel__tools button\.is-unavailable \.t8-farm-story-panel__tool-badge/);
  assert.match(css, /\.t8-farm-story-panel__mini-status \{[\s\S]*max-width:\s*none/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__mini-status \{[\s\S]*width:\s*auto/);
  assert.match(css, /\.t8-farm-story-panel__reward-bursts/);
  assert.match(css, /\.t8-farm-story-panel__season/);
  assert.match(css, /\.t8-farm-story-panel__season\[data-farm-season-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__season:focus-visible/);
  assert.match(css, /\.t8-farm-story-panel__season-head em\[data-farm-season-located-feedback="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__season-head small\[data-farm-season-weather="true"\]/);
  assert.match(css, /@keyframes farm-story-season-focus/);
  assert.match(css, /@keyframes farm-story-season-located-feedback/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*button\[data-farm-mini-status-item="season"\]\[data-farm-mini-season-opened="true"\]::after[\s\S]*button\[data-farm-mini-status-item="weather"\]\[data-farm-mini-weather-opened="true"\]::after[\s\S]*\.t8-farm-story-panel__season\[data-farm-season-focus="true"\][\s\S]*\.t8-farm-story-panel__season-head em\[data-farm-season-located-feedback="true"\][\s\S]*animation:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__season-progress/);
  assert.match(css, /\.t8-farm-story-panel__season\[data-farm-season="winter"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus/);
  assert.match(css, /\.t8-farm-story-panel__focus\.is-urgent/);
  assert.match(css, /\.t8-farm-story-panel__focus\.is-reward/);
  assert.match(css, /\.t8-farm-story-panel__focus\[data-farm-focus-progress-preview\]/);
  assert.match(css, /\.t8-farm-story-panel__focus\[data-farm-focus-action-resource-preview\]/);
  assert.match(css, /\.t8-farm-story-panel__focus\[data-farm-focus-action-resource-targets~="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus\[data-farm-focus-action-resource-targets~="gold"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus\[data-farm-focus-action-resource-targets~="wood"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus\[data-farm-focus-action-resource-targets~="stone"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus\[data-farm-focus-action-resource-targets~="scarecrow"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus\[data-farm-focus-action-resource-targets~="mature"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus\[data-farm-focus-action-resource-targets~="withered"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-head strong\[data-farm-focus-head-progress-preview\]/);
  assert.match(css, /\[data-farm-focus-head-progress-preview="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast \{[\s\S]*max-width:\s*100%[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast\[data-farm-focus-forecast-resource\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast\[data-farm-focus-forecast-progress\]/);
  assert.match(css, /\[data-farm-focus-forecast-item="true"\]/);
  assert.match(css, /\[data-farm-focus-forecast-tone="action"\]/);
  assert.match(css, /\[data-farm-focus-forecast-tone="resource"\]/);
  assert.match(css, /\[data-farm-focus-forecast-tone="progress"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-actionable="true"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-actionable="true"\]:not\(:disabled\):hover/);
  assert.match(css, /button\[data-farm-focus-forecast-busy="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt \{[\s\S]*max-width:\s*100%[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt svg/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt span/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt em/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-actionable="true"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-actionable="true"\]:hover/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-action-kind="water"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-action-kind="order"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-action-kind="npc"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-active="true"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-cooldown="true"\]::after/);
  assert.match(css, /animation:\s*farm-story-focus-forecast-receipt-chip-cooldown 1\.2s linear both/);
  assert.match(css, /@keyframes farm-story-focus-forecast-receipt-chip-cooldown/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*button\[data-farm-focus-forecast-receipt-chip-cooldown="true"\]::after[\s\S]*animation: none/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-resource-targets~="seed"\] \[data-farm-focus-forecast-receipt-chip-resource="true"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-resource-targets~="beauty"\] \[data-farm-focus-forecast-receipt-chip-resource="true"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-resource-targets~="mature"\] \[data-farm-focus-forecast-receipt-chip-resource="true"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-resource-targets~="withered"\] \[data-farm-focus-forecast-receipt-chip-resource="true"\]/);
  assert.match(css, /button\[data-farm-focus-forecast-receipt-chip-resource-targets~="day"\] \[data-farm-focus-forecast-receipt-chip-resource="true"\]/);
  assert.match(css, /\[data-farm-focus-forecast-receipt-chip="resource"\]/);
  assert.match(css, /\[data-farm-focus-forecast-receipt-chip="activity"\]/);
  assert.match(css, /\[data-farm-focus-forecast-receipt-chip="focus"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt\[data-farm-focus-forecast-receipt-action\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt\[data-farm-focus-forecast-receipt-kind\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt\[data-farm-focus-forecast-receipt-action="select-tool"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt\[data-farm-focus-forecast-receipt-action="jump-mature"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt\[data-farm-focus-forecast-receipt-action="complete-order"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt\[data-farm-focus-forecast-receipt-action="complete-npc"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt\[data-farm-focus-forecast-receipt-action="select-building"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt\[data-farm-focus-forecast-receipt-action="select-decor"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-forecast-receipt\[data-farm-focus-forecast-receipt-action="advance-day"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-progress/);
  assert.match(css, /\.t8-farm-story-panel__focus-progress\[data-farm-focus-progress-preview\]/);
  assert.match(css, /\[data-farm-focus-progress-forecast-bar="true"\]/);
  assert.match(css, /\[data-farm-focus-progress-current="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-actions/);
  assert.match(css, /\.t8-farm-story-panel__focus-actions button\[data-farm-focus-action-resource-preview\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-actions button\[data-farm-focus-action-progress-preview\]/);
  assert.match(css, /\[data-farm-focus-action-resource="true"\]/);
  assert.match(css, /\[data-farm-focus-action-progress="true"\]/);
  assert.match(css, /button\[data-farm-focus-action-resource-targets~="water"\] \[data-farm-focus-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-focus-action-resource-targets~="gold"\] \[data-farm-focus-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-focus-action-resource-targets~="wood"\] \[data-farm-focus-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-focus-action-resource-targets~="scarecrow"\] \[data-farm-focus-action-resource="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__focus-next/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \{[\s\S]*min-width:\s*0[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty \[data-farm-activity-empty-focus="true"\] \{[\s\S]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.t8-farm-story-panel__activity-empty-forecast \{[\s\S]*min-width:\s*0[\s\S]*max-width:\s*100%[\s\S]*overflow:\s*hidden/);
  assert.match(css, /\.t8-farm-story-panel__beauty/);
  assert.match(css, /\.t8-farm-story-panel__beauty\.is-level-4/);
  assert.match(css, /\.t8-farm-story-panel__beauty-progress/);
  assert.match(css, /\.t8-farm-story-panel__beauty-factors/);
  assert.match(css, /\.t8-farm-story-panel__beauty-rewards/);
  assert.match(css, /\.t8-farm-story-panel__beauty-reward\.is-unlocked/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst > svg/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst > svg \{[\s\S]*flex:\s*0 0 auto[\s\S]*width:\s*10px[\s\S]*height:\s*10px/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst small\[data-farm-reward-burst-kind-label="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst small\[data-farm-reward-burst-kind-label="true"\] \{[\s\S]*max-width:\s*72px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst\.is-gold/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst\.is-experience/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst\.is-catalog/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst\.is-quest/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst\.is-animal/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst\.is-rare/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst\.is-beauty/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst\.is-festival/);
  assert.match(css, /\.t8-farm-story-panel__reward-burst\.is-festival::before/);
  assert.match(css, /@keyframes farm-story-reward-burst/);
  assert.match(css, /prefers-reduced-motion[\s\S]*\.t8-farm-story-panel__reward-burst/);
  assert.match(css, /\.t8-farm-story-panel__tutorial/);
  assert.match(css, /\.t8-farm-story-panel__tutorial-progress/);
  assert.match(css, /\.t8-farm-story-panel__tutorial li\.is-active/);
  assert.match(css, /\.t8-farm-story-panel__tutorial li\.is-done/);
  assert.match(css, /\.t8-farm-story-panel__long-goals/);
  assert.match(css, /\.t8-farm-story-panel__long-goal-progress/);
  assert.match(css, /\.t8-farm-story-panel__long-goals li\.is-done/);
  assert.match(css, /\.t8-farm-story-panel__long-goal-action/);
  assert.match(css, /\.t8-farm-story-panel__long-goal-action\[data-farm-long-goal-action-route-target="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__long-goals li\[data-farm-long-goal-action-receipt="true"\]/);
  assert.match(css, /@keyframes farm-story-long-goal-action-receipt/);
  assert.match(css, /\.t8-farm-story-panel__palette/);
  assert.match(css, /\.t8-farm-story-panel__palette-head/);
  assert.match(css, /\.t8-farm-story-panel__palette-group/);
  assert.match(css, /\.t8-farm-story-panel__palette-card-head/);
  assert.match(css, /\.t8-farm-story-panel__palette-tags/);
  assert.match(css, /data-farm-palette-tag="cost"/);
  assert.match(css, /data-farm-palette-tag="effect"/);
  assert.match(css, /\.t8-farm-story-panel__palette button\.is-active/);
  assert.match(css, /\.t8-farm-story-panel__palette button\.is-short/);
  assert.match(css, /\.t8-farm-story-panel__palette button\.is-locked/);
  assert.match(css, /\.t8-farm-story-panel__palette button em/);
  assert.match(css, /\.t8-farm-story-panel__palette-unlock-route/);
  assert.match(css, /\.t8-farm-story-panel__palette-unlock-route\[data-farm-palette-unlock-route-target="ready-order"\]/);
  assert.match(css, /\.t8-farm-story-panel__palette-unlock-route\[data-farm-palette-unlock-route-target="mature-crop"\]/);
  assert.match(css, /\.t8-farm-story-panel__palette-unlock-route\[data-farm-palette-unlock-route-target="beauty"\]/);
  assert.match(css, /\.t8-farm-story-panel__palette-unlock-route\[data-farm-palette-unlock-route-receipt="true"\]/);
  assert.match(css, /@keyframes farm-story-palette-unlock-route-receipt/);
  assert.match(css, /\.t8-farm-story-panel__resource-decor/);
  assert.match(css, /\.t8-farm-story-panel__resource-decor-types/);
  assert.match(css, /\.t8-farm-story-panel__resource-decor-grid/);
  assert.match(css, /\.t8-farm-story-panel__building-effects/);
  assert.match(css, /\.t8-farm-story-panel__building-effects \{[\s\S]*position:\s*relative[\s\S]*outline:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__building-effects\[data-farm-building-effect-focus="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects:focus-visible[\s\S]*outline:\s*3px solid var\(--farm-sky\)/);
  assert.match(css, /\.t8-farm-story-panel__building-effects:focus-visible::after[\s\S]*content:\s*"已定位"/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt \{[\s\S]*justify-self:\s*end[\s\S]*max-width:\s*min\(100%, 280px\)[\s\S]*flex-wrap:\s*wrap[\s\S]*animation:\s*farm-story-building-effect-receipt/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt b \{[\s\S]*max-width:\s*72px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token\] \{[\s\S]*max-width:\s*132px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token\] b \{[\s\S]*max-width:\s*46px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token\] i\[data-farm-building-effect-receipt-token-next\] \{[\s\S]*max-width:\s*32px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token\] i\[data-farm-building-effect-receipt-token-next\] \{[\s\S]*animation:\s*farm-story-building-effect-target-pop/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token\] i\[data-farm-building-effect-receipt-token-next-tone="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token\] i\[data-farm-building-effect-receipt-token-next-tone="storage"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token\] i\[data-farm-building-effect-receipt-token-next-tone="board"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token\] i\[data-farm-building-effect-receipt-token-next-tone="scarecrow"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token\] i\[data-farm-building-effect-receipt-token-next-tone="home"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token="storage"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token="board"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token="scarecrow"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token="home"\]/);
  assert.match(css, /@keyframes farm-story-building-effect-receipt/);
  assert.match(css, /@keyframes farm-story-building-effect-target-pop/);
  assert.match(css, /\.t8-farm-story-panel__building-effects-head/);
  assert.match(css, /\.t8-farm-story-panel__building-effects-head em\[data-farm-building-effect-summary\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects-head em\[data-farm-building-effect-summary\] \{[\s\S]*margin-left:\s*auto[\s\S]*max-width:\s*96px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\] \{[\s\S]*display:\s*flex[\s\S]*flex-wrap:\s*wrap[\s\S]*max-width:\s*100%/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\] b\[data-farm-building-effect-summary-token\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\] b\[data-farm-building-effect-summary-token\]\[data-farm-building-effect-summary-token-yield\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\] b\[data-farm-building-effect-summary-token\] em\[data-farm-building-effect-summary-token-yield-text\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\] b\[data-farm-building-effect-summary-token\] em\[data-farm-building-effect-summary-token-yield-text\] \{[\s\S]*max-width:\s*48px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\] b\[data-farm-building-effect-summary-token="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\] b\[data-farm-building-effect-summary-token="storage"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\] b\[data-farm-building-effect-summary-token="board"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\] b\[data-farm-building-effect-summary-token="scarecrow"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects > small\[data-farm-building-effect-summary-detail\] b\[data-farm-building-effect-summary-token="home"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="storage"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="board"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="scarecrow"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="home"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects em\[data-farm-building-effect-support\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects strong\[data-farm-building-effect-status\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects i\[data-farm-building-effect-hint\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects small\[data-farm-building-effect-yield\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-yield-stamp\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-receipt-active="true"\] \{[\s\S]*animation:\s*farm-story-building-effect-row-receipt/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] \{[\s\S]*grid-column:\s*1 \/ -1[\s\S]*display:\s*inline-flex[\s\S]*max-width:\s*218px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] b\[data-farm-building-effect-row-receipt-yield\] \{[\s\S]*max-width:\s*46px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] i\[data-farm-building-effect-row-receipt-hint\] \{[\s\S]*max-width:\s*54px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] em\[data-farm-building-effect-row-receipt-next\] \{[\s\S]*max-width:\s*34px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] em\[data-farm-building-effect-row-receipt-next\] \{[\s\S]*animation:\s*farm-story-building-effect-target-pop/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] em\[data-farm-building-effect-row-receipt-next-tone="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] em\[data-farm-building-effect-row-receipt-next-tone="storage"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] em\[data-farm-building-effect-row-receipt-next-tone="board"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] em\[data-farm-building-effect-row-receipt-next-tone="scarecrow"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] em\[data-farm-building-effect-row-receipt-next-tone="home"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt-tone="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt-tone="storage"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt-tone="board"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt-tone="scarecrow"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt-tone="home"\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects em\[data-farm-building-effect-support\] \{[\s\S]*max-width:\s*46px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effects strong\[data-farm-building-effect-status\] \{[\s\S]*max-width:\s*48px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effects i\[data-farm-building-effect-hint\] \{[\s\S]*grid-column:\s*1 \/ 4[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effects small\[data-farm-building-effect-yield\] \{[\s\S]*grid-column:\s*4 \/ -1[\s\S]*max-width:\s*64px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-yield-stamp\] \{[\s\S]*grid-column:\s*1 \/ -1[\s\S]*justify-self:\s*end[\s\S]*animation:\s*farm-story-building-effect-yield-stamp-pop/);
  assert.match(css, /@keyframes farm-story-building-effect-status-pulse/);
  assert.match(css, /@keyframes farm-story-building-effect-yield-stamp-pop/);
  assert.match(css, /@keyframes farm-story-building-effect-row-receipt/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="water"\] strong\[data-farm-building-effect-status\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="storage"\] strong\[data-farm-building-effect-status\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="board"\] strong\[data-farm-building-effect-status\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="scarecrow"\] strong\[data-farm-building-effect-status\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="home"\] strong\[data-farm-building-effect-status\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="water"\] i\[data-farm-building-effect-hint\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="storage"\] i\[data-farm-building-effect-hint\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="board"\] i\[data-farm-building-effect-hint\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="scarecrow"\] i\[data-farm-building-effect-hint\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="home"\] i\[data-farm-building-effect-hint\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="water"\] small\[data-farm-building-effect-yield\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="storage"\] small\[data-farm-building-effect-yield\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="board"\] small\[data-farm-building-effect-yield\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="scarecrow"\] small\[data-farm-building-effect-yield\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="home"\] small\[data-farm-building-effect-yield\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="water"\] mark\[data-farm-building-effect-yield-stamp\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="storage"\] mark\[data-farm-building-effect-yield-stamp\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="board"\] mark\[data-farm-building-effect-yield-stamp\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="scarecrow"\] mark\[data-farm-building-effect-yield-stamp\]/);
  assert.match(css, /\.t8-farm-story-panel__building-effects li\[data-farm-building-effect-support="home"\] mark\[data-farm-building-effect-yield-stamp\]/);
  assert.match(css, /@keyframes farm-story-building-effect-focus/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.t8-farm-story-panel__building-effects\[data-farm-building-effect-focus="true"\],[\s\S]*\.t8-farm-story-panel__building-effect-receipt,[\s\S]*\.t8-farm-story-panel__building-effect-receipt em\[data-farm-building-effect-receipt-token\] i\[data-farm-building-effect-receipt-token-next\],[\s\S]*\.t8-farm-story-panel__building-effects mark\[data-farm-building-effect-row-receipt\] em\[data-farm-building-effect-row-receipt-next\],[\s\S]*animation:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__animals/);
  assert.match(css, /\.t8-farm-story-panel__animals-head/);
  assert.match(css, /\.t8-farm-story-panel__animals-head em\[data-farm-animal-mood-hint\] \{[\s\S]*grid-column:\s*1 \/ -1[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__animals-head i\[data-farm-animal-next-products\] \{[\s\S]*grid-column:\s*1 \/ -1[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__animals-head button\[data-farm-animal-next-products-action="true"\] \{[\s\S]*grid-column:\s*1 \/ -1[\s\S]*cursor:\s*pointer/);
  assert.match(css, /\.t8-farm-story-panel__animals-head button\[data-farm-animal-next-products-action="true"\]:hover[\s\S]*transform:\s*translateY\(-1px\)/);
  assert.match(css, /\.t8-farm-story-panel__animals-head button\[data-farm-animal-next-products-action="true"\]:focus-visible[\s\S]*outline:\s*2px solid var\(--farm-sky\)/);
  assert.match(css, /\.t8-farm-story-panel__animals-head button\[data-farm-animal-next-products-action="true"\] em \{[\s\S]*max-width:\s*48px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__animals-head small\[data-farm-animal-product-receipt="true"\] \{[\s\S]*grid-column:\s*1 \/ -1[\s\S]*animation:\s*farm-story-animal-product-receipt/);
  assert.match(css, /\.t8-farm-story-panel__animals-head small\[data-farm-animal-product-receipt="true"\]\[data-farm-animal-product-located="true"\] \{[\s\S]*border-color:/);
  assert.match(css, /\.t8-farm-story-panel__animals-head em\[data-farm-animal-product-located-badge="true"\] \{[\s\S]*animation:\s*farm-story-animal-product-located-badge/);
  assert.match(css, /\.t8-farm-story-panel__animals-head small\[data-farm-animal-product-receipt="true"\] b \{[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /@keyframes farm-story-animal-product-receipt/);
  assert.match(css, /@keyframes farm-story-animal-product-located-badge/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*small\[data-farm-animal-product-receipt="true"\][\s\S]*em\[data-farm-animal-product-located-badge="true"\][\s\S]*animation:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__animals li\[data-farm-animal-mood="happy"\]/);
  assert.match(css, /\.t8-farm-story-panel__animals li\[data-farm-animal-mood="calm"\]/);
  assert.match(css, /\.t8-farm-story-panel__animals li\[data-farm-animal-mood="hungry"\]/);
  assert.match(css, /\.t8-farm-story-panel__animals li\[data-farm-animal-product-ready="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__animals li\[data-farm-animal-next-product-ready="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__animals li\[data-farm-animal-produced-today="true"\] \{[\s\S]*box-shadow:[\s\S]*var\(--farm-wheat\)/);
  assert.match(css, /\.t8-farm-story-panel__animals li small \{[\s\S]*display:\s*flex[\s\S]*gap:\s*4px/);
  assert.match(css, /\.t8-farm-story-panel__animals \[data-farm-animal-mood-chip\]/);
  assert.match(css, /\.t8-farm-story-panel__animals mark\[data-farm-animal-product-chip\]/);
  assert.match(css, /\.t8-farm-story-panel__animals \[data-farm-animal-today-product-chip\]/);
  assert.match(css, /\.t8-farm-story-panel__animals \[data-farm-animal-next-product-chip\]/);
  assert.match(css, /\.t8-farm-story-panel__animals li\[data-farm-animal-product-ready="true"\] mark\[data-farm-animal-product-chip\]/);
  assert.match(css, /\.t8-farm-story-panel__animals li\[data-farm-animal-produced-today="true"\] \[data-farm-animal-today-product-chip\]/);
  assert.match(css, /\.t8-farm-story-panel__animals li\[data-farm-animal-next-product-ready="true"\] \[data-farm-animal-next-product-chip\]/);
  assert.match(css, /\.t8-farm-story-panel__npc\[data-farm-npc-delivery-active="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc\[data-farm-npc-focus="true"\] \{[\s\S]*animation:\s*farm-story-npc-focus/);
  assert.match(css, /\.t8-farm-story-panel__npc-meta small\[data-farm-npc-reward\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-bond/);
  assert.match(css, /\.t8-farm-story-panel__npc-bond\[data-farm-npc-bond-ready="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-bond-meter/);
  assert.match(css, /\.t8-farm-story-panel__npc-bond-meter > span \{[\s\S]*width:\s*var\(--farm-npc-bond-progress, 0%\)/);
  assert.match(css, /\[data-farm-npc-bond-next-reward="true"\]/);
  assert.match(css, /\[data-farm-npc-bond-after-delivery="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-bond-milestone/);
  assert.match(css, /\.t8-farm-story-panel__npc-bond-milestone\[data-farm-npc-bond-milestone="true"\]/);
  assert.match(css, /\[data-farm-npc-bond-milestone-reward\]/);
  assert.match(css, /\[data-farm-npc-bond-milestone-story\]/);
  assert.match(css, /@keyframes farm-story-npc-bond-milestone/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.t8-farm-story-panel__npc-bond-milestone\[data-farm-npc-bond-milestone="true"\][\s\S]*animation:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__npc-return-promise/);
  assert.match(css, /\.t8-farm-story-panel__npc-return-promise\[data-farm-npc-return-promise="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-return-promise\[data-farm-npc-return-promise-tone="seed"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-return-promise\[data-farm-npc-return-promise-tone="build"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-return-promise\[data-farm-npc-return-promise-tone="flower"\]/);
  assert.match(css, /\[data-farm-npc-return-promise-story="true"\]/);
  assert.match(css, /\[data-farm-npc-return-promise-completed="true"\]/);
  assert.match(css, /@keyframes farm-story-npc-return-promise/);
  assert.match(css, /\.t8-farm-story-panel__npc-prep-hint/);
  assert.match(css, /\.t8-farm-story-panel__npc-prep-hint\[data-farm-npc-prep-hint="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-prep-hint\[data-farm-npc-prep-tone="ready"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-prep-hint\[data-farm-npc-prep-tone="crop"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-prep-hint\[data-farm-npc-prep-tone="water"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-prep-hint\[data-farm-npc-prep-tone="animal"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-prep-hint\[data-farm-npc-prep-tone="day"\]/);
  assert.match(css, /\[data-farm-npc-prep-story="true"\]/);
  assert.match(css, /\[data-farm-npc-prep-action-button="true"\]/);
  assert.match(css, /@keyframes farm-story-npc-prep-hint/);
  assert.match(css, /\.t8-farm-story-panel__npc-meta em\[data-farm-npc-delivery-feedback="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc-meta em\[data-farm-npc-located-feedback="true"\] \{[\s\S]*animation:\s*farm-story-npc-located-feedback/);
  assert.match(css, /\.t8-farm-story-panel__npc-delivery-receipt/);
  assert.match(css, /\.t8-farm-story-panel__npc-delivery-receipt\[data-farm-npc-delivery-receipt="true"\]/);
  assert.match(css, /\[data-farm-npc-delivery-receipt-route-hint="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__npc button\[data-farm-npc-delivery-active="true"\]/);
  assert.match(css, /@keyframes farm-story-npc-focus/);
  assert.match(css, /@keyframes farm-story-npc-located-feedback/);
  assert.match(css, /@keyframes farm-story-npc-delivery-receipt/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.t8-farm-story-panel__npc\[data-farm-npc-focus="true"\][\s\S]*em\[data-farm-npc-located-feedback="true"\][\s\S]*\[data-farm-npc-delivery-receipt="true"\][\s\S]*animation:\s*none/);
  assert.match(css, /\.t8-farm-story-panel__quest\.is-ready/);
  assert.match(css, /\.t8-farm-story-panel__quest\[data-farm-order-focus="true"\] \{[\s\S]*animation:\s*farm-story-order-focus/);
  assert.match(css, /\.t8-farm-story-panel__quest-reward/);
  assert.match(css, /\.t8-farm-story-panel__quest\.is-ready \.t8-farm-story-panel__quest-reward/);
  assert.match(css, /\.t8-farm-story-panel__quest-reward\[data-farm-order-stamp-active="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__quest-reward em\[data-farm-order-stamp-feedback="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__quest-reward em\[data-farm-order-located-feedback="true"\] \{[\s\S]*animation:\s*farm-story-order-located-feedback/);
  assert.match(css, /\.t8-farm-story-panel__order-reward-pocket/);
  assert.match(css, /\.t8-farm-story-panel__order-reward-pocket\[data-farm-order-reward-pocket="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__order-reward-pocket\[data-farm-order-reward-pocket-route-target="ready-order"\]/);
  assert.match(css, /\.t8-farm-story-panel__order-reward-pocket \[data-farm-order-reward-pocket-route-hint="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__order-reward-pocket \[data-farm-order-reward-pocket-next-action="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__order-reward-pocket \[data-farm-order-reward-pocket-next-action-kind="complete-order"\]/);
  assert.match(css, /\.t8-farm-story-panel__order-reward-pocket \[data-farm-order-reward-pocket-next-action-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__order-reward-pocket\[data-farm-order-reward-pocket-route-receipt="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__quest-reward em\[data-farm-order-festival-link="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__quest-reward i\[data-farm-order-festival-reward="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__quest-reward\[data-farm-order-festival-completes="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__quest-reward\[data-farm-order-festival-completes="true"\] i\[data-farm-order-festival-reward="true"\]/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__quest-reward \{[\s\S]*grid-template-columns:\s*18px minmax\(0, 1fr\) auto[\s\S]*gap:\s*4px/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__quest-reward i\[data-farm-order-festival-reward="true"\] \{[\s\S]*grid-column:\s*2 \/ -1[\s\S]*max-width:\s*100%/);
  assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.t8-farm-story-panel__quest-reward em\[data-farm-order-festival-link="true"\],[\s\S]*\.t8-farm-story-panel__quest-reward em\[data-farm-order-stamp-feedback="true"\] \{[\s\S]*max-width:\s*82px/);
  assert.match(css, /button\[data-farm-order-stamp-active="true"\]/);
  assert.match(css, /button\[data-farm-order-button-festival-completes="true"\]/);
  assert.match(css, /button\[data-farm-order-button-festival-reward\]/);
  assert.match(css, /button\[data-farm-order-button-festival-reward\]::after/);
  assert.match(css, /@keyframes farm-story-order-focus/);
  assert.match(css, /@keyframes farm-story-order-located-feedback/);
  assert.match(css, /@keyframes farm-story-order-reward-pocket/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*button\[data-farm-mini-status-item="ready-order"\]\[data-farm-mini-ready-order-opened="true"\]::after[\s\S]*\.t8-farm-story-panel__quest\[data-farm-order-focus="true"\][\s\S]*em\[data-farm-order-located-feedback="true"\][\s\S]*animation:\s*none/);
  assert.match(css, /content:\s*'节庆奖'/);
  assert.match(css, /\.t8-farm-story-panel__quest-reward em\[data-farm-order-stamp-festival-reward\]/);
  assert.match(css, /button\[data-farm-order-stamp-active="true"\]\[data-farm-order-button-festival-reward\]/);
  assert.match(css, /\.t8-farm-story-panel__feedback/);
  assert.match(css, /\.t8-farm-story-panel__sound/);
  assert.match(css, /\.t8-farm-story-panel__sound\.is-active/);
  assert.match(css, /\.t8-farm-story-panel__summary/);
  assert.match(css, /\.t8-farm-story-panel__summary-head em/);
  assert.match(css, /\.t8-farm-story-panel__summary-metrics/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions/);
  assert.match(css, /data-farm-summary-action-tone="mature"/);
  assert.match(css, /data-farm-summary-action-tone="water"/);
  assert.match(css, /data-farm-summary-action-tone="cleanup"/);
  assert.match(css, /data-farm-summary-action-tone="build"/);
  assert.match(css, /data-farm-summary-action-tone="ready"/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions \[data-farm-summary-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-resource-targets~="water"\] \[data-farm-summary-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-resource-targets~="gold"\] \[data-farm-summary-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-resource-targets~="mature"\] \[data-farm-summary-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-resource-targets~="withered"\] \[data-farm-summary-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-resource-targets~="wood"\] \[data-farm-summary-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-resource-targets~="stone"\] \[data-farm-summary-action-resource="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-resource-targets~="scarecrow"\] \[data-farm-summary-action-resource="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions button\[data-farm-summary-action-feedback="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions \[data-farm-summary-action-resource-feedback="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions button\[data-farm-summary-action-feedback="true"\] \[data-farm-summary-action-resource="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions \[data-farm-summary-action-feedback-stamp="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions button\[data-farm-summary-action-feedback="true"\] \[data-farm-summary-action-feedback-stamp="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-tone="water"\]\[data-farm-summary-action-feedback="true"\] \[data-farm-summary-action-feedback-stamp="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-tone="mature"\]\[data-farm-summary-action-feedback="true"\] \[data-farm-summary-action-feedback-stamp="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-tone="cleanup"\]\[data-farm-summary-action-feedback="true"\] \[data-farm-summary-action-feedback-stamp="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-tone="ready"\]\[data-farm-summary-action-feedback="true"\] \[data-farm-summary-action-feedback-stamp="true"\]/);
  assert.match(css, /button\[data-farm-summary-action-tone="build"\]\[data-farm-summary-action-feedback="true"\] \[data-farm-summary-action-feedback-stamp="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-action-receipt/);
  assert.match(css, /\.t8-farm-story-panel__summary-action-receipt \[data-farm-summary-action-receipt-resource="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-action-receipt \[data-farm-summary-action-receipt-stamp="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-action-receipt \[data-farm-summary-action-receipt-next-hint="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-action-receipt \[data-farm-summary-action-receipt-next-badge="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-action-receipt \[data-farm-summary-action-receipt-next-count="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-action-receipt \[data-farm-summary-action-receipt-next-count="true"\] \{[\s\S]*max-width:\s*48px[\s\S]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.t8-farm-story-panel__summary-action-receipt \[data-farm-summary-action-receipt-next-badge="true"\] \{[\s\S]*animation:\s*farm-story-summary-next-badge-pop/);
  assert.match(css, /@keyframes farm-story-summary-next-badge-pop/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.t8-farm-story-panel__summary-action-receipt \[data-farm-summary-action-receipt-next-badge="true"\][\s\S]*animation: none/);
  assert.match(css, /data-farm-summary-action-receipt-next-targets~="water"/);
  assert.match(css, /data-farm-summary-action-receipt-next-targets~="mature"/);
  assert.match(css, /data-farm-summary-action-receipt-next-targets~="withered"/);
  assert.match(css, /data-farm-summary-action-receipt-next-targets~="gold"/);
  assert.match(css, /data-farm-summary-action-receipt-next-targets~="scarecrow"/);
  assert.match(css, /data-farm-summary-action-receipt-targets~="water"/);
  assert.match(css, /data-farm-summary-action-receipt-targets~="scarecrow"/);
  assert.match(css, /data-farm-summary-action-receipt-tone="water"/);
  assert.match(css, /data-farm-summary-action-receipt-tone="mature"/);
  assert.match(css, /data-farm-summary-action-receipt-tone="cleanup"/);
  assert.match(css, /data-farm-summary-action-receipt-tone="ready"/);
  assert.match(css, /data-farm-summary-action-receipt-tone="build"/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions button\[data-farm-summary-action-cooldown="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions button\[data-farm-summary-action-cooldown="true"\]::after/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions button\[data-farm-summary-action-cooldown="true"\]:hover[\s\S]*transform: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.t8-farm-story-panel__summary-actions button\[data-farm-summary-action-feedback="true"\][\s\S]*animation: none/);
  assert.match(css, /\.t8-farm-story-panel__summary-actions button:hover/);
  assert.match(css, /\.t8-farm-story-panel__festival-task/);
  assert.match(css, /\.t8-farm-story-panel__festival-task\[data-farm-festival-task-ready-via-order="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__festival-task\[data-farm-festival-task-completes-via-order="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__festival-task-head em\[data-farm-festival-task-completion-badge="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__festival-task-forecast/);
  assert.match(css, /\.t8-farm-story-panel__festival-task-forecast\[data-farm-festival-task-forecast-tone="complete"\]/);
  assert.match(css, /\[data-farm-festival-task-progress-forecast="true"\]/);
  assert.match(css, /\.t8-farm-story-panel__festival-task-progress/);
  assert.match(css, /\.t8-farm-story-panel__log/);
});

test('canvas route persists sanitized farm canvas state and mirrors it in auto-save', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't8-farm-canvas-route-'));
  const dataDir = path.join(tmpDir, 'data');
  const autoRoot = path.join(tmpDir, 'auto');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ canvasAutoSavePath: autoRoot }), 'utf8');

  const config = require('../backend/src/config.js');
  const oldConfig = {
    DATA_DIR: config.DATA_DIR,
    CANVAS_FILE: config.CANVAS_FILE,
    SETTINGS_FILE: config.SETTINGS_FILE,
    DEFAULT_CANVAS_AUTO_SAVE_DIR: config.DEFAULT_CANVAS_AUTO_SAVE_DIR,
  };
  t.after(() => Object.assign(config, oldConfig));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  config.DATA_DIR = dataDir;
  config.CANVAS_FILE = path.join(dataDir, 'canvas_list.json');
  config.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  config.DEFAULT_CANVAS_AUTO_SAVE_DIR = autoRoot;
  fs.writeFileSync(
    config.CANVAS_FILE,
    JSON.stringify([{ id: 'canvas-farm-test', name: '牧场画布', nodeCount: 1, createdAt: 1, updatedAt: 1 }]),
    'utf8',
  );

  const express = require('express');
  const canvasRouter = require('../backend/src/routes/canvas.js');
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/canvas', canvasRouter);

  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const body = {
    nodes: [{ id: 'text-1', type: 'text', position: { x: 0, y: 0 }, data: { nodeSerialId: 1 } }],
    edges: [],
    viewport: { x: -80, y: 40, zoom: 0.75 },
    nextNodeSerialId: 2,
    farmCanvas: {
      version: 99,
      coordinateMode: 'viewport',
      gridSize: 0,
      day: -8,
      season: 'bad-season',
      weather: 'bad-weather',
      festivalId: 'bad id',
      resources: { gold: -10, wood: 2, stone: 1, water: 9999, experience: 5, seeds: { turnip: 2, bad: 99 } },
      inventory: { crops: { turnip: 1, bad: 3 }, animalProducts: { egg: 2, wool: 1, bad: 9 }, decorIds: ['wood-fence', 'wood-fence'] },
      objects: [
        { id: 'decor-1', kind: 'decor', x: 95, y: -95, widthCells: 1, heightCells: 1, decorId: 'sign', resourceId: 'data:image/png;base64,abc', createdDay: 1 },
        { id: 'plot-1', kind: 'plot', x: 128, y: 0, widthCells: 1, heightCells: 1, crop: { cropId: 'turnip', dryDays: 4, stage: 'mature' }, createdDay: 1 },
      ],
      animals: [
        { id: 'bad animal id', kind: 'dragon', name: 'bad', mood: 'wild', placedDay: -1, productCount: -1 },
        {
          id: 'cow-1',
          kind: 'cow',
          name: '奶牛 prompt: hidden https://example.com/cow.png C:\\Users\\Secret\\cow.png',
          mood: 'happy',
          placedDay: 1,
          lastProducedDay: 99,
          productCount: 5,
        },
      ],
      orders: [],
      eventLog: [
        {
          id: 'unsafe-event',
          kind: 'bad-kind',
          day: -1,
          message: 'prompt: hidden https://example.com/out.png data:image/png;base64,abc C:\\Users\\Secret\\out.png',
          cropId: 'bad',
          objectKind: 'bad',
          rareEventId: 'rare-event-1-giant-turnip-plot',
          createdAt: 0,
        },
      ],
      lastDailySummary: {
        id: 'unsafe-summary',
        fromDay: -2,
        toDay: -1,
        message: 'prompt: hidden https://example.com/summary.png data:image/png;base64,abc C:\\Users\\Secret\\summary.png',
        harvestedCrops: -1,
        ordersCompleted: 1,
        goldEarned: 999999999,
        weather: 'festival',
        festivalId: 'spring-sowing-7',
        rainWateredCrops: 2,
        festivalBonusGold: 999999999,
        animalProductsProduced: 999999,
        animalProductSummary: '牛奶 x1 https://example.com C:\\Users\\Secret\\milk.png prompt: hidden',
        npcVisitsCompleted: 999999,
        rareEventsFound: 999999,
        rareEventSummary: '巨大萝卜 https://example.com C:\\Users\\Secret\\rare.png prompt: hidden',
        readyOrders: 999999,
        readyNpcVisits: 999999,
        dailyWaterCapacity: 999999,
        scarecrowProtectedCrops: 999999,
        wateredCrops: 2,
        dryCrops: 3,
        witheredCrops: 4,
        newMatureCrops: 5,
        matureCrops: 6,
        nextMatureCrops: 7,
        highlights: ['https://example.com/a', 'prompt: bad', '安全摘要'],
        createdAt: 0,
      },
      festivalTasks: [
        {
          id: 'bad task id',
          festivalId: 'bad festival id',
          title: '节庆委托',
          description: 'prompt: hidden https://example.com/task.png data:image/png;base64,abc C:\\Users\\Secret\\task.png',
          kind: 'bad-kind',
          target: 99,
          progress: 99,
          rewards: { gold: 999999999, wood: 3, seeds: { sunflower: 2, bad: 9 }, decorIds: ['wood-fence', 'bad id'] },
          completed: true,
          completedDay: -2,
        },
      ],
      rareEvents: [
        {
          id: 'bad rare event id',
          eventId: 'giant-turnip',
          title: '巨大萝卜 https://example.com C:\\Users\\Secret\\rare.png',
          message: 'prompt: hidden https://example.com/rare.png data:image/png;base64,abc C:\\Users\\Secret\\rare.png',
          day: 99,
          cropId: 'turnip',
          rewards: { gold: 999999999, seeds: { turnip: 2, bad: 9 }, decorIds: ['wood-fence', 'bad id'] },
        },
      ],
      stats: { plotsTilled: -5, rareEventsFound: 999999999, buildingsPlaced: 999999999, decorPlaced: 999999999 },
      selectedTool: 'hoe',
    },
  };

  const saved = await fetch(`${base}/api/canvas/canvas-farm-test`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json());
  assert.equal(saved.success, true);

  const loaded = await fetch(`${base}/api/canvas/canvas-farm-test`).then((res) => res.json());
  assert.equal(loaded.success, true);
  assert.equal(loaded.data.farmCanvas.version, 1);
  assert.equal(loaded.data.farmCanvas.coordinateMode, 'flow');
  assert.equal(loaded.data.farmCanvas.gridSize, FARM_GRID_SIZE);
  assert.equal(loaded.data.farmCanvas.day, 1);
  assert.equal(loaded.data.farmCanvas.weather, 'sunny');
  assert.equal(loaded.data.farmCanvas.festivalId, undefined);
  assert.equal(loaded.data.farmCanvas.resources.gold, 0);
  assert.equal(loaded.data.farmCanvas.resources.water, 999);
  assert.equal(loaded.data.farmCanvas.resources.seeds.turnip, 2);
  assert.equal(loaded.data.farmCanvas.resources.seeds.bad, undefined);
  assert.equal(loaded.data.farmCanvas.inventory.animalProducts.egg, 2);
  assert.equal(loaded.data.farmCanvas.inventory.animalProducts.wool, 1);
  assert.equal(loaded.data.farmCanvas.inventory.animalProducts.bad, undefined);
  assert.equal(loaded.data.farmCanvas.objects[0].x, 64);
  assert.equal(loaded.data.farmCanvas.objects[0].y, -128);
  assert.equal(loaded.data.farmCanvas.objects[0].resourceId, undefined);
  assert.equal(loaded.data.farmCanvas.objects[1].crop.stage, 'withered');
  assert.equal(loaded.data.farmCanvas.animals.length, 1);
  assert.equal(loaded.data.farmCanvas.animals[0].kind, 'cow');
  assert.equal(loaded.data.farmCanvas.animals[0].lastProducedDay, 1);
  assert.equal(loaded.data.farmCanvas.animals[0].name.includes('example.com'), false);
  assert.equal(loaded.data.farmCanvas.animals[0].name.includes('Secret'), false);
  assert.equal(loaded.data.farmCanvas.orders.length, 3);
  assert.equal(loaded.data.farmCanvas.eventLog.length, 1);
  assert.equal(loaded.data.farmCanvas.eventLog[0].kind, 'tool_feedback');
  assert.equal(loaded.data.farmCanvas.eventLog[0].message.includes('example.com'), false);
  assert.equal(loaded.data.farmCanvas.eventLog[0].message.includes('Secret'), false);
  assert.equal(loaded.data.farmCanvas.eventLog[0].message.includes('prompt:'), false);
  assert.equal(loaded.data.farmCanvas.eventLog[0].rareEventId, 'rare-event-1-giant-turnip-plot');
  assert.equal(loaded.data.farmCanvas.lastDailySummary.fromDay, 1);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.message.includes('example.com'), false);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.message.includes('Secret'), false);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.harvestedCrops, 0);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.goldEarned, 9999999);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.weather, 'festival');
  assert.equal(loaded.data.farmCanvas.lastDailySummary.festivalId, 'spring-sowing-7');
  assert.equal(loaded.data.farmCanvas.lastDailySummary.rainWateredCrops, 2);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.festivalBonusGold, 9999999);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.animalProductsProduced, 9999);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.animalProductSummary.includes('example.com'), false);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.animalProductSummary.includes('Secret'), false);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.npcVisitsCompleted, 9999);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.rareEventsFound, 9999);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.rareEventSummary.includes('example.com'), false);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.rareEventSummary.includes('Secret'), false);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.readyOrders, 9999);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.readyNpcVisits, 9999);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.dailyWaterCapacity, 9999);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.scarecrowProtectedCrops, 9999);
  assert.equal(loaded.data.farmCanvas.lastDailySummary.witheredCrops, 4);
  assert.equal(loaded.data.farmCanvas.festivalTasks.length, 1);
  assert.equal(loaded.data.farmCanvas.festivalTasks[0].festivalId, 'festival-1');
  assert.equal(loaded.data.farmCanvas.festivalTasks[0].kind, 'complete-orders');
  assert.equal(loaded.data.farmCanvas.festivalTasks[0].target, 9);
  assert.equal(loaded.data.farmCanvas.festivalTasks[0].progress, 9);
  assert.equal(loaded.data.farmCanvas.festivalTasks[0].description.includes('example.com'), false);
  assert.equal(loaded.data.farmCanvas.festivalTasks[0].rewards.seeds.sunflower, 2);
  assert.equal(loaded.data.farmCanvas.festivalTasks[0].rewards.seeds.bad, undefined);
  assert.equal(loaded.data.farmCanvas.rareEvents.length, 1);
  assert.equal(loaded.data.farmCanvas.rareEvents[0].id, 'rare-event-1-giant-turnip-0');
  assert.equal(loaded.data.farmCanvas.rareEvents[0].eventId, 'giant-turnip');
  assert.equal(loaded.data.farmCanvas.rareEvents[0].message.includes('example.com'), false);
  assert.equal(loaded.data.farmCanvas.rareEvents[0].message.includes('Secret'), false);
  assert.equal(loaded.data.farmCanvas.rareEvents[0].rewards.seeds.turnip, 2);
  assert.equal(loaded.data.farmCanvas.rareEvents[0].rewards.seeds.bad, undefined);
  assert.equal(loaded.data.farmCanvas.stats.rareEventsFound, 999999);
  assert.equal(loaded.data.farmCanvas.stats.buildingsPlaced, 999999);
  assert.equal(loaded.data.farmCanvas.stats.decorPlaced, 999999);

  const mirrored = await fetch(`${base}/api/canvas/canvas-farm-test/auto-save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json());
  assert.equal(mirrored.success, true);
  const mirrorPayload = JSON.parse(fs.readFileSync(mirrored.data.path, 'utf8'));
  assert.equal(mirrorPayload.farmCanvas.coordinateMode, 'flow');
  assert.equal(mirrorPayload.farmCanvas.weather, 'sunny');
  assert.equal(mirrorPayload.farmCanvas.animals.length, 1);
  assert.equal(mirrorPayload.farmCanvas.inventory.animalProducts.egg, 2);
  assert.equal(mirrorPayload.farmCanvas.orders.length, 3);
  assert.equal(mirrorPayload.farmCanvas.festivalTasks.length, 1);
  assert.equal(mirrorPayload.farmCanvas.rareEvents.length, 1);
  assert.equal(mirrorPayload.farmCanvas.eventLog[0].kind, 'tool_feedback');
  assert.equal(mirrorPayload.farmCanvas.lastDailySummary.message.includes('example.com'), false);

  const created = await fetch(`${base}/api/canvas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '新牧场' }),
  }).then((res) => res.json());
  assert.equal(created.success, true);
  const createdCanvas = await fetch(`${base}/api/canvas/${created.data.id}`).then((res) => res.json());
  assert.equal(createdCanvas.data.farmCanvas.coordinateMode, 'flow');
  assert.equal(createdCanvas.data.farmCanvas.weather, 'sunny');
  assert.equal(createdCanvas.data.farmCanvas.animals.length, 1);
  assert.equal(createdCanvas.data.farmCanvas.animals[0].kind, 'chicken');
  assert.equal(createdCanvas.data.farmCanvas.orders.length, 3);
  assert.equal(createdCanvas.data.farmCanvas.festivalTasks.length, 0);
  assert.equal(createdCanvas.data.farmCanvas.rareEvents.length, 0);
  assert.equal(createdCanvas.data.farmCanvas.eventLog.length, 0);
  assert.equal(createdCanvas.data.farmCanvas.lastDailySummary, undefined);
});
