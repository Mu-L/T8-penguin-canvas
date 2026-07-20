import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('garden defense is a complete built-in theme protocol entry', () => {
  const types = read('../src/theme/types.ts');
  const templates = read('../src/theme/defaultTemplates.ts');
  const manager = read('../src/components/ThemeTemplateManager.tsx');
  const musicToggle = read('../src/components/ThemeMusicToggle.tsx');
  const musicAutoplay = read('../src/theme/musicAutoplay.ts');
  const backend = read('../backend/src/routes/themes.js');
  const postBuild = read('../electron/_post_build.cjs');
  const features = read('../features.json');
  const readme = read('../README.md');
  const guide = read('../docs/theme-design-guide.md');

  assert.match(types, /'garden-defense'/);
  assert.match(types, /'garden-march'/);
  assert.match(types, /'garden-guard'/);
  assert.match(types, /'defense-lawn'/);
  assert.match(types, /'garden-card'/);
  assert.match(templates, /GARDEN_DEFENSE_TEMPLATE_ID = 'garden-defense-style'/);
  assert.match(templates, /name: '植物大战僵尸主题 · 庭院守卫'/);
  assert.match(templates, /preset: 'garden-march'/);
  assert.match(templates, /gardenDefenseThemeMusicUrl = new URL\('\.\.\/assets\/theme-music\/garden-defense-grasswalk\.mp3'/);
  assert.match(templates, /id: GARDEN_DEFENSE_TEMPLATE_ID[\s\S]*title: '植物大战僵尸白天（Grasswalk）'[\s\S]*source: 'url'[\s\S]*url: gardenDefenseThemeMusicUrl/);
  assert.equal(existsSync(new URL('../src/assets/theme-music/garden-defense-grasswalk.mp3', import.meta.url)), true);
  assert.match(manager, /value: 'garden-defense', label: '庭院守卫'/);
  assert.match(manager, /visualStyle === 'garden-defense'[\s\S]*source: 'url'[\s\S]*url: gardenDefenseThemeMusicUrl/);
  assert.match(manager, /requestGardenThemeMusicAutoplay\(editor\);[\s\S]*setTemplate\(editor\.id, mode\)/);
  assert.match(musicAutoplay, /template\.visuals\?\.style !== 'garden-defense'/);
  assert.match(musicAutoplay, /GARDEN_THEME_MUSIC_AUTOPLAY_EVENT/);
  assert.match(musicToggle, /gardenAutoPlayActive = template\.visuals\?\.style === 'garden-defense'/);
  assert.match(musicToggle, /handleGardenAutoplay[\s\S]*gestureGardenTemplateRef\.current = detail\.templateId[\s\S]*playThemeMusic\(detail\.music\)/);
  assert.match(musicToggle, /pendingGardenResumeRef\.current = true;[\s\S]*playCurrentMusic\(\)\.then/);
  assert.match(musicToggle, /document\.addEventListener\('pointerdown', resumeGardenMusic, true\)/);
  assert.match(musicToggle, /wasPlaying && !autoHiddenMusicRef\.current && !autoGardenMusicRef\.current/);
  assert.match(postBuild, /checkFrontendAsset\('garden-defense-grasswalk-', '\.mp3'\)/);
  assert.match(backend, /'garden-defense'/);
  assert.match(backend, /'garden-march'/);
  assert.match(features, /"gardenDefenseCanvasTheme"/);
  assert.match(readme, /庭院守卫主题 \+ 大画布塔防/);
  assert.match(guide, /`garden-defense` \| 庭院、防线、植物卡牌/);
});

test('garden music gesture bridge ignores every non-garden theme', async () => {
  const { GARDEN_THEME_MUSIC_AUTOPLAY_EVENT, requestGardenThemeMusicAutoplay } = await import('../src/theme/musicAutoplay.ts');
  const originalWindow = (globalThis as any).window;
  const fakeWindow = new EventTarget();
  let received: any = null;
  fakeWindow.addEventListener(GARDEN_THEME_MUSIC_AUTOPLAY_EVENT, (event) => {
    received = (event as CustomEvent).detail;
  });
  (globalThis as any).window = fakeWindow;

  try {
    assert.equal(requestGardenThemeMusicAutoplay({
      id: 'tech-default',
      visuals: { style: 'tech' },
    } as any), false);
    assert.equal(received, null);

    assert.equal(requestGardenThemeMusicAutoplay({
      id: 'garden-defense-style',
      visuals: { style: 'garden-defense' },
      music: {
        title: '植物大战僵尸白天（Grasswalk）',
        preset: 'garden-march',
        source: 'url',
        url: '/assets/garden-defense-grasswalk.mp3',
        volume: 0.16,
      },
    } as any), true);
    assert.equal(received?.templateId, 'garden-defense-style');
    assert.equal(received?.music?.url, '/assets/garden-defense-grasswalk.mp3');
  } finally {
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  }
});

test('garden defense battle is mounted under the top-right toolbar with Phaser and theme-scoped CSS', () => {
  const canvas = read('../src/components/Canvas.tsx');
  const experience = read('../src/features/garden-defense/GardenDefenseExperience.tsx');
  const stage = read('../src/features/garden-defense/GardenDefenseStage.tsx');
  const cssIndex = read('../src/styles/index.css');
  const themeCss = read('../src/styles/theme-garden-defense.css');
  const sound = read('../src/features/garden-defense/sound.ts');
  const storage = read('../src/features/garden-defense/storage.ts');
  const pkg = JSON.parse(read('../package.json'));

  assert.match(canvas, /GardenDefenseExperience/);
  assert.match(canvas, /withGardenDefenseNodeVisualState/);
  assert.match(canvas, /isGardenDefense\s*\?\s*nodes\.map\(withGardenDefenseNodeVisualState\)/);
  assert.match(experience, /GARDEN_PANEL_COLLAPSED_STORAGE_KEY/);
  assert.match(experience, /t8-garden-defense-panel__toggle/);
  assert.match(experience, /data-garden-panel-state/);
  assert.match(experience, /hidden=\{collapsed && !isStageMode\}/);
  assert.match(experience, /target instanceof Element/);
  assert.match(experience, /onMouseLeave=\{\(\) => setHovered\(false\)\}/);
  assert.match(experience, /activeAutoPauseReason/);
  assert.match(experience, /pauseGardenRun\(current\)/);
  assert.match(experience, /startGardenRun\(current\)/);
  assert.doesNotMatch(experience, /ViewportPortal/);
  assert.doesNotMatch(experience, /setCenter\(/);
  assert.match(experience, /lazy\(\(\) => import\('\.\/GardenDefenseStage\.tsx'\)\)/);
  assert.match(experience, /Maximize2/);
  assert.match(experience, /Minimize2/);
  assert.match(experience, /isStageMode/);
  assert.match(experience, /t8-garden-defense-stage-open/);
  assert.match(experience, /event\.key !== 'Escape'/);
  assert.match(experience, /createPortal\(panelMarkup, document\.body\)/);
  assert.match(experience, /t8-garden-defense-stage-toggle/);
  assert.match(experience, /沉浸大屏游玩/);
  assert.match(experience, /\(window\.innerWidth - horizontalPadding\) \/ GAME_WIDTH/);
  assert.match(experience, /\(window\.innerHeight - verticalPadding\) \/ GAME_HEIGHT/);
  assert.match(experience, /t8-garden-defense-stage-map/);
  assert.match(experience, /t8-garden-defense-upgrade-grid/);
  assert.match(experience, /t8-garden-defense-almanac/);
  assert.match(experience, /t8-garden-defense-pause-banner/);
  assert.match(stage, /new Phaser\.Game/);
  assert.match(stage, /syncEffects/);
  assert.match(stage, /playSunCollection/);
  assert.match(stage, /QuadraticBezier/);
  assert.match(stage, /getBoundingClientRect/);
  assert.match(stage, /gardenLastRawPointer/);
  assert.match(stage, /gardenSceneReady/);
  assert.match(stage, /data-garden-sun-count/);
  assert.match(experience, /data-garden-sun-pulse/);
  assert.match(experience, /projectile-fired/);
  assert.match(cssIndex, /theme-garden-defense\.css/);
  assert.match(themeCss, /data-theme-visual="garden-defense"/);
  assert.match(themeCss, /data-theme-mode="dark"/);
  assert.match(themeCss, /react-flow__pane::before/);
  assert.match(themeCss, /react-flow__edge-path\[data-t8-port-type="video"\]/);
  assert.match(themeCss, /react-flow__handle\[data-t8-port-type="image"\]/);
  assert.match(themeCss, /react-flow__minimap::before/);
  assert.match(themeCss, /\.t8-garden-defense-panel__popover/);
  assert.match(themeCss, /right: 0;/);
  assert.match(themeCss, /top: calc\(100% \+ 8px\);/);
  assert.match(themeCss, /transform: scale\(var\(--garden-panel-scale\)\)/);
  assert.match(themeCss, /body\.t8-garden-defense-stage-open/);
  assert.match(themeCss, /\.t8-garden-defense-panel\.is-stage-mode \{/);
  assert.match(themeCss, /position: fixed !important/);
  assert.match(themeCss, /--garden-panel-scale: var\(--garden-stage-scale\)/);
  assert.match(themeCss, /\.t8-garden-defense-stage-toggle\[aria-pressed="true"\]/);
  assert.match(themeCss, /garden-defense-sun-medallion-pop/);
  assert.match(themeCss, /is-garden-node-running/);
  assert.match(themeCss, /is-garden-node-success/);
  assert.match(themeCss, /is-garden-node-error/);
  assert.match(themeCss, /prefers-reduced-motion/);
  assert.match(sound, /MAX_ACTIVE_CUES/);
  assert.match(sound, /'frost-hit'/);
  assert.match(sound, /throttleMs/);
  assert.match(storage, /effects: \[\]/);
  assert.ok(pkg.dependencies.phaser);
});

test('generated garden art is wired for all eight plants and eight zombies', () => {
  const assets = read('../src/features/garden-defense/assets.ts');
  const plants = ['sun-bloom', 'pea-scout', 'frost-bulb', 'wall-root', 'ember-melon', 'storm-reed', 'healer-clover', 'chrono-mushroom'];
  const zombies = ['drifter', 'pothead', 'bucket-guard', 'sprinter', 'gatekeeper', 'mole-miner', 'moth-conductor', 'compost-titan'];
  plants.forEach((id) => assert.match(assets, new RegExp(id)));
  zombies.forEach((id) => assert.match(assets, new RegExp(id)));
  assert.match(assets, /garden-battlefield\.png/);
  assert.match(assets, /hud-banner\.png/);
  assert.match(assets, /upgrade-leaf\.png/);
  assert.match(assets, /pause-plate\.png/);
  assert.doesNotMatch(assets, /watering-can\.png/);
});
