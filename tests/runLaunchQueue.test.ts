import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

let createRunLaunchQueue: () => {
  readonly busy: boolean;
  readonly size: number;
  acquire: () => Promise<() => void>;
};

test.before(async () => {
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: ['src/utils/runLaunchQueue.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  const source = result.outputFiles[0].text;
  ({ createRunLaunchQueue } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
});

test('launch queue serializes preparation but releases the next launch before task completion', async () => {
  const queue = createRunLaunchQueue();
  const events: string[] = [];
  const firstRelease = await queue.acquire();
  events.push('first-prepared');
  const secondAcquire = queue.acquire().then((release) => {
    events.push('second-prepared');
    return release;
  });

  await Promise.resolve();
  assert.deepEqual(events, ['first-prepared']);
  assert.equal(queue.busy, true);
  assert.equal(queue.size, 2);

  firstRelease();
  const secondRelease = await secondAcquire;
  assert.deepEqual(events, ['first-prepared', 'second-prepared']);
  assert.equal(queue.size, 1);

  secondRelease();
  assert.equal(queue.busy, false);
  assert.equal(queue.size, 0);
});
