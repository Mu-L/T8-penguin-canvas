// 画布数据 CRUD 路由(Phase 0 占位,Phase 1 完整实现)
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getProjectDatabase } = require('../services/projectDatabase');
const { mapCanvasMutationError } = require('../services/canvasPatch');

const router = express.Router();

function projectDatabase() {
  return getProjectDatabase(config);
}

function expectedRevisionFromRequest(req) {
  const raw = req.body?.baseRevision ?? req.get('if-match');
  if (raw == null || raw === '') return null;
  const parsed = Number(String(raw).replace(/^W\//, '').replace(/"/g, ''));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

const LOCAL_PATCH_ACTOR_ID = 'local-owner';
const LOCAL_PATCH_SESSION_ID = 'local-session';
const LOCAL_PATCH_AUTHORITY = Object.freeze({
  source: 'local-owner',
  role: 'owner',
  capabilities: Object.freeze(['manageProviders']),
});
const LOCAL_AGENT_PATCH_AUTHORITY = Object.freeze({
  source: 'agent',
  role: 'owner',
  capabilities: Object.freeze([]),
});
const NEW_CANVAS_RESOURCE_OPTIONS = Object.freeze({
  initializeResourceScope: true,
});
const LEGACY_CANVAS_HYDRATION_OPTIONS = Object.freeze({
  initializeResourceScope: false,
});
const CANVAS_SYNC_GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseCanvasSyncAfterRevision(value) {
  if (value == null || value === '') return { valid: true, revision: 0 };
  if (Array.isArray(value) || typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return { valid: false, revision: null };
  }
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0
    ? { valid: true, revision }
    : { valid: false, revision: null };
}

function parseCanvasSyncGeneration(value) {
  if (value == null || value === '') return { valid: true, generation: null };
  if (Array.isArray(value) || typeof value !== 'string' || !CANVAS_SYNC_GENERATION_PATTERN.test(value)) {
    return { valid: false, generation: null };
  }
  return { valid: true, generation: value.toLowerCase() };
}

function localCanvasPatchAuthority(patch) {
  // Canvas Agent plan ids are created by the versioned host planner, not copied
  // from model output. This marker can only reduce local-owner authority.
  return /^agent-plan-/i.test(String(patch?.id || ''))
    ? LOCAL_AGENT_PATCH_AUTHORITY
    : LOCAL_PATCH_AUTHORITY;
}

function sendCanvasPatchError(res, error, options = {}) {
  const mapped = mapCanvasMutationError(error, options);
  return res.status(mapped.status).json(mapped.body);
}

function scopeCanvasPatch(rawPatch, scope) {
  const source = rawPatch && typeof rawPatch === 'object' && !Array.isArray(rawPatch) ? rawPatch : {};
  const patch = {
    ...source,
    operations: Array.isArray(source.operations) ? source.operations.map((rawOperation) => ({
      ...(rawOperation && typeof rawOperation === 'object' && !Array.isArray(rawOperation) ? rawOperation : {}),
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      actorId: scope.actorId,
      sessionId: scope.sessionId,
    })) : source.operations,
  };
  for (const key of ['projectId', 'canvasId', 'actorId', 'sessionId']) delete patch[key];
  return patch;
}

function ensurePatchCanvas(database, canvasId) {
  let document = database.getCanvas(canvasId);
  const file = getCanvasFile(canvasId);
  if (!document && fs.existsSync(file)) {
    document = database.ensureCanvas(
      canvasId,
      readJsonFile(file),
      undefined,
      LEGACY_CANVAS_HYDRATION_OPTIONS,
    );
  }
  return document;
}

function patchResultDocument(result) {
  const document = result?.document;
  return document && typeof document === 'object' && Array.isArray(document.nodes) && Array.isArray(document.edges)
    ? document
    : null;
}

const CANVAS_MIRROR_WARNING_MESSAGES = Object.freeze({
  refresh: Object.freeze({
    code: 'authoritative_canvas_refresh_failed',
    message: '画布已由 SQLite 成功提交，但提交后的权威画布刷新暂时失败；请重新读取画布状态。',
  }),
  document: Object.freeze({
    code: 'legacy_canvas_mirror_failed',
    message: '画布已由 SQLite 成功提交，但兼容画布镜像暂未同步；后续读取会重试修复。',
  }),
  list: Object.freeze({
    code: 'legacy_canvas_list_mirror_failed',
    message: '画布已由 SQLite 成功提交，但兼容画布列表元数据暂未同步。',
  }),
});

// Keep the public Patch warning ABI byte-for-byte stable while sharing the
// same post-commit mirror boundary with snapshot/operation/history writers.
const PATCH_MIRROR_WARNING_MESSAGES = Object.freeze({
  refresh: Object.freeze({
    code: 'authoritative_canvas_refresh_failed',
    message: 'Patch 已由 SQLite 成功提交，但提交后的画布刷新暂时失败；请重新读取画布状态。',
  }),
  document: Object.freeze({
    code: 'legacy_canvas_mirror_failed',
    message: 'Patch 已由 SQLite 成功提交，但兼容画布镜像暂未同步；后续读取会重试修复。',
  }),
  list: Object.freeze({
    code: 'legacy_canvas_list_mirror_failed',
    message: 'Patch 已由 SQLite 成功提交，但兼容画布列表元数据暂未同步。',
  }),
});

const CANVAS_DELETE_MIRROR_WARNING_MESSAGES = Object.freeze({
  document: Object.freeze({
    code: 'legacy_canvas_mirror_cleanup_failed',
    committed: true,
    message: '画布删除已由 SQLite 成功提交，但兼容画布文件暂未清理。',
  }),
  list: Object.freeze({
    code: 'legacy_canvas_list_mirror_failed',
    committed: true,
    message: '画布删除已由 SQLite 成功提交，但兼容画布列表暂未清理。',
  }),
});

function writeCanvasCompatibilityMirrors(canvasId, document, options = {}) {
  const warnings = [];
  const messages = options.messages || CANVAS_MIRROR_WARNING_MESSAGES;
  const logLabel = options.logLabel || 'canvas';
  try {
    atomicWriteJson(getCanvasFile(canvasId), document);
  } catch (_) {
    console.warn(`[${logLabel}] legacy canvas mirror write failed after authoritative SQLite commit`);
    warnings.push(messages.document);
  }
  try {
    const list = loadCanvasList();
    let item = list.find((entry) => entry.id === canvasId);
    if (!item && options.createListItem) {
      item = { ...options.createListItem, id: canvasId };
      list.push(item);
    }
    if (item) {
      item.nodeCount = document.nodes.length;
      item.updatedAt = Number(document.updatedAt) || Date.now();
      item.revision = Number(document.revision) || item.revision;
      saveCanvasList(list);
    }
  } catch (_) {
    console.warn(`[${logLabel}] legacy canvas list mirror write failed after authoritative SQLite commit`);
    warnings.push(messages.list);
  }
  return warnings;
}

function writeAuthoritativeCanvasCompatibilityMirrors(canvasId, fallbackDocument, database = null, options = {}) {
  const warnings = [];
  const messages = options.messages || CANVAS_MIRROR_WARNING_MESSAGES;
  const logLabel = options.logLabel || 'canvas';
  let currentDocument = null;
  try {
    currentDocument = database && typeof database.getCanvas === 'function'
      ? patchResultDocument({ document: database.getCanvas(canvasId) })
      : null;
  } catch (_) {
    console.warn(`[${logLabel}] authoritative canvas refresh failed after SQLite commit`);
    warnings.push(messages.refresh);
  }
  const document = currentDocument || patchResultDocument({ document: fallbackDocument });
  if (document) warnings.push(...writeCanvasCompatibilityMirrors(canvasId, document, options));
  return warnings;
}

function removeCanvasCompatibilityMirrors(canvasId) {
  const warnings = [];
  try {
    const list = loadCanvasList();
    saveCanvasList(list.filter((item) => item.id !== canvasId));
  } catch (_) {
    console.warn('[canvas] legacy canvas list cleanup failed after authoritative SQLite delete');
    warnings.push(CANVAS_DELETE_MIRROR_WARNING_MESSAGES.list);
  }
  try {
    const file = getCanvasFile(canvasId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) {
    console.warn('[canvas] legacy canvas file cleanup failed after authoritative SQLite delete');
    warnings.push(CANVAS_DELETE_MIRROR_WARNING_MESSAGES.document);
  }
  return warnings;
}

function sendAuthoritativePatchResult(res, canvasId, result, database = null) {
  const warnings = writeAuthoritativeCanvasCompatibilityMirrors(
    canvasId,
    patchResultDocument(result),
    database,
    { messages: PATCH_MIRROR_WARNING_MESSAGES, logLabel: 'canvas-patch' },
  );
  return res.json({ success: true, data: result, ...(warnings.length ? { warnings } : {}) });
}

function removeCanvasRequestControls(value) {
  for (const key of ['allowEmpty', 'actorId', 'sessionId', 'clientSeq', 'baseRevision']) delete value[key];
  return value;
}

// 工具函数
function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '').replace(/\0/g, '');
  return JSON.parse(raw);
}

function canvasCreatedAtFromId(id, fallback) {
  const match = String(id || '').match(/^canvas-(\d+)-/);
  if (!match) return fallback;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function recoverCanvasListFromFiles() {
  if (!fs.existsSync(config.DATA_DIR)) return [];
  const items = [];
  for (const entry of fs.readdirSync(config.DATA_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^canvas_canvas-[\w-]+\.json$/.test(entry.name)) continue;
    const id = entry.name.replace(/^canvas_/, '').replace(/\.json$/, '');
    const file = path.join(config.DATA_DIR, entry.name);
    try {
      const data = readJsonFile(file);
      if (!Array.isArray(data?.nodes) || !Array.isArray(data?.edges)) continue;
      const stat = fs.statSync(file);
      const updatedAt = Math.max(1, Math.round(stat.mtimeMs));
      items.push({
        id,
        name: id,
        nodeCount: data.nodes.length,
        createdAt: canvasCreatedAtFromId(id, updatedAt),
        updatedAt,
      });
    } catch {
      // Ignore corrupt canvas payloads; the list should still recover valid canvases.
    }
  }
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

function loadCanvasList() {
  if (!fs.existsSync(config.CANVAS_FILE)) return recoverCanvasListFromFiles();
  try {
    const list = readJsonFile(config.CANVAS_FILE);
    return Array.isArray(list) ? list : recoverCanvasListFromFiles();
  } catch (e) {
    console.warn(`⚠ 画布列表读取失败，尝试从单画布文件恢复: ${e?.message || e}`);
    return recoverCanvasListFromFiles();
  }
}

function saveCanvasList(list) {
  atomicWriteJson(config.CANVAS_FILE, list);
}

function getCanvasFile(id) {
  return path.join(config.DATA_DIR, `canvas_${id}.json`);
}

function safeFilename(input) {
  return String(input || 'canvas')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'canvas';
}

function loadSettings() {
  try {
    if (!fs.existsSync(config.SETTINGS_FILE)) return {};
    return JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function getCanvasAutoSaveDir() {
  const settings = loadSettings();
  const base = String(settings.canvasAutoSavePath || config.DEFAULT_CANVAS_AUTO_SAVE_DIR || '').trim();
  if (!base) return '';
  return path.join(base, 'T8-penguin-canvas', 'canvases');
}

function atomicWriteJson(file, data) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
    throw error;
  }
}

function parseNodeSerialId(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '').trim();
  if (!/^\d+$/.test(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function deriveNextNodeSerialId(nodes, incomingNext) {
  const requested = parseNodeSerialId(incomingNext);
  let maxSerial = 0;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    maxSerial = Math.max(maxSerial, parseNodeSerialId(node?.data?.nodeSerialId));
  }
  return Math.max(1, requested || 1, maxSerial + 1);
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeCreativeDeskText(value, maxLength = 160) {
  if (value == null) return undefined;
  const text = String(value).replace(/\0/g, '').trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function sanitizeCreativeDeskUrl(value) {
  const url = sanitizeCreativeDeskText(value, 2048);
  if (!url) return '';
  if (/^data:/i.test(url)) return '';
  return url;
}

function sanitizeCreativeDeskState(value) {
  const items = Array.isArray(value?.items) ? value.items : [];
  const sanitizedItems = [];
  for (const item of items.slice(0, 48)) {
    const url = sanitizeCreativeDeskUrl(item?.url);
    if (!url) continue;
    const id = sanitizeCreativeDeskText(item?.id, 80) || `desk-${sanitizedItems.length + 1}`;
    sanitizedItems.push({
      id,
      kind: 'image',
      url,
      title: sanitizeCreativeDeskText(item?.title, 120),
      resourceId: sanitizeCreativeDeskText(item?.resourceId, 120),
      x: clampNumber(item?.x, 0, -200000, 200000),
      y: clampNumber(item?.y, 0, -200000, 200000),
      width: clampNumber(item?.width, 320, 24, 8000),
      height: clampNumber(item?.height, 220, 24, 8000),
      scale: clampNumber(item?.scale, 1, 0.05, 12),
      rotation: clampNumber(item?.rotation, 0, -720, 720),
      opacity: clampNumber(item?.opacity, 0.42, 0, 1),
      frameId: sanitizeCreativeDeskText(item?.frameId, 40) || 'poster-card',
      frameColorId: sanitizeCreativeDeskText(item?.frameColorId, 40) || 'cream',
      zIndex: Math.round(clampNumber(item?.zIndex, sanitizedItems.length + 1, 0, 9999)),
      locked: item?.locked === true,
      visible: item?.visible !== false,
      createdAt: Math.round(clampNumber(item?.createdAt, Date.now(), 1, 9999999999999)),
    });
  }
  const state = {
    version: 1,
    defaultOpacity: clampNumber(value?.defaultOpacity, 0.42, 0, 1),
    items: sanitizedItems,
  };
  if (value?.coordinateMode === 'viewport' || value?.coordinateMode === 'flow') {
    state.coordinateMode = value.coordinateMode;
  }
  return state;
}

const FARM_GRID_SIZE = 64;
const MAX_FARM_OBJECTS = 1500;
const MAX_FARM_ORDERS = 12;
const MAX_FARM_EVENT_LOG = 50;
const MAX_FARM_FESTIVAL_TASKS = 12;
const MAX_FARM_NPC_VISITS = 16;
const MAX_FARM_RARE_EVENTS = 24;
const MAX_FARM_ANIMALS = 24;
const FARM_SEASON_DAYS = 28;
const FARM_SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const FARM_CROP_IDS = ['turnip', 'potato', 'tomato', 'sunflower'];
const FARM_ANIMAL_KINDS = ['chicken', 'cow', 'sheep'];
const FARM_ANIMAL_PRODUCT_IDS = ['egg', 'milk', 'wool'];
const FARM_ANIMAL_MOODS = ['happy', 'calm', 'hungry'];
const FARM_NPC_VISITOR_IDS = ['mira', 'taro', 'lina'];
const FARM_NPC_REQUEST_KINDS = ['crop', 'animal-product'];
const FARM_RARE_EVENT_IDS = ['giant-turnip', 'rainbow-sunflower', 'meteor-seed'];
const FARM_OBJECT_KINDS = ['plot', 'building', 'decor', 'path', 'obstacle'];
const FARM_CROP_STAGES = ['seed', 'sprout', 'growing', 'flowering', 'mature', 'withered'];
const FARM_WEATHERS = ['sunny', 'cloudy', 'rainy', 'festival'];
const FARM_EVENT_KINDS = [
  'plot_tilled',
  'crop_planted',
  'crop_watered',
  'crop_harvested',
  'order_completed',
  'npc_request_completed',
  'rare_event',
  'building_placed',
  'decor_placed',
  'day_advanced',
  'tool_feedback',
];
const FARM_DECOR_IDS = [
  'wood-fence',
  'stone-path',
  'flower-bed',
  'lantern',
  'sign',
  'crate',
  'hay-bale',
  'resource-sign',
  'resource-banner',
  'resource-poster-wall',
  'resource-tile',
];
const DEFAULT_FARM_ORDERS = [
  {
    id: 'tutorial-turnip-order',
    title: '新手萝卜订单',
    requirements: [{ kind: 'crop', cropId: 'turnip', amount: 3 }],
    rewards: { gold: 120, wood: 4, experience: 30, seeds: {}, decorIds: ['wood-fence'] },
    completed: false,
  },
  {
    id: 'potato-lunch-order',
    title: '午餐土豆订单',
    requirements: [{ kind: 'crop', cropId: 'potato', amount: 2 }],
    rewards: { gold: 150, stone: 3, experience: 36, seeds: {}, decorIds: [] },
    completed: false,
  },
  {
    id: 'sunflower-fair-order',
    title: '集市向日葵订单',
    requirements: [{ kind: 'crop', cropId: 'sunflower', amount: 2 }],
    rewards: { gold: 180, experience: 44, seeds: { tomato: 4 }, decorIds: [] },
    completed: false,
  },
];
const DEFAULT_FARM_ANIMALS = [
  {
    id: 'starter-chicken',
    kind: 'chicken',
    name: '啾啾',
    mood: 'calm',
    placedDay: 1,
    productCount: 0,
  },
];
const FARM_NPC_VISITOR_DEFINITIONS = {
  mira: {
    id: 'mira',
    name: '米拉',
    role: '种子店',
    greeting: '今天的集市缺一点新鲜蔬菜，可以帮我留一份吗？',
  },
  taro: {
    id: 'taro',
    name: '太郎',
    role: '木匠',
    greeting: '工坊早餐想加个鸡蛋，换你一些材料。',
  },
  lina: {
    id: 'lina',
    name: '莉娜',
    role: '花店',
    greeting: '花店想做一份暖汤，土豆正合适。',
  },
};
const FARM_RARE_EVENT_DEFINITIONS = {
  'giant-turnip': {
    id: 'giant-turnip',
    title: '巨大萝卜',
    message: '萝卜从土里拔出来时比木桶还大，村里都来围观。',
    rewards: { gold: 66, experience: 18, seeds: { turnip: 2 } },
  },
  'rainbow-sunflower': {
    id: 'rainbow-sunflower',
    title: '彩虹向日葵',
    message: '向日葵盘里闪出彩虹光，留下了稀有种子。',
    rewards: { gold: 88, experience: 24, seeds: { sunflower: 1 } },
  },
  'meteor-seed': {
    id: 'meteor-seed',
    title: '流星夜来信',
    message: '夜里掉下一封星光来信，夹着一粒番茄种子。',
    rewards: { experience: 20, seeds: { tomato: 1 } },
  },
};

function farmSeasonForDay(dayInput) {
  const day = Math.round(clampNumber(dayInput, 1, 1, 999999));
  const index = Math.floor((day - 1) / FARM_SEASON_DAYS) % FARM_SEASONS.length;
  return FARM_SEASONS[index] || 'spring';
}

function farmWeatherForDay(dayInput, season = 'spring') {
  const day = Math.round(clampNumber(dayInput, 1, 1, 999999));
  if (day % 7 === 0) return 'festival';
  if (day % 5 === 0) return 'rainy';
  if (day % 3 === 0) return 'cloudy';
  return season === 'winter' && day % 4 === 0 ? 'cloudy' : 'sunny';
}

function farmFestivalIdForDay(dayInput, season = 'spring') {
  const day = Math.round(clampNumber(dayInput, 1, 1, 999999));
  if (farmWeatherForDay(day, season) !== 'festival') return undefined;
  if (season === 'summer') return `summer-market-${day}`;
  if (season === 'autumn') return `harvest-fair-${day}`;
  if (season === 'winter') return `winter-lights-${day}`;
  return `spring-sowing-${day}`;
}

function farmSeasonFestivalLabel(season) {
  if (season === 'summer') return '夏日集市';
  if (season === 'autumn') return '丰收祭';
  if (season === 'winter') return '冬灯会';
  return '春播祭';
}

function createFarmFestivalTask(festivalId, day, season) {
  const label = farmSeasonFestivalLabel(season);
  const rewards = season === 'summer'
    ? { experience: 24, stone: 2, seeds: { tomato: 3 }, decorIds: [] }
    : season === 'autumn'
      ? { experience: 26, wood: 4, seeds: { potato: 2 }, decorIds: [] }
      : season === 'winter'
        ? { experience: 22, stone: 3, seeds: { turnip: 4 }, decorIds: [] }
        : { experience: 24, wood: 3, seeds: { sunflower: 2 }, decorIds: [] };
  return {
    id: `festival-task-${festivalId}`,
    festivalId,
    title: `${label}委托`,
    description: `D${day} 完成 1 个公告板订单，村里会送来额外谢礼。`,
    kind: 'complete-orders',
    target: 1,
    progress: 0,
    rewards,
    completed: false,
  };
}

function createFarmNpcVisitForDay(dayInput, season = 'spring') {
  const day = Math.round(clampNumber(dayInput, 1, 1, 999999));
  const slot = day % 3;
  const visitorId = slot === 0 ? 'taro' : slot === 1 ? 'mira' : 'lina';
  const visitor = FARM_NPC_VISITOR_DEFINITIONS[visitorId];
  if (visitorId === 'taro') {
    return {
      id: `npc-visit-${day}-${visitorId}`,
      visitorId,
      visitorName: visitor.name,
      day,
      title: `${visitor.role}来访：工坊早餐`,
      message: visitor.greeting,
      requestKind: 'animal-product',
      animalProductId: 'egg',
      amount: 1,
      rewards: { gold: 48, wood: 2, experience: 10 },
      completed: false,
    };
  }
  if (visitorId === 'lina') {
    return {
      id: `npc-visit-${day}-${visitorId}`,
      visitorId,
      visitorName: visitor.name,
      day,
      title: `${visitor.role}来访：暖汤材料`,
      message: visitor.greeting,
      requestKind: 'crop',
      cropId: 'potato',
      amount: 1,
      rewards: {
        gold: 54,
        experience: 12,
        ...(season === 'autumn' ? { seeds: { sunflower: 1 } } : {}),
      },
      completed: false,
    };
  }
  return {
    id: `npc-visit-${day}-${visitorId}`,
    visitorId,
    visitorName: visitor.name,
    day,
    title: `${visitor.role}来访：清晨蔬菜`,
    message: visitor.greeting,
    requestKind: 'crop',
    cropId: 'turnip',
    amount: 1,
    rewards: { gold: 36, experience: 8, seeds: { potato: 1 } },
    completed: false,
  };
}

function sanitizeFarmText(value, maxLength = 120) {
  if (value == null) return undefined;
  const text = String(value).replace(/\0/g, '').trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function sanitizeFarmEventMessage(value) {
  const text = sanitizeFarmText(value, 120) || '牧场有新动静';
  return text
    .replace(/https?:\/\/\S+/gi, '[链接已隐藏]')
    .replace(/file:\/\/\S+/gi, '[路径已隐藏]')
    .replace(/[a-zA-Z]:\\[^\s]+/g, '[路径已隐藏]')
    .replace(/data:[^\s]+/gi, '[素材已隐藏]')
    .replace(/prompt\s*[:：][^，。;；]*/gi, '提示词已隐藏')
    .slice(0, 120);
}

function sanitizeFarmId(value, fallback) {
  const text = sanitizeFarmText(value, 96) || fallback;
  return /^[a-zA-Z0-9:_-]+$/.test(text) ? text : fallback;
}

function sanitizeFarmGridSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 16) return FARM_GRID_SIZE;
  return Math.round(Math.min(256, parsed));
}

function snapFarmCoordinate(value, gridSize) {
  const parsed = clampNumber(value, 0, -2000000, 2000000);
  return Math.floor(parsed / gridSize) * gridSize;
}

function sanitizeFarmCropBag(value) {
  const input = value && typeof value === 'object' ? value : {};
  const bag = {};
  for (const cropId of FARM_CROP_IDS) {
    const amount = Math.round(clampNumber(input[cropId], 0, 0, 9999));
    if (amount > 0) bag[cropId] = amount;
  }
  return bag;
}

function sanitizeFarmAnimalProductBag(value) {
  const input = value && typeof value === 'object' ? value : {};
  const bag = {};
  for (const productId of FARM_ANIMAL_PRODUCT_IDS) {
    const amount = Math.round(clampNumber(input[productId], 0, 0, 9999));
    if (amount > 0) bag[productId] = amount;
  }
  return bag;
}

function sanitizeFarmResources(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    gold: Math.round(clampNumber(input.gold, 300, 0, 9999999)),
    wood: Math.round(clampNumber(input.wood, 8, 0, 999999)),
    stone: Math.round(clampNumber(input.stone, 6, 0, 999999)),
    water: Math.round(clampNumber(input.water, 20, 0, 999)),
    experience: Math.round(clampNumber(input.experience, 0, 0, 9999999)),
    seeds: sanitizeFarmCropBag(input.seeds || { turnip: 12 }),
  };
}

function sanitizeFarmInventory(value) {
  const input = value && typeof value === 'object' ? value : {};
  const decorIds = Array.isArray(input.decorIds)
    ? [...new Set(input.decorIds.map((id, index) => sanitizeFarmId(id, `decor-${index}`)))].slice(0, 200)
    : [];
  return {
    crops: sanitizeFarmCropBag(input.crops),
    animalProducts: sanitizeFarmAnimalProductBag(input.animalProducts),
    decorIds,
  };
}

function sanitizeFarmStats(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    plotsTilled: Math.round(clampNumber(input.plotsTilled, 0, 0, 999999)),
    cropsPlanted: Math.round(clampNumber(input.cropsPlanted, 0, 0, 999999)),
    cropsWatered: Math.round(clampNumber(input.cropsWatered, 0, 0, 999999)),
    cropsHarvested: Math.round(clampNumber(input.cropsHarvested, 0, 0, 999999)),
    ordersCompleted: Math.round(clampNumber(input.ordersCompleted, 0, 0, 999999)),
    npcVisitsCompleted: Math.round(clampNumber(input.npcVisitsCompleted, 0, 0, 999999)),
    rareEventsFound: Math.round(clampNumber(input.rareEventsFound, 0, 0, 999999)),
    objectsPlaced: Math.round(clampNumber(input.objectsPlaced, 0, 0, 999999)),
    buildingsPlaced: Math.round(clampNumber(input.buildingsPlaced, 0, 0, 999999)),
    decorPlaced: Math.round(clampNumber(input.decorPlaced, 0, 0, 999999)),
    daysAdvanced: Math.round(clampNumber(input.daysAdvanced, 0, 0, 999999)),
  };
}

function sanitizeFarmAnimals(value, day) {
  const input = Array.isArray(value) ? value : DEFAULT_FARM_ANIMALS;
  return input
    .slice(0, MAX_FARM_ANIMALS)
    .map((animal, index) => {
      const source = animal && typeof animal === 'object' ? animal : {};
      if (!FARM_ANIMAL_KINDS.includes(source.kind)) return null;
      const placedDay = Math.round(clampNumber(source.placedDay, day, 1, day));
      const lastProducedDay = source.lastProducedDay == null
        ? undefined
        : Math.round(clampNumber(source.lastProducedDay, placedDay, 1, day));
      const item = {
        id: sanitizeFarmId(source.id, `farm-animal-${index}`),
        kind: source.kind,
        name: sanitizeFarmEventMessage(source.name || source.kind).slice(0, 16),
        mood: FARM_ANIMAL_MOODS.includes(source.mood) ? source.mood : 'calm',
        placedDay,
        productCount: Math.round(clampNumber(source.productCount, 0, 0, 999999)),
      };
      if (lastProducedDay) item.lastProducedDay = lastProducedDay;
      return item;
    })
    .filter(Boolean);
}

function sanitizeFarmReward(value) {
  const rewards = value && typeof value === 'object' ? value : {};
  return {
    gold: Math.round(clampNumber(rewards.gold, 0, 0, 999999)),
    wood: Math.round(clampNumber(rewards.wood, 0, 0, 999999)),
    stone: Math.round(clampNumber(rewards.stone, 0, 0, 999999)),
    experience: Math.round(clampNumber(rewards.experience, 0, 0, 999999)),
    seeds: sanitizeFarmCropBag(rewards.seeds),
    decorIds: Array.isArray(rewards.decorIds)
      ? rewards.decorIds
        .map((id, rewardIndex) => sanitizeFarmId(id, `decor-reward-${rewardIndex}`))
        .filter((id) => FARM_DECOR_IDS.includes(id))
        .slice(0, 20)
      : [],
  };
}

function sanitizeFarmCrop(value, fallbackDay) {
  const input = value && typeof value === 'object' ? value : {};
  if (!FARM_CROP_IDS.includes(input.cropId)) return undefined;
  const dryDays = Math.round(clampNumber(input.dryDays, 0, 0, 99));
  const stage = dryDays >= 3
    ? 'withered'
    : (FARM_CROP_STAGES.includes(input.stage) ? input.stage : 'seed');
  return {
    cropId: input.cropId,
    plantedDay: Math.round(clampNumber(input.plantedDay, fallbackDay, 1, 999999)),
    daysGrown: Math.round(clampNumber(input.daysGrown, 0, 0, 9999)),
    wateredToday: input.wateredToday === true,
    dryDays,
    stage,
    quality: ['silver', 'gold', 'rainbow'].includes(input.quality) ? input.quality : 'normal',
  };
}

function sanitizeFarmObject(value, index, day, gridSize) {
  const input = value && typeof value === 'object' ? value : {};
  if (!FARM_OBJECT_KINDS.includes(input.kind)) return null;
  const item = {
    id: sanitizeFarmId(input.id, `farm-object-${index}`),
    kind: input.kind,
    x: snapFarmCoordinate(input.x, gridSize),
    y: snapFarmCoordinate(input.y, gridSize),
    widthCells: Math.round(clampNumber(input.widthCells, 1, 1, 32)),
    heightCells: Math.round(clampNumber(input.heightCells, 1, 1, 32)),
    createdDay: Math.round(clampNumber(input.createdDay, day, 1, 999999)),
  };
  if ([90, 180, 270].includes(input.rotation)) item.rotation = input.rotation;
  if (item.kind === 'plot') {
    const crop = sanitizeFarmCrop(input.crop, item.createdDay);
    if (crop) item.crop = crop;
  }
  if (item.kind === 'building') item.buildingId = sanitizeFarmId(input.buildingId, 'hut');
  if (item.kind === 'decor') {
    item.decorId = sanitizeFarmId(input.decorId, 'wood-fence');
    const resourceId = sanitizeFarmText(input.resourceId, 120);
    if (resourceId && !/^data:/i.test(resourceId)) item.resourceId = sanitizeFarmId(resourceId, 'resource');
  }
  const skinId = sanitizeFarmText(input.skinId, 80);
  if (skinId) item.skinId = sanitizeFarmId(skinId, 'default');
  return item;
}

function sanitizeFarmOrders(value) {
  const input = Array.isArray(value) ? value : [];
  const orders = [];
  for (let index = 0; index < input.length && orders.length < MAX_FARM_ORDERS; index += 1) {
    const order = input[index];
    if (!order || typeof order !== 'object') continue;
    const requirements = Array.isArray(order.requirements)
      ? order.requirements
        .map((requirement) => {
          if (requirement?.kind !== 'crop' || !FARM_CROP_IDS.includes(requirement.cropId)) return null;
          return {
            kind: 'crop',
            cropId: requirement.cropId,
            amount: Math.round(clampNumber(requirement.amount, 1, 1, 999)),
          };
        })
        .filter(Boolean)
      : [];
    if (requirements.length === 0) continue;
    orders.push({
      id: sanitizeFarmId(order.id, `farm-order-${index}`),
      title: sanitizeFarmText(order.title, 80) || `牧场订单 ${index + 1}`,
      requirements,
      rewards: sanitizeFarmReward(order.rewards),
      completed: order.completed === true,
    });
  }
  return orders.length > 0 ? orders : DEFAULT_FARM_ORDERS.map((order) => ({
    ...order,
    requirements: order.requirements.map((requirement) => ({ ...requirement })),
    rewards: {
      ...order.rewards,
      seeds: { ...(order.rewards.seeds || {}) },
      decorIds: [...(order.rewards.decorIds || [])],
    },
  }));
}

function sanitizeFarmFestivalTasks(value, day, season, weather, festivalId) {
  const input = Array.isArray(value) ? value : [];
  const tasks = [];
  for (let index = 0; index < input.length && tasks.length < MAX_FARM_FESTIVAL_TASKS; index += 1) {
    const source = input[index] && typeof input[index] === 'object' ? input[index] : {};
    const cleanFestivalId = sanitizeFarmId(source.festivalId, festivalId || `festival-${day}`);
    const target = Math.round(clampNumber(source.target, 1, 1, 9));
    const progress = Math.round(clampNumber(source.progress, 0, 0, target));
    const completed = source.completed === true || progress >= target;
    tasks.push({
      id: sanitizeFarmId(source.id, `festival-task-${cleanFestivalId}-${index}`),
      festivalId: cleanFestivalId,
      title: sanitizeFarmText(source.title, 80) || `${farmSeasonFestivalLabel(season)}委托`,
      description: sanitizeFarmEventMessage(source.description || `完成 ${target} 个公告板订单，领取节庆谢礼。`),
      kind: 'complete-orders',
      target,
      progress,
      rewards: sanitizeFarmReward(source.rewards),
      completed,
      completedDay: completed ? Math.round(clampNumber(source.completedDay, day, 1, 999999)) : undefined,
    });
  }
  if (weather === 'festival' && festivalId && !tasks.some((task) => task.festivalId === festivalId)) {
    tasks.unshift(createFarmFestivalTask(festivalId, day, season));
  }
  return tasks.slice(0, MAX_FARM_FESTIVAL_TASKS);
}

function sanitizeFarmNpcVisit(value, index, currentDay, season) {
  const source = value && typeof value === 'object' ? value : {};
  const day = Math.round(clampNumber(source.day, currentDay, 1, currentDay));
  const fallback = createFarmNpcVisitForDay(day, season);
  const visitorId = FARM_NPC_VISITOR_IDS.includes(source.visitorId) ? source.visitorId : fallback.visitorId;
  const visitor = FARM_NPC_VISITOR_DEFINITIONS[visitorId];
  const requestKind = FARM_NPC_REQUEST_KINDS.includes(source.requestKind) ? source.requestKind : fallback.requestKind;
  const cropId = FARM_CROP_IDS.includes(source.cropId) ? source.cropId : fallback.cropId;
  const animalProductId = FARM_ANIMAL_PRODUCT_IDS.includes(source.animalProductId) ? source.animalProductId : fallback.animalProductId;
  if (requestKind === 'crop' && !cropId) return null;
  if (requestKind === 'animal-product' && !animalProductId) return null;
  const amount = Math.round(clampNumber(source.amount, fallback.amount, 1, 99));
  const completed = source.completed === true;
  const item = {
    id: sanitizeFarmId(source.id, `npc-visit-${day}-${visitorId}-${index}`),
    visitorId,
    visitorName: sanitizeFarmEventMessage(source.visitorName || visitor.name).slice(0, 18),
    day,
    title: sanitizeFarmText(source.title, 80) || fallback.title,
    message: sanitizeFarmEventMessage(source.message || fallback.message),
    requestKind,
    amount,
    rewards: sanitizeFarmReward(source.rewards || fallback.rewards),
    completed,
  };
  if (requestKind === 'crop') item.cropId = cropId;
  if (requestKind === 'animal-product') item.animalProductId = animalProductId;
  if (completed) item.completedDay = Math.round(clampNumber(source.completedDay, day, 1, currentDay));
  return item;
}

function sanitizeFarmNpcVisits(value, day, season) {
  const input = Array.isArray(value) ? value : [];
  const visits = input
    .slice(0, MAX_FARM_NPC_VISITS)
    .map((visit, index) => sanitizeFarmNpcVisit(visit, index, day, season))
    .filter(Boolean);
  if (!visits.some((visit) => visit.day === day)) {
    visits.unshift(createFarmNpcVisitForDay(day, season));
  }
  return visits
    .sort((a, b) => b.day - a.day || String(a.id).localeCompare(String(b.id)))
    .slice(0, MAX_FARM_NPC_VISITS);
}

function sanitizeFarmRareEvent(value, index, currentDay) {
  const source = value && typeof value === 'object' ? value : {};
  if (!FARM_RARE_EVENT_IDS.includes(source.eventId)) return null;
  const definition = FARM_RARE_EVENT_DEFINITIONS[source.eventId];
  const day = Math.round(clampNumber(source.day, currentDay, 1, currentDay));
  const item = {
    id: sanitizeFarmId(source.id, `rare-event-${day}-${source.eventId}-${index}`),
    eventId: source.eventId,
    title: sanitizeFarmText(source.title, 80) || definition.title,
    message: sanitizeFarmEventMessage(source.message || definition.message),
    day,
    rewards: sanitizeFarmReward(source.rewards || definition.rewards),
  };
  if (FARM_CROP_IDS.includes(source.cropId)) item.cropId = source.cropId;
  return item;
}

function sanitizeFarmRareEvents(value, day) {
  const input = Array.isArray(value) ? value : [];
  return input
    .slice(0, MAX_FARM_RARE_EVENTS)
    .map((event, index) => sanitizeFarmRareEvent(event, index, day))
    .filter(Boolean)
    .sort((a, b) => b.day - a.day || String(a.id).localeCompare(String(b.id)))
    .slice(0, MAX_FARM_RARE_EVENTS);
}

function sanitizeFarmEventLog(value, fallbackDay) {
  const input = Array.isArray(value) ? value : [];
  return input.slice(0, MAX_FARM_EVENT_LOG).map((event, index) => {
    const source = event && typeof event === 'object' ? event : {};
    const day = Math.round(clampNumber(source.day, fallbackDay, 1, 999999));
    const item = {
      id: sanitizeFarmId(source.id, `farm-event-${day}-${index}`),
      kind: FARM_EVENT_KINDS.includes(source.kind) ? source.kind : 'tool_feedback',
      day,
      message: sanitizeFarmEventMessage(source.message),
      createdAt: Math.round(clampNumber(source.createdAt, day * 100000 + index, 1, 9999999999999)),
    };
    const amount = Math.round(clampNumber(source.amount, 0, -999999, 999999));
    if (amount !== 0) item.amount = amount;
    if (FARM_CROP_IDS.includes(source.cropId)) item.cropId = source.cropId;
    if (FARM_OBJECT_KINDS.includes(source.objectKind)) item.objectKind = source.objectKind;
    if (source.orderId) item.orderId = sanitizeFarmId(source.orderId, 'farm-order');
    if (source.npcVisitId) item.npcVisitId = sanitizeFarmId(source.npcVisitId, 'npc-visit');
    if (source.rareEventId) item.rareEventId = sanitizeFarmId(source.rareEventId, 'rare-event');
    return item;
  });
}

function sanitizeFarmDailySummary(value, fallbackDay) {
  const source = value && typeof value === 'object' ? value : null;
  if (!source) return undefined;
  const toDay = Math.round(clampNumber(source.toDay, fallbackDay, 1, 999999));
  const fromDay = Math.round(clampNumber(source.fromDay, Math.max(1, toDay - 1), 1, 999999));
  const weather = FARM_WEATHERS.includes(source.weather) ? source.weather : farmWeatherForDay(toDay);
  return {
    id: sanitizeFarmId(source.id, `farm-summary-${fromDay}-${toDay}`),
    fromDay,
    toDay,
    weather,
    festivalId: weather === 'festival' ? sanitizeFarmId(source.festivalId, farmFestivalIdForDay(toDay)) : undefined,
    message: sanitizeFarmEventMessage(source.message),
    harvestedCrops: Math.round(clampNumber(source.harvestedCrops, 0, 0, 9999)),
    ordersCompleted: Math.round(clampNumber(source.ordersCompleted, 0, 0, 9999)),
    goldEarned: Math.round(clampNumber(source.goldEarned, 0, 0, 9999999)),
    rainWateredCrops: Math.round(clampNumber(source.rainWateredCrops, 0, 0, 9999)),
    festivalBonusGold: Math.round(clampNumber(source.festivalBonusGold, 0, 0, 9999999)),
    animalProductsProduced: Math.round(clampNumber(source.animalProductsProduced, 0, 0, 9999)),
    animalProductSummary: source.animalProductSummary ? sanitizeFarmEventMessage(source.animalProductSummary) : undefined,
    npcVisitsCompleted: Math.round(clampNumber(source.npcVisitsCompleted, 0, 0, 9999)),
    rareEventsFound: Math.round(clampNumber(source.rareEventsFound, 0, 0, 9999)),
    rareEventSummary: source.rareEventSummary ? sanitizeFarmEventMessage(source.rareEventSummary) : undefined,
    readyOrders: Math.round(clampNumber(source.readyOrders, 0, 0, 9999)),
    readyNpcVisits: Math.round(clampNumber(source.readyNpcVisits, 0, 0, 9999)),
    dailyWaterCapacity: Math.round(clampNumber(source.dailyWaterCapacity, 0, 0, 9999)),
    scarecrowProtectedCrops: Math.round(clampNumber(source.scarecrowProtectedCrops, 0, 0, 9999)),
    wateredCrops: Math.round(clampNumber(source.wateredCrops, 0, 0, 9999)),
    dryCrops: Math.round(clampNumber(source.dryCrops, 0, 0, 9999)),
    witheredCrops: Math.round(clampNumber(source.witheredCrops, 0, 0, 9999)),
    newMatureCrops: Math.round(clampNumber(source.newMatureCrops, 0, 0, 9999)),
    matureCrops: Math.round(clampNumber(source.matureCrops, 0, 0, 9999)),
    nextMatureCrops: Math.round(clampNumber(source.nextMatureCrops, 0, 0, 9999)),
    highlights: Array.isArray(source.highlights)
      ? source.highlights.map((item) => sanitizeFarmEventMessage(item)).filter(Boolean).slice(0, 5)
      : [],
    createdAt: Math.round(clampNumber(source.createdAt, toDay * 100000, 1, 9999999999999)),
  };
}

function sanitizeFarmCanvasState(value) {
  const input = value && typeof value === 'object' ? value : {};
  const day = Math.round(clampNumber(input.day, 1, 1, 999999));
  const gridSize = sanitizeFarmGridSize(input.gridSize);
  const season = FARM_SEASONS.includes(input.season) ? input.season : farmSeasonForDay(day);
  const weather = FARM_WEATHERS.includes(input.weather) ? input.weather : farmWeatherForDay(day, season);
  const festivalId = weather === 'festival' ? sanitizeFarmId(input.festivalId, farmFestivalIdForDay(day, season)) : undefined;
  return {
    version: 1,
    coordinateMode: 'flow',
    gridSize,
    day,
    season,
    weather,
    festivalId,
    resources: sanitizeFarmResources(input.resources),
    inventory: sanitizeFarmInventory(input.inventory),
    objects: Array.isArray(input.objects)
      ? input.objects
        .slice(0, MAX_FARM_OBJECTS)
        .map((item, index) => sanitizeFarmObject(item, index, day, gridSize))
        .filter(Boolean)
      : [],
    animals: sanitizeFarmAnimals(input.animals, day),
    orders: sanitizeFarmOrders(input.orders),
    festivalTasks: sanitizeFarmFestivalTasks(input.festivalTasks, day, season, weather, festivalId),
    npcVisits: sanitizeFarmNpcVisits(input.npcVisits, day, season),
    rareEvents: sanitizeFarmRareEvents(input.rareEvents, day),
    eventLog: sanitizeFarmEventLog(input.eventLog, day),
    lastDailySummary: sanitizeFarmDailySummary(input.lastDailySummary, day),
    discoveredCropIds: Array.isArray(input.discoveredCropIds)
      ? [...new Set(input.discoveredCropIds.filter((id) => FARM_CROP_IDS.includes(id)))].slice(0, 64)
      : [],
    unlockedDecorIds: Array.isArray(input.unlockedDecorIds)
      ? [...new Set(input.unlockedDecorIds.map((id, index) => sanitizeFarmId(id, `decor-${index}`)))].slice(0, 200)
      : [],
    stats: sanitizeFarmStats(input.stats),
    selectedTool: ['select', 'hoe', 'seed', 'water', 'harvest', 'shovel', 'build', 'decor', 'move', 'delete'].includes(input.selectedTool)
      ? input.selectedTool
      : 'select',
  };
}

function createDefaultFarmCanvasState() {
  return sanitizeFarmCanvasState();
}

// GET /api/canvas — 获取画布列表
router.get('/', (_req, res) => {
  const list = loadCanvasList();
  res.json({ success: true, data: list });
});

// POST /api/canvas — 创建画布
router.post('/', (req, res) => {
  const id = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const canvas = {
    id,
    name: req.body?.name || '未命名画布',
    nodeCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  // 初始化空画布数据
  const initialData = {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    nextNodeSerialId: 1,
    farmCanvas: createDefaultFarmCanvasState(),
  };
  let database;
  let document;
  try {
    database = projectDatabase();
    document = database.ensureCanvas(
      id,
      initialData,
      undefined,
      NEW_CANVAS_RESOURCE_OPTIONS,
    );
  } catch (error) {
    return sendCanvasPatchError(res, error, {
      fallbackCode: 'canvas_create_failed',
      fallbackMessage: '画布创建失败',
      defaultStatus: 500,
    });
  }
  const warnings = writeAuthoritativeCanvasCompatibilityMirrors(id, document, database, {
    createListItem: canvas,
  });
  return res.json({
    success: true,
    data: { ...canvas, revision: document.revision },
    ...(warnings.length ? { warnings } : {}),
  });
});

// GET /api/canvas/:id — 获取单个画布数据
router.get('/:id', (req, res) => {
  const file = getCanvasFile(req.params.id);
  try {
    const database = projectDatabase();
    let document = database.getCanvas(req.params.id);
    if (!document) {
      if (!fs.existsSync(file)) return res.status(404).json({ success: false, error: '画布不存在' });
      document = database.ensureCanvas(
        req.params.id,
        readJsonFile(file),
        undefined,
        LEGACY_CANVAS_HYDRATION_OPTIONS,
      );
    } else {
      let mirrorRevision = null;
      try {
        if (fs.existsSync(file)) mirrorRevision = Number(readJsonFile(file)?.revision);
      } catch {
        mirrorRevision = null;
      }
      if (!Number.isSafeInteger(mirrorRevision) || mirrorRevision !== Number(document.revision)) {
        try {
          atomicWriteJson(file, document);
        } catch (_) {
          console.warn('[canvas] legacy mirror repair failed; serving authoritative SQLite document');
          res.set('X-T8-Canvas-Mirror-Warning', 'legacy_canvas_mirror_failed');
        }
      }
    }
    res.set('ETag', `"${document.revision}"`);
    res.json({ success: true, data: document });
  } catch (e) {
    return sendCanvasPatchError(res, e, {
      fallbackCode: 'canvas_read_failed',
      fallbackMessage: '画布读取失败',
      defaultStatus: 500,
    });
  }
});

// PUT /api/canvas/:id — 更新画布数据(防空数据覆盖)
router.put('/:id', (req, res) => {
  const file = getCanvasFile(req.params.id);
  const incoming = req.body;
  const allowEmptyOverwrite = req.query?.allowEmpty === '1' || incoming?.allowEmpty === true;
  let database;
  let authoritativeExisting = null;
  try {
    database = projectDatabase();
    authoritativeExisting = database.getCanvas(req.params.id);
  } catch (error) {
    return sendCanvasPatchError(res, error, {
      fallbackCode: 'canvas_snapshot_save_failed',
      fallbackMessage: '画布快照保存失败',
      defaultStatus: 500,
    });
  }
  // 防空数据覆盖保护
  if (
    !incoming ||
    !Array.isArray(incoming.nodes) ||
    (!allowEmptyOverwrite && incoming.nodes.length === 0 && (authoritativeExisting || fs.existsSync(file)))
  ) {
    let existing = authoritativeExisting;
    if (!existing && fs.existsSync(file)) {
      try {
        existing = readJsonFile(file);
      } catch (error) {
        return sendCanvasPatchError(res, error, {
          fallbackCode: 'canvas_snapshot_save_failed',
          fallbackMessage: '画布快照保存失败',
          defaultStatus: 500,
        });
      }
    }
    if (existing && Array.isArray(existing.nodes) && existing.nodes.length > 0) {
      console.warn(`⚠ 拒绝空数据覆盖画布 ${req.params.id}(原 ${existing.nodes.length} 节点)`);
      return res.status(400).json({ success: false, error: '拒绝空数据覆盖' });
    }
  }
  const persisted = removeCanvasRequestControls({
    ...(incoming && typeof incoming === 'object' ? incoming : {}),
    nodes: Array.isArray(incoming?.nodes) ? incoming.nodes : [],
    edges: Array.isArray(incoming?.edges) ? incoming.edges : [],
    viewport: incoming?.viewport || { x: 0, y: 0, zoom: 1 },
    nextNodeSerialId: deriveNextNodeSerialId(incoming?.nodes, incoming?.nextNodeSerialId),
  });
  if (Object.prototype.hasOwnProperty.call(incoming || {}, 'creativeDesk')) {
    persisted.creativeDesk = sanitizeCreativeDeskState(incoming.creativeDesk);
  }
  if (Object.prototype.hasOwnProperty.call(incoming || {}, 'farmCanvas')) {
    persisted.farmCanvas = sanitizeFarmCanvasState(incoming.farmCanvas);
  }
  let document;
  try {
    if (!authoritativeExisting && fs.existsSync(file)) {
      database.ensureCanvas(
        req.params.id,
        readJsonFile(file),
        undefined,
        LEGACY_CANVAS_HYDRATION_OPTIONS,
      );
    }
    document = database.saveCanvasSnapshot(req.params.id, persisted, {
      expectedRevision: expectedRevisionFromRequest(req),
      actorId: req.body?.actorId,
      sessionId: req.body?.sessionId,
      clientSeq: req.body?.clientSeq,
    });
    persisted.revision = document.revision;
    persisted.schema = document.schema;
    persisted.schemaVersion = document.schemaVersion;
    persisted.projectId = document.projectId;
    persisted.canvasId = document.canvasId;
    persisted.updatedAt = document.updatedAt;
  } catch (e) {
    return sendCanvasPatchError(res, e, {
      fallbackCode: 'canvas_snapshot_save_failed',
      fallbackMessage: '画布快照保存失败',
      defaultStatus: 500,
    });
  }
  const warnings = writeAuthoritativeCanvasCompatibilityMirrors(
    req.params.id,
    document,
    database,
  );
  res.set('ETag', `"${persisted.revision}"`);
  return res.json({
    success: true,
    data: { revision: persisted.revision, updatedAt: persisted.updatedAt },
    ...(warnings.length ? { warnings } : {}),
  });
});

// GET /api/canvas/:id/sync?afterRevision=N — 增量同步；遇到整快照保存时自动返回快照。
router.get('/:id/sync', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const afterRevision = parseCanvasSyncAfterRevision(req.query?.afterRevision);
    if (!afterRevision.valid) {
      return res.status(400).json({
        success: false,
        code: 'canvas_revision_invalid',
        error: 'afterRevision 必须是非负安全整数',
      });
    }
    const requestedGeneration = parseCanvasSyncGeneration(req.query?.generation);
    if (!requestedGeneration.valid) {
      return res.status(400).json({
        success: false,
        code: 'canvas_generation_invalid',
        error: 'generation 必须是 UUID',
      });
    }
    const database = projectDatabase();
    const document = database.getCanvas(req.params.id);
    const file = getCanvasFile(req.params.id);
    if (!document) {
      if (fs.existsSync(file)) {
        return res.status(409).json({
          success: false,
          code: 'canvas_sync_materialization_required',
          error: '旧画布尚未完成 SQLite 物化，请先通过画布保存流程完成迁移后再同步',
        });
      }
      return res.status(404).json({ success: false, error: '画布不存在' });
    }
    const data = database.syncCanvas(
      req.params.id,
      afterRevision.revision,
      500,
      requestedGeneration.generation,
    );
    if (!data) return res.status(404).json({ success: false, error: '画布不存在' });
    res.json({ success: true, data });
  } catch (e) {
    return sendCanvasPatchError(res, e, {
      fallbackCode: 'canvas_sync_failed',
      fallbackMessage: '画布同步失败',
      defaultStatus: 500,
    });
  }
});

// POST /api/canvas/:id/operations — 结构化画布操作，供协作网关和后续本机实时编辑共用。
router.post('/:id/operations', (req, res) => {
  let database;
  let result;
  try {
    const file = getCanvasFile(req.params.id);
    database = projectDatabase();
    if (!database.getCanvas(req.params.id) && fs.existsSync(file)) {
      database.ensureCanvas(
        req.params.id,
        readJsonFile(file),
        undefined,
        LEGACY_CANVAS_HYDRATION_OPTIONS,
      );
    }
    result = database.applyOperations(req.params.id, req.body?.operations, {
      expectedRevision: expectedRevisionFromRequest(req),
    });
  } catch (e) {
    return sendCanvasPatchError(res, e, {
      fallbackCode: 'canvas_operation_invalid',
      fallbackMessage: '画布操作请求无效',
    });
  }
  const warnings = writeAuthoritativeCanvasCompatibilityMirrors(
    req.params.id,
    result.document,
    database,
  );
  res.set('ETag', `"${result.document.revision}"`);
  return res.json({ success: true, data: result, ...(warnings.length ? { warnings } : {}) });
});

// POST /api/canvas/:id/patches/preview — 只预览，不写画布 revision。
router.post('/:id/patches/preview', (req, res) => {
  try {
    const database = projectDatabase();
    const document = ensurePatchCanvas(database, req.params.id);
    if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在' });
    const context = {
      actorId: LOCAL_PATCH_ACTOR_ID,
      sessionId: LOCAL_PATCH_SESSION_ID,
      projectId: document.projectId,
      canvasId: document.canvasId,
    };
    const patch = scopeCanvasPatch(req.body?.patch, context);
    const preview = database.previewCanvasPatch(req.params.id, patch, {
      actorId: context.actorId,
      sessionId: context.sessionId,
      projectId: context.projectId,
      authority: localCanvasPatchAuthority(patch),
    });
    res.json({ success: true, data: preview });
  } catch (error) {
    return sendCanvasPatchError(res, error);
  }
});

// POST /api/canvas/:id/patches — 用户确认后由 SQLite 权威事务应用。
router.post('/:id/patches', (req, res) => {
  try {
    const database = projectDatabase();
    const document = ensurePatchCanvas(database, req.params.id);
    if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在' });
    const context = {
      actorId: LOCAL_PATCH_ACTOR_ID,
      sessionId: LOCAL_PATCH_SESSION_ID,
      projectId: document.projectId,
      canvasId: document.canvasId,
    };
    const patch = scopeCanvasPatch(req.body?.patch, context);
    const result = database.applyCanvasPatch(req.params.id, patch, {
      previewDigest: req.body?.previewDigest,
      confirmed: req.body?.confirmed === true,
      actorId: context.actorId,
      sessionId: context.sessionId,
      projectId: context.projectId,
      authority: localCanvasPatchAuthority(patch),
      allowExactDuplicateAcrossActors: true,
    });
    return sendAuthoritativePatchResult(res, req.params.id, result, database);
  } catch (error) {
    return sendCanvasPatchError(res, error);
  }
});

// GET /api/canvas/:id/patches — 当前本机用户的持久 Patch/撤销记录。
router.get('/:id/patches', (req, res) => {
  try {
    const database = projectDatabase();
    const document = ensurePatchCanvas(database, req.params.id);
    if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在' });
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query?.limit) || 50)));
    const patches = database.listCanvasPatches(req.params.id, { actorId: LOCAL_PATCH_ACTOR_ID, limit });
    res.json({ success: true, data: patches });
  } catch (error) {
    return sendCanvasPatchError(res, error);
  }
});

