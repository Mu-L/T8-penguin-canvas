import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createThemeCssApplyCoordinator,
  ensureThemeCssLoaded,
  themeCssKeyForStyle,
} from '../src/theme/themeCssLoader.ts';

function read(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('theme styles resolve to lazy CSS chunks and preserve aliases', () => {
  assert.equal(themeCssKeyForStyle('tech'), null);
  assert.equal(themeCssKeyForStyle('soccer-hero'), 'soccer');
  assert.equal(themeCssKeyForStyle('dragon-ball'), 'dragonball');
  assert.equal(themeCssKeyForStyle('saint-seiya'), 'saintseiya');
  assert.equal(themeCssKeyForStyle('farm-story'), 'farm-story');
  assert.equal(themeCssKeyForStyle('garden-defense'), 'garden-defense');
  assert.equal(themeCssKeyForStyle('unknown-custom-theme'), null);
});

test('unknown theme styles are a safe non-blocking no-op', async () => {
  await assert.doesNotReject(ensureThemeCssLoaded('unknown-custom-theme'));
});

test('startup CSS keeps only shared core while every visual theme is dynamically addressable', () => {
  const indexCss = read('../src/styles/index.css');
  const loader = read('../src/theme/themeCssLoader.ts');

  assert.match(indexCss, /@import '\.\/theme-core\.css'/);
  assert.doesNotMatch(indexCss, /@import '\.\/theme-(?!core)/);
  for (const file of [
    'pixel',
    'op',
    'rh',
    'naruto',
    'eva',
    'yyh',
    'slamdunk',
    'soccer',
    'dragonball',
    'saintseiya',
    'tetris',
    'farm-story',
    'garden-defense',
  ]) {
    assert.equal(loader.includes("import('../styles/theme-" + file + ".css')"), true);
  }
});

test('theme CSS switches are double-buffered and only the latest loaded style applies', async () => {
  const pending = new Map<string, {
    promise: Promise<void>;
    resolve: () => void;
  }>();
  const coordinator = createThemeCssApplyCoordinator((style) => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    pending.set(style, { promise, resolve });
    return promise;
  });
  let appliedStyle = 'tech';
  const first = coordinator.apply('farm-story', () => { appliedStyle = 'farm-story'; }, () => {});
  const second = coordinator.apply('garden-defense', () => { appliedStyle = 'garden-defense'; }, () => {});

  assert.equal(appliedStyle, 'tech', 'the previous style remains visible while both chunks load');
  pending.get('farm-story')!.resolve();
  assert.equal(await first, 'stale');
  assert.equal(appliedStyle, 'tech', 'an older resolved chunk must not replace the latest request');
  pending.get('garden-defense')!.resolve();
  assert.equal(await second, 'applied');
  assert.equal(appliedStyle, 'garden-defense');
});

test('theme CSS failure is observable, retryable, and wired to a visible tech fallback', async () => {
  const failure = new Error('chunk unavailable');
  const coordinator = createThemeCssApplyCoordinator(async () => { throw failure; });
  let received: unknown = null;
  const outcome = await coordinator.apply('farm-story', () => assert.fail('failed CSS must not apply'), (error) => {
    received = error;
  });

  assert.equal(outcome, 'failed');
  assert.equal(received, failure);

  const loader = read('../src/theme/themeCssLoader.ts');
  const app = read('../src/App.tsx');
  const canvas = read('../src/components/Canvas.tsx');
  assert.match(loader, /loadedThemeCss\.delete\(key\);[\s\S]{0,160}throw error;/);
  assert.match(app, /void themeCssApplyCoordinator\.apply\([\s\S]*applyThemeTemplate\(currentTemplate, theme\)/);
  assert.match(app, /applyThemeTemplate\(fallbackTemplate, theme\)[\s\S]*setAppliedThemeStyle\('tech'\)/);
  assert.match(app, /data-theme-css-fallback-notice="true"/);
  assert.match(app, /setThemeCssLoadAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(app, /themeStyleOverride=\{appliedThemeStyle\}/);
  assert.match(canvas, /themeStyleOverride \|\| currentTemplate\.visuals\?\.style \|\| style/);
});
