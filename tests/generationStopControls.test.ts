import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(rel: string) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

const imageNode = read('src/components/nodes/ImageNode.tsx');
const videoNode = read('src/components/nodes/VideoNode.tsx');
const seedanceNode = read('src/components/nodes/SeedanceNode.tsx');

test('image generation exposes a stop control and invalidates stale async work', () => {
  assert.match(imageNode, /generationRunRef = useRef\(0\)/);
  assert.match(imageNode, /const runId = nextGenerationRun\(\)/);
  assert.match(imageNode, /const handleStop = \(\) => \{/);
  assert.match(imageNode, /generationRunRef\.current \+= 1/);
  assert.match(imageNode, /isCurrentGenerationRun\(runId\)/);
  assert.match(imageNode, /<Square size=\{11\} \/> 停止/);
  assert.doesNotMatch(imageNode, /disabled=\{status === 'generating'\}/);
});

test('video generation stop invalidates old polling before a new task can update state', () => {
  assert.match(videoNode, /generationRunRef = useRef\(0\)/);
  assert.match(videoNode, /const runId = nextGenerationRun\(\)/);
  assert.match(videoNode, /const startPolling = \(tid: string, runId: number, reporter\?: RunNodeLifecycleReporter\): Promise<void> =>/);
  assert.match(videoNode, /const startFalPolling = \(runId: number, reporter\?: RunNodeLifecycleReporter\): Promise<void> =>/);
  assert.match(videoNode, /await startPolling\(r\.taskId, runId, reporter\)/);
  assert.match(videoNode, /await startFalPolling\(runId, reporter\)/);
  assert.match(videoNode, /generationRunRef\.current \+= 1/);
  assert.match(videoNode, /taskId: null/);
});

test('SD2.0 generation stop invalidates old polling before a new task can update state', () => {
  assert.match(seedanceNode, /generationRunRef = useRef\(0\)/);
  assert.match(seedanceNode, /const runId = nextGenerationRun\(\)/);
  assert.match(seedanceNode, /const startPolling = \([\s\S]*tid: string,[\s\S]*runId: number,[\s\S]*\): Promise<void> =>/);
  assert.match(seedanceNode, /await startPolling\(r\.taskId, runId, submittedProvider, reporter\)/);
  assert.match(seedanceNode, /generationRunRef\.current \+= 1/);
  assert.match(seedanceNode, /taskId: null/);
});