// POST /api/canvas/:id/patches/:patchId/revert — 以新的个人逆向 Operation 事务撤销。
router.post('/:id/patches/:patchId/revert', (req, res) => {
  try {
    const database = projectDatabase();
    const document = ensurePatchCanvas(database, req.params.id);
    if (!document) return res.status(404).json({ success: false, code: 'canvas_not_found', error: '画布不存在' });
    const result = database.revertCanvasPatch(req.params.id, req.params.patchId, {
      expectedRevision: req.body?.expectedRevision ?? req.body?.baseRevision,
      actorId: LOCAL_PATCH_ACTOR_ID,
      sessionId: LOCAL_PATCH_SESSION_ID,
      projectId: document.projectId,
      authority: LOCAL_PATCH_AUTHORITY,
    });
    return sendAuthoritativePatchResult(res, req.params.id, result, database);
  } catch (error) {
    return sendCanvasPatchError(res, error);
  }
});

// GET /api/canvas/:id/history — 列出持久化快照；只返回元数据，不回传大快照正文。
router.get('/:id/history', (req, res) => {
  try {
    const file = getCanvasFile(req.params.id);
    if (!projectDatabase().getCanvas(req.params.id) && fs.existsSync(file)) {
      projectDatabase().ensureCanvas(
        req.params.id,
        readJsonFile(file),
        undefined,
        LEGACY_CANVAS_HYDRATION_OPTIONS,
      );
    }
    if (!projectDatabase().getCanvas(req.params.id)) return res.status(404).json({ success: false, error: '画布不存在' });
    res.json({ success: true, data: projectDatabase().listCanvasSnapshots(req.params.id, req.query?.limit) });
  } catch (e) {
    return sendCanvasPatchError(res, e, {
      fallbackCode: 'canvas_history_list_failed',
      fallbackMessage: '画布历史读取失败',
      defaultStatus: 500,
    });
  }
});

