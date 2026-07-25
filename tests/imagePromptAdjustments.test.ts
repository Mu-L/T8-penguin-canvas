import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  IMAGE_PROMPT_ADJUSTMENT_CATALOG_VERSION,
  IMAGE_PROMPT_ADJUSTMENT_CATEGORIES,
  IMAGE_PROMPT_ADJUSTMENTS,
  combinePromptWithImageAdjustments,
  compileImagePromptAdjustments,
  createImagePromptAdjustmentSelection,
  imagePromptAdjustmentsForCategory,
  normalizeImagePromptAdjustmentSelections,
  toggleImagePromptAdjustmentSelection,
} from '../src/data/imagePromptAdjustments.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('image adjustment catalog contains 12 stable categories and exactly 20 curated items per category', () => {
  assert.equal(IMAGE_PROMPT_ADJUSTMENT_CATEGORIES.length, 12);
  assert.equal(IMAGE_PROMPT_ADJUSTMENTS.length, 240);

  const categoryIds = new Set<string>();
  const itemIds = new Set<string>();
  const normalizedZhLabels = new Set<string>();
  const normalizedEnLabels = new Set<string>();
  const normalizedZhPrompts = new Set<string>();
  const normalizedEnPrompts = new Set<string>();

  for (const category of IMAGE_PROMPT_ADJUSTMENT_CATEGORIES) {
    assert.equal(categoryIds.has(category.id), false, `duplicate category id: ${category.id}`);
    categoryIds.add(category.id);
    assert.equal(imagePromptAdjustmentsForCategory(category.id).length, 20, category.id);
    assert.ok(category.labelZh.trim());
    assert.ok(category.labelEn.trim());
    assert.ok(category.descriptionZh.length >= 12);
    assert.ok(category.descriptionEn.length >= 24);
  }

  for (const item of IMAGE_PROMPT_ADJUSTMENTS) {
    const zhLabel = item.labelZh.replace(/\s+/g, '').toLocaleLowerCase();
    const enLabel = item.labelEn.replace(/\s+/g, '').toLocaleLowerCase();
    const zhPrompt = item.promptZh.replace(/\s+/g, '').toLocaleLowerCase();
    const enPrompt = item.promptEn.replace(/\s+/g, '').toLocaleLowerCase();
    assert.equal(itemIds.has(item.id), false, `duplicate item id: ${item.id}`);
    assert.equal(normalizedZhLabels.has(zhLabel), false, `duplicate zh label: ${item.labelZh}`);
    assert.equal(normalizedEnLabels.has(enLabel), false, `duplicate en label: ${item.labelEn}`);
    assert.equal(normalizedZhPrompts.has(zhPrompt), false, `duplicate zh prompt: ${item.labelZh}`);
    assert.equal(normalizedEnPrompts.has(enPrompt), false, `duplicate en prompt: ${item.labelEn}`);
    itemIds.add(item.id);
    normalizedZhLabels.add(zhLabel);
    normalizedEnLabels.add(enLabel);
    normalizedZhPrompts.add(zhPrompt);
    normalizedEnPrompts.add(enPrompt);
    assert.ok(categoryIds.has(item.categoryId), item.id);
    assert.ok(item.promptZh.length >= 18, item.id);
    assert.ok(item.promptEn.length >= 38, item.id);
  }

  assert.ok(
    imagePromptAdjustmentsForCategory('skin').every((item) => item.applicability === 'people'),
    'skin adjustments should keep people-specific applicability metadata',
  );
  assert.ok(
    imagePromptAdjustmentsForCategory('reference').every((item) => item.applicability === 'reference'),
    'reference adjustments should require reference images',
  );
});

test('selection snapshots are versioned and preserve one active item per category', () => {
  const a01 = IMAGE_PROMPT_ADJUSTMENTS.find((item) => item.id === 'A01')!;
  const a02 = IMAGE_PROMPT_ADJUSTMENTS.find((item) => item.id === 'A02')!;
  const b01 = IMAGE_PROMPT_ADJUSTMENTS.find((item) => item.id === 'B01')!;
  const snapshots = normalizeImagePromptAdjustmentSelections([
    createImagePromptAdjustmentSelection(a01),
    createImagePromptAdjustmentSelection(a02),
    createImagePromptAdjustmentSelection(b01),
  ]);
  assert.deepEqual(snapshots.map((item) => item.itemId), ['A02', 'B01']);
  assert.ok(snapshots.every((item) => item.catalogVersion === IMAGE_PROMPT_ADJUSTMENT_CATALOG_VERSION));

  const oldSnapshot = {
    ...createImagePromptAdjustmentSelection(a01),
    catalogVersion: 'older-catalog',
    promptZh: '旧画布固定语义',
    promptEn: 'Pinned semantics from an older canvas.',
  };
  const restored = normalizeImagePromptAdjustmentSelections([oldSnapshot]);
  assert.equal(restored[0]?.promptZh, '旧画布固定语义');
  assert.equal(restored[0]?.catalogVersion, 'older-catalog');
});

