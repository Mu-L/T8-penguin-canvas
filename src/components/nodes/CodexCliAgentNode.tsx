import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  FileText,
  GitBranch,
  Image as ImageIcon,
  Library,
  Loader2,
  Music2,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  TerminalSquare,
  Video,
  Wand2,
  X,
} from 'lucide-react';
import { PORT_COLOR } from '../../config/portTypes';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import * as api from '../../services/api';
import {
  createCodexProjectSkill,
  deleteCodexProjectSkill,
  getCodexCliSkills,
  getCodexCliStatus,
  startCodexCliLogin,
  streamCodexCliAgent,
  type CodexAgentArtifact,
  type CodexCliStatus,
  type CodexSkill,
  type CodexStreamEvent,
  updateCodexProjectSkill,
} from '../../services/codexCli';
import { logBus } from '../../stores/logs';
import { taskCompletionSound } from '../../stores/taskCompletionSound';
import { useThemeStore } from '../../stores/theme';
import {
  countExcludedMaterials,
  excludeMaterialId,
  filterExcludedMaterials,
  normalizeExcludedMaterialIds,
} from '../../utils/materialExclusion';
import { createReadableStudioPalette, readableTextOn } from '../../utils/readableStudioPalette';
import MaterialPreviewSection from './MaterialPreviewSection';
import MentionPromptInput from './MentionPromptInput';
import SmartImage from '../SmartImage';
import { materialMentionKey, resolveMediaMentions, type MediaMention } from './mediaMentions';
import { useOrderedMaterials } from './useOrderedMaterials';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useUpstreamMaterials, type Material } from './useUpstreamMaterials';

type CodexAgentMode = 'chat' | 'prompt' | 'image' | 'storyboard' | 'character' | 'product' | 'quality';
type CodexArtifactKind = 'text' | 'image' | 'video' | 'audio' | 'model3d' | 'file';
type CodexSkillPickerMode = 'select' | 'slash';
type CodexStudioTool = 'template-workshop' | 'project-skill' | null;
type CodexRunIntent = 'auto' | 'llm' | 'img';

interface CodexAgentMessage {
  id: string;
  turnId?: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  mode?: CodexAgentMode;
  status?: 'running' | 'success' | 'error';
  createdAt: number;
}

interface CodexVersionEntry {
  id: string;
  artifactId: string;
  title: string;
  kind: CodexArtifactKind;
  parentId?: string;
  createdAt: number;
}

interface CodexStudioSession {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  artifactCount: number;
  messages?: CodexAgentMessage[];
  artifacts?: CodexAgentArtifact[];
  versions?: CodexVersionEntry[];
  contextSummary?: string;
  contextCompressedCount?: number;
  contextLimit?: number;
}

interface CodexStudioMemoryContext {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  summary: string;
  compressedCount: number;
  compressedNow: number;
  contextLimit: number;
}

interface CreatorPreset {
  id: string;
  mode: CodexAgentMode;
  label: string;
  command: string;
  icon: any;
  hint: string;
  systemHint: string;
  category?: string;
  custom?: boolean;
}

const DEFAULT_CREATOR_PRESET: CreatorPreset = {
  id: 'default',
  mode: 'chat',
  label: '默认创作',
  command: '/chat',
  icon: Wand2,
  hint: '按当前任务自由创作',
  systemHint: '保持流式协作，先理解创作目标，再给可执行的最终产物或下一步方案。',
};

const IMAGE_GENERATION_FALLBACK_PRESET: CreatorPreset = {
  id: 'image-generation-runtime',
  mode: 'image',
  label: '图像生成任务',
  command: '/image',
  icon: ImageIcon,
  hint: '按图像生成任务处理',
  systemHint: '优先直接调用 Codex 的 image_generation 能力生成图片；如果当前 CLI 无法生图，再输出可执行的图像提示词和参数。',
};

const SYSTEM_CREATOR_PRESETS: CreatorPreset[] = [];

const CODEX_MODEL_OPTIONS = [
  { value: 'default', label: '默认模型', hint: '跟随本机 Codex CLI / profile 配置' },
  { value: 'gpt-5.5', label: 'GPT-5.5（推荐）', hint: '官方推荐：复杂编码、电脑使用、知识工作和研究流程优先。' },
  { value: 'gpt-5.4', label: 'GPT-5.4', hint: '适合高质量创作规划、复杂推理和较长任务。' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini（快速）', hint: '官方建议用于更快、成本更低的轻量任务或子 Agent。' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark（预览）', hint: '研究预览模型，适合近实时迭代；通常需要 Pro 权限。' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex（旧版）', hint: 'Codex 旧模型；官方已提示 ChatGPT 登录下不推荐继续使用。' },
  { value: 'gpt-5.2', label: 'GPT-5.2（旧版）', hint: 'Codex 旧模型；保留给已有 API/脚本兼容。' },
  { value: 'custom', label: '自定义模型', hint: '手动填写任意 Codex CLI 支持的模型 ID' },
];

const CODEX_RUN_INTENT_OPTIONS: Array<{ id: Exclude<CodexRunIntent, 'auto'>; label: string; title: string }> = [
  { id: 'llm', label: 'LLM', title: '只做文字回答、读图分析和提示词整理，绝不生成图片。' },
  { id: 'img', label: 'IMG', title: '允许调用 image_generation，面向直接生图。' },
];

const CODEX_IMAGEGEN_PARAM_LISTS = [
  {
    label: '比例',
    options: [
      { label: '1:1 方图', value: '1:1' },
      { label: '4:5 小红书', value: '4:5' },
      { label: '5:4 横图', value: '5:4' },
      { label: '3:4 竖图', value: '3:4' },
      { label: '4:3 横图', value: '4:3' },
      { label: '2:3 海报', value: '2:3' },
      { label: '3:2 摄影', value: '3:2' },
      { label: '9:16 竖屏', value: '9:16' },
      { label: '16:9 横屏', value: '16:9' },
      { label: '9:21 长竖屏', value: '9:21' },
      { label: '21:9 超宽屏', value: '21:9' },
      { label: '1:2 长图', value: '1:2' },
      { label: '2:1 宽图', value: '2:1' },
    ],
  },
  {
    label: '尺寸',
    options: [
      { label: '1K', value: '1K' },
      { label: '2K', value: '2K' },
      { label: '4K', value: '4K' },
      { label: '1024x1024', value: '1024x1024' },
      { label: '1024x1536', value: '1024x1536' },
      { label: '1536x1024', value: '1536x1024' },
      { label: '1152x2048', value: '1152x2048' },
      { label: '2048x1152', value: '2048x1152' },
      { label: '2048x2048', value: '2048x2048' },
      { label: '4096x4096', value: '4096x4096' },
    ],
  },
  {
    label: '质量',
    options: [
      { label: '高质量', value: 'high quality' },
      { label: '高细节', value: 'high detail' },
      { label: '商业级', value: 'commercial grade' },
      { label: '精修质感', value: 'polished finish' },
      { label: '自然皮肤', value: 'natural skin texture' },
      { label: '真实光影', value: 'realistic lighting' },
      { label: '干净构图', value: 'clean composition' },
      { label: '低噪点', value: 'low noise' },
    ],
  },
  {
    label: '风格',
    options: [
      { label: '电影感', value: 'cinematic' },
      { label: '写实摄影', value: 'photorealistic' },
      { label: '海报设计', value: 'poster design' },
      { label: '电商主图', value: 'ecommerce hero image' },
      { label: '杂志大片', value: 'editorial magazine' },
      { label: '柔光棚拍', value: 'soft studio lighting' },
      { label: '产品摄影', value: 'product photography' },
      { label: '极简高级', value: 'minimal premium design' },
    ],
  },
];

const CODEX_IMAGEGEN_QUICK_PARAMS = [
  { label: '1:1', value: '1:1' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '4:3', value: '4:3' },
  { label: '3:4', value: '3:4' },
  { label: '21:9', value: '21:9' },
  { label: '9:21', value: '9:21' },
  { label: '1K', value: '1K' },
  { label: '2K', value: '2K' },
  { label: '4K', value: '4K' },
  { label: '高质量', value: 'high quality' },
  { label: '写实', value: 'photorealistic' },
  { label: '海报', value: 'poster' },
  { label: '电商', value: 'ecommerce' },
  { label: '保留参考', value: 'preserve reference' },
  { label: '无水印', value: 'no watermark' },
  { label: '文+图', value: '文字和图片同时生成' },
];

const CREATOR_SKILL_ALLOWLIST = [
  'imagegen',
  'ads-explorer',
  'generative-polish',
  'logo-explorer',
  'moodboard-explorer',
  'offer-explorer',
  'positioning-explorer',
  'scene-explorer',
  'shot-explorer',
  'get-context',
  'ideate',
  'image-to-code',
  'figma-generate-design',
  'figma-generate-library',
  'Presentations',
  'documents',
  'spreadsheets',
];

const CREATOR_SKILL_PURPOSES: Record<string, string> = {
  imagegen: '生成或编辑图片，适合角色图、海报、商品图、视觉参考。',
  'ads-explorer': '探索广告创意方向，批量生成不同卖点和画面方案。',
  'generative-polish': '把已有视觉做发布前润色，提升质感和商业可用性。',
  'logo-explorer': '探索 logo、字标、品牌识别和视觉系统方向。',
  'moodboard-explorer': '生成情绪板和视觉风格路线，适合前期定调。',
  'offer-explorer': '围绕产品/服务卖点生成转化型创意和素材方向。',
  'positioning-explorer': '梳理目标人群、定位、场景和传播角度。',
  'scene-explorer': '把产品、人物或服务放进具体场景里做画面方案。',
  'shot-explorer': '围绕参考图探索镜头、裁切、角度和局部特写。',
  'get-context': '先收集设计目标、用户、场景和约束，避免直接跑偏。',
  ideate: '基于截图或需求发散产品/视觉方案，适合做方向探索。',
  'image-to-code': '把截图或设计稿转成可交互前端原型。',
  'figma-generate-design': '把页面或应用布局转成 Figma 设计结构。',
  'figma-generate-library': '创建或整理设计系统组件和变量。',
  Presentations: '制作演示文稿，适合提案、汇报和项目说明。',
  documents: '制作或修改文档，适合方案、脚本、说明书和交付稿。',
  spreadsheets: '整理表格和批量素材清单，适合排期、清单和数据化规划。',
};

const MAX_MESSAGES = 120;
const MAX_ARTIFACTS = 80;
const MAX_VERSIONS = 80;
const MAX_DELETED_ARTIFACT_KEYS = 600;
const CODEX_MESSAGE_STORAGE_CHAR_LIMIT = 8000;
const CODEX_TOOL_MESSAGE_STORAGE_CHAR_LIMIT = 1200;
const CODEX_ARTIFACT_TEXT_STORAGE_CHAR_LIMIT = 12000;
const CODEX_STUDIO_SESSION_STORAGE_LIMIT = 8;
const CODEX_STUDIO_SESSION_MESSAGE_LIMIT = 24;
const CODEX_STUDIO_SESSION_ARTIFACT_LIMIT = 24;
const CODEX_STUDIO_CONTEXT_DEFAULT_LIMIT = 30;
const CODEX_STUDIO_CONTEXT_MAX_LIMIT = 80;
const CODEX_STUDIO_CONTEXT_SUMMARY_MAX_CHARS = 3600;
const DEFAULT_CREATOR_CATEGORY = '未分类';
const NO_CREATOR_PRESET_ID = '__none__';
const LLM_DEFAULT_CODEX_MODEL = 'gpt-5.4-mini';
const IMG_DEFAULT_CODEX_MODEL = 'gpt-5.5';

const handleStyle: CSSProperties = {
  width: 15,
  height: 15,
  border: '2px solid rgba(255,255,255,0.92)',
  boxShadow: '0 0 0 2px rgba(8,18,34,0.86), 0 0 12px rgba(56,189,248,0.35)',
  zIndex: 120,
};

const CODEX_AGENT_HANDLE_GAP = 34;

function codexAgentHandleTop(index: number, count: number): CSSProperties['top'] {
  const offset = Math.round((index - (count - 1) / 2) * CODEX_AGENT_HANDLE_GAP);
  if (offset === 0) return '50%';
  return `calc(50% ${offset > 0 ? '+' : '-'} ${Math.abs(offset)}px)`;
}

function makeId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function asStringArray(value: any): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  const text = String(value || '').trim();
  return text ? [text] : [];
}

function parseExtraArgs(value: any): string[] {
  if (Array.isArray(value)) return asStringArray(value);
  const text = String(value || '').trim();
  if (!text) return [];
  return text.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, '')) || [];
}

function appendCommaSeparatedPromptToken(prompt: string, token: string) {
  const cleanPrompt = String(prompt || '').trimEnd();
  const cleanToken = String(token || '').trim().replace(/[，,]+$/g, '');
  if (!cleanToken) return cleanPrompt;
  if (!cleanPrompt) return `${cleanToken},`;
  if (/[，,]\s*$/.test(cleanPrompt)) return `${cleanPrompt} ${cleanToken},`;
  return `${cleanPrompt}, ${cleanToken},`;
}

function sanitizeCreatorCategory(value: any) {
  const text = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 32);
  return text || DEFAULT_CREATOR_CATEGORY;
}

function sanitizeCreatorPresets(value: any): CreatorPreset[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): CreatorPreset | null => {
      const label = String(item?.label || item?.name || '').trim();
      const command = String(item?.command || '/custom').trim();
      const hint = String(item?.hint || item?.description || '').trim();
      const systemHint = String(item?.systemHint || item?.prompt || '').trim();
      const mode = ['chat', 'prompt', 'image', 'storyboard', 'character', 'product', 'quality'].includes(item?.mode)
        ? item.mode as CodexAgentMode
        : 'prompt';
      if (!label || !systemHint) return null;
      return {
        id: String(item?.id || `user-${label}`).replace(/\s+/g, '-').slice(0, 64),
        mode,
        label,
        command,
        icon: Wand2,
        hint: hint || '用户自定义创作模板',
        systemHint,
        category: sanitizeCreatorCategory(item?.category),
        custom: true,
      };
    })
    .filter((item): item is CreatorPreset => !!item)
    .slice(0, 24);
}

function creatorPresetPlain(preset: CreatorPreset) {
  const { icon: _icon, ...plain } = preset;
  return plain;
}

function importedCreatorPresets(payload: any): CreatorPreset[] {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.templates)
      ? payload.templates
      : Array.isArray(payload?.presets)
        ? payload.presets
        : Array.isArray(payload?.items)
          ? payload.items
          : [];
  return sanitizeCreatorPresets(source);
}

interface ImportedProjectSkill {
  name: string;
  category: string;
  description: string;
  body: string;
}

function importedProjectSkills(payload: any): ImportedProjectSkill[] {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.skills)
      ? payload.skills
      : Array.isArray(payload?.items)
        ? payload.items
        : [];
  return source
    .map((item: any): ImportedProjectSkill | null => {
      const name = String(item?.name || item?.id || '').replace(/^\$/, '').trim();
      const body = String(item?.body || item?.content || item?.markdown || '').trim();
      if (!name || !body) return null;
      return {
        name,
        category: sanitizeCreatorCategory(item?.category),
        description: String(item?.description || item?.title || '导入的项目 Skill').trim(),
        body,
      };
    })
    .filter((item: ImportedProjectSkill | null): item is ImportedProjectSkill => !!item)
    .slice(0, 80);
}

function downloadJsonFile(filename: string, payload: any) {
  if (typeof document === 'undefined') return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function readJsonFile(file: File) {
  return JSON.parse(await file.text());
}

function normalizeSkillKey(name: string) {
  return String(name || '').replace(/^\$/, '').trim().toLowerCase();
}

function skillPurposeLabel(skill: CodexSkill): string {
  const key = normalizeSkillKey(skill.name);
  const mapped = CREATOR_SKILL_PURPOSES[key] || CREATOR_SKILL_PURPOSES[skill.name];
  if (mapped) return mapped;
  const desc = String(skill.description || '').trim();
  if (/image|bitmap|photo|visual|picture|generate|edit/i.test(desc)) return '图像生成、编辑或视觉方案相关 Skill。';
  if (/design|layout|figma|prototype|component|ui/i.test(desc)) return '设计、排版、界面或原型相关 Skill。';
  if (/presentation|slide|deck|ppt/i.test(desc)) return '演示文稿和提案排版相关 Skill。';
  if (/document|copy|writing|script|story|brief|prompt/i.test(desc)) return '文案、脚本、提示词或创作说明相关 Skill。';
  if (desc) return desc.length > 88 ? `${desc.slice(0, 88)}...` : desc;
  return skill.scope === 'project' ? '当前项目自定义创作 Skill。' : '可由 Codex 调用的扩展能力。';
}

function skillSearchText(skill: CodexSkill) {
  return `${skill.name} ${skill.description || ''} ${skillPurposeLabel(skill)}`.toLowerCase();
}

function scoreSkillMatch(skill: CodexSkill, rawQuery: string) {
  const query = normalizeSkillKey(rawQuery).replace(/^\//, '');
  if (!query) return 0;
  const name = normalizeSkillKey(skill.name);
  const shortName = normalizeSkillKey(name.split(':').pop() || name);
  const description = String(skill.description || '').toLowerCase();
  const purpose = skillPurposeLabel(skill).toLowerCase();
  if (name === query || shortName === query) return 1;
  if (name.startsWith(query) || shortName.startsWith(query)) return 2;
  if (name.includes(query) || shortName.includes(query)) return 3;
  if (description.includes(query)) return 5;
  if (purpose.includes(query)) return 6;
  return Number.POSITIVE_INFINITY;
}

function skillMatchesSlashToken(skill: CodexSkill, token: string) {
  const key = normalizeSkillKey(skill.name);
  const clean = normalizeSkillKey(token);
  if (!clean) return false;
  const shortName = normalizeSkillKey(key.split(':').pop() || key);
  return key === clean || shortName === clean || key.endsWith(`:${clean}`);
}

function extractSlashSkillReferences(prompt: string, skills: CodexSkill[]) {
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|[\s，。！？、,;；])\/\$?([A-Za-z0-9][\w.:-]{0,96})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt || ''))) {
    const token = match[1];
    const skill = skills.find((item) => skillMatchesSlashToken(item, token));
    if (!skill || seen.has(skill.name)) continue;
    seen.add(skill.name);
    found.push(skill.name);
  }
  return found;
}

function trailingSlashSkillQuery(prompt: string) {
  const text = String(prompt || '');
  const match = /(^|[\s，。！？、,;；])\/\$?([A-Za-z0-9][\w.:-]{0,96})?$/.exec(text);
  if (!match) return null;
  const start = text.lastIndexOf('/');
  if (start < 0) return null;
  return { start, end: text.length, query: match[2] || '' };
}

function shiftMentionsForTextReplacement(
  mentions: MediaMention[],
  range: { start: number; end: number },
  replacement: string,
) {
  const delta = replacement.length - (range.end - range.start);
  return mentions
    .filter((mention) => mention.end <= range.start || mention.start >= range.end)
    .map((mention) => (
      mention.start >= range.end
        ? { ...mention, start: mention.start + delta, end: mention.end + delta }
        : mention
    ));
}

function isImageGenerationSkillName(name: string) {
  return /^(imagegen|imagen|image-generation|image_generation|generate-image)$/i.test(normalizeSkillKey(name));
}

function findDefaultImageGenerationSkill(skills: CodexSkill[]) {
  return (
    skills.find((skill) => normalizeSkillKey(skill.name) === 'imagegen') ||
    skills.find((skill) => isImageGenerationSkillName(skill.name)) ||
    null
  );
}

function normalizeCodexRunIntent(value: any): Exclude<CodexRunIntent, 'auto'> {
  return value === 'img' ? 'img' : 'llm';
}

function autoCodexModelForRunIntent(intent: Exclude<CodexRunIntent, 'auto'>) {
  return intent === 'llm' ? LLM_DEFAULT_CODEX_MODEL : IMG_DEFAULT_CODEX_MODEL;
}

function codexModelAutoPatchForRunIntent(intent: Exclude<CodexRunIntent, 'auto'>) {
  const model = autoCodexModelForRunIntent(intent);
  return { codexModelMode: model, codexModel: model };
}

function shouldForceImageGeneration(_prompt: string, preset: CreatorPreset, skillNames: string[], runIntent: CodexRunIntent = 'auto') {
  if (runIntent === 'llm') return false;
  if (runIntent === 'img') return true;
  if (preset.mode === 'image' || preset.id === 'image') return true;
  if (skillNames.some(isImageGenerationSkillName)) return true;
  return false;
}

function shouldDisplayCodexToolMessage(event: CodexStreamEvent, message: string) {
  const text = String(message || '').trim();
  if (!text) return false;
  if (/^(thread|turn|item)\.(started|completed)$/i.test(text)) return false;
  if (/^Reading prompt from stdin/i.test(text)) return false;
  if (/plan_tool feature|Plan Tool CLI/i.test(text)) return false;
  if (/正在(?:打开|使用已设置的) Codex 创作工作区/i.test(text)) return false;
  if (event.rawType && /^(thread|turn|item)\.(started|completed)$/i.test(String(event.rawType))) return false;
  return true;
}

function isCreatorFacingSkill(skill: CodexSkill) {
  if (skill.scope === 'project') return true;
  const key = normalizeSkillKey(skill.name);
  if (CREATOR_SKILL_ALLOWLIST.some((name) => normalizeSkillKey(name) === key)) return true;
  const joined = `${skill.name} ${skill.description || ''}`.toLowerCase();
  return /image|visual|design|figma|layout|poster|logo|mood|scene|shot|prompt|story|script|presentation|document|copy|creative|canva/.test(joined);
}

function trimCodexStorageText(value: any, max = CODEX_MESSAGE_STORAGE_CHAR_LIMIT) {
  const text = String(value || '');
  if (text.length <= max) return text;
  const marker = `\n\n...[已为画布流畅度折叠 ${Math.max(0, text.length - max)} 字符]...\n\n`;
  if (max <= marker.length + 24) return `${text.slice(0, Math.max(0, max - marker.length))}${marker.trim()}`;
  const headLength = Math.max(0, Math.floor((max - marker.length) * 0.6));
  const tailLength = Math.max(0, max - marker.length - headLength);
  return `${text.slice(0, headLength).trimEnd()}${marker}${text.slice(-tailLength).trimStart()}`;
}

function sanitizeMessages(value: any): CodexAgentMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): CodexAgentMessage | null => {
      const role = ['user', 'assistant', 'tool', 'system'].includes(item?.role) ? item.role : 'assistant';
      const content = String(item?.content || '');
      if (!content && role !== 'assistant') return null;
      if (role === 'tool' && !shouldDisplayCodexToolMessage({ type: 'tool.progress' } as CodexStreamEvent, content)) return null;
      return {
        id: String(item?.id || makeId('codex-msg')),
        turnId: item?.turnId ? String(item.turnId) : undefined,
        role,
        content: trimCodexStorageText(content, role === 'tool' ? CODEX_TOOL_MESSAGE_STORAGE_CHAR_LIMIT : CODEX_MESSAGE_STORAGE_CHAR_LIMIT),
        mode: item?.mode,
        status: item?.status,
        createdAt: Number(item?.createdAt) || Date.now(),
      };
    })
    .filter((item): item is CodexAgentMessage => !!item)
    .slice(-MAX_MESSAGES);
}

