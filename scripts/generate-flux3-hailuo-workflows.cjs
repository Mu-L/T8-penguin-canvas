'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'docs', 'workflows');
const savedAt = '2026-08-08T08:00:00.000Z';

const writeWorkflow = (model, title, nodes, edges) => {
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
};

const uploadNode = (id, label, uploadType, x, y) => ({
  id,
  type: 'upload',
  position: { x, y },
  data: { label, uploadType, lockedUploadType: uploadType },
});

const edge = (model, source, target) => ({ id: `${model}-${source}-edge`, source, target });

const hailuoModels = [
  ['hailuo-h3-global-t2v', 'Hailuo H3 海外文生视频', 't2v'],
  ['hailuo-h3-global-i2v', 'Hailuo H3 海外首尾帧图生视频', 'i2v'],
  ['hailuo-h3-global-multi', 'Hailuo H3 海外多模态参考视频', 'multi'],
];

for (const [model, title, mode] of hailuoModels) {
  const uploads = mode === 'i2v'
    ? [
        uploadNode(`${model}-first-image`, '上传首帧图（必填）', 'image', 0, 0),
        uploadNode(`${model}-last-image`, '上传尾帧图（可选）', 'image', 0, 210),
      ]
    : mode === 'multi'
      ? [
          uploadNode(`${model}-image`, '上传参考图（最多 9 张）', 'image', 0, 0),
          uploadNode(`${model}-video`, '上传参考视频（最多 3 个）', 'video', 0, 210),
          uploadNode(`${model}-audio`, '上传参考音频（最多 3 个）', 'audio', 0, 420),
        ]
      : [];
  const generation = {
    id: model,
    type: 'video',
    position: { x: uploads.length ? 440 : 0, y: mode === 'multi' ? 170 : 40 },
    data: {
      label: title,
      mainId: 'hailuo-2.3',
      model,
      videoBuiltinSource: 'seedance-nz',
      ratio: '16:9',
      duration: 5,
      resolution: '2K',
      localPrompt: mode === 'i2v' ? '镜头缓慢推进，保持主体身份、构图和材质稳定' : mode === 'multi' ? '使用 @Image 1 保持主体，参考 @Video 1 的运镜并跟随 @Audio 1 的节拍' : '电影感镜头缓慢推进，主体自然运动，画面稳定连贯',
      reuseResult: false,
    },
  };
  writeWorkflow(model, `${title}（贞贞的平价AI小屋）`, [...uploads, generation], uploads.map((node) => edge(model, node.id, model)));
}

const fluxModels = [
  'flux-3-video-t2v',
  'flux-3-video-i2v',
  'flux-3-video-v2v',
  'flux-3-video-draft-enhance',
  'flux-3-video-global-t2v',
  'flux-3-video-global-i2v',
  'flux-3-video-global-v2v',
  'flux-3-video-global-draft-enhance',
];

for (const model of fluxModels) {
  const global = model.includes('-global-');
  const mode = model.endsWith('-draft-enhance') ? 'draft-enhance' : model.endsWith('-v2v') ? 'v2v' : model.endsWith('-i2v') ? 'i2v' : 't2v';
  const modeLabel = mode === 't2v' ? '文生视频' : mode === 'i2v' ? '关键帧图生视频' : mode === 'v2v' ? '视频编辑' : '草稿增强';
  const title = `FLUX 3 ${global ? '海外' : '国内'}${modeLabel}`;
  const uploads = mode === 'i2v'
    ? [uploadNode(`${model}-images`, '上传关键帧图片（1-10 张）', 'image', 0, 40)]
    : mode === 'v2v'
      ? [uploadNode(`${model}-video`, '上传输入 MP4（恰好 1 个）', 'video', 0, 40)]
      : [];
  const generation = {
    id: model,
    type: 'video',
    position: { x: uploads.length ? 440 : 0, y: 40 },
    data: {
      label: title,
      mainId: 'flux-3-video',
      model,
      videoBuiltinSource: 'seedance-nz',
      ratio: 'auto',
      duration: 5,
      resolution: 'hd',
      localPrompt: mode === 'draft-enhance' ? '' : mode === 'v2v' ? '保持主体身份与动作连续，按要求修改画面' : mode === 'i2v' ? '镜头缓慢推进，按关键帧顺序保持连贯运动' : '电影感极简摄影棚内，纸雕主体缓慢旋转，镜头平稳推进',
      flux3Draft: false,
      flux3AudioMode: 'api_default',
      flux3SafetyTolerance: 'api_default',
      flux3DraftCache: '',
      reuseResult: false,
    },
  };
  writeWorkflow(model, `${title}（贞贞的平价AI小屋）`, [...uploads, generation], uploads.map((node) => edge(model, node.id, model)));
}

console.log(`generated ${hailuoModels.length + fluxModels.length} workflows`);
