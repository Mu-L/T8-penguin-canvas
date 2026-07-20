import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVideoEditExecutionInputSnapshot,
  videoEditExecutionInputDigest,
  videoEditExecutionInputMatchesDigest,
} from '../src/utils/videoEditExecution.ts';

function snapshot() {
  return createVideoEditExecutionInputSnapshot({
    mode: 'compose',
    clips: [{ id: 'clip-a', url: '/files/a.mp4', name: 'a.mp4', trimStart: 0, trimEnd: 1 }] as any,
    settings: { aspect: '16:9', resolution: '1080p', transition: 'none', transitionDuration: 0, filter: 'none', audio: 'keep', autoCreateOutputNode: false } as any,
    timelineV2: { version: 2, assets: [], tracks: [] } as any,
    renderPlan: { version: 1, duration: 1, videoSegments: [], audioSegments: [], textSegments: [] } as any,
    operationSettings: [{ aspect: '16:9', resolution: '1080p', transition: 'none', transitionDuration: 0, filter: 'none', audio: 'keep', autoCreateOutputNode: false }] as any,
  });
}

test('video edit execution input digest is deterministic and rejects changed inputs', () => {
  const first = snapshot();
  const second = snapshot();
  const digest = videoEditExecutionInputDigest(first);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(videoEditExecutionInputDigest(second), digest);
  assert.equal(videoEditExecutionInputMatchesDigest(first, digest), true);

  const changed = structuredClone(first) as any;
  changed.clips[0].trimEnd = 0.5;
  assert.equal(videoEditExecutionInputMatchesDigest(changed, digest), false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.clips[0]), true);
});
