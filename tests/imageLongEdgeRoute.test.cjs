const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');
const imageOpsRouter = require('../backend/src/routes/imageOps');
const config = require('../backend/src/config');

async function withServer(run) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/image', imageOpsRouter);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('resize-long-edge keeps aspect ratio and writes a 1024px long edge', async () => {
  const input = await sharp({
    create: {
      width: 1600,
      height: 800,
      channels: 4,
      background: { r: 20, g: 80, b: 140, alpha: 1 },
    },
  }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${input.toString('base64')}`;
  let outputPath = '';

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/image/resize-long-edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: dataUrl, longEdge: 1024 }),
    });
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.resized, true);
    assert.equal(json.data.width, 1024);
    assert.equal(json.data.height, 512);
    assert.match(json.data.imageUrl, /^\/files\/output\/.+\.png$/);

    outputPath = path.join(config.OUTPUT_DIR, path.basename(json.data.imageUrl));
    const metadata = await sharp(outputPath).metadata();
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, 512);
  });

  if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
});

test('resize-long-edge does not enlarge images already below the selected limit', async () => {
  const input = await sharp({
    create: {
      width: 320,
      height: 180,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${input.toString('base64')}`;

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/image/resize-long-edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: dataUrl, longEdge: 2048 }),
    });
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.data.resized, false);
    assert.equal(json.data.imageUrl, dataUrl);
    assert.equal(json.data.width, 320);
    assert.equal(json.data.height, 180);
  });
});

test('resize-long-edge preserves the displayed ratio of EXIF-rotated photos', async () => {
  const input = await sharp({
    create: {
      width: 1600,
      height: 800,
      channels: 3,
      background: { r: 120, g: 60, b: 30 },
    },
  }).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
  const dataUrl = `data:image/jpeg;base64,${input.toString('base64')}`;
  let outputPath = '';

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/image/resize-long-edge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: dataUrl, longEdge: 1024 }),
      });
      const json = await response.json();
      assert.equal(response.status, 200);
      assert.equal(json.success, true);
      assert.equal(json.data.width, 512);
      assert.equal(json.data.height, 1024);
      outputPath = path.join(config.OUTPUT_DIR, path.basename(json.data.imageUrl));

      const metadata = await sharp(outputPath).metadata();
      assert.equal(metadata.width, 512);
      assert.equal(metadata.height, 1024);
    });
  } finally {
    if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});
