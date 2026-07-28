import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Copy,
  Download,
  Image as ImageIcon,
  Loader2,
  LogIn,
  LogOut,
  Maximize2,
  MessageCircle,
  Mic,
  Music2,
  PanelRightOpen,
  Library,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Upload,
  Video,
  Wand2,
  X,
} from 'lucide-react';
import { PORT_COLOR } from '../../config/portTypes';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { createCanvasNodeRunRequestId, requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import type { RunNodeLifecycleReporter } from '../../types/project';
import * as api from '../../services/api';
import {
  completeGrokOAuthLogin,
  getGrokOAuthStatus,
  GROK_OAUTH_PRIVATE_DISABLED_MESSAGE,
  logoutGrokOAuth,
  pollGrokOAuthLogin,
  startGrokOAuthLogin,
  streamGrokOAuthAgent,
  type GrokOAuthMediaResult,
  type GrokOAuthStatus,
  type GrokOAuthStreamEvent,
} from '../../services/grokOAuth';
import { logBus } from '../../stores/logs';
import { taskCompletionSound } from '../../stores/taskCompletionSound';
import { useThemeStore } from '../../stores/theme';
import { uploadFile } from '../../services/generation';
import { createReadableStudioPalette } from '../../utils/readableStudioPalette';
import MaterialPreviewSection from './MaterialPreviewSection';
import MentionPromptInput from './MentionPromptInput';
import SmartImage from '../SmartImage';
import {
  materialMentionKey,
  resolveMediaMentions,
  tokenForMaterial,
  type MediaMention,
} from './mediaMentions';
import { useOrderedMaterials } from './useOrderedMaterials';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useUpstreamMaterials, type Material, type UpstreamMaterials } from './useUpstreamMaterials';
import type { SendableMaterial } from '../../utils/sendMaterials';

type GrokOAuthMode = 'chat' | 'image' | 'video' | 'tts' | 'stt';
type GrokArtifactKind = 'text' | 'image' | 'video' | 'audio' | 'transcript';
type GrokArtifactTab = 'image' | 'video' | 'audio' | 'text';
type GrokUploadKind = 'auto' | 'image' | 'video' | 'audio';

interface GrokAgentMessage {
  id: string;
  turnId?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  mode?: GrokOAuthMode;
  status?: 'running' | 'success' | 'error';
  command?: string;
  progress?: number;
  artifactIds?: string[];
  createdAt: number;
}

interface GrokAgentArtifact {
  id: string;
  refId?: string;
  turnId?: string;
  kind: GrokArtifactKind;
  title: string;
  text?: string;
  url?: string;
  urls?: string[];
  prompt?: string;
  model?: string;
  mode?: GrokOAuthMode;
  command?: string;
  parentId?: string;
  sourceArtifactIds?: string[];
  revision?: number;
  status?: string;
  progress?: number;
  requestId?: string;
  message?: string;
  createdAt: number;
  publishedAt?: number;
}

const MODES: Array<{ id: GrokOAuthMode; label: string; icon: any; hint: string }> = [
  { id: 'chat', label: '对话', icon: MessageCircle, hint: '流式聊天 / 改提示词 / 分析素材' },
  { id: 'image', label: '图像', icon: ImageIcon, hint: '生成或编辑图片' },
  { id: 'video', label: '视频', icon: Video, hint: '文生视频 / 图生视频' },
  { id: 'tts', label: 'TTS', icon: Music2, hint: '文字转语音' },
  { id: 'stt', label: 'STT', icon: Mic, hint: '音频转文字' },
];

const SLASH_COMMANDS: Array<{ command: string; aliases: string[]; mode: GrokOAuthMode; label: string; hint: string; insert: string }> = [
  { command: 'image', aliases: ['image', 'img', '图像', '图片', '改图'], mode: 'image', label: '/image', hint: '生成图片，或 @ 图像继续改图', insert: '/image ' },
  { command: 'video', aliases: ['video', 'vid', '视频', '图生视频'], mode: 'video', label: '/video', hint: '文生视频，或 @ 图像/视频生成视频', insert: '/video ' },
  { command: 'audio', aliases: ['audio', '音频'], mode: 'tts', label: '/audio', hint: '音频生成入口；公开壳默认按 TTS 参数发送', insert: '/audio ' },
  { command: 'tts', aliases: ['tts', 'voice', '配音', '朗读'], mode: 'tts', label: '/tts', hint: '文本转语音', insert: '/tts ' },
  { command: 'stt', aliases: ['stt', 'transcribe', '转写', '听写'], mode: 'stt', label: '/stt', hint: '音频转文字，支持 @ 音频产物', insert: '/stt ' },
];

const CHAT_MODELS = ['grok-4.3', 'grok-4', 'grok-4-fast-non-reasoning', 'grok-4.20-reasoning'];
const IMAGE_MODELS = ['grok-imagine-image', 'grok-imagine-image-quality'];
const DEFAULT_TEXT_VIDEO_MODEL = 'grok-imagine-video';
const DEFAULT_IMAGE_VIDEO_MODEL = 'grok-imagine-video-1.5-preview';
const VIDEO_MODELS = [DEFAULT_TEXT_VIDEO_MODEL, DEFAULT_IMAGE_VIDEO_MODEL];
const VIDEO_MODEL_LABELS: Record<string, string> = {
  [DEFAULT_TEXT_VIDEO_MODEL]: 'grok-imagine-video（文生/旧图生）',
  [DEFAULT_IMAGE_VIDEO_MODEL]: 'grok-imagine-video-1.5-preview（图生）',
};
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
const RESOLUTIONS = ['720p', '480p', '1k', '2k'];
const MAX_AGENT_MESSAGES = 160;
const MAX_AGENT_ARTIFACTS = 80;
const MAX_DELETED_AGENT_ARTIFACT_KEYS = 600;
const MAX_LOCAL_MATERIALS = 24;
const MAX_GROK_CONTEXT_LIMIT = 80;
const DEFAULT_GROK_CONTEXT_LIMIT = 30;
const CONTEXT_SUMMARY_MAX_CHARS = 3600;
const DEFAULT_GROK_TEMPERATURE = 0.7;
const DEFAULT_GROK_TOP_P = 1;
const DEFAULT_GROK_TOP_K = 0;
const DEFAULT_GROK_MAX_OUTPUT_TOKENS = 2048;
const GROK_UPLOAD_ACCEPT: Record<GrokUploadKind, string> = {
  auto: 'image/*,video/*,audio/*',
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
};

interface GrokChatSettings {
  contextLimit: number;
  temperature: number;
  topP: number;
  topK: number;
  maxOutputTokens: number;
}

const handleStyle: CSSProperties = {
  width: 16,
  height: 16,
  border: '2px solid rgba(255,247,219,0.96)',
  boxShadow: '0 0 0 2px rgba(5,12,30,0.82), 0 0 14px rgba(255,224,113,0.42)',
  zIndex: 120,
};

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function asStringArray(value: any): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  const text = String(value || '').trim();
  return text ? [text] : [];
}

function clampNumber(value: any, fallback: number, min: number, max: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function clampInteger(value: any, fallback: number, min: number, max: number) {
  return Math.round(clampNumber(value, fallback, min, max));
}

function buildChatGenerationPayload(settings: GrokChatSettings) {
  const payload: Record<string, number> = {
    temperature: settings.temperature,
    top_p: settings.topP,
    topP: settings.topP,
    max_tokens: settings.maxOutputTokens,
    max_output_tokens: settings.maxOutputTokens,
    maxOutputTokens: settings.maxOutputTokens,
  };
  if (settings.topK > 0) {
    payload.top_k = settings.topK;
    payload.topK = settings.topK;
  }
  return payload;
}

function dedupeStringArray(value: any): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of asStringArray(value)) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function inferUploadKind(file: File, fallback: GrokUploadKind = 'auto'): Exclude<GrokUploadKind, 'auto'> | null {
  const type = String(file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/.test(name)) return 'image';
  if (type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv)$/.test(name)) return 'video';
  if (type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/.test(name)) return 'audio';
  return fallback === 'auto' ? null : fallback;
}

function sanitizeLocalMaterials(value: any): Material[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index): Material | null => {
      const kind = ['image', 'video', 'audio'].includes(item?.kind) ? item.kind as Exclude<GrokUploadKind, 'auto'> : null;
      const url = String(item?.url || '').trim();
      if (!kind || !url) return null;
      return {
        id: String(item?.id || `grok-local-${kind}-${index}`),
        kind,
        url,
        sourceNodeId: String(item?.sourceNodeId || 'grok-local'),
        origin: 'local' as const,
        label: String(item?.label || item?.filename || url.split(/[?#]/)[0].split('/').pop() || `${kind}${index + 1}`),
      };
    })
    .filter((item): item is Material => !!item)
    .slice(-MAX_LOCAL_MATERIALS);
}

function buildPrompt(localPrompt: string, upstreamTexts: Material[], mentions: MediaMention[], mentionMaterials: Material[]) {
  const upstreamText = upstreamTexts.map((item) => item.url).filter(Boolean).join('\n\n').trim();
  const resolvedLocal = resolveMediaMentions(localPrompt || '', mentions || [], mentionMaterials).trim();
  return [upstreamText, resolvedLocal].filter(Boolean).join('\n\n').trim();
}

function normalizePromptMentionTokens(text: string, mentions: MediaMention[], materials: Material[]): { text: string; mentions: MediaMention[]; changed: boolean } {
  if (!mentions.length) return { text, mentions, changed: false };
  const byKey = new Map<string, Material>();
  for (const material of materials) byKey.set(materialMentionKey(material), material);

  let nextText = text;
  let delta = 0;
  let changed = false;
  const nextMentions: MediaMention[] = [];
  for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
    const material = byKey.get(mention.materialKey);
    if (!material) continue;
    const start = mention.start + delta;
    const end = mention.end + delta;
    if (nextText.slice(start, end) !== mention.token) continue;
    const token = tokenForMaterial(material, materials);
    if (token !== mention.token) {
      nextText = `${nextText.slice(0, start)}${token}${nextText.slice(end)}`;
      delta += token.length - mention.token.length;
      changed = true;
    }
    nextMentions.push({ ...mention, token, start, end: start + token.length });
  }
  return { text: nextText, mentions: nextMentions, changed };
}

function parseSlashCommand(prompt: string): { command: string; mode: GrokOAuthMode; body: string; bodyStart: number } | null {
  const textValue = String(prompt || '');
  const match = textValue.match(/^\s*\/([^\s/]+)(?:\s+|$)/);
  if (!match) return null;
  const raw = String(match[1] || '').toLowerCase();
  const def = SLASH_COMMANDS.find((item) => item.aliases.map((alias) => alias.toLowerCase()).includes(raw));
  if (!def) return null;
  const bodyStart = match[0].length;
  return {
    command: def.command,
    mode: def.mode,
    body: textValue.slice(bodyStart),
    bodyStart,
  };
}

function slashCommandFromMode(mode: GrokOAuthMode) {
  if (mode === 'image') return 'image';
  if (mode === 'video') return 'video';
  if (mode === 'tts') return 'tts';
  if (mode === 'stt') return 'stt';
  return '';
}

function shiftMentionsForSlashBody(mentions: MediaMention[], bodyStart: number): MediaMention[] {
  if (!bodyStart) return mentions;
  return mentions
    .filter((mention) => mention.start >= bodyStart && mention.end > bodyStart)
    .map((mention) => ({ ...mention, start: mention.start - bodyStart, end: mention.end - bodyStart }))
    .sort((a, b) => a.start - b.start);
}

function normalizeSlashMode(prompt: string, current: GrokOAuthMode, hasAudio: boolean): { mode: GrokOAuthMode; command: string; bodyPrompt: string; bodyStart: number; explicit: boolean } {
  const slash = parseSlashCommand(prompt);
  if (slash) return { mode: slash.mode, command: slash.command, bodyPrompt: slash.body, bodyStart: slash.bodyStart, explicit: true };
  const inferred = inferModeFromPrompt(prompt, current, hasAudio);
  const command = inferred === 'tts' ? 'tts' : inferred === 'stt' ? 'stt' : inferred === 'image' ? 'image' : inferred === 'video' ? 'video' : 'chat';
  return { mode: inferred, command, bodyPrompt: prompt, bodyStart: 0, explicit: false };
}

function artifactUrl(artifact: GrokAgentArtifact): string {
  const urls = dedupeStringArray(artifact.urls || artifact.url);
  return String(artifact.url || urls[0] || '').trim();
}

function artifactMaterialKind(artifact: GrokAgentArtifact): Material['kind'] | null {
  if (artifact.kind === 'image') return 'image';
  if (artifact.kind === 'video') return 'video';
  if (artifact.kind === 'audio') return 'audio';
  if (artifact.kind === 'text' || artifact.kind === 'transcript') return artifact.text ? 'text' : null;
  return null;
}

function artifactTokenPrefix(kind: GrokArtifactKind): string {
  if (kind === 'image') return 'img';
  if (kind === 'video') return 'vid';
  if (kind === 'audio') return 'aud';
  return 'txt';
}

