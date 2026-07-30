import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  MIDJOURNEY_NZ_ACTIONS,
  buildMidjourneyNzRequest,
  midjourneyNzRequiresPrompt,
} from '../src/utils/midjourneyNz.ts';

const require = createRequire(import.meta.url);
const seedanceNz = require('../backend/src/providers/seedanceNz.js');
const TINY_PNG_A = 'data:image/png;base64,iVBORw0KGgo=';
const TINY_PNG_B = 'data:image/png;base64,iVBORw0KGgox';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('seedance.nz Midjourney catalog is the exact documented 16-action whitelist', () => {
  const operations = Object.keys(seedanceNz.MIDJOURNEY_ACTION_SPECS);
  assert.deepEqual(operations, [
    'midjourney-imagine',
    'midjourney-blend',
    'midjourney-describe',
    'midjourney-edits',
    'midjourney-upscale',
    'midjourney-variation',
    'midjourney-high-variation',
    'midjourney-low-variation',
    'midjourney-reroll',
    'midjourney-zoom',
    'midjourney-pan',
    'midjourney-inpaint',
    'midjourney-modal',
    'midjourney-video',
    'midjourney-remix-strong',
    'midjourney-remix-subtle',
  ]);
  assert.equal(MIDJOURNEY_NZ_ACTIONS.length, 16);
  assert.equal(new Set(MIDJOURNEY_NZ_ACTIONS.map((item) => item.value)).size, 16);
});

test('seedance.nz builds every Midjourney action with only the documented fields', async () => {
  let uploadIndex = 0;
  const fetchImpl = async (url: string) => {
    assert.match(url, /\/v1\/files\/upload$/);
    uploadIndex += 1;
    return jsonResponse({ url: `https://cdn.example.com/mj-${uploadIndex}.png` });
  };
  const requests: Record<string, Record<string, unknown>> = {
    'midjourney-imagine': { prompt: 'cinematic duck', images: [TINY_PNG_A], version: '8.1', quality: '1' },
    'midjourney-blend': { images: [TINY_PNG_A, TINY_PNG_B], dimensions: 'SQUARE' },
    'midjourney-describe': { images: [TINY_PNG_A] },
    'midjourney-edits': { prompt: 'change the lighting', images: [TINY_PNG_A] },
    'midjourney-upscale': { task_id: 'source_task', index: 1 },
    'midjourney-variation': { task_id: 'source_task', index: 2 },
    'midjourney-high-variation': { task_id: 'source_task', index: 3 },
    'midjourney-low-variation': { task_id: 'source_task', index: 4 },
    'midjourney-reroll': { task_id: 'source_task' },
    'midjourney-zoom': { task_id: 'source_task', index: 1, zoom_ratio: 1.5 },
    'midjourney-pan': { task_id: 'source_task', index: 1, direction: 'left' },
    'midjourney-inpaint': { task_id: 'source_task', index: 1 },
    'midjourney-modal': { task_id: 'source_task', prompt: 'replace coat', mask_url: TINY_PNG_A, modal_mode: 'region' },
    'midjourney-video': {
      prompt: 'slow camera push',
      images: [TINY_PNG_A],
      video_type: 'vid_1.1_i2v_480',
      animate_mode: 'manual',
      motion: 'low',
      batch_size: 1,
    },
    'midjourney-remix-strong': { task_id: 'source_task', index: 1, prompt: 'night scene' },
    'midjourney-remix-subtle': { task_id: 'source_task', index: 2, prompt: 'warmer light' },
  };

  for (const operation of Object.keys(seedanceNz.MIDJOURNEY_ACTION_SPECS)) {
    seedanceNz.resetCachesForTests();
    const built = await seedanceNz.buildMidjourneyPayload(
      { operation, ...requests[operation] },
      'test-key',
      { fetchImpl, uploadIntervalMs: 0 },
    );
    const spec = seedanceNz.MIDJOURNEY_ACTION_SPECS[operation];
    assert.equal(built.operation, operation);
    assert.equal(built.action, operation.slice('midjourney-'.length));
    assert.equal(built.resultFamily, spec.resultFamily);
    assert.equal(Object.hasOwn(built.payload, 'model'), false);
    for (const field of Object.keys(built.payload)) {
      assert.ok(spec.allowedFields.includes(field), `${operation} leaked field ${field}`);
    }
    for (const field of spec.requiredFields) {
      assert.notEqual(built.payload[field], undefined, `${operation} missing ${field}`);
    }
  }
});

