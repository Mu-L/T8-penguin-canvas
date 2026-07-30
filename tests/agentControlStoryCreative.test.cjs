'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzePatch,
  buildLocalStoryAnalysis,
  buildStoryAudioPlan,
  importPatch,
  splitStoryScriptBlocks,
  storySceneSections,
} = require('../backend/src/services/agentControlStoryCreative.js');

const script = `《唐人街巷战》
Scene：The Alley
【镜头一｜建立环境】
雨夜的悉尼唐人街后巷。
没有人物。
【镜头二｜建立人物】
萌萌独自走出电梯。
她始终直视前方。
【镜头三｜战斗状态】
萌萌脱下黑色西装外套，右手展开战术甩棍。
不要加入其它人物。`;

function document() {
  return {
    projectId: 'project-local',
    canvasId: 'canvas-a',
    revision: 7,
    nodes: [{
      id: 'story-a',
      type: 'story',
      position: { x: 0, y: 0 },
      data: {
        storyProject: {
          storyId: 'story-a',
          storyRevision: 1,
          productionRevision: 0,
          title: '唐人街巷战',
          script,
          settings: {
            targetDurationSec: 24,
            visualStyle: '写实电影感',
          },
          scenes: [],
          shots: [],
          assets: [{
            id: 'locked-hero',
            kind: 'character',
            name: '萌萌',
            description: '用户已确认角色',
            prompt: '用户提示词',
            requiredByShotIds: [],
            source: 'upload',
            status: 'succeeded',
            url: '/api/project-assets/hero/media',
            locked: true,
            revision: 3,
          }],
        },
      },
    }],
    edges: [],
  };
}

test('local Story analyzer preserves shot blocks and hard constraints', () => {
  const blocks = splitStoryScriptBlocks(script);
  assert.equal(blocks.length, 3);
  const analysis = buildLocalStoryAnalysis(document().nodes[0].data.storyProject);
  assert.equal(analysis.schema, 't8-story-analysis-v1');
  assert.equal(analysis.shots.length, 3);
  assert.ok(analysis.shots[0].mustNotInclude.some((item) => item.includes('没有人物')));
  assert.ok(analysis.shots[2].mustNotInclude.some((item) => item.includes('不要加入其它人物')));
  assert.ok(analysis.assets.some((asset) => asset.kind === 'character' && asset.name === '萌萌'));
  const costume = analysis.assets.find((asset) => asset.kind === 'costume');
  assert.ok(costume);
  assert.match(costume.prompt, /不出现人物/);
  assert.equal(analysis.audioPlan.schema, 't8-story-audio-plan-v1');
  assert.equal(analysis.audioPlan.items.some((item) => item.role === 'ambience' || item.role === 'sfx'), false);
  assert.equal(analysis.audioPlan.lipSync.supported, true);
  assert.equal(analysis.audioPlan.lipSync.model, 'creatify-aurora-fal');
});

test('local Story analyzer separates multiple scenes, binds scene assets locally, and keeps stable shot IDs', () => {
  const multiSceneScript = `《双城追逐》
Scene：Rain Alley
【镜头一｜雨巷建立】
女主穿过雨夜后巷。
【镜头二｜发现线索】
她在霓虹灯下捡起一封信。
场景二｜Rooftop Dawn
【镜头三｜天台对峙】
清晨天台，女主与对手隔着水塔对视。`;
  const first = buildLocalStoryAnalysis({
    ...document().nodes[0].data.storyProject,
    script: multiSceneScript,
  });
  assert.deepEqual(first.scenes.map((scene) => scene.title), ['Rain Alley', 'Rooftop Dawn']);
  assert.equal(new Set(first.shots.map((shot) => shot.sceneId)).size, 2);
  assert.equal(first.shots[0].sceneId, first.shots[1].sceneId);
  assert.notEqual(first.shots[1].sceneId, first.shots[2].sceneId);
  const sceneAssets = first.assets.filter((asset) => asset.kind === 'scene');
  assert.equal(sceneAssets.length, 2);
  assert.deepEqual(sceneAssets[0].requiredByShotIds, first.shots.slice(0, 2).map((shot) => shot.id));
  assert.deepEqual(sceneAssets[1].requiredByShotIds, [first.shots[2].id]);

  const sections = storySceneSections(multiSceneScript);
  assert.equal(sections.length, 2);
  assert.ok(sections.every((scene) => scene.sourceSpan.end > scene.sourceSpan.start));

  const withAddedPreamble = buildLocalStoryAnalysis({
    ...document().nodes[0].data.storyProject,
    script: `故事梗概：一封信把两人引向天台。\n${multiSceneScript}`,
  });
  assert.deepEqual(
    withAddedPreamble.shots.map((shot) => shot.id),
    first.shots.map((shot) => shot.id),
  );
});

test('analyze patch keeps uploaded or locked assets and never starts generation', () => {
  const result = analyzePatch(document(), 'plan-a', { storyId: 'story-a' });
  assert.equal(result.schema, 't8-canvas-patch-v1');
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].type, 'node.patch');
  const project = result.operations[0].payload.dataPatch.storyProject;
  const hero = project.assets.find((asset) => asset.name === '萌萌');
  assert.equal(hero.id, 'locked-hero');
  assert.equal(hero.url, '/api/project-assets/hero/media');
  assert.equal(hero.locked, true);
  assert.equal(project.analysisSource, 'local-fallback');
  assert.equal(project.audioPlan.schema, 't8-story-audio-plan-v1');
});

