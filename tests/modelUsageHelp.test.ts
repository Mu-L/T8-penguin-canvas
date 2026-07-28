import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const canvasSource = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8');

test('model usage help defaults to budget house and keeps the original workshop in a second tab', () => {
  assert.match(canvasSource, /type ModelUsageHelpTabId = 'budget-house' \| 'workshop'/);
  assert.match(canvasSource, /useState<ModelUsageHelpTabId>\('budget-house'\)/);
  assert.match(canvasSource, /label: '贞贞的平价AI小屋'/);
  assert.match(canvasSource, /label: '贞贞的AI工坊'/);
  assert.match(canvasSource, /role="tablist" aria-label="模型平台"/);
  assert.match(canvasSource, /role="tabpanel"/);
  assert.match(canvasSource, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(styleSource, /\.t8-model-help-panel__tabs/);
  assert.match(styleSource, /\.t8-model-help-panel__tab\.is-active/);
});

test('model usage help control appears immediately before the placement shelf control', () => {
  const controlStackIndex = canvasSource.indexOf('className="t8-control-stack"');
  const modelHelpIndex = canvasSource.indexOf('data-canvas-floating-ui="model-help-toggle"', controlStackIndex);
  const placementShelfIndex = canvasSource.indexOf('data-canvas-floating-ui="placement-shelf-toggle"', controlStackIndex);
  assert.ok(controlStackIndex >= 0);
  assert.ok(modelHelpIndex > controlStackIndex);
  assert.ok(placementShelfIndex > modelHelpIndex);
  const betweenModelHelpAndPlacementShelf = canvasSource.slice(
    modelHelpIndex + 'data-canvas-floating-ui="model-help-toggle"'.length,
    placementShelfIndex,
  );
  assert.doesNotMatch(
    betweenModelHelpAndPlacementShelf,
    /data-canvas-floating-ui="[^"]+-toggle"/,
  );
});

test('budget house model usage help includes its channel, review, pricing and recommended models', () => {
  assert.match(canvasSource, /与贞贞的AI工坊不同，模型以国内模型以及一些海外核心模型为主/);
  assert.match(canvasSource, /支持宽审核开通；请合规使用/);
  assert.match(canvasSource, /Seedance 2\.0 官方特价版/);
  assert.match(canvasSource, /720P 约 1 元\/秒，480P Mini 不到 0\.25 元\/秒/);
  assert.match(canvasSource, /zhenzhen-image-g-v2-lowprice/);
  assert.match(canvasSource, /zhenzhen-video-gk-v15/);
  assert.match(canvasSource, /zhenzhen-image-nb-2/);
  assert.match(canvasSource, /zhenzhen-image-nb-pro/);
  assert.match(canvasSource, /zhenzhen-video-g-omni-flash/);
  assert.match(canvasSource, /midjourney-imagine/);
  assert.match(canvasSource, /dola-seedream-5\.0-pro-i2i/);
  assert.match(canvasSource, /zhenzhen-image-gk-v15-edit/);
});

test('workshop model usage help preserves the current image, video, audio and LLM notes', () => {
  assert.match(canvasSource, /如果不小心网页崩溃等，但是实际任务没失败，需要去网站异步任务看下/);
  assert.match(canvasSource, /图像模型注意事项（2K，4K只有FAL长期稳定，其他都不保证稳定）/);
  assert.match(canvasSource, /2026\.06\.25谷歌香蕉模型从preview模型升级为正式版，模型名字需要修改/);
  assert.match(canvasSource, /gemini-3-pro-image-preview ，需要改为 gemini-3-pro-image/);
  assert.match(canvasSource, /gemini-3-pro-image，gemini-3-pro-image-2k，gemini-3-pro-image-4k，gemini-3\.1-flash-image，gemini-3\.1-flash-image-512px，gemini-3\.1-flash-image-2k，gemini-3\.1-flash-image-4k/);
  assert.match(canvasSource, /特殊的nano-banana-pro模型不需要修改/);
  assert.match(canvasSource, /gpt-image-2模型，新增azure特价分组，固定0\.3积分，支持2K,4K，目前稳定/);
  assert.match(canvasSource, /gpt-image-2模型（default分组）可以出1K，2K，4K图，2K，4K不一定稳定/);
  assert.match(canvasSource, /gpt-image-2-2k模型是备用模型，非gpt-image-2模型分支，直接支持2k，目前0\.1积分,2026\.06\.10新增（default分组）/);
  assert.match(canvasSource, /gpt-image-2-4k模型是备用模型，非gpt-image-2模型分支，直接支持2k，目前0\.1积分,2026\.06\.10新增（default分组）/);
  assert.match(canvasSource, /veo-omni模型，需要使用default分组（veo-omnii模型是2026\.06\.06刚上架的）/);
  assert.match(canvasSource, /20250624更新，seedance2\.0新增mini模型（720P是满血版的一半），支持原生4K，电影级质感（仅满血720P可选）/);
  assert.match(canvasSource, /grok-video模型，需要看下网站左侧分类教程，有多个分组可用，目前比较稳的是fal模型和默认分组/);
  assert.match(canvasSource, /2026\.06\.11修复grok-video-3模型的defualt默认分组，直接升级成imagine 1\.5模型，0\.5积分10秒，2026\.06\.12新增grok-video-1\.5-6s，grok-video-1\.5-10s，grok-video-1\.5-15s模型，默认720P，分组default，3个模型，分别是0\.5，0\.7，0\.7积分，最佳SD2\.0平替/);
  assert.match(canvasSource, /sora-2模型，支持sora-vip分组以及default默认分组的FAL模型/);
  assert.match(canvasSource, /suno v5\.5模型（Default分组）支持生成，翻唱，延长，一次生成两首歌/);
  assert.match(canvasSource, /LLM模型有时候因为官方问题会出现速度慢，失败等现象，这时候换个模型即可或者换一下分组即可/);
});

test('model usage help no longer warns that Sora2 is unavailable', () => {
  assert.doesNotMatch(canvasSource, /20260\.06\.11/);
  assert.doesNotMatch(canvasSource, /sora-2模型，由于官方下架了/);
  assert.doesNotMatch(canvasSource, /目前有问题，先不要用/);
  assert.doesNotMatch(canvasSource, /gpt-image-2-vip模型/);
});
