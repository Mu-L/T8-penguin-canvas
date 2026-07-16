import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  ARTIST_STYLE_MASTER_EXPORT_SCHEMA,
  ARTIST_STYLE_MASTER_STORAGE_KEY,
  buildArtistStyleOutputPayload,
  buildArtistStylePrompt,
  createArtistStyleFromMaterial,
  createArtistStyleExport,
  importArtistStyleExport,
  normalizeArtistStyleItem,
  searchArtistStyles,
  upsertArtistStyleInLibrary,
} from '../src/utils/artistStyleMaster.ts';
import { ARTIST_STYLE_MASTER_ITEMS } from '../src/data/artistStyleMasterManifest.ts';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

test('artist style master is registered in the Inspiration category', () => {
  const types = read('../src/types/canvas.ts');
  const registry = read('../src/config/nodeRegistry.ts');
  const canvas = read('../src/components/Canvas.tsx');
  const node = read('../src/components/nodes/ArtistStyleMasterNode.tsx');
  const sidebar = read('../src/components/Sidebar.tsx');
  const placement = read('../src/utils/nodePlacement.ts');
  const features = read('../features.json');

  assert.match(types, /'artist-style-master'/);
  assert.match(types, /'inspiration'/);
  assertProductionNodeSchema('artist-style-master', {
    label: '艺术风格大师',
    category: 'inspiration',
    inputs: ['text'],
    outputs: ['text', 'image'],
    executable: true,
  });
  assert.match(registry, /inspiration:\s*\{\s*label:\s*'灵感之源'/);
  assert.match(canvas, /ArtistStyleMasterNode/);
  assert.match(canvas, /import\('\.\/nodes\/ArtistStyleMasterNode'\)/);
  assert.match(canvas, /'artist-style-master': ArtistStyleMasterNode/);
  assert.match(node, /import \{ requestCanvasNodeRun \} from '\.\.\/\.\.\/utils\/canvasRunRequest';/);
  assert.equal(node.match(/requestCanvasNodeRun\(id\)/g)?.length, 1);
  assert.match(node, /onClick=\{\(\) => requestArtistStyleRun\('prompt'\)\}/);
  assert.match(node, /onClick=\{\(\) => requestArtistStyleRun\('image'\)\}/);
  assert.match(node, /artistStyleOutputMode: mode,[\s\S]*?requestCanvasNodeRun\(id\);/);
  assert.match(node, /liveData\?\.artistStyleOutputMode === 'image'[\s\S]*?runArtistStyleOutput\(mode\)/);
  assert.doesNotMatch(node, /void runArtistStyleOutput\(/);
  assert.match(sidebar, /'artist-style-master': 'Palette'/);
  assert.match(placement, /'artist-style-master':\s*\{\s*w:\s*480,\s*h:\s*620\s*\}/);
  assert.match(features, /artistStyleMasterNode/);
  assert.match(features, /"label":\s*"灵感之源"/);
});

test('artist style manifest migrates qiaomu styles and local thumbnails', () => {
  assert.ok(ARTIST_STYLE_MASTER_ITEMS.length >= 300);

  const mucha = ARTIST_STYLE_MASTER_ITEMS.find((item) => item.id === 'alphonse-mucha');
  assert.ok(mucha);
  assert.equal(mucha.name, 'Alphonse Mucha');
  assert.equal(mucha.chineseName, '阿尔丰斯·穆夏');
  assert.equal(mucha.movement, 'Art Nouveau');
  assert.match(mucha.imageUrl, /\/artist-style-master\/generated\/alphonse-mucha\.webp$/);
  assert.match(mucha.thumbnailUrl, /\/artist-style-master\/generated\/thumbs\/alphonse-mucha\.webp$/);

  const generatedDir = new URL('../public/artist-style-master/generated/', import.meta.url);
  const thumbsDir = new URL('../public/artist-style-master/generated/thumbs/', import.meta.url);
  assert.equal(existsSync(new URL('alphonse-mucha.webp', generatedDir)), true);
  assert.equal(existsSync(new URL('alphonse-mucha.webp', thumbsDir)), true);
  assert.ok(readdirSync(generatedDir).filter((name) => name.endsWith('.webp')).length >= 300);
  assert.ok(readdirSync(thumbsDir).filter((name) => name.endsWith('.webp')).length >= 300);
});

test('artist style search, prompt output and import/export are deterministic', () => {
  assert.equal(ARTIST_STYLE_MASTER_STORAGE_KEY, 't8-artist-style-master:user-library:v1');
  assert.equal(ARTIST_STYLE_MASTER_EXPORT_SCHEMA, 't8-artist-style-master@1');

  const matches = searchArtistStyles(ARTIST_STYLE_MASTER_ITEMS, {
    query: 'mucha 装饰 海报',
    movement: 'Art Nouveau',
  });
  assert.ok(matches.some((item) => item.id === 'alphonse-mucha'));

  const mucha = matches.find((item) => item.id === 'alphonse-mucha')!;
  const prompt = buildArtistStylePrompt(mucha);
  assert.match(prompt, /装饰线条/);
  assert.match(prompt, /Use this as a visual style reference/);
  assert.equal(prompt.includes('\n'), false);
  assert.doesNotMatch(prompt, /Artist style reference|Movement:|Visual cue:|Style tags:/);
  assert.equal(prompt, `${mucha.chineseName}，${mucha.cue}, Use this as a visual style reference: composition language, line quality, color palette, lighting, texture, mood and design rhythm.`);

  const textPayload = buildArtistStyleOutputPayload(mucha, 'prompt');
  assert.equal(textPayload.kind, 'text');
  assert.equal(textPayload.data.directOutputText, prompt);
  assert.equal(textPayload.data.directImageUrl, undefined);

  const imagePayload = buildArtistStyleOutputPayload(mucha, 'image');
  assert.equal(imagePayload.kind, 'image');
  assert.match(imagePayload.data.directImageUrl, /alphonse-mucha\.webp$/);
  assert.deepEqual(imagePayload.data.directImageUrls, [mucha.imageUrl]);
  assert.deepEqual(imagePayload.data.imageUrls, [mucha.imageUrl]);
  assert.equal(imagePayload.data.directOutputText, prompt);

  const custom = normalizeArtistStyleItem({
    name: 'Studio Test',
    chineseName: '工作室测试',
    movement: 'User',
    movementZh: '自定义',
    category: '我的收藏',
    categoryZh: '我的收藏',
    cue: 'clean composition, practical reference',
    imageUrl: '/custom/test.webp',
    tags: ['poster', 'layout'],
  });
  const exported = createArtistStyleExport({
    categories: [{ id: 'my-style', name: '我的收藏' }],
    styles: [custom],
  });
  assert.equal(exported.schema, ARTIST_STYLE_MASTER_EXPORT_SCHEMA);
  const imported = importArtistStyleExport(exported);
  assert.equal(imported.styles.length, 1);
  assert.equal(imported.categories[0].name, '我的收藏');
});

test('artist style custom library supports editing saved styles in place', () => {
  const original = normalizeArtistStyleItem({
    id: 'custom-poster-style',
    name: 'Custom Poster',
    chineseName: '自定义海报',
    category: 'poster',
    categoryZh: '海报',
    cue: 'initial cue',
    imageUrl: '/custom/poster.webp',
    tags: ['poster'],
  });
  const edited = normalizeArtistStyleItem({
    ...original,
    chineseName: '自定义商业海报',
    category: 'commerce',
    categoryZh: '商业海报',
    cue: 'clean ecommerce layout, strong readable headline',
    tags: ['poster', 'ecommerce'],
  });

  const library = upsertArtistStyleInLibrary(
    { categories: [{ id: 'poster', name: '海报' }], styles: [original] },
    edited,
    { id: edited.category, name: edited.categoryZh },
  );

  assert.equal(library.styles.length, 1);
  assert.equal(library.styles[0].id, 'custom-poster-style');
  assert.equal(library.styles[0].chineseName, '自定义商业海报');
  assert.equal(library.styles[0].category, 'commerce');
  assert.equal(library.styles[0].cue, 'clean ecommerce layout, strong readable headline');
  assert.ok(library.categories.some((item) => item.id === 'poster'));
  assert.ok(library.categories.some((item) => item.id === 'commerce'));
});

test('image materials can be converted into confirmed custom artist styles', () => {
  const style = createArtistStyleFromMaterial({
    imageUrl: '/files/output/poster.png',
    title: 'neo-cinema-poster.png',
    prompt: 'neon poster lighting, dramatic composition',
    negativePrompt: 'blur, low quality',
    categoryZh: '素材收藏',
    tags: ['right-click', 'poster'],
  });

  assert.equal(style.imageUrl, '/files/output/poster.png');
  assert.equal(style.thumbnailUrl, '/files/output/poster.png');
  assert.equal(style.name, 'neo-cinema-poster');
  assert.equal(style.chineseName, 'neo-cinema-poster');
  assert.equal(style.categoryZh, '素材收藏');
  assert.equal(style.userCreated, true);
  assert.ok(style.tags.includes('right-click'));
  assert.match(style.cue, /neon poster lighting/);
  assert.match(style.cue, /Negative prompt: blur, low quality/);
  assert.match(buildArtistStylePrompt(style), /neon poster lighting/);
});

test('material context menu can save image materials to artist style master', () => {
  const contextMenu = read('../src/components/MaterialContextMenu.tsx');
  const uploadNode = read('../src/components/nodes/UploadNode.tsx');
  const outputNode = read('../src/components/nodes/OutputNode.tsx');
  const artistNode = read('../src/components/nodes/ArtistStyleMasterNode.tsx');

  assert.match(contextMenu, /保存风格到艺术风格大师/);
  assert.match(contextMenu, /openArtistStyleSaveDialog/);
  assert.match(contextMenu, /createArtistStyleFromMaterial/);
  assert.match(contextMenu, /menu\.kind !== 'image'/);
  assert.match(contextMenu, /penguin:artist-style-master-changed/);
  assert.match(contextMenu, /请确认或修改风格提示词/);
  assert.match(contextMenu, /自动获取提示词/);
  assert.match(uploadNode, /data-drag-kind="image"/);
  assert.match(outputNode, /data-prompt-template-prompt=\{mediaPromptByUrl\.get\(u\)\?\.prompt \|\| displayText\}/);
  assert.match(artistNode, /penguin:artist-style-master-changed/);
});

test('artist style master frontend keeps gallery and theme readability hooks', () => {
  const node = read('../src/components/nodes/ArtistStyleMasterNode.tsx');
  const styles = read('../src/styles/index.css');

  assert.match(node, /data-artist-style-master-root/);
  assert.match(node, /data-artist-style-master-drag-surface/);
  assert.match(node, /data-artist-style-gallery-modal/);
  assert.match(node, /data-artist-style-lightbox/);
  assert.match(node, /onWheelCapture=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(node, /ArrowRight/);
  assert.match(node, /ArrowLeft/);
  assert.match(node, /打开艺术风格库/);
  assert.match(node, /输出风格提示词/);
  assert.match(node, /输出风格图片/);
  assert.match(node, /requestArtistStyleRun\('prompt'\)/);
  assert.match(node, /requestArtistStyleRun\('image'\)/);
  assert.match(node, /保存到艺术风格大师/);
  assert.match(node, /新增分类/);
  assert.match(node, /重命名分类/);
  assert.match(node, /删除分类/);
  assert.match(node, /收藏分类/);
  assert.match(node, /全部收藏分类/);
  assert.match(node, /type="file" accept="image\/\*"/);
  assert.match(node, /上传风格图/);
  assert.match(node, /customImageUploadRef/);
  assert.match(node, /编辑自定义风格/);
  assert.match(node, /更新自定义风格/);
  assert.match(node, /取消编辑/);
  assert.match(node, /导入/);
  assert.match(node, /导出/);
  assert.match(node, /复制画家提示词/);
  assert.doesNotMatch(node, /ARTIST_STYLE_MASTER_CATEGORIES/);
  assert.doesNotMatch(node, /filteredStyles\.slice\(0,\s*6\)/);
  assert.match(node, /artist-style-master-mini-grid" onWheelCapture=\{stopCanvasWheel\}/);

  assert.match(styles, /artist-style-master-node/);
  assert.match(styles, /artist-style-master-modal/);
  assert.match(styles, /artist-style-master-lightbox/);
  assert.match(styles, /artist-style-master-mini-grid[\s\S]*max-height/);
  assert.match(styles, /artist-style-master-mini-grid[\s\S]*overflow-y:\s*auto/);
  assert.match(styles, /artist-style-master-mini-grid button[\s\S]*min-width:\s*0/);
  assert.match(styles, /artist-style-master-mini-grid img[\s\S]*max-height/);
  assert.match(styles, /artist-style-master-inline-form[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/);
  assert.match(styles, /artist-style-master-custom-upload/);
  assert.match(styles, /\[data-theme-mode="dark"\][\s\S]*artist-style-master-node/);
  assert.match(styles, /\[data-theme-mode="light"\][\s\S]*artist-style-master-node/);
  assert.match(styles, /html\[data-theme-visual\] \.artist-style-master-node/);
  assert.match(styles, /--asm-bg:\s*var\(--t8-bg-node/);
  assert.match(styles, /--asm-panel:\s*var\(--t8-bg-panel/);
  assert.match(styles, /--asm-accent:\s*var\(--t8-accent/);
  assert.match(styles, /--asm-border:\s*var\(--t8-border-strong/);
  assert.match(styles, /color:\s*var\(--asm-text\)/);
});