test('seedance.nz enforces Midjourney image counts, task indexes, custom buttons and video source modes', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return jsonResponse({ url: 'https://cdn.example.com/reference.png' });
  };
  await assert.rejects(
    seedanceNz.buildMidjourneyPayload(
      {
        operation: 'midjourney-imagine',
        prompt: 'five references must be rejected rather than silently truncated',
        images: [TINY_PNG_A, TINY_PNG_B, TINY_PNG_A, TINY_PNG_B, TINY_PNG_A],
      },
      'test-key',
      { fetchImpl, uploadIntervalMs: 0 },
    ),
    /最多支持 4 张图片/,
  );
  assert.equal(fetchCalls, 0);
  await assert.rejects(
    seedanceNz.buildMidjourneyPayload(
      { operation: 'midjourney-blend', images: [TINY_PNG_A] },
      'test-key',
      { fetchImpl, uploadIntervalMs: 0 },
    ),
    /2–4 张图片/,
  );
  await assert.rejects(
    seedanceNz.buildMidjourneyPayload(
      { operation: 'midjourney-describe', images: [TINY_PNG_A, TINY_PNG_B] },
      'test-key',
      { fetchImpl, uploadIntervalMs: 0 },
    ),
    /只能提供 1 张图片/,
  );
  await assert.rejects(
    seedanceNz.buildMidjourneyPayload(
      { operation: 'midjourney-upscale', task_id: 'source', index: 0 },
      'test-key',
    ),
    /index 必须为 1–4/,
  );
  const custom = await seedanceNz.buildMidjourneyPayload(
    {
      operation: 'midjourney-pan',
      task_id: 'source',
      custom_id: 'button-value',
      index: 4,
      direction: 'right',
    },
    'test-key',
  );
  assert.equal(custom.payload.custom_id, 'button-value');
  assert.equal(Object.hasOwn(custom.payload, 'index'), false);
  assert.equal(Object.hasOwn(custom.payload, 'direction'), false);

  const taskVideo = await seedanceNz.buildMidjourneyPayload({
    operation: 'midjourney-video',
    task_id: 'source',
    index: 0,
    video_type: 'vid_1.1_i2v_720',
    animate_mode: 'auto',
    motion: 'high',
    batch_size: 2,
  }, 'test-key');
  assert.equal(taskVideo.payload.index, 0);
  assert.equal(taskVideo.payload.batch_size, 2);
  await assert.rejects(
    seedanceNz.buildMidjourneyPayload({
      operation: 'midjourney-video',
      task_id: 'source',
      images: [TINY_PNG_A],
      video_type: 'vid_1.1_i2v_480',
      animate_mode: 'manual',
      motion: 'low',
      batch_size: 1,
    }, 'test-key', { fetchImpl, uploadIntervalMs: 0 }),
    /必须且只能选择首帧图片或任务 ID/,
  );
});

