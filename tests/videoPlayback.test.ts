import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compatibleVideoPreviewUrl,
  LOOPING_VIDEO_DEFAULT_PROPS,
  mergeLoopingVideoProps,
  needsCompatibleVideoPreview,
} from '../src/utils/videoPlayback.ts';

test('LOOPING_VIDEO_DEFAULT_PROPS makes canvas video previews loop by default', () => {
  assert.equal(LOOPING_VIDEO_DEFAULT_PROPS.loop, true);
  assert.equal(LOOPING_VIDEO_DEFAULT_PROPS.playsInline, true);
  assert.equal(LOOPING_VIDEO_DEFAULT_PROPS.preload, 'metadata');
});

test('mergeLoopingVideoProps preserves caller props while keeping loop enabled', () => {
  assert.deepEqual(mergeLoopingVideoProps({ controls: true, muted: false, className: 'w-full' }), {
    loop: true,
    playsInline: true,
    preload: 'metadata',
    controls: true,
    muted: false,
    className: 'w-full',
  });
});

test('local MOV files use a browser-compatible MP4 preview without changing the source URL', () => {
  assert.equal(needsCompatibleVideoPreview('/files/input/camera.MOV'), true);
  assert.equal(needsCompatibleVideoPreview('/files/output/render.mov?revision=2'), true);
  assert.equal(needsCompatibleVideoPreview('https://cdn.example.com/render.mov'), false);
  assert.equal(needsCompatibleVideoPreview('/files/output/render.mp4'), false);
  assert.equal(
    compatibleVideoPreviewUrl('/files/output/render.mov'),
    '/api/files/video-preview?url=%2Ffiles%2Foutput%2Frender.mov',
  );
  assert.equal(compatibleVideoPreviewUrl('/files/output/render.mp4'), '/files/output/render.mp4');
});