function nextArtifactRefId(kind: GrokArtifactKind, artifacts: GrokAgentArtifact[]): string {
  const prefix = artifactTokenPrefix(kind);
  let max = 0;
  for (const item of artifacts) {
    const match = String(item.refId || '').match(new RegExp(`^@${prefix}(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1] || 0));
  }
  return `@${prefix}${max + 1}`;
}

function isStableArtifactRefId(refId: any, kind: GrokArtifactKind): refId is string {
  const prefix = artifactTokenPrefix(kind);
  return new RegExp(`^@${prefix}\\d+$`).test(String(refId || '').trim());
}

function assignMissingArtifactRefIds(artifacts: GrokAgentArtifact[]): GrokAgentArtifact[] {
  const counters: Record<string, number> = { img: 0, vid: 0, aud: 0, txt: 0 };
  const used = new Set<string>();
  const out = artifacts.map((artifact) => {
    const prefix = artifactTokenPrefix(artifact.kind);
    const refId = String(artifact.refId || '').trim();
    const match = refId.match(new RegExp(`^@${prefix}(\\d+)$`));
    if (match && !used.has(refId)) {
      counters[prefix] = Math.max(counters[prefix] || 0, Number(match[1] || 0));
      used.add(refId);
      return { ...artifact, refId };
    }
    let next = '';
    do {
      counters[prefix] = (counters[prefix] || 0) + 1;
      next = `@${prefix}${counters[prefix]}`;
    } while (used.has(next));
    used.add(next);
    return { ...artifact, refId: next };
  });
  return out;
}

function ensureArtifactRefId(artifact: GrokAgentArtifact, artifacts: GrokAgentArtifact[]): GrokAgentArtifact {
  const current = artifacts.find((item) => item.id === artifact.id) || artifact;
  if (isStableArtifactRefId(current.refId, current.kind)) return current;
  return { ...current, refId: nextArtifactRefId(current.kind, artifacts.filter((item) => item.id !== current.id)) };
}

function artifactToMaterial(artifact: GrokAgentArtifact, nodeId: string): (Material & { mentionKey?: string; mentionToken?: string; artifactId?: string }) | null {
  const kind = artifactMaterialKind(artifact);
  if (!kind) return null;
  const url = kind === 'text' ? String(artifact.text || '').trim() : artifactUrl(artifact);
  if (!url) return null;
  if (!isStableArtifactRefId(artifact.refId, artifact.kind)) return null;
  const refId = artifact.refId;
  return {
    id: `grok-artifact:${artifact.id}`,
    kind,
    url,
    sourceNodeId: nodeId,
    origin: 'local',
    label: `${refId} · ${artifact.title || artifactKindLabel(artifact.kind)}`,
    mentionKey: `artifact:${artifact.id}`,
    mentionToken: refId,
    artifactId: artifact.id,
  };
}

function artifactToSendableMaterial(artifact: GrokAgentArtifact, nodeId: string): SendableMaterial | null {
  const id = artifact.id || makeId('grok-artifact-send');
  const title = artifact.title || artifactKindLabel(artifact.kind);
  const sourceMeta = {
    sourceNodeId: nodeId,
    sourceType: 'grok-oauth-agent',
  };
  if (artifact.kind === 'text' || artifact.kind === 'transcript') {
    const text = String(artifact.text || artifact.prompt || '').trim();
    if (!text) return null;
    return {
      id,
      kind: 'text',
      text,
      name: title,
      ...sourceMeta,
    };
  }
  const kind = artifactMaterialKind(artifact);
  const url = artifactUrl(artifact);
  if (!kind || kind === 'text' || !url) return null;
  return {
    id,
    kind,
    url,
    name: title || downloadName(url, 'grok-oauth-output'),
    ...sourceMeta,
  };
}

function openArtifactSendModal(artifact: GrokAgentArtifact, nodeId: string) {
  const material = artifactToSendableMaterial(artifact, nodeId);
  if (!material) {
    logBus.warn('这个产物没有可发送的内容', `grok:${nodeId}`);
    return;
  }
  window.dispatchEvent(new CustomEvent('penguin:open-send-materials', {
    detail: {
      materials: [material],
      sourceLabel: `Grok 产物 · ${material.name || artifactKindLabel(artifact.kind)}`,
      defaultMode: artifact.kind === 'text' || artifact.kind === 'transcript' ? 'upload' : 'output',
    },
  }));
}

async function saveArtifactToResourceLibrary(artifact: GrokAgentArtifact, nodeId: string): Promise<string> {
  const material = artifactToSendableMaterial(artifact, nodeId);
  if (!material) throw new Error('这个产物没有可保存的内容');
  const title = material.name || artifact.title || artifactKindLabel(artifact.kind);
  const tags = ['Grok OAuth', 'Agent'];
  const sourceNodeId = material.sourceNodeId || nodeId;
  let result: any;
  if (material.kind === 'text') {
    result = await api.addResourceSet({
      materialSetKind: 'text',
      materialSetItems: [{ id: material.id, kind: 'text', text: material.text || '', name: title }],
      title,
      tags,
      sourceNodeId,
      favorite: false,
    });
  } else {
    result = await api.addResourceItem({
      kind: material.kind,
      url: material.url || '',
      title,
      tags,
      sourceNodeId,
      favorite: false,
    });
  }
  if (!result?.success) throw new Error(result?.error || '保存到资源库失败');
  window.dispatchEvent(new CustomEvent('penguin:resources-changed'));
  return Boolean((result as any).duplicate || result.data?.duplicate) ? '资源库已有' : '已入库';
}

function referencedArtifactIds(mentions: MediaMention[], materials: Material[]): string[] {
  const byKey = new Map<string, string>();
  for (const material of materials) {
    const artifactId = String((material as any).artifactId || '').trim();
    if (!artifactId) continue;
    byKey.set(materialMentionKey(material), artifactId);
  }
  return Array.from(new Set(mentions.map((mention) => byKey.get(mention.materialKey)).filter(Boolean) as string[]));
}

function referencedMediaByMentions(mentions: MediaMention[], materials: Material[]): Pick<UpstreamMaterials, 'images' | 'videos' | 'audios'> {
  const byKey = new Map<string, Material>();
  for (const material of materials) byKey.set(materialMentionKey(material), material);
  const refs: Pick<UpstreamMaterials, 'images' | 'videos' | 'audios'> = { images: [], videos: [], audios: [] };
  const seen = new Set<string>();
  for (const mention of mentions) {
    const material = byKey.get(mention.materialKey);
    if (!material || !['image', 'video', 'audio'].includes(material.kind)) continue;
    const key = `${material.kind}:${material.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (material.kind === 'image') refs.images.push(material);
    if (material.kind === 'video') refs.videos.push(material);
    if (material.kind === 'audio') refs.audios.push(material);
  }
  return refs;
}

function referencedFirstUrls(referenced: Material[], fallback: Material[]): string[] {
  return dedupeStringArray([
    ...referenced.map((item) => item.url),
    ...fallback.map((item) => item.url),
  ]);
}

function materialUrls(materials: Material[]): string[] {
  return dedupeStringArray(materials.map((item) => item.url));
}

function isPrivateDisabledError(message: string) {
  return String(message || '').includes(GROK_OAUTH_PRIVATE_DISABLED_MESSAGE);
}

function normalizeGrokVideoModel(model: any) {
  const text = String(model || '').trim();
  if (text === 'grok-image-video-1.5-preview' || text === 'grok-imagine-video-1.5-2026-05-30') return DEFAULT_IMAGE_VIDEO_MODEL;
  return text || DEFAULT_TEXT_VIDEO_MODEL;
}

function isGrokImageOnlyVideoModel(model: any) {
  return normalizeGrokVideoModel(model) === DEFAULT_IMAGE_VIDEO_MODEL;
}

function inferModeFromPrompt(prompt: string, current: GrokOAuthMode, hasAudio: boolean): GrokOAuthMode {
  const text = String(prompt || '').toLowerCase();
  if (/\/\s*image|#image|生成图片|生成图像|画一张|出图|改图|修图/.test(text)) return 'image';
  if (/\/\s*video|#video|生成视频|做成视频|图生视频|文生视频|动画|运镜/.test(text)) return 'video';
  if (/\/\s*tts|#tts|配音|旁白|朗读|转语音|生成音频|文字转语音/.test(text)) return 'tts';
  if (/\/\s*stt|#stt|转写|听写|音频转文字|识别音频/.test(text)) return 'stt';
  if (hasAudio && current === 'stt') return 'stt';
  return current;
}

function modeTitle(mode: GrokOAuthMode) {
  return MODES.find((item) => item.id === mode)?.label || mode;
}

function artifactKindLabel(kind: GrokArtifactKind) {
  if (kind === 'image') return '图像';
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  if (kind === 'transcript') return '转写';
  return '文本';
}

function artifactKindFromMode(mode: GrokOAuthMode): GrokArtifactKind {
  if (mode === 'image') return 'image';
  if (mode === 'video') return 'video';
  if (mode === 'tts') return 'audio';
  if (mode === 'stt') return 'transcript';
  return 'text';
}

function textPreview(text: string, max = 72) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}...`;
}

function sanitizeMessages(value: any): GrokAgentMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      id: String(item?.id || makeId('msg')),
      turnId: item?.turnId ? String(item.turnId) : undefined,
      role: ['user', 'assistant', 'tool', 'system'].includes(item?.role) ? item.role : 'assistant',
      content: String(item?.content || ''),
      mode: item?.mode,
      status: item?.status,
      command: item?.command ? String(item.command) : undefined,
      progress: typeof item?.progress === 'number' ? item.progress : undefined,
      artifactIds: Array.isArray(item?.artifactIds) ? item.artifactIds.map(String) : [],
      createdAt: Number(item?.createdAt || Date.now()),
    }))
    .filter((item) => item.content || item.artifactIds.length)
    .slice(-MAX_AGENT_MESSAGES);
}

type GrokConversationPayloadMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function conversationHistoryMessages(history: GrokAgentMessage[]): GrokConversationPayloadMessage[] {
  return history
    .filter((item) => ['system', 'user', 'assistant'].includes(item.role))
    .filter((item) => item.status !== 'running')
    .map((item): GrokConversationPayloadMessage => ({
      role: item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user',
      content: String(item.content || '').trim(),
    }))
    .filter((item) => item.content);
}

function compactSummaryLine(text: string, max = 360) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max)}...`;
}

function trimContextSummary(text: string) {
  const value = String(text || '').trim();
  if (value.length <= CONTEXT_SUMMARY_MAX_CHARS) return value;
  return `...${value.slice(-CONTEXT_SUMMARY_MAX_CHARS)}`;
}

function conversationRoleLabel(role: string) {
  if (role === 'assistant') return 'Grok';
  if (role === 'system') return '系统';
  return '用户';
}

function summarizeConversationChunk(messages: GrokConversationPayloadMessage[]) {
  return messages
    .map((item) => `${conversationRoleLabel(item.role)}：${compactSummaryLine(item.content)}`)
    .filter(Boolean)
    .join('\n');
}

function mergeConversationSummary(previousSummary: string, newlyCompressed: GrokConversationPayloadMessage[]) {
  const previous = String(previousSummary || '').trim();
  const nextChunk = summarizeConversationChunk(newlyCompressed);
  return trimContextSummary([previous, nextChunk].filter(Boolean).join('\n'));
}

function buildConversationContext(
  history: GrokAgentMessage[],
  currentPrompt: string,
  options: { contextLimit?: number; summary?: string; compressedCount?: number } = {},
) {
  const contextLimit = clampInteger(options.contextLimit, DEFAULT_GROK_CONTEXT_LIMIT, 0, MAX_GROK_CONTEXT_LIMIT);
  const historyMessages = conversationHistoryMessages(history);
  const previousSummary = String(options.summary || '').trim();
  const previousCompressedCount = clampInteger(options.compressedCount, 0, 0, historyMessages.length);
  const targetCompressedCount = contextLimit <= 0 ? historyMessages.length : Math.max(0, historyMessages.length - contextLimit);
  const normalizedCompressedCount = Math.min(previousCompressedCount, targetCompressedCount);
  const newlyCompressed = historyMessages.slice(normalizedCompressedCount, targetCompressedCount);
  const summary = newlyCompressed.length ? mergeConversationSummary(previousSummary, newlyCompressed) : previousSummary;
  const prompt = String(currentPrompt || '').trim();
  const recent = contextLimit <= 0 ? [] : historyMessages.slice(-contextLimit);
  const messages: GrokConversationPayloadMessage[] = summary
    ? [
      {
        role: 'system',
        content: `以下是此前对话的压缩记忆，请作为长期上下文使用，不要把它当成用户刚刚输入：\n${summary}`,
      },
      ...recent,
    ]
    : [...recent];
  const last = messages[messages.length - 1];
  if (prompt) {
    if (last?.role === 'user' && last.content === prompt) {
      return { messages, summary, compressedCount: targetCompressedCount, compressedNow: newlyCompressed.length };
    }
    return { messages: [...messages, { role: 'user', content: prompt }], summary, compressedCount: targetCompressedCount, compressedNow: newlyCompressed.length };
  }
  if (messages.length) return { messages, summary, compressedCount: targetCompressedCount, compressedNow: newlyCompressed.length };
  return { messages: [{ role: 'user', content: '' }], summary, compressedCount: targetCompressedCount, compressedNow: newlyCompressed.length };
}

function buildConversationMessages(history: GrokAgentMessage[], currentPrompt: string, options: { contextLimit?: number; summary?: string; compressedCount?: number } = {}) {
  return buildConversationContext(history, currentPrompt, options).messages;
}

function stopCopyableConversationEvent(event: any) {
  event.stopPropagation?.();
  event.nativeEvent?.stopImmediatePropagation?.();
}

function sanitizeArtifacts(value: any): GrokAgentArtifact[] {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .map((item) => ({
      id: String(item?.id || makeId('art')),
      refId: item?.refId ? String(item.refId) : undefined,
      turnId: item?.turnId ? String(item.turnId) : undefined,
      kind: ['text', 'image', 'video', 'audio', 'transcript'].includes(item?.kind) ? item.kind : 'text',
      title: String(item?.title || artifactKindLabel(item?.kind || 'text')),
      text: item?.text ? String(item.text) : undefined,
      url: item?.url ? String(item.url) : undefined,
      urls: dedupeStringArray(item?.urls || item?.imageUrls || item?.videoUrls || item?.audioUrls || item?.url),
      prompt: item?.prompt ? String(item.prompt) : undefined,
      model: item?.model ? String(item.model) : undefined,
      mode: item?.mode,
      command: item?.command ? String(item.command) : undefined,
      parentId: item?.parentId ? String(item.parentId) : undefined,
      sourceArtifactIds: Array.isArray(item?.sourceArtifactIds) ? item.sourceArtifactIds.map(String).filter(Boolean) : [],
      revision: Number.isFinite(Number(item?.revision)) ? Number(item.revision) : undefined,
      status: item?.status ? String(item.status) : undefined,
      progress: typeof item?.progress === 'number' ? item.progress : undefined,
      requestId: item?.requestId ? String(item.requestId) : undefined,
      message: item?.message ? String(item.message) : undefined,
      createdAt: Number(item?.createdAt || Date.now()),
      publishedAt: item?.publishedAt ? Number(item.publishedAt) : undefined,
    }))
    .filter((item) => item.text || item.url || (item.urls && item.urls.length))
    .slice(-MAX_AGENT_ARTIFACTS);
  return assignMissingArtifactRefIds(cleaned);
}

function normalizeArtifactIdentityValue(value: string) {
  let next = String(value || '').trim();
  if (!next) return '';
  next = next.replace(/^<+|>+$/g, '').replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  next = next.replace(/^https?:\/\/[^/]+/i, '');
  next = next.split(/[?#]/)[0] || next;
  return next.toLowerCase();
}

function artifactStableTitle(artifact: GrokAgentArtifact) {
  const title = String(artifact.title || '').trim();
  const extLike = /\.(png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav|m4a|txt|md)$/i.test(title);
  const generic = !title || title === artifactKindLabel(artifact.kind);
  return extLike && !generic ? title : '';
}

function artifactDeleteKeys(artifact: GrokAgentArtifact): string[] {
  const urls = Array.isArray(artifact.urls) ? artifact.urls : [];
  const candidates = [
    artifact.id,
    artifact.url,
    ...urls,
    artifactStableTitle(artifact),
    downloadName(artifact.url || urls[0] || '', ''),
  ];
  return Array.from(new Set(
    candidates
      .map((item) => normalizeArtifactIdentityValue(String(item || '')))
      .filter(Boolean),
  ));
}

function sanitizeDeletedArtifactKeys(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((item) => normalizeArtifactIdentityValue(String(item || '')))
      .filter(Boolean),
  )).slice(-MAX_DELETED_AGENT_ARTIFACT_KEYS);
}

function mergeDeletedArtifactKeys(...groups: Array<Array<string | undefined>>) {
  return Array.from(new Set(
    groups.flat()
      .map((item) => normalizeArtifactIdentityValue(String(item || '')))
      .filter(Boolean),
  )).slice(-MAX_DELETED_AGENT_ARTIFACT_KEYS);
}

function artifactMatchesDeletedKeys(artifact: GrokAgentArtifact, deletedKeys: string[]) {
  if (deletedKeys.length === 0) return false;
  const deleted = new Set(deletedKeys.map(normalizeArtifactIdentityValue).filter(Boolean));
  return artifactDeleteKeys(artifact).some((key) => deleted.has(key));
}

function filterDeletedArtifacts(artifacts: GrokAgentArtifact[], deletedKeys: string[]) {
  if (deletedKeys.length === 0) return artifacts;
  return artifacts.filter((artifact) => !artifactMatchesDeletedKeys(artifact, deletedKeys));
}

function resultToArtifact(mode: GrokOAuthMode, result: GrokOAuthMediaResult | undefined, prompt: string, model?: string): GrokAgentArtifact | null {
  const data = result || {};
  const kind = artifactKindFromMode(mode);
  const text =
    kind === 'text' || kind === 'transcript'
      ? String(data.text || data.reply || data.prompt || '').trim()
      : '';
  const genericUrls = dedupeStringArray((data as any).urls || (data as any).url);
  const imageUrls = dedupeStringArray(data.imageUrls || data.imageUrl || (kind === 'image' ? genericUrls : []));
  const videoUrls = dedupeStringArray(data.videoUrls || data.videoUrl || (kind === 'video' ? genericUrls : []));
  const audioUrls = dedupeStringArray(data.audioUrls || data.audioUrl || (kind === 'audio' ? genericUrls : []));
  const urls = kind === 'image' ? imageUrls : kind === 'video' ? videoUrls : kind === 'audio' ? audioUrls : [];
  if (!text && urls.length === 0) return null;
  const label = artifactKindLabel(kind);
  return {
    id: makeId('artifact'),
    kind,
    title: `${label} · ${new Date().toLocaleTimeString()}`,
    text: text || undefined,
    url: urls[0],
    urls,
    prompt,
    model,
    mode,
    status: data.status || 'completed',
    progress: typeof data.progress === 'number' ? data.progress : 100,
    requestId: String(data.requestId || data.id || data.taskId || data.generationId || ''),
    message: data.message || '',
    createdAt: Date.now(),
  };
}

function eventToArtifact(event: GrokOAuthStreamEvent, mode: GrokOAuthMode, prompt: string, model?: string): GrokAgentArtifact | null {
  const source: any = event.artifact || event.result || {};
  const eventKind = source.kind || artifactKindFromMode(mode);
  const normalizedMode =
    eventKind === 'image' ? 'image'
      : eventKind === 'video' ? 'video'
        : eventKind === 'audio' ? 'tts'
          : eventKind === 'transcript' ? 'stt'
            : mode;
  const artifact = resultToArtifact(normalizedMode, source, prompt, model);
  if (!artifact) return null;
  artifact.kind = ['text', 'image', 'video', 'audio', 'transcript'].includes(eventKind) ? eventKind : artifact.kind;
  artifact.title = source.title || artifact.title;
  artifact.id = source.id ? String(source.id) : artifact.id;
  artifact.refId = source.refId ? String(source.refId) : artifact.refId;
  artifact.turnId = source.turnId || event.turnId ? String(source.turnId || event.turnId) : artifact.turnId;
  artifact.command = source.command || event.command ? String(source.command || event.command) : artifact.command;
  artifact.parentId = source.parentId || event.parentArtifactId ? String(source.parentId || event.parentArtifactId) : artifact.parentId;
  artifact.sourceArtifactIds = Array.isArray(source.sourceArtifactIds)
    ? source.sourceArtifactIds.map(String).filter(Boolean)
    : (Array.isArray((event as any).sourceArtifactIds) ? (event as any).sourceArtifactIds.map(String).filter(Boolean) : artifact.sourceArtifactIds);
  artifact.revision = Number.isFinite(Number(source.revision)) ? Number(source.revision) : artifact.revision;
  return artifact;
}

function artifactSignature(artifact: GrokAgentArtifact) {
  return [
    artifact.kind,
    artifact.url || '',
    (artifact.urls || []).join('|'),
    textPreview(artifact.text || '', 120),
    artifact.requestId || '',
  ].join('::');
}

function buildLegacyArtifactsFromData(data: any): GrokAgentArtifact[] {
  const prompt = String(data?.promptResolved || data?.prompt || '').trim();
  const createdAt = Date.now();
  const artifacts: GrokAgentArtifact[] = [];
  const textValue = String(data?.outputText || data?.reply || data?.text || '').trim();
  if (textValue) {
    artifacts.push({
      id: makeId('legacy_text'),
      kind: 'text',
      title: '旧文本输出',
      text: textValue,
      prompt,
      mode: 'chat',
      status: 'migrated',
      createdAt,
    });
  }
  for (const [kind, label, urls] of [
    ['image', '旧图像输出', dedupeStringArray(data?.imageUrls || data?.imageUrl)],
    ['video', '旧视频输出', dedupeStringArray(data?.videoUrls || data?.videoUrl)],
    ['audio', '旧音频输出', dedupeStringArray(data?.audioUrls || data?.audioUrl)],
  ] as Array<[GrokArtifactKind, string, string[]]>) {
    for (const url of urls) {
      artifacts.push({
        id: makeId(`legacy_${kind}`),
        kind,
        title: label,
        url,
        urls: [url],
        prompt,
        mode: kind === 'image' ? 'image' : kind === 'video' ? 'video' : 'tts',
        status: 'migrated',
        createdAt,
      });
    }
  }
  return artifacts.slice(-MAX_AGENT_ARTIFACTS);
}

function buildArtifactOutputPatch(artifact: GrokAgentArtifact, options: {
  prompt?: string;
  summary?: string;
  lastPublishedArtifactId?: string;
  lastQuickOutputId?: string;
  quickLastRunSummary?: string;
} = {}): Record<string, any> {
  const allUrls = dedupeStringArray(artifact.urls || artifact.url);
  const primaryUrl = String(artifact.url || allUrls[0] || '').trim();
  const urls = primaryUrl ? [primaryUrl] : [];
  const textValue = String(artifact.text || '').trim();
  const label = artifactKindLabel(artifact.kind);
  const summary = options.summary || `${label} 已输出到画布素材`;
  const patch: Record<string, any> = {
    status: 'success',
    error: '',
    progress: 100,
    progressMessage: '',
    lastRunSummary: summary,
    promptResolved: artifact.prompt || options.prompt || '',
    outputText: '',
    text: '',
    reply: '',
    urls: [],
    generatedImages: [],
    imageUrl: '',
    imageUrls: [],
    directImageUrl: '',
    directImageUrls: [],
    videoUrl: '',
    videoUrls: [],
    directVideoUrl: '',
    directVideoUrls: [],
    audioUrl: '',
    audioUrls: [],
    directAudioUrl: '',
    directAudioUrls: [],
  };
  if (options.lastPublishedArtifactId) patch.lastPublishedArtifactId = options.lastPublishedArtifactId;
  if (options.lastQuickOutputId) patch.lastQuickOutputId = options.lastQuickOutputId;
  if (options.quickLastRunSummary) patch.quickLastRunSummary = options.quickLastRunSummary;
  if (artifact.kind === 'image') {
    patch.imageUrl = urls[0] || '';
    patch.imageUrls = urls;
  } else if (artifact.kind === 'video') {
    patch.videoUrl = urls[0] || '';
    patch.videoUrls = urls;
  } else if (artifact.kind === 'audio') {
    patch.audioUrl = urls[0] || '';
    patch.audioUrls = urls;
  } else {
    patch.outputText = textValue;
    patch.text = textValue;
    patch.reply = textValue;
    patch.prompt = options.prompt || artifact.prompt || '';
  }
  return patch;
}

function copyText(text: string) {
  if (!text) return;
  void navigator.clipboard?.writeText?.(text);
}

function downloadName(url: string, fallback: string) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.pathname.split('/').pop() || fallback;
  } catch {
    return fallback;
  }
}

const GrokOAuthAgentNode = ({ id, data, selected }: NodeProps) => {
  const rf = useReactFlow();
  const update = useUpdateNodeData(id);
  const d = (data || {}) as any;
  const { theme, style: themeStyle } = useThemeStore();
  const isDark = theme === 'dark';
  const isLight = theme === 'light';
  const isPixel = themeStyle === 'pixel';

  const [status, setStatus] = useState<GrokOAuthStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [streamingReply, setStreamingReply] = useState('');
  const [loginPolling, setLoginPolling] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const loginPollRef = useRef<number | null>(null);
  const latestErrorRef = useRef('');
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadKindRef = useRef<GrokUploadKind>('auto');
  const [uploadingKind, setUploadingKind] = useState<GrokUploadKind | ''>('');

  const mode = (d.mode || 'chat') as GrokOAuthMode;
  const localPrompt = String(d.prompt || '');
  const promptMentions = (Array.isArray(d.promptMentions) ? d.promptMentions : []) as MediaMention[];
  const quickPrompt = String(d.quickPrompt || '');
  const quickPromptMentions = (Array.isArray(d.quickPromptMentions) ? d.quickPromptMentions : []) as MediaMention[];
  const materialOrder = Array.isArray(d.materialOrder) ? d.materialOrder : [];
  const statusText = String(d.status || 'idle');
  const isBusy = ['running', 'streaming', 'submitting', 'polling'].includes(statusText);
  const autoIntent = d.autoIntent !== false;
  const autoPublishArtifacts = d.autoPublishArtifacts === true;
  const persistPrompt = d.grokPersistPrompt === true;
  const persistLocalMaterials = d.grokPersistLocalMaterials === true;
  const contextSummary = String(d.grokContextSummary || '').trim();
  const contextCompressedCount = clampInteger(d.grokContextCompressedCount, 0, 0, MAX_AGENT_MESSAGES);
  const chatSettings = useMemo<GrokChatSettings>(() => ({
    contextLimit: clampInteger(d.grokContextLimit, DEFAULT_GROK_CONTEXT_LIMIT, 0, MAX_GROK_CONTEXT_LIMIT),
    temperature: clampNumber(d.grokTemperature, DEFAULT_GROK_TEMPERATURE, 0, 2),
    topP: clampNumber(d.grokTopP, DEFAULT_GROK_TOP_P, 0.01, 1),
    topK: clampInteger(d.grokTopK, DEFAULT_GROK_TOP_K, 0, 200),
    maxOutputTokens: clampInteger(d.grokMaxOutputTokens, DEFAULT_GROK_MAX_OUTPUT_TOKENS, 256, 8192),
  }), [d.grokContextLimit, d.grokMaxOutputTokens, d.grokTemperature, d.grokTopK, d.grokTopP]);

  const agentMessages = useMemo(() => sanitizeMessages(d.agentMessages), [d.agentMessages]);
  const deletedArtifactKeys = useMemo(() => sanitizeDeletedArtifactKeys(d.grokDeletedArtifactKeys), [d.grokDeletedArtifactKeys]);
  const agentArtifacts = useMemo(
    () => filterDeletedArtifacts(sanitizeArtifacts(d.agentArtifacts), deletedArtifactKeys),
    [d.agentArtifacts, deletedArtifactKeys],
  );
  const localMaterials = useMemo(() => sanitizeLocalMaterials(d.grokLocalMaterials), [d.grokLocalMaterials]);
  const messagesRef = useRef<GrokAgentMessage[]>(agentMessages);
  const artifactsRef = useRef<GrokAgentArtifact[]>(agentArtifacts);
  const deletedArtifactKeysRef = useRef<string[]>(deletedArtifactKeys);
  const localMaterialsRef = useRef<Material[]>(localMaterials);
  const publishingArtifactIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => { messagesRef.current = agentMessages; }, [agentMessages]);
  useEffect(() => { artifactsRef.current = agentArtifacts; }, [agentArtifacts]);
  useEffect(() => { deletedArtifactKeysRef.current = deletedArtifactKeys; }, [deletedArtifactKeys]);
  useEffect(() => { localMaterialsRef.current = localMaterials; }, [localMaterials]);

  useEffect(() => {
    if (d.grokAgentStudioMigrated || d.lastPublishedArtifactId) return;
    const legacy = buildLegacyArtifactsFromData(d);
    if (legacy.length === 0) return;
    const merged = filterDeletedArtifacts([...agentArtifacts, ...legacy], deletedArtifactKeysRef.current).slice(-MAX_AGENT_ARTIFACTS);
    artifactsRef.current = merged;
    update({
      grokAgentStudioMigrated: true,
      agentArtifacts: merged,
      lastArtifactId: legacy[legacy.length - 1]?.id || d.lastArtifactId || '',
      lastRunSummary: '旧输出已收纳到 Grok 创作台产物库',
      outputText: '',
      text: '',
      reply: '',
      imageUrl: '',
      imageUrls: [],
      videoUrl: '',
      videoUrls: [],
      audioUrl: '',
      audioUrls: [],
    });
  }, [agentArtifacts, d, update]);

  const upstream = useUpstreamMaterials(id);
  const localImages = useMemo(() => localMaterials.filter((item) => item.kind === 'image'), [localMaterials]);
  const localVideos = useMemo(() => localMaterials.filter((item) => item.kind === 'video'), [localMaterials]);
  const localAudios = useMemo(() => localMaterials.filter((item) => item.kind === 'audio'), [localMaterials]);
  const mergedImages = useMemo(() => [...upstream.images, ...localImages], [upstream.images, localImages]);
  const mergedVideos = useMemo(() => [...upstream.videos, ...localVideos], [upstream.videos, localVideos]);
  const mergedAudios = useMemo(() => [...upstream.audios, ...localAudios], [upstream.audios, localAudios]);
  const orderedTexts = useOrderedMaterials(upstream.texts, materialOrder);
  const orderedImages = useOrderedMaterials(mergedImages, materialOrder);
  const orderedVideos = useOrderedMaterials(mergedVideos, materialOrder);
  const orderedAudios = useOrderedMaterials(mergedAudios, materialOrder);
  const artifactMaterials = useMemo(
    () => agentArtifacts.map((artifact) => artifactToMaterial(artifact, id)).filter((item): item is Material & { mentionKey?: string; mentionToken?: string; artifactId?: string } => !!item),
    [agentArtifacts, id],
  );
  const mentionMaterials = useMemo(
    () => [...orderedImages, ...orderedVideos, ...orderedAudios, ...artifactMaterials],
    [orderedImages, orderedVideos, orderedAudios, artifactMaterials],
  );

  const error = String(d.error || '');
  const oauthLoginUrl = String(d.oauthLoginUrl || '');
  const oauthLoginSessionId = String(d.oauthLoginSessionId || '');
  const lastArtifact = agentArtifacts.find((item) => item.id === d.lastArtifactId) || agentArtifacts[agentArtifacts.length - 1] || null;
  const quickLastRunSummary = String(d.quickLastRunSummary || '').trim();
  const statusMessage = loginPolling
    ? '等待 Grok 授权；如果页面显示无法建立连接，请复制授权码粘贴到下方。'
    : status?.loggedIn
      ? `已登录 ${status.user || status.account || ''}`
      : (status?.message || GROK_OAUTH_PRIVATE_DISABLED_MESSAGE);

  const accent = isPixel ? 'var(--px-mint)' : isLight ? '#10b981' : '#67e8f9';
  const bg = isPixel ? 'var(--px-surface)' : isLight ? '#ffffff' : 'rgba(7, 12, 24, 0.96)';
  const surface = isPixel ? 'var(--px-muted)' : isLight ? 'rgba(16,185,129,0.08)' : 'rgba(255,255,255,0.06)';
  const surfaceStrong = isPixel ? 'var(--px-yellow)' : isLight ? 'rgba(16,185,129,0.16)' : 'rgba(103,232,249,0.14)';
  const text = isPixel ? 'var(--px-ink)' : isLight ? '#0f172a' : '#ecfeff';
  const subText = isPixel ? 'var(--px-ink-soft)' : isLight ? '#64748b' : 'rgba(236,254,255,0.68)';
  const border = isPixel ? 'var(--px-ink)' : isLight ? 'rgba(16,185,129,0.28)' : 'rgba(103,232,249,0.24)';
  const danger = isPixel ? '#dc2626' : '#fca5a5';
  const readablePalette = createReadableStudioPalette({ isDark, isPixel, accent, bg, surface, surfaceStrong, text, subText, border, danger });
  const studioAccentText = readablePalette.accentText;
  const studioHeaderText = readablePalette.headerText;
  const studioHeaderSubText = readablePalette.headerSubText;
  const noticeCardBg = readablePalette.noticeBg;
  const noticeCardText = readablePalette.noticeText;
  const noticeCardSubText = readablePalette.noticeSubText;
  const noticeCardBorder = readablePalette.noticeBorder;

  const rootStyle: CSSProperties = {
    width: 380,
    minHeight: 300,
    background: bg,
    color: text,
    border: `2px solid ${selected ? accent : border}`,
    borderRadius: isPixel ? 8 : 16,
    boxShadow: isPixel ? (selected ? '5px 5px 0 var(--px-ink)' : '3px 3px 0 var(--px-ink)') : 'var(--t8-node-shadow, 0 16px 42px rgba(0,0,0,0.32))',
    overflow: 'visible',
  };

  const setAgentMessages = useCallback((next: GrokAgentMessage[], extra: Record<string, any> = {}) => {
    const capped = next.slice(-MAX_AGENT_MESSAGES);
    messagesRef.current = capped;
    update({ agentMessages: capped, ...extra });
  }, [update]);

  const setAgentArtifacts = useCallback((next: GrokAgentArtifact[], extra: Record<string, any> = {}) => {
    const capped = filterDeletedArtifacts(next, deletedArtifactKeysRef.current).slice(-MAX_AGENT_ARTIFACTS);
    artifactsRef.current = capped;
    update({ agentArtifacts: capped, ...extra });
  }, [update]);

  const appendMessage = useCallback((message: GrokAgentMessage, extra: Record<string, any> = {}) => {
    setAgentMessages([...messagesRef.current, message], extra);
  }, [setAgentMessages]);

  const updateMessage = useCallback((messageId: string, patch: Partial<GrokAgentMessage>, extra: Record<string, any> = {}) => {
    setAgentMessages(messagesRef.current.map((item) => item.id === messageId ? { ...item, ...patch } : item), extra);
  }, [setAgentMessages]);

  const appendArtifact = useCallback((artifact: GrokAgentArtifact, extra: Record<string, any> = {}) => {
    const prepared: GrokAgentArtifact = {
      ...artifact,
      refId: artifact.refId || nextArtifactRefId(artifact.kind, artifactsRef.current),
      revision: artifact.revision || ((artifact.parentId || (artifact.sourceArtifactIds || []).length > 0) ? 2 : 1),
    };
    if (artifactMatchesDeletedKeys(prepared, deletedArtifactKeysRef.current)) return null;
    const sig = artifactSignature(prepared);
    const exists = artifactsRef.current.find((item) => artifactSignature(item) === sig);
    if (exists) {
      setAgentArtifacts(artifactsRef.current.map((item) => item.id === exists.id ? { ...item, ...prepared, id: exists.id, refId: item.refId || prepared.refId } : item), {
        lastArtifactId: exists.id,
        lastRunSummary: `${artifactKindLabel(exists.kind)} 已更新`,
        ...extra,
      });
      return exists;
    }
    const next = [...artifactsRef.current, prepared].slice(-MAX_AGENT_ARTIFACTS);
    artifactsRef.current = next;
    update({
      agentArtifacts: next,
      lastArtifactId: prepared.id,
      lastRunSummary: `${artifactKindLabel(prepared.kind)} 已生成`,
      ...extra,
    });
    return prepared;
  }, [update, setAgentArtifacts]);

  const deleteArtifacts = useCallback((targets: GrokAgentArtifact[], summary = '已删除 Grok 产物') => {
    const normalizedTargets = targets
      .map((artifact) => sanitizeArtifacts([artifact])[0])
      .filter((artifact): artifact is GrokAgentArtifact => !!artifact);
    if (normalizedTargets.length === 0) return;
    const targetIds = new Set(normalizedTargets.map((artifact) => artifact.id));
    const nextDeletedKeys = mergeDeletedArtifactKeys(deletedArtifactKeysRef.current, normalizedTargets.flatMap(artifactDeleteKeys));
    deletedArtifactKeysRef.current = nextDeletedKeys;
    const nextArtifacts = filterDeletedArtifacts(
      artifactsRef.current.filter((artifact) => !targetIds.has(artifact.id)),
      nextDeletedKeys,
    ).slice(-MAX_AGENT_ARTIFACTS);
    artifactsRef.current = nextArtifacts;
    update({
      agentArtifacts: nextArtifacts,
      grokDeletedArtifactKeys: nextDeletedKeys,
      lastArtifactId: nextArtifacts[nextArtifacts.length - 1]?.id || '',
      lastRunSummary: summary,
    });
  }, [update]);

  const publishArtifact = useCallback((artifact: GrokAgentArtifact | null | undefined) => {
    if (!artifact) return;
    const current = artifactsRef.current.find((item) => item.id === artifact.id) || artifact;
    if (publishingArtifactIdsRef.current.has(current.id)) {
      logBus.info(`正在发布 ${artifactKindLabel(current.kind)}，不会重复创建输出节点`, `grok:${id}`);
      return;
    }
    if (current.publishedAt) {
      logBus.info(`已发布过 ${artifactKindLabel(current.kind)}，不会重复创建输出节点`, `grok:${id}`);
      return;
    }
    publishingArtifactIdsRef.current.add(current.id);
    const patch = buildArtifactOutputPatch(current, {
      lastPublishedArtifactId: current.id,
      summary: `已发布 ${artifactKindLabel(current.kind)} 到画布输出`,
      prompt: current.prompt || d.promptResolved || localPrompt,
    });
    const nextArtifacts = artifactsRef.current.map((item) => item.id === current.id ? { ...item, publishedAt: Date.now() } : item);
    setAgentArtifacts(nextArtifacts, patch);
    logBus.success(`已发布 ${artifactKindLabel(current.kind)} 到画布输出`, `grok:${id}`);
  }, [d.promptResolved, id, localPrompt, setAgentArtifacts]);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const next = await getGrokOAuthStatus();
      setStatus(next);
      const patch: Record<string, any> = {
        oauthAvailable: !!next.available,
        oauthLoggedIn: !!next.loggedIn,
        oauthMessage: next.message || '',
      };
      if (next.available && isPrivateDisabledError(latestErrorRef.current)) patch.error = '';
      if (next.loggedIn) {
        patch.oauthLoginUrl = '';
        patch.oauthLoginSessionId = '';
        patch.progressMessage = '';
      }
      update(patch);
    } catch (e: any) {
      const message = e?.message || String(e);
      setStatus({ available: false, loggedIn: false, message });
      update({ oauthAvailable: false, oauthLoggedIn: false, oauthMessage: message });
    } finally {
      setStatusLoading(false);
    }
  }, [update]);

  useEffect(() => {
    latestErrorRef.current = error;
  }, [error]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!studioOpen || typeof document === 'undefined') return undefined;
    const stopSelectableTextGesture = (event: Event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target?.closest?.('[data-grok-studio-copyable], [data-grok-message-copyable]')) return;
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };
    document.addEventListener('pointerdown', stopSelectableTextGesture, true);
    document.addEventListener('mousedown', stopSelectableTextGesture, true);
    document.addEventListener('dblclick', stopSelectableTextGesture, true);
    document.addEventListener('contextmenu', stopSelectableTextGesture, true);
    document.addEventListener('dragstart', stopSelectableTextGesture, true);
    return () => {
      document.removeEventListener('pointerdown', stopSelectableTextGesture, true);
      document.removeEventListener('mousedown', stopSelectableTextGesture, true);
      document.removeEventListener('dblclick', stopSelectableTextGesture, true);
      document.removeEventListener('contextmenu', stopSelectableTextGesture, true);
      document.removeEventListener('dragstart', stopSelectableTextGesture, true);
    };
  }, [studioOpen]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (loginPollRef.current) window.clearTimeout(loginPollRef.current);
    };
  }, []);

  const startLoginPoll = useCallback((sessionId: string) => {
    setLoginPolling(true);
    const tick = async () => {
      try {
        const result = await pollGrokOAuthLogin({ sessionId });
        if (result.loggedIn || result.status === 'success' || result.done) {
          setLoginPolling(false);
          setManualCode('');
          update({ oauthLoginUrl: '', oauthLoginSessionId: '', progressMessage: '', error: '' });
          await refreshStatus();
          logBus.success('Grok OAuth 登录完成', `grok:${id}`);
          return;
        }
        loginPollRef.current = window.setTimeout(tick, 1800);
      } catch (e: any) {
        setLoginPolling(false);
        update({ error: e?.message || String(e) });
      }
    };
    loginPollRef.current = window.setTimeout(tick, 1200);
  }, [id, refreshStatus, update]);

  const handleLogin = useCallback(async () => {
    try {
      setManualCode('');
      update({ error: '', progressMessage: '正在打开 Grok OAuth 授权页...' });
      const result = await startGrokOAuthLogin({});
      const loginUrl = result.loginUrl || result.url || result.verificationUriComplete || result.verification_url;
      const sessionId = String(result.sessionId || result.deviceCode || result.state || '').trim();
      update({
        oauthLoginUrl: loginUrl || '',
        oauthLoginSessionId: sessionId,
        progressMessage: result.manualInstructions || '请在浏览器完成 Grok 授权；如果页面提示无法建立连接，请复制授权码粘贴回来。',
      });
      if (loginUrl && typeof window !== 'undefined') window.open(loginUrl, '_blank', 'noopener,noreferrer');
      if (sessionId) startLoginPoll(sessionId);
      else await refreshStatus();
    } catch (e: any) {
      const message = e?.message || String(e);
      update({ error: message });
      logBus.error(message, `grok:${id}`);
    }
  }, [id, refreshStatus, startLoginPoll, update]);

  const handleLogout = useCallback(async () => {
    try {
      await logoutGrokOAuth();
      await refreshStatus();
      setManualCode('');
      update({ error: '', oauthLoginUrl: '', oauthLoginSessionId: '', progressMessage: '' });
    } catch (e: any) {
      update({ error: e?.message || String(e) });
    }
  }, [refreshStatus, update]);

  const handlePasteManualCode = useCallback(async () => {
    try {
      const textValue = await navigator.clipboard?.readText?.();
      if (textValue) setManualCode(textValue.trim());
    } catch {
      update({ error: '浏览器不允许读取剪贴板，请手动 Ctrl+V 粘贴授权码。' });
    }
  }, [update]);

  const handleCompleteLogin = useCallback(async () => {
    const code = manualCode.replace(/\s+/g, '').trim();
    if (!code) {
      update({ error: '请先粘贴 Grok 页面显示的授权码。' });
      return;
    }
    try {
      update({ error: '', status: 'running', progressMessage: '正在提交 Grok 授权码...' });
      const result = await completeGrokOAuthLogin({
        sessionId: oauthLoginSessionId,
        authorizationCode: code,
      });
      if (result.loggedIn || result.status === 'success' || result.done) {
        setManualCode('');
        setLoginPolling(false);
        if (loginPollRef.current) window.clearTimeout(loginPollRef.current);
        update({ status: 'idle', error: '', oauthLoginUrl: '', oauthLoginSessionId: '', progressMessage: 'Grok OAuth 登录完成。' });
        await refreshStatus();
        logBus.success('Grok OAuth 授权码登录完成', `grok:${id}`);
        return;
      }
      update({ status: 'idle', progressMessage: result.message || '授权码已提交，正在等待登录完成...' });
    } catch (e: any) {
      update({ status: 'error', error: e?.message || String(e), progressMessage: '' });
    }
  }, [id, manualCode, oauthLoginSessionId, refreshStatus, update]);

  const setMaterialOrder = (newOrder: string[]) => update({ materialOrder: newOrder });

  const pickLocalMaterial = useCallback((kind: GrokUploadKind = 'auto') => {
    pendingUploadKindRef.current = kind;
    if (!uploadInputRef.current) return;
    uploadInputRef.current.accept = GROK_UPLOAD_ACCEPT[kind];
    uploadInputRef.current.value = '';
    uploadInputRef.current.click();
  }, []);

  const removeLocalMaterial = useCallback((material: Material) => {
    const next = localMaterialsRef.current.filter((item) => item.id !== material.id);
    update({
      grokLocalMaterials: next,
      materialOrder: materialOrder.filter((item: string) => item !== material.id),
    });
  }, [materialOrder, update]);

  const clearTransientLocalMaterials = useCallback(() => {
    const current = localMaterialsRef.current;
    if (current.length === 0) return;
    const localIds = new Set(current.map((item) => item.id));
    localMaterialsRef.current = [];
    update({
      grokLocalMaterials: [],
      materialOrder: materialOrder.filter((item: string) => !localIds.has(item)),
    });
  }, [materialOrder, update]);

  const handleLocalMaterialFiles = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;
    const preferredKind = pendingUploadKindRef.current || 'auto';
    setUploadingKind(preferredKind);
    try {
      const created: Material[] = [];
      for (const file of files) {
        const kind = inferUploadKind(file, preferredKind);
        if (!kind) throw new Error(`不支持的素材类型：${file.name}`);
        const uploaded = await uploadFile(file);
        const url = String(uploaded?.url || '').trim();
        if (!url) throw new Error(`上传失败：${file.name}`);
        created.push({
          id: makeId(`local_${kind}`),
          kind,
          url,
          sourceNodeId: id,
          origin: 'local',
          label: uploaded.filename || file.name,
        });
      }
      const next = [...localMaterialsRef.current, ...created].slice(-MAX_LOCAL_MATERIALS);
      localMaterialsRef.current = next;
      update({
        grokLocalMaterials: next,
        materialOrder: [...materialOrder.filter(Boolean), ...created.map((item) => item.id)],
        error: '',
        progressMessage: `已上传 ${created.length} 个本地素材。`,
      });
      logBus.success(`Grok 创作台已上传 ${created.length} 个本地素材`, `grok:${id}`);
    } catch (e: any) {
      const message = e?.message || String(e);
      update({ error: message });
      logBus.error(message, `grok:${id}`);
    } finally {
      setUploadingKind('');
      pendingUploadKindRef.current = 'auto';
    }
  }, [id, materialOrder, update]);

  const payloadBase = useCallback((runMode: GrokOAuthMode = mode, promptText = localPrompt, mentions: MediaMention[] = promptMentions) => {
    const refMedia = referencedMediaByMentions(mentions, mentionMaterials);
    const explicitImageRefs = materialUrls(refMedia.images);
    const explicitVideoRefs = materialUrls(refMedia.videos);
    const explicitAudioRefs = materialUrls(refMedia.audios);
    const imageRefs = referencedFirstUrls(refMedia.images, orderedImages);
    const videoRefs = referencedFirstUrls(refMedia.videos, orderedVideos);
    const audioRefs = referencedFirstUrls(refMedia.audios, orderedAudios);
    const activeImageRefs = explicitImageRefs.length > 0 ? explicitImageRefs : imageRefs;
    const activeVideoRefs = explicitVideoRefs.length > 0 ? explicitVideoRefs : videoRefs;
    const activeAudioRefs = explicitAudioRefs.length > 0 ? explicitAudioRefs : audioRefs;
    const promptResolved = buildPrompt(promptText, orderedTexts, mentions, mentionMaterials);
    const sourceArtifactIds = referencedArtifactIds(mentions, mentionMaterials);
    return {
      mode: runMode,
      prompt: promptResolved,
      promptResolved,
      text: promptResolved,
      images: imageRefs,
      videos: videoRefs,
      audios: audioRefs,
      referenceImages: activeImageRefs,
      referenceImageUrls: activeImageRefs,
      referenceVideos: activeVideoRefs,
      referenceAudios: activeAudioRefs,
      inputImages: activeImageRefs,
      inputVideos: activeVideoRefs,
      inputAudios: activeAudioRefs,
      imageUrl: activeImageRefs[0] || '',
      videoUrl: activeVideoRefs[0] || '',
      audioUrl: activeAudioRefs[0] || '',
      sourceImageUrl: activeImageRefs[0] || '',
      sourceImageUrls: activeImageRefs,
      hasExplicitImageReferences: activeImageRefs.length > 0,
      explicitImageReferenceCount: explicitImageRefs.length,
      referenceImageCount: activeImageRefs.length,
      mentions,
      sourceArtifactIds,
      parentArtifactId: sourceArtifactIds[0] || '',
      nodeId: id,
    };
  }, [id, localPrompt, mentionMaterials, mode, orderedAudios, orderedImages, orderedTexts, orderedVideos, promptMentions]);

  const modePayload = useCallback((runMode: GrokOAuthMode, media?: {
    prompt?: string;
    images?: string[];
    videos?: string[];
    audios?: string[];
    referenceImages?: string[];
    referenceImageUrls?: string[];
    referenceVideos?: string[];
    inputImages?: string[];
    inputVideos?: string[];
    sourceImageUrls?: string[];
    sourceImageUrl?: string;
    videoUrl?: string;
  }) => {
    if (runMode === 'chat') {
      return {
        model: d.chatModel || CHAT_MODELS[0],
        ...buildChatGenerationPayload(chatSettings),
        messages: [{ role: 'user', content: buildPrompt(localPrompt, orderedTexts, promptMentions, mentionMaterials) }],
      };
    }
    if (runMode === 'image') {
      const explicitImageRefs = dedupeStringArray([
        ...(media?.referenceImages || []),
        ...(media?.referenceImageUrls || []),
        ...(media?.inputImages || []),
        ...(media?.sourceImageUrls || []),
        media?.sourceImageUrl || '',
      ]);
      const imageRefs = explicitImageRefs.length > 0
        ? explicitImageRefs
        : dedupeStringArray(media?.images || orderedImages.map((item) => item.url).filter(Boolean));
      const referenceImageRefs = imageRefs;
      return {
        model: d.imageModel || IMAGE_MODELS[0],
        ratio: d.ratio || '1:1',
        aspectRatio: d.ratio || '1:1',
        resolution: d.imageResolution || '1k',
        images: imageRefs,
        imageUrl: referenceImageRefs[0] || '',
        inputImages: referenceImageRefs,
        referenceImages: referenceImageRefs,
        referenceImageUrls: referenceImageRefs,
        sourceImageUrl: referenceImageRefs[0] || '',
        sourceImageUrls: referenceImageRefs,
        referenceImageCount: referenceImageRefs.length,
        edit: referenceImageRefs.length > 0,
        operation: referenceImageRefs.length > 0 ? 'edit' : 'generate',
      };
    }
    if (runMode === 'video') {
      const promptValue = String(media?.prompt || localPrompt || '').toLowerCase();
      const explicitImageRefs = dedupeStringArray([
        ...(media?.referenceImages || []),
        ...(media?.referenceImageUrls || []),
        ...(media?.inputImages || []),
        ...(media?.sourceImageUrls || []),
        media?.sourceImageUrl || '',
      ]);
      const imageRefs = explicitImageRefs.length > 0
        ? explicitImageRefs
        : dedupeStringArray(media?.images || orderedImages.map((item) => item.url).filter(Boolean));
      const explicitVideoRefs = dedupeStringArray([
        ...(media?.referenceVideos || []),
        ...(media?.inputVideos || []),
        media?.videoUrl || '',
      ]);
      const videoRefs = explicitVideoRefs.length > 0
        ? explicitVideoRefs
        : dedupeStringArray(media?.videos || orderedVideos.map((item) => item.url).filter(Boolean));
      const videoOperation = videoRefs.length > 0 && /extend|extension|continue|longer|续|延长|加长|继续/.test(promptValue)
        ? 'extend'
        : videoRefs.length > 0 ? 'edit' : 'generate';
      const selectedVideoModel = normalizeGrokVideoModel(d.videoModel || VIDEO_MODELS[0]);
      const videoModel = videoRefs.length > 0 && isGrokImageOnlyVideoModel(selectedVideoModel)
        ? DEFAULT_TEXT_VIDEO_MODEL
        : selectedVideoModel;
      return {
        images: isGrokImageOnlyVideoModel(videoModel) ? imageRefs.slice(0, 1) : imageRefs,
        imageUrl: imageRefs[0] || '',
        videos: videoRefs,
        videoUrl: videoRefs[0] || '',
        referenceImages: explicitImageRefs,
        referenceImageUrls: explicitImageRefs,
        referenceVideos: explicitVideoRefs,
        inputVideos: videoRefs,
        operation: videoOperation,
        videoOperation,
        model: videoModel,
        ratio: d.ratio || '16:9',
        aspectRatio: d.ratio || '16:9',
        resolution: d.videoResolution || '720p',
        duration: Number(d.duration || 8),
      };
    }
    if (runMode === 'tts') {
      return {
        model: d.ttsModel || 'xai-tts',
        voiceId: d.voiceId || 'eve',
        language: d.language || 'zh',
        outputFormat: d.outputFormat || 'mp3',
      };
    }
    const audioUrl = media?.audios?.[0] || orderedAudios[0]?.url || d.audioUrl || '';
    return {
      audioUrl,
      audios: audioUrl ? [audioUrl] : [],
      model: d.sttModel || 'xai-stt',
      language: d.language || 'zh',
    };
  }, [chatSettings, d.audioUrl, d.chatModel, d.duration, d.imageModel, d.imageResolution, d.language, d.outputFormat, d.ratio, d.sttModel, d.ttsModel, d.videoModel, d.videoResolution, d.voiceId, localPrompt, mentionMaterials, orderedAudios, orderedImages, orderedTexts, promptMentions]);

  const handleRun = useCallback(async (override?: { prompt?: string; mentions?: MediaMention[] }) => {
    if (isBusy) return;
    const rawRunPrompt = typeof override?.prompt === 'string' ? override.prompt : localPrompt;
    const rawRunMentions = Array.isArray(override?.mentions) ? override.mentions : promptMentions;
    const normalizedInput = normalizePromptMentionTokens(rawRunPrompt, rawRunMentions, mentionMaterials);
    const runPrompt = normalizedInput.text;
    const runMentions = normalizedInput.mentions;
    if (normalizedInput.changed) {
      update({ prompt: runPrompt, promptMentions: runMentions });
    }
    const slash = parseSlashCommand(runPrompt);
    const promptBody = slash ? slash.body : runPrompt;
    const effectiveMentions = slash ? shiftMentionsForSlashBody(runMentions, slash.bodyStart) : runMentions;
    const runPromptResolved = buildPrompt(promptBody, orderedTexts, effectiveMentions, mentionMaterials);
    const refMedia = referencedMediaByMentions(effectiveMentions, mentionMaterials);
    const hasAudioInput = orderedAudios.length > 0 || refMedia.audios.length > 0;
    const inferredMode = slash ? slash.mode : (autoIntent ? inferModeFromPrompt(runPromptResolved || promptBody, mode, hasAudioInput) : mode);
    const command = slash?.command || (inferredMode === 'image' ? 'image' : inferredMode === 'video' ? 'video' : inferredMode === 'tts' ? 'tts' : inferredMode === 'stt' ? 'stt' : 'chat');
    const base = payloadBase(inferredMode, promptBody, effectiveMentions);
    const videoModel = normalizeGrokVideoModel(d.videoModel || VIDEO_MODELS[0]);
    if (inferredMode === 'video' && isGrokImageOnlyVideoModel(videoModel) && base.images.length === 0 && base.videos.length === 0) {
      update({ status: 'error', error: 'grok-imagine-video-1.5-preview 只支持图生视频：请连接至少 1 张图片，或切换到 grok-imagine-video 做文生视频。' });
      setStudioOpen(true);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setStreamingReply('');
    update({ mode: inferredMode, status: inferredMode === 'chat' ? 'streaming' : 'running', error: '', progressMessage: '', requestId: '', lastSlashCommand: command });
    let activeToolMessageId = '';
    let shouldClearTransientMaterials = false;
    let shouldClearPromptAfterDispatch = false;
    try {
      const latestStatus = status || await getGrokOAuthStatus();
      if (latestStatus.available === false || latestStatus.moduleEnabled === false) {
        throw new Error(latestStatus.message || GROK_OAUTH_PRIVATE_DISABLED_MESSAGE);
      }
      if (!latestStatus.loggedIn) throw new Error('请先点击“登录 / 绑定”完成 Grok OAuth 授权。');
      if (inferredMode !== 'stt' && !base.prompt) throw new Error('请填写 Prompt，或连接上游文本节点。');
      if (inferredMode === 'stt' && !(modePayload('stt', base) as any).audioUrl) throw new Error('STT 需要连接上游音频，或节点已有音频输出。');
      shouldClearTransientMaterials = !persistLocalMaterials && localMaterialsRef.current.length > 0;
      shouldClearPromptAfterDispatch = !persistPrompt && (runPrompt.trim().length > 0 || runMentions.length > 0);

      const turnId = makeId('turn');
      const runtimeModePayload = modePayload(inferredMode, base) as any;
      const chatContext = inferredMode === 'chat'
        ? buildConversationContext(messagesRef.current, base.prompt, {
          contextLimit: chatSettings.contextLimit,
          summary: contextSummary,
          compressedCount: contextCompressedCount,
        })
        : { messages: [], summary: contextSummary, compressedCount: contextCompressedCount, compressedNow: 0 };
      const chatConversationMessages = inferredMode === 'chat'
        ? chatContext.messages
        : [];
      if (inferredMode === 'chat') runtimeModePayload.messages = chatConversationMessages;
      if (inferredMode === 'chat' && (chatContext.summary !== contextSummary || chatContext.compressedCount !== contextCompressedCount)) {
        update({
          grokContextSummary: chatContext.summary,
          grokContextCompressedCount: chatContext.compressedCount,
          grokContextCompressedAt: Date.now(),
        });
      }
      const modelValue = String(runtimeModePayload.model || '');
      const sourceArtifactIds = Array.isArray(base.sourceArtifactIds) ? base.sourceArtifactIds : [];
      const referenceImageCount = Number(base.referenceImageCount || 0);
      const parentArtifactId = String(base.parentArtifactId || sourceArtifactIds[0] || '');
      appendMessage({
        id: `${turnId}_user`,
        turnId,
        role: 'user',
        content: `${slash ? `/${command} ` : ''}${base.prompt || `转写音频：${(modePayload('stt', base) as any).audioUrl || '上游音频'}`}`.trim(),
        mode: inferredMode,
        command,
        status: 'success',
        artifactIds: sourceArtifactIds,
        createdAt: Date.now(),
      });
      const shouldShowToolMessage = inferredMode !== 'chat';
      const toolMessageId = shouldShowToolMessage ? `${turnId}_tool` : '';
      if (shouldShowToolMessage) {
        appendMessage({
          id: toolMessageId,
          turnId,
          role: 'tool',
          content: `准备运行 ${modeTitle(inferredMode)}${modelValue ? ` · ${modelValue}` : ''}${sourceArtifactIds.length ? ` · 引用 ${sourceArtifactIds.length} 个产物` : ''}${referenceImageCount ? ` · 参考图 ${referenceImageCount} 张` : ''}`,
          mode: inferredMode,
          command,
          status: 'running',
          progress: 1,
          createdAt: Date.now(),
        });
      }
      activeToolMessageId = toolMessageId;
      if (shouldClearPromptAfterDispatch) {
        update({ prompt: '', promptMentions: [] });
      }

      const createdArtifactIds: string[] = [];
      const seenArtifacts = new Set<string>();
      const addArtifact = (artifact: GrokAgentArtifact | null) => {
        if (!artifact) return null;
        artifact.turnId = artifact.turnId || turnId;
        artifact.command = artifact.command || command;
        artifact.sourceArtifactIds = artifact.sourceArtifactIds?.length ? artifact.sourceArtifactIds : sourceArtifactIds;
        artifact.parentId = artifact.parentId || parentArtifactId || undefined;
        const sig = artifactSignature(artifact);
        if (seenArtifacts.has(sig)) return null;
        seenArtifacts.add(sig);
        const saved = appendArtifact(artifact, { status: 'running' });
        if (saved) createdArtifactIds.push(saved.id);
        return saved;
      };

      let finalReply = '';
      const result = await streamGrokOAuthAgent(
        {
          ...base,
          ...runtimeModePayload,
          mode: inferredMode,
          command,
          slashCommand: slash?.command || '',
          turnId,
          conversationId: String(d.grokConversationId || 'default'),
          conversationContextLimit: chatSettings.contextLimit,
          sourceArtifactIds,
          parentArtifactId,
          conversationMessages: inferredMode === 'chat' ? chatConversationMessages : messagesRef.current.slice(-24),
          conversationArtifacts: artifactsRef.current.slice(-32).map((artifact) => ({
            id: artifact.id,
            refId: artifact.refId,
            kind: artifact.kind,
            title: artifact.title,
            text: artifact.text,
            url: artifact.url,
            urls: artifact.urls,
            prompt: artifact.prompt,
            model: artifact.model,
            parentId: artifact.parentId,
            sourceArtifactIds: artifact.sourceArtifactIds,
            createdAt: artifact.createdAt,
          })),
        },
        {
          signal: controller.signal,
          onDelta: (delta) => {
            finalReply += delta;
            setStreamingReply((prev) => prev + delta);
          },
          onEvent: (event) => {
            if (event.type === 'turn.started' || event.event === 'turn.started') {
              if (toolMessageId) updateMessage(toolMessageId, { content: event.message || `已开始 ${modeTitle(inferredMode)} 任务`, progress: event.progress || 1, status: 'running' });
            }
            if (event.type === 'tool.progress' || event.event === 'tool.progress') {
              const progress = Number(event.progress || 0);
              if (toolMessageId) {
                updateMessage(toolMessageId, {
                  content: event.message || 'Grok OAuth Agent 正在运行...',
                  progress,
                  status: 'running',
                });
                update({
                  status: inferredMode === 'video' ? 'polling' : 'running',
                  progress,
                  requestId: event.requestId || d.requestId || '',
                  progressMessage: event.message || 'Grok OAuth Agent 正在运行...',
                });
              }
            }
            if (event.type === 'artifact.preview' || event.event === 'artifact.preview' || event.type === 'artifact.completed' || event.event === 'artifact.completed') {
              addArtifact(eventToArtifact(event, inferredMode, base.prompt, modelValue));
            }
            if (event.type === 'message.completed' || event.event === 'message.completed') {
              const textValue = String(event.text || event.result?.text || '').trim();
              if (textValue && !finalReply) finalReply = textValue;
            }
            if (event.type === 'turn.completed' || event.event === 'turn.completed') {
              if (toolMessageId) updateMessage(toolMessageId, { content: event.message || `${modeTitle(inferredMode)} 任务完成`, progress: 100, status: 'success' });
            }
          },
        },
      );

      const fallbackArtifact = resultToArtifact(inferredMode, result, base.prompt, modelValue);
      const savedFallback = addArtifact(fallbackArtifact);
      const textOut = String(result.text || result.reply || finalReply || '').trim();
      if (textOut) {
        appendMessage({
          id: `${turnId}_assistant`,
          turnId,
          role: 'assistant',
          content: textOut,
          mode: inferredMode,
          command,
          status: 'success',
          artifactIds: savedFallback ? [savedFallback.id] : [],
          createdAt: Date.now(),
        });
      } else if (inferredMode !== 'chat' && createdArtifactIds.length > 0) {
        appendMessage({
          id: `${turnId}_assistant`,
          turnId,
          role: 'assistant',
          content: `${modeTitle(inferredMode)} 已完成，产物已进入右侧产物库。`,
          mode: inferredMode,
          command,
          status: 'success',
          artifactIds: createdArtifactIds,
          createdAt: Date.now(),
        });
      }
      if (toolMessageId) updateMessage(toolMessageId, { status: 'success', progress: 100, content: `${modeTitle(inferredMode)} 任务完成` });
      const newestArtifact = [...artifactsRef.current].reverse().find((item) => createdArtifactIds.includes(item.id)) || savedFallback || null;
      update({
        status: 'success',
        error: '',
        progressMessage: '',
        promptResolved: base.prompt,
        lastSlashCommand: command,
        lastRunSummary: newestArtifact ? `${artifactKindLabel(newestArtifact.kind)} 已进入创作台产物库` : 'Grok OAuth Agent 运行完成',
      });
      if (autoPublishArtifacts && newestArtifact) publishArtifact(newestArtifact);
      taskCompletionSound.notifyComplete(id, 'grok-oauth-agent');
      logBus.success('Grok OAuth Agent 运行完成', `grok:${id}`);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        update({ status: 'idle', error: '已中止 Grok OAuth 任务。' });
        if (activeToolMessageId) updateMessage(activeToolMessageId, { status: 'error', progress: 100, content: '已中止 Grok OAuth 任务。' });
      } else {
        const message = e?.message || String(e);
        update({ status: 'error', error: message, progressMessage: '' });
        if (activeToolMessageId) {
          updateMessage(activeToolMessageId, { status: 'error', progress: 100, content: message });
        } else {
          appendMessage({ id: makeId('msg_error'), role: 'tool', content: message, mode: inferredMode, status: 'error', createdAt: Date.now() });
        }
        logBus.error(message, `grok:${id}`);
      }
    } finally {
      abortRef.current = null;
      setStreamingReply('');
      if (shouldClearTransientMaterials) clearTransientLocalMaterials();
    }
  }, [appendArtifact, appendMessage, autoIntent, autoPublishArtifacts, chatSettings.contextLimit, clearTransientLocalMaterials, contextCompressedCount, contextSummary, d.grokConversationId, d.requestId, d.videoModel, id, isBusy, localPrompt, mentionMaterials, mode, modePayload, orderedAudios, orderedTexts, payloadBase, persistLocalMaterials, persistPrompt, promptMentions, publishArtifact, status, update, updateMessage]);

  const handleQuickRun = useCallback(async (
    override?: { prompt?: string; mentions?: MediaMention[] },
    reporter?: RunNodeLifecycleReporter,
  ) => {
    if (isBusy) return;
    const rawRunPrompt = typeof override?.prompt === 'string' ? override.prompt : quickPrompt;
    const rawRunMentions = Array.isArray(override?.mentions) ? override.mentions : quickPromptMentions;
    const normalizedInput = normalizePromptMentionTokens(rawRunPrompt, rawRunMentions, mentionMaterials);
    const runPrompt = normalizedInput.text;
    const runMentions = normalizedInput.mentions;
    if (normalizedInput.changed) {
      update({ quickPrompt: runPrompt, quickPromptMentions: runMentions });
    }
    const slash = parseSlashCommand(runPrompt);
    const promptBody = slash ? slash.body : runPrompt;
    const effectiveMentions = slash ? shiftMentionsForSlashBody(runMentions, slash.bodyStart) : runMentions;
    const runPromptResolved = buildPrompt(promptBody, orderedTexts, effectiveMentions, mentionMaterials);
    const refMedia = referencedMediaByMentions(effectiveMentions, mentionMaterials);
    const hasAudioInput = orderedAudios.length > 0 || refMedia.audios.length > 0;
    const inferredMode = slash ? slash.mode : (autoIntent ? inferModeFromPrompt(runPromptResolved || promptBody, mode, hasAudioInput) : mode);
    const command = slash?.command || (inferredMode === 'image' ? 'image' : inferredMode === 'video' ? 'video' : inferredMode === 'tts' ? 'tts' : inferredMode === 'stt' ? 'stt' : 'chat');
    const base = payloadBase(inferredMode, promptBody, effectiveMentions);
    const videoModel = normalizeGrokVideoModel(d.videoModel || VIDEO_MODELS[0]);
    if (inferredMode === 'video' && isGrokImageOnlyVideoModel(videoModel) && base.images.length === 0 && base.videos.length === 0) {
      update({ status: 'error', error: 'grok-imagine-video-1.5-preview 只支持图生视频：请连接至少 1 张图片，或切换到 grok-imagine-video 做文生视频。' });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStreamingReply('');
    update({
      mode: inferredMode,
      status: 'running',
      error: '',
      progress: 1,
      progressMessage: 'Grok OAuth 简易生成中...',
      requestId: '',
      lastSlashCommand: command,
    });
    let shouldClearTransientMaterials = false;
    let shouldClearQuickPromptAfterDispatch = false;
    try {
      const latestStatus = status || await getGrokOAuthStatus();
      if (latestStatus.available === false || latestStatus.moduleEnabled === false) {
        throw new Error(latestStatus.message || GROK_OAUTH_PRIVATE_DISABLED_MESSAGE);
      }
      if (!latestStatus.loggedIn) throw new Error('请先点击“登录 / 绑定”完成 Grok OAuth 授权。');
      if (inferredMode !== 'stt' && !base.prompt) throw new Error('请填写 Prompt，或连接上游文本节点。');
      if (inferredMode === 'stt' && !(modePayload('stt', base) as any).audioUrl) throw new Error('STT 需要连接上游音频，或节点已有音频输出。');

      shouldClearTransientMaterials = !persistLocalMaterials && localMaterialsRef.current.length > 0;
      shouldClearQuickPromptAfterDispatch = !persistPrompt && (runPrompt.trim().length > 0 || runMentions.length > 0);
      if (shouldClearQuickPromptAfterDispatch) {
        update({ quickPrompt: '', quickPromptMentions: [] });
      }

      const turnId = makeId('quick_turn');
      const runtimeModePayload = modePayload(inferredMode, base) as any;
      if (inferredMode === 'chat') {
        runtimeModePayload.messages = [
          { role: 'user', content: base.prompt },
        ];
      }
      const modelValue = String(runtimeModePayload.model || '');
      await reporter?.providerRequest({ provider: 'grok-oauth', model: modelValue || inferredMode });
      let providerSubmittedRecorded = false;
      const sourceArtifactIds = Array.isArray(base.sourceArtifactIds) ? base.sourceArtifactIds : [];
      const parentArtifactId = String(base.parentArtifactId || sourceArtifactIds[0] || '');
      let finalReply = '';
      let latestEventArtifact: GrokAgentArtifact | null = null;
      const result = await streamGrokOAuthAgent(
        {
          ...base,
          ...runtimeModePayload,
          mode: inferredMode,
          command,
          slashCommand: slash?.command || '',
          turnId,
          conversationId: String(d.grokConversationId || 'default'),
          conversationContextLimit: 1,
          sourceArtifactIds,
          parentArtifactId,
          conversationMessages: [],
          conversationArtifacts: artifactsRef.current.slice(-16).map((artifact) => ({
            id: artifact.id,
            refId: artifact.refId,
            kind: artifact.kind,
            title: artifact.title,
            text: artifact.text,
            url: artifact.url,
            urls: artifact.urls,
            prompt: artifact.prompt,
            model: artifact.model,
            parentId: artifact.parentId,
            sourceArtifactIds: artifact.sourceArtifactIds,
            createdAt: artifact.createdAt,
          })),
        },
        {
          signal: controller.signal,
          submissionKey: reporter?.providerSubmissionKey,
          onDelta: (delta) => {
            finalReply += delta;
          },
          onEvent: async (event) => {
            if (event.type === 'tool.progress' || event.event === 'tool.progress') {
              const progress = Number(event.progress || 0);
              const eventResult = event.result || {};
              const payload = {
                provider: 'grok-oauth',
                model: modelValue || null,
                requestId: event.requestId || d.requestId || null,
                transportHttpStatus: eventResult.transportHttpStatus,
                upstreamHttpStatus: eventResult.upstreamHttpStatus,
                usage: eventResult.usage,
                pollCount: event.pollCount,
                httpStatusSource: 'local-backend',
                mode: inferredMode,
                progress,
                message: event.message || 'Grok OAuth 简易生成中...',
              };
              if (payload.requestId && !providerSubmittedRecorded) {
                await reporter?.providerSubmitted(payload);
                providerSubmittedRecorded = true;
              }
              if (inferredMode === 'video') await reporter?.polling(payload);
              else await reporter?.progress(payload);
              update({
                status: inferredMode === 'video' ? 'polling' : 'running',
                progress,
                requestId: event.requestId || d.requestId || '',
                progressMessage: event.message || 'Grok OAuth 简易生成中...',
              });
            }
            if (event.type === 'artifact.preview' || event.event === 'artifact.preview' || event.type === 'artifact.completed' || event.event === 'artifact.completed') {
              const artifact = eventToArtifact(event, inferredMode, base.prompt, modelValue);
              if (artifact) latestEventArtifact = artifact;
            }
            if (event.type === 'message.completed' || event.event === 'message.completed') {
              const textValue = String(event.text || event.result?.text || '').trim();
              if (textValue && !finalReply) finalReply = textValue;
            }
          },
        },
      );

      const textOut = String(result?.text || result?.reply || finalReply || '').trim();
      const fallbackArtifact = resultToArtifact(inferredMode, { ...(result || {}), text: textOut || result?.text, reply: textOut || result?.reply }, base.prompt, modelValue);
      const outputArtifact = latestEventArtifact || fallbackArtifact;
      if (!outputArtifact) throw new Error('Grok OAuth 没有返回可输出内容。');
      await reporter?.providerResponse({
        provider: 'grok-oauth',
        model: modelValue || inferredMode,
        requestId: result?.requestId || outputArtifact.requestId,
        transportHttpStatus: result?.transportHttpStatus,
        upstreamHttpStatus: result?.upstreamHttpStatus,
        usage: result?.usage,
        status: 'succeeded',
        httpStatusSource: 'local-backend',
      });
      outputArtifact.id = outputArtifact.id || makeId('quick_artifact');
      outputArtifact.turnId = outputArtifact.turnId || turnId;
      outputArtifact.command = outputArtifact.command || command;
      outputArtifact.sourceArtifactIds = outputArtifact.sourceArtifactIds?.length ? outputArtifact.sourceArtifactIds : sourceArtifactIds;
      outputArtifact.parentId = outputArtifact.parentId || parentArtifactId || undefined;
      outputArtifact.prompt = outputArtifact.prompt || base.prompt;
      outputArtifact.model = outputArtifact.model || modelValue;
      const label = artifactKindLabel(outputArtifact.kind);
      update({
        ...buildArtifactOutputPatch(outputArtifact, {
          prompt: base.prompt,
          summary: `${label} 已输出到画布素材`,
          quickLastRunSummary: `${label} · 已输出`,
          lastQuickOutputId: outputArtifact.id,
        }),
        provider: 'grok-oauth',
        model: modelValue || inferredMode,
        requestId: result?.requestId || outputArtifact.requestId,
        transportHttpStatus: result?.transportHttpStatus,
        upstreamHttpStatus: result?.upstreamHttpStatus,
        usage: result?.usage,
      });
      taskCompletionSound.notifyComplete(id, 'grok-oauth-agent');
      logBus.success(`Grok OAuth 简易生成完成：${label}`, `grok:${id}`);
    } catch (e: any) {
      await reporter?.providerResponse({
        provider: 'grok-oauth',
        model: String((modePayload(inferredMode, base) as any).model || inferredMode),
        requestId: e?.requestId,
        transportHttpStatus: e?.transportHttpStatus,
        upstreamHttpStatus: e?.upstreamHttpStatus,
        status: e?.name === 'AbortError' ? 'stopped' : 'failed',
        error: { message: e?.message || String(e), code: e?.code },
        httpStatusSource: 'local-backend',
      });
      if (e?.name === 'AbortError') {
        update({ status: 'idle', error: '已中止 Grok OAuth 任务。', progressMessage: '' });
      } else {
        const message = e?.message || String(e);
        update({ status: 'error', error: message, progressMessage: '' });
        logBus.error(message, `grok:${id}`);
      }
    } finally {
      abortRef.current = null;
      setStreamingReply('');
      if (shouldClearTransientMaterials) clearTransientLocalMaterials();
    }
  }, [autoIntent, clearTransientLocalMaterials, d.grokConversationId, d.requestId, d.videoModel, id, isBusy, mentionMaterials, mode, modePayload, orderedAudios, orderedTexts, payloadBase, persistLocalMaterials, persistPrompt, quickPrompt, quickPromptMentions, status, update]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearSession = useCallback(() => {
    messagesRef.current = [];
    artifactsRef.current = [];
    publishingArtifactIdsRef.current.clear();
    update({
      grokConversationId: makeId('chat'),
      agentMessages: [],
      agentArtifacts: [],
      lastArtifactId: '',
      lastPublishedArtifactId: '',
      lastRunSummary: '',
      status: 'idle',
      error: '',
      progressMessage: '',
      grokContextSummary: '',
      grokContextCompressedCount: 0,
      grokContextCompressedAt: 0,
      outputText: '',
      text: '',
      reply: '',
      imageUrl: '',
      imageUrls: [],
      videoUrl: '',
      videoUrls: [],
      audioUrl: '',
      audioUrls: [],
    });
  }, [update]);

  const startNewConversation = useCallback(() => {
    abortRef.current?.abort();
    messagesRef.current = [];
    setStreamingReply('');
    update({
      grokConversationId: makeId('chat'),
      agentMessages: [],
      status: 'idle',
      error: '',
      progressMessage: '',
      grokContextSummary: '',
      grokContextCompressedCount: 0,
      grokContextCompressedAt: 0,
      lastRunSummary: '已开启新对话，右侧产物库已保留。',
    });
  }, [update]);

  const insertArtifactIntoPrompt = useCallback((artifact: GrokAgentArtifact, command?: 'image' | 'video' | 'stt') => {
    const stableArtifact = ensureArtifactRefId(artifact, artifactsRef.current);
    if (stableArtifact.refId !== artifact.refId) {
      setAgentArtifacts(
        artifactsRef.current.map((item) => item.id === stableArtifact.id ? stableArtifact : item),
      );
    }
    const material = artifactToMaterial(stableArtifact, id);
    if (!material) return;
    const allMentionMaterials = [...mentionMaterials.filter((item) => materialMentionKey(item) !== materialMentionKey(material)), material];
    const token = tokenForMaterial(material, allMentionMaterials);
    const prefix = command ? `/${command} ` : '';
    const baseText = command ? prefix : `${localPrompt.trimEnd()}${localPrompt.trim() ? ' ' : ''}`;
    const textBeforeMention = baseText;
    const nextText = `${textBeforeMention}${token} `;
    const mention: MediaMention = {
      id: `${materialMentionKey(material)}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      kind: material.kind as any,
      materialKey: materialMentionKey(material),
      url: material.url,
      label: material.label,
      token,
      start: textBeforeMention.length,
      end: textBeforeMention.length + token.length,
    };
    const nextMentions = command ? [mention] : [...promptMentions, mention].sort((a, b) => a.start - b.start);
    update({
      prompt: nextText,
      promptMentions: nextMentions,
      mode: command === 'video' ? 'video' : command === 'stt' ? 'stt' : command === 'image' ? 'image' : mode,
      error: '',
    });
    setStudioOpen(true);
  }, [id, localPrompt, mentionMaterials, mode, promptMentions, setAgentArtifacts, update]);

  const insertSlashCommand = useCallback((insert: string, nextMode: GrokOAuthMode) => {
    const slash = parseSlashCommand(localPrompt);
    const withoutOldSlash = slash ? slash.body : localPrompt;
    update({
      prompt: `${insert}${withoutOldSlash}`.trimEnd() + ' ',
      promptMentions: slash ? shiftMentionsForSlashBody(promptMentions, slash.bodyStart).map((mention) => ({ ...mention, start: mention.start + insert.length, end: mention.end + insert.length })) : promptMentions.map((mention) => ({ ...mention, start: mention.start + insert.length, end: mention.end + insert.length })),
      mode: nextMode,
      error: '',
    });
    setStudioOpen(true);
  }, [localPrompt, promptMentions, update]);

  const activeSlashCommand = useMemo(() => parseSlashCommand(localPrompt)?.command || slashCommandFromMode(mode), [localPrompt, mode]);

  const requestGrokCanvasRun = useCallback((
    surface: 'quick' | 'studio',
    override?: { prompt?: string; mentions?: MediaMention[] },
  ) => {
    const requestId = createCanvasNodeRunRequestId(id, `grok-${surface}`);
    const promptPatch = surface === 'studio'
      ? {
          ...(typeof override?.prompt === 'string' ? { prompt: override.prompt } : {}),
          ...(Array.isArray(override?.mentions) ? { promptMentions: override.mentions } : {}),
        }
      : {
          ...(typeof override?.prompt === 'string' ? { quickPrompt: override.prompt } : {}),
          ...(Array.isArray(override?.mentions) ? { quickPromptMentions: override.mentions } : {}),
        };
    // Persist the chosen surface before requesting Canvas authorization. The
    // surface and latest prompt therefore participate in the execution-graph
    // digest instead of living in an uninspectable click-local closure.
    update({ ...promptPatch, grokRunSurface: surface, grokRunRequestId: requestId });
    window.requestAnimationFrame(() => requestCanvasNodeRun(id, { requestId }));
  }, [id, update]);

  useRunTrigger(
    id,
    async (reporter) => {
      const liveData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
      const exactRequestedSurface = Boolean(reporter.runContext?.requestId)
        && reporter.runContext?.requestId === liveData?.grokRunRequestId
        ? String(liveData?.grokRunSurface || 'quick')
        : 'quick';
      try {
        if (exactRequestedSurface === 'studio') await handleRun();
        else await handleQuickRun(undefined, reporter);
      } finally {
        update({ grokRunSurface: 'quick', grokRunRequestId: '' });
      }
    },
    'grok-oauth-agent',
    { lifecycleAware: true },
  );

  const renderModeParams = (compact = false) => {
    if (mode === 'chat') {
      return (
        <SelectField label="Chat 模型" value={d.chatModel || CHAT_MODELS[0]} options={CHAT_MODELS} onChange={(value) => update({ chatModel: value })} surface={surface} text={text} border={border} subText={subText} />
      );
    }
    if (mode === 'image') {
      return (
        <div className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-3'} gap-2`}>
          <SelectField label="图像模型" value={d.imageModel || IMAGE_MODELS[0]} options={IMAGE_MODELS} onChange={(value) => update({ imageModel: value })} surface={surface} text={text} border={border} subText={subText} />
          <SelectField label="比例" value={d.ratio || '1:1'} options={RATIOS} onChange={(value) => update({ ratio: value })} surface={surface} text={text} border={border} subText={subText} />
          <SelectField label="分辨率" value={d.imageResolution || '1k'} options={['1k', '2k']} onChange={(value) => update({ imageResolution: value })} surface={surface} text={text} border={border} subText={subText} />
        </div>
      );
    }
    if (mode === 'video') {
      const selectedVideoModel = normalizeGrokVideoModel(d.videoModel || VIDEO_MODELS[0]);
      const imageOnly = isGrokImageOnlyVideoModel(selectedVideoModel);
      const hasVideoImageInput = orderedImages.length > 0;
      const hintNeedsContrast = imageOnly && !hasVideoImageInput;
      return (
        <div className="space-y-2">
          <div className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-2'} gap-2`}>
            <SelectField label="视频模型" value={selectedVideoModel} options={VIDEO_MODELS} labels={VIDEO_MODEL_LABELS} onChange={(value) => update({ videoModel: value })} surface={surface} text={text} border={border} subText={subText} />
            <SelectField label="比例" value={d.ratio || '16:9'} options={RATIOS} onChange={(value) => update({ ratio: value })} surface={surface} text={text} border={border} subText={subText} />
            <SelectField label="清晰度" value={d.videoResolution || '720p'} options={RESOLUTIONS.slice(0, 2)} onChange={(value) => update({ videoResolution: value })} surface={surface} text={text} border={border} subText={subText} />
            <NumberField label="时长(s)" value={Number(d.duration || 8)} min={1} max={imageOnly ? 10 : 15} onChange={(value) => update({ duration: value })} surface={surface} text={text} border={border} subText={subText} />
          </div>
          <div
            className="rounded px-2 py-1 text-[10px] leading-relaxed"
            style={{
              background: hintNeedsContrast || isPixel ? noticeCardBg : surfaceStrong,
              color: hintNeedsContrast || isPixel ? noticeCardText : subText,
              border: `1px solid ${hintNeedsContrast || isPixel ? noticeCardBorder : border}`,
            }}
          >
            {imageOnly ? '1.5 preview 只支持图生视频；请连接上游图片，文生视频请选择 grok-imagine-video。' : 'grok-imagine-video 支持文生视频；连接图片时也可作为旧图生视频 / 参考图路径。'}
          </div>
        </div>
      );
    }
    if (mode === 'tts') {
      return (
        <div className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-3'} gap-2`}>
          <TextField label="声音" value={d.voiceId || 'eve'} onChange={(value) => update({ voiceId: value })} surface={surface} text={text} border={border} subText={subText} />
          <TextField label="语言" value={d.language || 'zh'} onChange={(value) => update({ language: value })} surface={surface} text={text} border={border} subText={subText} />
          <SelectField label="格式" value={d.outputFormat || 'mp3'} options={['mp3', 'wav', 'opus']} onChange={(value) => update({ outputFormat: value })} surface={surface} text={text} border={border} subText={subText} />
        </div>
      );
    }
    return (
      <div className="rounded px-2 py-2 text-[11px]" style={{ background: surface, color: subText, border: `1px solid ${border}` }}>
        STT 会读取第一个上游音频，转写结果进入创作台；需要输出到画布时点击产物卡“发布”。
      </div>
    );
  };

  const modeChips = (
    <div className="grid grid-cols-5 gap-1.5">
      {MODES.map((item) => {
        const Icon = item.icon;
        const active = mode === item.id;
        return (
          <button key={item.id} type="button" title={item.hint} onClick={() => update({ mode: item.id, error: '', status: 'idle' })} className="nodrag rounded px-1 py-1.5 text-[10px] font-bold flex flex-col items-center gap-1" style={{ background: active ? accent : surface, color: active ? studioAccentText : text, border: `1px solid ${active ? accent : border}` }}>
            <Icon size={13} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );

  const loginPanel = (compact = false) => (
    <div className="space-y-2">
      <div className={`grid ${status?.loggedIn ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
        <button type="button" onClick={handleLogin} className="nodrag rounded px-2 py-1.5 text-[11px] font-bold flex items-center justify-center gap-1" style={{ background: status?.loggedIn ? surface : accent, color: status?.loggedIn ? text : studioAccentText, border: `1px solid ${border}` }}>
          {loginPolling ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />} {status?.loggedIn ? '重新登录 / 绑定' : '登录 / 绑定'}
        </button>
        {status?.loggedIn && (
          <button type="button" onClick={handleLogout} className="nodrag rounded px-2 py-1.5 text-[11px] font-bold flex items-center justify-center gap-1" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
            <LogOut size={12} /> 退出
          </button>
        )}
      </div>
      {(oauthLoginUrl || loginPolling || manualCode) && !status?.loggedIn && (
        <div className="space-y-2 rounded p-2 text-[10px]" style={{ background: surfaceStrong, color: text, border: `1px solid ${border}` }}>
          <div className="leading-relaxed" style={{ color: subText }}>
            如果 Grok 页面显示“无法建立连接”，复制页面中的授权码，粘贴到这里完成绑定。
          </div>
          <div className="flex gap-2">
            {oauthLoginUrl && (
              <button type="button" className="nodrag flex-1 rounded px-2 py-1 font-bold" style={{ background: surface, color: text, border: `1px solid ${border}` }} onClick={() => window.open(oauthLoginUrl, '_blank', 'noopener,noreferrer')}>
                打开授权页
              </button>
            )}
            <button type="button" className="nodrag rounded px-2 py-1 font-bold" style={{ background: surface, color: text, border: `1px solid ${border}` }} onClick={() => void handlePasteManualCode()}>
              粘贴
            </button>
          </div>
          <div className={`grid ${compact ? 'grid-cols-1' : 'grid-cols-[1fr_auto]'} gap-2`}>
            <input className="nodrag nowheel min-w-0 rounded px-2 py-1 text-[11px] outline-none" style={{ background: bg, color: text, border: `1px solid ${border}` }} value={manualCode} onChange={(e) => setManualCode(e.target.value)} placeholder="粘贴 Grok 授权码" autoComplete="off" spellCheck={false} />
            <button type="button" className="nodrag rounded px-2 py-1 font-bold" style={{ background: accent, color: studioAccentText, border: `1px solid ${accent}` }} onClick={() => void handleCompleteLogin()}>
              完成授权
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const totalMaterials = orderedTexts.length + orderedImages.length + orderedVideos.length + orderedAudios.length;
  const latestSummary = quickLastRunSummary || (lastArtifact
    ? `${artifactKindLabel(lastArtifact.kind)} · ${lastArtifact.publishedAt ? '已发布' : '待发布'}`
    : (d.lastRunSummary || '还没有产物'));

  return (
    <div className="t8-grok-oauth-agent-node relative flex flex-col" style={rootStyle}>
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        accept={GROK_UPLOAD_ACCEPT.auto}
        className="hidden"
        onChange={handleLocalMaterialFiles}
      />
      <Handle type="target" position={Position.Left} className="t8-grok-oauth-agent-handle" style={{ ...handleStyle, background: PORT_COLOR.any, left: -12, top: '50%' }} />
      <Handle id="text" type="source" position={Position.Right} className="t8-grok-oauth-agent-handle" title="文本输出" style={{ ...handleStyle, background: PORT_COLOR.text, right: -12, top: '34%' }} />
      <Handle id="image" type="source" position={Position.Right} className="t8-grok-oauth-agent-handle" title="图像输出" style={{ ...handleStyle, background: PORT_COLOR.image, right: -12, top: '44%' }} />
      <Handle id="video" type="source" position={Position.Right} className="t8-grok-oauth-agent-handle" title="视频输出" style={{ ...handleStyle, background: PORT_COLOR.video, right: -12, top: '54%' }} />
      <Handle id="audio" type="source" position={Position.Right} className="t8-grok-oauth-agent-handle" title="音频输出" style={{ ...handleStyle, background: PORT_COLOR.audio, right: -12, top: '64%' }} />

      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${border}` }}>
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: surfaceStrong, color: accent, border: `1px solid ${border}` }}>
          <Bot size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm">Grok OAuth Agent</div>
          <div className="text-[10px] truncate" style={{ color: subText }}>{statusMessage}</div>
        </div>
        <button type="button" className="nodrag rounded px-2 py-1 text-[10px]" style={{ background: surface, color: text, border: `1px solid ${border}` }} onClick={() => void refreshStatus()} title="刷新状态">
          {statusLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
      </div>

      <div className="nodrag nowheel p-3 space-y-3" onMouseDown={(e) => e.stopPropagation()}>
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <StatPill label="消息" value={agentMessages.length} surface={surface} text={text} border={border} />
          <StatPill label="产物" value={agentArtifacts.length} surface={surface} text={text} border={border} />
          <StatPill label="素材" value={totalMaterials} surface={surface} text={text} border={border} />
        </div>

        <button type="button" onClick={() => setStudioOpen(true)} className="nodrag w-full rounded-xl py-2 text-xs font-bold flex items-center justify-center gap-2" style={{ background: accent, color: studioAccentText, border: `1px solid ${accent}`, boxShadow: isPixel ? '2px 2px 0 var(--px-ink)' : '0 10px 24px rgba(16,185,129,0.20)' }}>
          <PanelRightOpen size={15} /> 打开 Grok 创作台
        </button>

        {loginPanel(true)}

        <div className="rounded p-2 text-[11px] space-y-1" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold flex items-center gap-1"><Sparkles size={12} /> 当前会话</span>
            <span style={{ color: subText }}>{modeTitle(mode)} · {autoIntent ? '智能识别' : '手动模式'}</span>
          </div>
          <div className="truncate" style={{ color: subText }}>{latestSummary}</div>
        </div>

        <div className="rounded p-2 space-y-2" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="font-bold flex items-center gap-1"><Send size={12} /> 简易生成</span>
            <span className="text-[10px]" style={{ color: subText }}>直接输出到右侧素材</span>
          </div>
          {modeChips}
          {renderModeParams(true)}
          <MentionPromptInput
            title="Grok 简易 Prompt"
            value={quickPrompt}
            mentions={quickPromptMentions}
            materials={mentionMaterials}
            onChange={(value, mentions) => update({ quickPrompt: value, quickPromptMentions: mentions })}
            onSubmit={(value, mentions) => requestGrokCanvasRun('quick', { prompt: value, mentions })}
            placeholder="写一句话直接生成，也可以 @ 引用上游或产物"
            isDark={isDark}
            isPixel={isPixel}
            promptTemplateKind={mode === 'video' ? 'video' : 'image'}
            className="w-full min-h-[76px] rounded-lg px-2 py-2 text-[12px] leading-relaxed outline-none"
            style={{ background: bg, color: text, border: `1px solid ${border}` }}
          />
          <div className="text-[10px] leading-relaxed" style={{ color: subText }}>
            小节点简易生成不会写入 Grok 创作台历史；需要连续对话、产物库和版本引用时打开创作台。
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {isBusy ? (
            <button type="button" onClick={handleStop} className="nodrag rounded px-2 py-1.5 text-[11px] font-bold flex items-center justify-center gap-1" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
              <Square size={12} /> 停止
            </button>
          ) : (
            <button type="button" onClick={() => requestGrokCanvasRun('quick')} className="nodrag rounded px-2 py-1.5 text-[11px] font-bold flex items-center justify-center gap-1" style={{ background: surfaceStrong, color: text, border: `1px solid ${border}` }}>
              <Send size={12} /> 简易生成
            </button>
          )}
          <button type="button" disabled={!lastArtifact || !!lastArtifact?.publishedAt} onClick={() => publishArtifact(lastArtifact)} className="nodrag rounded px-2 py-1.5 text-[11px] font-bold flex items-center justify-center gap-1 disabled:opacity-45" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
            <CheckCircle2 size={12} /> {lastArtifact?.publishedAt ? '已发布' : '发布最新'}
          </button>
        </div>

        {error && (
          <div className="rounded px-2 py-2 text-[11px] flex items-start gap-1" style={{ color: danger, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)' }}>
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
        {(isBusy || d.progressMessage) && (
          <div className="flex items-center gap-1 text-[10px]" style={{ color: accent }}>
            {isBusy && <Loader2 size={11} className="animate-spin" />}
            <span className="flex-1">{d.progressMessage || (mode === 'chat' ? '流式输出中...' : '运行中...')}</span>
          </div>
        )}
      </div>

      {studioOpen && createPortal(
        <GrokAgentStudio
          nodeId={id}
          bg={bg}
          surface={surface}
          surfaceStrong={surfaceStrong}
          text={text}
          subText={subText}
          border={border}
          accent={accent}
          accentText={studioAccentText}
          headerText={studioHeaderText}
          headerSubText={studioHeaderSubText}
          danger={danger}
          isDark={isDark}
          isPixel={isPixel}
          status={status}
          statusMessage={statusMessage}
          isBusy={isBusy}
          mode={mode}
          localPrompt={localPrompt}
          promptMentions={promptMentions}
          mentionMaterials={mentionMaterials}
          materialOrder={materialOrder}
          orderedTexts={orderedTexts}
          orderedImages={orderedImages}
          orderedVideos={orderedVideos}
          orderedAudios={orderedAudios}
          agentMessages={agentMessages}
          agentArtifacts={agentArtifacts}
          streamingReply={streamingReply}
          error={error}
          progressMessage={String(d.progressMessage || '')}
          autoIntent={autoIntent}
          autoPublishArtifacts={autoPublishArtifacts}
          persistPrompt={persistPrompt}
          persistLocalMaterials={persistLocalMaterials}
          contextSummary={contextSummary}
          contextCompressedCount={contextCompressedCount}
          chatSettings={chatSettings}
          uploadingKind={uploadingKind}
          modeChips={modeChips}
          activeSlashCommand={activeSlashCommand}
          loginPanel={loginPanel(false)}
          renderModeParams={() => renderModeParams(false)}
          onClose={() => setStudioOpen(false)}
          onRun={(override) => requestGrokCanvasRun('studio', override)}
          onStop={handleStop}
          onRefresh={() => void refreshStatus()}
          onPromptChange={(value, mentions) => update({ prompt: value, promptMentions: mentions })}
          onMaterialOrder={setMaterialOrder}
          onModeChange={(nextMode) => update({ mode: nextMode, error: '', status: 'idle' })}
          onAutoIntentChange={(value) => update({ autoIntent: value })}
          onAutoPublishChange={(value) => update({ autoPublishArtifacts: value })}
          onPersistPromptChange={(value) => update({ grokPersistPrompt: value })}
          onPersistLocalMaterialsChange={(value) => update({ grokPersistLocalMaterials: value })}
          onChatSettingsChange={(patch) => update({
            ...(patch.contextLimit !== undefined ? { grokContextLimit: clampInteger(patch.contextLimit, DEFAULT_GROK_CONTEXT_LIMIT, 0, MAX_GROK_CONTEXT_LIMIT) } : {}),
            ...(patch.temperature !== undefined ? { grokTemperature: clampNumber(patch.temperature, DEFAULT_GROK_TEMPERATURE, 0, 2) } : {}),
            ...(patch.topP !== undefined ? { grokTopP: clampNumber(patch.topP, DEFAULT_GROK_TOP_P, 0.01, 1) } : {}),
            ...(patch.topK !== undefined ? { grokTopK: clampInteger(patch.topK, DEFAULT_GROK_TOP_K, 0, 200) } : {}),
            ...(patch.maxOutputTokens !== undefined ? { grokMaxOutputTokens: clampInteger(patch.maxOutputTokens, DEFAULT_GROK_MAX_OUTPUT_TOKENS, 256, 8192) } : {}),
          })}
          onPublish={publishArtifact}
          onDeleteArtifacts={deleteArtifacts}
          onArtifactReference={(artifact) => insertArtifactIntoPrompt(artifact)}
          onArtifactContinue={(artifact) => {
            if (artifact.kind === 'image') insertArtifactIntoPrompt(artifact, 'image');
            else if (artifact.kind === 'audio') insertArtifactIntoPrompt(artifact, 'stt');
            else insertArtifactIntoPrompt(artifact);
          }}
          onArtifactMakeVideo={(artifact) => insertArtifactIntoPrompt(artifact, 'video')}
          onInsertSlashCommand={insertSlashCommand}
          onPickLocalMaterial={pickLocalMaterial}
          onRemoveLocalMaterial={removeLocalMaterial}
          onNewConversation={startNewConversation}
          onClearSession={clearSession}
        />,
        document.body,
      )}
    </div>
  );
};

interface StudioProps {
  nodeId: string;
  bg: string;
  surface: string;
  surfaceStrong: string;
  text: string;
  subText: string;
  border: string;
  accent: string;
  accentText: string;
  headerText: string;
  headerSubText: string;
  danger: string;
  isDark: boolean;
  isPixel: boolean;
  status: GrokOAuthStatus | null;
  statusMessage: string;
  isBusy: boolean;
  mode: GrokOAuthMode;
  localPrompt: string;
  promptMentions: MediaMention[];
  mentionMaterials: Material[];
  materialOrder: string[];
  orderedTexts: Material[];
  orderedImages: Material[];
  orderedVideos: Material[];
  orderedAudios: Material[];
  agentMessages: GrokAgentMessage[];
  agentArtifacts: GrokAgentArtifact[];
  streamingReply: string;
  error: string;
  progressMessage: string;
  autoIntent: boolean;
  autoPublishArtifacts: boolean;
  persistPrompt: boolean;
  persistLocalMaterials: boolean;
  contextSummary: string;
  contextCompressedCount: number;
  chatSettings: GrokChatSettings;
  uploadingKind: GrokUploadKind | '';
  modeChips: ReactNode;
  activeSlashCommand: string;
  loginPanel: ReactNode;
  renderModeParams: () => ReactNode;
  onClose: () => void;
  onRun: (override?: { prompt?: string; mentions?: MediaMention[] }) => void;
  onStop: () => void;
  onRefresh: () => void;
  onPromptChange: (value: string, mentions: MediaMention[]) => void;
  onMaterialOrder: (order: string[]) => void;
  onModeChange: (mode: GrokOAuthMode) => void;
  onAutoIntentChange: (value: boolean) => void;
  onAutoPublishChange: (value: boolean) => void;
  onPersistPromptChange: (value: boolean) => void;
  onPersistLocalMaterialsChange: (value: boolean) => void;
  onChatSettingsChange: (patch: Partial<GrokChatSettings>) => void;
  onPublish: (artifact: GrokAgentArtifact) => void;
  onDeleteArtifacts: (artifacts: GrokAgentArtifact[], summary?: string) => void;
  onArtifactReference: (artifact: GrokAgentArtifact) => void;
  onArtifactContinue: (artifact: GrokAgentArtifact) => void;
  onArtifactMakeVideo: (artifact: GrokAgentArtifact) => void;
  onInsertSlashCommand: (insert: string, mode: GrokOAuthMode) => void;
  onPickLocalMaterial: (kind?: GrokUploadKind) => void;
  onRemoveLocalMaterial: (material: Material) => void;
  onNewConversation: () => void;
  onClearSession: () => void;
}

function GrokAgentStudio({
  nodeId,
  bg,
  surface,
  surfaceStrong,
  text,
  subText,
  border,
  accent,
  accentText,
  headerText,
  headerSubText,
  danger,
  isDark,
  isPixel,
  status,
  statusMessage,
  isBusy,
  mode,
  localPrompt,
  promptMentions,
  mentionMaterials,
  materialOrder,
  orderedTexts,
  orderedImages,
  orderedVideos,
  orderedAudios,
  agentMessages,
  agentArtifacts,
  streamingReply,
  error,
  progressMessage,
  autoIntent,
  autoPublishArtifacts,
  persistPrompt,
  persistLocalMaterials,
  contextSummary,
  contextCompressedCount,
  chatSettings,
  uploadingKind,
  modeChips,
  activeSlashCommand,
  loginPanel,
  renderModeParams,
  onClose,
  onRun,
  onStop,
  onRefresh,
  onPromptChange,
  onMaterialOrder,
  onAutoIntentChange,
  onAutoPublishChange,
  onPersistPromptChange,
  onPersistLocalMaterialsChange,
  onChatSettingsChange,
  onPublish,
  onDeleteArtifacts,
  onArtifactReference,
  onArtifactContinue,
  onArtifactMakeVideo,
  onInsertSlashCommand,
  onPickLocalMaterial,
  onRemoveLocalMaterial,
  onNewConversation,
  onClearSession,
}: StudioProps) {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [artifactTab, setArtifactTab] = useState<GrokArtifactTab>('image');
  const [artifactBatchMode, setArtifactBatchMode] = useState(false);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agentMessages, streamingReply]);
  useEffect(() => {
    setSelectedArtifactIds((current) => current.filter((artifactId) => agentArtifacts.some((artifact) => artifact.id === artifactId)));
  }, [agentArtifacts]);

  const materialTotal = orderedTexts.length + orderedImages.length + orderedVideos.length + orderedAudios.length;
  const artifactGroups = useMemo<Record<GrokArtifactTab, GrokAgentArtifact[]>>(() => ({
    text: agentArtifacts.filter((item) => item.kind === 'text' || item.kind === 'transcript'),
    image: agentArtifacts.filter((item) => item.kind === 'image'),
    video: agentArtifacts.filter((item) => item.kind === 'video'),
    audio: agentArtifacts.filter((item) => item.kind === 'audio'),
  }), [agentArtifacts]);
  const artifactTabs = useMemo<Array<{ id: GrokArtifactTab; label: string; title: string; icon: ReactNode; count: number }>>(() => [
    { id: 'image', label: '图像', title: '图像', icon: <ImageIcon size={13} />, count: artifactGroups.image.length },
    { id: 'video', label: '视频', title: '视频', icon: <Video size={13} />, count: artifactGroups.video.length },
    { id: 'audio', label: '音频', title: '音频', icon: <Music2 size={13} />, count: artifactGroups.audio.length },
    { id: 'text', label: '文本', title: '文本 / 转写', icon: <MessageCircle size={13} />, count: artifactGroups.text.length },
  ], [artifactGroups]);
  const activeArtifactTab = artifactTabs.find((item) => item.id === artifactTab) || artifactTabs[0];
  const activeArtifacts = artifactGroups[activeArtifactTab.id];
  const selectedActiveArtifacts = activeArtifacts.filter((artifact) => selectedArtifactIds.includes(artifact.id));
  const allActiveArtifactsSelected = activeArtifacts.length > 0 && activeArtifacts.every((artifact) => selectedArtifactIds.includes(artifact.id));
  const toggleArtifactSelection = useCallback((artifactId: string) => {
    setSelectedArtifactIds((current) => (
      current.includes(artifactId)
        ? current.filter((item) => item !== artifactId)
        : [...current, artifactId]
    ));
  }, []);
  const toggleSelectActiveArtifacts = useCallback(() => {
    setSelectedArtifactIds((current) => {
      const ids = activeArtifacts.map((artifact) => artifact.id);
      if (ids.length === 0) return current;
      if (ids.every((artifactId) => current.includes(artifactId))) {
        return current.filter((artifactId) => !ids.includes(artifactId));
      }
      return Array.from(new Set([...current, ...ids]));
    });
  }, [activeArtifacts]);
  const deleteSelectedArtifacts = useCallback(() => {
    const selectedArtifacts = agentArtifacts.filter((artifact) => selectedArtifactIds.includes(artifact.id));
    onDeleteArtifacts(selectedArtifacts, `已删除 ${selectedArtifacts.length} 个 Grok 产物`);
    setSelectedArtifactIds([]);
  }, [agentArtifacts, onDeleteArtifacts, selectedArtifactIds]);
  const clearAllArtifacts = useCallback(() => {
    onDeleteArtifacts(agentArtifacts, '已清空 Grok 产物库');
    setSelectedArtifactIds([]);
    setArtifactBatchMode(false);
  }, [agentArtifacts, onDeleteArtifacts]);
  const readablePalette = createReadableStudioPalette({ isDark, isPixel, accent, bg, surface, surfaceStrong, text, subText, border, danger });
  const noticeCardBg = readablePalette.noticeBg;
  const noticeCardText = readablePalette.noticeText;
  const noticeCardSubText = readablePalette.noticeSubText;
  const noticeCardBorder = readablePalette.noticeBorder;
  const noticeBusy = !error && (isBusy || !!uploadingKind);

  return (
    <div className="fixed inset-0 z-[9999] nodrag nowheel" style={{ background: isDark ? 'rgba(0,0,0,0.72)' : 'rgba(15,23,42,0.34)' }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="absolute inset-4 rounded-2xl overflow-hidden flex flex-col" style={{ background: bg, color: text, border: `1px solid ${border}`, boxShadow: '0 30px 80px rgba(0,0,0,0.38)' }}>
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${border}`, background: surfaceStrong, color: headerText }}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: surface, color: accent, border: `1px solid ${border}` }}>
            <Bot size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-base flex items-center gap-2">
              Grok 创作台
              {isBusy && <Loader2 size={15} className="animate-spin" style={{ color: accent }} />}
            </div>
            <div className="text-[11px] truncate" style={{ color: headerSubText }}>{statusMessage}</div>
          </div>
          <button type="button" onClick={onRefresh} className="rounded-lg px-3 py-1.5 text-xs font-bold" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
            <RefreshCw size={13} className="inline mr-1" /> 刷新
          </button>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-bold" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
            <X size={13} className="inline mr-1" /> 关闭
          </button>
        </div>

        <div className="grid grid-cols-[280px_minmax(420px,1fr)_360px] gap-0 min-h-0 flex-1">
          <aside className="min-h-0 overflow-y-auto p-4 space-y-3" style={{ borderRight: `1px solid ${border}` }}>
            {loginPanel}
            <Panel title="输入素材" icon={<Sparkles size={14} />} surface={surface} border={border} text={text} subText={subText} aside={`${materialTotal} 项`}>
              <MaterialPreviewSection
                texts={orderedTexts}
                images={orderedImages}
                videos={orderedVideos}
                audios={orderedAudios}
                order={materialOrder}
                onReorder={onMaterialOrder}
                onRemoveLocal={onRemoveLocalMaterial}
                isDark={isDark}
                isPixel={isPixel}
                title="上游素材 · Agent 输入"
              />
              {materialTotal === 0 && <div className="text-[11px]" style={{ color: subText }}>可从左侧连接文本、图片、视频或音频，也可以直接在 Prompt 里描述任务。</div>}
            </Panel>
            <Panel title="对话上下文" icon={<MessageCircle size={14} />} surface={surface} border={border} text={text} subText={subText}>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <NumberField label="上下文条数" value={chatSettings.contextLimit} min={0} max={MAX_GROK_CONTEXT_LIMIT} step={1} onChange={(value) => onChatSettingsChange({ contextLimit: Math.round(value) })} surface={surfaceStrong} text={text} border={border} subText={subText} />
                  <NumberField label="最大输出" value={chatSettings.maxOutputTokens} min={256} max={8192} step={256} onChange={(value) => onChatSettingsChange({ maxOutputTokens: Math.round(value) })} surface={surfaceStrong} text={text} border={border} subText={subText} />
                  <NumberField label="Temperature" value={chatSettings.temperature} min={0} max={2} step={0.1} onChange={(value) => onChatSettingsChange({ temperature: value })} surface={surfaceStrong} text={text} border={border} subText={subText} />
                  <NumberField label="Top P" value={chatSettings.topP} min={0.01} max={1} step={0.05} onChange={(value) => onChatSettingsChange({ topP: value })} surface={surfaceStrong} text={text} border={border} subText={subText} />
                  <NumberField label="Top K" value={chatSettings.topK} min={0} max={200} step={1} onChange={(value) => onChatSettingsChange({ topK: Math.round(value) })} surface={surfaceStrong} text={text} border={border} subText={subText} />
                </div>
                <div className="rounded-lg px-2 py-1.5 text-[10px] leading-relaxed" style={{ background: noticeCardBg, color: noticeCardText, border: `1px solid ${noticeCardBorder}` }}>
                  上下文 0 表示只发当前输入；超过条数的旧对话会自动压缩成长期记忆。Top K 为 0 时不主动传参，避免模型不支持时触发错误。
                </div>
                {contextSummary && (
                  <div className="rounded-lg px-2 py-1.5 text-[10px] leading-relaxed" style={{ background: surfaceStrong, color: text, border: `1px solid ${border}` }}>
                    已压缩 {contextCompressedCount} 条历史为长期记忆，新对话或清空全部会重置。
                  </div>
                )}
              </div>
            </Panel>
            <Panel title="模式参数" icon={<Wand2 size={14} />} surface={surface} border={border} text={text} subText={subText}>
              <div className="space-y-3">
                {modeChips}
                {renderModeParams()}
                <label className="flex items-center gap-2 text-[11px]" style={{ color: text }}>
                  <input type="checkbox" checked={autoIntent} onChange={(e) => onAutoIntentChange(e.target.checked)} />
                  根据文字自动识别图像 / 视频 / 音频任务
                </label>
                <label className="flex items-center gap-2 text-[11px]" style={{ color: text }}>
                  <input type="checkbox" checked={autoPublishArtifacts} onChange={(e) => onAutoPublishChange(e.target.checked)} />
                  生成后自动发布到画布输出
                </label>
                <label className="flex items-start gap-2 rounded-lg p-2 text-[11px]" style={{ color: noticeCardText, background: noticeCardBg, border: `1px solid ${noticeCardBorder}` }}>
                  <input type="checkbox" checked={persistPrompt} onChange={(e) => onPersistPromptChange(e.target.checked)} />
                  <span className="min-w-0">
                    <span className="block font-bold">提示词持久化</span>
                    <span className="block text-[10px] leading-relaxed" style={{ color: noticeCardSubText }}>
                      默认关闭：任务发送后自动清空 Prompt；开启后保留输入，方便连续微调。
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-lg p-2 text-[11px]" style={{ color: noticeCardText, background: noticeCardBg, border: `1px solid ${noticeCardBorder}` }}>
                  <input type="checkbox" checked={persistLocalMaterials} onChange={(e) => onPersistLocalMaterialsChange(e.target.checked)} />
                  <span className="min-w-0">
                    <span className="block font-bold">素材持久化</span>
                    <span className="block text-[10px] leading-relaxed" style={{ color: noticeCardSubText }}>
                      默认关闭：创作台上传素材只参与本轮运行，结束后自动清理；上游连线和产物库不受影响。
                    </span>
                  </span>
                </label>
              </div>
            </Panel>
          </aside>

          <main className="min-h-0 flex flex-col">
            <div
              ref={timelineRef}
              className="nodrag nopan nowheel flex-1 min-h-0 overflow-y-auto p-5 space-y-4"
              data-grok-studio-copyable="true"
              style={{
                background: isDark ? 'linear-gradient(180deg, rgba(103,232,249,0.05), transparent)' : 'linear-gradient(180deg, rgba(16,185,129,0.05), transparent)',
                userSelect: 'text',
                WebkitUserSelect: 'text',
              } as CSSProperties}
              onMouseDownCapture={stopCopyableConversationEvent}
              onPointerDownCapture={stopCopyableConversationEvent}
              onDoubleClickCapture={stopCopyableConversationEvent}
              onContextMenuCapture={stopCopyableConversationEvent}
              onDragStartCapture={stopCopyableConversationEvent}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {agentMessages.length === 0 && !streamingReply && (
                <div className="h-full flex items-center justify-center text-center">
                  <div className="max-w-md space-y-3">
                    <div className="mx-auto w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: surfaceStrong, color: accent, border: `1px solid ${border}` }}>
                      <Sparkles size={24} />
                    </div>
                    <div className="text-lg font-bold">用一句话驱动 Grok 多模态创作</div>
                    <div className="text-sm leading-relaxed" style={{ color: subText }}>
                      例如：把上游图片改成红色泳衣并生成 8 秒视频；或把这段文本读成旁白音频。产物会先进入右侧产物库，点击发布后才落到画布。
                    </div>
                  </div>
                </div>
              )}
              {agentMessages.map((message) => (
                <MessageBubble key={message.id} message={message} artifacts={agentArtifacts} surface={surface} surfaceStrong={surfaceStrong} border={border} text={text} subText={subText} accent={accent} isPixel={isPixel} />
              ))}
              {streamingReply && (
                <MessageBubble
                  message={{ id: 'streaming', role: 'assistant', content: streamingReply, mode, status: 'running', createdAt: Date.now() }}
                  artifacts={agentArtifacts}
                  surface={surface}
                  surfaceStrong={surfaceStrong}
                  border={border}
                  text={text}
                  subText={subText}
                  accent={accent}
                  isPixel={isPixel}
                />
              )}
            </div>

            <div className="p-4 space-y-3" style={{ borderTop: `1px solid ${border}`, background: bg }}>
              {(error || progressMessage) && (
                <div className="rounded-lg px-3 py-2 text-[12px] flex items-start gap-2" style={{ background: error ? 'rgba(239,68,68,0.12)' : surface, color: error ? danger : text, border: `1px solid ${error ? 'rgba(239,68,68,0.35)' : border}` }}>
                  {error ? (
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  ) : noticeBusy ? (
                    <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" style={{ color: accent }} />
                  ) : (
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0" style={{ color: accent }} />
                  )}
                  <span>{error || progressMessage}</span>
                </div>
              )}
              <LocalUploadBar
                surface={surface}
                border={border}
                text={text}
                subText={subText}
                accent={accent}
                accentText={accentText}
                isPixel={isPixel}
                uploadingKind={uploadingKind}
                onPick={onPickLocalMaterial}
              />
              <SlashCommandBar
                surface={surface}
                border={border}
                text={text}
                subText={subText}
                accent={accent}
                accentText={accentText}
                isPixel={isPixel}
                activeCommand={activeSlashCommand}
                onInsert={onInsertSlashCommand}
              />
              <MentionPromptInput
                title="Grok 创作台 Prompt"
                value={localPrompt}
                mentions={promptMentions}
                materials={mentionMaterials}
                onChange={onPromptChange}
                placeholder="写一句话即可：生成图片 / 做成视频 / 生成旁白 / 转写音频，也可以 @ 引用上游素材"
                isDark={isDark}
                isPixel={isPixel}
                promptTemplateKind={mode === 'video' ? 'video' : mode === 'image' ? 'image' : false}
                onSubmit={(value, mentions) => onRun({ prompt: value, mentions })}
                className="w-full min-h-[104px] rounded-xl px-3 py-3 text-[13px] outline-none"
                style={{ background: surface, color: text, border: `1px solid ${border}` }}
              />
              <div className="flex items-center gap-2">
                {isBusy ? (
                  <button type="button" onClick={onStop} className="rounded-xl px-5 py-2 text-sm font-bold flex items-center gap-2" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
                    <Square size={15} /> 停止
                  </button>
                ) : (
                  <button type="button" onClick={() => onRun()} className="rounded-xl px-5 py-2 text-sm font-bold flex items-center gap-2" style={{ background: accent, color: accentText, border: `1px solid ${accent}` }}>
                    <Send size={15} /> 运行 Grok OAuth
                  </button>
                )}
                <button type="button" onClick={onNewConversation} className="rounded-xl px-4 py-2 text-sm font-bold" style={{ background: surfaceStrong, color: text, border: `1px solid ${border}` }}>
                  新对话
                </button>
                <button type="button" onClick={onClearSession} className="rounded-xl px-4 py-2 text-sm font-bold" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
                  清空全部
                </button>
                <div className="ml-auto text-[11px]" style={{ color: subText }}>
                  当前：{modeTitle(mode)} · {status?.loggedIn ? '已登录' : '未登录'}
                </div>
              </div>
            </div>
          </main>

          <aside className="min-h-0 overflow-y-auto p-4 space-y-3" style={{ borderLeft: `1px solid ${border}` }}>
            <Panel title="产物库" icon={<PanelRightOpen size={14} />} surface={surface} border={border} text={text} subText={subText} aside={`${agentArtifacts.length} 项`}>
              <div className="space-y-3">
                <div className="grid grid-cols-4 gap-1 nodrag">
                  {artifactTabs.map((tab) => {
                    const active = tab.id === artifactTab;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setArtifactTab(tab.id)}
                        className="min-w-0 rounded-lg px-2 py-2 text-[11px] font-bold transition-transform hover:-translate-y-0.5"
                        style={{
                          background: active ? accent : surfaceStrong,
                          color: active ? accentText : text,
                          border: `1px solid ${active ? accent : border}`,
                          boxShadow: active ? '0 6px 16px rgba(0,0,0,0.18)' : 'none',
                        }}
                        title={`${tab.title} ${tab.count} 项`}
                      >
                        <span className="mx-auto mb-1 flex items-center justify-center">{tab.icon}</span>
                        <span className="block truncate">{tab.label}</span>
                        <span className="mt-0.5 block text-[10px] opacity-80">{tab.count}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-3 gap-1 nodrag">
                  <button
                    type="button"
                    onClick={() => setArtifactBatchMode((value) => !value)}
                    className="rounded-lg px-2 py-1.5 text-[11px] font-bold"
                    style={{ background: artifactBatchMode ? accent : surfaceStrong, color: artifactBatchMode ? accentText : text, border: `1px solid ${artifactBatchMode ? accent : border}` }}
                  >
                    {artifactBatchMode ? '退出批量' : '批量'}
                  </button>
                  <button
                    type="button"
                    disabled={!artifactBatchMode || selectedArtifactIds.length === 0}
                    onClick={deleteSelectedArtifacts}
                    className="rounded-lg px-2 py-1.5 text-[11px] font-bold disabled:opacity-45"
                    style={{ background: 'transparent', color: danger, border: `1px solid ${danger}` }}
                  >
                    删选中 {selectedArtifactIds.length}
                  </button>
                  <button
                    type="button"
                    disabled={agentArtifacts.length === 0}
                    onClick={clearAllArtifacts}
                    className="rounded-lg px-2 py-1.5 text-[11px] font-bold disabled:opacity-45"
                    style={{ background: 'transparent', color: danger, border: `1px solid ${danger}` }}
                  >
                    清空全部
                  </button>
                </div>
                {artifactBatchMode && (
                  <div className="flex items-center justify-between rounded-lg px-2 py-1.5 text-[11px]" style={{ background: surface, color: subText, border: `1px solid ${border}` }}>
                    <span>{activeArtifactTab.title}已选 {selectedActiveArtifacts.length} / {activeArtifacts.length}</span>
                    <button type="button" className="rounded-md px-2 py-1 text-[11px] font-bold" style={{ background: surfaceStrong, color: text, border: `1px solid ${border}` }} onClick={toggleSelectActiveArtifacts}>
                      {allActiveArtifactsSelected ? '取消全选' : '全选当前'}
                    </button>
                  </div>
                )}
                <ArtifactGroup
                  title={activeArtifactTab.title}
                  items={activeArtifacts}
                  sourceNodeId={nodeId}
                  batchMode={artifactBatchMode}
                  selectedArtifactIds={selectedArtifactIds}
                  onToggleSelect={toggleArtifactSelection}
                  onPublish={onPublish}
                  onDelete={(artifact) => onDeleteArtifacts([artifact])}
                  onReference={onArtifactReference}
                  onContinue={onArtifactContinue}
                  onMakeVideo={onArtifactMakeVideo}
                  surface={surfaceStrong}
                  border={border}
                  text={text}
                  subText={subText}
                  accent={accent}
                  accentText={accentText}
                  isPixel={isPixel}
                />
              </div>
            </Panel>
          </aside>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, icon, children, surface, border, text, subText, aside }: { title: string; icon: ReactNode; children: ReactNode; surface: string; border: string; text: string; subText: string; aside?: string }) {
  return (
    <section className="rounded-xl p-3 space-y-3" style={{ background: surface, border: `1px solid ${border}` }}>
      <div className="flex items-center gap-2 text-[12px] font-bold" style={{ color: text }}>
        {icon}
        <span className="flex-1">{title}</span>
        {aside && <span className="text-[10px]" style={{ color: subText }}>{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function StatPill({ label, value, surface, text, border }: { label: string; value: number; surface: string; text: string; border: string }) {
  return (
    <div className="rounded-lg px-2 py-1 flex items-center justify-between" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function LocalUploadBar({
  surface,
  border,
  text,
  subText,
  accent,
  accentText,
  isPixel,
  uploadingKind,
  onPick,
}: {
  surface: string;
  border: string;
  text: string;
  subText: string;
  accent: string;
  accentText: string;
  isPixel: boolean;
  uploadingKind: GrokUploadKind | '';
  onPick: (kind?: GrokUploadKind) => void;
}) {
  const options: Array<{ kind: GrokUploadKind; label: string; icon: ReactNode; title: string }> = [
    { kind: 'auto', label: '上传素材', icon: <Plus size={13} />, title: '上传图片 / 视频 / 音频' },
    { kind: 'image', label: '图像', icon: <ImageIcon size={13} />, title: '上传图像素材' },
    { kind: 'video', label: '视频', icon: <Video size={13} />, title: '上传视频素材' },
    { kind: 'audio', label: '音频', icon: <Music2 size={13} />, title: '上传音频素材' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: subText }}>
      <span className="font-bold flex items-center gap-1" style={{ color: text }}>
        <Upload size={13} /> 本地素材
      </span>
      {options.map((item) => {
        const loading = uploadingKind === item.kind || (item.kind === 'auto' && !!uploadingKind);
        return (
          <button
            key={item.kind}
            type="button"
            title={item.title}
            disabled={!!uploadingKind}
            onClick={() => onPick(item.kind)}
            className="nodrag rounded-lg px-2 py-1 font-bold inline-flex items-center gap-1 disabled:opacity-60"
            style={{
              background: item.kind === 'auto' ? accent : surface,
              color: item.kind === 'auto' ? accentText : text,
              border: `1px solid ${item.kind === 'auto' ? accent : border}`,
            }}
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : item.icon}
            {loading ? '上传中' : item.label}
          </button>
        );
      })}
      <span className="text-[10px]">支持图片、视频、音频，上传后会进入左侧素材池并参与 @ 引用。</span>
    </div>
  );
}

function SlashCommandBar({
  surface,
  border,
  text,
  subText,
  accent,
  accentText,
  isPixel,
  activeCommand,
  onInsert,
}: {
  surface: string;
  border: string;
  text: string;
  subText: string;
  accent: string;
  accentText: string;
  isPixel: boolean;
  activeCommand: string;
  onInsert: (insert: string, mode: GrokOAuthMode) => void;
}) {
  return (
    <div className="rounded-xl px-2 py-2 space-y-2" style={{ background: surface, color: text, border: `1px solid ${border}` }}>
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="font-bold flex items-center gap-1"><Sparkles size={12} /> Slash 快捷能力</span>
        <span style={{ color: subText }}>输入 / 或点击插入</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SLASH_COMMANDS.map((item) => {
          const active = item.command === activeCommand;
          return (
            <button
              key={item.command}
              type="button"
              className="nodrag rounded-lg px-2 py-1 text-[10px] font-bold"
              title={item.hint}
              onClick={() => onInsert(item.insert, item.mode)}
              style={{
                background: active ? accent : 'transparent',
                color: active ? accentText : text,
                border: `1px solid ${active ? accent : border}`,
              }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MessageBubble({ message, artifacts, surface, surfaceStrong, border, text, subText, accent, isPixel }: { message: GrokAgentMessage; artifacts: GrokAgentArtifact[]; surface: string; surfaceStrong: string; border: string; text: string; subText: string; accent: string; isPixel: boolean }) {
  const isUser = message.role === 'user';
  const linked = (message.artifactIds || []).map((id) => artifacts.find((item) => item.id === id)).filter(Boolean) as GrokAgentArtifact[];
  const bubbleText = isUser && isPixel ? '#1a1408' : text;
  const bubbleSubText = isUser && isPixel ? 'rgba(26,20,8,0.72)' : subText;
  const copyMessage = () => {
    const content = String(message.content || '').trim();
    if (!content) return;
    void navigator.clipboard?.writeText?.(content);
  };
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[78%] rounded-2xl p-3 space-y-2" style={{ background: isUser ? surfaceStrong : surface, color: bubbleText, border: `1px solid ${isUser ? accent : border}` }}>
        <div className="flex items-center gap-2 text-[10px]" style={{ color: bubbleSubText }}>
          <span className="font-bold" style={{ color: isUser ? bubbleText : accent }}>{isUser ? '你' : message.role === 'tool' ? 'Grok 工具' : 'Grok'}</span>
          {message.mode && <span>{modeTitle(message.mode)}</span>}
          {message.status === 'running' && <Loader2 size={10} className="animate-spin" />}
          <button
            type="button"
            className="nodrag rounded-md border px-1 py-0.5 opacity-70 transition hover:opacity-100"
            style={{ borderColor: border, background: surfaceStrong, color: bubbleText }}
            onClick={copyMessage}
            title="复制这条消息"
          >
            <Copy size={10} />
          </button>
        </div>
        <div
          className="nodrag nopan select-text whitespace-pre-wrap text-[13px] leading-relaxed"
          data-grok-message-copyable="true"
          style={{ userSelect: 'text', WebkitUserSelect: 'text' } as CSSProperties}
          onMouseDownCapture={stopCopyableConversationEvent}
          onPointerDownCapture={stopCopyableConversationEvent}
          onDoubleClickCapture={stopCopyableConversationEvent}
          onContextMenuCapture={stopCopyableConversationEvent}
          onDragStartCapture={stopCopyableConversationEvent}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {message.content}
        </div>
        {message.role === 'tool' && typeof message.progress === 'number' && (
          <div className="h-1.5 overflow-hidden rounded-full" style={{ background: isPixel ? 'rgba(26,20,8,0.18)' : 'rgba(255,255,255,0.12)' }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${Math.max(2, Math.min(100, message.progress))}%`, background: accent }} />
          </div>
        )}
        {linked.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {linked.map((item) => (
              <span key={item.id} className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: surfaceStrong, color: isPixel ? '#1a1408' : text, border: `1px solid ${border}` }}>{item.refId || artifactKindLabel(item.kind)}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactGroup({
  title,
  items,
  sourceNodeId,
  batchMode,
  selectedArtifactIds,
  onToggleSelect,
  onPublish,
  onDelete,
  onReference,
  onContinue,
  onMakeVideo,
  surface,
  border,
  text,
  subText,
  accent,
  accentText,
  isPixel,
}: {
  title: string;
  items: GrokAgentArtifact[];
  sourceNodeId: string;
  batchMode: boolean;
  selectedArtifactIds: string[];
  onToggleSelect: (artifactId: string) => void;
  onPublish: (artifact: GrokAgentArtifact) => void;
  onDelete: (artifact: GrokAgentArtifact) => void;
  onReference: (artifact: GrokAgentArtifact) => void;
  onContinue: (artifact: GrokAgentArtifact) => void;
  onMakeVideo: (artifact: GrokAgentArtifact) => void;
  surface: string;
  border: string;
  text: string;
  subText: string;
  accent: string;
  accentText: string;
  isPixel: boolean;
}) {
  if (items.length === 0) {
    return (
      <div className="space-y-2">
        <div className="text-[11px] font-bold" style={{ color: text }}>{title}</div>
        <div className="rounded-lg px-3 py-4 text-center text-[11px]" style={{ color: subText, border: `1px dashed ${border}` }}>暂无产物</div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-bold" style={{ color: text }}>{title}</div>
      {items.slice().reverse().map((artifact) => (
        <ArtifactCard
          key={artifact.id}
          artifact={artifact}
          sourceNodeId={sourceNodeId}
          batchMode={batchMode}
          selected={selectedArtifactIds.includes(artifact.id)}
          onToggleSelect={onToggleSelect}
          onPublish={onPublish}
          onDelete={onDelete}
          onReference={onReference}
          onContinue={onContinue}
          onMakeVideo={onMakeVideo}
          surface={surface}
          border={border}
          text={text}
          subText={subText}
          accent={accent}
          accentText={accentText}
          isPixel={isPixel}
        />
      ))}
    </div>
  );
}

function ArtifactImagePreview({
  src,
  title,
  border,
  text,
  surface,
  accent,
  accentText,
}: {
  src: string;
  title: string;
  border: string;
  text: string;
  surface: string;
  accent: string;
  accentText: string;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const overlay = previewOpen && typeof document !== 'undefined'
    ? createPortal(
      <div className="fixed inset-0 z-[10080] pointer-events-none flex items-center justify-center p-10" style={{ background: 'rgba(0,0,0,0.58)' }}>
        <div className="relative rounded-2xl p-3" style={{ background: surface, border: `1px solid ${border}`, boxShadow: '0 28px 80px rgba(0,0,0,0.42)' }}>
          <div className="absolute right-3 top-3 rounded-full px-2 py-1 text-[11px] font-bold" style={{ background: accent, color: accentText }}>100%</div>
          <img
            src={src}
            alt={title || 'Grok 产物 100% 预览'}
            className="block rounded-xl"
            style={{ maxWidth: 'calc(100vw - 96px)', maxHeight: 'calc(100vh - 96px)' }}
          />
        </div>
      </div>,
      document.body,
    )
    : null;

  return (
    <div className="relative group" onMouseLeave={() => setPreviewOpen(false)}>
      <SmartImage src={src} alt={title} className="w-full rounded-lg object-contain max-h-56" thumbSize={520} />
      <button
        type="button"
        title="100% 查看"
        aria-label="Grok 产物 100% 预览"
        className="absolute right-2 top-2 rounded-lg p-1 opacity-0 transition-opacity group-hover:opacity-100"
        onMouseEnter={() => setPreviewOpen(true)}
        onFocus={() => setPreviewOpen(true)}
        onBlur={() => setPreviewOpen(false)}
        style={{ background: surface, color: text, border: `1px solid ${border}`, boxShadow: '0 8px 20px rgba(0,0,0,0.22)' }}
      >
        <Maximize2 size={13} />
      </button>
      {overlay}
    </div>
  );
}

function ArtifactCard({
  artifact,
  sourceNodeId,
  batchMode,
  selected,
  onToggleSelect,
  onPublish,
  onDelete,
  onReference,
  onContinue,
  onMakeVideo,
  surface,
  border,
  text,
  subText,
  accent,
  accentText,
  isPixel,
}: {
  artifact: GrokAgentArtifact;
  sourceNodeId: string;
  batchMode: boolean;
  selected: boolean;
  onToggleSelect: (artifactId: string) => void;
  onPublish: (artifact: GrokAgentArtifact) => void;
  onDelete: (artifact: GrokAgentArtifact) => void;
  onReference: (artifact: GrokAgentArtifact) => void;
  onContinue: (artifact: GrokAgentArtifact) => void;
  onMakeVideo: (artifact: GrokAgentArtifact) => void;
  surface: string;
  border: string;
  text: string;
  subText: string;
  accent: string;
  accentText: string;
  isPixel: boolean;
}) {
  const urls = dedupeStringArray(artifact.urls || artifact.url);
  const url = urls[0] || '';
  const cardText = isPixel ? '#1a1408' : text;
  const cardSubText = isPixel ? 'rgba(26,20,8,0.72)' : subText;
  const [resourceState, setResourceState] = useState('');
  const [savingResource, setSavingResource] = useState(false);
  const canSendOrSave = !!artifactToSendableMaterial(artifact, sourceNodeId);
  const handleSaveResource = useCallback(async () => {
    if (savingResource) return;
    setSavingResource(true);
    setResourceState('');
    try {
      const message = await saveArtifactToResourceLibrary(artifact, sourceNodeId);
      setResourceState(message);
      logBus.success(message, `grok:${sourceNodeId}`);
      window.setTimeout(() => setResourceState(''), 1600);
    } catch (e: any) {
      const message = e?.message || String(e);
      setResourceState('入库失败');
      logBus.error(message, `grok:${sourceNodeId}`);
      window.setTimeout(() => setResourceState(''), 2200);
    } finally {
      setSavingResource(false);
    }
  }, [artifact, savingResource, sourceNodeId]);
  return (
    <div className="rounded-xl p-2 space-y-2" style={{ background: surface, border: `1px solid ${artifact.publishedAt ? accent : border}`, color: cardText }}>
      <div className="flex items-center gap-2">
        {batchMode && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(artifact.id)}
            aria-label="选择 Grok 产物"
          />
        )}
        <div className="font-bold text-[12px] flex-1 min-w-0 truncate">{artifact.refId ? `${artifact.refId} · ` : ''}{artifact.title || artifactKindLabel(artifact.kind)}</div>
        {artifact.publishedAt && <span className="text-[10px]" style={{ color: accent }}>已发布</span>}
      </div>
      {(artifact.parentId || (artifact.sourceArtifactIds || []).length > 0) && (
        <div className="text-[10px]" style={{ color: cardSubText }}>
          v{artifact.revision || 2} · 来源 {(artifact.sourceArtifactIds || []).length || 1} 个产物
        </div>
      )}
      {artifact.text && <div className="text-[11px] whitespace-pre-wrap max-h-32 overflow-y-auto" style={{ color: cardSubText }}>{artifact.text}</div>}
      {artifact.kind === 'image' && url && <ArtifactImagePreview src={url} title={artifact.title} surface={surface} border={border} text={cardText} accent={accent} accentText={accentText} />}
      {artifact.kind === 'video' && url && <video src={url} controls className="w-full rounded-lg max-h-56" />}
      {artifact.kind === 'audio' && url && <audio src={url} controls className="w-full h-9" />}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => onReference(artifact)} className="rounded px-2 py-1 text-[10px] font-bold" style={{ background: 'transparent', color: cardText, border: `1px solid ${border}` }}>
          引用
        </button>
        {artifact.kind !== 'text' && artifact.kind !== 'transcript' && (
          <button type="button" onClick={() => onContinue(artifact)} className="rounded px-2 py-1 text-[10px] font-bold" style={{ background: 'transparent', color: cardText, border: `1px solid ${border}` }}>
            继续改
          </button>
        )}
        {(artifact.kind === 'image' || artifact.kind === 'video') && (
          <button type="button" onClick={() => onMakeVideo(artifact)} className="rounded px-2 py-1 text-[10px] font-bold" style={{ background: 'transparent', color: cardText, border: `1px solid ${border}` }}>
            做视频
          </button>
        )}
        <button type="button" disabled={!!artifact.publishedAt} onClick={() => onPublish(artifact)} className="rounded px-2 py-1 text-[10px] font-bold disabled:opacity-60" style={{ background: accent, color: accentText, border: `1px solid ${accent}` }}>
          {artifact.publishedAt ? '已发布' : '发布'}
        </button>
        <button type="button" disabled={!canSendOrSave} onClick={() => openArtifactSendModal(artifact, sourceNodeId)} title="发送到其他画布" className="rounded px-2 py-1 text-[10px] font-bold disabled:opacity-60" style={{ background: 'transparent', color: cardText, border: `1px solid ${border}` }}>
          发送画布
        </button>
        <button type="button" disabled={!canSendOrSave || savingResource} onClick={() => void handleSaveResource()} title="保存到资源库" className="rounded px-2 py-1 text-[10px] font-bold disabled:opacity-60" style={{ background: 'transparent', color: cardText, border: `1px solid ${border}` }}>
          {savingResource ? <Loader2 size={11} className="inline mr-1 animate-spin" /> : <Library size={11} className="inline mr-1" />}
          {resourceState || '入库'}
        </button>
        {artifact.prompt && (
          <button type="button" onClick={() => copyText(artifact.prompt || '')} className="rounded px-2 py-1 text-[10px] font-bold" style={{ background: 'transparent', color: cardText, border: `1px solid ${border}` }}>
            <Copy size={11} className="inline mr-1" /> Prompt
          </button>
        )}
        {url && (
          <a href={url} download={downloadName(url, 'grok-oauth-output')} className="rounded px-2 py-1 text-[10px] font-bold no-underline" style={{ background: 'transparent', color: cardText, border: `1px solid ${border}` }}>
            <Download size={11} className="inline mr-1" /> 下载
          </a>
        )}
        <button type="button" onClick={() => onDelete(artifact)} className="rounded px-2 py-1 text-[10px] font-bold" style={{ background: 'transparent', color: '#ef4444', border: '1px solid #ef4444' }}>
          删除
        </button>
      </div>
    </div>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  options: string[];
  labels?: Record<string, string>;
  onChange: (value: string) => void;
  surface: string;
  text: string;
  border: string;
  subText: string;
}

function SelectField({ label, value, options, labels, onChange, surface, text, border, subText }: SelectFieldProps) {
  return (
    <label className="space-y-1 min-w-0 block">
      <span className="text-[10px]" style={{ color: subText }}>{label}</span>
      <select className="nodrag nowheel w-full rounded px-2 py-1 text-[11px] outline-none truncate" style={{ background: surface, color: text, border: `1px solid ${border}` }} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((item) => <option key={item} value={item}>{labels?.[item] || item}</option>)}
      </select>
    </label>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  surface: string;
  text: string;
  border: string;
  subText: string;
}

function TextField({ label, value, onChange, surface, text, border, subText }: TextFieldProps) {
  return (
    <label className="space-y-1 min-w-0 block">
      <span className="text-[10px]" style={{ color: subText }}>{label}</span>
      <input className="nodrag nowheel w-full rounded px-2 py-1 text-[11px] outline-none" style={{ background: surface, color: text, border: `1px solid ${border}` }} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

interface NumberFieldProps extends Omit<TextFieldProps, 'value' | 'onChange'> {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

function NumberField({ label, value, min, max, step = 1, onChange, surface, text, border, subText }: NumberFieldProps) {
  return (
    <label className="space-y-1 min-w-0 block">
      <span className="text-[10px]" style={{ color: subText }}>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        className="nodrag nowheel w-full rounded px-2 py-1 text-[11px] outline-none"
        style={{ background: surface, color: text, border: `1px solid ${border}` }}
        value={Number.isFinite(value) ? value : min}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
        }}
      />
    </label>
  );
}

export default memo(GrokOAuthAgentNode);
