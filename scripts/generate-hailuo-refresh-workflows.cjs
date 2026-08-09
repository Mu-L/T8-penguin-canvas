'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'docs', 'workflows');
const savedAt = '2026-08-09T00:00:00.000Z';

function writeWorkflow(model, title, nodes, edges) {
  const doc = {
    schema: 't8-workflow-fragment',
    version: 1,
    title,
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodeTypes: nodes.map((node) => node.type),
    topologyPreview: {
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type,
        label: node.data.label,
        x: node.position.x + 50,
        y: node.position.y + 50,
      })),
      edges,
    },
    savedAt,
  };
  fs.writeFileSync(path.join(outputDir, `${model}.json`), `${JSON.stringify(doc, null, 2)}\n`);
}

function videoNode(model, label, localPrompt, resolution) {
  return {
    id: model,
    type: 'video',
    position: { x: model.endsWith('-fast') ? 420 : 0, y: model.endsWith('-fast') ? 40 : 0 },
    data: {
      label,
      mainId: 'hailuo-2.3',
      model,
      videoBuiltinSource: 'seedance-nz',
      ratio: '16:9',
      duration: 5,
      resolution,
      localPrompt,
      reuseResult: false,
    },
  };
}

for (const [model, label, prompt] of [
  ['hailuo-h3-t2v', 'Hailuo H3 文生视频', '填写希望生成的视频内容'],
  ['hailuo-h3-i2v', 'Hailuo H3 首尾帧图生视频', ''],
  ['hailuo-h3-multi', 'Hailuo H3 多模态参考', '说明图片、视频和音频参考素材在成片中的作用'],
]) {
  writeWorkflow(model, `${label}（平价AI小屋 · 768P）`, [videoNode(model, label, prompt, '768P')], []);
}

for (const [model, label, uploadLabel, prompt] of [
  [
    'minimax-h3-ow-i2v-fast',
    'MiniMax H3 OW Fast 首帧图生视频',
    '上传首帧图（必须且只能 1 张）',
    '',
  ],
  [
    'minimax-h3-ow-r2v-fast',
    'MiniMax H3 OW Fast 参考生视频',
    '上传参考图（1-9 张，按顺序）',
    '保持参考主体身份、服装和材质一致，镜头缓慢推进',
  ],
]) {
  const uploadId = `${model}-reference`;
  const upload = {
    id: uploadId,
    type: 'upload',
    position: { x: 0, y: 40 },
    data: { label: uploadLabel, uploadType: 'image', lockedUploadType: 'image' },
  };
  const generation = videoNode(model, label, prompt, '480p');
  const edges = [{ id: `${uploadId}-edge`, source: uploadId, target: model }];
  writeWorkflow(model, `${label}（平价AI小屋）`, [upload, generation], edges);
}

console.log('generated 5 Hailuo refresh workflows');
