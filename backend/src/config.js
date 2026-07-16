const path = require('path');
const fs = require('fs');
const os = require('os');

// T8-penguin-canvas 后端配置
// 运行模式:
//   - 开发: backend/src/config.js 底下的 PROJECT_DIR 即项目根
//   - 打包: 主进程 electron/main.cjs 会注入 T8PC_PACKAGED=1 与 T8PC_USER_DATA=<userData>
//             数据/输入/输出/缩略图都位于该 userData 下,近可读写;
//             前端静态产物位于 T8PC_FRONTEND_DIST(默认 resources/frontend)。
const IS_PACKAGED = process.env.T8PC_PACKAGED === '1';
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
function resolveAppVersion() {
  const injected = String(process.env.T8PC_APP_VERSION || '').trim();
  if (injected) return injected;
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8')).version || '').trim() || '0.0.0-dev';
  } catch (_) {
    return '0.0.0-dev';
  }
}
const APP_VERSION = resolveAppVersion();
const USER_DATA = process.env.T8PC_USER_DATA && process.env.T8PC_USER_DATA.trim().length > 0
  ? process.env.T8PC_USER_DATA
  : PROJECT_DIR;
const DATA_ROOT = IS_PACKAGED ? USER_DATA : PROJECT_DIR;
const USER_HOME_DIR = os.homedir() || process.env.USERPROFILE || process.env.HOME || PROJECT_DIR;
const LEGACY_WINDOWS_DEFAULT_ROOT = 'D:\\zhenzhen';
const DEFAULT_ZHENZHEN_ROOT = process.platform === 'win32'
  ? LEGACY_WINDOWS_DEFAULT_ROOT
  : path.join(USER_HOME_DIR, 'zhenzhen');
const DEFAULT_RESOURCE_LIBRARY_DIR = path.join(DEFAULT_ZHENZHEN_ROOT, 'resources');
const DEFAULT_THEME_TEMPLATE_DIR = path.join(DEFAULT_ZHENZHEN_ROOT, 'theme-templates');