test('clicking toggles, replaces the same category, and removes explicit cross-category conflicts', () => {
  let selections = toggleImagePromptAdjustmentSelection([], 'E01');
  assert.deepEqual(selections.map((item) => item.itemId), ['E01']);
  selections = toggleImagePromptAdjustmentSelection(selections, 'E03');
  assert.deepEqual(selections.map((item) => item.itemId), ['E03']);
  selections = toggleImagePromptAdjustmentSelection(selections, 'E03');
  assert.deepEqual(selections, []);

  selections = toggleImagePromptAdjustmentSelection([], 'I07');
  selections = toggleImagePromptAdjustmentSelection(selections, 'F02');
  assert.deepEqual(selections.map((item) => item.itemId), ['F02']);

  selections = toggleImagePromptAdjustmentSelection([], 'I09');
  selections = toggleImagePromptAdjustmentSelection(selections, 'B01');
  assert.deepEqual(selections.map((item) => item.itemId), ['B01']);
});

test('compiler keeps fixed semantic order, auto language, and reference capability feedback', () => {
  const selected = ['L01', 'A02', 'I01', 'G01'].map((itemId) => (
    createImagePromptAdjustmentSelection(
      IMAGE_PROMPT_ADJUSTMENTS.find((item) => item.id === itemId)!,
    )
  ));

  const withoutReference = compileImagePromptAdjustments(
    selected,
    { hasReferenceImages: false, language: 'zh' },
    '一位人物走在街道上',
  );
  assert.deepEqual(withoutReference.active.map((item) => item.itemId), ['A02', 'G01', 'L01']);
  assert.deepEqual(withoutReference.inactive.map((item) => item.itemId), ['I01']);
  assert.match(withoutReference.inactive[0]?.reason || '', /参考图/);

  const withReference = combinePromptWithImageAdjustments(
    'A person walking down a street.',
    selected,
    { hasReferenceImages: true, language: 'auto' },
  );
  assert.equal(withReference.language, 'en');
  assert.deepEqual(withReference.active.map((item) => item.itemId), ['I01', 'A02', 'G01', 'L01']);
  assert.ok(withReference.finalPrompt.startsWith('A person walking down a street.\nImage adjustment requirements:'));
  assert.ok(withReference.finalPrompt.indexOf('Preserve the reference person') < withReference.finalPrompt.indexOf('Match lighting'));
});

test('ImageNode and MentionPromptInput share one structured adjustment source without rewriting prompt text', () => {
  const imageNode = read('src/components/nodes/ImageNode.tsx');
  const mentionInput = read('src/components/nodes/MentionPromptInput.tsx');
  const adjustmentUi = read('src/components/ImagePromptAdjustmentButton.tsx');

  assert.match(imageNode, /normalizeImagePromptAdjustmentSelections\(d\?\.imagePromptAdjustments\)/);
  assert.match(imageNode, /const basePrompt = \(\s*upstreamPrompt\s*\|\|/);
  assert.match(imageNode, /combinePromptWithImageAdjustments\(/);
  assert.match(imageNode, /hasReferenceImages:\s*upstreamImages\.length > 0/);
  assert.match(imageNode, /imagePromptAdjustments=\{imagePromptAdjustments\}/);
  assert.match(imageNode, /onImagePromptAdjustmentsChange=\{updateImagePromptAdjustments\}/);

  assert.match(mentionInput, /imagePromptAdjustments\?: unknown/);
  assert.match(mentionInput, /ImagePromptAdjustmentButton/);
  assert.match(mentionInput, /data-image-prompt-adjustment-summary/);
  assert.match(mentionInput, /项待参考图/);
  assert.doesNotMatch(mentionInput, /onChange\(.*promptZh/);

  assert.match(adjustmentUi, /data-image-prompt-adjustment-trigger/);
  assert.match(adjustmentUi, /role="dialog"/);
  assert.match(adjustmentUi, /role="listbox"/);
  assert.match(adjustmentUi, /role="option"/);
  assert.match(adjustmentUi, /aria-selected=\{selected\}/);
  assert.match(adjustmentUi, /aria-disabled=\{disabled\}/);
  assert.match(adjustmentUi, /同类自动替换/);
  assert.match(adjustmentUi, /setPreviousSelections/);
});
