import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('GPT Image 2 exposes quality and moderation with Auto defaults only on the standard route', () => {
  const imageNode = read('src/components/nodes/ImageNode.tsx');

  assert.match(imageNode, /const isStandardGptImage2 = !isExternalSelected[\s\S]*modelDef\.paramKind === 'gpt-size'[\s\S]*!isFal[\s\S]*!isZhenzhenImageG2/);
  assert.match(imageNode, /const gptImageQuality:[\s\S]*: 'auto';/);
  assert.match(imageNode, /const gptImageModeration:[\s\S]*\? 'low' : 'auto';/);
  for (const value of ['auto', 'high', 'medium', 'low']) {
    assert.match(imageNode, new RegExp(`<option value="${value}"[^>]*>`, 'i'));
  }
  assert.match(imageNode, /<label[^>]*>内容审查<\/label>[\s\S]*<option value="auto"[\s\S]*<option value="low"/);
  assert.match(imageNode, /quality: isStandardGptImage2 \? gptImageQuality : undefined/);
  assert.match(imageNode, /moderation: isStandardGptImage2 \? gptImageModeration : undefined/);
});

test('GPT Image 2 request and schema preserve validated quality and moderation choices', () => {
  const generation = read('src/services/generation.ts');
  const proxy = read('backend/src/routes/proxy.js');
  const canvas = read('src/components/Canvas.tsx');
  const schema = JSON.parse(read('backend/src/shared/canvasNodeSchema.json'));
  const image = schema.types.find((entry: any) => entry.type === 'image');

  assert.match(generation, /moderation\?: 'auto' \| 'low'/);
  assert.match(proxy, /\['auto', 'high', 'medium', 'low'\]\.includes\(String\(quality/);
  assert.match(proxy, /\['auto', 'low'\]\.includes\(String\(moderation/);
  assert.match(proxy, /form\.append\('quality', normalizedQuality\)/);
  assert.match(proxy, /form\.append\('moderation', normalizedModeration\)/);
  assert.match(canvas, /gptImageQuality: 'auto', gptImageModeration: 'auto'/);
  assert.deepEqual(image.generation.allowedDataFields.gptImageQuality.enum, ['auto', 'high', 'medium', 'low']);
  assert.deepEqual(image.generation.allowedDataFields.gptImageModeration.enum, ['auto', 'low']);
  assert.equal(image.generation.defaults.gptImageQuality, 'auto');
  assert.equal(image.generation.defaults.gptImageModeration, 'auto');
});