function normalizeArtifact(value: any, fallbackTurnId?: string): CodexAgentArtifact | null {
  if (!value || typeof value !== 'object') return null;
  const kind = ['text', 'image', 'video', 'audio', 'model3d', 'file'].includes(value.kind) ? value.kind as CodexArtifactKind : 'text';
  const text = String(value.text || value.content || '').trim();
  const urls = Array.isArray(value.urls) ? value.urls.map((url: any) => String(url || '').trim()).filter(Boolean) : [];
  const url = String(value.url || urls[0] || '').trim();
  if (kind !== 'text' && !url && urls.length === 0) return null;
  if (kind === 'text' && !text) return null;
  return {
    ...value,
    id: String(value.id || makeId('codex-artifact')),
    kind,
    turnId: value.turnId || fallbackTurnId,
    title: String(value.title || artifactKindLabel(kind)),
    text: trimCodexStorageText(text, CODEX_ARTIFACT_TEXT_STORAGE_CHAR_LIMIT),
    content: kind === 'text' ? trimCodexStorageText(text, CODEX_ARTIFACT_TEXT_STORAGE_CHAR_LIMIT) : value.content,
    url,
    urls: urls.length ? urls : (url ? [url] : []),
    status: value.status || 'completed',
    progress: Number(value.progress) || 100,
    createdAt: Number(value.createdAt) || Date.now(),
  };
}

function sanitizeArtifacts(value: any): CodexAgentArtifact[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeArtifact(item))
    .filter((item): item is CodexAgentArtifact => !!item)
    .slice(-MAX_ARTIFACTS);
}

function normalizeArtifactIdentityValue(value: string) {
  let next = String(value || '').trim();
  if (!next) return '';
  next = next.replace(/^<+|>+$/g, '').replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  next = next.replace(/^https?:\/\/[^/]+/i, '');
  next = next.split(/[?#]/)[0] || next;
  return next.toLowerCase();
}

function artifactStableTitle(artifact: CodexAgentArtifact) {
  const title = String(artifact.title || '').trim();
  const extLike = /\.(png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav|m4a|glb|gltf|txt|md)$/i.test(title);
  const generic = !title || title === artifactKindLabel(artifact.kind);
  return extLike && !generic ? title : '';
}

function artifactDeleteKeys(artifact: CodexAgentArtifact): string[] {
  const urls = Array.isArray(artifact.urls) ? artifact.urls : [];
  const candidates = [
    artifact.id,
    artifact.url,
    ...urls,
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
  )).slice(-MAX_DELETED_ARTIFACT_KEYS);
}

function mergeDeletedArtifactKeys(...groups: Array<Array<string | undefined>>) {
  return Array.from(new Set(
    groups.flat()
      .map((item) => normalizeArtifactIdentityValue(String(item || '')))
      .filter(Boolean),
  )).slice(-MAX_DELETED_ARTIFACT_KEYS);
}

function artifactMatchesDeletedKeys(artifact: CodexAgentArtifact, deletedKeys: string[]) {
  if (deletedKeys.length === 0) return false;
  const deleted = new Set(deletedKeys.map(normalizeArtifactIdentityValue).filter(Boolean));
  return artifactDeleteKeys(artifact).some((key) => deleted.has(key));
}

function filterDeletedArtifacts(artifacts: CodexAgentArtifact[], deletedKeys: string[]) {
  if (deletedKeys.length === 0) return artifacts;
  return artifacts.filter((artifact) => !artifactMatchesDeletedKeys(artifact, deletedKeys));
}

function sanitizeVersions(value: any): CodexVersionEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): CodexVersionEntry | null => {
      const artifactId = String(item?.artifactId || '').trim();
      if (!artifactId) return null;
      return {
        id: String(item?.id || makeId('codex-version')),
        artifactId,
        title: String(item?.title || 'Codex 版本'),
        kind: item?.kind || 'text',
        parentId: item?.parentId ? String(item.parentId) : undefined,
        createdAt: Number(item?.createdAt) || Date.now(),
      };
    })
    .filter((item): item is CodexVersionEntry => !!item)
    .slice(-MAX_VERSIONS);
}

function deriveSessionTitle(messages: CodexAgentMessage[], fallback = '新会话') {
  const user = [...messages].reverse().find((item) => item.role === 'user' && item.content.trim());
  if (!user) return fallback;
  return textPreview(user.content, 24) || fallback;
}

function compactCodexStudioSessionForCanvas(session: CodexStudioSession): CodexStudioSession {
  const messages = sanitizeMessages(session.messages).slice(-CODEX_STUDIO_SESSION_MESSAGE_LIMIT);
  const artifacts = sanitizeArtifacts(session.artifacts).slice(-CODEX_STUDIO_SESSION_ARTIFACT_LIMIT);
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const versions = sanitizeVersions(session.versions)
    .filter((version) => artifactIds.has(version.artifactId))
    .slice(-MAX_VERSIONS);
  const contextSummary = trimCodexStorageText(session.contextSummary || '', CODEX_STUDIO_CONTEXT_SUMMARY_MAX_CHARS);
  return {
    ...session,
    id: String(session.id || makeId('codex-session')),
    title: String(session.title || deriveSessionTitle(messages, '新会话')).trim() || '新会话',
    updatedAt: Number(session.updatedAt) || Date.now(),
    messageCount: Number(session.messageCount) || messages.length,
    artifactCount: Number(session.artifactCount) || artifacts.length,
    messages,
    artifacts,
    versions,
    contextSummary,
    contextCompressedCount: clampInteger(session.contextCompressedCount, 0, 0, MAX_MESSAGES),
    contextLimit: clampInteger(session.contextLimit, CODEX_STUDIO_CONTEXT_DEFAULT_LIMIT, 0, CODEX_STUDIO_CONTEXT_MAX_LIMIT),
  };
}

function compactCodexStudioSessionsForCanvas(sessions: CodexStudioSession[]): CodexStudioSession[] {
  const seen = new Set<string>();
  return sessions
    .map((session) => compactCodexStudioSessionForCanvas(session))
    .filter((session) => {
      if (!session.id || seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    })
    .slice(0, CODEX_STUDIO_SESSION_STORAGE_LIMIT);
}

function sanitizeStudioSessions(value: any, fallbackId = 'session'): CodexStudioSession[] {
  const items = Array.isArray(value) ? value : [];
  const out = items
    .map((item): CodexStudioSession | null => {
      const id = String(item?.id || '').trim();
      if (!id) return null;
      const messages = sanitizeMessages(item?.messages);
      const artifacts = sanitizeArtifacts(item?.artifacts);
      const versions = sanitizeVersions(item?.versions);
      return {
        id,
        title: String(item?.title || deriveSessionTitle(messages, '新会话')).trim() || '新会话',
        updatedAt: Number(item?.updatedAt) || Date.now(),
        messageCount: Number(item?.messageCount) || messages.length,
        artifactCount: Number(item?.artifactCount) || artifacts.length,
        messages,
        artifacts,
        versions,
        contextSummary: String(item?.contextSummary || '').trim(),
        contextCompressedCount: clampInteger(item?.contextCompressedCount, 0, 0, MAX_MESSAGES),
        contextLimit: clampInteger(item?.contextLimit, CODEX_STUDIO_CONTEXT_DEFAULT_LIMIT, 0, CODEX_STUDIO_CONTEXT_MAX_LIMIT),
      };
    })
    .filter((item): item is CodexStudioSession => !!item);
  const compacted = compactCodexStudioSessionsForCanvas(out);
  if (compacted.length > 0) return compacted;
  return [compactCodexStudioSessionForCanvas({
    id: fallbackId,
    title: '当前会话',
    updatedAt: Date.now(),
    messageCount: 0,
    artifactCount: 0,
    messages: [],
    artifacts: [],
    versions: [],
    contextSummary: '',
    contextCompressedCount: 0,
    contextLimit: CODEX_STUDIO_CONTEXT_DEFAULT_LIMIT,
  })];
}

function artifactKindLabel(kind: CodexArtifactKind | string) {
  if (kind === 'image') return '图像';
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  if (kind === 'model3d') return '3D 模型';
  if (kind === 'file') return '文件';
  return '文本';
}

function artifactPrimaryUrl(artifact: CodexAgentArtifact | null | undefined) {
  if (!artifact) return '';
  return artifact.url || artifact.urls?.[0] || '';
}

function downloadName(url: string, fallback: string) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.pathname.split('/').pop() || fallback;
  } catch {
    return fallback;
  }
}