// POST /api/canvas/:id/history/:revision/restore — 恢复为新 revision，保留全部旧历史。
router.post('/:id/history/:revision/restore', (req, res) => {
  let database;
  let document;
  try {
    const file = getCanvasFile(req.params.id);
    database = projectDatabase();
    if (!database.getCanvas(req.params.id) && fs.existsSync(file)) {
      database.ensureCanvas(
        req.params.id,
        readJsonFile(file),
        undefined,
        LEGACY_CANVAS_HYDRATION_OPTIONS,
      );
    }
    document = database.restoreCanvasSnapshot(req.params.id, req.params.revision, {
      expectedRevision: expectedRevisionFromRequest(req),
      actorId: req.body?.actorId,
      sessionId: req.body?.sessionId,
      authority: LOCAL_PATCH_AUTHORITY,
    });
  } catch (e) {
    return sendCanvasPatchError(res, e, {
      fallbackCode: 'snapshot_restore_invalid',
      fallbackMessage: '历史快照恢复请求无效',
    });
  }
  const warnings = writeAuthoritativeCanvasCompatibilityMirrors(
    req.params.id,
    document,
    database,
  );
  res.set('ETag', `"${document.revision}"`);
  return res.json({ success: true, data: document, ...(warnings.length ? { warnings } : {}) });
});

