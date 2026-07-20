import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('topbar exposes plugin install as a separate button before canvas tutorial', () => {
  const app = read('src/App.tsx');
  const packageJson = read('package.json');
  const photoshopManifest = read('tools/photoshop-bridge/plugin/manifest.json');
  const figmaManifest = read('tools/figma-bridge/plugin/manifest.json');
  const extensionManifest = read('extension/manifest.json');

  assert.match(app, /pluginInstallOpen/);
  assert.match(app, /pluginInstallWrapRef/);
  assert.ok(app.indexOf('title="插件安装') < app.indexOf('title="画布教程'));
  assert.ok(app.indexOf('setPluginInstallOpen') < app.indexOf('setCanvasTutorialOpen'));
  assert.match(app, /插件安装/);
  assert.match(app, /T8 Photoshop Link/);
  assert.match(app, /tools\\\\photoshop-bridge\\\\plugin\\\\manifest\.json/);
  assert.match(app, /Adobe UXP Developer Tool/);
  assert.match(app, /T8 Penguin Canvas Bridge/);
  assert.match(app, /tools\\\\figma-bridge\\\\plugin\\\\manifest\.json/);
  assert.match(app, /Plugins\s*->\s*Development\s*->\s*Import plugin from manifest/);
  assert.match(app, /网页图片反推与素材采集 Chrome 扩展/);
  assert.match(app, /Popup 或 Side Panel/);
  assert.match(app, /resources\/extension\/web-image-reverse\//);
  assert.match(app, /localhost|127\.0\.0\.1/);

  assert.match(photoshopManifest, /T8 Photoshop Link/);
  assert.match(figmaManifest, /T8 Penguin Canvas Bridge/);
  assert.match(extensionManifest, /T8 Penguin Canvas Web Image Reverse/);
  assert.match(packageJson, /"from":\s*"tools\/photoshop-bridge"/);
  assert.match(packageJson, /"from":\s*"tools\/figma-bridge"/);
  assert.match(packageJson, /"from":\s*"extension"/);
});

test('topbar exposes zhaotutu tagger tab before plugin install with its own panel link', () => {
  const app = read('src/App.tsx');

  assert.match(app, /ZHAOTUTU_TAGGER_TRAINER_URL\s*=\s*'https:\/\/zhaotutu\.xyz'/);
  assert.match(app, /zhaotutuOpen/);
  assert.match(app, /zhaotutuWrapRef/);
  assert.match(app, /handleOpenZhaotutuTaggerTrainer/);
  assert.match(app, /typeof window\.t8pc\?\.openExternal === 'function'/);
  assert.match(app, /window\.t8pc\.openExternal\(ZHAOTUTU_TAGGER_TRAINER_URL\)/);
  assert.match(app, /result\?\.success === true/);
  assert.match(app, /window\.open\(ZHAOTUTU_TAGGER_TRAINER_URL,\s*'_blank',\s*'noopener,noreferrer'\)/);
  assert.ok(app.indexOf('title="图图打标器') < app.indexOf('title="插件安装'));
  assert.ok(app.indexOf('<span className="text-[11px]">图图打标器</span>') < app.indexOf('<span className="text-[11px]">插件安装</span>'));
  assert.match(app, /最好的打标和模型训练工具-图图打标及训练器/);
  assert.match(app, />点击获取</);
});

test('topbar exposes a compact API acquisition panel beside zhaotutu', () => {
  const app = read('src/App.tsx');

  assert.match(app, /apiAcquisitionOpen/);
  assert.match(app, /apiAcquisitionWrapRef/);
  assert.match(app, /title="API获取 · 国内与海外 API Key 注册入口"/);
  assert.match(app, /<span className="text-\[11px\]">API获取<\/span>/);
  assert.ok(app.indexOf('title="图图打标器') < app.indexOf('title="API获取'));
  assert.ok(app.indexOf('title="API获取') < app.indexOf('title="插件安装'));
  assert.match(app, /https:\/\/api\.seedance\.nz\/sign-up\?aff=5f4w/);
  assert.match(app, /https:\/\/ai\.t8star\.org\/register\?aff=dP7j/);
  assert.match(app, /https:\/\/www\.runninghub\.cn\/user-center\/1819214514410942465\/webapp\?inviteCode=rh-v1121/);
  assert.match(app, /https:\/\/www\.runninghub\.ai\/user-center\/1907375370302308353\/webapp\?inviteCode=rh-v1121/);
  assert.match(app, /贞贞的平价AI小屋（国内版）/);
  assert.match(app, /贞贞的AI工坊（海外版）/);
  assert.match(app, /RunningHub APIKEY 国内版/);
  assert.match(app, /RunningHub APIKEY 海外版/);
  assert.match(app, /window\.t8pc\.openExternal\(url\)/);
  assert.match(app, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
});
