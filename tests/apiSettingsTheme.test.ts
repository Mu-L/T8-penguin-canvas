import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const apiSettingsSource = readFileSync(new URL('../src/components/ApiSettings.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8');
const defaultTemplatesSource = readFileSync(new URL('../src/theme/defaultTemplates.ts', import.meta.url), 'utf8');
const themeStoreSource = readFileSync(new URL('../src/stores/theme.ts', import.meta.url), 'utf8');
const themeTemplateManagerSource = readFileSync(new URL('../src/components/ThemeTemplateManager.tsx', import.meta.url), 'utf8');
const featuresSource = readFileSync(new URL('../features.json', import.meta.url), 'utf8');

test('ApiSettings uses semantic theme classes for cross-theme readability', () => {
  const requiredClasses = [
    't8-api-settings-modal',
    't8-api-settings-body',
    't8-api-settings-toggle',
    't8-api-settings-badge',
    't8-api-settings-provider-card',
    't8-api-settings-provider-panel',
    't8-api-settings-section',
    't8-api-settings-guide',
    't8-api-settings-input',
  ];

  for (const className of requiredClasses) {
    assert.match(apiSettingsSource, new RegExp(className), `${className} should be used by ApiSettings`);
    assert.match(indexCss, new RegExp(`\\.${className}\\b`), `${className} should be defined in index.css after Tailwind utilities`);
  }
});

test('ApiSettings theme CSS is backed by T8 tokens instead of hard-coded white panels', () => {
  const cssBlock = indexCss.slice(indexCss.indexOf('/* API settings semantic theme adapter */'));
  assert.ok(cssBlock.length > 0, 'API settings semantic theme adapter should exist');
  assert.match(cssBlock, /--t8-bg-panel/);
  assert.match(cssBlock, /--t8-text-main/);
  assert.match(cssBlock, /--t8-text-muted/);
  assert.match(cssBlock, /--t8-border/);
  assert.match(cssBlock, /--t8-accent/);
});

test('ApiSettings advanced provider fields stay mounted while typing and ModelScope exposes token links', () => {
  assert.doesNotMatch(
    apiSettingsSource,
    /const\s+FormBlock\s*=/,
    'advanced provider sections must not define a React component inside renderAdvancedProviderForm',
  );
  assert.match(apiSettingsSource, /function\s+AdvancedProviderFormBlock/);
  assert.match(apiSettingsSource, /https:\/\/www\.modelscope\.cn\/my\/access\/token/);
  assert.match(apiSettingsSource, /https:\/\/www\.modelscope\.ai\/my\/access\/token/);
  assert.match(apiSettingsSource, /获取 Token · 国内/);
  assert.match(apiSettingsSource, /获取 Token · 国外/);
  assert.match(apiSettingsSource, /ModelScope LoRA/);
  assert.match(apiSettingsSource, /中文模型库/);
  assert.match(apiSettingsSource, /https:\/\/www\.modelscope\.cn\/aigc\/models/);
});

test('ApiSettings Jimeng CLI panel explains install, login, and executable path', () => {
  assert.match(apiSettingsSource, /如何安装即梦 CLI/);
  assert.match(apiSettingsSource, /curl -s https:\/\/jimeng\.jianying\.com\/cli \| bash/);
  assert.match(apiSettingsSource, /dreamina login/);
  assert.match(apiSettingsSource, /C:\\Users\\&lt;用户名&gt;\\bin\\dreamina\.exe/);
  assert.match(apiSettingsSource, /测试连接/);
});

test('ApiSettings ComfyUI panel supports workflow JSON upload and auto-mapping exclude rules', () => {
  assert.match(apiSettingsSource, /handleComfyWorkflowFile/);
  assert.match(apiSettingsSource, /上传 JSON/);
  assert.match(apiSettingsSource, /applyComfySampleWorkflow/);
  assert.match(apiSettingsSource, /载入样例/);
  assert.match(apiSettingsSource, /buildComfyWorkflowImportChecklist/);
  assert.match(apiSettingsSource, /自动映射排除规则（可选）/);
  assert.match(apiSettingsSource, /filterComfyFieldsByExcludeRules/);
  assert.match(apiSettingsSource, /parseComfyFieldExcludeRules/);
  assert.match(apiSettingsSource, /comfyExcludeRulesRaw/);
  assert.match(apiSettingsSource, /排除采样器参数/);
});

test('ApiSettings Volcengine panel separates Ark API Key from AK/SK credentials', () => {
  assert.match(apiSettingsSource, /方舟 Ark API Key（生成用，不是 AK\/SK）/);
  assert.match(apiSettingsSource, /请输入方舟 Ark API Key，不要填 Access Key ID \/ Secret/);
  assert.match(apiSettingsSource, /3\. 火山 AK\/SK（可选，素材签名）/);
  assert.match(apiSettingsSource, /Access Key ID（AK，素材签名）/);
  assert.match(apiSettingsSource, /Secret Access Key（SK，素材签名）/);
  assert.match(apiSettingsSource, /目前它只作为素材签名类能力的预留凭证/);
  assert.match(apiSettingsSource, /Seedance2\.0 开通提醒/);
  assert.match(apiSettingsSource, /doubao-seedance-2-0-260128/);
  assert.match(apiSettingsSource, /doubao-seedance-2-0-fast-260128/);
  assert.match(apiSettingsSource, /ModelNotOpen \/ HTTP 404/);
});

test('ApiSettings classified API keys expose explicit clear actions', () => {
  assert.match(apiSettingsSource, /const \[clearedFields, setClearedFields\]/);
  assert.match(apiSettingsSource, /handleClearClassifiedKey/);
  assert.match(apiSettingsSource, /保存后清空/);
  assert.match(apiSettingsSource, /\(patch as any\)\[f\] = ''/);
  assert.match(apiSettingsSource, /清空该分类独立 Key/);
  assert.match(apiSettingsSource, /aria-label=\{`\$\{spec\.label\}\$\{pendingClear \? '取消清空' : '清空'\}`\}/);
});

test('ApiSettings exposes an independent fixed seedance.nz main API key', () => {
  assert.match(apiSettingsSource, /贞贞的平价AI工坊（国内） API Key/);
  assert.match(apiSettingsSource, /贞贞的AI工坊（海外） API Key/);
  assert.match(apiSettingsSource, /FIXED_ZHENZHEN_SD2_BASE/);
  assert.match(apiSettingsSource, /https:\/\/api\.seedance\.nz\/sign-up\?aff=ibVH/);
  assert.match(apiSettingsSource, /zhenzhenSd2ApiKey/);
  assert.match(apiSettingsSource, /clearable: true/);
});

test('ApiSettings cloud upload panels link to vendor consoles and secret key reminders', () => {
  assert.match(apiSettingsSource, /https:\/\/console\.cloud\.tencent\.com\/cam\/capi/);
  assert.match(apiSettingsSource, /https:\/\/console\.cloud\.tencent\.com\/lighthouse\/cos\/index\?rid=5/);
  assert.match(apiSettingsSource, /腾讯云 SecretKey 只会在新建密钥时显示一次/);
  assert.match(apiSettingsSource, /https:\/\/ram\.console\.aliyun\.com\/manage\/ak/);
  assert.match(apiSettingsSource, /https:\/\/oss\.console\.aliyun\.com\/bucket/);
  assert.match(apiSettingsSource, /阿里云 AccessKey Secret 只会在创建时显示一次/);
});

test('ApiSettings exposes custom task completion sound upload without bypassing theme classes', () => {
  assert.match(apiSettingsSource, /任务完成提示音/);
  assert.match(apiSettingsSource, /handleTaskCompletionSoundUpload/);
  assert.match(apiSettingsSource, /uploadTaskCompletionSound/);
  assert.match(apiSettingsSource, /resetTaskCompletionSound/);
  assert.match(apiSettingsSource, /accept="audio\/\*,\.mp3,\.wav,\.ogg,\.m4a,\.aac,\.flac,\.webm"/);
  assert.match(apiSettingsSource, /试听/);
  assert.match(apiSettingsSource, /恢复默认/);
  assert.match(apiSettingsSource, /t8-api-settings-section/);
  assert.match(apiSettingsSource, /t8-api-settings-secondary-btn/);
});

test('UI font preference resolves readable defaults and custom stacks', async () => {
  const fontModule = new URL('../src/utils/uiFont.ts', import.meta.url);

  assert.equal(existsSync(fontModule), true, 'uiFont utility should exist');
  const utils = await import('../src/utils/uiFont.ts');
  assert.equal(utils.DEFAULT_UI_FONT_PRESET, 'readable');
  assert.equal(utils.normalizeUiFontPresetId('missing'), 'readable');
  assert.match(utils.resolveUiFontStack('readable', ''), /Microsoft YaHei UI/);
  assert.match(utils.resolveUiFontStack('system', ''), /system-ui/);
  assert.equal(utils.resolveUiFontStack('theme', ''), '');
  assert.equal(utils.sanitizeCustomUiFont('  "霞鹜文楷", serif  '), '"霞鹜文楷", serif');
  assert.equal(utils.resolveUiFontStack('custom', '"霞鹜文楷", serif'), '"霞鹜文楷", serif');
});

test('ApiSettings exposes a persisted global UI font control', () => {
  assert.match(apiSettingsSource, /UI_FONT_PRESETS/);
  assert.match(apiSettingsSource, /界面字体/);
  assert.match(apiSettingsSource, /data-ui-font-settings="true"/);
  assert.match(apiSettingsSource, /data-ui-font-preset/);
  assert.match(apiSettingsSource, /界面字体预览/);
  assert.match(apiSettingsSource, /setUiFontPreset/);
  assert.match(apiSettingsSource, /setCustomUiFont/);
  assert.match(themeStoreSource, /uiFontPreset/);
  assert.match(themeStoreSource, /customUiFont/);
  assert.match(themeStoreSource, /setUiFontPreset/);
  assert.match(themeStoreSource, /resetUiFontPreference/);
  assert.match(appSource, /applyUiFontPreference/);
  assert.match(indexCss, /\.t8-ui-font-option/);
  assert.match(indexCss, /\.t8-ui-font-preview/);
});

test('Dragon Ball theme defaults to bundled mp3 music and packaging validates the asset', () => {
  const postBuild = readFileSync(new URL('../electron/_post_build.cjs', import.meta.url), 'utf8');
  const musicAsset = new URL('../src/assets/theme-music/dragonball-makafushigi-adventure.mp3', import.meta.url);
  const hiddenMusicAsset = new URL('../src/assets/theme-music/dragonball-shenron-cha-la-head-cha-la.mp3', import.meta.url);

  assert.equal(existsSync(musicAsset), true);
  assert.equal(existsSync(hiddenMusicAsset), true);
  assert.match(defaultTemplatesSource, /dragonBallThemeMusicUrl = new URL\('\.\.\/assets\/theme-music\/dragonball-makafushigi-adventure\.mp3'/);
  assert.match(defaultTemplatesSource, /dragonBallShenronHiddenMusicUrl = new URL\('\.\.\/assets\/theme-music\/dragonball-shenron-cha-la-head-cha-la\.mp3'/);
  assert.match(defaultTemplatesSource, /id: DRAGON_BALL_TEMPLATE_ID[\s\S]*source: 'url'[\s\S]*url: dragonBallThemeMusicUrl/);
  assert.match(defaultTemplatesSource, /title: '摩诃不思议 Adventure'/);
  assert.match(defaultTemplatesSource, /hiddenTitle: 'CHA-LA HEAD-CHA-LA'/);
  assert.match(defaultTemplatesSource, /hiddenUrl: dragonBallShenronHiddenMusicUrl/);
  assert.match(themeTemplateManagerSource, /dragonBallThemeMusicUrl/);
  assert.match(themeTemplateManagerSource, /dragonBallShenronHiddenMusicUrl/);
  assert.match(themeTemplateManagerSource, /visualStyle === 'dragon-ball'[\s\S]*source: 'url'[\s\S]*url: dragonBallThemeMusicUrl/);
  assert.match(themeTemplateManagerSource, /visualStyle === 'dragon-ball'[\s\S]*hiddenUrl: dragonBallShenronHiddenMusicUrl/);
  assert.match(postBuild, /checkFrontendAsset\('dragonball-makafushigi-adventure-', '\.mp3'\)/);
  assert.match(postBuild, /checkFrontendAsset\('dragonball-shenron-cha-la-head-cha-la-', '\.mp3'\)/);
  assert.match(featuresSource, /"dragon-ball-style": "dragonball-makafushigi-adventure\.mp3"/);
  assert.match(featuresSource, /"dragon-ball-shenron-hidden": "dragonball-shenron-cha-la-head-cha-la\.mp3"/);
});

test('Saint Seiya theme defaults to bundled sanctuary and Hades mp3 music', () => {
  const postBuild = readFileSync(new URL('../electron/_post_build.cjs', import.meta.url), 'utf8');
  const musicAsset = new URL('../src/assets/theme-music/saint-seiya-pegasus-fantasy.mp3', import.meta.url);
  const hiddenMusicAsset = new URL('../src/assets/theme-music/saint-seiya-hades-last-holy-war.mp3', import.meta.url);

  assert.equal(existsSync(musicAsset), true);
  assert.equal(existsSync(hiddenMusicAsset), true);
  assert.match(defaultTemplatesSource, /saintSeiyaThemeMusicUrl = new URL\('\.\.\/assets\/theme-music\/saint-seiya-pegasus-fantasy\.mp3'/);
  assert.match(defaultTemplatesSource, /saintSeiyaHadesThemeMusicUrl = new URL\('\.\.\/assets\/theme-music\/saint-seiya-hades-last-holy-war\.mp3'/);
  assert.match(defaultTemplatesSource, /id: SAINT_SEIYA_TEMPLATE_ID[\s\S]*source: 'url'[\s\S]*url: saintSeiyaThemeMusicUrl/);
  assert.match(defaultTemplatesSource, /hiddenUrl: saintSeiyaHadesThemeMusicUrl/);
  assert.match(themeTemplateManagerSource, /saintSeiyaThemeMusicUrl/);
  assert.match(themeTemplateManagerSource, /visualStyle === 'saint-seiya'[\s\S]*source: 'url'[\s\S]*url: saintSeiyaThemeMusicUrl/);
  assert.match(themeTemplateManagerSource, /visualStyle === 'saint-seiya'[\s\S]*hiddenUrl: saintSeiyaHadesThemeMusicUrl/);
  assert.match(postBuild, /checkFrontendAsset\('saint-seiya-pegasus-fantasy-', '\.mp3'\)/);
  assert.match(postBuild, /checkFrontendAsset\('saint-seiya-hades-last-holy-war-', '\.mp3'\)/);
  assert.match(postBuild, /film-tech-01\.mp4\.t8media/);
  assert.match(postBuild, /film-rh-01\.mp4\.t8media/);
  assert.match(postBuild, /film-yyh-01\.mp4\.t8media/);
  assert.match(postBuild, /film-dragon-ball-01\.mp4\.t8media/);
  assert.match(postBuild, /film-saint-seiya-01\.mp4\.t8media/);
  assert.match(postBuild, /film-tetris-01\.mp4\.t8media/);
  assert.match(featuresSource, /"saint-seiya-style": "saint-seiya-pegasus-fantasy\.mp3"/);
  assert.match(featuresSource, /"saint-seiya-hades-hidden": "saint-seiya-hades-last-holy-war\.mp3"/);
});
