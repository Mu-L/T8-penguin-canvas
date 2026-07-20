import type {
  GardenPlantDefinition,
  GardenPlantId,
  GardenPlantStats,
  GardenProfile,
  GardenStageDefinition,
  GardenZombieDefinition,
  GardenZombieId,
} from './types.ts';

export const GARDEN_PLANT_ORDER: GardenPlantId[] = [
  'sun-bloom',
  'pea-scout',
  'frost-bulb',
  'wall-root',
  'ember-melon',
  'storm-reed',
  'healer-clover',
  'chrono-mushroom',
];

export const GARDEN_PLANTS: Record<GardenPlantId, GardenPlantDefinition> = {
  'sun-bloom': {
    id: 'sun-bloom', name: '曦光花', role: 'sun', cost: 50, cooldownMs: 5200, maxHp: 280, damage: 0,
    actionIntervalMs: 10500, unlockStage: 1, description: '稳定凝聚阳光，是每套阵容的经济核心。', upgradeBlurb: '更快产出，并额外提高生命。',
  },
  'pea-scout': {
    id: 'pea-scout', name: '豆荚侦察兵', role: 'shooter', cost: 100, cooldownMs: 4300, maxHp: 310, damage: 34,
    actionIntervalMs: 1380, projectileSpeed: 320, unlockStage: 1, description: '向本行最前方持续发射硬壳种子。', upgradeBlurb: '提高种子伤害与射速。',
  },
  'frost-bulb': {
    id: 'frost-bulb', name: '霜晶球根', role: 'control', cost: 150, cooldownMs: 7600, maxHp: 300, damage: 26,
    actionIntervalMs: 1900, projectileSpeed: 285, unlockStage: 2, description: '冰晶种子会降低入侵者移动速度。', upgradeBlurb: '延长减速并提高冰晶伤害。',
  },
  'wall-root': {
    id: 'wall-root', name: '苔甲根卫', role: 'tank', cost: 75, cooldownMs: 9800, maxHp: 1650, damage: 0,
    actionIntervalMs: 0, unlockStage: 2, description: '用厚重木甲挡住一整条进攻路线。', upgradeBlurb: '显著增加木甲生命与自愈。',
  },
  'ember-melon': {
    id: 'ember-melon', name: '烬火瓜炮', role: 'splash', cost: 225, cooldownMs: 10500, maxHp: 330, damage: 105,
    actionIntervalMs: 3200, projectileSpeed: 235, unlockStage: 4, description: '抛射会爆裂的火种，对小范围敌人造成伤害。', upgradeBlurb: '扩大爆炸范围并提高伤害。',
  },
  'storm-reed': {
    id: 'storm-reed', name: '雷鸣苇', role: 'control', cost: 200, cooldownMs: 8900, maxHp: 320, damage: 54,
    actionIntervalMs: 2450, unlockStage: 6, description: '闪电会在相邻目标间跳跃。', upgradeBlurb: '增加连锁目标与电击伤害。',
  },
  'healer-clover': {
    id: 'healer-clover', name: '露珠苜蓿', role: 'support', cost: 125, cooldownMs: 8200, maxHp: 360, damage: 0,
    actionIntervalMs: 4800, unlockStage: 8, description: '周期治疗附近受伤植物并产生少量阳光。', upgradeBlurb: '提高治疗量并缩短施法间隔。',
  },
  'chrono-mushroom': {
    id: 'chrono-mushroom', name: '时轮菇', role: 'control', cost: 250, cooldownMs: 12000, maxHp: 420, damage: 22,
    actionIntervalMs: 5200, unlockStage: 11, description: '释放时间孢子，让整行敌人陷入迟滞。', upgradeBlurb: '增强全行迟滞与孢子伤害。',
  },
};

export const GARDEN_ZOMBIE_ORDER: GardenZombieId[] = [
  'drifter', 'pothead', 'bucket-guard', 'sprinter', 'gatekeeper', 'mole-miner', 'moth-conductor', 'compost-titan',
];

export const GARDEN_ZOMBIES: Record<GardenZombieId, GardenZombieDefinition> = {
  drifter: { id: 'drifter', name: '游荡园丁', maxHp: 220, speed: 18, damage: 38, attackIntervalMs: 1100, rewardSun: 8, unlockWave: 1, description: '最常见的缓慢入侵者。' },
  pothead: { id: 'pothead', name: '陶盆护头', maxHp: 520, speed: 16, damage: 44, attackIntervalMs: 1080, rewardSun: 12, unlockWave: 2, description: '碎花盆提供了额外防护。' },
  'bucket-guard': { id: 'bucket-guard', name: '铁桶守卫', maxHp: 980, speed: 13, damage: 54, attackIntervalMs: 980, rewardSun: 18, unlockWave: 3, description: '高耐久前排，会稳步压缩防线。' },
  sprinter: { id: 'sprinter', name: '猩红疾行者', maxHp: 310, speed: 34, damage: 34, attackIntervalMs: 780, rewardSun: 14, unlockWave: 3, description: '受伤后会进入短暂冲刺。' },
  gatekeeper: { id: 'gatekeeper', name: '温室门卫', maxHp: 1450, speed: 11, damage: 66, attackIntervalMs: 1180, rewardSun: 24, unlockWave: 4, description: '木门盾牌可削弱正面投射物。' },
  'mole-miner': { id: 'mole-miner', name: '地穴矿工', maxHp: 650, speed: 23, damage: 58, attackIntervalMs: 900, rewardSun: 20, unlockWave: 5, description: '前半程潜地，难以被普通种子命中。' },
  'moth-conductor': { id: 'moth-conductor', name: '夜蛾指挥家', maxHp: 820, speed: 14, damage: 50, attackIntervalMs: 980, rewardSun: 28, unlockWave: 6, description: '周期鼓舞并治疗附近入侵者。' },
  'compost-titan': { id: 'compost-titan', name: '堆肥古树王', maxHp: 6200, speed: 8, damage: 135, attackIntervalMs: 1250, rewardSun: 100, unlockWave: 7, boss: true, description: '会震击整行植物的关底首领。' },
};