// POST /api/canvas/:id/auto-save — 将当前画布镜像保存到用户配置的本地目录
// 用于跨版本迁移: 用户可在「API 设置 → 画布自动保存路径」配置基础路径。
// 实际保存位置: <path>/T8-penguin-canvas/canvases/<画布名>-<id>.json
router.post('/:id/auto-save', (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || !Array.isArray(incoming.nodes) || !Array.isArray(incoming.edges)) {
      return res.status(400).json({ success: false, error: '画布数据格式错误' });
    }
    const saveDir = getCanvasAutoSaveDir();
    if (!saveDir) {
      return res.status(400).json({ success: false, error: '未配置 canvasAutoSavePath' });
    }

    const database = projectDatabase();
    const authoritative = ensurePatchCanvas(database, req.params.id);
    if (!authoritative) {
      return res.status(404).json({
        success: false,
        code: 'canvas_auto_save_not_found',
        error: '画布不存在',
      });
    }
    const currentRevision = Number(authoritative.revision);
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 1) {
      console.warn('[canvas-auto-save] authoritative canvas has an invalid revision');
      return res.status(500).json({
        success: false,
        code: 'canvas_auto_save_failed',
        error: '画布自动保存失败',
      });
    }
    const hasIncomingRevision = Object.prototype.hasOwnProperty.call(incoming, 'revision');
    const incomingRevision = hasIncomingRevision ? Number(incoming.revision) : null;
    if (hasIncomingRevision && (!Number.isSafeInteger(incomingRevision) || incomingRevision < 1)) {
      return res.status(400).json({
        success: false,
        code: 'canvas_auto_save_revision_invalid',
        error: '画布修订号无效',
        currentRevision,
      });
    }
    if (incomingRevision != null && incomingRevision > currentRevision) {
      return res.status(409).json({
        success: false,
        code: 'canvas_auto_save_revision_conflict',
        error: '自动保存请求不是当前权威画布修订',
        currentRevision,
      });
    }

    const list = loadCanvasList();
    const item = list.find((x) => x.id === req.params.id);
    const name = item?.name || req.params.id;
    const shortId = String(req.params.id).replace(/^canvas-/, '').slice(0, 24);
    const filename = `${safeFilename(name)}-${safeFilename(shortId)}.json`;
    const target = path.join(saveDir, filename);
    const now = Date.now();
    let existing = null;
    try {
      if (fs.existsSync(target)) existing = readJsonFile(target);
    } catch (_) {
      existing = null;
    }
    const existingRevision = Number(existing?.revision);
    if (Number.isSafeInteger(existingRevision) && existingRevision > currentRevision) {
      return res.status(409).json({
        success: false,
        code: 'canvas_auto_save_mirror_ahead',
        error: '自动保存镜像修订高于当前权威画布，已拒绝覆盖',
        currentRevision,
      });
    }
    const autoSavedAt = existingRevision === currentRevision && typeof existing?.autoSavedAt === 'string'
      ? existing.autoSavedAt
      : new Date(now).toISOString();
    const payload = removeCanvasRequestControls({
      ...authoritative,
      schema: 't8-penguin-canvas-autosave',
      version: 1,
      autoSavedAt,
      revision: currentRevision,
      canvas: {
        id: req.params.id,
        name,
        nodeCount: authoritative.nodes.length,
        edgeCount: authoritative.edges.length,
        createdAt: item?.createdAt ?? authoritative.createdAt ?? null,
        updatedAt: authoritative.updatedAt ?? item?.updatedAt ?? now,
      },
      nodes: authoritative.nodes,
      edges: authoritative.edges,
      viewport: authoritative.viewport || { x: 0, y: 0, zoom: 1 },
      nextNodeSerialId: deriveNextNodeSerialId(authoritative.nodes, authoritative.nextNodeSerialId),
    });
    if (Object.prototype.hasOwnProperty.call(authoritative, 'creativeDesk')) {
      payload.creativeDesk = sanitizeCreativeDeskState(authoritative.creativeDesk);
    }
    if (Object.prototype.hasOwnProperty.call(authoritative, 'farmCanvas')) {
      payload.farmCanvas = sanitizeFarmCanvasState(authoritative.farmCanvas);
    }

    const idempotent = existingRevision === currentRevision
      && JSON.stringify(existing) === JSON.stringify(payload);
    if (!idempotent) atomicWriteJson(target, payload);
    res.json({
      success: true,
      data: {
        path: target,
        nodeCount: authoritative.nodes.length,
        edgeCount: authoritative.edges.length,
        revision: currentRevision,
        idempotent,
        staleIgnored: incomingRevision != null && incomingRevision < currentRevision,
      },
    });
  } catch (error) {
    console.warn('[canvas-auto-save] authoritative mirror write failed');
    return sendCanvasPatchError(res, error, {
      fallbackCode: 'canvas_auto_save_failed',
      fallbackMessage: '画布自动保存失败',
      defaultStatus: 500,
    });
  }
});

// DELETE /api/canvas/:id
router.delete('/:id', (req, res) => {
  try {
    projectDatabase().deleteCanvas(req.params.id);
  } catch (error) {
    return sendCanvasPatchError(res, error, {
      fallbackCode: 'canvas_delete_failed',
      fallbackMessage: '画布删除失败',
      defaultStatus: 500,
    });
  }
  const warnings = removeCanvasCompatibilityMirrors(req.params.id);
  return res.json({ success: true, ...(warnings.length ? { warnings } : {}) });
});

// PATCH /api/canvas/:id/name — 重命名
router.patch('/:id/name', (req, res) => {
  const list = loadCanvasList();
  const item = list.find((x) => x.id === req.params.id);
  if (!item) return res.status(404).json({ success: false, error: '画布不存在' });
  item.name = req.body?.name || item.name;
  item.updatedAt = Date.now();
  saveCanvasList(list);
  res.json({ success: true, data: item });
});

module.exports = router;
router.writeAuthoritativeCanvasCompatibilityMirrors = writeAuthoritativeCanvasCompatibilityMirrors;
router.PATCH_MIRROR_WARNING_MESSAGES = PATCH_MIRROR_WARNING_MESSAGES;