function materialUrls(materials: Material[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const material of materials) {
    const url = String(material.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function materialIds(materials: Material[]): string[] {
  return Array.from(new Set(materials.map((material) => String(material.id || '').trim()).filter(Boolean)));
}

function mergeMaterialIds(...groups: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const value of group || []) {
      const id = String(value || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function artifactToMaterial(artifact: CodexAgentArtifact, nodeId: string): Material | null {
  const id = String(artifact.id || makeId('codex-artifact'));
  if (artifact.kind === 'text') {
    const text = String(artifact.text || '').trim();
    if (!text) return null;
    return {
      id,
      kind: 'text',
      url: text,
      sourceNodeId: nodeId,
      origin: 'local',
      label: artifact.title || 'Codex 文本',
      mentionKey: `codex-artifact:${id}`,
    } as Material & { mentionKey?: string };
  }
  if (!['image', 'video', 'audio'].includes(String(artifact.kind))) return null;
  const url = artifactPrimaryUrl(artifact);
  if (!url) return null;
  return {
    id,
    kind: artifact.kind as 'image' | 'video' | 'audio',
    url,
    sourceNodeId: nodeId,
    origin: 'local',
    label: artifact.title || artifactKindLabel(artifact.kind),
    mentionKey: `codex-artifact:${id}`,
  } as Material & { mentionKey?: string };
}

function artifactToSendableMaterial(artifact: CodexAgentArtifact, nodeId: string) {
  const title = artifact.title || artifactKindLabel(artifact.kind);
  if (artifact.kind === 'text') {
    const text = String(artifact.text || '').trim();
    if (!text) return null;
    return { id: artifact.id || makeId('codex-send-text'), kind: 'text', text, name: title, sourceNodeId: nodeId };
  }
  const url = artifactPrimaryUrl(artifact);
  if (!url) return null;
  return {
    id: artifact.id || makeId('codex-send-media'),
    kind: artifact.kind,
    url,
    name: title || downloadName(url, 'codex-output'),
    sourceNodeId: nodeId,
  };
}

function openArtifactSendModal(artifact: CodexAgentArtifact, nodeId: string) {
  const material = artifactToSendableMaterial(artifact, nodeId);
  if (!material) {
    logBus.warn('这个 Codex 产物没有可发送到画布的内容', `codex:${nodeId}`);
    return;
  }
  window.dispatchEvent(new CustomEvent('penguin:open-send-materials', {
    detail: {
      materials: [material],
      sourceLabel: `Codex 产物 · ${material.name || artifactKindLabel(artifact.kind)}`,
      defaultMode: artifact.kind === 'text' ? 'upload' : 'output',
    },
  }));
}

function buildPrompt(
  localPrompt: string,
  upstreamTexts: Material[],
  mentions: MediaMention[],
  mentionMaterials: Material[],
) {
  const upstreamText = upstreamTexts.map((item) => item.url).filter(Boolean).join('\n\n').trim();
  const resolvedLocal = resolveMediaMentions(localPrompt || '', mentions || [], mentionMaterials).trim();
  return [upstreamText, resolvedLocal].filter(Boolean).join('\n\n').trim();
}

function buildImageOnlyPrompt(images: string[], videos: string[], audios: string[], preset: CreatorPreset) {
  if (images.length > 0) {
    const action = preset.mode === 'image' || preset.id === 'image'
      ? '直接生成一张与参考图强相关的新图'
      : '基于参考图完成当前创作任务';
    return [
      `${action}。`,
      '请优先保留参考图里的主体身份、构图关系、服装/发型/色彩/材质和关键视觉线索。',
      '如果要改风格，也要让结果明显来自这张参考图，不要另起炉灶。',
    ].join('\n');
  }
  if (videos.length > 0) return '请基于已连接的视频素材完成当前创作任务，先提炼画面内容、镜头节奏和可执行改稿方向。';
  if (audios.length > 0) return '请基于已连接的音频素材完成当前创作任务，先提炼声音特点、情绪和可执行创作方向。';
  return '';
}

function buildCreatorBriefBlock(data: any): string {
  const lines: string[] = [];
  const push = (label: string, value: any) => {
    const text = String(value || '').trim();
    if (text) lines.push(`- ${label}: ${text}`);
  };
  push('主体', data.codexBriefSubject);
  push('风格', data.codexBriefStyle);
  push('镜头', data.codexBriefCamera);
  push('光影', data.codexBriefLighting);
  push('构图', data.codexBriefComposition);
  push('平台转换', data.codexTargetPlatform);
  push('比例', data.codexAspectRatio);
  push('风格锁定', data.codexStyleLock);
  push('自动负面词', data.codexAutoNegativePrompt === false ? '' : '根据目标模型和题材自动补充负面词，并单独输出 negative prompt。');
  push('负面词', data.codexNegativePrompt);
  const variantCount = Number(data.codexBatchVariantCount || 1);
  if (Number.isFinite(variantCount) && variantCount > 1) lines.push(`- 批量变体: 输出 ${variantCount} 个差异明显的方向。`);
  return lines.length ? `创作 Brief:\n${lines.join('\n')}` : '';
}

function buildPresetInstructionBlock(preset: CreatorPreset, forceImageGeneration: boolean) {
  const label = String(preset.label || '').trim();
  const category = sanitizeCreatorCategory(preset.category);
  const hint = String(preset.hint || '').trim();
  const systemHint = String(preset.systemHint || '').trim();
  const lines = [
    label ? `当前创作模板：${label}` : '',
    category ? `模板分类：${category}` : '',
    hint ? `模板用途：${hint}` : '',
    systemHint ? `模板指令：\n${systemHint}` : '',
    forceImageGeneration ? '执行模式：本轮允许 IMG 生图，但必须优先遵循上面的创作模板，不要用默认生图提示覆盖模板要求。' : '',
  ].filter(Boolean);
  return lines.length ? `创作模板指令：\n${lines.join('\n')}` : '';
}

function createVariantPrompt(artifact: CodexAgentArtifact, count: number) {
  const base = artifact.kind === 'text'
    ? String(artifact.text || '')
    : `${artifact.title || artifactKindLabel(artifact.kind)} ${artifactPrimaryUrl(artifact)}`;
  return `基于下面 Codex 产物继续生成 ${count} 个批量变体。要求每个方向都有明确差异：主体构图、色彩、镜头、光影、平台适配、负面词和可直接复制的 Prompt。\n\n${base}`;
}

function shouldStoreTextArtifact(textValue: string, preset: CreatorPreset, generatedArtifacts: CodexAgentArtifact[]) {
  const text = String(textValue || '').trim();
  if (!text) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const nonRuntimeLines = lines.filter((line) => !/^(?:thread|turn|item)\.(?:started|completed)\b|^Reading prompt from stdin\b|^正在准备 Codex 专用创作工作区|^当前 Codex CLI 未提供/i.test(line));
  if (nonRuntimeLines.length === 0) return false;
  const hasMedia = generatedArtifacts.some((artifact) => artifact.kind !== 'text');
  if (hasMedia && preset.mode === 'image' && nonRuntimeLines.join('').length < 12) return false;
  if (preset.mode === 'image' && /(?:^|\n)\s*(?:thread|turn)\.started\b/i.test(text)) return false;
  return true;
}

function selectAutoPublishArtifact(
  generatedArtifacts: CodexAgentArtifact[],
  runIntent: CodexRunIntent,
  fallback: CodexAgentArtifact | null,
) {
  const ordered = generatedArtifacts.filter(Boolean);
  if (runIntent === 'img') {
    return [...ordered].reverse().find((artifact) => artifact.kind === 'image') ||
      [...ordered].reverse().find((artifact) => artifact.kind !== 'text') ||
      fallback;
  }
  if (runIntent === 'llm') {
    return [...ordered].reverse().find((artifact) => artifact.kind === 'text') || fallback;
  }
  return fallback;
}

function stopCopyableConversationEvent(event: any) {
  event.stopPropagation?.();
  event.nativeEvent?.stopImmediatePropagation?.();
}

function settingsValue(value: any, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function clampInteger(value: any, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

const codexLoginCommand = 'codex login';
const codexInstallCommand = 'npm install -g @openai/codex';
const CODEX_LOGIN_FLOW_STEPS = [
  '1. 点击“打开登录”，T8 会在 Windows 上打开一个可见的 Codex 登录窗口。',
  '2. 按新窗口或浏览器里的 OpenAI / Codex 授权提示完成登录；如果显示验证码或链接，请按终端提示操作。',
  '3. 登录完成后回到 T8，点击“刷新”，看到“Codex 已就绪”后即可生成。',
  '如果点击没有弹窗：点“复制登录命令”，在普通 CMD 或 PowerShell 里粘贴运行 codex login；未安装时先复制安装命令。',
];

function isRouteMissingMessage(message: string) {
  return /后端路由未加载|HTTP\s*404|404\s*\(Not Found\)/i.test(message || '');
}

function friendlyCodexErrorMessage(message: any) {
  const text = String(message || '').trim();
  if (!text) return '';
  if (isRouteMissingMessage(text)) return 'Codex CLI 后端路由未加载：请重启后端服务或桌面应用，让 /api/codex-cli 生效。';
  return text;
}

function clearRecoverableCodexError(message: any) {
  const text = String(message || '').trim();
  if (!text) return false;
  return (
    isRouteMissingMessage(text) ||
    /Codex CLI 不可用|没有登录|需要登录|Unknown feature flag:\s*(?:plan_tool|web_search)/i.test(text)
  );
}

function textPreview(text: string, length = 120) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length)}...` : clean;
}

function trimCodexStudioMemorySummary(value: string) {
  const text = String(value || '').trim();
  if (text.length <= CODEX_STUDIO_CONTEXT_SUMMARY_MAX_CHARS) return text;
  const trimmed = text.slice(-CODEX_STUDIO_CONTEXT_SUMMARY_MAX_CHARS);
  return trimmed.replace(/^[\s\S]*?(?=\n- )/, '').trim() || trimmed.trim();
}

function codexStudioMemoryMessages(history: CodexAgentMessage[]) {
  return sanitizeMessages(history)
    .filter((item) => (item.role === 'user' || item.role === 'assistant') && item.status !== 'running')
    .map((item) => ({
      role: item.role as 'user' | 'assistant',
      content: String(item.content || '').trim(),
    }))
    .filter((item) => item.content && !/^Codex 任务已停止$/i.test(item.content));
}

function summarizeCodexStudioMemoryChunk(messages: Array<{ role: 'user' | 'assistant'; content: string }>) {
  return messages
    .map((item) => `- ${item.role === 'user' ? '用户' : 'Codex'}：${textPreview(item.content, 420)}`)
    .join('\n');
}

function mergeCodexStudioMemorySummary(previousSummary: string, newlyCompressed: Array<{ role: 'user' | 'assistant'; content: string }>) {
  const previous = String(previousSummary || '').trim();
  const nextChunk = summarizeCodexStudioMemoryChunk(newlyCompressed);
  return trimCodexStudioMemorySummary([previous, nextChunk].filter(Boolean).join('\n'));
}

function buildCodexStudioMemoryContext(
  history: CodexAgentMessage[],
  options: { contextLimit?: number; summary?: string; compressedCount?: number } = {},
): CodexStudioMemoryContext {
  const contextLimit = clampInteger(options.contextLimit, CODEX_STUDIO_CONTEXT_DEFAULT_LIMIT, 0, CODEX_STUDIO_CONTEXT_MAX_LIMIT);
  const historyMessages = codexStudioMemoryMessages(history);
  const previousSummary = String(options.summary || '').trim();
  const previousCompressedCount = clampInteger(options.compressedCount, 0, 0, historyMessages.length);
  const targetCompressedCount = contextLimit <= 0 ? historyMessages.length : Math.max(0, historyMessages.length - contextLimit);
  const normalizedCompressedCount = Math.min(previousCompressedCount, targetCompressedCount);
  const newlyCompressed = historyMessages.slice(normalizedCompressedCount, targetCompressedCount);
  const summary = newlyCompressed.length ? mergeCodexStudioMemorySummary(previousSummary, newlyCompressed) : previousSummary;
  const messages = contextLimit <= 0 ? [] : historyMessages.slice(-contextLimit);
  return {
    messages,
    summary,
    compressedCount: targetCompressedCount,
    compressedNow: newlyCompressed.length,
    contextLimit,
  };
}

function buildCodexStudioMemoryPrompt(memory: CodexStudioMemoryContext) {
  const summary = String(memory.summary || '').trim();
  const recent = memory.messages
    .map((item) => `${item.role === 'user' ? '用户' : 'Codex'}：${item.content}`)
    .join('\n\n');
  if (!summary && !recent) return '';
  return [
    '本轮创作台会话记忆：以下内容来自同一个 Codex 创作台会话，请作为连续记忆使用，不要把它当成用户刚刚输入。',
    summary ? `长期压缩记忆：\n${summary}` : '',
    recent ? `最近 ${memory.messages.length} 条对话：\n${recent}` : '',
  ].filter(Boolean).join('\n\n');
}

async function saveArtifactToResourceLibrary(artifact: CodexAgentArtifact, nodeId: string): Promise<string> {
  const title = artifact.title || artifactKindLabel(artifact.kind);
  const tags = ['Codex CLI', 'Agent', '创作者'];
  if (artifact.kind === 'text') {
    const text = String(artifact.text || '').trim();
    if (!text) throw new Error('这个文本产物为空。');
    const result: any = await api.addResourceSet({
      materialSetKind: 'text',
      materialSetItems: [{ id: artifact.id, kind: 'text', text, name: title }],
      title,
      tags,
      sourceNodeId: nodeId,
      favorite: false,
    });
    window.dispatchEvent(new CustomEvent('penguin:resources-changed'));
    return result?.duplicate ? '资源库已有' : '已入库';
  }

  const url = artifactPrimaryUrl(artifact);
  if (!url) throw new Error('这个产物没有可保存的 URL。');
  const result: any = await api.addResourceItem({
    kind: artifact.kind as any,
    url,
    title: title || downloadName(url, 'codex-output'),
    tags,
    sourceNodeId: nodeId,
    favorite: false,
  });
  window.dispatchEvent(new CustomEvent('penguin:resources-changed'));
  return result?.duplicate ? '资源库已有' : '已入库';
}

const CodexCliAgentNode = ({ id, data, selected }: NodeProps) => {
  const update = useUpdateNodeData(id);
  const d = (data || {}) as any;
  const { theme, style: themeStyle } = useThemeStore();
  const isDark = theme === 'dark';
  const isPixel = themeStyle === 'pixel';

  const [studioOpen, setStudioOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<CodexCliStatus | null>(null);
  const [skills, setSkills] = useState<CodexSkill[]>([]);
  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerMode, setSkillPickerMode] = useState<CodexSkillPickerMode>('select');
  const [skillPickerAnchor, setSkillPickerAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const [slashSkillRange, setSlashSkillRange] = useState<{ start: number; end: number } | null>(null);
  const [artifactLibraryTab, setArtifactLibraryTab] = useState<'image' | 'text'>('image');
  const [artifactBatchMode, setArtifactBatchMode] = useState(false);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);
  const [hoverZoomArtifact, setHoverZoomArtifact] = useState<CodexAgentArtifact | null>(null);
  const [codexStudioTool, setCodexStudioTool] = useState<CodexStudioTool>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState('');
  const [codexTemplateCategoryFilter, setCodexTemplateCategoryFilter] = useState('全部');
  const [skillDraftName, setSkillDraftName] = useState('creator-note');
  const [skillDraftCategory, setSkillDraftCategory] = useState(DEFAULT_CREATOR_CATEGORY);
  const [skillDraftBody, setSkillDraftBody] = useState('# 创作者 Skill\n\n用于记录当前项目的风格、禁忌和交付标准。');
  const [editingSkillName, setEditingSkillName] = useState('');
  const [projectSkillCategoryFilter, setProjectSkillCategoryFilter] = useState('全部');
  const [streamingReply, setStreamingReply] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const simplePromptFrameRef = useRef<HTMLDivElement | null>(null);
  const studioPromptFrameRef = useRef<HTMLDivElement | null>(null);
  const studioThreadScrollRef = useRef<HTMLDivElement | null>(null);
  const templateImportInputRef = useRef<HTMLInputElement | null>(null);
  const projectSkillImportInputRef = useRef<HTMLInputElement | null>(null);
  const skillRefreshRequestRef = useRef(0);

  const sessionId = settingsValue(d.codexSessionId, `${id}-${Date.now().toString(36)}`);
  const customPresets = useMemo(() => sanitizeCreatorPresets(d.codexUserPresets), [d.codexUserPresets]);
  const allCreatorPresets = useMemo(() => [...customPresets, ...SYSTEM_CREATOR_PRESETS], [customPresets]);
  const presetId = settingsValue(d.codexPresetId || d.codexPreset, NO_CREATOR_PRESET_ID);
  const selectedCreatorPreset = presetId === NO_CREATOR_PRESET_ID
    ? null
    : allCreatorPresets.find((item) => item.id === presetId || item.label === presetId) || null;
  const hasActiveCreatorPreset = Boolean(selectedCreatorPreset);
  const currentPreset = selectedCreatorPreset || DEFAULT_CREATOR_PRESET;
  const currentPresetLabel = hasActiveCreatorPreset ? currentPreset.label : '无模板';
  const codexRunIntent = normalizeCodexRunIntent(d.codexRunIntent);
  const quickPrompt = String(d.codexQuickPrompt || '');
  const quickPromptMentions = (Array.isArray(d.codexQuickPromptMentions) ? d.codexQuickPromptMentions : []) as MediaMention[];
  const selectedSkillNames = asStringArray(d.codexSelectedSkillNames);
  const creatorSkills = useMemo(() => skills.filter(isCreatorFacingSkill), [skills]);
  const projectSkills = useMemo(() => skills.filter((skill) => skill.scope === 'project'), [skills]);
  const selectedSkillKey = selectedSkillNames.join('\n');
  const selectedRunnableSkillNames = useMemo(() => {
    if (creatorSkills.length === 0) return [];
    const valid = new Set(creatorSkills.map((skill) => skill.name));
    return selectedSkillNames.filter((name) => valid.has(name));
  }, [creatorSkills, selectedSkillKey]);
  const selectedRunnableSkillKey = selectedRunnableSkillNames.join('\n');
  const templateCategories = useMemo(() => {
    const categories = new Set([DEFAULT_CREATOR_CATEGORY]);
    customPresets.forEach((preset) => categories.add(sanitizeCreatorCategory(preset.category)));
    return ['全部', ...Array.from(categories).sort((a, b) => a.localeCompare(b))];
  }, [customPresets]);
  const templateSelectCategoryValue = settingsValue(d.codexTemplateSelectCategory, '全部');
  const codexTemplateSelectCategory = templateCategories.includes(templateSelectCategoryValue)
    ? templateSelectCategoryValue
    : '全部';
  const visibleSelectableCreatorPresets = useMemo(() => (
    codexTemplateSelectCategory === '全部'
      ? allCreatorPresets
      : allCreatorPresets.filter((preset) => sanitizeCreatorCategory(preset.category) === codexTemplateSelectCategory)
  ), [allCreatorPresets, codexTemplateSelectCategory]);
  const projectSkillCategories = useMemo(() => {
    const categories = new Set([DEFAULT_CREATOR_CATEGORY]);
    projectSkills.forEach((skill) => categories.add(sanitizeCreatorCategory(skill.category)));
    return ['全部', ...Array.from(categories).sort((a, b) => a.localeCompare(b))];
  }, [projectSkills]);
  const visibleCustomPresets = useMemo(() => (
    codexTemplateCategoryFilter === '全部'
      ? customPresets
      : customPresets.filter((preset) => sanitizeCreatorCategory(preset.category) === codexTemplateCategoryFilter)
  ), [codexTemplateCategoryFilter, customPresets]);
  const visibleProjectSkills = useMemo(() => (
    projectSkillCategoryFilter === '全部'
      ? projectSkills
      : projectSkills.filter((skill) => sanitizeCreatorCategory(skill.category) === projectSkillCategoryFilter)
  ), [projectSkillCategoryFilter, projectSkills]);
  const filteredCreatorSkills = useMemo(() => {
    const query = skillSearchQuery.trim();
    if (!query) return creatorSkills;
    return creatorSkills
      .map((skill) => ({ skill, score: scoreSkillMatch(skill, query) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name))
      .map((item) => item.skill);
  }, [creatorSkills, skillSearchQuery]);
  const selectedCreatorSkills = useMemo(
    () => creatorSkills.filter((skill) => selectedRunnableSkillNames.includes(skill.name)),
    [creatorSkills, selectedRunnableSkillKey],
  );
  const defaultImageGenerationSkill = useMemo(() => findDefaultImageGenerationSkill(creatorSkills), [creatorSkills]);
  const codexAutoImagegenSkillName = String(d.codexAutoImagegenSkillName || '').trim();
  const hasLegacyCustomCodexModel = settingsValue(d.codexModelMode, '') === 'custom' && Boolean(String(d.codexModel || '').trim());
  const codexModelManual = d.codexModelManual === true || hasLegacyCustomCodexModel;
  const autoCodexModelMode = autoCodexModelForRunIntent(codexRunIntent);
  const codexModelMode = codexModelManual
    ? settingsValue(d.codexModelMode, d.codexModel ? 'custom' : autoCodexModelMode)
    : autoCodexModelMode;
  const selectedCodexModel = codexModelMode === 'default'
    ? ''
    : codexModelMode === 'custom'
      ? String(d.codexModel || '').trim()
      : codexModelMode;
  const materialOrder = Array.isArray(d.materialOrder) ? d.materialOrder : [];
  const persistPrompt = d.codexPersistPrompt === true;
  const studioAutoPublishOutput = d.codexAutoPublishOutput === true;
  const autoPublishOutput = studioOpen ? studioAutoPublishOutput : true;
  const persistMaterials = d.codexPersistMaterials === true;
  const statusText = String(d.status || 'idle');
  const isBusy = ['running', 'streaming', 'submitting'].includes(statusText);
  const codexStudioMemorySettings = useMemo(() => ({
    contextSummary: String(d.codexContextSummary || '').trim(),
    contextCompressedCount: clampInteger(d.codexContextCompressedCount, 0, 0, MAX_MESSAGES),
    contextLimit: clampInteger(d.codexContextLimit, CODEX_STUDIO_CONTEXT_DEFAULT_LIMIT, 0, CODEX_STUDIO_CONTEXT_MAX_LIMIT),
  }), [d.codexContextCompressedCount, d.codexContextLimit, d.codexContextSummary]);
  const codexContextSummary = codexStudioMemorySettings.contextSummary;
  const codexContextCompressedCount = codexStudioMemorySettings.contextCompressedCount;
  const codexContextLimit = codexStudioMemorySettings.contextLimit;
  const messages = useMemo(() => sanitizeMessages(d.codexMessages), [d.codexMessages]);
  const deletedArtifactKeys = useMemo(() => sanitizeDeletedArtifactKeys(d.codexDeletedArtifactKeys), [d.codexDeletedArtifactKeys]);
  const artifacts = useMemo(
    () => filterDeletedArtifacts(sanitizeArtifacts(d.codexArtifacts), deletedArtifactKeys),
    [d.codexArtifacts, deletedArtifactKeys],
  );
  const imageArtifacts = useMemo(() => artifacts.filter((artifact) => artifact.kind === 'image'), [artifacts]);
  const textArtifacts = useMemo(() => artifacts.filter((artifact) => artifact.kind === 'text'), [artifacts]);
  const visibleStudioArtifacts = artifactLibraryTab === 'image' ? imageArtifacts : textArtifacts;
  const versions = useMemo(() => sanitizeVersions(d.codexVersions), [d.codexVersions]);
  const codexStudioSessions = useMemo(() => sanitizeStudioSessions(d.codexStudioSessions, sessionId), [d.codexStudioSessions, sessionId]);
  const activeStudioSessionId = settingsValue(d.codexActiveStudioSessionId, codexStudioSessions[0]?.id || sessionId);
  const studioSessionList = useMemo(() => {
    const current: CodexStudioSession = {
      id: activeStudioSessionId,
      title: deriveSessionTitle(messages, '当前会话'),
      updatedAt: messages[messages.length - 1]?.createdAt || Date.now(),
      messageCount: messages.length,
      artifactCount: artifacts.length,
      messages,
      artifacts,
      versions,
      contextSummary: codexContextSummary,
      contextCompressedCount: codexContextCompressedCount,
      contextLimit: codexContextLimit,
    };
    const next = [current, ...codexStudioSessions.filter((item) => item.id !== activeStudioSessionId)];
    return compactCodexStudioSessionsForCanvas(next);
  }, [activeStudioSessionId, artifacts, codexContextCompressedCount, codexContextLimit, codexContextSummary, codexStudioSessions, messages, versions]);
  const messagesRef = useRef<CodexAgentMessage[]>(messages);
  const artifactsRef = useRef<CodexAgentArtifact[]>(artifacts);
  const versionsRef = useRef<CodexVersionEntry[]>(versions);
  const deletedArtifactKeysRef = useRef<string[]>(deletedArtifactKeys);
  const codexContextSummaryRef = useRef(codexContextSummary);
  const codexContextCompressedCountRef = useRef(codexContextCompressedCount);
  const codexContextLimitRef = useRef(codexContextLimit);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { artifactsRef.current = artifacts; }, [artifacts]);
  useEffect(() => { versionsRef.current = versions; }, [versions]);
  useEffect(() => { deletedArtifactKeysRef.current = deletedArtifactKeys; }, [deletedArtifactKeys]);
  useEffect(() => { codexContextSummaryRef.current = codexContextSummary; }, [codexContextSummary]);
  useEffect(() => { codexContextCompressedCountRef.current = codexContextCompressedCount; }, [codexContextCompressedCount]);
  useEffect(() => { codexContextLimitRef.current = codexContextLimit; }, [codexContextLimit]);
  useEffect(() => {
    setSelectedArtifactIds((current) => current.filter((artifactId) => artifacts.some((artifact) => artifact.id === artifactId)));
  }, [artifacts]);

  useEffect(() => {
    if (!studioOpen) return undefined;
    const el = studioThreadScrollRef.current;
    if (!el) return undefined;
    const frame = window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [studioOpen, messages.length, streamingReply]);

  useEffect(() => {
    if (!studioOpen) setHoverZoomArtifact(null);
  }, [studioOpen]);

  useEffect(() => {
    if (!studioOpen || typeof document === 'undefined') return undefined;
    const stopSelectableTextGesture = (event: Event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target?.closest?.('[data-codex-studio-copyable], [data-codex-message-copyable]')) return;
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
    if (d.codexSessionId) return;
    update({ codexSessionId: sessionId });
  }, [d.codexSessionId, sessionId, update]);

  useEffect(() => {
    if (creatorSkills.length === 0) return;
    if (selectedSkillKey === selectedRunnableSkillKey) return;
    update({ codexSelectedSkillNames: selectedRunnableSkillNames });
  }, [creatorSkills.length, selectedRunnableSkillKey, selectedRunnableSkillNames, selectedSkillKey, update]);

  useEffect(() => {
    if (!codexAutoImagegenSkillName) return;
    if (!selectedRunnableSkillNames.includes(codexAutoImagegenSkillName)) {
      update({ codexAutoImagegenSkillName: '' });
      return;
    }
    if (codexRunIntent === 'llm' && codexAutoImagegenSkillName) {
      update({
        codexSelectedSkillNames: selectedRunnableSkillNames.filter((name) => name !== codexAutoImagegenSkillName),
        codexAutoImagegenSkillName: '',
      });
    }
  }, [
    codexAutoImagegenSkillName,
    codexRunIntent,
    selectedRunnableSkillKey,
    selectedRunnableSkillNames,
    update,
  ]);

  const upstream = useUpstreamMaterials(id);
  const excludedMaterialIds = useMemo(
    () => normalizeExcludedMaterialIds(d.excludedMaterialIds),
    [d.excludedMaterialIds],
  );
  const studioConsumedMaterialIds = useMemo(
    () => normalizeExcludedMaterialIds(d.codexStudioConsumedMaterialIds),
    [d.codexStudioConsumedMaterialIds],
  );
  const visibleUpstreamTexts = useMemo(
    () => filterExcludedMaterials(upstream.texts, excludedMaterialIds),
    [upstream.texts, excludedMaterialIds],
  );
  const visibleUpstreamImages = useMemo(
    () => filterExcludedMaterials(upstream.images, excludedMaterialIds),
    [upstream.images, excludedMaterialIds],
  );
  const visibleUpstreamVideos = useMemo(
    () => filterExcludedMaterials(upstream.videos, excludedMaterialIds),
    [upstream.videos, excludedMaterialIds],
  );
  const visibleUpstreamAudios = useMemo(
    () => filterExcludedMaterials(upstream.audios, excludedMaterialIds),
    [upstream.audios, excludedMaterialIds],
  );
  const excludedUpstreamCount = useMemo(
    () => countExcludedMaterials(excludedMaterialIds, [...upstream.texts, ...upstream.images, ...upstream.videos, ...upstream.audios]),
    [excludedMaterialIds, upstream.texts, upstream.images, upstream.videos, upstream.audios],
  );
  const artifactMaterials = useMemo(
    () => artifacts.map((artifact) => artifactToMaterial(artifact, id)).filter((item): item is Material => !!item),
    [artifacts, id],
  );
  const activeUpstreamTexts = useMemo(
    () => studioOpen && !persistMaterials ? filterExcludedMaterials(visibleUpstreamTexts, studioConsumedMaterialIds) : visibleUpstreamTexts,
    [persistMaterials, studioConsumedMaterialIds, studioOpen, visibleUpstreamTexts],
  );
  const activeUpstreamImages = useMemo(
    () => studioOpen && !persistMaterials ? filterExcludedMaterials(visibleUpstreamImages, studioConsumedMaterialIds) : visibleUpstreamImages,
    [persistMaterials, studioConsumedMaterialIds, studioOpen, visibleUpstreamImages],
  );
  const activeUpstreamVideos = useMemo(
    () => studioOpen && !persistMaterials ? filterExcludedMaterials(visibleUpstreamVideos, studioConsumedMaterialIds) : visibleUpstreamVideos,
    [persistMaterials, studioConsumedMaterialIds, studioOpen, visibleUpstreamVideos],
  );
  const activeUpstreamAudios = useMemo(
    () => studioOpen && !persistMaterials ? filterExcludedMaterials(visibleUpstreamAudios, studioConsumedMaterialIds) : visibleUpstreamAudios,
    [persistMaterials, studioConsumedMaterialIds, studioOpen, visibleUpstreamAudios],
  );
  const orderedInputTexts = useOrderedMaterials(activeUpstreamTexts, materialOrder);
  const orderedTexts = useOrderedMaterials(activeUpstreamTexts, materialOrder);
  const orderedImages = useOrderedMaterials(activeUpstreamImages, materialOrder);
  const orderedVideos = useOrderedMaterials(activeUpstreamVideos, materialOrder);
  const orderedAudios = useOrderedMaterials(activeUpstreamAudios, materialOrder);
  const mentionMaterials = useMemo(
    () => [...orderedTexts, ...orderedImages, ...orderedVideos, ...orderedAudios, ...artifactMaterials],
    [orderedTexts, orderedImages, orderedVideos, orderedAudios, artifactMaterials],
  );
  const inputMaterialTotal = orderedInputTexts.length + orderedImages.length + orderedVideos.length + orderedAudios.length;
  const setMaterialOrder = useCallback((nextOrder: string[]) => update({ materialOrder: nextOrder }), [update]);
  const excludeUpstreamMaterial = useCallback((material: Material) => {
    if (material.origin !== 'upstream') return;
    update({
      excludedMaterialIds: excludeMaterialId(excludedMaterialIds, material.id),
      materialOrder: materialOrder.filter((itemId: string) => itemId !== material.id),
    });
  }, [excludedMaterialIds, materialOrder, update]);
  const restoreExcludedMaterials = useCallback(() => {
    update({ excludedMaterialIds: [] });
  }, [update]);

  const accent = isPixel ? 'var(--px-cyan)' : isDark ? '#38bdf8' : '#0284c7';
  const bg = isPixel ? 'var(--px-surface)' : isDark ? 'rgba(8,13,28,0.97)' : '#ffffff';
  const surface = isPixel ? 'var(--px-muted)' : isDark ? 'rgba(255,255,255,0.06)' : 'rgba(2,132,199,0.07)';
  const surfaceStrong = isPixel ? 'var(--px-yellow)' : isDark ? 'rgba(56,189,248,0.14)' : 'rgba(14,165,233,0.16)';
  const text = isPixel ? 'var(--px-ink)' : isDark ? '#ecfeff' : '#0f172a';
  const subText = isPixel ? 'var(--px-ink-soft)' : isDark ? 'rgba(236,254,255,0.68)' : '#64748b';
  const border = isPixel ? 'var(--px-ink)' : isDark ? 'rgba(125,211,252,0.26)' : 'rgba(2,132,199,0.28)';
  const danger = isPixel ? '#dc2626' : '#fb7185';
  const readablePalette = createReadableStudioPalette({ isDark, isPixel, accent, bg, surface, surfaceStrong, text, subText, border, danger });
  const studioAccentText = readablePalette.accentText;
  const studioHeaderText = readablePalette.headerText;
  const studioHeaderSubText = readablePalette.headerSubText;
  const studioSurfaceStrongText = readablePalette.surfaceStrongText;
  const activeControlText = readableTextOn(accent, isDark);
  const inactiveControlText = readablePalette.controlText;
  const inactiveControlBg = readablePalette.controlBg;

  const rootStyle: CSSProperties = {
    width: 420,
    minHeight: 500,
    background: bg,
    color: text,
    border: `2px solid ${selected ? accent : border}`,
    borderRadius: isPixel ? 8 : 16,
    boxShadow: isPixel ? (selected ? '5px 5px 0 var(--px-ink)' : '3px 3px 0 var(--px-ink)') : 'var(--t8-node-shadow, 0 16px 42px rgba(0,0,0,0.32))',
    overflow: 'visible',
  };

  const buttonStyle: CSSProperties = {
    border: `1px solid ${border}`,
    background: surface,
    color: text,
    borderRadius: isPixel ? 6 : 10,
  };

  const segmentedControlButtonStyle = (active: boolean): CSSProperties => {
    const controlBg = active ? accent : inactiveControlBg;
    return {
      border: `1px solid ${active ? accent : border}`,
      background: controlBg,
      color: active ? activeControlText : readableTextOn(controlBg, isDark),
      borderRadius: isPixel ? 6 : 10,
      boxShadow: active ? '0 1px 0 rgba(0,0,0,0.28)' : undefined,
    };
  };

  const appendImagegenQuickParam = useCallback((value: string) => {
    update({ codexQuickPrompt: appendCommaSeparatedPromptToken(quickPrompt, value) });
  }, [quickPrompt, update]);

  const renderImagegenQuickParamBar = (placement: 'simple' | 'studio') => (
    <div
      data-codex-imagegen-param-bar={placement}
      className={`nodrag grid gap-1.5 ${placement === 'studio' ? 'mb-2' : 'mt-2'}`}
      style={{ color: subText }}
    >
      <div className="grid grid-cols-2 gap-1.5">
        {CODEX_IMAGEGEN_PARAM_LISTS.map((group) => (
          <select
            key={`${placement}-${group.label}`}
            data-codex-imagegen-param-list={group.label}
            className="nodrag min-w-0 rounded-md border px-2 py-1 text-[10px] font-black outline-none"
            style={{ borderColor: border, background: bg, color: text }}
            value=""
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value) appendImagegenQuickParam(value);
            }}
            title={`追加${group.label}参数`}
          >
            <option value="">{group.label}</option>
            {group.options.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CODEX_IMAGEGEN_QUICK_PARAMS.map((item) => (
          <button
            key={`${placement}-${item.value}`}
            type="button"
            data-codex-imagegen-param={item.value}
            className="nodrag rounded-md border px-2 py-1 text-[10px] font-black leading-none"
            style={{ borderColor: border, background: surfaceStrong, color: studioSurfaceStrongText }}
            onClick={() => appendImagegenQuickParam(item.value)}
            title={`追加 ${item.value},`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );

  const setMessages = useCallback((next: CodexAgentMessage[], extra: Record<string, any> = {}) => {
    const capped = sanitizeMessages(next);
    messagesRef.current = capped;
    update({ codexMessages: capped, ...extra });
  }, [update]);

  const setArtifacts = useCallback((next: CodexAgentArtifact[], extra: Record<string, any> = {}) => {
    const capped = filterDeletedArtifacts(sanitizeArtifacts(next), deletedArtifactKeysRef.current).slice(-MAX_ARTIFACTS);
    artifactsRef.current = capped;
    update({ codexArtifacts: capped, ...extra });
  }, [update]);

  const setVersions = useCallback((next: CodexVersionEntry[], extra: Record<string, any> = {}) => {
    const capped = next.slice(-MAX_VERSIONS);
    versionsRef.current = capped;
    update({ codexVersions: capped, ...extra });
  }, [update]);

  const addArtifact = useCallback((artifact: CodexAgentArtifact) => {
    const prepared = normalizeArtifact(artifact);
    if (!prepared) return null;
    const stored: CodexAgentArtifact = { ...prepared, id: String(prepared.id || makeId('codex-artifact')) };
    if (artifactMatchesDeletedKeys(stored, deletedArtifactKeysRef.current)) return null;
    const artifactId = stored.id || makeId('codex-artifact');
    const existing = artifactsRef.current.find((item) => item.id === artifactId);
    const nextArtifacts = existing
      ? artifactsRef.current.map((item) => item.id === artifactId ? { ...item, ...stored } : item)
      : [...artifactsRef.current, stored];
    setArtifacts(nextArtifacts, { lastArtifactId: artifactId, codexLastRunSummary: `${artifactKindLabel(stored.kind)} 已生成` });
    if (!versionsRef.current.some((item) => item.artifactId === artifactId)) {
      setVersions([
        ...versionsRef.current,
        {
          id: makeId('codex-version'),
          artifactId,
          title: stored.title || artifactKindLabel(stored.kind),
          kind: stored.kind as CodexArtifactKind,
          parentId: String(d.lastPublishedArtifactId || '') || undefined,
          createdAt: stored.createdAt || Date.now(),
        },
      ]);
    }
    return stored;
  }, [d.lastPublishedArtifactId, setArtifacts, setVersions]);

  const copyCodexMessage = useCallback((value: string) => {
    const textValue = String(value || '').trim();
    if (!textValue) return;
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (!clipboard?.writeText) {
      logBus.warn('当前环境不支持直接复制，请手动选择文字。', `codex:${id}`);
      return;
    }
    void clipboard.writeText(textValue)
      .then(() => logBus.success('已复制对话文字', `codex:${id}`))
      .catch((error: any) => logBus.error(error?.message || '复制失败', `codex:${id}`));
  }, [id]);

  const copyCodexSetupCommand = useCallback((value: string, label: string) => {
    const textValue = String(value || '').trim();
    if (!textValue) return;
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (!clipboard?.writeText) {
      const message = '当前环境不支持直接复制，请手动选中命令复制。';
      update({ codexLastRunSummary: message });
      logBus.warn(message, `codex:${id}`);
      return;
    }
    void clipboard.writeText(textValue)
      .then(() => {
        const message = `已复制${label}：${textValue}`;
        update({ codexLastRunSummary: message });
        logBus.success(message, `codex:${id}`);
      })
      .catch((error: any) => {
        const message = error?.message || `${label}复制失败，请手动选中命令复制。`;
        update({ codexLastRunSummary: message });
        logBus.error(message, `codex:${id}`);
      });
  }, [id, update]);

  const publishArtifact = useCallback((artifact: CodexAgentArtifact | null | undefined) => {
    const prepared = artifact ? normalizeArtifact(artifact) : null;
    if (!prepared) return;
    const urls = prepared.urls?.length ? prepared.urls : (prepared.url ? [prepared.url] : []);
    const patch: Record<string, any> = {
      status: 'success',
      error: '',
      lastArtifactId: prepared.id,
      lastPublishedArtifactId: prepared.id,
      codexLastRunSummary: `${artifactKindLabel(prepared.kind)} 已发布到画布输出`,
      outputText: '',
      prompt: '',
      lastPrompt: '',
      text: '',
      reply: '',
      textSegments: [],
      segments: [],
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
      modelUrl: '',
      modelUrls: [],
      directModelUrl: '',
      directModelUrls: [],
    };
    if (prepared.kind === 'text') {
      const value = String(prepared.text || '').trim();
      patch.outputText = value;
      patch.text = value;
      patch.reply = value;
    } else if (prepared.kind === 'image') {
      patch.imageUrl = urls[0] || '';
      patch.imageUrls = urls;
    } else if (prepared.kind === 'video') {
      patch.videoUrl = urls[0] || '';
      patch.videoUrls = urls;
    } else if (prepared.kind === 'audio') {
      patch.audioUrl = urls[0] || '';
      patch.audioUrls = urls;
    } else if (prepared.kind === 'model3d') {
      patch.modelUrl = urls[0] || '';
      patch.modelUrls = urls;
    }
    update(patch);
    logBus.info(`Codex ${artifactKindLabel(prepared.kind)} 已发布`, `codex:${id}`);
  }, [id, update]);

  const invalidateSkillRefreshes = useCallback(() => {
    skillRefreshRequestRef.current += 1;
  }, []);

  const refreshStatusAndSkills = useCallback(async () => {
    const refreshRequestId = ++skillRefreshRequestRef.current;
    try {
      const [nextStatus, skillData] = await Promise.all([
        getCodexCliStatus(String(d.codexExecutablePath || '').trim() || undefined).catch((error) => ({
          available: false,
          message: error?.message || 'Codex CLI 状态检查失败',
        })),
        getCodexCliSkills({ nodeId: id, sessionId, workspaceDir: String(d.codexWorkspaceDir || '').trim() }).catch(() => ({ workspaceDir: '', skills: [] as CodexSkill[] })),
      ]);
      if (refreshRequestId !== skillRefreshRequestRef.current) return;
      setStatus(nextStatus as CodexCliStatus);
      setSkills(skillData.skills || []);
      const nextWorkspaceDir = skillData.workspaceDir || d.codexWorkspaceDir || '';
      const patch: Record<string, any> = {};
      if (nextWorkspaceDir !== String(d.codexWorkspaceDir || '').trim()) patch.codexWorkspaceDir = nextWorkspaceDir;
      if ((nextStatus as CodexCliStatus).available && clearRecoverableCodexError(d.error)) {
        patch.error = '';
      }
      if (Object.keys(patch).length > 0) update(patch);
    } catch (error: any) {
      if (refreshRequestId !== skillRefreshRequestRef.current) return;
      setStatus({ available: false, message: error?.message || 'Codex CLI 状态检查失败' });
    }
  }, [d.codexExecutablePath, d.codexWorkspaceDir, d.error, id, sessionId, update]);

  useEffect(() => {
    void refreshStatusAndSkills();
  }, [refreshStatusAndSkills]);

  const openCodexLogin = useCallback(async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    const openingMessage = '正在打开 Codex 登录窗口；如果没有弹出窗口，请复制 codex login 到 CMD 或 PowerShell 手动运行。';
    setStatus((previous) => ({ ...(previous || { available: false }), available: false, message: openingMessage }));
    update({ error: '', codexLastRunSummary: openingMessage });
    try {
      const result = await startCodexCliLogin({
        executablePath: String(d.codexExecutablePath || '').trim() || undefined,
      });
      const message = [
        result.message || '已打开 Codex CLI 登录流程。',
        result.command ? `命令：${result.command}` : '',
        '完成登录后请回到节点点击“刷新”。',
      ].filter(Boolean).join(' ');
      setStatus((previous) => ({
        ...(previous || { available: false }),
        available: false,
        executable: result.executable || previous?.executable,
        message,
      }));
      update({ error: '', codexLastRunSummary: message });
      logBus.info(message, `codex:${id}`);
      setTimeout(() => void refreshStatusAndSkills(), 1600);
    } catch (error: any) {
      const message = friendlyCodexErrorMessage(error?.message || '打开 Codex 登录失败');
      setStatus({ available: false, message });
      update({ error: message });
      logBus.error(message, `codex:${id}`);
    } finally {
      setLoginBusy(false);
    }
  }, [d.codexExecutablePath, id, loginBusy, refreshStatusAndSkills, update]);

  const toggleSkill = useCallback((name: string) => {
    const next = selectedRunnableSkillNames.includes(name)
      ? selectedRunnableSkillNames.filter((item) => item !== name)
      : [...selectedRunnableSkillNames, name];
    update({ codexSelectedSkillNames: next });
  }, [selectedRunnableSkillNames, update]);

  const openSkillPicker = useCallback((
    modeToOpen: CodexSkillPickerMode,
    target?: HTMLElement | null,
    query = '',
    slashRange: { start: number; end: number } | null = null,
  ) => {
    const rect = target?.getBoundingClientRect();
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
    const width = Math.min(Math.max(rect?.width || 360, 340), Math.min(560, viewportWidth - 24));
    const left = Math.min(Math.max(12, rect?.left || 24), Math.max(12, viewportWidth - width - 12));
    const top = Math.min(Math.max(12, (rect?.bottom ?? 120) + 8), Math.max(12, viewportHeight - 420));
    setSkillPickerMode(modeToOpen);
    setSkillSearchQuery(query);
    setSlashSkillRange(slashRange);
    setSkillPickerAnchor({ left, top, width });
    setSkillPickerOpen(true);
  }, []);

  const closeSkillPicker = useCallback(() => {
    setSkillPickerOpen(false);
    setSlashSkillRange(null);
  }, []);

  const openSkillPickerFromPrompt = useCallback((source: 'simple' | 'studio', promptText = quickPrompt) => {
    const match = trailingSlashSkillQuery(promptText);
    if (!match) return false;
    const target = source === 'studio' ? studioPromptFrameRef.current : simplePromptFrameRef.current;
    openSkillPicker('slash', target, match.query, { start: match.start, end: match.end });
    return true;
  }, [openSkillPicker, quickPrompt]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const active = document.activeElement as HTMLElement | null;
    const frame = active?.closest?.('[data-codex-prompt-frame-source]') as HTMLElement | null;
    if (!frame) return;
    const source = frame.dataset.codexPromptFrameSource === 'studio' ? 'studio' : 'simple';
    const opened = openSkillPickerFromPrompt(source, quickPrompt);
    if (!opened && skillPickerMode === 'slash') closeSkillPicker();
  }, [closeSkillPicker, openSkillPickerFromPrompt, quickPrompt, skillPickerMode]);

  useEffect(() => {
    if (!skillPickerOpen || typeof document === 'undefined') return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest?.('[data-codex-skill-picker-portal]') ||
        target?.closest?.('[data-codex-skill-trigger]') ||
        target?.closest?.('[data-codex-prompt-frame-source]')
      ) {
        return;
      }
      closeSkillPicker();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [closeSkillPicker, skillPickerOpen]);

  const chooseSkillFromPicker = useCallback((skill: CodexSkill) => {
    if (skillPickerMode === 'slash' && slashSkillRange) {
      const replacement = `/${skill.name} `;
      const nextPrompt = `${quickPrompt.slice(0, slashSkillRange.start)}${replacement}${quickPrompt.slice(slashSkillRange.end)}`;
      const nextMentions = shiftMentionsForTextReplacement(quickPromptMentions, slashSkillRange, replacement);
      update({
        codexQuickPrompt: nextPrompt,
        codexQuickPromptMentions: nextMentions,
      });
      closeSkillPicker();
      return;
    }
    toggleSkill(skill.name);
  }, [closeSkillPicker, quickPrompt, quickPromptMentions, skillPickerMode, slashSkillRange, toggleSkill, update]);

  const clearProjectSkillDraft = useCallback(() => {
    setEditingSkillName('');
    setSkillDraftName('creator-note');
    setSkillDraftCategory(DEFAULT_CREATOR_CATEGORY);
    setSkillDraftBody('# 创作者 Skill\n\n用于记录当前项目的风格、禁忌和交付标准。');
  }, []);

  const editProjectSkill = useCallback((skill: CodexSkill) => {
    setEditingSkillName(skill.name);
    setSkillDraftName(skill.name);
    setSkillDraftCategory(sanitizeCreatorCategory(skill.category));
    setSkillDraftBody(String(skill.body || skill.description || '# 项目 Skill\n\n').trim());
  }, []);

  const saveProjectSkill = useCallback(async () => {
    const name = skillDraftName.trim();
    if (!name) {
      logBus.warn('请先填写 Skill 名称', `codex:${id}`);
      return;
    }
    invalidateSkillRefreshes();
    try {
      const payload = {
        nodeId: id,
        sessionId,
        workspaceDir: String(d.codexWorkspaceDir || '').trim(),
        name,
        title: name,
        description: '当前画布项目专用创作者 Skill',
        category: sanitizeCreatorCategory(skillDraftCategory),
        body: skillDraftBody,
      };
      const result = editingSkillName
        ? await updateCodexProjectSkill({ ...payload, oldName: editingSkillName })
        : await createCodexProjectSkill(payload);
      invalidateSkillRefreshes();
      setSkills((prev) => {
        const next = prev.filter((item) => item.name !== result.skill.name && item.name !== editingSkillName);
        return [...next, result.skill];
      });
      const nextSelected = Array.from(new Set([
        ...selectedRunnableSkillNames.filter((item) => item !== editingSkillName),
        result.skill.name,
      ]));
      update({ codexSelectedSkillNames: nextSelected, codexWorkspaceDir: result.workspaceDir });
      setEditingSkillName(result.skill.name);
      setSkillDraftName(result.skill.name);
      setSkillDraftCategory(sanitizeCreatorCategory(result.skill.category));
      logBus.success(`${editingSkillName ? '已保存' : '已创建'}项目 Skill：${result.skill.name}`, `codex:${id}`);
    } catch (error: any) {
      logBus.error(error?.message || '保存项目 Skill 失败', `codex:${id}`);
    }
  }, [d.codexWorkspaceDir, editingSkillName, id, invalidateSkillRefreshes, selectedRunnableSkillNames, sessionId, skillDraftBody, skillDraftCategory, skillDraftName, update]);

  const deleteProjectSkill = useCallback(async (skill: CodexSkill) => {
    if (typeof window !== 'undefined' && !window.confirm(`删除项目 Skill「${skill.name}」？`)) return;
    invalidateSkillRefreshes();
    try {
      const result = await deleteCodexProjectSkill({
        nodeId: id,
        sessionId,
        workspaceDir: String(d.codexWorkspaceDir || '').trim(),
        name: skill.name,
      });
      invalidateSkillRefreshes();
      setSkills((prev) => prev.filter((item) => item.name !== skill.name));
      update({
        codexSelectedSkillNames: selectedRunnableSkillNames.filter((item) => item !== skill.name),
        codexWorkspaceDir: result.workspaceDir || d.codexWorkspaceDir || '',
      });
      if (editingSkillName === skill.name) clearProjectSkillDraft();
      logBus.success(`已删除项目 Skill：${skill.name}`, `codex:${id}`);
    } catch (error: any) {
      logBus.error(error?.message || '删除项目 Skill 失败', `codex:${id}`);
    }
  }, [clearProjectSkillDraft, d.codexWorkspaceDir, editingSkillName, id, invalidateSkillRefreshes, selectedRunnableSkillNames, sessionId, update]);

  const exportProjectSkills = useCallback(() => {
    downloadJsonFile(`codex-project-skills-${new Date().toISOString().slice(0, 10)}.json`, {
      schema: 't8-codex-project-skills',
      version: 1,
      exportedAt: new Date().toISOString(),
      workspaceDir: String(d.codexWorkspaceDir || ''),
      skills: projectSkills.map((skill) => ({
        name: skill.name,
        category: sanitizeCreatorCategory(skill.category),
        description: skill.description || '当前画布项目专用创作者 Skill',
        body: String(skill.body || skill.description || '').trim(),
      })),
    });
  }, [d.codexWorkspaceDir, projectSkills]);

  const importProjectSkills = useCallback(async (file?: File | null) => {
    if (!file) return;
    try {
      const imported = importedProjectSkills(await readJsonFile(file));
      if (imported.length === 0) {
        logBus.warn('没有识别到可导入的项目 Skill', `codex:${id}`);
        return;
      }
      invalidateSkillRefreshes();
      let workspaceDir = String(d.codexWorkspaceDir || '').trim();
      const knownNames = new Set(projectSkills.map((skill) => skill.name));
      const savedSkills: CodexSkill[] = [];
      for (const skill of imported) {
        const payload = {
          nodeId: id,
          sessionId,
          workspaceDir,
          name: skill.name,
          title: skill.name,
          description: skill.description || '当前画布项目专用创作者 Skill',
          category: skill.category,
          body: skill.body,
        };
        const result = knownNames.has(skill.name)
          ? await updateCodexProjectSkill({ ...payload, oldName: skill.name })
          : await createCodexProjectSkill(payload);
        workspaceDir = result.workspaceDir || workspaceDir;
        savedSkills.push(result.skill);
      }
      invalidateSkillRefreshes();
      setSkills((prev) => {
        const byName = new Map(prev.map((skill) => [skill.name, skill]));
        savedSkills.forEach((skill) => byName.set(skill.name, skill));
        return Array.from(byName.values());
      });
      update({ codexWorkspaceDir: workspaceDir });
      setProjectSkillCategoryFilter(sanitizeCreatorCategory(savedSkills[0]?.category));
      logBus.success(`已导入 ${savedSkills.length} 个项目 Skill`, `codex:${id}`);
    } catch (error: any) {
      logBus.error(error?.message || '导入项目 Skill 失败', `codex:${id}`);
    }
  }, [d.codexWorkspaceDir, id, invalidateSkillRefreshes, projectSkills, sessionId, update]);

  const snapshotActiveStudioSession = useCallback((): CodexStudioSession => {
    const current: CodexStudioSession = {
      id: activeStudioSessionId,
      title: deriveSessionTitle(messagesRef.current, '当前会话'),
      updatedAt: Date.now(),
      messageCount: messagesRef.current.length,
      artifactCount: artifactsRef.current.length,
      messages: messagesRef.current,
      artifacts: artifactsRef.current,
      versions: versionsRef.current,
      contextSummary: codexContextSummaryRef.current,
      contextCompressedCount: codexContextCompressedCountRef.current,
      contextLimit: codexContextLimitRef.current,
    };
    return compactCodexStudioSessionForCanvas(current);
  }, [activeStudioSessionId]);

  const newCodexStudioSession = useCallback(() => {
    const current = snapshotActiveStudioSession();
    const nextId = makeId('codex-session');
    const nextSession: CodexStudioSession = {
      id: nextId,
      title: '新会话',
      updatedAt: Date.now(),
      messageCount: 0,
      artifactCount: 0,
      messages: [],
      artifacts: [],
      versions: [],
      contextSummary: '',
      contextCompressedCount: 0,
      contextLimit: codexContextLimitRef.current,
    };
    messagesRef.current = [];
    artifactsRef.current = [];
    versionsRef.current = [];
    codexContextSummaryRef.current = '';
    codexContextCompressedCountRef.current = 0;
    update({
      codexStudioSessions: compactCodexStudioSessionsForCanvas([current, nextSession, ...codexStudioSessions.filter((item) => item.id !== current.id)]),
      codexActiveStudioSessionId: nextId,
      codexMessages: [],
      codexArtifacts: [],
      codexVersions: [],
      codexContextSummary: '',
      codexContextCompressedCount: 0,
      codexContextLimit: codexContextLimitRef.current,
      lastArtifactId: '',
      lastPublishedArtifactId: '',
      status: 'idle',
      error: '',
      codexLastRunSummary: '新会话已创建',
    });
  }, [codexStudioSessions, snapshotActiveStudioSession, update]);

  const createNewCodexWorkspace = useCallback(() => {
    const nextSessionId = makeId('codex-workspace');
    invalidateSkillRefreshes();
    setSkills([]);
    update({
      codexSessionId: nextSessionId,
      codexWorkspaceDir: '',
      codexLastRunSummary: '已准备新工作区，下次运行会自动创建并复用。',
      error: '',
    });
  }, [invalidateSkillRefreshes, update]);

  const archiveCodexStudioSessions = useCallback(() => {
    const current = snapshotActiveStudioSession();
    const archivedCount = Math.max(0, codexStudioSessions.length - 1);
    update({
      codexStudioSessions: [compactCodexStudioSessionForCanvas(current)],
      codexActiveStudioSessionId: current.id,
      codexArchivedSessionCount: Number(d.codexArchivedSessionCount || 0) + archivedCount,
      codexLastRunSummary: archivedCount > 0 ? `已归档 ${archivedCount} 个旧会话` : '没有需要归档的旧会话',
    });
  }, [codexStudioSessions.length, d.codexArchivedSessionCount, snapshotActiveStudioSession, update]);

  const switchCodexStudioSession = useCallback((sessionIdToOpen: string) => {
    const targetId = String(sessionIdToOpen || '').trim();
    if (!targetId || targetId === activeStudioSessionId) return;
    const current = snapshotActiveStudioSession();
    const savedSessions = compactCodexStudioSessionsForCanvas([current, ...codexStudioSessions.filter((item) => item.id !== current.id)]);
    const target = savedSessions.find((item) => item.id === targetId);
    if (!target) return;
    const nextMessages = sanitizeMessages(target.messages);
    const nextArtifacts = filterDeletedArtifacts(sanitizeArtifacts(target.artifacts), deletedArtifactKeysRef.current);
    const nextArtifactIds = new Set(nextArtifacts.map((artifact) => artifact.id));
    const nextVersions = sanitizeVersions(target.versions).filter((version) => nextArtifactIds.has(version.artifactId));
    const nextContextSummary = String(target.contextSummary || '').trim();
    const nextContextCompressedCount = clampInteger(target.contextCompressedCount, 0, 0, MAX_MESSAGES);
    const nextContextLimit = clampInteger(target.contextLimit, CODEX_STUDIO_CONTEXT_DEFAULT_LIMIT, 0, CODEX_STUDIO_CONTEXT_MAX_LIMIT);
    messagesRef.current = nextMessages;
    artifactsRef.current = nextArtifacts;
    versionsRef.current = nextVersions;
    codexContextSummaryRef.current = nextContextSummary;
    codexContextCompressedCountRef.current = nextContextCompressedCount;
    codexContextLimitRef.current = nextContextLimit;
    update({
      codexStudioSessions: compactCodexStudioSessionsForCanvas(savedSessions.map((item) => item.id === targetId
        ? { ...target, messages: nextMessages, artifacts: nextArtifacts, versions: nextVersions, contextSummary: nextContextSummary, contextCompressedCount: nextContextCompressedCount, contextLimit: nextContextLimit }
        : item)),
      codexActiveStudioSessionId: targetId,
      codexMessages: nextMessages,
      codexArtifacts: nextArtifacts,
      codexVersions: nextVersions,
      codexContextSummary: nextContextSummary,
      codexContextCompressedCount: nextContextCompressedCount,
      codexContextLimit: nextContextLimit,
      lastArtifactId: nextArtifacts[nextArtifacts.length - 1]?.id || '',
      status: 'idle',
      error: '',
      codexLastRunSummary: `已切换会话：${target.title}`,
    });
  }, [activeStudioSessionId, codexStudioSessions, snapshotActiveStudioSession, update]);

  const codexStopRunning = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const nextMessages = messagesRef.current.map((item) => (
      item.status === 'running' && item.role === 'assistant'
        ? { ...item, content: item.content || 'Codex 任务已停止', status: 'error' as const }
        : item
    ));
    setMessages(nextMessages, { status: 'idle', error: '', codexLastRunSummary: 'Codex 任务已停止' });
    setStreamingReply('');
    logBus.warn('Codex 任务已停止', `codex:${id}`);
  }, [id, setMessages]);

  const handleQuickRun = useCallback(async () => {
    if (isBusy) return;
    const prompt = buildPrompt(quickPrompt, orderedTexts, quickPromptMentions, mentionMaterials);
    const imagesForRun = materialUrls(orderedImages);
    const videosForRun = materialUrls(orderedVideos);
    const audiosForRun = materialUrls(orderedAudios);
    const promptForRun = prompt || buildImageOnlyPrompt(imagesForRun, videosForRun, audiosForRun, currentPreset);
    const hasRunnableInput = Boolean(promptForRun || imagesForRun.length || videosForRun.length || audiosForRun.length);
    if (!hasRunnableInput) {
      logBus.warn('请填写任务，或连接上游图片/视频/音频素材。', `codex:${id}`);
      return;
    }
    const runIntent: CodexRunIntent = codexRunIntent;
    const slashSkillNames = extractSlashSkillReferences(quickPrompt, creatorSkills);
    const rawSkillNamesForRun = Array.from(new Set([...selectedRunnableSkillNames, ...slashSkillNames]));
    const selectedSkillNamesForRun = runIntent === 'llm'
      ? rawSkillNamesForRun.filter((name) => !isImageGenerationSkillName(name))
      : rawSkillNamesForRun;
    const intentPreset = hasActiveCreatorPreset
      ? currentPreset
      : runIntent === 'img'
        ? IMAGE_GENERATION_FALLBACK_PRESET
        : DEFAULT_CREATOR_PRESET;
    const forceImageGeneration = shouldForceImageGeneration(promptForRun, intentPreset, selectedSkillNamesForRun, runIntent);
    const runPreset = hasActiveCreatorPreset
      ? currentPreset
      : forceImageGeneration
        ? IMAGE_GENERATION_FALLBACK_PRESET
        : DEFAULT_CREATOR_PRESET;
    const presetInstruction = hasActiveCreatorPreset
      ? buildPresetInstructionBlock(runPreset, forceImageGeneration)
      : runPreset.systemHint;
    const runMode = forceImageGeneration ? 'image' : runPreset.mode;
    const studioMemory = studioOpen ? buildCodexStudioMemoryContext(messagesRef.current, {
      contextLimit: codexContextLimit,
      summary: codexContextSummary,
      compressedCount: codexContextCompressedCount,
    }) : null;
    const studioMemoryPrompt = studioMemory ? buildCodexStudioMemoryPrompt(studioMemory) : '';

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const turnId = makeId('codex-turn');
    const userMsg: CodexAgentMessage = {
      id: makeId('codex-user'),
      turnId,
      role: 'user',
      content: promptForRun,
      mode: runMode,
      status: 'success',
      createdAt: Date.now(),
    };
    const assistantMsg: CodexAgentMessage = {
      id: makeId('codex-assistant'),
      turnId,
      role: 'assistant',
      content: '',
      mode: runMode,
      status: 'running',
      createdAt: Date.now(),
    };
    setStreamingReply('');
    setMessages([...messagesRef.current, userMsg, assistantMsg], { status: 'running', error: '' });
    const startPatch: Record<string, any> = {
      status: 'running',
      error: '',
      codexMode: runMode,
      codexPresetId: hasActiveCreatorPreset ? runPreset.id : NO_CREATOR_PRESET_ID,
      codexPreset: hasActiveCreatorPreset ? runPreset.label : '',
      codexSelectedSkillNames: selectedSkillNamesForRun,
    };
    if (runIntent === 'img' && defaultImageGenerationSkill && selectedSkillNamesForRun.includes(defaultImageGenerationSkill.name)) {
      startPatch.codexAutoImagegenSkillName = defaultImageGenerationSkill.name;
    }
    if (studioMemory) {
      codexContextSummaryRef.current = studioMemory.summary;
      codexContextCompressedCountRef.current = studioMemory.compressedCount;
      codexContextLimitRef.current = studioMemory.contextLimit;
      startPatch.codexContextSummary = studioMemory.summary;
      startPatch.codexContextCompressedCount = studioMemory.compressedCount;
      startPatch.codexContextLimit = studioMemory.contextLimit;
    }
    const shouldClearPromptAfterRun = studioOpen && !persistPrompt;
    const shouldClearPromptMentionsAfterRun = studioOpen && (!persistPrompt || !persistMaterials);
    if (studioOpen) startPatch.codexRunIntent = codexRunIntent;
    if (shouldClearPromptAfterRun) startPatch.codexQuickPrompt = '';
    if (shouldClearPromptMentionsAfterRun) startPatch.codexQuickPromptMentions = [];
    update(startPatch);
    taskCompletionSound.primeAudio();

    const replaceAssistant = (content: string, status: CodexAgentMessage['status'] = 'running') => {
      setMessages(
        messagesRef.current.map((item) => item.id === assistantMsg.id ? { ...item, content, status } : item),
      );
    };

    const appendToolMessage = (content: string) => {
      setMessages([
        ...messagesRef.current,
        {
          id: makeId('codex-tool'),
          turnId,
          role: 'tool',
          content,
          mode: runMode,
          status: 'success',
          createdAt: Date.now(),
        },
      ]);
    };

    try {
      const creatorBrief = buildCreatorBriefBlock(d);
      let streamedText = '';
      const result = await streamCodexCliAgent({
        nodeId: id,
        sessionId,
        turnId,
        mode: runMode,
        command: runPreset.command,
        preset: hasActiveCreatorPreset ? runPreset.label : '',
        prompt: [
          presetInstruction,
          runIntent === 'llm' ? '本轮为 LLM 文字模式：即使连接了参考图片，也只能分析、回答、整理提示词或给出创作方案；不要生成图片文件，不要调用 image_generation。' : '',
          forceImageGeneration ? '本轮为 IMG 生图模式：优先直接生成图片产物，不要只输出提示词文本。' : '',
          studioMemoryPrompt,
          creatorBrief,
          promptForRun,
        ].filter(Boolean).join('\n\n'),
        referenceTexts: orderedTexts.map((item) => item.url).filter(Boolean),
        images: imagesForRun,
        videos: videosForRun,
        audios: audiosForRun,
        selectedSkillNames: selectedSkillNamesForRun,
        imageGeneration: forceImageGeneration,
        llmOnly: runIntent === 'llm',
        workspaceDir: String(d.codexWorkspaceDir || '').trim(),
        model: selectedCodexModel,
        profile: String(d.codexProfile || '').trim(),
        sandbox: settingsValue(d.codexSandbox, 'workspace-write'),
        approvalPolicy: settingsValue(d.codexApprovalPolicy, 'never'),
        reasoningEffort: String(d.codexReasoningEffort || '').trim(),
        webSearch: d.codexWebSearch === true,
        includePlanTool: d.codexIncludePlanTool === true,
        executablePath: String(d.codexExecutablePath || '').trim(),
        extraArgs: parseExtraArgs(d.codexExtraArgs),
      }, {
        signal: controller.signal,
        onDelta: (delta) => {
          streamedText += delta;
          setStreamingReply(streamedText);
        },
        onEvent: (event: CodexStreamEvent) => {
          if (event.type === 'tool.progress' || event.event === 'tool.progress') {
            const msg = String(event.message || event.text || '').trim();
            if (shouldDisplayCodexToolMessage(event, msg)) appendToolMessage(msg);
          }
          if (event.artifact) addArtifact({ ...event.artifact, turnId });
        },
      });

      const nextArtifacts: CodexAgentArtifact[] = [];
      if (Array.isArray(result.artifacts)) {
        for (const artifact of result.artifacts) {
          const added = addArtifact({ ...artifact, turnId });
          if (added) nextArtifacts.push(added);
        }
      }
      const finalText = String(result.text || result.reply || streamedText || '').trim();
      if (finalText) {
        replaceAssistant(finalText, 'success');
        const runArtifactsForStore = nextArtifacts.length
          ? nextArtifacts
          : artifactsRef.current.filter((artifact) => artifact.turnId === turnId);
        if (shouldStoreTextArtifact(finalText, runPreset, runArtifactsForStore)) {
          const textArtifact = addArtifact({
            id: makeId('codex-text'),
            kind: 'text',
            title: `${runPreset.label} · 文本`,
            text: finalText,
            turnId,
            status: 'completed',
            progress: 100,
            createdAt: Date.now(),
          });
          if (textArtifact) nextArtifacts.push(textArtifact);
        }
      } else {
        replaceAssistant('Codex 已完成任务，但没有返回文本。请查看产物库或运行日志。', 'success');
      }
      const runArtifactsForPublish = nextArtifacts.length
        ? nextArtifacts
        : artifactsRef.current.filter((artifact) => artifact.turnId === turnId);
      const latest = runArtifactsForPublish[runArtifactsForPublish.length - 1] || artifactsRef.current[artifactsRef.current.length - 1];
      const autoPublishArtifact = selectAutoPublishArtifact(runArtifactsForPublish, runIntent, latest);
      if (autoPublishArtifact && autoPublishOutput) publishArtifact(autoPublishArtifact);
      const finishPatch: Record<string, any> = {};
      if (shouldClearPromptAfterRun) finishPatch.codexQuickPrompt = '';
      if (shouldClearPromptMentionsAfterRun) finishPatch.codexQuickPromptMentions = [];
      if (studioOpen && !persistMaterials) {
        const consumedIds = materialIds([
          ...orderedInputTexts,
          ...orderedImages,
          ...orderedVideos,
          ...orderedAudios,
        ]);
        finishPatch.codexStudioConsumedMaterialIds = mergeMaterialIds(studioConsumedMaterialIds, consumedIds);
        finishPatch.materialOrder = materialOrder.filter((itemId: string) => !consumedIds.includes(itemId));
      }
      update({
        status: 'success',
        error: '',
        codexLastRunSummary: (autoPublishArtifact || latest)
          ? `${artifactKindLabel((autoPublishArtifact || latest)!.kind)} 已生成${autoPublishOutput ? '，已发布到画布输出' : '，可手动发布'}`
          : 'Codex 任务完成',
        ...finishPatch,
      });
      taskCompletionSound.notifyComplete(id, 'codex-cli-agent');
    } catch (error: any) {
      const stopped = error?.name === 'AbortError' || /Codex 任务已停止|aborted/i.test(String(error?.message || ''));
      const message = stopped ? 'Codex 任务已停止' : friendlyCodexErrorMessage(error?.message || 'Codex CLI 运行失败');
      replaceAssistant(message, 'error');
      update({ status: stopped ? 'idle' : 'error', error: stopped ? '' : message, codexLastRunSummary: message });
      if (stopped) logBus.warn(message, `codex:${id}`);
      else logBus.error(message, `codex:${id}`);
    } finally {
      abortRef.current = null;
    }
  }, [
    addArtifact,
    allCreatorPresets,
    creatorSkills,
    currentPreset,
    defaultImageGenerationSkill,
    d.codexApprovalPolicy,
    d.codexAspectRatio,
    d.codexAutoNegativePrompt,
    d.codexBatchVariantCount,
    d.codexBriefCamera,
    d.codexBriefComposition,
    d.codexBriefLighting,
    d.codexBriefStyle,
    d.codexBriefSubject,
    d.codexExecutablePath,
    d.codexExtraArgs,
    d.codexIncludePlanTool,
    d.codexModel,
    d.codexModelMode,
    d.codexNegativePrompt,
    d.codexProfile,
    d.codexReasoningEffort,
    d.codexSandbox,
    d.codexStyleLock,
    d.codexTargetPlatform,
    d.codexWebSearch,
    d.codexWorkspaceDir,
    hasActiveCreatorPreset,
    id,
    isBusy,
    loginBusy,
    mentionMaterials,
    orderedAudios,
    orderedImages,
    orderedInputTexts,
    orderedTexts,
    orderedVideos,
    persistPrompt,
    autoPublishOutput,
    persistMaterials,
    publishArtifact,
    quickPrompt,
    quickPromptMentions,
    codexRunIntent,
    codexContextCompressedCount,
    codexContextLimit,
    codexContextSummary,
    selectedRunnableSkillNames,
    selectedCodexModel,
    sessionId,
    setMessages,
    studioConsumedMaterialIds,
    studioOpen,
    materialOrder,
    update,
  ]);

  useRunTrigger(id, handleQuickRun, 'codex-cli-agent');

  const latestArtifact = artifacts.find((item) => item.id === d.lastArtifactId) || artifacts[artifacts.length - 1] || null;
  const rawStatusMessage = status?.available
    ? (status.version ? `Codex ${status.version}` : 'Codex CLI 可用')
    : (status?.message || '正在检查 Codex CLI');
  const routeMissing = isRouteMissingMessage(rawStatusMessage);
  const statusLineMessage = status?.available
    ? rawStatusMessage
    : routeMissing
      ? '后端路由未加载'
      : '需要登录或填写 Codex CLI 路径';
  const statusDetailMessage = !status?.available && !routeMissing && status?.message
    ? status.message
    : '';
  const clearTemplateDraft = useCallback(() => {
    setEditingPresetId('');
    update({
      codexPresetDraftTitle: '',
      codexPresetDraftHint: '',
      codexPresetDraftPrompt: '',
      codexPresetDraftMode: 'prompt',
      codexPresetDraftCategory: DEFAULT_CREATOR_CATEGORY,
    });
  }, [update]);

  const editCustomPreset = useCallback((preset: CreatorPreset) => {
    setEditingPresetId(preset.id);
    update({
      codexPresetDraftTitle: preset.label,
      codexPresetDraftHint: preset.hint,
      codexPresetDraftPrompt: preset.systemHint,
      codexPresetDraftMode: preset.mode,
      codexPresetDraftCategory: sanitizeCreatorCategory(preset.category),
    });
  }, [update]);

  const deleteCustomPreset = useCallback((presetId: string) => {
    const target = customPresets.find((preset) => preset.id === presetId);
    if (!target) return;
    if (typeof window !== 'undefined' && !window.confirm(`删除模板「${target.label}」？`)) return;
    const next = customPresets.filter((preset) => preset.id !== presetId);
    update({
      codexUserPresets: next.map(({ icon, ...item }) => item),
      codexPresetId: currentPreset.id === presetId ? (next[0]?.id || '') : d.codexPresetId,
      codexMode: currentPreset.id === presetId ? (next[0]?.mode || 'prompt') : d.codexMode,
      codexPreset: currentPreset.id === presetId ? (next[0]?.label || '') : d.codexPreset,
    });
    if (editingPresetId === presetId) clearTemplateDraft();
    logBus.success(`已删除 Codex 创作模板：${target.label}`, `codex:${id}`);
  }, [clearTemplateDraft, currentPreset.id, customPresets, d.codexMode, d.codexPreset, d.codexPresetId, editingPresetId, id, update]);

  const saveCustomPreset = useCallback(() => {
    const label = String(d.codexPresetDraftTitle || '').trim();
    const hint = String(d.codexPresetDraftHint || '').trim();
    const systemHint = String(d.codexPresetDraftPrompt || '').trim();
    const category = sanitizeCreatorCategory(d.codexPresetDraftCategory);
    const draftMode = ['chat', 'prompt', 'image', 'storyboard', 'character', 'product', 'quality'].includes(d.codexPresetDraftMode)
      ? d.codexPresetDraftMode as CodexAgentMode
      : 'prompt';
    if (!label || !systemHint) {
      logBus.warn('请先填写模板名称和模板指令', `codex:${id}`);
      return;
    }
    const nextPreset: CreatorPreset = {
      id: editingPresetId || `user-${Date.now().toString(36)}-${label}`.replace(/\s+/g, '-').slice(0, 64),
      mode: draftMode,
      label,
      command: '/custom',
      icon: Wand2,
      hint: hint || '用户自定义创作模板',
      systemHint,
      category,
      custom: true,
    };
    const next = editingPresetId
      ? customPresets.map((preset) => preset.id === editingPresetId ? nextPreset : preset)
      : [nextPreset, ...customPresets].slice(0, 24);
    update({
      codexUserPresets: next.map(({ icon, ...item }) => item),
      codexPresetId: nextPreset.id,
      codexMode: nextPreset.mode,
      codexPreset: nextPreset.label,
      codexPresetDraftTitle: label,
      codexPresetDraftHint: hint,
      codexPresetDraftPrompt: systemHint,
      codexPresetDraftMode: draftMode,
      codexPresetDraftCategory: category,
    });
    setEditingPresetId(nextPreset.id);
    setCodexTemplateCategoryFilter(category);
    logBus.success(`${editingPresetId ? '已保存' : '已新增'} Codex 创作模板：${nextPreset.label}`, `codex:${id}`);
  }, [customPresets, d.codexPresetDraftCategory, d.codexPresetDraftHint, d.codexPresetDraftMode, d.codexPresetDraftPrompt, d.codexPresetDraftTitle, editingPresetId, id, update]);

  const exportCustomPresets = useCallback(() => {
    downloadJsonFile(`codex-creator-templates-${new Date().toISOString().slice(0, 10)}.json`, {
      schema: 't8-codex-creator-templates',
      version: 1,
      exportedAt: new Date().toISOString(),
      templates: customPresets.map(creatorPresetPlain),
    });
  }, [customPresets]);

  const importCustomPresets = useCallback(async (file?: File | null) => {
    if (!file) return;
    try {
      const imported = importedCreatorPresets(await readJsonFile(file));
      if (imported.length === 0) {
        logBus.warn('没有识别到可导入的 Codex 模板', `codex:${id}`);
        return;
      }
      const importedKeys = new Set(imported.map((preset) => `${preset.id}::${preset.label}`));
      const next = [
        ...imported,
        ...customPresets.filter((preset) => !importedKeys.has(`${preset.id}::${preset.label}`)),
      ].slice(0, 24);
      const first = imported[0];
      update({
        codexUserPresets: next.map(creatorPresetPlain),
        codexPresetId: first.id,
        codexMode: first.mode,
        codexPreset: first.label,
      });
      setCodexTemplateCategoryFilter(sanitizeCreatorCategory(first.category));
      logBus.success(`已导入 ${imported.length} 个 Codex 模板`, `codex:${id}`);
    } catch (error: any) {
      logBus.error(error?.message || '导入 Codex 模板失败', `codex:${id}`);
    }
  }, [customPresets, id, update]);

  const codexStatusPanel = (
    <div className="rounded-xl border p-3" style={{ borderColor: routeMissing ? danger : border, background: surface }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-black">
          {status?.available ? <CheckCircle2 size={15} color="#22c55e" /> : <AlertCircle size={15} color={routeMissing ? danger : accent} />}
          <span>{status?.available ? 'Codex 已就绪' : routeMissing ? '后端路由未加载' : '登录 Codex CLI'}</span>
        </div>
        <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => void refreshStatusAndSkills()}>
          刷新
        </button>
      </div>
      <div className="text-[11px] leading-relaxed" style={{ color: subText }}>
        {routeMissing
          ? '当前前端已经加载 Codex 节点，但运行中的后端还没有 /api/codex-cli 路由。请重启后端服务或桌面应用后再刷新。'
          : status?.available
            ? '可以直接发送创作任务。若生成时提示未登录，请在终端执行登录命令后点刷新。'
            : '首次使用需要先在本机终端登录 Codex CLI。登录完成后回到节点点刷新。'}
      </div>
      <div className="mt-2 rounded-lg border px-2 py-1.5 text-[10px] leading-relaxed" style={{ borderColor: border, background: bg, color: subText }}>
        <div className="mb-1 font-black" style={{ color: text }}>登录流程</div>
        <ol className="m-0 list-decimal space-y-0.5 pl-4">
          {CODEX_LOGIN_FLOW_STEPS.map((step) => (
            <li key={step}>{step.replace(/^\d+\.\s*/, '')}</li>
          ))}
        </ol>
      </div>
      {statusDetailMessage && (
        <div className="mt-2 rounded-lg border px-2 py-1.5 text-[10px] leading-relaxed" style={{ borderColor: border, background: bg, color: subText }}>
          检测详情：{statusDetailMessage}
        </div>
      )}
      {!status?.available && (
        <div className="mt-2 grid gap-2">
          <button
            type="button"
            className="nodrag inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-black"
            style={{ ...buttonStyle, background: accent, color: studioAccentText, borderColor: accent }}
            disabled={loginBusy}
            onClick={() => void openCodexLogin()}
          >
            {loginBusy ? <Loader2 size={14} className="animate-spin" /> : <TerminalSquare size={14} />}
            打开登录
          </button>
          <div className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5" style={{ borderColor: border, background: bg }}>
            <code className="truncate text-[11px]">{codexLoginCommand}</code>
            <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => copyCodexSetupCommand(codexLoginCommand, '登录命令')}>
              复制登录命令
            </button>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5" style={{ borderColor: border, background: bg }}>
            <code className="truncate text-[11px]">{codexInstallCommand}</code>
            <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => copyCodexSetupCommand(codexInstallCommand, '安装命令')}>
              复制安装命令
            </button>
          </div>
        </div>
      )}
    </div>
  );

  const queueArtifactEdit = (artifact: CodexAgentArtifact, variant = false) => {
    const isImage = artifact.kind === 'image';
    update({
      codexQuickPrompt: variant
        ? createVariantPrompt(artifact, Number(d.codexBatchVariantCount || 4))
        : `继续修改这个产物，保持优点，解决瑕疵，并输出新版最终结果。\n\n${artifact.text || artifactPrimaryUrl(artifact)}`,
      codexQuickPromptMentions: [],
      codexMode: isImage ? 'image' : 'prompt',
      codexPresetId: isImage ? 'image' : 'prompt',
      codexPreset: isImage ? '图像生成' : '提示词增强',
      codexLastRunSummary: variant ? '已把变体任务填入输入框' : '已把继续修改任务填入输入框',
    });
  };

  const deleteArtifacts = useCallback((targets: CodexAgentArtifact[], summary = '已删除 Codex 产物') => {
    const normalizedTargets = targets
      .map((artifact) => normalizeArtifact(artifact))
      .filter((artifact): artifact is CodexAgentArtifact => !!artifact);
    if (normalizedTargets.length === 0) return;
    const targetIds = new Set(normalizedTargets.map((artifact) => artifact.id));
    const targetKeys = normalizedTargets.flatMap(artifactDeleteKeys);
    const nextDeletedKeys = mergeDeletedArtifactKeys(deletedArtifactKeysRef.current, targetKeys);
    deletedArtifactKeysRef.current = nextDeletedKeys;
    const nextArtifacts = filterDeletedArtifacts(
      artifactsRef.current.filter((artifact) => !targetIds.has(artifact.id)),
      nextDeletedKeys,
    ).slice(-MAX_ARTIFACTS);
    const nextArtifactIds = new Set(nextArtifacts.map((artifact) => artifact.id));
    const nextVersions = versionsRef.current
      .filter((version) => !targetIds.has(version.artifactId) && nextArtifactIds.has(version.artifactId))
      .slice(-MAX_VERSIONS);
    const nextSessions = compactCodexStudioSessionsForCanvas(studioSessionList.map((session) => {
      const sessionArtifacts = filterDeletedArtifacts(
        sanitizeArtifacts(session.id === activeStudioSessionId ? nextArtifacts : session.artifacts),
        nextDeletedKeys,
      );
      const sessionArtifactIds = new Set(sessionArtifacts.map((artifact) => artifact.id));
      const sessionVersions = sanitizeVersions(session.id === activeStudioSessionId ? nextVersions : session.versions)
        .filter((version) => sessionArtifactIds.has(version.artifactId));
      const sessionMessages = sanitizeMessages(session.messages);
      return {
        ...session,
        artifacts: sessionArtifacts,
        versions: sessionVersions,
        messages: sessionMessages,
        artifactCount: sessionArtifacts.length,
        messageCount: sessionMessages.length,
        updatedAt: session.id === activeStudioSessionId ? Date.now() : session.updatedAt,
      };
    }));
    artifactsRef.current = nextArtifacts;
    versionsRef.current = nextVersions;
    setHoverZoomArtifact((current) => current && targetIds.has(current.id) ? null : current);
    setSelectedArtifactIds((current) => current.filter((artifactId) => !targetIds.has(artifactId)));
    update({
      codexArtifacts: nextArtifacts,
      codexVersions: nextVersions,
      codexDeletedArtifactKeys: nextDeletedKeys,
      codexStudioSessions: nextSessions,
      lastArtifactId: nextArtifacts[nextArtifacts.length - 1]?.id || '',
      codexLastRunSummary: summary,
    });
  }, [activeStudioSessionId, studioSessionList, update]);

  const deleteArtifact = useCallback((artifact: CodexAgentArtifact) => {
    deleteArtifacts([artifact]);
  }, [deleteArtifacts]);

  const toggleArtifactSelection = useCallback((artifactId: string) => {
    setSelectedArtifactIds((current) => (
      current.includes(artifactId)
        ? current.filter((item) => item !== artifactId)
        : [...current, artifactId]
    ));
  }, []);

  const allVisibleArtifactsSelected = visibleStudioArtifacts.length > 0
    && visibleStudioArtifacts.every((artifact) => selectedArtifactIds.includes(String(artifact.id || '')));
  const selectedVisibleArtifacts = visibleStudioArtifacts.filter((artifact) => selectedArtifactIds.includes(String(artifact.id || '')));
  const renderedStudioArtifacts = artifactBatchMode ? visibleStudioArtifacts : visibleStudioArtifacts.slice(-8);

  const toggleSelectVisibleArtifacts = useCallback(() => {
    setSelectedArtifactIds((current) => {
      const visibleIds = visibleStudioArtifacts.map((artifact) => String(artifact.id || '')).filter(Boolean);
      if (visibleIds.length === 0) return current;
      if (visibleIds.every((artifactId) => current.includes(artifactId))) {
        return current.filter((artifactId) => !visibleIds.includes(artifactId));
      }
      return Array.from(new Set([...current, ...visibleIds]));
    });
  }, [visibleStudioArtifacts]);

  const deleteSelectedArtifacts = useCallback(() => {
    const selected = artifactsRef.current.filter((artifact) => selectedArtifactIds.includes(String(artifact.id || '')));
    deleteArtifacts(selected, `已删除 ${selected.length} 个 Codex 产物`);
  }, [deleteArtifacts, selectedArtifactIds]);

  const clearAllArtifacts = useCallback(() => {
    deleteArtifacts(artifactsRef.current, '已清空 Codex 产物库');
    setArtifactBatchMode(false);
  }, [deleteArtifacts]);

  const renderArtifactCard = (artifact: CodexAgentArtifact) => {
    const url = artifactPrimaryUrl(artifact);
    const artifactId = String(artifact.id || '');
    const selectedForBatch = selectedArtifactIds.includes(artifactId);
    return (
      <div key={artifactId} className="rounded-lg border p-2" style={{ borderColor: border }}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {artifactBatchMode && (
              <input
                type="checkbox"
                className="nodrag"
                checked={selectedForBatch}
                onChange={() => toggleArtifactSelection(artifactId)}
                aria-label="选择产物"
              />
            )}
            <div className="min-w-0 text-xs font-black">{artifact.title || artifactKindLabel(artifact.kind)}</div>
          </div>
          <span className="shrink-0 text-[10px]" style={{ color: subText }}>{artifactKindLabel(artifact.kind)}</span>
        </div>
        {artifact.kind === 'image' && url && (
          <div
            className="nodrag relative mb-2 overflow-hidden rounded-md border"
            style={{ borderColor: border, background: bg }}
            onMouseEnter={() => setHoverZoomArtifact(artifact)}
            onMouseLeave={() => setHoverZoomArtifact(null)}
            data-codex-artifact-zoom-trigger="true"
          >
            <SmartImage src={url} alt={artifact.title || 'Codex 图像'} className="max-h-32 w-full object-contain" thumbSize={360} />
            <div className="pointer-events-none absolute right-1 top-1 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-black shadow-sm" style={{ borderColor: accent, background: isDark ? 'rgba(8,13,28,0.86)' : 'rgba(255,255,255,0.9)', color: text }}>
              <Search size={11} /> 100%
            </div>
          </div>
        )}
        <div className="mb-2 break-all text-[11px]" style={{ color: subText }}>
          {artifact.kind === 'text' ? textPreview(String(artifact.text || ''), 90) : downloadName(url, 'artifact')}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => queueArtifactEdit(artifact)}>
            继续改
          </button>
          <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => queueArtifactEdit(artifact, true)}>
            变体
          </button>
          <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => publishArtifact(artifact)}>
            发布
          </button>
          <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => openArtifactSendModal(artifact, id)}>
            发送画布
          </button>
          <button
            type="button"
            className="nodrag rounded-md px-2 py-1 text-[11px] font-bold"
            style={buttonStyle}
            onClick={() => void saveArtifactToResourceLibrary(artifact, id)
              .then((msg) => {
                update({ codexLastRunSummary: `资源库：${msg}` });
                logBus.success(msg, `codex:${id}`);
              })
              .catch((error) => logBus.error(error?.message || '保存失败', `codex:${id}`))}
          >
            入库
          </button>
          <button
            type="button"
            data-codex-artifact-action="delete"
            className="nodrag rounded-md px-2 py-1 text-[11px] font-bold"
            style={{ ...buttonStyle, borderColor: danger, color: danger }}
            onClick={() => deleteArtifact(artifact)}
          >
            删除
          </button>
        </div>
      </div>
    );
  };

  const renderSimpleCompletionSummary = (artifact: CodexAgentArtifact | null) => {
    if (!artifact) return <div className="text-xs" style={{ color: subText }}>暂无 Codex 产物</div>;
    const url = artifactPrimaryUrl(artifact);
    return (
      <div className="grid gap-2 text-xs" style={{ color: subText }}>
        <div className="font-bold" style={{ color: text }}>
          {artifactKindLabel(artifact.kind)} 已生成{autoPublishOutput ? '，并发布到输出素材' : '，可手动发布到输出素材'}
        </div>
        <div className="truncate" title={artifact.kind === 'text' ? artifact.text : url}>
          {artifact.kind === 'text' ? textPreview(String(artifact.text || ''), 52) : downloadName(url, 'artifact')}
        </div>
        <div className="grid grid-cols-3 gap-1">
          <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => queueArtifactEdit(artifact, true)}>
            变体
          </button>
          <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => openArtifactSendModal(artifact, id)}>
            发送
          </button>
          <button
            type="button"
            className="nodrag rounded-md px-2 py-1 text-[11px] font-bold"
            style={buttonStyle}
            onClick={() => void saveArtifactToResourceLibrary(artifact, id)
              .then((msg) => {
                update({ codexLastRunSummary: `资源库：${msg}` });
                logBus.success(msg, `codex:${id}`);
              })
              .catch((error) => logBus.error(error?.message || '保存失败', `codex:${id}`))}
          >
            入库
          </button>
        </div>
      </div>
    );
  };

  const updateCodexRunIntent = useCallback((nextIntent: Exclude<CodexRunIntent, 'auto'>) => {
    const patch: Record<string, any> = {
      codexRunIntent: nextIntent,
      ...(codexModelManual ? {} : codexModelAutoPatchForRunIntent(nextIntent)),
    };
    if (
      nextIntent === 'img' &&
      defaultImageGenerationSkill &&
      !selectedRunnableSkillNames.includes(defaultImageGenerationSkill.name)
    ) {
      patch.codexSelectedSkillNames = [...selectedRunnableSkillNames, defaultImageGenerationSkill.name];
      patch.codexAutoImagegenSkillName = defaultImageGenerationSkill.name;
    }
    if (nextIntent === 'llm' && codexAutoImagegenSkillName) {
      patch.codexSelectedSkillNames = selectedRunnableSkillNames.filter((name) => name !== codexAutoImagegenSkillName);
      patch.codexAutoImagegenSkillName = '';
    }
    update(patch);
  }, [codexAutoImagegenSkillName, codexModelManual, defaultImageGenerationSkill, selectedRunnableSkillNames, update]);

  const renderRunIntentToggle = (placement: 'simple' | 'studio') => (
    <div
      className="grid grid-cols-2 gap-1 rounded-xl border p-1"
      style={{ borderColor: accent, background: isDark ? 'rgba(8,13,28,0.72)' : bg, boxShadow: isPixel ? undefined : `inset 0 0 0 1px ${isDark ? 'rgba(56,189,248,0.16)' : 'rgba(2,132,199,0.08)'}` }}
      data-codex-run-intent={codexRunIntent}
      data-codex-simple-run-intent={placement === 'simple' ? codexRunIntent : undefined}
    >
      {CODEX_RUN_INTENT_OPTIONS.map((item) => {
        const active = codexRunIntent === item.id;
        const intentLabel = item.id === 'img' ? '生图模式' : '文字模式';
        return (
          <button
            key={`${placement}-${item.id}`}
            type="button"
            aria-pressed={active}
            data-codex-run-intent-option={item.id}
            data-codex-run-intent-active={active ? 'true' : 'false'}
            className="nodrag flex min-h-[42px] flex-col items-center justify-center rounded-lg border px-3 py-1.5 text-xs font-black transition"
            style={{
              ...segmentedControlButtonStyle(active),
              outline: active ? `2px solid ${accent}` : '1px solid transparent',
              outlineOffset: active ? 1 : 0,
              transform: active ? 'translateY(-1px)' : undefined,
              boxShadow: active
                ? isPixel
                  ? '2px 2px 0 var(--px-ink)'
                  : `0 0 0 2px ${isDark ? 'rgba(56,189,248,0.22)' : 'rgba(2,132,199,0.16)'}, 0 8px 18px rgba(0,0,0,0.18)`
                : 'none',
            }}
            onClick={() => {
              const nextIntent = item.id;
              updateCodexRunIntent(nextIntent);
            }}
            title={item.title}
          >
            <span className="inline-flex items-center justify-center gap-1 leading-none">
              {active && <CheckCircle2 size={13} strokeWidth={3} />}
              <span>{item.label}</span>
              {active && (
                <span
                  className="rounded-full border px-1.5 py-0.5 text-[9px] font-black leading-none"
                  style={{
                    borderColor: isDark ? 'rgba(255,255,255,0.42)' : 'rgba(15,23,42,0.22)',
                    background: isDark ? 'rgba(8,13,28,0.78)' : 'rgba(255,255,255,0.88)',
                    color: accent,
                  }}
                >
                  当前
                </span>
              )}
            </span>
            <span className="mt-0.5 text-[10px] font-bold leading-none opacity-80">{intentLabel}</span>
          </button>
        );
      })}
    </div>
  );

  const renderModelPicker = (compact = false) => (
    <div className={compact ? 'grid min-w-0 gap-1.5' : 'grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2'}>
      <label className="grid min-w-0 gap-1 text-[11px]" style={{ color: subText }}>
        模型选择
        <select
          className="nodrag w-full min-w-0 rounded-lg border px-2 py-1.5 text-xs font-bold outline-none"
          style={{ borderColor: border, background: bg, color: text }}
          value={codexModelMode}
          onChange={(event) => {
            const value = event.currentTarget.value;
            update({
              codexModelMode: value,
              codexModel: value === 'default' ? '' : value === 'custom' ? String(d.codexModel || '') : value,
              codexModelManual: true,
            });
          }}
        >
          {CODEX_MODEL_OPTIONS.map((item) => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
      </label>
      <label className="grid min-w-0 gap-1 text-[11px]" style={{ color: subText }}>
        {codexModelMode === 'custom' ? '自定义模型 ID' : '说明'}
        {codexModelMode === 'custom' ? (
          <input
            className="nodrag w-full min-w-0 rounded-lg border px-2 py-1.5 text-xs outline-none"
            style={{ borderColor: border, background: bg, color: text }}
            value={String(d.codexModel || '')}
            placeholder="例如：gpt-5.2"
            onChange={(event) => update({ codexModel: event.currentTarget.value, codexModelMode: 'custom', codexModelManual: true })}
          />
        ) : (
          <div className="w-full min-w-0 truncate rounded-lg border px-2 py-1.5 text-[11px] leading-snug" style={{ borderColor: border, background: surface, color: subText }}>
            {CODEX_MODEL_OPTIONS.find((item) => item.value === codexModelMode)?.hint || '跟随 Codex CLI 配置'}
          </div>
        )}
      </label>
    </div>
  );

  const renderModelSelect = (showHint = true) => {
    const currentModelOption = CODEX_MODEL_OPTIONS.find((item) => item.value === codexModelMode) || CODEX_MODEL_OPTIONS[0];
    return (
      <div className="grid min-w-0 gap-1">
        <label className="grid min-w-0 gap-1 text-[11px] font-bold" style={{ color: subText }}>
          模型
          <select
            className="nodrag w-full min-w-0 rounded-lg border px-2 py-2 text-xs font-black outline-none"
            style={{ borderColor: border, background: bg, color: text }}
            value={codexModelMode}
            onChange={(event) => {
              const value = event.currentTarget.value;
              update({
                codexModelMode: value,
                codexModel: value === 'custom' ? String(d.codexModel || '') : value === 'default' ? '' : value,
                codexModelManual: true,
              });
            }}
          >
            {CODEX_MODEL_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        {codexModelMode === 'custom' && (
          <input
            className="nodrag w-full min-w-0 rounded-lg border px-2 py-1.5 text-xs outline-none"
            style={{ borderColor: border, background: bg, color: text }}
            value={String(d.codexModel || '')}
            placeholder="例如：gpt-5.5"
            onChange={(event) => update({ codexModel: event.currentTarget.value, codexModelMode: 'custom', codexModelManual: true })}
          />
        )}
        {showHint && (
          <div className="w-full min-w-0 truncate rounded-lg border px-2 py-1.5 text-[11px]" style={{ borderColor: border, background: bg, color: subText }} title={currentModelOption.hint}>
            {currentModelOption.hint}
          </div>
        )}
      </div>
    );
  };

  const renderPresetSelect = (label = '创作模板') => {
    const currentPresetVisible = visibleSelectableCreatorPresets.some((preset) => preset.id === currentPreset.id);
    return (
      <div className="grid min-w-0 gap-1.5">
        <label className="grid min-w-0 gap-1 text-[11px] font-bold" style={{ color: subText }}>
          模板分类
          <select
            data-codex-template-category="select-filter"
            className="nodrag w-full min-w-0 rounded-lg border px-2 py-2 text-xs font-black outline-none"
            style={{ borderColor: border, background: bg, color: text }}
            value={codexTemplateSelectCategory}
            onChange={(event) => {
              const nextCategory = event.currentTarget.value;
              const nextPresets = nextCategory === '全部'
                ? allCreatorPresets
                : allCreatorPresets.filter((preset) => sanitizeCreatorCategory(preset.category) === nextCategory);
              const currentStillVisible = nextPresets.some((preset) => preset.id === currentPreset.id);
              update({
                codexTemplateSelectCategory: nextCategory,
                ...(hasActiveCreatorPreset && !currentStillVisible ? {
                  codexMode: DEFAULT_CREATOR_PRESET.mode,
                  codexPresetId: NO_CREATOR_PRESET_ID,
                  codexPreset: '',
                } : {}),
              });
            }}
          >
            {templateCategories.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
        </label>
        <label className="grid min-w-0 gap-1 text-[11px] font-bold" style={{ color: subText }}>
          {label}
          <select
            className="nodrag w-full min-w-0 rounded-lg border px-2 py-2 text-xs font-black outline-none"
            style={{ borderColor: border, background: bg, color: text }}
            value={hasActiveCreatorPreset && currentPresetVisible ? currentPreset.id : NO_CREATOR_PRESET_ID}
            onChange={(event) => {
              const nextPresetId = event.currentTarget.value;
              if (nextPresetId === NO_CREATOR_PRESET_ID) {
                update({
                  codexMode: DEFAULT_CREATOR_PRESET.mode,
                  codexPresetId: NO_CREATOR_PRESET_ID,
                  codexPreset: '',
                });
                return;
              }
              const preset = allCreatorPresets.find((item) => item.id === nextPresetId) || DEFAULT_CREATOR_PRESET;
              update({
                codexMode: preset.mode,
                codexPresetId: preset.id,
                codexPreset: preset.label,
                codexTemplateSelectCategory: sanitizeCreatorCategory(preset.category),
              });
            }}
          >
            <option value={NO_CREATOR_PRESET_ID}>无模板</option>
            {visibleSelectableCreatorPresets.length === 0 && (
              <option data-codex-empty-template-option value="" disabled>当前分类暂无模板</option>
            )}
            {visibleSelectableCreatorPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.label} · {sanitizeCreatorCategory(preset.category)}</option>
            ))}
          </select>
        </label>
      </div>
    );
  };

  const renderSkillDropdown = () => {
    return (
    <div className="grid min-w-0 gap-1" data-codex-skill-compact="true">
      <div className="grid min-w-0 gap-1 text-[11px] font-bold" style={{ color: subText }}>
        Skill 列表
        <button
          type="button"
          data-codex-skill-trigger="true"
          className="nodrag flex w-full min-w-0 items-center justify-between rounded-lg border px-2 py-2 text-left text-xs font-black"
          style={{ borderColor: border, background: bg, color: text }}
          disabled={creatorSkills.length === 0}
          onClick={(event) => openSkillPicker('select', event.currentTarget, skillSearchQuery, null)}
        >
          <span className="truncate">
            {creatorSkills.length
              ? selectedCreatorSkills.length
                ? `已选 ${selectedCreatorSkills.length} 个 Skill`
                : '选择 / 取消 Skill...'
              : '未发现可用 Skill'}
          </span>
          <span className="text-[10px]" style={{ color: subText }}>{creatorSkills.length}</span>
        </button>
      </div>
      <div className="w-full min-w-0 truncate rounded-lg border px-2 py-1.5 text-[11px] leading-snug" style={{ borderColor: border, background: bg, color: subText }}>
        {selectedCreatorSkills.length
          ? `已选 ${selectedCreatorSkills.length} 个：${selectedCreatorSkills.slice(0, 3).map((skill) => `$${skill.name}`).join('、')}${selectedCreatorSkills.length > 3 ? '...' : ''}`
          : '未选择 Skill；可点上方下拉或在输入框输入 /。'}
      </div>
    </div>
    );
  };

  const renderRunPreferenceControls = (compact = false, showPersistence = true, showAutoPublish = true) => (
    <div className={`grid min-w-0 ${compact ? 'gap-1.5' : 'gap-2'}`} data-codex-run-preferences="true">
      {showAutoPublish && (
        <label className="nodrag flex min-w-0 items-start gap-2 rounded-lg border px-2 py-1.5 text-[11px]" style={{ borderColor: border, background: bg, color: subText }}>
          <input
            type="checkbox"
            className="mt-0.5 shrink-0"
            checked={studioAutoPublishOutput}
            onChange={(event) => update({ codexAutoPublishOutput: event.currentTarget.checked })}
          />
          <span className="min-w-0">
            <span className="block font-black" style={{ color: text }}>生成后自动发布到画布输出</span>
            {!compact && <span className="block leading-snug">关闭后只进入产物库，需要手动点发布。</span>}
          </span>
        </label>
      )}
      {showPersistence && (
        <div className="grid grid-cols-2 gap-2">
          <label className="nodrag flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px]" style={{ borderColor: border, background: bg, color: subText }}>
            <input
              type="checkbox"
              checked={persistPrompt}
              onChange={(event) => update({ codexPersistPrompt: event.currentTarget.checked })}
            />
            <span className="min-w-0 truncate">
              <span className="font-black" style={{ color: text }}>提示词持久化</span>
            </span>
          </label>
          <label className="nodrag flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px]" style={{ borderColor: border, background: bg, color: subText }}>
            <input
              type="checkbox"
              checked={persistMaterials}
              onChange={(event) => update({
                codexPersistMaterials: event.currentTarget.checked,
                ...(event.currentTarget.checked ? { codexStudioConsumedMaterialIds: [] } : {}),
              })}
            />
            <span className="min-w-0 truncate">
              <span className="font-black" style={{ color: text }}>素材持久化</span>
            </span>
          </label>
        </div>
      )}
    </div>
  );

  const renderCompactCreatorControls = (showManage = true) => (
    <section className="w-full max-w-full overflow-hidden rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-black">创作设置</div>
          <div className="text-[11px]" style={{ color: subText }}>模板 · Skill · 模型</div>
        </div>
        {showManage && (
          <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => setStudioOpen(true)}>
            管理
          </button>
        )}
      </div>
      <div className="grid min-w-0 gap-2">
        {renderPresetSelect()}
        {renderSkillDropdown()}
        {renderModelSelect(false)}
        {renderRunPreferenceControls(!showManage, !showManage, !showManage)}
      </div>
    </section>
  );

  const renderTemplateWorkshop = () => (
    <div className="grid min-h-[420px] gap-3 md:grid-cols-[250px_minmax(0,1fr)]">
      <section className="min-h-0 rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-black">模板库</div>
            <div className="text-[11px]" style={{ color: subText }}>{customPresets.length} 个自定义模板</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <input
              ref={templateImportInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(event) => {
                void importCustomPresets(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
            <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => templateImportInputRef.current?.click()}>
              导入
            </button>
            <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={exportCustomPresets}>
              导出
            </button>
            <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={clearTemplateDraft}>
              新建
            </button>
          </div>
        </div>
        <select
          data-codex-template-category="filter"
          className="nodrag mb-2 w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
          style={{ borderColor: border, background: bg, color: text }}
          value={codexTemplateCategoryFilter}
          onChange={(event) => setCodexTemplateCategoryFilter(event.currentTarget.value)}
        >
          {templateCategories.map((category) => (
            <option key={category} value={category}>{category}</option>
          ))}
        </select>
        <div className="max-h-[330px] space-y-2 overflow-auto pr-1">
          {visibleCustomPresets.map((preset) => {
            const active = editingPresetId === preset.id;
            return (
              <div key={preset.id} className="rounded-lg border p-2" style={{ borderColor: active ? accent : border, background: active ? surfaceStrong : bg }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-black">{preset.label}</div>
                    <div className="truncate text-[10px]" style={{ color: subText }}>{sanitizeCreatorCategory(preset.category)} · {preset.mode}</div>
                  </div>
                  <button type="button" data-codex-template-action="rename" className="nodrag shrink-0 rounded-md px-2 py-1 text-[10px] font-bold" style={buttonStyle} onClick={() => editCustomPreset(preset)}>
                    重命名
                  </button>
                </div>
                <div className="mt-1 line-clamp-2 text-[11px]" style={{ color: subText }}>{preset.hint}</div>
                <div className="mt-2 grid grid-cols-2 gap-1">
                  <button type="button" data-codex-template-action="edit" className="nodrag rounded-md px-2 py-1 text-[10px] font-bold" style={buttonStyle} onClick={() => editCustomPreset(preset)}>
                    编辑
                  </button>
                  <button type="button" data-codex-template-action="delete" className="nodrag rounded-md px-2 py-1 text-[10px] font-bold" style={{ ...buttonStyle, color: danger }} onClick={() => deleteCustomPreset(preset.id)}>
                    删除
                  </button>
                </div>
              </div>
            );
          })}
          {visibleCustomPresets.length === 0 && (
            <div className="rounded-lg border p-3 text-center text-xs" style={{ borderColor: border, color: subText }}>
              当前分类暂无模板
            </div>
          )}
        </div>
      </section>
      <section className="rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-black">{editingPresetId ? '编辑模板' : '新建模板'}</div>
            <div className="text-[11px]" style={{ color: subText }}>分类、名称和指令都会保存到模板下拉</div>
          </div>
        </div>
        <div className="grid gap-2">
          <div className="grid grid-cols-[1fr_150px] gap-2">
            <input
              className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none"
              style={{ borderColor: border, background: bg, color: text }}
              value={String(d.codexPresetDraftTitle || '')}
              onChange={(event) => update({ codexPresetDraftTitle: event.currentTarget.value })}
              placeholder="模板名称，例如：小红书商品图"
            />
            <input
              data-codex-template-category="draft"
              className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none"
              style={{ borderColor: border, background: bg, color: text }}
              value={String(d.codexPresetDraftCategory || DEFAULT_CREATOR_CATEGORY)}
              onChange={(event) => update({ codexPresetDraftCategory: event.currentTarget.value })}
              placeholder="分类"
            />
          </div>
          <div className="grid grid-cols-[1fr_130px] gap-2">
            <input
              className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none"
              style={{ borderColor: border, background: bg, color: text }}
              value={String(d.codexPresetDraftHint || '')}
              onChange={(event) => update({ codexPresetDraftHint: event.currentTarget.value })}
              placeholder="用途说明"
            />
            <select
              className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none"
              style={{ borderColor: border, background: bg, color: text }}
              value={settingsValue(d.codexPresetDraftMode, 'prompt')}
              onChange={(event) => update({ codexPresetDraftMode: event.currentTarget.value })}
            >
              <option value="prompt">提示词</option>
              <option value="image">图像</option>
              <option value="storyboard">分镜</option>
              <option value="character">角色</option>
              <option value="product">商品</option>
              <option value="quality">质检</option>
              <option value="chat">对话</option>
            </select>
          </div>
          <textarea
            className="nodrag min-h-[220px] rounded-lg border px-2 py-1.5 text-xs leading-relaxed outline-none"
            style={{ borderColor: border, background: bg, color: text }}
            value={String(d.codexPresetDraftPrompt || '')}
            onChange={(event) => update({ codexPresetDraftPrompt: event.currentTarget.value })}
            placeholder="模板指令：告诉 Codex 应该按什么结构输出、重点检查什么、最终交付什么。"
          />
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <button type="button" className="nodrag inline-flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-xs font-black" style={{ ...buttonStyle, background: surfaceStrong }} onClick={saveCustomPreset}>
              <Plus size={14} /> {editingPresetId ? '保存修改' : '保存为我的模板'}
            </button>
            {editingPresetId && (
              <button type="button" className="nodrag rounded-lg px-3 py-2 text-xs font-black" style={buttonStyle} onClick={clearTemplateDraft}>
                取消编辑
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );

  const renderProjectSkillEditor = () => (
    <div className="grid min-h-[430px] gap-3 md:grid-cols-[260px_minmax(0,1fr)]">
      <section className="min-h-0 rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-black">项目 Skill 库</div>
            <div className="text-[11px]" style={{ color: subText }}>{projectSkills.length} 个项目 Skill</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <input
              ref={projectSkillImportInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(event) => {
                void importProjectSkills(event.currentTarget.files?.[0]);
                event.currentTarget.value = '';
              }}
            />
            <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => projectSkillImportInputRef.current?.click()}>
              导入
            </button>
            <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={exportProjectSkills}>
              导出
            </button>
            <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={clearProjectSkillDraft}>
              新建
            </button>
          </div>
        </div>
        <select
          data-codex-project-skill-category="filter"
          className="nodrag mb-2 w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
          style={{ borderColor: border, background: bg, color: text }}
          value={projectSkillCategoryFilter}
          onChange={(event) => setProjectSkillCategoryFilter(event.currentTarget.value)}
        >
          {projectSkillCategories.map((category) => (
            <option key={category} value={category}>{category}</option>
          ))}
        </select>
        <div className="max-h-[340px] space-y-2 overflow-auto pr-1">
          {visibleProjectSkills.map((skill) => {
            const active = editingSkillName === skill.name;
            return (
              <div key={skill.name} className="rounded-lg border p-2" style={{ borderColor: active ? accent : border, background: active ? surfaceStrong : bg }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-black">${skill.name}</div>
                    <div className="truncate text-[10px]" style={{ color: subText }}>{sanitizeCreatorCategory(skill.category)}</div>
                  </div>
                  <button type="button" data-codex-skill-action="rename" className="nodrag shrink-0 rounded-md px-2 py-1 text-[10px] font-bold" style={buttonStyle} onClick={() => editProjectSkill(skill)}>
                    重命名
                  </button>
                </div>
                <div className="mt-1 line-clamp-2 text-[11px]" style={{ color: subText }}>{skill.description}</div>
                <div className="mt-2 grid grid-cols-2 gap-1">
                  <button type="button" data-codex-skill-action="edit" className="nodrag rounded-md px-2 py-1 text-[10px] font-bold" style={buttonStyle} onClick={() => editProjectSkill(skill)}>
                    编辑
                  </button>
                  <button type="button" data-codex-skill-action="delete" className="nodrag rounded-md px-2 py-1 text-[10px] font-bold" style={{ ...buttonStyle, color: danger }} onClick={() => void deleteProjectSkill(skill)}>
                    删除
                  </button>
                </div>
              </div>
            );
          })}
          {visibleProjectSkills.length === 0 && (
            <div className="rounded-lg border p-3 text-center text-xs" style={{ borderColor: border, color: subText }}>
              当前分类暂无项目 Skill
            </div>
          )}
        </div>
      </section>
      <section className="rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
        <div className="mb-3">
          <div className="text-sm font-black">{editingSkillName ? '编辑项目 Skill' : '新建项目 Skill'}</div>
          <div className="text-[11px]" style={{ color: subText }}>把项目风格、禁忌和交付标准写成可调用 Skill</div>
        </div>
        <div className="grid gap-2">
          <div className="grid grid-cols-[1fr_150px] gap-2">
            <input
              className="nodrag rounded-lg border px-2 py-2 text-sm outline-none"
              style={{ borderColor: border, background: bg, color: text }}
              value={skillDraftName}
              onChange={(event) => setSkillDraftName(event.currentTarget.value)}
              placeholder="project-skill-name"
            />
            <input
              data-codex-project-skill-category="draft"
              className="nodrag rounded-lg border px-2 py-2 text-sm outline-none"
              style={{ borderColor: border, background: bg, color: text }}
              value={skillDraftCategory}
              onChange={(event) => setSkillDraftCategory(event.currentTarget.value)}
              placeholder="分类"
            />
          </div>
          <textarea
            className="nodrag min-h-[270px] rounded-lg border px-3 py-2 text-sm leading-relaxed outline-none"
            style={{ borderColor: border, background: bg, color: text }}
            value={skillDraftBody}
            onChange={(event) => setSkillDraftBody(event.currentTarget.value)}
            placeholder="# 项目 Skill&#10;&#10;写清楚什么时候调用、输入是什么、输出格式是什么、风格禁忌是什么。"
          />
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <button type="button" className="nodrag inline-flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-sm font-black" style={buttonStyle} onClick={() => void saveProjectSkill()}>
              <Plus size={15} /> {editingSkillName ? '保存修改' : '创建项目 Skill'}
            </button>
            {editingSkillName && (
              <button type="button" className="nodrag rounded-lg px-3 py-2 text-sm font-black" style={buttonStyle} onClick={clearProjectSkillDraft}>
                取消编辑
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );

  const studioToolPanel = codexStudioTool && typeof document !== 'undefined'
    ? createPortal(
      <div className="fixed inset-0 z-[10040] nodrag nowheel bg-black/50" onMouseDown={(event) => event.stopPropagation()}>
        <div
          data-codex-studio-tool={codexStudioTool}
          className="absolute left-1/2 top-1/2 flex max-h-[86vh] w-[min(760px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border shadow-2xl"
          style={{ borderColor: accent, background: bg, color: text }}
        >
          <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: border, background: surfaceStrong }}>
            <div>
              <div className="text-base font-black">{codexStudioTool === 'template-workshop' ? '模板工坊' : '项目 Skill'}</div>
              <div className="text-[11px]" style={{ color: subText }}>{codexStudioTool === 'template-workshop' ? '编辑自己的模板，保存后才会出现在模板下拉里' : '创建当前工作区可调用的 Skill'}</div>
            </div>
            <button type="button" className="nodrag rounded-lg p-2" style={buttonStyle} onClick={() => setCodexStudioTool(null)} title="关闭">
              <X size={17} />
            </button>
          </div>
          <div className="min-h-0 overflow-auto p-4">
            {codexStudioTool === 'template-workshop' ? renderTemplateWorkshop() : renderProjectSkillEditor()}
          </div>
        </div>
      </div>,
      document.body,
    )
    : null;

  const skillPickerPortal = skillPickerOpen && creatorSkills.length > 0 && typeof document !== 'undefined'
    ? createPortal(
      <div
        data-codex-skill-picker-portal="true"
        data-canvas-floating-ui
        className="nodrag nowheel"
        onMouseDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        style={{
          position: 'fixed',
          left: skillPickerAnchor?.left ?? 24,
          top: skillPickerAnchor?.top ?? 120,
          width: skillPickerAnchor?.width ?? 380,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'min(540px, calc(100vh - 40px))',
          zIndex: 10020,
          border: `1px solid ${accent}`,
          borderRadius: 14,
          background: bg,
          color: text,
          boxShadow: isPixel ? '4px 4px 0 rgba(0,0,0,0.85)' : '0 24px 70px rgba(0,0,0,0.45)',
          overflow: 'hidden',
        }}
      >
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: border, background: surfaceStrong }}>
          <div className="min-w-0">
            <div className="truncate text-xs font-black">{skillPickerMode === 'slash' ? '/Skill 引用' : '选择 Skill'}</div>
            <div className="truncate text-[10px]" style={{ color: subText }}>
              {skillPickerMode === 'slash' ? '选择后会插入到输入框并加入本轮调用' : `共 ${creatorSkills.length} 个可用 Skill`}
            </div>
          </div>
          <button type="button" className="nodrag rounded-md p-1" style={buttonStyle} onClick={closeSkillPicker} title="关闭">
            <X size={14} />
          </button>
        </div>
        <div className="p-2">
          <div className="relative mb-2 min-w-0">
            <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2" style={{ color: subText }} />
            <input
              data-codex-skill-search="true"
              className="nodrag w-full min-w-0 rounded-lg border py-2 pl-7 pr-2 text-xs outline-none"
              style={{ borderColor: border, background: surface, color: text }}
              value={skillSearchQuery}
              placeholder="搜索 Skill，例如 image / design / figma"
              autoFocus
              onChange={(event) => setSkillSearchQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') closeSkillPicker();
              }}
            />
          </div>
          {selectedRunnableSkillNames.length > 0 && skillPickerMode === 'select' && (
            <button
              type="button"
              className="nodrag mb-2 w-full rounded-md px-2 py-1.5 text-left text-[11px] font-bold"
              style={{ ...buttonStyle, background: surfaceStrong }}
              onClick={() => update({ codexSelectedSkillNames: [] })}
            >
              清空已选 Skill
            </button>
          )}
          <div
            className="max-h-[360px] overflow-y-auto pr-1"
            style={{ overscrollBehavior: 'contain' }}
            onWheel={(event) => event.stopPropagation()}
          >
            {filteredCreatorSkills.map((skill) => {
              const active = selectedRunnableSkillNames.includes(skill.name);
              return (
                <button
                  key={`${skill.scope}:${skill.name}`}
                  type="button"
                  data-codex-skill-option={skill.name}
                  className="nodrag mb-1 w-full rounded-md border px-2 py-1.5 text-left"
                  style={{ borderColor: active ? accent : border, background: active ? surfaceStrong : surface, color: text }}
                  onClick={() => chooseSkillFromPicker(skill)}
                >
                  <span className="block truncate text-xs font-black">{active ? '✓ ' : ''}${skill.name}</span>
                  <span className="block truncate text-[10px]" style={{ color: subText }}>{skillPurposeLabel(skill)}</span>
                </button>
              );
            })}
            {filteredCreatorSkills.length === 0 && (
              <div className="rounded-lg border px-3 py-3 text-xs" style={{ borderColor: border, background: surface, color: subText }}>
                没有匹配的 Skill
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body,
    )
    : null;

  const artifactZoomUrl = hoverZoomArtifact && hoverZoomArtifact.kind === 'image'
    ? artifactPrimaryUrl(hoverZoomArtifact)
    : '';
  const artifactZoomPortal = hoverZoomArtifact && artifactZoomUrl && typeof document !== 'undefined'
    ? createPortal(
      <div
        className="pointer-events-none fixed inset-0 z-[10060] flex items-center justify-center bg-black/35 p-8"
        data-codex-artifact-zoom-preview="true"
      >
        <div className="max-w-[88vw] rounded-2xl border p-3 shadow-2xl" style={{ borderColor: accent, background: bg, color: text }}>
          <div className="mb-2 flex items-center justify-between gap-3 text-xs font-black">
            <span className="truncate">{hoverZoomArtifact.title || 'Codex 图像预览'}</span>
            <span className="shrink-0 rounded-md border px-2 py-0.5 text-[10px]" style={{ borderColor: accent, color: subText }}>100%</span>
          </div>
          <SmartImage
            src={artifactZoomUrl}
            alt={hoverZoomArtifact.title || 'Codex 图像 100% 预览'}
            className="max-h-[78vh] max-w-[82vw] rounded-xl object-contain"
            thumbSize={1400}
          />
        </div>
      </div>,
      document.body,
    )
    : null;

  const studio = studioOpen ? createPortal(
    <div className="fixed inset-0 z-[9999] nodrag nowheel bg-black/55" onMouseDown={(event) => event.stopPropagation()}>
      <div
        className="absolute inset-4 flex flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{ background: bg, color: text, borderColor: accent }}
      >
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: border, background: surfaceStrong, color: studioHeaderText }}>
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: accent, color: studioAccentText }}>
              <TerminalSquare size={24} />
            </div>
            <div>
              <div className="text-lg font-black">Codex 创作台</div>
              <div className="text-xs" style={{ color: studioHeaderSubText }}>流式对话 · Skill 调用 · 产物库 · 版本树 · 质量检查</div>
            </div>
          </div>
          <button type="button" className="nodrag rounded-lg p-2" style={buttonStyle} onClick={() => setStudioOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(420px,1fr)_340px] gap-0 overflow-hidden">
          <aside className="min-h-0 overflow-y-auto border-r p-4" style={{ borderColor: border }}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-black">创作工作区</div>
                <div className="text-[11px]" style={{ color: subText }}>会话 · 项目 · 模板 · Skill · 参数</div>
              </div>
              <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => void refreshStatusAndSkills()}>
                刷新
              </button>
            </div>

            <section className="mb-4 rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-black">会话列表</div>
                  <div className="text-[11px]" style={{ color: subText }}>项目内多轮创作对话</div>
                </div>
                <button type="button" className="nodrag inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-black" style={buttonStyle} onClick={newCodexStudioSession}>
                  <Plus size={13} /> 新建会话
                </button>
              </div>
              <div className="space-y-1.5">
                {studioSessionList.slice(0, 8).map((session) => {
                  const active = session.id === activeStudioSessionId;
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className="nodrag w-full rounded-lg border px-2 py-1.5 text-left"
                      style={{ borderColor: active ? accent : border, background: active ? surfaceStrong : bg, color: text }}
                      onClick={() => switchCodexStudioSession(session.id)}
                    >
                      <span className="block truncate text-xs font-black">{session.title}</span>
                      <span className="block text-[10px]" style={{ color: subText }}>{session.messageCount} 条对话 · {session.artifactCount} 个产物</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="mb-4 rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
              <div className="mb-2 text-sm font-black">项目管理</div>
              <div className="grid gap-1.5 text-[11px]" style={{ color: subText }}>
                <div className="flex items-center justify-between gap-2">
                  <span>工作区</span>
                  <span className="truncate text-right" title={String(d.codexWorkspaceDir || '')}>{d.codexWorkspaceDir ? '已创建' : '待创建'}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>当前模型</span>
                  <span className="truncate text-right">{selectedCodexModel || '默认'}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>已选 Skill</span>
                  <span>{selectedRunnableSkillNames.length}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>@ 产物</span>
                  <span>{artifactMaterials.length}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>记忆条数</span>
                  <span>{codexContextLimit} / {CODEX_STUDIO_CONTEXT_MAX_LIMIT}</span>
                </div>
              </div>
              <label className="mt-3 grid gap-1 text-[11px] font-bold" style={{ color: subText }}>
                创作台记忆
                <input
                  className="nodrag w-full rounded-lg border px-2 py-1.5 text-xs outline-none"
                  style={{ borderColor: border, background: bg, color: text }}
                  type="number"
                  min={0}
                  max={CODEX_STUDIO_CONTEXT_MAX_LIMIT}
                  step={1}
                  value={codexContextLimit}
                  onChange={(event) => {
                    const nextLimit = clampInteger(event.currentTarget.value, CODEX_STUDIO_CONTEXT_DEFAULT_LIMIT, 0, CODEX_STUDIO_CONTEXT_MAX_LIMIT);
                    codexContextLimitRef.current = nextLimit;
                    update({ codexContextLimit: nextLimit });
                  }}
                />
              </label>
              <div className="mt-1 rounded-lg border px-2 py-1.5 text-[10px] leading-relaxed" style={{ borderColor: border, background: bg, color: subText }}>
                超出条数的旧对话会自动压缩成长期记忆；新建会话会清空记忆。
                {codexContextCompressedCount > 0 && <span> 已压缩 {codexContextCompressedCount} 条历史为长期记忆。</span>}
              </div>
              <button type="button" className="nodrag mt-3 w-full rounded-lg px-3 py-2 text-xs font-black" style={buttonStyle} onClick={() => void refreshStatusAndSkills()}>
                刷新项目状态
              </button>
              <input
                className="nodrag mt-2 w-full rounded-lg border px-2 py-1.5 text-[11px] outline-none"
                style={{ borderColor: border, background: bg, color: text }}
                value={String(d.codexWorkspaceDir || '')}
                placeholder="工作区路径；留空则自动创建"
                onChange={(event) => update({ codexWorkspaceDir: event.currentTarget.value })}
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" className="nodrag rounded-lg px-2 py-1.5 text-[11px] font-black" style={buttonStyle} onClick={createNewCodexWorkspace}>
                  新建工作区
                </button>
                <button type="button" className="nodrag rounded-lg px-2 py-1.5 text-[11px] font-black" style={buttonStyle} onClick={archiveCodexStudioSessions}>
                  归档旧会话
                </button>
              </div>
            </section>

            <section
              className="mb-4 rounded-xl border p-3"
              style={{ borderColor: border, background: surface }}
              data-codex-studio-input-materials="true"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-black">输入素材</div>
                  <div className="text-[11px]" style={{ color: subText }}>当前会传给 Codex 的上游素材</div>
                </div>
                <span className="rounded-md border px-1.5 py-0.5 text-[10px] font-black" style={{ borderColor: border, background: bg, color: subText }}>
                  {inputMaterialTotal} 项
                </span>
              </div>
              <MaterialPreviewSection
                texts={orderedInputTexts}
                images={orderedImages}
                videos={orderedVideos}
                audios={orderedAudios}
                order={materialOrder}
                onReorder={setMaterialOrder}
                onExcludeUpstream={excludeUpstreamMaterial}
                excludedCount={excludedUpstreamCount}
                onRestoreExcluded={restoreExcludedMaterials}
                selected={!!selected}
                isDark={isDark}
                isPixel={isPixel}
                title="上游素材 · Agent 输入"
              />
              {inputMaterialTotal === 0 && excludedUpstreamCount === 0 && (
                <div className="text-[11px] leading-relaxed" style={{ color: subText }}>
                  可从左侧连接文本、图片、视频或音频；连接后这里会显示缩略图，并可拖动排序或点 X 排除。
                </div>
              )}
            </section>

            <section className="mb-4">
              {renderCompactCreatorControls(false)}
            </section>

            <section className="rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
              <div className="mb-2 text-sm font-black">工作台工具</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  data-codex-studio-tool="template-workshop"
                  className="nodrag rounded-lg px-2 py-2 text-xs font-black"
                  style={buttonStyle}
                  onClick={() => setCodexStudioTool('template-workshop')}
                >
                  模板工坊
                </button>
                <button
                  type="button"
                  data-codex-studio-tool="project-skill"
                  className="nodrag rounded-lg px-2 py-2 text-xs font-black"
                  style={buttonStyle}
                  onClick={() => setCodexStudioTool('project-skill')}
                >
                  项目 Skill
                </button>
              </div>
            </section>
          </aside>

          <main className="flex min-h-0 flex-col">
            <div className="border-b px-4 py-3" style={{ borderColor: border, background: surface }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-black">流式对话</div>
                  <div className="truncate text-[11px]" style={{ color: subText }}>
                    {currentPresetLabel} · {selectedCodexModel || '默认模型'} · {selectedRunnableSkillNames.length} 个 Skill · @ {artifactMaterials.length} 个产物
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {renderRunIntentToggle('studio')}
                  {isBusy && (
                    <button
                      type="button"
                      className="nodrag inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-black"
                      style={{ ...buttonStyle, borderColor: danger, color: danger }}
                      onClick={codexStopRunning}
                    >
                      <X size={14} /> 停止
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div
              ref={studioThreadScrollRef}
              className="nodrag nopan nowheel min-h-0 flex-1 overflow-auto p-5"
              data-codex-studio-thread="plain"
              data-codex-studio-copyable="true"
              style={{ userSelect: 'text', WebkitUserSelect: 'text' } as CSSProperties}
              onMouseDownCapture={stopCopyableConversationEvent}
              onPointerDownCapture={stopCopyableConversationEvent}
              onDoubleClickCapture={stopCopyableConversationEvent}
              onContextMenuCapture={stopCopyableConversationEvent}
              onDragStartCapture={stopCopyableConversationEvent}
              onMouseDown={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div data-codex-studio-thread-inner="true" className="w-full max-w-none space-y-5 select-text">
                {messages.length === 0 && (
                  <div className="py-4 text-sm leading-relaxed" style={{ color: subText }}>
                    用 Codex 作为画布里的创作副驾驶：让它帮你拆图像方案、写提示词、做分镜、沉淀项目 Skill，或者检查一组素材的创作风险。
                  </div>
                )}
                {messages.map((msg) => {
                  const roleLabel = msg.role === 'user' ? 'USER' : msg.role === 'tool' ? 'TOOL' : 'CODEX';
                  const messageContent = msg.content || (msg.status === 'running' && msg.role === 'assistant' ? streamingReply : '') || (msg.status === 'running' ? 'Codex 正在生成...' : '');
                  if (msg.role === 'tool') {
                    return (
                      <div key={msg.id} data-codex-message-role="tool" className="group flex items-start gap-2 text-[11px]" style={{ color: subText }}>
                        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: accent }} />
                        <span
                          className="nodrag nopan min-w-0 select-text whitespace-pre-wrap leading-relaxed"
                          data-codex-message-copyable="true"
                          style={{ userSelect: 'text', WebkitUserSelect: 'text' } as CSSProperties}
                          onMouseDownCapture={stopCopyableConversationEvent}
                          onPointerDownCapture={stopCopyableConversationEvent}
                          onDoubleClickCapture={stopCopyableConversationEvent}
                          onContextMenuCapture={stopCopyableConversationEvent}
                          onDragStartCapture={stopCopyableConversationEvent}
                          onMouseDown={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          {msg.content}
                        </span>
                        <button
                          type="button"
                          className="nodrag shrink-0 rounded-md border px-1.5 py-1 opacity-70 transition hover:opacity-100"
                          style={{ borderColor: border, background: surface, color: text }}
                          onClick={() => copyCodexMessage(msg.content)}
                          title="复制这条消息"
                        >
                          <Copy size={11} />
                        </button>
                      </div>
                    );
                  }
                  return (
                    <div key={msg.id} data-codex-message-role={msg.role} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`min-w-0 max-w-[92%] ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                        <div className={`mb-1 flex items-center gap-2 text-[10px] font-black uppercase tracking-wide ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`} style={{ color: subText }}>
                          <span>{roleLabel}</span>
                          {msg.status === 'running' && <Loader2 size={12} className="animate-spin" />}
                          <button
                            type="button"
                            className="nodrag rounded-md border px-1 py-0.5 opacity-70 transition hover:opacity-100"
                            style={{ borderColor: border, background: surface, color: text }}
                            onClick={() => copyCodexMessage(messageContent)}
                            title="复制这条消息"
                          >
                            <Copy size={10} />
                          </button>
                        </div>
                        <div
                          className="nodrag nopan select-text whitespace-pre-wrap text-sm leading-relaxed"
                          data-codex-message-copyable="true"
                          style={{ color: text, userSelect: 'text', WebkitUserSelect: 'text' } as CSSProperties}
                          onMouseDownCapture={stopCopyableConversationEvent}
                          onPointerDownCapture={stopCopyableConversationEvent}
                          onDoubleClickCapture={stopCopyableConversationEvent}
                          onContextMenuCapture={stopCopyableConversationEvent}
                          onDragStartCapture={stopCopyableConversationEvent}
                          onMouseDown={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          {messageContent}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border-t p-4" style={{ borderColor: border }}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-black">输入任务</div>
                  <div className="text-[11px]" style={{ color: subText }}>支持 @ 产物和 /Skill 直接调用能力</div>
                </div>
                <div className="rounded-lg border px-2 py-1 text-[11px] font-bold" style={{ borderColor: border, background: surface, color: subText }}>
                  {currentPresetLabel}
                </div>
              </div>
              <div
                ref={studioPromptFrameRef}
                data-codex-simple-prompt-frame="studio"
                data-codex-prompt-frame-source="studio"
                className="codex-simple-prompt-frame rounded-xl border p-2"
                style={{ borderColor: accent, background: bg, boxShadow: isPixel ? undefined : '0 0 0 3px rgba(56,189,248,0.08)' }}
                onFocusCapture={() => {
                  if (trailingSlashSkillQuery(quickPrompt)) openSkillPickerFromPrompt('studio');
                }}
                onKeyDownCapture={(event) => {
                  if (event.key === '/') window.setTimeout(() => openSkillPickerFromPrompt('studio'), 0);
                  if (event.key === 'Escape' && skillPickerMode === 'slash') closeSkillPicker();
                }}
              >
                {renderImagegenQuickParamBar('studio')}
                <MentionPromptInput
                  value={quickPrompt}
                  mentions={quickPromptMentions}
                  materials={mentionMaterials}
                  onChange={(value, mentions) => update({ codexQuickPrompt: value, codexQuickPromptMentions: mentions })}
                  onSubmit={() => requestCanvasNodeRun(id)}
                  placeholder="输入创作任务；可用 @ 引用素材，也可输入 /imagegen 或 /ads-explorer 调用 Skill..."
                  title="Codex 流式对话"
                  promptTemplateKind="image"
                  isDark={isDark}
                  isPixel={isPixel}
                  expandable
                  className="rounded-lg px-2 py-2 text-sm outline-none"
                  style={{ color: text, background: 'transparent', minHeight: 150, height: 150 }}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <label className="nodrag flex items-center gap-2 text-xs" style={{ color: subText }}>
                  <input
                    type="checkbox"
                    checked={persistPrompt}
                    onChange={(event) => update({ codexPersistPrompt: event.currentTarget.checked })}
                  />
                  保留 Prompt
                </label>
                <div className="flex items-center gap-2">
                  <button type="button" className="nodrag inline-flex items-center gap-1 px-3 py-2 text-sm font-bold" style={buttonStyle} onClick={() => void refreshStatusAndSkills()}>
                    <RefreshCw size={15} /> 刷新
                  </button>
                  {isBusy && (
                    <button
                      type="button"
                      className="nodrag inline-flex items-center gap-1 px-3 py-2 text-sm font-black"
                      style={{ ...buttonStyle, borderColor: danger, color: danger }}
                      onClick={codexStopRunning}
                    >
                      <X size={15} /> 停止
                    </button>
                  )}
                  <button
                    type="button"
                    className="nodrag inline-flex items-center gap-1 px-4 py-2 text-sm font-black"
                    style={{ ...buttonStyle, background: accent, color: studioAccentText, borderColor: accent }}
                    disabled={isBusy}
                    onClick={() => requestCanvasNodeRun(id)}
                  >
                    {isBusy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    发送
                  </button>
                </div>
              </div>
            </div>
          </main>

          <aside className="min-h-0 overflow-auto border-l p-4" style={{ borderColor: border }}>
            <section className="mb-4 rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-black"><Library size={15} /> 产物库</div>
                <div className="grid grid-cols-2 gap-1 rounded-lg border p-1" style={{ borderColor: border, background: bg }}>
                  <button
                    type="button"
                    data-codex-artifact-tab="image"
                    className="nodrag rounded-md px-2 py-1 text-[11px] font-black"
                    style={segmentedControlButtonStyle(artifactLibraryTab === 'image')}
                    onClick={() => setArtifactLibraryTab('image')}
                  >
                    图像 {imageArtifacts.length}
                  </button>
                  <button
                    type="button"
                    data-codex-artifact-tab="text"
                    className="nodrag rounded-md px-2 py-1 text-[11px] font-black"
                    style={segmentedControlButtonStyle(artifactLibraryTab === 'text')}
                    onClick={() => setArtifactLibraryTab('text')}
                  >
                    文本 {textArtifacts.length}
                  </button>
                </div>
              </div>
              <div className="mb-2 grid grid-cols-3 gap-1">
                <button
                  type="button"
                  className="nodrag rounded-md px-2 py-1 text-[11px] font-bold"
                  style={artifactBatchMode ? segmentedControlButtonStyle(true) : buttonStyle}
                  onClick={() => setArtifactBatchMode((value) => !value)}
                >
                  {artifactBatchMode ? '退出批量' : '批量'}
                </button>
                <button
                  type="button"
                  disabled={!artifactBatchMode || selectedArtifactIds.length === 0}
                  className="nodrag rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-45"
                  style={{ ...buttonStyle, borderColor: danger, color: danger }}
                  onClick={deleteSelectedArtifacts}
                >
                  删选中 {selectedArtifactIds.length}
                </button>
                <button
                  type="button"
                  disabled={artifacts.length === 0}
                  className="nodrag rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-45"
                  style={{ ...buttonStyle, borderColor: danger, color: danger }}
                  onClick={clearAllArtifacts}
                >
                  清空全部
                </button>
              </div>
              {artifactBatchMode && (
                <div className="mb-2 flex items-center justify-between rounded-lg border px-2 py-1 text-[11px]" style={{ borderColor: border, background: bg, color: subText }}>
                  <span>{artifactLibraryTab === 'image' ? '图像' : '文本'}已选 {selectedVisibleArtifacts.length} / {visibleStudioArtifacts.length}</span>
                  <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={toggleSelectVisibleArtifacts}>
                    {allVisibleArtifactsSelected ? '取消全选' : '全选当前'}
                  </button>
                </div>
              )}
              <div className="space-y-2">
                {renderedStudioArtifacts.slice().reverse().map((artifact) => renderArtifactCard(artifact))}
                {visibleStudioArtifacts.length === 0 && <div className="text-xs" style={{ color: subText }}>暂无{artifactLibraryTab === 'image' ? '图像' : '文本'}产物</div>}
              </div>
            </section>

            <section className="rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
              <div className="mb-2 flex items-center gap-2 text-sm font-black"><GitBranch size={15} /> 版本树</div>
              <div className="space-y-2">
                {versions.slice(-8).reverse().map((version) => (
                  <button
                    key={version.id}
                    type="button"
                    className="nodrag w-full rounded-lg border px-2 py-1.5 text-left text-xs"
                    style={{ borderColor: border, background: surfaceStrong, color: text }}
                    onClick={() => publishArtifact(artifacts.find((item) => item.id === version.artifactId))}
                  >
                    <span className="block font-bold">{version.title}</span>
                    <span style={{ color: subText }}>{artifactKindLabel(version.kind)} · 点击重新发布</span>
                  </button>
                ))}
                {versions.length === 0 && <div className="text-xs" style={{ color: subText }}>暂无版本</div>}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div data-codex-cli-agent-root="true" className="codex-cli-agent-node" style={rootStyle}>
        <Handle type="target" id="text" position={Position.Left} style={{ ...handleStyle, top: codexAgentHandleTop(0, 4), background: PORT_COLOR.text }} />
        <Handle type="target" id="image" position={Position.Left} style={{ ...handleStyle, top: codexAgentHandleTop(1, 4), background: PORT_COLOR.image }} />
        <Handle type="target" id="video" position={Position.Left} style={{ ...handleStyle, top: codexAgentHandleTop(2, 4), background: PORT_COLOR.video }} />
        <Handle type="target" id="audio" position={Position.Left} style={{ ...handleStyle, top: codexAgentHandleTop(3, 4), background: PORT_COLOR.audio }} />
        <Handle type="source" id="text" position={Position.Right} style={{ ...handleStyle, top: codexAgentHandleTop(0, 5), background: PORT_COLOR.text }} />
        <Handle type="source" id="image" position={Position.Right} style={{ ...handleStyle, top: codexAgentHandleTop(1, 5), background: PORT_COLOR.image }} />
        <Handle type="source" id="video" position={Position.Right} style={{ ...handleStyle, top: codexAgentHandleTop(2, 5), background: PORT_COLOR.video }} />
        <Handle type="source" id="audio" position={Position.Right} style={{ ...handleStyle, top: codexAgentHandleTop(3, 5), background: PORT_COLOR.audio }} />
        <Handle type="source" id="model3d" position={Position.Right} style={{ ...handleStyle, top: codexAgentHandleTop(4, 5), background: PORT_COLOR.model3d }} />

        <div data-codex-drag-surface="true" className="flex cursor-grab items-center justify-between border-b px-4 py-3 active:cursor-grabbing" style={{ borderColor: border, background: surfaceStrong, color: studioHeaderText }}>
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl" style={{ background: accent, color: studioAccentText }}>
              <TerminalSquare size={23} />
            </div>
            <div className="min-w-0">
              <div className="truncate text-lg font-black">Codex CLI Agent</div>
              <div className="truncate text-xs" style={{ color: studioHeaderSubText }}>{statusLineMessage}</div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {status?.available ? <CheckCircle2 size={18} color="#22c55e" /> : <AlertCircle size={18} color={danger} />}
            <button type="button" className="nodrag rounded-lg p-2" style={buttonStyle} onClick={() => setStudioOpen(true)} title="打开 Codex 创作台">
              <PanelRightOpen size={17} />
            </button>
          </div>
        </div>

        <div className="space-y-3 p-4">
          {codexStatusPanel}

          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-black">Codex 简约生成</div>
              <div className="text-xs" style={{ color: subText }}>输入任务，选择 Skill 后可直接调用</div>
            </div>
            <button type="button" className="nodrag rounded-lg p-2" style={buttonStyle} onClick={() => setSettingsOpen((v) => !v)} title="CLI 设置">
              <Settings2 size={16} />
            </button>
          </div>

          <div
            className="rounded-xl border p-2"
            style={{ borderColor: border, background: surface }}
            data-codex-simple-run-intent={codexRunIntent}
          >
            <div className="mb-1 flex min-w-0 items-center justify-between gap-2 px-0.5 text-[11px]" style={{ color: subText }}>
              <span className="shrink-0 font-black" style={{ color: text }}>运行模式</span>
              <span className="min-w-0 truncate font-bold" data-codex-run-intent-summary={codexRunIntent} style={{ color: text }}>
                当前：{codexRunIntent === 'img' ? 'IMG 生图模式 · 默认 gpt-5.5 + imagegen' : 'LLM 文字模式 · 默认 gpt-5.4 mini'}
              </span>
            </div>
            {renderRunIntentToggle('simple')}
          </div>

          {renderCompactCreatorControls(true)}

          {settingsOpen && (
            <div className="grid grid-cols-2 gap-2 rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
              <div className="col-span-2">{renderModelPicker(false)}</div>
              <label className="grid gap-1 text-[11px]" style={{ color: subText }}>
                Profile
                <input className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexProfile || '')} placeholder="creator" onChange={(e) => update({ codexProfile: e.currentTarget.value })} />
              </label>
              <label className="grid gap-1 text-[11px]" style={{ color: subText }}>
                沙箱
                <select className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={settingsValue(d.codexSandbox, 'workspace-write')} onChange={(e) => update({ codexSandbox: e.currentTarget.value })}>
                  <option value="workspace-write">workspace-write</option>
                  <option value="read-only">read-only</option>
                  <option value="danger-full-access">danger-full-access</option>
                </select>
              </label>
              <label className="grid gap-1 text-[11px]" style={{ color: subText }}>
                审批
                <select className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={settingsValue(d.codexApprovalPolicy, 'never')} onChange={(e) => update({ codexApprovalPolicy: e.currentTarget.value })}>
                  <option value="never">never</option>
                  <option value="on-request">on-request</option>
                  <option value="on-failure">on-failure</option>
                  <option value="untrusted">untrusted</option>
                </select>
              </label>
              <label className="col-span-2 grid gap-1 text-[11px]" style={{ color: subText }}>
                Codex 可执行文件路径
                <input className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexExecutablePath || '')} placeholder="codex" onChange={(e) => update({ codexExecutablePath: e.currentTarget.value })} />
              </label>
              <label className="col-span-2 grid gap-1 text-[11px]" style={{ color: subText }}>
                Codex 工作区
                <input className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexWorkspaceDir || '')} placeholder="留空自动创建；填写后后续运行都会复用" onChange={(e) => update({ codexWorkspaceDir: e.currentTarget.value })} />
              </label>
              <label className="col-span-2 grid gap-1 text-[11px]" style={{ color: subText }}>
                额外 CLI 参数
                <input className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexExtraArgs || '')} placeholder="--skip-git-repo-check" onChange={(e) => update({ codexExtraArgs: e.currentTarget.value })} />
              </label>
              <label className="nodrag flex items-center gap-2 text-xs" style={{ color: subText }}>
                <input type="checkbox" checked={d.codexWebSearch === true} onChange={(e) => update({ codexWebSearch: e.currentTarget.checked })} />
                Web Search
              </label>
              <label className="nodrag flex items-center gap-2 text-xs" style={{ color: subText }}>
                <input type="checkbox" checked={d.codexIncludePlanTool === true} onChange={(e) => update({ codexIncludePlanTool: e.currentTarget.checked })} />
                Plan Tool（可选，CLI 支持时）
              </label>
              <div className="col-span-2 mt-1 grid gap-2 rounded-lg border p-2" style={{ borderColor: border, background: surfaceStrong }}>
                <div className="text-[11px] font-black">创作 Brief / 平台转换</div>
                <div className="grid grid-cols-2 gap-2">
                  <input className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexBriefSubject || '')} placeholder="主体" onChange={(e) => update({ codexBriefSubject: e.currentTarget.value })} />
                  <input className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexBriefStyle || '')} placeholder="风格" onChange={(e) => update({ codexBriefStyle: e.currentTarget.value })} />
                  <input className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexBriefCamera || '')} placeholder="镜头" onChange={(e) => update({ codexBriefCamera: e.currentTarget.value })} />
                  <input className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexBriefLighting || '')} placeholder="光影" onChange={(e) => update({ codexBriefLighting: e.currentTarget.value })} />
                </div>
                <input className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexBriefComposition || '')} placeholder="构图 / 画面层级" onChange={(e) => update({ codexBriefComposition: e.currentTarget.value })} />
                <div className="grid grid-cols-3 gap-2">
                  <select className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={settingsValue(d.codexTargetPlatform, '通用')} onChange={(e) => update({ codexTargetPlatform: e.currentTarget.value })}>
                    <option value="通用">通用</option>
                    <option value="GPT Image">GPT Image</option>
                    <option value="Midjourney">Midjourney</option>
                    <option value="SD / ComfyUI">SD / ComfyUI</option>
                    <option value="即梦 / Seedream">即梦 / Seedream</option>
                    <option value="视频模型">视频模型</option>
                  </select>
                  <select className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={settingsValue(d.codexAspectRatio, '自动')} onChange={(e) => update({ codexAspectRatio: e.currentTarget.value })}>
                    <option value="自动">比例自动</option>
                    <option value="1:1">1:1</option>
                    <option value="16:9">16:9</option>
                    <option value="9:16">9:16</option>
                    <option value="4:3">4:3</option>
                    <option value="3:4">3:4</option>
                  </select>
                  <select className="nodrag rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexBatchVariantCount || 1)} onChange={(e) => update({ codexBatchVariantCount: Number(e.currentTarget.value) })}>
                    <option value="1">不批量</option>
                    <option value="4">批量变体 4</option>
                    <option value="8">批量变体 8</option>
                    <option value="16">批量变体 16</option>
                  </select>
                </div>
                <textarea className="nodrag min-h-[52px] rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexStyleLock || '')} placeholder="风格锁定：品牌色、角色固定设定、镜头语言、禁用词..." onChange={(e) => update({ codexStyleLock: e.currentTarget.value })} />
                <textarea className="nodrag min-h-[52px] rounded-lg border px-2 py-1.5 text-xs outline-none" style={{ borderColor: border, background: bg, color: text }} value={String(d.codexNegativePrompt || '')} placeholder="负面词 / 禁止出现内容" onChange={(e) => update({ codexNegativePrompt: e.currentTarget.value })} />
                <label className="nodrag flex items-center gap-2 text-xs" style={{ color: subText }}>
                  <input type="checkbox" checked={d.codexAutoNegativePrompt !== false} onChange={(e) => update({ codexAutoNegativePrompt: e.currentTarget.checked })} />
                  自动负面词
                </label>
              </div>
            </div>
          )}

          {inputMaterialTotal > 0 && (
            <div data-codex-simple-input-materials="true">
              <MaterialPreviewSection
                texts={orderedInputTexts}
                images={orderedImages}
                videos={orderedVideos}
                audios={orderedAudios}
                order={materialOrder}
                onReorder={setMaterialOrder}
                onExcludeUpstream={excludeUpstreamMaterial}
                excludedCount={excludedUpstreamCount}
                onRestoreExcluded={restoreExcludedMaterials}
                selected={selected}
                isDark={isDark}
                isPixel={isPixel}
                title="输入素材 · 上游参考"
              />
            </div>
          )}

              <div
                ref={simplePromptFrameRef}
                data-codex-simple-prompt-frame="simple"
                data-codex-prompt-frame-source="simple"
                className="codex-simple-prompt-frame rounded-xl border p-2"
                style={{ borderColor: accent, background: surface, boxShadow: isPixel ? undefined : '0 0 0 3px rgba(56,189,248,0.08)' }}
                onFocusCapture={() => {
                  if (trailingSlashSkillQuery(quickPrompt)) openSkillPickerFromPrompt('simple');
                }}
                onKeyDownCapture={(event) => {
                  if (event.key === '/') window.setTimeout(() => openSkillPickerFromPrompt('simple'), 0);
                  if (event.key === 'Escape' && skillPickerMode === 'slash') closeSkillPicker();
                }}
              >
            <div className="mb-1 flex items-center justify-between px-1 text-[11px]" style={{ color: subText }}>
              <span>输入提示词 / 对话</span>
              <span>@ 产物 / /Skill 可引用</span>
            </div>
            <MentionPromptInput
              value={quickPrompt}
              mentions={quickPromptMentions}
              materials={mentionMaterials}
              onChange={(value, mentions) => update({ codexQuickPrompt: value, codexQuickPromptMentions: mentions })}
              onSubmit={() => requestCanvasNodeRun(id)}
              placeholder="例如：/imagegen 生成一张未来感海报；也可 @ 引用素材继续改..."
              title="Codex 简约生成"
              promptTemplateKind="image"
              isDark={isDark}
              isPixel={isPixel}
              expandable
              className="rounded-lg px-2 py-2 text-sm outline-none"
              style={{ color: text, background: bg, minHeight: 180, height: 180 }}
            />
            {renderImagegenQuickParamBar('simple')}
          </div>

          <div className="grid grid-cols-4 gap-2 text-center text-[11px]">
            <div className="rounded-lg border p-2" style={{ borderColor: border, background: surface }}><FileText size={14} className="mx-auto mb-1" />{orderedTexts.length} 文本</div>
            <div className="rounded-lg border p-2" style={{ borderColor: border, background: surface }}><ImageIcon size={14} className="mx-auto mb-1" />{orderedImages.length} 图</div>
            <div className="rounded-lg border p-2" style={{ borderColor: border, background: surface }}><Video size={14} className="mx-auto mb-1" />{orderedVideos.length} 视频</div>
            <div className="rounded-lg border p-2" style={{ borderColor: border, background: surface }}><Music2 size={14} className="mx-auto mb-1" />{orderedAudios.length} 音频</div>
          </div>

          <div className="rounded-xl border p-3" style={{ borderColor: border, background: surface }}>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-black">完成反馈</div>
              {latestArtifact && (
                <div className="flex gap-1">
                  <button type="button" className="nodrag rounded-md p-1" style={buttonStyle} title="复制文本" onClick={() => void navigator.clipboard?.writeText?.(latestArtifact.text || artifactPrimaryUrl(latestArtifact) || '')}>
                    <Copy size={13} />
                  </button>
                  <button type="button" className="nodrag rounded-md p-1" style={buttonStyle} title="保存到资源库" onClick={() => void saveArtifactToResourceLibrary(latestArtifact, id).then((msg) => logBus.success(msg, `codex:${id}`)).catch((error) => logBus.error(error?.message || '保存失败', `codex:${id}`))}>
                    <Library size={13} />
                  </button>
                </div>
              )}
            </div>
            {renderSimpleCompletionSummary(latestArtifact)}
          </div>

          {d.error && (
            <div className="rounded-xl border px-3 py-2 text-xs" style={{ borderColor: danger, background: isDark ? 'rgba(251,113,133,0.12)' : 'rgba(254,226,226,0.9)', color: danger }}>
              {friendlyCodexErrorMessage(d.error)}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            {isBusy ? (
              <button
                type="button"
                className="nodrag inline-flex flex-1 items-center justify-center gap-2 px-4 py-2.5 text-sm font-black"
                style={{ ...buttonStyle, borderColor: danger, color: danger, background: isDark ? 'rgba(251,113,133,0.12)' : 'rgba(254,226,226,0.9)' }}
                onClick={codexStopRunning}
              >
                <X size={17} />
                停止运行
              </button>
            ) : (
              <button
                type="button"
                className="nodrag inline-flex flex-1 items-center justify-center gap-2 px-4 py-2.5 text-sm font-black"
                style={{ ...buttonStyle, background: accent, color: studioAccentText, borderColor: accent }}
                onClick={() => requestCanvasNodeRun(id)}
              >
                <Play size={17} />
                开始生成
              </button>
            )}
            <button type="button" className="nodrag inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-black" style={buttonStyle} onClick={() => setStudioOpen(true)}>
              <PanelRightOpen size={17} />
              创作台
            </button>
          </div>
        </div>
      </div>
      {studio}
      {studioToolPanel}
      {artifactZoomPortal}
      {skillPickerPortal}
    </>
  );
};

export default memo(CodexCliAgentNode);
