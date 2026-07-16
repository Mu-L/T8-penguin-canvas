import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';
import { getNodeOutputs } from '../src/config/portTypes.ts';

const loadFalToolboxUtils = async () => import('../src/utils/falToolbox.ts');
const loadFalToolboxManifest = async () => import('../src/data/falToolboxManifest.ts');

test('Fal toolbox node is registered as a visible executable FAL node', () => {
  const registry = readFileSync(new URL('../src/config/nodeRegistry.ts', import.meta.url), 'utf8');
  const types = readFileSync(new URL('../src/types/canvas.ts', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
  const actionBar = readFileSync(new URL('../src/components/NodeActionBar.tsx', import.meta.url), 'utf8');
  const loop = readFileSync(new URL('../src/components/nodes/LoopNode.tsx', import.meta.url), 'utf8');
  const node = readFileSync(new URL('../src/components/nodes/FalToolboxNode.tsx', import.meta.url), 'utf8');

  assertProductionNodeSchema('fal-toolbox', {
    label: 'Fal超市',
    category: 'fal',
    inputs: ['text', 'image', 'video', 'audio'],
    outputs: ['text', 'image', 'video', 'audio', 'model3d'],
    executable: true,
  });
  assertProductionNodeSchema('model-3d-upload', {
    label: '3D素材上传',
    category: 'input',
    inputs: [],
    outputs: ['model3d'],
    executable: false,
  });
  assertProductionNodeSchema('model-3d-preview', {
    label: '3D模型预览',
    category: 'input',
    inputs: ['model3d'],
    outputs: ['image'],
    executable: false,
  });
  assert.match(registry, /fal:\s*\{\s*label:\s*'FAL工具箱'/);
  assert.deepEqual(getNodeOutputs({ type: 'upload', data: { uploadType: 'model3d' } } as never), ['model3d']);
  assert.deepEqual(getNodeOutputs({ type: 'model-3d-upload', data: {} } as never), ['model3d']);
  assert.match(types, /\|\s*'fal-toolbox'/);
  assert.match(types, /\|\s*'model-3d-preview'/);
  assert.match(types, /\|\s*'model-3d-upload'/);
  assert.match(types, /\|\s*'fal'/);
  assert.match(canvas, /const FalToolboxNode = lazyCanvasNode\(\(\) => import\('\.\/nodes\/FalToolboxNode'\), 'FalToolboxNode'\)/);
  assert.match(canvas, /const Model3DPreviewNode = lazyCanvasNode\(\(\) => import\('\.\/nodes\/Model3DPreviewNode'\), 'Model3DPreviewNode'\)/);
  assert.match(canvas, /'fal-toolbox': FalToolboxNode/);
  assert.match(canvas, /'model-3d-preview': Model3DPreviewNode/);
  assert.match(canvas, /'model-3d-upload': UploadNode/);
  assert.match(canvas, /'fal-toolbox':\s*\{/);
  assert.match(canvas, /'model-3d-preview':\s*\{/);
  assert.match(canvas, /'model-3d-upload':\s*\{\s*uploadType:\s*'model3d'/);
  assert.match(canvas, /import \{ EXECUTABLE_NODE_TYPES \} from '\.\.\/config\/executableNodeTypes'/);
  assert.match(actionBar, /EXECUTABLE_NODE_TYPES\.has\(n\.type\)/);
  assert.match(loop, /import \{ EXECUTABLE_NODE_TYPES \} from '\.\.\/\.\.\/config\/executableNodeTypes'/);
  assert.match(node, /const handleHorizontalWheel = \(event: WheelEvent<HTMLDivElement>\)/);
  assert.match(node, /el\.scrollLeft \+= delta/);
  assert.equal((node.match(/onWheel=\{handleHorizontalWheel\}/g) || []).length >= 2, true);
  assert.match(node, /Fal模型会先预扣3\.4币，生成完成后多退少补/);
  assert.match(node, /import MentionPromptInput from '\.\/MentionPromptInput'/);
  assert.match(node, /resolveMediaMentions/);
  assert.match(node, /Prompt 可本地输入或接上游文本/);
  assert.match(node, /本地为空时使用上游文本/);
  const falToolboxLabels = node.match(/<label\b[\s\S]*?<\/label>/g) || [];
  assert.equal(falToolboxLabels.some((label) => label.includes('MentionPromptInput')), false);
  assert.match(node, /falToolboxTextInputs/);
  assert.match(node, /falToolboxTextMentions/);
  assert.match(node, /falToolboxUserParamMentions/);
  assert.match(node, /inputValues:\s*resolvedTextInputs/);
  const service = readFileSync(new URL('../src/services/falToolbox.ts', import.meta.url), 'utf8');
  assert.match(service, /inputValues\?: Record<string, string \| string\[\]>/);
  assert.match(service, /stillMissing/);
});

test('Fal toolbox manifest normalizes configured tools and builds generic payloads', async () => {
  const { FAL_TOOLBOX_MANIFEST } = await loadFalToolboxManifest();
  const {
    buildFalToolboxRunPayload,
    filterFalToolboxTools,
    findFalToolboxToolById,
    listFalToolboxTools,
    normalizeFalToolboxManifest,
    pickFalToolboxInputs,
  } = await loadFalToolboxUtils();

  const manifest = normalizeFalToolboxManifest(FAL_TOOLBOX_MANIFEST);
  assert.equal(manifest.schema, 't8-fal-toolbox-manifest');
  assert.equal(manifest.categories.some((category) => category.id === 'video-generation'), true);
  assert.equal(manifest.categories.some((category) => category.id === 'model-3d'), true);
  assert.equal(listFalToolboxTools(manifest).length >= 55, true);
  const zhenzhenFalIds = [
    'zhenzhen-bernini-r-video-fal',
    'zhenzhen-bernini-r-edit-video-fal',
    'zhenzhen-bernini-r-reference-edit-video-fal',
    'zhenzhen-bernini-r-edit-image-fal',
    'zhenzhen-luma-ray-v3.2-fal',
    'zhenzhen-luma-ray-v3.2-image-to-video-fal',
    'zhenzhen-luma-uni-1-v1-fal',
    'zhenzhen-luma-uni-1-v1-max-fal',
    'zhenzhen-luma-uni-1-v1-edit-fal',
    'zhenzhen-luma-uni-1-v1-edit-max-fal',
    'zhenzhen-bria-video-background-removal-v3-fal',
    'zhenzhen-nemotron-asr-multilingual-fal',
    'zhenzhen-bria-genfill-v2-fal',
    'zhenzhen-luma-ray-v3.2-video-to-video-fal',
    'zhenzhen-pixelcut-video-background-removal-fal',
  ];
  for (const id of zhenzhenFalIds) assert.ok(findFalToolboxToolById(manifest, id), id);
  assert.deepEqual(
    filterFalToolboxTools(manifest, { categoryId: 'video-generation', query: 'sora' }).map((tool) => tool.id),
    ['sora2-fal-text', 'sora2-fal-image'],
  );

  const tool = findFalToolboxToolById(manifest, 'gpt-image-2-fal-edit');
  assert.ok(tool);
  const picked = pickFalToolboxInputs(tool!, {
    texts: ['把人物改成赛博朋克风'],
    images: ['/files/input/ref.png'],
  });
  assert.deepEqual(picked.missing, []);
  const payload = buildFalToolboxRunPayload(tool!, {
    inputValues: picked.values,
    userParamValues: { image_size: 'square_hd', quality: 'high', num_images: 2 },
  });
  assert.equal(payload.endpoint, 'openai/gpt-image-2/edit');
  assert.equal(payload.payload.prompt, '把人物改成赛博朋克风');
  assert.deepEqual(payload.payload.image_urls, ['/files/input/ref.png']);
  assert.deepEqual(payload.mediaFields, [{ key: 'image_urls', kind: 'image', multiple: true, upload: true, mediaMode: 'base64' }]);

  const maiTool = findFalToolboxToolById(manifest, 'mai-image-2-5-fal');
  assert.ok(maiTool);
  const missingMai = pickFalToolboxInputs(maiTool!, {});
  assert.deepEqual(missingMai.missingKeys, ['prompt']);
  const directPromptPayload = buildFalToolboxRunPayload(maiTool!, {
    inputValues: { prompt: '一只发光的机械企鹅站在电影布光里' },
    userParamValues: { aspect_ratio: '16:9', num_images: 1 },
  });
  assert.equal(directPromptPayload.payload.prompt, '一只发光的机械企鹅站在电影布光里');

  const vtoTool = findFalToolboxToolById(manifest, 'flux-pro-vto-fal');
  assert.ok(vtoTool);
  const pickedVto = pickFalToolboxInputs(vtoTool!, {
    texts: ['把服装自然穿在模特身上'],
    images: ['/files/input/human.png', '/files/input/cloth.png'],
  });
  assert.deepEqual(pickedVto.missing, []);
  assert.equal(pickedVto.values.human_image_url, '/files/input/human.png');
  assert.equal(pickedVto.values.garment_image_url, '/files/input/cloth.png');
  const vtoPayload = buildFalToolboxRunPayload(vtoTool!, {
    inputValues: pickedVto.values,
    userParamValues: {},
  });
  assert.equal(vtoPayload.payload.human_image_url, '/files/input/human.png');
  assert.equal(vtoPayload.payload.garment_image_url, '/files/input/cloth.png');

  const modelTool = findFalToolboxToolById(manifest, 'hunyuan-3d-v3-1-pro-image-fal');
  assert.ok(modelTool);
  assert.equal(modelTool!.outputSchema.some((output) => output.kind === 'model3d'), true);

  const minimaxTool = findFalToolboxToolById(manifest, 'minimax-speech-2-8-turbo-fal');
  assert.ok(minimaxTool);
  const pickedSpeech = pickFalToolboxInputs(minimaxTool!, { texts: ['欢迎来到贞贞的无限画布'] });
  assert.deepEqual(pickedSpeech.missing, []);
  const speechPayload = buildFalToolboxRunPayload(minimaxTool!, {
    inputValues: pickedSpeech.values,
    userParamValues: {
      'voice_setting.emotion': 'happy',
      language_boost: 'Chinese',
    },
  });
  assert.equal(speechPayload.endpoint, 'fal-ai/minimax/speech-2.8-turbo');
  assert.equal(speechPayload.payload.prompt, '欢迎来到贞贞的无限画布');
  assert.deepEqual((speechPayload.payload as any).voice_setting, {
    voice_id: 'Wise_Woman',
    speed: 1,
    vol: 1,
    pitch: 0,
    emotion: 'happy',
    english_normalization: false,
  });
  assert.deepEqual((speechPayload.payload as any).audio_setting, {
    sample_rate: 32000,
    bitrate: 128000,
    format: 'mp3',
  });
  assert.equal((speechPayload.payload as any).language_boost, 'Chinese');

  const heygenTool = findFalToolboxToolById(manifest, 'heygen-avatar5-fal');
  assert.ok(heygenTool);
  const heygenPayload = buildFalToolboxRunPayload(heygenTool!, {
    inputValues: { prompt: '镜头前自然介绍产品' },
    userParamValues: {
      avatar: 'server_default',
      voice: 'server_default',
      custom_avatar: 'Ann Doctor Standing',
      custom_voice: 'Ivy',
      caption: true,
    },
  });
  assert.equal(heygenPayload.endpoint, 'fal-ai/heygen/avatar5/digital-twin');
  assert.equal((heygenPayload.payload as any).avatar, 'Ann Doctor Standing');
  assert.equal((heygenPayload.payload as any).voice, 'Ivy');
  assert.equal((heygenPayload.payload as any).custom_avatar, undefined);
  assert.equal((heygenPayload.payload as any).custom_voice, undefined);
  assert.equal((heygenPayload.payload as any).caption, true);
});

test('Zhenzhen FAL tools mirror ComfyUI payload contracts', async () => {
  const { FAL_TOOLBOX_MANIFEST } = await loadFalToolboxManifest();
  const {
    buildFalToolboxRunPayload,
    findFalToolboxToolById,
    normalizeFalToolboxManifest,
  } = await loadFalToolboxUtils();

  const manifest = normalizeFalToolboxManifest(FAL_TOOLBOX_MANIFEST);
  const byId = (id: string) => {
    const found = findFalToolboxToolById(manifest, id);
    assert.ok(found, id);
    return found!;
  };

  const berniniReference = byId('zhenzhen-bernini-r-video-fal');
  const berniniReferencePayload = buildFalToolboxRunPayload(berniniReference, {
    inputValues: {
      prompt: 'cinematic move',
      reference_image_urls: ['/files/input/ref1.png', '/files/input/ref2.png'],
    },
    userParamValues: {
      aspect_ratio: '9:16',
      acceleration: 'regular',
      max_image_size: 848,
      num_frames: 81,
      frames_per_second: 16,
      num_inference_steps: 30,
      enable_prompt_expansion: false,
      seed: 0,
    },
  });
  assert.equal(berniniReferencePayload.endpoint, 'fal-ai/bernini-r/reference-to-video');
  assert.equal(berniniReferencePayload.payload.prompt, 'cinematic move');
  assert.equal(berniniReferencePayload.payload.aspect_ratio, '9:16');
  assert.equal(berniniReferencePayload.payload.seed, undefined);
  assert.deepEqual(berniniReferencePayload.payload.reference_image_urls, ['/files/input/ref1.png', '/files/input/ref2.png']);
  assert.deepEqual(berniniReferencePayload.mediaFields.find((field) => field.key === 'reference_image_urls'), {
    key: 'reference_image_urls',
    kind: 'image',
    multiple: true,
    upload: true,
    mediaMode: 'base64',
  });

  const berniniEditVideo = byId('zhenzhen-bernini-r-edit-video-fal');
  const berniniEditVideoPayload = buildFalToolboxRunPayload(berniniEditVideo, {
    inputValues: { prompt: 'make it cinematic', video_url: '/files/input/source.mp4' },
    userParamValues: { num_frames: 81, seed: 0 },
  });
  assert.equal(berniniEditVideoPayload.endpoint, 'fal-ai/bernini-r/edit-video');
  assert.equal(berniniEditVideoPayload.payload.video_url, '/files/input/source.mp4');
  assert.deepEqual(berniniEditVideoPayload.mediaFields.find((field) => field.key === 'video_url'), {
    key: 'video_url',
    kind: 'video',
    multiple: false,
    upload: true,
    mediaMode: 'url',
  });

  const berniniReferenceEditVideo = byId('zhenzhen-bernini-r-reference-edit-video-fal');
  assert.equal(berniniReferenceEditVideo.endpoint, 'fal-ai/bernini-r/reference-edit-video');

  const berniniEditImage = byId('zhenzhen-bernini-r-edit-image-fal');
  const berniniEditImagePayload = buildFalToolboxRunPayload(berniniEditImage, {
    inputValues: { prompt: 'Make the image more cinematic.', image_url: '/files/input/source.png' },
    userParamValues: { max_image_size: 848, num_inference_steps: 30, seed: 0 },
  });
  assert.equal(berniniEditImagePayload.endpoint, 'fal-ai/bernini-r/edit-image');
  assert.equal(berniniEditImagePayload.payload.image_url, '/files/input/source.png');
  assert.deepEqual(berniniEditImagePayload.mediaFields.find((field) => field.key === 'image_url'), {
    key: 'image_url',
    kind: 'image',
    multiple: false,
    upload: true,
    mediaMode: 'base64',
  });

  const lumaRayText = byId('zhenzhen-luma-ray-v3.2-fal');
  const lumaRayTextPayload = buildFalToolboxRunPayload(lumaRayText, {
    inputValues: { prompt: 'A smooth cinematic camera move.' },
    userParamValues: { duration: '10s', resolution: '1080p', aspect_ratio: '21:9', loop: true },
  });
  assert.equal(lumaRayTextPayload.endpoint, 'luma/agent/ray/v3.2/text-to-video');
  assert.equal(lumaRayTextPayload.payload.duration, '10s');
  assert.equal(lumaRayTextPayload.payload.resolution, '1080p');
  assert.equal(lumaRayTextPayload.payload.aspect_ratio, '21:9');
  assert.equal(lumaRayTextPayload.payload.loop, true);

  const lumaRayImage = byId('zhenzhen-luma-ray-v3.2-image-to-video-fal');
  const lumaRayImagePayload = buildFalToolboxRunPayload(lumaRayImage, {
    inputValues: { prompt: 'Animate the portrait.', image_url: '/files/input/start.png' },
    userParamValues: {
      keyframes_json: '["https://example.com/key.png"]',
      keyframe_indexes_json: '[0]',
    },
  });
  assert.equal(lumaRayImagePayload.endpoint, 'luma/agent/ray/v3.2/image-to-video');
  assert.deepEqual(lumaRayImagePayload.payload.keyframes, ['https://example.com/key.png']);
  assert.deepEqual(lumaRayImagePayload.payload.keyframe_indexes, [0]);

  const lumaUniText = byId('zhenzhen-luma-uni-1-v1-fal');
  const lumaUniTextPayload = buildFalToolboxRunPayload(lumaUniText, {
    inputValues: { prompt: 'A product poster.' },
    userParamValues: { output_format: 'png', style: 'auto', aspect_ratio: 'auto' },
  });
  assert.equal(lumaUniTextPayload.endpoint, 'luma/agent/uni-1/v1/text-to-image');
  assert.equal(lumaUniTextPayload.payload.output_format, 'png');
  assert.equal(lumaUniTextPayload.payload.aspect_ratio, undefined);

  const lumaUniEditMax = byId('zhenzhen-luma-uni-1-v1-edit-max-fal');
  const lumaUniEditMaxPayload = buildFalToolboxRunPayload(lumaUniEditMax, {
    inputValues: { prompt: 'Change lighting.', image_url: '/files/input/edit.png' },
    userParamValues: { output_format: 'jpeg', style: 'manga', aspect_ratio: '16:9' },
  });
  assert.equal(lumaUniEditMaxPayload.endpoint, 'luma/agent/uni-1/v1/max/edit');
  assert.equal(lumaUniEditMaxPayload.payload.image_url, '/files/input/edit.png');
  assert.equal(lumaUniEditMaxPayload.payload.output_format, 'jpeg');

  const briaVideo = byId('zhenzhen-bria-video-background-removal-v3-fal');
  const briaVideoPayload = buildFalToolboxRunPayload(briaVideo, {
    inputValues: { video_url: '/files/input/source.mp4' },
    userParamValues: {
      background_color: 'Black',
      preserve_audio: true,
      output_container_and_codec: 'webm_vp9',
    },
  });
  assert.equal(briaVideoPayload.endpoint, 'bria/video/background-removal/v3');
  assert.equal(briaVideoPayload.payload.background_color, 'Black');
  assert.equal(briaVideoPayload.payload.output_container_and_codec, 'webm_vp9');

  const nemotron = byId('zhenzhen-nemotron-asr-multilingual-fal');
  const nemotronPayload = buildFalToolboxRunPayload(nemotron, {
    inputValues: { audio_url: '/files/input/speech.wav' },
    userParamValues: { language: 'zh-CN', acceleration: 'high' },
  });
  assert.equal(nemotronPayload.endpoint, 'nvidia/nemotron-asr-multilingual/asr');
  assert.equal(nemotronPayload.payload.language, 'zh-CN');
  assert.equal(nemotron.outputSchema.some((output) => output.kind === 'text'), true);

  const briaGenfill = byId('zhenzhen-bria-genfill-v2-fal');
  const briaGenfillPayload = buildFalToolboxRunPayload(briaGenfill, {
    inputValues: {
      instruction: 'A beautiful colorful butterfly',
      image_url: '/files/input/image.png',
      mask_url: '/files/input/mask.png',
    },
    userParamValues: { seed: 5555, steps_num: 30, sync_mode: false },
  });
  assert.equal(briaGenfillPayload.endpoint, 'bria/genfill/v2');
  assert.equal(briaGenfillPayload.payload.instruction, 'A beautiful colorful butterfly');
  assert.equal(briaGenfillPayload.payload.mask_url, '/files/input/mask.png');

  const rayVideoToVideo = byId('zhenzhen-luma-ray-v3.2-video-to-video-fal');
  const rayVideoToVideoPayload = buildFalToolboxRunPayload(rayVideoToVideo, {
    inputValues: { prompt: 'Watercolor animation.', video_url: '/files/input/clip.mp4' },
    userParamValues: {
      auto_controls: false,
      edit_strength: 'flex_1',
      controls_json: '{"motion":"soft"}',
      keyframes_json: '["https://example.com/frame.png"]',
      keyframe_indexes_json: '[12]',
    },
  });
  assert.equal(rayVideoToVideoPayload.endpoint, 'luma/agent/ray/v3.2/video-to-video');
  assert.equal(rayVideoToVideoPayload.payload.edit_strength, 'flex_1');
  assert.deepEqual(rayVideoToVideoPayload.payload.controls, { motion: 'soft' });
  assert.deepEqual(rayVideoToVideoPayload.payload.keyframe_indexes, [12]);

  const pixelcut = byId('zhenzhen-pixelcut-video-background-removal-fal');
  const pixelcutPayload = buildFalToolboxRunPayload(pixelcut, {
    inputValues: { video_url: '/files/input/person.mp4' },
    userParamValues: {
      background: 'custom',
      custom_r: 1,
      custom_g: 2,
      custom_b: 3,
      output_format: 'mp4_h264',
    },
  });
  assert.equal(pixelcutPayload.endpoint, 'pixelcut/video-background-removal');
  assert.equal(pixelcutPayload.payload.background, 'custom');
  assert.deepEqual(pixelcutPayload.payload.background_color, { r: 1, g: 2, b: 3 });

  assert.throws(
    () => buildFalToolboxRunPayload(rayVideoToVideo, {
      inputValues: { prompt: 'bad json', video_url: '/files/input/clip.mp4' },
      userParamValues: { controls_json: '{bad' },
    }),
    /不是有效 JSON/,
  );
});

test('3D model preview supports common FAL model formats', () => {
  const preview = readFileSync(new URL('../src/components/nodes/Model3DPreviewNode.tsx', import.meta.url), 'utf8');
  const output = readFileSync(new URL('../src/components/nodes/OutputNode.tsx', import.meta.url), 'utf8');
  const upload = readFileSync(new URL('../src/components/nodes/UploadNode.tsx', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');

  assert.match(preview, /FBXLoader/);
  assert.match(preview, /OBJLoader/);
  assert.match(preview, /STLLoader/);
  assert.match(preview, /USDLoader/);
  assert.match(preview, /glb\/gltf\/obj\/stl\/fbx\/usdz/);
  assert.match(preview, /toErrorMessage/);
  assert.match(preview, /下载地址/);
  assert.match(preview, /function clearThreeMount/);
  assert.match(preview, /canvas\.parentNode === mount/);
  assert.match(preview, /ref=\{mountRef\} className="absolute inset-0"/);
  assert.doesNotMatch(preview, /while \(mount\.firstChild\) mount\.removeChild\(mount\.firstChild\)/);
  assert.doesNotMatch(preview, /当前内置预览先支持 glb\/gltf/);
  assertProductionNodeSchema('model-3d-preview', {
    label: '3D模型预览',
    category: 'input',
    inputs: ['model3d'],
    outputs: ['image'],
    executable: false,
    description: /glb\/gltf\/obj\/stl\/fbx\/usdz 3D 模型/,
  });
  assert.match(output, /const isModel3DUrl/);
  assert.match(output, /3D模型 \(\{collected\.models\.length\}\)/);
  assert.match(output, /splitOutputCollection\('model3d', collected\.models\)/);
  assert.match(upload, /MODEL_3D_EXT_RE/);
  assert.match(upload, /3D素材上传/);
  assert.match(canvas, /pushMod\(d\.modelUrl\)/);
  assert.match(canvas, /type:\s*'model-3d-preview'/);
  assert.match(canvas, /'model-3d-preview'/);
  assert.match(canvas, /const shouldCollectModelOutputs = t !== 'model-3d-preview'/);
  assert.match(canvas, /snapshot image still needs normal auto output/);
  assert.match(canvas, /if \(shouldCollectModelOutputs\) \{\s*pushMod\(d\.modelUrl\)/);
  assert.doesNotMatch(canvas, /SKIP_TYPES = new Set\(\[[^\]]*'model-3d-preview'/);
  assert.match(canvas, /Clean up bad chains created by older builds/);
  assert.match(canvas, /source\?\.type === 'model-3d-preview'/);
  assert.match(canvas, /target\.id\.startsWith\('model-3d-preview-auto-'\)/);
});

test('Fal toolbox backend is additive and keeps old FAL routes', () => {
  const proxy = readFileSync(new URL('../backend/src/routes/proxy.js', import.meta.url), 'utf8');
  assert.match(proxy, /router\.post\('\/image\/fal\/submit'/);
  assert.match(proxy, /router\.post\('\/video\/fal\/submit'/);
  assert.match(proxy, /router\.post\('\/fal-toolbox\/submit'/);
  assert.match(proxy, /router\.post\('\/fal-toolbox\/query'/);
  assert.match(proxy, /queue\.fal\.run/);
  assert.match(proxy, /ensureDefaultZhenzhenKey\(settings, res, 'Fal超市'\)/);
});

test('Fal toolbox maker is dev-only and guarded from packaged builds', () => {
  const registry = readFileSync(new URL('../src/config/nodeRegistry.ts', import.meta.url), 'utf8');
  const canvas = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
  const ports = readFileSync(new URL('../src/config/portTypes.ts', import.meta.url), 'utf8');
  const postBuild = readFileSync(new URL('../electron/_post_build.cjs', import.meta.url), 'utf8');
  const publicCheck = readFileSync(new URL('../scripts/check-public-clean.cjs', import.meta.url), 'utf8');
  const node = readFileSync(new URL('../src/components/nodes/FalToolboxNode.tsx', import.meta.url), 'utf8');
  const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

  assert.match(registry, /import\.meta\.env\?\.DEV[\s\S]*type:\s*'fal-toolbox-maker'[\s\S]*label:\s*'FAL应用制作工具'/);
  assert.match(canvas, /const FAL_TOOLBOX_MAKER_MODULE = '\.\/nodes\/FalToolboxMakerNode'/);
  assert.match(canvas, /lazyCanvasNode\(\(\) => import\(\/\* @vite-ignore \*\/ FAL_TOOLBOX_MAKER_MODULE\), 'FalToolboxMakerNode'\)/);
  assert.match(canvas, /import\.meta\.env\?\.DEV \? \{ 'fal-toolbox-maker': FalToolboxMakerNode \} : \{\}/);
  assert.match(ports, /import\.meta\.env\?\.DEV[\s\S]*'fal-toolbox-maker':\s*\{\s*inputs:\s*\[\],\s*outputs:\s*\['text'\]\s*\}/);
  assert.match(postBuild, /checkNoFalToolboxMaker/);
  assert.match(postBuild, /FalToolboxMakerNode/);
  assert.match(postBuild, /FAL应用制作工具/);
  assert.match(publicCheck, /src\/components\/nodes\/FalToolboxMakerNode\.tsx/);
  assert.match(publicCheck, /src\/utils\/falToolboxDeveloper\.ts/);
  assert.match(gitignore, /\/src\/components\/nodes\/FalToolboxMakerNode\.tsx/);
  assert.match(gitignore, /\/src\/utils\/falToolboxDeveloper\.ts/);
  assert.match(node, /const FAL_TOOLBOX_DEVELOPER_MODULE = '\.\.\/\.\.\/utils\/falToolboxDeveloper'/);
  assert.match(node, /import\(\/\* @vite-ignore \*\/ FAL_TOOLBOX_DEVELOPER_MODULE\)/);
});