test('seedance.nz submits immediate Describe and polls async Midjourney on official v1 routes', async () => {
  const seen: Array<{ url: string; body?: any }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith('/v1/files/upload')) {
      return jsonResponse({ url: 'https://cdn.example.com/reference.png' });
    }
    if (url.endsWith('/v1/midjourney/generations/describe')) {
      return jsonResponse({ data: { description: 'A cinematic rainy alley.' } });
    }
    if (url.endsWith('/v1/midjourney/generations/imagine')) {
      return jsonResponse({ data: { task_id: 'mj_task_1', status: 'SUBMITTED' } });
    }
    if (url.endsWith('/v1/midjourney/tasks/mj_task_1')) {
      return jsonResponse({
        data: {
          task_id: 'mj_task_1',
          status: 'SUCCESS',
          progress: 100,
          result: {
            grid_image_url: 'https://cdn.example.com/grid.png',
            image_urls: [
              { url: 'https://cdn.example.com/one.png' },
              { image_url: 'https://cdn.example.com/two.png' },
            ],
            buttons: [{ label: 'U1', custom_id: 'upscale-1' }],
          },
        },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  seedanceNz.resetCachesForTests();
  const describe = await seedanceNz.submitMidjourneyAction({
    operation: 'midjourney-describe',
    images: [TINY_PNG_A],
  }, 'test-key', { fetchImpl, uploadIntervalMs: 0 });
  assert.equal(describe.sync, true);
  assert.equal(describe.text, 'A cinematic rainy alley.');
  assert.equal(describe.taskId, '');

  const submitted = await seedanceNz.submitMidjourneyAction({
    operation: 'midjourney-imagine',
    prompt: 'cinematic rainy alley',
  }, 'test-key', { fetchImpl });
  assert.equal(submitted.sync, false);
  assert.equal(submitted.taskId, 'mj_task_1');
  assert.equal(seen.at(-1)?.url, `${seedanceNz.BASE_URL}/v1/midjourney/generations/imagine`);
  assert.deepEqual(seen.at(-1)?.body, { prompt: 'cinematic rainy alley' });

  const queried = await seedanceNz.queryMidjourneyTask('mj_task_1', 'test-key', { fetchImpl });
  assert.equal(queried.status, 'succeeded');
  assert.equal(queried.gridImageUrl, 'https://cdn.example.com/grid.png');
  assert.deepEqual(queried.imageUrls, [
    'https://cdn.example.com/one.png',
    'https://cdn.example.com/two.png',
  ]);
  assert.deepEqual(queried.buttons, [{ customId: 'upscale-1', label: 'U1' }]);
  assert.equal(seen.at(-1)?.url, `${seedanceNz.BASE_URL}/v1/midjourney/tasks/mj_task_1`);
});

test('seedance.nz stops Inpaint at MODAL and preserves the task for the follow-up action', async () => {
  const fetchImpl = async () => jsonResponse({
    data: {
      task_id: 'modal_source',
      status: 'MODAL',
      buttons: [{ label: 'Submit', custom_id: 'modal-submit' }],
    },
  });
  const queried = await seedanceNz.queryMidjourneyTask('modal_source', 'test-key', { fetchImpl });
  assert.equal(queried.status, 'modal');
  assert.equal(queried.taskId, 'modal_source');
  assert.deepEqual(queried.buttons, [{ customId: 'modal-submit', label: 'Submit' }]);
});

test('frontend Midjourney builder keeps the budget platform action contract separate from legacy MJ', () => {
  assert.equal(midjourneyNzRequiresPrompt('midjourney-imagine'), true);
  assert.equal(midjourneyNzRequiresPrompt('midjourney-blend'), false);
  assert.equal(midjourneyNzRequiresPrompt('midjourney-video', 'image'), true);
  assert.equal(midjourneyNzRequiresPrompt('midjourney-video', 'task'), false);

  const directVideo = buildMidjourneyNzRequest({
    mjNzOperation: 'midjourney-video',
    mjNzVideoSource: 'image',
    mjNzVideoType: 'vid_1.1_i2v_start_end_720',
  }, 'camera orbit', ['start.png', 'end.png']);
  assert.deepEqual(directVideo.images, ['start.png']);
  assert.equal(directVideo.end_url, 'end.png');

  const taskVideo = buildMidjourneyNzRequest({
    mjNzOperation: 'midjourney-video',
    mjNzVideoSource: 'task',
    mjNzSourceTaskId: 'task_x',
    mjNzVideoIndex: 0,
  }, '', []);
  assert.equal(taskVideo.task_id, 'task_x');
  assert.equal(taskVideo.index, 0);
  assert.equal(taskVideo.images, undefined);

  const imageNode = readFileSync(new URL('../src/components/nodes/ImageNode.tsx', import.meta.url), 'utf8');
  const generation = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8');
  const proxy = readFileSync(new URL('../backend/src/routes/proxy.js', import.meta.url), 'utf8');
  assert.match(imageNode, /isZhenzhenBudgetMjSelected/);
  assert.match(imageNode, /submitMidjourneyNz/);
  assert.match(imageNode, /submitMjImagine/);
  assert.match(generation, /\/api\/proxy\/image\/seedance-nz\/midjourney\/submit/);
  assert.match(proxy, /router\.post\('\/image\/seedance-nz\/midjourney\/submit'/);
  assert.match(proxy, /router\.post\('\/mj\/imagine'/);
});