export const GARDEN_STAGES: GardenStageDefinition[] = [
  { id: 'garden-01', number: 1, name: '初醒草坪', subtitle: '守住第一缕晨光', totalWaves: 4, startingSun: 225, rewardLeaves: 2, rewardXp: 80, difficulty: 1 },
  { id: 'garden-02', number: 2, name: '陶盆来客', subtitle: '厚头盔首次出现', totalWaves: 5, startingSun: 200, rewardLeaves: 2, rewardXp: 100, difficulty: 1.12 },
  { id: 'garden-03', number: 3, name: '疾行小径', subtitle: '别让红围巾钻空子', totalWaves: 5, startingSun: 200, rewardLeaves: 3, rewardXp: 125, difficulty: 1.24 },
  { id: 'garden-04', number: 4, name: '烬火试炼', subtitle: '用爆裂火种清场', totalWaves: 6, startingSun: 175, rewardLeaves: 3, rewardXp: 150, difficulty: 1.36 },
  { id: 'garden-05', number: 5, name: '铁桶黄昏', subtitle: '坚甲队列逼近', totalWaves: 6, startingSun: 175, rewardLeaves: 3, rewardXp: 180, difficulty: 1.5 },
  { id: 'garden-06', number: 6, name: '雷雨前线', subtitle: '连锁闪电加入防线', totalWaves: 7, startingSun: 175, rewardLeaves: 4, rewardXp: 210, difficulty: 1.65 },
  { id: 'garden-07', number: 7, name: '木门围攻', subtitle: '重盾突破战', totalWaves: 7, startingSun: 150, rewardLeaves: 4, rewardXp: 245, difficulty: 1.8 },
  { id: 'garden-08', number: 8, name: '露珠花园', subtitle: '治疗与续航', totalWaves: 8, startingSun: 150, rewardLeaves: 4, rewardXp: 280, difficulty: 1.95 },
  { id: 'garden-09', number: 9, name: '地穴回声', subtitle: '矿工从土下逼近', totalWaves: 8, startingSun: 150, rewardLeaves: 5, rewardXp: 320, difficulty: 2.1 },
  { id: 'garden-10', number: 10, name: '月下蛾群', subtitle: '夜蛾指挥家登场', totalWaves: 9, startingSun: 150, rewardLeaves: 5, rewardXp: 360, difficulty: 2.3, night: true },
  { id: 'garden-11', number: 11, name: '时轮温室', subtitle: '掌握全行迟滞', totalWaves: 9, startingSun: 125, rewardLeaves: 5, rewardXp: 410, difficulty: 2.5, night: true },
  { id: 'garden-12', number: 12, name: '古树苏醒', subtitle: '首领战：堆肥古树王', totalWaves: 10, startingSun: 150, rewardLeaves: 7, rewardXp: 500, difficulty: 2.75, night: true },
  { id: 'garden-13', number: 13, name: '双线风暴', subtitle: '精英组合轮番进攻', totalWaves: 11, startingSun: 125, rewardLeaves: 7, rewardXp: 580, difficulty: 3 },
  { id: 'garden-14', number: 14, name: '守望长夜', subtitle: '资源紧张的耐久战', totalWaves: 12, startingSun: 100, rewardLeaves: 8, rewardXp: 680, difficulty: 3.25, night: true },
  { id: 'garden-15', number: 15, name: '无尽庭院', subtitle: '每一轮都会更危险', totalWaves: 99, startingSun: 200, rewardLeaves: 10, rewardXp: 800, difficulty: 3.5, endless: true },
];

export function getGardenStage(stageId?: string) {
  return GARDEN_STAGES.find((stage) => stage.id === stageId) || GARDEN_STAGES[0];
}

export function getGardenPlantStats(plantId: GardenPlantId, profile?: Pick<GardenProfile, 'plantUpgrades'>): GardenPlantStats {
  const definition = GARDEN_PLANTS[plantId];
  const level = Math.max(0, Math.min(5, Math.floor(profile?.plantUpgrades?.[plantId] || 0)));
  return {
    maxHp: Math.round(definition.maxHp * (1 + level * 0.16)),
    damage: Math.round(definition.damage * (1 + level * 0.14)),
    actionIntervalMs: definition.actionIntervalMs > 0
      ? Math.max(420, Math.round(definition.actionIntervalMs * (1 - level * 0.055)))
      : 0,
    cost: Math.max(25, definition.cost - (level >= 4 ? 25 : 0)),
  };
}

export function gardenUpgradeCost(plantId: GardenPlantId, currentLevel: number) {
  const definition = GARDEN_PLANTS[plantId];
  return Math.max(1, Math.round(2 + currentLevel * 2 + definition.cost / 100));
}

export function gardenUnlockedPlantsForStage(stageNumber: number): GardenPlantId[] {
  return GARDEN_PLANT_ORDER.filter((id) => GARDEN_PLANTS[id].unlockStage <= Math.max(1, stageNumber));
}

export function gardenZombiePoolForWave(wave: number, isFinalWave: boolean): GardenZombieId[] {
  const pool = GARDEN_ZOMBIE_ORDER.filter((id) => {
    const definition = GARDEN_ZOMBIES[id];
    if (definition.boss) return isFinalWave && wave >= definition.unlockWave;
    return definition.unlockWave <= wave;
  });
  return pool.length > 0 ? pool : ['drifter'];
}
