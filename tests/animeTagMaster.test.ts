import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  ANIME_TAG_MASTER_EXPORT_SCHEMA,
  ANIME_TAG_MASTER_STORAGE_KEY,
  ANIME_TAG_ONLINE_PROVIDERS,
  buildAnimeTagImageOutputPayload,
  buildAnimeTagLivePreviewImageUrl,
  buildAnimeTagProxyPostsUrl,
  buildAnimeTagPreviewUrl,
  buildAnimeTagProxyImageUrl,
  buildAnimeTagProxySearchUrl,
  buildAnimeTagProxyTagsUrl,
  buildAnimeTagPrompt,
  buildDanbooruPostsUrl,
  buildDanbooruTagsUrl,
  buildGelbooruPostsUrl,
  buildGelbooruTagsUrl,
  ANIME_TAG_ONLINE_CATEGORY_OPTIONS,
  createAnimeTagExport,
  extractGelbooruPostRecords,
  getAnimeTagPreviewImageUrl,
  createAnimeTagFromMaterial,
  importAnimeTagExport,
  mapDanbooruTagToAnimeTagItem,
  mapGelbooruTagToAnimeTagItem,
  normalizeAnimeTagProvider,
  normalizeAnimeTagItem,
  pickAnimeTagPreviewQuery,
  resolveAnimeTagOnlineCategory,
  searchAnimeTags,
  upsertAnimeTagInLibrary,
} from '../src/utils/animeTagMaster.ts';
import { ANIME_TAG_MASTER_CATEGORIES, ANIME_TAG_MASTER_ITEMS } from '../src/data/animeTagMasterManifest.ts';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

const require = createRequire(import.meta.url);
const animeTagsRoute = require('../backend/src/routes/animeTags.js');

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

