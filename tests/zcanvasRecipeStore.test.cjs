'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RecipeStoreError,
  exportRecipe,
  findRecipe,
  importRecipe,
  listRecipes,
  pinRecipe,
  rollbackRecipe,
  saveRecipe,
  verifyProjectRecipes,
} = require('../tools/zcanvas-cli/src/recipeStore.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-recipes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    env: { ZCANVAS_RECIPE_STORE: path.join(root, 'recipes.json') },
    signingSecret: 'test-recipe-signing-secret',
    now: () => '2026-07-24T12:00:00.000Z',
  };
}

function definition(style) {
  return {
    schema: 't8-creator-recipe-v1',
    id: 'rain-director',
    label: '雨夜导演配方',
    kind: 'story',
    defaults: {
      duration: 30,
      ratio: '9:16',
      profile: 'quality',
      template: 'storyboard',
      locks: ['identity', 'wardrobe', 'scene'],
      llmModel: 'gemini-3.5-flash',
      imageModel: 'zhenzhen-image-g2-t2i',
      videoModel: 'doubao-seedance-2-0-fast-260128',
    },
    guidance: {
      directorStyle: style,
      characterBible: '女主身份和发型固定',
      shotGrammar: '先建立环境，再推进人物动作',
    },
    stages: ['剧本分析', '确认镜头', '准备资产', '生成视频', '成片导出'],
    reviewDimensions: ['人物一致性', '动作连续性', '叙事清晰度'],
  };
}

test('project recipes are versioned, signed, pinned and rollback-safe', (t) => {
  const options = fixture(t);
  const first = saveRecipe('project-local', 'rain-director', definition('冷峻雨夜'), options);
  const second = saveRecipe('project-local', 'rain-director', definition('冷峻雨夜，高反差霓虹'), options);
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(findRecipe('project-local', 'rain-director', undefined, options).version, 2);
  assert.equal(listRecipes('project-local', options)[0].verified, true);
  assert.equal(pinRecipe('project-local', 'rain-director', 1, options).version, 1);
  assert.equal(pinRecipe('project-local', 'rain-director', 2, options).version, 2);
  assert.equal(rollbackRecipe('project-local', 'rain-director', options).version, 1);
  assert.equal(verifyProjectRecipes('project-local', options).valid, true);
});

test('recipe export/import preserves content digest and re-signs the explicit project import', (t) => {
  const options = fixture(t);
  saveRecipe('project-a', 'rain-director', definition('电影感雨夜'), options);
  const target = path.join(options.root, 'rain-director.json');
  const exported = exportRecipe('project-a', 'rain-director', target, options);
  assert.match(exported.contentDigest, /^[a-f0-9]{64}$/);
  const imported = importRecipe('project-b', target, options);
  assert.equal(imported.sourceSignatureVerified, true);
  assert.equal(imported.trust, 'same-signing-identity');
  assert.equal(findRecipe('project-b', 'rain-director', 1, options).verified, true);
});

test('recipe store fails closed after a signed definition is changed on disk', (t) => {
  const options = fixture(t);
  saveRecipe('project-local', 'rain-director', definition('原始风格'), options);
  const filename = options.env.ZCANVAS_RECIPE_STORE;
  const store = JSON.parse(fs.readFileSync(filename, 'utf8'));
  store.projects['project-local'].recipes['rain-director'].versions[0].definition.guidance.directorStyle = '被篡改';
  fs.writeFileSync(filename, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  assert.throws(
    () => findRecipe('project-local', 'rain-director', 1, options),
    (error) => error instanceof RecipeStoreError && error.code === 'RECIPE_SIGNATURE_INVALID',
  );
});
