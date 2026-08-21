'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'docs', 'workflows');
const savedAt = '2026-08-21T00:00:00.000Z';

function preview(nodes, edges) {
  const minX = Math.min(...nodes.map((node) => node.position.x));
  const maxX = Math.max(...nodes.map((node) => node.position.x));
  const span = Math.max(1, maxX - minX);
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.data.label,
      x: Math.round(8 + ((node.position.x - minX) / span) * 84),
      y: 50,
    })),
    edges: edges.map(({ source, target }) => ({ source, target })),
  };
}

function save(name, title, nodes, edges) {
  const workflow = {
    schema: 't8-workflow-fragment',
    version: 1,
    title,
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodeTypes: [...new Set(nodes.map((node) => node.type))],
    topologyPreview: preview(nodes, edges),
    savedAt,
  };
  fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
}

const outputType = (family) => family === 'text' ? 'text' : family === 'video' ? 'video' : 'audio';
const actionDefs = [
  ['flowmusic-generation', '音乐生成', 'audio', { prompt: '电影感电子流行，温暖钢琴与渐进合成器，女声', flowMusicLyrics: '[Verse]\n雨落在未寄出的信上\n\n[Chorus]\n天亮以后我们重新出发', flowMusicVersion: 'lyria-3.5', flowMusicTitle: '天亮以后', flowMusicBpm: 112, flowMusicLength: 30 }],
  ['flowmusic-lyrics', '歌词生成', 'text', { prompt: '创作一首关于雨夜重逢与重新出发的中文流行歌词' }],
  ['flowmusic-upload-audio', '上传音频', 'audio', {}],
  ['flowmusic-extend', '音乐续写', 'audio', { prompt: '自然续写，加入温暖弦乐并保持原有节奏', flowMusicVersion: 'lyria-3.5', flowMusicExtendFrom: 0, flowMusicExtendSeconds: 15 }],
  ['flowmusic-replace', '片段替换', 'audio', { prompt: '将选定片段替换为情绪逐步增强的弦乐过门', flowMusicVersion: 'lyria-3.5', flowMusicStartSeconds: 1, flowMusicEndSeconds: 5 }],
  ['flowmusic-cover', '整曲翻唱', 'audio', { prompt: '改编为克制、细腻的女声爵士版本', flowMusicVersion: 'lyria-3.5', flowMusicStrength: 0.5 }],
  ['flowmusic-stems', '人声伴奏分离', 'file', {}],
  ['flowmusic-download-audio', '下载音频', 'audio', { flowMusicFormat: 'wav' }],
  ['flowmusic-video-clip', '音乐视频', 'video', { flowMusicPreset: 'modern' }],
];

for (const [operation, label, family, fields] of actionDefs) {
  const actionNode = {
    id: `${operation}-action`,
    type: 'audio',
    position: { x: operation === 'flowmusic-generation' || operation === 'flowmusic-lyrics' ? 40 : 440, y: 40 },
    data: {
      label: `Lyria · ${label}`,
      audioProviderMode: 'lyria',
      apiModel: 'flowmusic',
      flowMusicOperation: operation,
      flowMusicClipId: '',
      reuseResult: false,
      ...fields,
    },
  };
  const nodes = [];
  const edges = [];
  if (operation === 'flowmusic-upload-audio') {
    nodes.push({ id: `${operation}-source`, type: 'upload', position: { x: 0, y: 40 }, data: { label: '上传参考音频', uploadType: 'audio', lockedUploadType: 'audio' } });
    edges.push({ id: `${operation}-source-edge`, source: `${operation}-source`, target: actionNode.id });
  } else if (!['flowmusic-generation', 'flowmusic-lyrics'].includes(operation)) {
    nodes.push({
      id: `${operation}-source`,
      type: 'audio',
      position: { x: 0, y: 40 },
      data: {
        label: 'Lyria · 先生成可编辑的原生 clip',
        audioProviderMode: 'lyria',
        apiModel: 'flowmusic',
        flowMusicOperation: 'flowmusic-generation',
        flowMusicVersion: 'lyria-3.5',
        prompt: '电影感器乐流行，温暖钢琴与克制电子节奏，无人声',
        flowMusicBpm: 110,
        flowMusicLength: 8,
        reuseResult: false,
      },
    });
    edges.push({ id: `${operation}-clip-edge`, source: `${operation}-source`, target: actionNode.id });
  }
  nodes.push(actionNode);
  if (family !== 'file') {
    nodes.push({ id: `${operation}-output`, type: 'output', position: { x: 860, y: 40 }, data: { label: `${label}结果`, outputType: outputType(family) } });
    edges.push({ id: `${operation}-output-edge`, source: actionNode.id, target: `${operation}-output` });
  }
  save(operation, `Lyria · ${operation}`, nodes, edges);
}

save(
  'zhenzhen-image-gk-v2-edit',
  'Grok Image · zhenzhen-image-gk-v2-edit 图像编辑',
  [
    { id: 'gk-v2-edit-source', type: 'upload', position: { x: 0, y: 40 }, data: { label: '上传 1–3 张参考图', uploadType: 'image', lockedUploadType: 'image' } },
    { id: 'gk-v2-edit', type: 'image', position: { x: 420, y: 40 }, data: { label: 'Grok Image v2 Edit', model: 'grok-image', apiModel: 'zhenzhen-image-gk-v2-edit', imageBuiltinSource: 'seedance-nz', prompt: '保留主体身份与构图，将场景改为雨夜电影灯光', aspectRatio: 'auto', grokV2EditResolution: '2k', grokV2ImageCount: 1, grokV2EditNsfwCheck: false, imageOnlyOutput: true, reuseResult: false } },
    { id: 'gk-v2-edit-output', type: 'output', position: { x: 840, y: 40 }, data: { label: '编辑图片', outputType: 'image' } },
  ],
  [
    { id: 'gk-v2-edit-source-edge', source: 'gk-v2-edit-source', target: 'gk-v2-edit' },
    { id: 'gk-v2-edit-output-edge', source: 'gk-v2-edit', target: 'gk-v2-edit-output' },
  ],
);

console.log(`generated ${actionDefs.length + 1} workflows in ${outDir}`);