test('anime tag master is registered in the Inspiration category', () => {
  const types = read('../src/types/canvas.ts');
  const canvas = read('../src/components/Canvas.tsx');
  const node = read('../src/components/nodes/AnimeTagMasterNode.tsx');
  const sidebar = read('../src/components/Sidebar.tsx');
  const placement = read('../src/utils/nodePlacement.ts');
  const server = read('../backend/src/server.js');
  const backendRoute = read('../backend/src/routes/animeTags.js');
  const features = read('../features.json');

  assert.match(types, /'anime-tag-master'/);
  assertProductionNodeSchema('anime-tag-master', {
    label: '动漫标签大师',
    category: 'inspiration',
    inputs: ['text', 'image'],
    outputs: ['text', 'image'],
    executable: true,
  });
  assert.match(canvas, /AnimeTagMasterNode/);
  assert.match(canvas, /import\('\.\/nodes\/AnimeTagMasterNode'\)/);
  assert.match(canvas, /'anime-tag-master': AnimeTagMasterNode/);
  assert.match(node, /import \{ requestCanvasNodeRun \} from '\.\.\/\.\.\/utils\/canvasRunRequest';/);
  assert.equal(node.match(/requestCanvasNodeRun\(id\)/g)?.length, 1);
  assert.match(node, /onClick=\{\(\) => requestAnimeTagRun\('tags'\)\}/);
  assert.match(node, /onClick=\{\(\) => requestAnimeTagRun\('image'\)\}/);
  assert.match(node, /animeTagOutputMode: mode,[\s\S]*?requestCanvasNodeRun\(id\);/);
  assert.match(node, /liveData\?\.animeTagOutputMode === 'image'[\s\S]*?runAnimeTagOutput\(mode\)/);
  assert.doesNotMatch(node, /void runAnimeTagOutput\(/);
  assert.match(sidebar, /'anime-tag-master': 'Tags'/);
  assert.match(placement, /'anime-tag-master':\s*\{\s*w:\s*500,\s*h:\s*660\s*\}/);
  assert.match(server, /animeTagsRouter/);
  assert.match(server, /\/api\/anime-tags/);
  assert.match(backendRoute, /Gelbooru DAPI 需要 user_id\/api_key/);
  assert.match(backendRoute, /searchGelbooruHtml/);
  assert.match(backendRoute, /normalizeProvider/);
  assert.match(backendRoute, /\/preview/);
  assert.match(backendRoute, /\/preview-image/);
  assert.match(backendRoute, /previewDanbooru/);
  assert.match(backendRoute, /previewGelbooru/);
  assert.match(backendRoute, /router\.get\('\/tags'/);
  assert.match(backendRoute, /router\.post\('\/tags\/refresh'/);
  assert.match(backendRoute, /router\.get\('\/posts'/);
  assert.match(backendRoute, /searchDanbooruTags/);
  assert.match(backendRoute, /searchGelbooruTags/);
  assert.match(backendRoute, /async function searchDanbooruTags[^{]*\{(?:(?!async function searchGelbooruDapi)[\s\S])*return sortTagItemsByPostCount\(/);
  assert.match(backendRoute, /async function searchGelbooruTags[^{]*\{(?:(?!function parseGelbooruHtmlTagRows)[\s\S])*return sortTagItemsByPostCount\(/);
  assert.match(backendRoute, /searchGelbooruHtmlTypeTags/);
  assert.match(backendRoute, /fallbackProvider/);
  assert.match(backendRoute, /Danbooru 预览失败，已切换 Gelbooru 实时预览/);
  assert.match(backendRoute, /\/image/);
  assert.match(features, /animeTagMasterNode/);
  assert.match(features, /"type":\s*"anime-tag-master"/);
});

test('anime tag manifest and prompt output cover anime creation basics', () => {
  assert.ok(ANIME_TAG_MASTER_ITEMS.length >= 24);
  const categoryNames = ANIME_TAG_MASTER_CATEGORIES.map((item) => item.name).join(' / ');
  assert.match(categoryNames, /画师 \/ Artist/);
  assert.match(categoryNames, /作品 IP \/ Copyright/);
  assert.match(categoryNames, /角色 IP \/ Character/);
  assert.match(categoryNames, /风格 · Meta/);
  assert.doesNotMatch(categoryNames, /在线图库 Danbooru/);
  assert.doesNotMatch(categoryNames, /在线图库 Gelbooru/);
  assert.doesNotMatch(categoryNames, /表情情绪|服装配饰|负面排除/);

  const keyVisual = searchAnimeTags(ANIME_TAG_MASTER_ITEMS, { query: '少女 海报 1girl', category: 'character' })[0];
  assert.ok(keyVisual);
  assert.match(keyVisual.tags.join(', '), /1girl/);

  const prompt = buildAnimeTagPrompt(keyVisual);
  assert.deepEqual(prompt.split('\n').map((line) => line.replace(/:.*/, ':')), ['Tags:', 'Prompt:']);
  assert.match(prompt, /1girl/);
  assert.doesNotMatch(prompt, /Anime tag reference|中文分类|Negative prompt|Attributes/);

  const custom = normalizeAnimeTagItem({
    name: 'maid character sheet',
    chineseName: '女仆角色设定',
    categoryId: 'character',
    categoryName: '角色人设',
    tags: ['maid', 'character_sheet', 'front_view'],
    prompt: 'clean anime character sheet',
    imageUrl: '/custom/maid.webp',
  });
  const library = upsertAnimeTagInLibrary({ categories: [], items: [] }, custom, {
    id: 'character',
    name: '角色 IP / Character',
  });
  assert.equal(library.items.length, 1);
  assert.equal(library.categories[0].name, '角色 IP / Character');
});

test('online booru tag search preserves provider popularity order', () => {
  const onlineItems = [
    normalizeAnimeTagItem({
      id: 'danbooru-tag-original',
      name: 'original',
      chineseName: 'original',
      categoryId: 'copyright',
      categoryName: '作品 IP / Copyright',
      source: 'danbooru',
      postCount: 1510001,
    }),
    normalizeAnimeTagItem({
      id: 'danbooru-tag-touhou',
      name: 'touhou',
      chineseName: 'touhou',
      categoryId: 'copyright',
      categoryName: '作品 IP / Copyright',
      source: 'danbooru',
      postCount: 1061588,
    }),
    normalizeAnimeTagItem({
      id: 'danbooru-tag-arknights',
      name: 'arknights',
      chineseName: 'arknights',
      categoryId: 'copyright',
      categoryName: '作品 IP / Copyright',
      source: 'danbooru',
      postCount: 211598,
    }),
  ];

  const results = searchAnimeTags(onlineItems, { category: 'copyright', source: 'danbooru' });
  assert.deepEqual(results.map((item) => item.name), ['original', 'touhou', 'arknights']);
});

test('anime tag online gallery uses provider-aware General / Meta category mapping', () => {
  assert.deepEqual(ANIME_TAG_ONLINE_CATEGORY_OPTIONS.map((item) => item.id), [
    'artist',
    'copyright',
    'character',
    'general-meta',
  ]);
  assert.match(ANIME_TAG_ONLINE_CATEGORY_OPTIONS[3].name, /General \/ Meta/);
  assert.equal(resolveAnimeTagOnlineCategory('danbooru', 'general-meta'), 'meta');
  assert.equal(resolveAnimeTagOnlineCategory('gelbooru', 'general-meta'), 'general');
  assert.equal(resolveAnimeTagOnlineCategory('galbooru', 'general-meta'), 'general');
  assert.equal(resolveAnimeTagOnlineCategory('danbooru', 'artist'), 'artist');

  const danbooruTagsUrl = buildDanbooruTagsUrl('general-meta', { query: 'highres', page: 2, limit: 30 });
  assert.match(danbooruTagsUrl, /^https:\/\/danbooru\.donmai\.us\/tags\.json/);
  assert.match(danbooruTagsUrl, /search%5Bcategory%5D=5/);
  assert.match(danbooruTagsUrl, /search%5Border%5D=count/);
  assert.match(danbooruTagsUrl, /search%5Bhide_empty%5D=yes/);
  assert.match(danbooruTagsUrl, /search%5Bname_matches%5D=\*highres\*/);
  assert.match(danbooruTagsUrl, /page=2/);
  assert.match(danbooruTagsUrl, /limit=30/);

  const gelbooruTagsUrl = buildGelbooruTagsUrl('general-meta', { query: '1girl', page: 3, limit: 40 });
  assert.match(gelbooruTagsUrl, /^https:\/\/gelbooru\.com\/index\.php/);
  assert.match(gelbooruTagsUrl, /s=tag/);
  assert.match(gelbooruTagsUrl, /pid=2/);
  assert.match(gelbooruTagsUrl, /type=0/);
  assert.match(gelbooruTagsUrl, /orderby=count/);
  assert.match(gelbooruTagsUrl, /name_pattern=%251girl%25/);

  const danbooruProxy = buildAnimeTagProxyTagsUrl('danbooru', 'general-meta', {
    query: 'highres',
    letter: 'h',
    page: 2,
    pageSize: 30,
  });
  assert.equal(danbooruProxy, '/api/anime-tags/tags?provider=danbooru&category=meta&q=highres&letter=h&page=2&pageSize=30&safe=1');
  const gelbooruProxy = buildAnimeTagProxyTagsUrl('gelbooru', 'general-meta', {
    page: 1,
    pageSize: 30,
  });
  assert.equal(gelbooruProxy, '/api/anime-tags/tags?provider=gelbooru&category=general&page=1&pageSize=30&safe=1');

  const danbooruTag = mapDanbooruTagToAnimeTagItem({ name: 'highres', category: 5, post_count: 4321 });
  assert.equal(danbooruTag.chineseName, 'highres');
  assert.equal(danbooruTag.categoryId, 'meta');
  assert.equal(danbooruTag.categoryName, '风格 · Meta');
  assert.equal(danbooruTag.postCount, 4321);

  const gelbooruTag = mapGelbooruTagToAnimeTagItem({ name: '1girl', type: 0, count: 999999 });
  assert.equal(gelbooruTag.chineseName, '1girl');
  assert.equal(gelbooruTag.categoryId, 'general');
  assert.equal(gelbooruTag.categoryName, '通用标签 / General');
  assert.equal(gelbooruTag.postCount, 999999);

  const gelbooruAutocompleteArtist = mapGelbooruTagToAnimeTagItem({
    type: 'tag',
    category: 'artist',
    value: 'tony_taka',
    post_count: '3573',
  });
  assert.equal(gelbooruAutocompleteArtist.categoryId, 'artist');
  assert.equal(gelbooruAutocompleteArtist.chineseName, 'tony_taka');
  assert.equal(gelbooruAutocompleteArtist.postCount, 3573);
});

test('anime tag backend handles live booru API edge cases', () => {
  const internals = animeTagsRoute._internals;
  assert.ok(internals);
  assert.match(internals.USER_AGENT, /^T8-PenguinCanvas/);
  assert.doesNotMatch(internals.USER_AGENT, /^Mozilla/);

  const autocompleteArtist = internals.mapGelbooruTag({
    type: 'tag',
    category: 'artist',
    label: 'tony taka',
    value: 'tony_taka',
    post_count: '3573',
  }, 'artist');
  assert.equal(autocompleteArtist.categoryId, 'artist');
  assert.equal(autocompleteArtist.name, 'tony_taka');
  assert.equal(autocompleteArtist.chineseName, 'tony_taka');
  assert.equal(autocompleteArtist.postCount, 3573);

  const autocompleteGeneral = internals.mapGelbooruTag({
    type: 'tag',
    category: 'tag',
    label: '1girl',
    value: '1girl',
    post_count: '9276317',
  }, 'general');
  assert.equal(autocompleteGeneral.categoryId, 'general');

  assert.deepEqual(internals.buildGelbooruAutocompleteTerms('artist', { query: 'tony', letter: '' }), ['tony']);
  assert.deepEqual(internals.buildGelbooruAutocompleteTerms('artist', { query: '', letter: 't' }), ['t']);
  assert.ok(internals.buildGelbooruAutocompleteTerms('artist', { query: '', letter: '' }).includes('tony'));
  assert.ok(internals.buildGelbooruAutocompleteTerms('artist', { query: '', letter: '' }).includes('tony_taka'));
  assert.ok(internals.buildGelbooruAutocompleteTerms('copyright', { query: '', letter: '' }).includes('pokemon'));
  assert.ok(internals.buildGelbooruAutocompleteTerms('copyright', { query: '', letter: '' }).includes('genshin_impact'));
  assert.ok(internals.buildGelbooruAutocompleteTerms('character', { query: '', letter: '' }).includes('z23'));
  assert.ok(internals.buildGelbooruAutocompleteTerms('general', { query: '', letter: '' }).includes('1girl'));
  assert.equal(internals.normalizeBooruTagQuery('bb_(baalbuddy)'), 'bb_(baalbuddy)');
  assert.equal(internals.normalizeBooruTagQuery('tony taka'), 'tony_taka');
  assert.equal(internals.normalizePreviewQuery('bb_(baalbuddy)'), 'bb_(baalbuddy)');
  assert.equal(internals.normalizePreviewQuery('z23_(azur_lane)'), 'z23_(azur_lane)');
  assert.equal(internals.normalizePreviewQuery('tony taka (artist)'), 'tony_taka');

  const sortedByPosts = internals.sortTagItemsByPostCount([
    { name: 'low', postCount: 4 },
    { name: 'high', postCount: 40 },
    { name: 'middle', postCount: 12 },
  ]);
  assert.deepEqual(sortedByPosts.map((item: any) => item.name), ['high', 'middle', 'low']);

  const htmlRows = internals.parseGelbooruHtmlTagRows(`
    <tr><td><span class="tag-type-artist"><a href="index.php?page=post&amp;s=list&amp;tags=tony_taka">tony taka</a></span>
    <span class="tag-count">3,573</span></td><td>artist (<a href="#">edit</a>)</td></tr>
  `, 'artist');
  assert.equal(htmlRows[0].categoryId, 'artist');
  assert.equal(htmlRows[0].name, 'tony_taka');
  assert.equal(htmlRows[0].postCount, 3573);
});

test('anime tag master lazy-loads Danbooru and Gelbooru/Galbooru online libraries', () => {
  assert.deepEqual(ANIME_TAG_ONLINE_PROVIDERS.map((item) => item.id), ['danbooru', 'gelbooru']);
  assert.equal(ANIME_TAG_ONLINE_PROVIDERS[1].label, 'Gelbooru');
  assert.doesNotMatch(ANIME_TAG_ONLINE_PROVIDERS.map((item) => item.label).join(' '), /Galbooru/);
  assert.equal(ANIME_TAG_ONLINE_PROVIDERS[1].aliases.includes('galbooru'), true);
  assert.equal(normalizeAnimeTagProvider('galbooru'), 'gelbooru');
  assert.equal(normalizeAnimeTagProvider('gel'), 'gelbooru');
  assert.equal(normalizeAnimeTagProvider('dan'), 'danbooru');

  const danbooruPost = buildDanbooruPostsUrl('hatsune_miku', { limit: 6, page: 2 });
  const mappedDanbooruPost = animeTagsRoute._internals.mapDanbooruPost({
    id: 123,
    tag_string: 'hatsune_miku 1girl solo',
    preview_file_url: 'https://cdn.donmai.us/sample.jpg',
  }, 'hatsune_miku');
  assert.equal(mappedDanbooruPost.chineseName, 'hatsune_miku, 1girl, solo');

  const mappedGelbooruPost = animeTagsRoute._internals.mapGelbooruPost({
    id: 456,
    tags: 'ask_(askzy) original solo',
    preview_url: 'https://img3.gelbooru.com/sample.jpg',
  }, 'ask_(askzy)');
  assert.equal(mappedGelbooruPost.chineseName, 'ask_(askzy), original, solo');

  const danbooruUrl = danbooruPost;
  assert.match(danbooruUrl, /^https:\/\/danbooru\.donmai\.us\/posts\.json/);
  assert.match(danbooruUrl, /hatsune_miku/);
  assert.match(danbooruUrl, /rating%3Ageneral/);
  assert.match(danbooruUrl, /page=2/);

  const gelbooruUrl = buildGelbooruPostsUrl('1girl', { limit: 6, page: 3 });
  assert.match(gelbooruUrl, /^https:\/\/gelbooru\.com\/index\.php/);
  assert.match(gelbooruUrl, /page=dapi/);
  assert.match(gelbooruUrl, /pid=2/);
  assert.match(gelbooruUrl, /tags=1girl%20rating%3Ageneral/);

  const proxyUrl = buildAnimeTagProxySearchUrl('gelbooru', '1girl', { limit: 6, page: 3 });
  assert.equal(proxyUrl, '/api/anime-tags/search?provider=gelbooru&q=1girl&limit=6&page=3&safe=1');
  const galProxyUrl = buildAnimeTagProxySearchUrl('galbooru', '1girl', { limit: 6, page: 3 });
  assert.equal(galProxyUrl, '/api/anime-tags/search?provider=gelbooru&q=1girl&limit=6&page=3&safe=1');
  const postsProxyUrl = buildAnimeTagProxyPostsUrl('danbooru', 'tony_taka', { page: 4, pageSize: 24 });
  assert.equal(postsProxyUrl, '/api/anime-tags/posts?provider=danbooru&tag=tony_taka&page=4&pageSize=24&safe=1');
  const disambiguatedPostsProxyUrl = buildAnimeTagProxyPostsUrl('danbooru', 'bb_(baalbuddy)', { page: 1, pageSize: 24 });
  assert.equal(new URLSearchParams(disambiguatedPostsProxyUrl.split('?')[1]).get('tag'), 'bb_(baalbuddy)');

  const previewUrl = buildAnimeTagPreviewUrl('danbooru', '@hatsune miku, smile', { safe: true });
  assert.equal(previewUrl, '/api/anime-tags/preview?provider=danbooru&q=hatsune_miku&safe=1');
  const livePreviewUrl = buildAnimeTagLivePreviewImageUrl('galbooru', '1girl', { safe: true });
  assert.equal(livePreviewUrl, '/api/anime-tags/preview-image?provider=gelbooru&q=1girl&safe=1');
  assert.deepEqual(extractGelbooruPostRecords({ posts: { post: [{ id: 1 }] } }), [{ id: 1 }]);
  assert.deepEqual(extractGelbooruPostRecords({ post: { id: 2 } }), [{ id: 2 }]);

  const previewQuery = pickAnimeTagPreviewQuery({
    id: 'builtin-1',
    name: '少女主视觉海报',
    chineseName: '少女主视觉海报',
    categoryId: 'character',
    categoryName: '角色人设',
    tags: ['1girl', 'solo'],
    prompt: 'anime key visual',
    negativePrompt: '',
    source: 'builtin',
    imageUrl: '',
    attributes: '',
    userCreated: false,
  });
  assert.equal(previewQuery, '1girl');
});

test('anime tag image output carries standard image fields', () => {
  const item = normalizeAnimeTagItem({
    name: 'sakura miku',
    chineseName: '樱花初音',
    categoryId: 'character',
    categoryName: '角色人设',
    tags: ['hatsune_miku', 'sakura', 'long_hair'],
    prompt: 'sakura miku under cherry blossoms',
    imageUrl: '/anime-tags/sakura-miku.webp',
  });
  const payload = buildAnimeTagImageOutputPayload(item);
  assert.equal(payload.kind, 'image');
  assert.equal(payload.data.directImageUrl, '/anime-tags/sakura-miku.webp');
  assert.deepEqual(payload.data.directImageUrls, ['/anime-tags/sakura-miku.webp']);
  assert.deepEqual(payload.data.imageUrls, ['/anime-tags/sakura-miku.webp']);
  assert.match(payload.data.directOutputText, /hatsune_miku/);
});

test('anime tag preview images are proxied or generated without local downloads', () => {
  const proxied = buildAnimeTagProxyImageUrl('https://cdn.donmai.us/original/sample.jpg');
  assert.equal(proxied, '/api/anime-tags/image?u=https%3A%2F%2Fcdn.donmai.us%2Foriginal%2Fsample.jpg');

  const builtin = normalizeAnimeTagItem({
    name: '1girl visual poster',
    chineseName: '少女主视觉海报',
    categoryId: 'character',
    categoryName: '角色人设',
    tags: ['1girl', 'solo', 'looking_at_viewer'],
    prompt: '1girl, solo',
    source: 'builtin',
    userCreated: false,
  });
  const fallbackPreview = getAnimeTagPreviewImageUrl(builtin);
  assert.equal(fallbackPreview, '/api/anime-tags/preview-image?provider=danbooru&q=1girl&safe=1');

  const payload = buildAnimeTagImageOutputPayload(builtin);
  assert.equal(payload.kind, 'image');
  assert.equal(payload.data.directImageUrl, '/api/anime-tags/preview-image?provider=danbooru&q=1girl&safe=1');
  assert.deepEqual(payload.data.directImageUrls, [payload.data.directImageUrl]);

  const customWithoutImage = normalizeAnimeTagItem({
    name: 'my private tag',
    chineseName: '我的本地标签',
    categoryId: 'custom',
    categoryName: '自定义',
    tags: ['private_tag'],
    prompt: 'private_tag',
    source: 'custom',
  });
  assert.match(getAnimeTagPreviewImageUrl(customWithoutImage), /^data:image\/svg\+xml/);
});

test('anime tag custom library import/export and material conversion are confirmed', () => {
  assert.equal(ANIME_TAG_MASTER_STORAGE_KEY, 't8-anime-tag-master:user-library:v1');
  assert.equal(ANIME_TAG_MASTER_EXPORT_SCHEMA, 't8-anime-tag-master@1');

  const material = createAnimeTagFromMaterial({
    imageUrl: '/files/output/anime.png',
    title: 'anime-reference.png',
    prompt: '1girl, kimono, night festival',
    categoryName: '素材收藏',
    tags: ['right-click', 'reference'],
  });
  assert.equal(material.imageUrl, '/files/output/anime.png');
  assert.equal(material.userCreated, true);
  assert.match(material.tags.join(','), /kimono/);

  const exported = createAnimeTagExport({
    categories: [{ id: 'my-anime', name: '我的动漫标签' }],
    items: [material],
  });
  assert.equal(exported.schema, ANIME_TAG_MASTER_EXPORT_SCHEMA);
  const imported = importAnimeTagExport(exported);
  assert.equal(imported.items.length, 1);
  assert.equal(imported.categories[0].name, '我的动漫标签');
});

test('material context menu can save image materials to anime tag master', () => {
  const contextMenu = read('../src/components/MaterialContextMenu.tsx');
  const uploadNode = read('../src/components/nodes/UploadNode.tsx');
  const outputNode = read('../src/components/nodes/OutputNode.tsx');
  const node = read('../src/components/nodes/AnimeTagMasterNode.tsx');

  assert.match(contextMenu, /保存动漫标签到动漫标签大师/);
  assert.match(contextMenu, /openAnimeTagSaveDialog/);
  assert.match(contextMenu, /createAnimeTagFromMaterial/);
  assert.match(contextMenu, /menu\.kind !== 'image'/);
  assert.match(contextMenu, /ANIME_TAG_MASTER_EVENT/);
  assert.match(contextMenu, /请确认或修改动漫标签提示词/);
  assert.match(contextMenu, /自动获取提示词/);
  assert.match(uploadNode, /data-drag-kind="image"/);
  assert.match(outputNode, /data-prompt-template-prompt=\{mediaPromptByUrl\.get\(u\)\?\.prompt \|\| displayText\}/);
  assert.match(node, /ANIME_TAG_MASTER_EVENT/);
});

test('anime tag master frontend keeps compact scrolling, lightbox and theme hooks', () => {
  const node = read('../src/components/nodes/AnimeTagMasterNode.tsx');
  const styles = read('../src/styles/index.css');

  assert.match(node, /data-anime-tag-master-root/);
  assert.match(node, /data-anime-tag-master-drag-surface/);
  assert.match(node, /data-anime-tag-library-modal/);
  assert.match(node, /data-anime-tag-lightbox/);
  assert.match(node, /onWheelCapture=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(node, /AnimeTagPreviewImage/);
  assert.match(node, /requestLazyPreview/);
  assert.match(node, /queueVisiblePreview/);
  assert.match(node, /IntersectionObserver/);
  assert.match(node, /data-anime-tag-preview-id/);
  assert.match(node, /重试预览/);
  assert.match(node, /buildAnimeTagPreviewUrl/);
  assert.match(node, /buildAnimeTagLivePreviewImageUrl/);
  assert.match(node, /const PREVIEW_RETRY_DELAYS_MS = \[650, 1400, 2600\]/);
  assert.match(node, /async function fetchPreviewWithRetries/);
  assert.match(node, /预览已重试 3 次/);
  assert.doesNotMatch(node, /previewImageOf/);
  assert.match(node, /ArrowRight/);
  assert.match(node, /ArrowLeft/);
  assert.match(node, /Danbooru/);
  assert.match(node, /Gelbooru/);
  assert.match(node, /懒加载搜索/);
  assert.match(node, /const searchOnline = useCallback[\s\S]*await loadOnlineTags\(1, true\)/);
  assert.doesNotMatch(node, /refreshOnline/);
  assert.doesNotMatch(node, />刷新</);
  assert.match(node, /handleOnlineQueryKeyDown/);
  assert.match(node, /onKeyDown=\{handleOnlineQueryKeyDown\}/);
  assert.match(node, /handleLoadedSearchKeyDown/);
  assert.match(node, /onKeyDown=\{handleLoadedSearchKeyDown\}/);
  assert.match(node, /runLoadedQueryAsOnlineSearch/);
  assert.match(node, /categoryToOnlineCategory/);
  assert.match(node, /updateCategory\(event\.target\.value\)/);
  assert.match(node, /updateOnlineCategory\(event\.target\.value as AnimeTagOnlineCategoryId\)/);
  assert.match(node, /renderOnlinePagination\('modal'/);
  assert.match(node, /renderOnlinePagination\('compact'/);
  assert.match(node, /anime-tag-master-gallery-panel/);
  assert.match(node, /anime-tag-master-preview-eye/);
  assert.match(node, /anime-tag-master-hover-preview-popover/);
  assert.match(node, /anime-tag-master-compact-search/);
  assert.match(node, /anime-tag-master-compact-query/);
  assert.match(node, /className="anime-tag-master-online-search"[\s\S]*<Search size=\{16\} \/>\s*搜索/);
  assert.match(node, /anime-tag-master-grid-title/);
  assert.match(node, /allowLivePreview=\{allowLivePreview\}/);
  assert.match(node, /renderPreviewImage\(displayItem,[\s\S]*false,\s*false\)/);
  assert.match(node, /previewSeedLimit/);
  assert.match(node, /pageSize:\s*60/);
  assert.match(node, /const previewProviders/);
  assert.match(node, /返回标签列表/);
  assert.match(node, /onlineMode === 'posts' \? 'all' : category/);
  assert.match(node, /trustedTotal/);
  assert.match(node, /resolveAnimeTagOnlineCategory\(/);
  assert.match(node, /onlineRequestRef/);
  assert.match(node, /updateOnlineQuery/);
  assert.match(node, /updateOnlineLetter/);
  assert.match(node, /initialOnlineQuery\(\(data as any\)\?\.animeTagOnlineQuery\)/);
  assert.match(node, /legacyDefaultOnlineQueries/);
  assert.match(node, /'1 girl'/);
  assert.match(node, /'hatsune_miku \/ 1 girl'/);
  assert.doesNotMatch(node, /animeTagOnlineQuery \|\| '1girl'/);
  assert.doesNotMatch(node, /placeholder="(?:例如 )?hatsune_miku \/ 1girl"/);
  assert.doesNotMatch(node, /setCategory\(resolvedCategory\)/);
  assert.doesNotMatch(node, /limit:\s*libraryOpen\s*\?\s*undefined\s*:\s*12/);
  assert.doesNotMatch(node, /filteredItems\.slice\(0,\s*8\)\.map/);
  assert.doesNotMatch(node, /setCategory\(items\[0\]\.categoryId\)/);
  assert.match(node, /输出标签/);
  assert.match(node, /输出图像/);
  assert.match(node, /requestAnimeTagRun\('tags'\)/);
  assert.match(node, /requestAnimeTagRun\('image'\)/);
  assert.match(node, /新增分类/);
  assert.match(node, /删除分类/);
  assert.match(node, /导入/);
  assert.match(node, /导出/);
  assert.match(node, /type="file" accept="image\/\*"/);
  assert.match(node, /上传标签图/);

  assert.match(styles, /anime-tag-master-node/);
  assert.match(styles, /anime-tag-master-modal/);
  assert.match(styles, /anime-tag-master-lightbox/);
  assert.match(styles, /anime-tag-master-gallery-panel/);
  assert.match(styles, /anime-tag-master-pagination\.is-compact/);
  assert.match(styles, /anime-tag-master-preview-eye/);
  assert.match(styles, /anime-tag-master-preview-eye svg/);
  assert.match(styles, /anime-tag-master-hover-preview-popover/);
  assert.match(styles, /anime-tag-master-compact-search/);
  assert.match(styles, /anime-tag-master-online\.is-compact \.anime-tag-master-online-search[\s\S]*min-height:\s*46px/);
  assert.match(styles, /anime-tag-master-online-search[\s\S]*display:\s*inline-flex/);
  assert.match(styles, /anime-tag-master-online-search[\s\S]*border:\s*2px solid var\(--atm-border\)/);
  assert.match(styles, /anime-tag-master-online-search[\s\S]*background:\s*var\(--atm-panel\)/);
  assert.match(styles, /anime-tag-master-no-image\.is-online-preview-loading/);
  assert.match(styles, /anime-tag-master-no-image\.is-online-preview-missing/);
  assert.doesNotMatch(styles, /anime-tag-master-online\.is-compact \.anime-tag-master-online-search[\s\S]{0,100}padding:\s*0\s*;/);
  assert.match(styles, /anime-tag-master-grid-title/);
  assert.doesNotMatch(styles, /\.anime-tag-master-grid span\s*\{/);
  assert.match(styles, /anime-tag-master-card-actions button[\s\S]*justify-content:\s*center/);
  assert.match(styles, /anime-tag-master-grid[\s\S]*overflow-y:\s*auto/);
  assert.match(styles, /anime-tag-master-grid button[\s\S]*min-width:\s*0/);
  assert.match(styles, /\[data-theme-mode="dark"\][\s\S]*anime-tag-master-node/);
  assert.match(styles, /\[data-theme-mode="light"\][\s\S]*anime-tag-master-node/);
  assert.match(styles, /html\[data-theme-visual\] \.anime-tag-master-node/);
  assert.match(styles, /--atm-bg:\s*var\(--t8-bg-node/);
  assert.match(styles, /--atm-panel:\s*var\(--t8-bg-panel/);
  assert.match(styles, /--atm-accent:\s*var\(--t8-accent/);
  assert.match(styles, /--atm-border:\s*var\(--t8-border-strong/);
  assert.match(styles, /color:\s*var\(--atm-text\)/);
});