test('Story re-analysis invalidates only changed shots and preserves completed, uploaded, accepted, or locked work', () => {
  const current = document();
  current.nodes[0].data.storyProject.shots = [{
    id: 'shot-1',
    sceneId: '',
    title: '建立环境',
    sourceSpan: { start: 0, end: 8, text: '雨夜后巷。' },
    sourceText: '雨夜后巷。',
    durationSec: 6,
    visualDescription: '雨夜后巷。',
    action: '',
    dialogue: '',
    voiceover: '',
    sfx: '',
    camera: '稳定电影镜头，主体清晰',
    lighting: '',
    mustInclude: [],
    mustNotInclude: [],
    entityRefs: [],
    assetIds: [],
    finalPrompt: '已确认的环境提示词',
    negativePrompt: '不要人物',
    status: 'succeeded',
    videoUrl: '/outputs/shot-1.mp4',
    taskId: 'task-shot-1',
    taskProvider: 'zhenzhen',
    taskModel: 'seedance',
    error: '',
    lockedFields: [],
    revision: 4,
  }, {
    id: 'shot-2',
    sceneId: '',
    title: '建立人物',
    sourceSpan: { start: 9, end: 20, text: '萌萌走出电梯。' },
    sourceText: '萌萌走出电梯。',
    durationSec: 6,
    visualDescription: '萌萌走出电梯。',
    action: '',
    dialogue: '',
    voiceover: '',
    sfx: '',
    camera: '稳定电影镜头，主体清晰',
    lighting: '',
    mustInclude: [],
    mustNotInclude: [],
    entityRefs: ['萌萌'],
    assetIds: ['locked-hero'],
    finalPrompt: '已完成的人物提示词',
    negativePrompt: '',
    status: 'succeeded',
    videoUrl: '/outputs/shot-2.mp4',
    taskId: 'task-shot-2',
    taskProvider: 'zhenzhen',
    taskModel: 'seedance',
    error: '',
    lockedFields: [],
    revision: 2,
  }];
  const result = importPatch(current, 'plan-revise', {
    storyId: 'story-a',
    payload: {
      shots: [{
        id: 'shot-1',
        title: '建立环境',
        sourceText: '雨夜后巷。',
        sourceSpan: { start: 0, end: 8, text: '雨夜后巷。' },
        durationSec: 6,
        visualDescription: '雨夜后巷。',
      }, {
        id: 'shot-2',
        title: '建立人物',
        sourceText: '萌萌走出电梯。',
        sourceSpan: { start: 9, end: 20, text: '萌萌走出电梯。' },
        durationSec: 6,
        visualDescription: '萌萌快步走出电梯。',
        entityRefs: ['萌萌'],
        assetIds: ['locked-hero'],
      }],
      assets: [{
        id: 'locked-hero',
        kind: 'character',
        name: '萌萌',
        description: '新的自动分析描述不能覆盖用户素材',
      }],
    },
  });
  const project = result.operations[0].payload.dataPatch.storyProject;
  const unchanged = project.shots.find((shot) => shot.id === 'shot-1');
  const changed = project.shots.find((shot) => shot.id === 'shot-2');
  assert.equal(unchanged.status, 'succeeded');
  assert.equal(unchanged.videoUrl, '/outputs/shot-1.mp4');
  assert.equal(unchanged.finalPrompt, '已确认的环境提示词');
  assert.equal(unchanged.revision, 4);
  assert.equal(changed.status, 'pending');
  assert.equal(changed.videoUrl, '');
  assert.equal(changed.taskId, '');
  assert.equal(changed.revision, 3);
  const hero = project.assets.find((asset) => asset.id === 'locked-hero');
  assert.equal(hero.url, '/api/project-assets/hero/media');
  assert.equal(hero.locked, true);
  assert.equal(hero.status, 'succeeded');
});

test('Story audio planning keeps dialogue, ambience and SFX as separate editable layers', () => {
  const plan = buildStoryAudioPlan([{
    id: 'shot-1',
    dialogue: '别回头。',
    voiceover: '',
    sfx: '雨声与远处警笛',
  }, {
    id: 'shot-2',
    dialogue: '',
    voiceover: '她终于看见清晨。',
    sfx: '金属刀刃碰撞声',
  }], {
    audioProviderSource: 'zhenzhen',
    audioModel: 'doubao-seed-audio-1.0',
    audioOutputFormat: 'wav',
    audioSampleRate: 24_000,
  });
  assert.deepEqual(new Set(plan.items.map((item) => item.role)), new Set([
    'dialogue',
    'ambience',
    'voiceover',
    'sfx',
  ]));
  assert.equal(plan.items.every((item) => item.licenseStatus === 'unknown'), true);
  assert.equal(plan.items
    .filter((item) => item.role === 'dialogue' || item.role === 'voiceover')
    .every((item) => item.provider === 'grok-oauth'
      && item.model === 'xai-tts'
      && item.requires.includes('grok-oauth-login')), true);
  assert.equal(plan.items
    .filter((item) => item.role === 'ambience' || item.role === 'sfx')
    .every((item) => item.provider === 'zhenzhen'
      && item.model === 'doubao-seed-audio-1.0'), true);
  assert.equal(plan.mix.requiresCreatorReview, true);
  assert.equal(plan.lipSync.supported, true);
  assert.equal(plan.lipSync.provider, 'fal');
  assert.equal(plan.lipSync.model, 'creatify-aurora-fal');
  assert.deepEqual(plan.lipSync.requiredAssetKinds, ['image', 'audio']);
  assert.equal(plan.lipSync.requiresRunApproval, true);
});
