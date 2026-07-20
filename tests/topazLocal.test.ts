import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { EXECUTABLE_NODE_TYPES } from '../src/config/executableNodeTypes.ts';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

const require = createRequire(import.meta.url);
const {
  buildGigapixelArgs,
  buildTopazVideoArgs,
  buildTopazVideoFilterChain,
} = require('../backend/src/tools/topaz/runner.js');

function read(rel: string) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

test('Topaz Gigapixel args mirror ComfyUI CLI mapping', () => {
  const plan = buildGigapixelArgs({
    inputPath: 'input.png',
    outputDir: 'out',
    scale: 2,
    model: 'Standard',
    denoise: 1,
    sharpen: 2,
    compression: 67,
    fineDetail: 50,
  });

  assert.deepEqual(plan.args.slice(0, 6), ['--scale', '2', '-i', 'input.png', '-o', 'out']);
  assert.ok(plan.args.includes('--dn'));
  assert.ok(plan.args.includes('--sh'));
  assert.ok(plan.args.includes('--cm'));
  assert.ok(plan.args.includes('--fr'));
  assert.equal(plan.args[plan.args.indexOf('--model') + 1], 'std');
  assert.equal(plan.args[plan.args.indexOf('--mv') + 1], '2');
});

test('Topaz Gigapixel only sends pre-downscaling for Recover model', () => {
  const standard = buildGigapixelArgs({
    inputPath: 'input.png',
    outputDir: 'out',
    model: 'std',
    preDownscaling: 80,
  });
  const recovery = buildGigapixelArgs({
    inputPath: 'input.png',
    outputDir: 'out',
    model: 'recovery',
    preDownscaling: 80,
  });

  assert.equal(standard.args.includes('--pds'), false);
  assert.equal(recovery.args[recovery.args.indexOf('--pds') + 1], '80');
});

test('Topaz Video chains upscale and frame interpolation in one ffmpeg pass', () => {
  const plan = buildTopazVideoArgs({
    inputPath: 'input.mp4',
    outputPath: 'output.mp4',
    enableUpscale: true,
    upscaleModel: 'iris-3',
    upscaleFactor: 2,
    compression: 1,
    blend: 0,
    enableInterpolation: true,
    inputFps: 24,
    interpolationMultiplier: 2,
    interpolationModel: 'apo-8',
    useGpu: true,
  });

  const vfIndex = plan.args.indexOf('-vf');
  assert.equal(
    plan.args[vfIndex + 1],
    'tvai_up=model=iris-3:scale=2:estimate=8:compression=1:blend=0,tvai_fi=model=apo-8:fps=48',
  );
  assert.equal(plan.args.filter((arg: string) => arg === '-vf').length, 1);
  assert.equal(plan.args.includes('hevc_nvenc'), true);
  assert.equal(plan.settings.targetFps, 48);
});

test('Topaz Video fixes thm-2 to 1x and rejects empty actions', () => {
  const filter = buildTopazVideoFilterChain({
    enableUpscale: true,
    upscaleModel: 'thm-2',
    upscaleFactor: 4,
    enableInterpolation: false,
  });

  assert.match(filter.filterChain, /tvai_up=model=thm-2:scale=1:/);
  assert.equal(filter.settings.upscaleFactor, 1);
  assert.throws(
    () => buildTopazVideoFilterChain({ enableUpscale: false, enableInterpolation: false }),
    /至少开启/,
  );
});

test('Topaz local nodes are registered, executable, routed and package-checked', () => {
  const types = read('src/types/canvas.ts');
  const canvas = read('src/components/Canvas.tsx');
  const loop = read('src/components/nodes/LoopNode.tsx');
  const server = read('backend/src/server.js');
  const postBuild = read('electron/_post_build.cjs');

  assertProductionNodeSchema('topaz-image-upscale', {
    label: 'Topaz图像高清化',
    category: 'toolbox',
    inputs: ['image'],
    outputs: ['image'],
    executable: true,
  });
  assertProductionNodeSchema('topaz-video-upscale', {
    label: 'Topaz视频高清化',
    category: 'toolbox',
    inputs: ['video'],
    outputs: ['video'],
    executable: true,
  });
  assert.match(types, /\|\s*'topaz-image-upscale'/);
  assert.match(types, /\|\s*'topaz-video-upscale'/);
  assert.match(canvas, /TopazImageUpscaleNode/);
  assert.match(canvas, /TopazVideoUpscaleNode/);
  assert.match(canvas, /'topaz-image-upscale':\s*TopazImageUpscaleNode/);
  assert.match(canvas, /'topaz-video-upscale':\s*TopazVideoUpscaleNode/);
  assert.equal(EXECUTABLE_NODE_TYPES.has('topaz-image-upscale'), true);
  assert.equal(EXECUTABLE_NODE_TYPES.has('topaz-video-upscale'), true);
  assert.match(loop, /import \{ EXECUTABLE_NODE_TYPES \} from '\.\.\/\.\.\/config\/executableNodeTypes'/);
  assert.match(loop, /topologicalSort\(routePlanned\.nodes, routePlanned\.edges, EXECUTABLE_NODE_TYPES\)/);
  assert.match(server, /const topazRouter = require\('\.\/routes\/topaz'\)/);
  assert.match(server, /app\.use\('\/api\/topaz', topazRouter\)/);
  assert.match(postBuild, /routes', 'topaz\.t8c'/);
  assert.match(postBuild, /tools', 'topaz', 'runner\.t8c'/);
});

test('Topaz frontend nodes explain local installation requirement', () => {
  const imageNode = read('src/components/nodes/TopazImageUpscaleNode.tsx');
  const videoNode = read('src/components/nodes/TopazVideoUpscaleNode.tsx');
  const service = read('src/services/topaz.ts');

  assert.match(imageNode, /需要本机已安装并登录 Topaz Gigapixel AI/);
  assert.match(videoNode, /需要本机已安装并登录 Topaz Video AI/);
  assert.match(videoNode, /tvai_up \/ tvai_fi/);
  assert.match(service, /\/api\/topaz/);
  assert.match(service, /runTopazGigapixel/);
  assert.match(service, /runTopazVideo/);
});
