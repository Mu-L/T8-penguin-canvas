import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('simple high-traffic nodes route raw media through shared lazy components', () => {
  const audioNodes = [
    'FalToolboxNode',
    'GrokOAuthAgentNode',
    'ComfyUIStoreNode',
    'PickFromSetNode',
    'RunningHubNode',
    'RHToolboxNode',
    'RHToolsNode',
    'OutputNode',
    'UploadNode',
    'StoryNode',
    'AudioNode',
  ];
  const videoNodes = [
    'GrokOAuthAgentNode',
    'ComfyUIStoreNode',
    'StoryNode',
    'LLMNode',
    'ImageNode',
    'AudioNode',
    'ScriptMasterNode',
  ];

  for (const node of new Set([...audioNodes, ...videoNodes])) {
    const source = read('../src/components/nodes/' + node + '.tsx');
    assert.doesNotMatch(source, /<(?:audio|video)\b/, node + ' has no raw media tags');
    if (audioNodes.includes(node)) {
      assert.match(source, /import LazyAudio from '\.\.\/LazyAudio'/, node + ' imports LazyAudio');
      assert.match(source, /<LazyAudio\b[\s\S]*controls/, node + ' preserves audio controls');
    }
    if (videoNodes.includes(node)) {
      assert.match(source, /import LazyVideo from '\.\.\/LazyVideo'/, node + ' imports LazyVideo');
      assert.match(source, /<LazyVideo\b[\s\S]*controls/, node + ' preserves video controls');
    }
  }
});


test('high-traffic canvas image previews route through the shared image scheduler', () => {
  const imageNodes = [
    'ImageNode',
    'StoryNode',
    'ScriptMasterNode',
    'PrevisStudioNode',
  ];

  for (const node of imageNodes) {
    const source = read('../src/components/nodes/' + node + '.tsx');
    assert.doesNotMatch(source, /<img\b/, node + ' has no raw image tags');
    assert.match(source, /import SmartImage from '\.\.\/SmartImage'/, node + ' imports SmartImage');
    assert.match(source, /<SmartImage\b/, node + ' renders SmartImage');
  }
});

test('lazy media retains a pending first-play intent while a shared slot is busy', () => {
  const lazyVideo = read('../src/components/LazyVideo.tsx');
  const lazyAudio = read('../src/components/LazyAudio.tsx');

  for (const source of [lazyVideo, lazyAudio]) {
    assert.match(source, /const pendingPlayRef = useRef/);
    assert.match(source, /const requestPendingPlay = \(\) =>/);
    assert.match(source, /pendingPlayRef\.current = true/);
    assert.match(source, /onCanPlay=\{\(event\) => \{[\s\S]*event\.currentTarget\.play\(\)/);
  }
});

test('autoplay video pauses offscreen and resumes only while play intent remains active', () => {
  const lazyVideo = read('../src/components/LazyVideo.tsx');
  const lazyAudio = read('../src/components/LazyAudio.tsx');

  assert.match(lazyVideo, /onVisibilityChange: autoPlay/);
  assert.match(lazyVideo, /visibilityPauseRef\.current = true/);
  assert.match(lazyVideo, /video\.pause\(\)/);
  assert.match(lazyVideo, /playIntentRef\.current && video\.getAttribute\('src'\)/);
  assert.match(lazyVideo, /void video\.play\(\)\.catch/);
  assert.doesNotMatch(lazyAudio, /onVisibilityChange/);
});
