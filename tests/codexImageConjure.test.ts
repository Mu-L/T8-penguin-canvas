import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CODEX_IMAGE_CONJURE_PROMPT_SCHEMA,
  DEFAULT_CODEX_IMAGE_SNIPPETS,
  DEFAULT_CODEX_IMAGE_TEMPLATE_CATEGORIES,
  buildCodexImageConjurePrompt,
  createCodexImageConjureTask,
  deleteCodexImageSnippet,
  deleteCodexImageTemplate,
  enqueueCodexImageConjureTasks,
  expandCodexImagePromptSnippets,
  exportCodexImagePromptPack,
  importCodexImagePromptPack,
  normalizeCodexImagePromptState,
  trimCodexImageConjureHistory,
  updateCodexImageConjureTask,
  upsertCodexImageSnippet,
  upsertCodexImageTemplate,
} from '../src/utils/codexImageConjure.ts';
import { publishCodexImageConjureResult } from '../src/services/codexImageConjure.ts';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

test('Codex image conjure node is registered as a focused Codex image generator', () => {
  const types = read('../src/types/canvas.ts');
  const registry = read('../src/config/nodeRegistry.ts');
  const canvas = read('../src/components/Canvas.tsx');
  const sidebar = read('../src/components/Sidebar.tsx');
  const placement = read('../src/utils/nodePlacement.ts');
  const features = read('../features.json');

  assert.match(types, /'codex-image-conjure'/);
  assertProductionNodeSchema('codex-image-conjure', {
    label: 'Codex 生图工作台',
    category: 'codex',
    inputs: ['text', 'image'],
    outputs: ['image', 'text'],
    executable: true,
  });
  assert.match(registry, /codex:\s*\{\s*label:\s*'CODEX CLI'/);
  assert.match(canvas, /CodexImageConjureNode/);
  assert.match(canvas, /import\('\.\/nodes\/CodexImageConjureNode'\)/);
  assert.match(canvas, /'codex-image-conjure': CodexImageConjureNode/);
  assert.match(canvas, /'codex-image-conjure':\s*\{[\s\S]*codexConjureMaterialOrder:\s*\[\]/);
  assert.match(canvas, /'codex-image-conjure':\s*\{[\s\S]*codexConjureExcludedMaterialIds:\s*\[\]/);
  assert.match(sidebar, /'codex-image-conjure': 'ImagePlus'/);
  assert.match(placement, /'codex-image-conjure':\s*\{\s*w:\s*520,\s*h:\s*680\s*\}/);
  assert.match(features, /codexImageConjureNode/);
});

test('Codex image conjure keeps ilab prompt templates and snippets in an independent pack', () => {
  assert.equal(CODEX_IMAGE_CONJURE_PROMPT_SCHEMA, 't8-codex-image-conjure-prompts');
  assert.ok(DEFAULT_CODEX_IMAGE_TEMPLATE_CATEGORIES.some((item) => item.id === '人像'));
  assert.ok(DEFAULT_CODEX_IMAGE_TEMPLATE_CATEGORIES.some((item) => item.id === '电商'));
  assert.ok(DEFAULT_CODEX_IMAGE_SNIPPETS.some((item) => item.tag === 'cinematic'));

  const imported = importCodexImagePromptPack({
    format: 'webui-prompt-template-pack',
    categories: [{ id: '海报', name: '海报', order: 50 }],
    templates: [
      {
        title: '夏日人像',
        short_title: '夏日',
        content: 'bright sunlight portrait, soft bokeh',
        category: '人像',
        tags: ['portrait', 'sunlight'],
        mode: 'text_to_image',
        model_hint: 'gpt-image-2',
      },
    ],
    snippets: [
      { tag: '~gold', title: '金色光线', content: 'golden hour rim light', category: '光影', order: 20 },
    ],
  });

  assert.equal(imported.templates.length, 1);
  assert.equal(imported.templates[0].category, '人像');
  assert.equal(imported.snippets.some((item) => item.tag === 'gold'), true);
  assert.equal(expandCodexImagePromptSnippets('portrait ~gold', imported.snippets), 'portrait golden hour rim light');

  const backup = exportCodexImagePromptPack(imported);
  assert.equal(backup.schema, CODEX_IMAGE_CONJURE_PROMPT_SCHEMA);
  assert.equal(backup.templates.length, 1);
  assert.equal(backup.snippets.length >= 1, true);

  const normalized = normalizeCodexImagePromptState({ templates: [{ title: 'bad' }], snippets: [{ tag: 'x' }] });
  assert.equal(normalized.templates.length, 0);
  assert.equal(normalized.categories.some((item) => item.id === '常用'), true);
});

test('Codex image conjure frontend only uses Codex CLI image generation and resource-library gallery hooks', () => {
  const node = read('../src/components/nodes/CodexImageConjureNode.tsx');
  const service = read('../src/services/codexImageConjure.ts');

  assert.match(node, /data-codex-image-conjure-root/);
  assert.match(node, /data-codex-image-conjure-drag-surface/);
  assert.match(node, /data-codex-image-conjure-body/);
  assert.match(node, /nowheel/);
  assert.match(node, /onWheelCapture=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.doesNotMatch(node, /data-codex-image-conjure-root className="nodrag/);
  assert.match(node, /Codex 生图工作台/);
  assert.match(node, /提示词模板/);
  assert.match(node, /片段/);
  assert.match(node, /公共图库/);
  assert.match(node, /任务队列/);
  assert.match(node, /历史/);
  assert.match(node, /并发/);
  assert.match(node, /数量/);
  assert.match(node, /自动发布/);
  assert.match(node, /提示词持久化/);
  assert.match(node, /素材持久化/);
  assert.match(node, /startCodexCliLogin/);
  assert.match(node, /正在打开 Codex 登录窗口/);
  assert.match(node, /CODEX_LOGIN_FLOW_STEPS/);
  assert.match(node, /copyCodexSetupCommand/);
  assert.match(node, /登录 Codex CLI/);
  assert.match(node, /打开登录/);
  assert.match(node, /复制登录命令/);
  assert.match(node, /普通 CMD 或 PowerShell/);
  assert.match(node, /登录流程/);
  assert.match(node, /复制安装/);
  assert.match(node, /codexExecutablePath/);
  assert.match(node, /模板工坊/);
  assert.match(node, /片段工坊/);
  assert.match(node, /重命名/);
  assert.match(node, /删除/);
  assert.match(node, /加入参考/);
  assert.match(node, /移除参考/);
  assert.doesNotMatch(node, /发送画布/);
  assert.doesNotMatch(node, /继续改/);
  assert.doesNotMatch(node, /<Send/);
  assert.doesNotMatch(node, /<Wand2/);
  assert.doesNotMatch(node, /<Repeat/);
  assert.doesNotMatch(node, /publishResult/);
  assert.match(node, /变体/);
  assert.match(node, /codexConjureTasks/);
  assert.match(node, /runQueue/);
  assert.match(node, /createCanvasNodeRunRequestId\(id, 'codex-queue'\)/);
  assert.match(node, /codexConjureRunMode: 'queue'[\s\S]*codexConjureRunRequestId: requestId/);
  assert.match(node, /requestCanvasNodeRun\(id, \{ requestId \}\)/);
  assert.match(node, /const persistedRequestId = String\(liveData\?\.codexConjureRunRequestId[\s\S]*contextRequestId !== persistedRequestId[\s\S]*requestedMode !== 'queue'[\s\S]*runQueue\(reporter\)/);
  assert.match(node, /latestData\?\.codexConjureRunRequestId === contextRequestId[\s\S]*codexConjureRunRequestId: ''/);
  assert.match(node, /update\(\{ status: 'error', error: message \}\);[\s\S]*throw new Error\(message\)/);
  assert.match(node, /useRunTrigger\(id,[\s\S]*\{ lifecycleAware: true \}\)/);
  assert.match(node, /reporter\?\.providerRequest\([\s\S]*provider: 'codex-cli'/);
  assert.match(node, /reporter\?\.providerResponse\([\s\S]*provider: 'codex-cli'/);
  assert.doesNotMatch(node, /onClick=\{\(\) => void runQueue\(\)\}/,
    'queue buttons must not invoke Codex generation outside the Canvas Run pipeline');
  assert.match(node, /导入/);
  assert.match(node, /导出/);
  assert.match(node, /MentionPromptInput/);
  assert.match(node, /MaterialPreviewSection/);
  assert.match(node, /data-codex-image-conjure-input-materials="true"/);
  assert.match(node, /const visibleUpstreamImages = useMemo\([\s\S]*filterExcludedMaterials\(upstream\.images, excludedMaterialIds\)/);
  assert.match(node, /const orderedInputImages = useOrderedMaterials\(inputImageMaterials, materialOrder\)/);
  assert.match(node, /codexConjureExcludedMaterialIds: excludeMaterialId\(excludedMaterialIds, material\.id\)/);
  assert.match(node, /codexConjureGalleryRefs: galleryRefs\.filter\(\(url\) => url !== material\.url\)/);
  assert.match(node, /const imageRefs = unique\(\[[\s\S]*\.\.\.orderedInputImages\.map\(\(item\) => item\.url\)/);
  assert.doesNotMatch(node, /const imageRefs = unique\(\[[\s\S]*\.\.\.upstream\.images\.map/);
  assert.match(node, /streamCodexImageConjure/);
  assert.match(node, /getResourceItems/);
  assert.match(node, /publishCodexImageConjureResult/);
  assert.doesNotMatch(node, /renderArtifactPreview\(latestArtifact\)/);
  assert.doesNotMatch(node, /openai-compatible|apiProvider|api_mode|api_provider/i);

  assert.match(service, /streamCodexCliAgent/);
  assert.match(service, /imageGeneration:\s*true/);
  assert.match(service, /selectedSkillNames:\s*\[/);
  assert.match(service, /imagegen/);
  assert.match(service, /throw new Error\('Codex 没有返回图片产物/);
  assert.doesNotMatch(service, /openai-compatible|apiProvider|api_mode|api_provider/i);
});

test('Codex image conjure publishes only requested images to canvas output without explanation text', () => {
  const published = publishCodexImageConjureResult({
    imageUrls: ['a.png', 'b.png'],
    imageUrl: 'c.png',
    text: 'Codex explanation that should stay out of canvas auto output',
  } as any, { maxImages: 1, includeText: false });

  assert.equal(published.imageUrl, 'a.png');
  assert.deepEqual(published.imageUrls, ['a.png']);
  assert.equal(published.outputText, '');
});

test('Codex image conjure manages editable templates, snippets, prompts, and queued tasks', () => {
  const base = normalizeCodexImagePromptState({});
  const withTemplate = upsertCodexImageTemplate(base, {
    title: '小红书商品图',
    shortTitle: '商品图',
    content: 'Create a clean product image for {product}',
    category: '电商',
    tags: ['shop'],
    mode: 'text_to_image',
    modelHint: 'gpt-image-2',
  });
  assert.equal(withTemplate.templates.some((item) => item.title === '小红书商品图'), true);

  const template = withTemplate.templates.find((item) => item.title === '小红书商品图');
  assert.ok(template);
  const renamedTemplateState = upsertCodexImageTemplate(withTemplate, {
    ...template,
    title: '小红书商品主图',
  });
  assert.equal(renamedTemplateState.templates.some((item) => item.title === '小红书商品主图'), true);
  assert.equal(deleteCodexImageTemplate(renamedTemplateState, template.id).templates.some((item) => item.id === template.id), false);

  const withSnippet = upsertCodexImageSnippet(base, {
    tag: 'gold',
    title: '金色光线',
    content: 'golden hour rim light',
    category: '光影',
  });
  assert.equal(expandCodexImagePromptSnippets('portrait ~gold', withSnippet.snippets), 'portrait golden hour rim light');
  assert.equal(deleteCodexImageSnippet(withSnippet, 'gold').snippets.some((item) => item.tag === 'gold'), false);
  assert.equal(deleteCodexImageSnippet(base, 'cinematic').snippets.some((item) => item.tag === 'cinematic'), false);

  const prompt = buildCodexImageConjurePrompt({
    upstreamTexts: ['品牌 brief: 轻奢护肤品'],
    templateNotes: '适合电商主图',
    prompt: '商品海报 ~gold',
    snippets: withSnippet.snippets,
    negativePrompt: 'no watermark',
    outputSettings: {
      model: 'gpt-5.5',
      size: '2K',
      aspectRatio: '4:5',
      quality: '高',
      count: 2,
    },
  });
  assert.match(prompt, /品牌 brief/);
  assert.match(prompt, /golden hour rim light/);
  assert.match(prompt, /Negative prompt: no watermark/);
  assert.match(prompt, /输出设置/);

  const task = createCodexImageConjureTask({
    prompt,
    images: ['local-a.png'],
    model: 'gpt-5.5',
    size: '2K',
    aspectRatio: '4:5',
    quality: '高',
    count: 1,
  });
  assert.equal(task.status, 'queued');
  assert.equal(task.images.length, 1);

  const queued = enqueueCodexImageConjureTasks([], task, 3);
  assert.equal(queued.length, 3);
  assert.equal(queued[2].queueIndex, 3);
  const running = updateCodexImageConjureTask(queued, queued[0].id, { status: 'running', progressText: 'working' });
  assert.equal(running[0].status, 'running');
  assert.equal(running[0].progressText, 'working');

  const trimmed = trimCodexImageConjureHistory(
    running.map((item, index) => ({ ...item, status: index === 0 ? 'running' : 'completed' })),
    1,
  );
  assert.equal(trimmed.some((item) => item.status === 'running'), true);
  assert.equal(trimmed.filter((item) => item.status === 'completed').length, 1);
});