const config = {
  // 服务器
  HOST: process.env.HOST || '127.0.0.1',
  PORT: process.env.PORT || 18766, // 注意:与主项目 18765 错开
  APP_VERSION,
  NODE_ENV: process.env.NODE_ENV || (IS_PACKAGED ? 'production' : 'development'),
  IS_PACKAGED,

  // 数据 / 资源目录
  // 开发模式: 项目根下 data/input/output/thumbnails
  // 打包模式: %APPDATA%/T8-PenguinCanvas/data ...走 userData
  BASE_DIR: DATA_ROOT,
  DATA_DIR: path.join(DATA_ROOT, 'data'),
  INPUT_DIR: path.join(DATA_ROOT, 'input'),
  OUTPUT_DIR: path.join(DATA_ROOT, 'output'),
  THUMBNAILS_DIR: path.join(DATA_ROOT, 'thumbnails'),
  ASSET_PREVIEWS_DIR: path.join(DATA_ROOT, 'thumbnails', 'asset-previews'),
  ASSET_BLOB_DIR: path.join(DATA_ROOT, 'data', 'asset-blobs'),
  COLLAB_UPLOAD_TEMP_DIR: path.join(DATA_ROOT, 'data', 'collaboration-uploads'),
  ASSET_SEMANTIC_MODELS_DIR: path.join(DATA_ROOT, 'semantic-models'),
  ASSET_SEMANTIC_WORK_DIR: path.join(DATA_ROOT, 'data', 'asset-semantic'),
  ASSET_SEMANTIC_SNAPSHOTS_DIR: path.join(DATA_ROOT, 'data', 'asset-semantic', 'snapshots'),
  ASSET_SEMANTIC_CONCURRENCY: Math.max(1, Math.min(1, Number(process.env.T8_ASSET_SEMANTIC_CONCURRENCY) || 1)),
  ASSET_SEMANTIC_MAX_ATTEMPTS: Math.max(1, Math.min(3, Number(process.env.T8_ASSET_SEMANTIC_MAX_ATTEMPTS) || 3)),
  ASSET_SEMANTIC_RETRY_BASE_MS: Math.max(100, Math.min(60_000, Number(process.env.T8_ASSET_SEMANTIC_RETRY_BASE_MS) || 1_500)),
  ASSET_SEMANTIC_JOB_TIMEOUT_MS: Math.max(30_000, Math.min(30 * 60_000, Number(process.env.T8_ASSET_SEMANTIC_JOB_TIMEOUT_MS) || 10 * 60_000)),
  ASSET_SEMANTIC_PIPELINE_VERSION: 'asset-semantic-v1',
  PROJECT_DB_FILE: path.join(DATA_ROOT, 'data', 't8-projects.sqlite3'),
  PROJECT_DB_BACKUP_FILE: path.join(DATA_ROOT, 'data', 't8-projects.sqlite3.backup'),
  COLLAB_HOST: process.env.T8_COLLAB_HOST || '127.0.0.1',
  COLLAB_PORT: Number(process.env.T8_COLLAB_PORT || 18767),
  COLLAB_ALLOWED_ORIGINS: String(process.env.T8_COLLAB_ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
  COLLAB_PROJECT_QUOTA_BYTES: Math.max(1, Number(process.env.T8_COLLAB_PROJECT_QUOTA_BYTES) || 20 * 1024 * 1024 * 1024),
  COLLAB_MEMBER_QUOTA_BYTES: Math.max(1, Number(process.env.T8_COLLAB_MEMBER_QUOTA_BYTES) || 5 * 1024 * 1024 * 1024),
  COLLAB_UPLOAD_CHUNK_BYTES: Math.max(1024 * 1024, Math.min(16 * 1024 * 1024, Number(process.env.T8_COLLAB_UPLOAD_CHUNK_BYTES) || 8 * 1024 * 1024)),
  COLLAB_MAX_UPLOAD_BYTES: Math.max(1024 * 1024, Math.min(4 * 1024 * 1024 * 1024, Number(process.env.T8_COLLAB_MAX_UPLOAD_BYTES) || 512 * 1024 * 1024)),
  COLLAB_UPLOAD_SESSION_TTL_MS: Math.max(5 * 60 * 1000, Math.min(7 * 24 * 60 * 60 * 1000, Number(process.env.T8_COLLAB_UPLOAD_SESSION_TTL_MS) || 24 * 60 * 60 * 1000)),

  // 数据文件
  CANVAS_FILE: path.join(DATA_ROOT, 'data', 'canvas_list.json'),
  SETTINGS_FILE: path.join(DATA_ROOT, 'data', 'settings.json'),
  FEISHU_BITABLE_PRIVATE_FILE: path.join(DATA_ROOT, 'data', 'feishu_bitable.private.json'),
  ACHIEVEMENTS_FILE: path.join(DATA_ROOT, 'data', 'achievements.json'),
  RH_APPS_FILE: path.join(DATA_ROOT, 'data', 'rh_apps.json'),
  // v1.2.10+ RH 工具节点专用数据（与 rh_apps.json 完全分开）
  RH_TOOL_CATEGORIES_FILE: path.join(DATA_ROOT, 'data', 'rh_tool_categories.json'),
  RH_TOOL_APPS_FILE: path.join(DATA_ROOT, 'data', 'rh_tool_apps.json'),
  RH_TOOLBOX_MANIFEST_FILE: path.join(DATA_ROOT, 'data', 'rh_toolbox_manifest.json'),
  // 前端静态产物目录(打包后由 Express 同进程托管)
  FRONTEND_DIST: process.env.T8PC_FRONTEND_DIST || (IS_PACKAGED ? '' : path.join(PROJECT_DIR, 'dist')),
  // 缩略图配置
  THUMBNAIL_SIZE: 160,
  THUMBNAIL_QUALITY: 80,
  ASSET_PREVIEW_CONCURRENCY: Math.max(1, Math.min(4, Number.parseInt(process.env.T8PC_ASSET_PREVIEW_CONCURRENCY || '2', 10) || 2)),
  ASSET_PREVIEW_MAX_ATTEMPTS: Math.max(1, Math.min(3, Number.parseInt(process.env.T8PC_ASSET_PREVIEW_MAX_ATTEMPTS || '3', 10) || 3)),
  ASSET_PREVIEW_RETRY_BASE_MS: Math.max(100, Math.min(60_000, Number.parseInt(process.env.T8PC_ASSET_PREVIEW_RETRY_BASE_MS || '750', 10) || 750)),
  ASSET_PREVIEW_EPHEMERAL_QUEUE_LIMIT: Math.max(1, Math.min(256, Number.parseInt(process.env.T8PC_ASSET_PREVIEW_EPHEMERAL_QUEUE_LIMIT || '64', 10) || 64)),
  ASSET_PREVIEW_TEMP_MAX_AGE_MS: Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, Number.parseInt(process.env.T8PC_ASSET_PREVIEW_TEMP_MAX_AGE_MS || String(6 * 60 * 60 * 1000), 10) || 6 * 60 * 60 * 1000)),
  ASSET_PREVIEW_PIPELINE_VERSION: 'asset-preview-v2-phash',
  ASSET_INDEX_STABILITY_ATTEMPTS: Math.max(1, Math.min(3, Number.parseInt(process.env.T8PC_ASSET_INDEX_STABILITY_ATTEMPTS || '2', 10) || 2)),

  // 业务配置
  // 上传素材节点不设置应用层大小上限；0 表示交给磁盘和系统自身约束。
  MAX_FILE_SIZE: 0,

  // 三套 API Key 默认值(均可在 settings 中覆盖)
  // 贞贞工坊 / LLM 独立 Key 强制走 https://ai.t8star.org
  ZHENZHEN_BASE_URL: 'https://ai.t8star.org',
  // 贞贞 SD2 独立链路，只用于 api.seedance.nz 的 Seedance 2.0 API。
  ZHENZHEN_SD2_BASE_URL: 'https://api.seedance.nz',
  RH_BASE_URL: 'https://www.runninghub.cn',
  RH_INTL_BASE_URL: 'https://www.runninghub.ai',

  // v1.2.10.2: 全局生成素材自动保存到本地的默认路径
  //   用户可在「API 设置 → 文件自动保存路径」覆盖。
  //   不存在时启动会自动创建; 写入失败仅 console.warn, 不阻断业务。
  DEFAULT_LOCAL_SAVE_DIR: DEFAULT_ZHENZHEN_ROOT,
  // v1.3.1: 画布自动保存导出路径默认同本地素材保存路径。
  //   实际文件会写入 <path>/T8-penguin-canvas/canvases/*.json。
  DEFAULT_CANVAS_AUTO_SAVE_DIR: DEFAULT_ZHENZHEN_ROOT,
  // v1.3.4: 资源库默认路径。资源文件与 resource_library.json 元数据均保存在此路径,
  //   用户更换版本后只要设置同一路径即可继续读取资源库。
  DEFAULT_RESOURCE_LIBRARY_DIR,
  // v1.3.6: 主题模板目录。自定义模板 JSON 保存在这里，内置模板仍打包在前端代码里。
  DEFAULT_THEME_TEMPLATE_DIR,
  // 本地 Eagle API 默认地址。仅允许本机地址，避免桌面端变成远端请求代理。
  DEFAULT_EAGLE_API_BASE: 'http://127.0.0.1:41595',
  // 用于旧版本配置迁移：Windows 继续沿用 D:\zhenzhen，非 Windows 遇到旧硬编码默认值时迁移到用户目录。
  LEGACY_WINDOWS_DEFAULT_ROOT,
};

// 提前创建打包后的数据目录(避免首次启动报错)
if (IS_PACKAGED) {
  for (const dir of [config.DATA_DIR, config.INPUT_DIR, config.OUTPUT_DIR, config.THUMBNAILS_DIR, config.ASSET_PREVIEWS_DIR, config.ASSET_BLOB_DIR, config.COLLAB_UPLOAD_TEMP_DIR]) {
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
}

module.exports = config;
