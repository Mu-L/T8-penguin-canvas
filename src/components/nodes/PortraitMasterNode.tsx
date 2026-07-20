import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Handle,
  Position,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  Copy,
  Download,
  FileText,
  Lock,
  PackagePlus,
  Play,
  RotateCcw,
  Search,
  Send,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Unlock,
  Upload as UploadIcon,
  UserRoundCog,
  X,
} from 'lucide-react';
import { PORT_COLOR } from '../../config/portTypes';
import * as api from '../../services/api';
import { useCanvasStore } from '../../stores/canvas';
import { logBus } from '../../stores/logs';
import {
  PORTRAIT_CATEGORIES,
  PORTRAIT_GROUPS,
  PORTRAIT_OPTION_BY_ID,
  buildPortraitPrompt,
  categoryOptionCount,
  clearCategorySelection,
  normalizePortraitLocks,
  normalizePortraitSelection,
  normalizePortraitWeights,
  portraitSelectionStats,
  randomizePortraitSelection,
  resolvePortraitPreview,
  summarizePortraitSelection,
  type PortraitLanguage,
  type PortraitLocks,
  type PortraitPreviewState,
  type PortraitSelection,
  type PortraitWeights,
} from '../../data/portraitMasterOptions';
import {
  PORTRAIT_ADVANCED_CATEGORIES,
  PORTRAIT_ADVANCED_GROUPS,
  PORTRAIT_ADVANCED_OPTION_BY_ID,
  buildPortraitAdvancedPrompt,
  categoryAdvancedOptionCount,
  clearAdvancedCategorySelection,
  normalizePortraitAdvancedLocks,
  normalizePortraitAdvancedSelection,
  normalizePortraitAdvancedWeights,
  portraitAdvancedStats,
  portraitSelectionLooksUnderage,
  randomizePortraitHiddenAdvanced,
  summarizePortraitAdvancedSelection,
} from '../../data/portraitMasterAdvancedOptions';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useThemeStore } from '../../stores/theme';
import { trackAchievementEvent } from '../../stores/achievements';
import { useHiddenFeatureStore, isYyhPortraitEnabled } from '../../stores/hiddenFeatures';
import { resolveThemeTemplate } from '../../theme/defaultTemplates';
import { materialSetItemFromText, materialSetItemsToData } from '../../utils/materialSet';
import { defaultSizeOf, placeBatchNodes, placeSingleNode, type Rect } from '../../utils/nodePlacement';
import { useUpdateNodeData } from './useUpdateNodeData';

const SCHEMA_VERSION = 2;
const PORTRAIT_FAVORITES_KEY = 't8:portrait-master:favorites:v1';
const MAX_PORTRAIT_FAVORITES = 40;

type PortraitRandomMode = 'all' | 'empty' | 'category' | 'unlocked';
type PortraitBatchMode = 'text-nodes' | 'material-set';

interface PortraitBackup {
  schema: 't8-portrait-master';
  version: number;
  title?: string;
  selection: PortraitSelection;
  locks: PortraitLocks;
  weights: PortraitWeights;
  advancedSelection?: PortraitSelection;
  advancedLocks?: PortraitLocks;
  advancedWeights?: PortraitWeights;
  customText: string;
  language: PortraitLanguage;
  prompt: string;
  exportedAt: string;
}

interface PortraitFavorite extends PortraitBackup {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

const STYLE_PACKS = [
  { id: 'any', label: '不限风格', hints: [] },
  { id: 'pure', label: '清纯', hints: ['清纯', '柔和', '自然', '白皙', '学院', '少女', 'soft', 'natural', 'gentle', 'fair', 'academy'] },
  { id: 'mature', label: '御姐', hints: ['御姐', '成熟', '冷艳', '高定', '高挑', 'elegant', 'mature', 'cool', 'high-fashion'] },
  { id: 'cyber', label: '赛博', hints: ['赛博', '未来', '机械', '冷光', 'cyber', 'futuristic', 'neon', 'mechanic'] },
  { id: 'ancient', label: '古风', hints: ['古典', '巫女', '王族', '花朵', '丝绸', 'classical', 'royal', 'shrine', 'ornate'] },
  { id: 'academy', label: '学院', hints: ['学院', '学生', '制服', '图书', 'academy', 'school', 'student', 'librarian'] },
  { id: 'dark', label: '暗黑', hints: ['暗黑', '哥特', '吸血鬼', '黑色', '冷感', 'gothic', 'dark', 'vampire', 'black'] },
  { id: 'idol', label: '偶像', hints: ['偶像', '歌手', '舞台', '亮片', 'idol', 'singer', 'stage', 'sparkle'] },
  { id: 'battle', label: '战斗', hints: ['战斗', '剑士', '忍者', '骑士', '战术', '伤痕', 'battle', 'swordsman', 'ninja', 'knight', 'tactical'] },
  { id: 'lolita', label: '洛丽塔', hints: ['人偶', '童话', '甜妹', '蝴蝶结', '娃娃', 'doll', 'storybook', 'sweet', 'ribbon', 'princess'] },
  { id: 'workplace', label: '职场', hints: ['都市', '医生', '侦探', '领袖', '利落', 'urban', 'doctor', 'detective', 'leader', 'clean sharp'] },
] as const;

type StylePackId = (typeof STYLE_PACKS)[number]['id'];

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeLanguage(value: unknown): PortraitLanguage {
  return value === 'zh' ? 'zh' : 'en';
}

function safeRandomMode(value: unknown): PortraitRandomMode {
  return value === 'all' || value === 'empty' || value === 'category' || value === 'unlocked' ? value : 'unlocked';
}

function safeStylePack(value: unknown): StylePackId {
  return STYLE_PACKS.some((pack) => pack.id === value) ? (value as StylePackId) : 'any';
}

function safeBatchMode(value: unknown): PortraitBatchMode {
  return value === 'material-set' ? 'material-set' : 'text-nodes';
}

function promptFromState(
  selection: PortraitSelection,
  weights: PortraitWeights,
  customText: string,
  language: PortraitLanguage,
  advancedSelection: PortraitSelection = {},
  advancedWeights: PortraitWeights = {},
  includeAdvanced = false,
): string {
  const basePrompt = buildPortraitPrompt({ selection, weights, customText: '', language });
  const advancedPrompt = includeAdvanced && !portraitSelectionLooksUnderage(selection)
    ? buildPortraitAdvancedPrompt({ selection: advancedSelection, weights: advancedWeights, language })
    : '';
  const custom = customText.trim();
  const separator = language === 'zh' ? '，' : ', ';
  return [basePrompt, advancedPrompt, custom].filter(Boolean).join(separator);
}

function buildPortraitBackup(params: {
  title?: string;
  selection: PortraitSelection;
  locks: PortraitLocks;
  weights: PortraitWeights;
  advancedSelection?: PortraitSelection;
  advancedLocks?: PortraitLocks;
  advancedWeights?: PortraitWeights;
  customText: string;
  language: PortraitLanguage;
  includeAdvanced?: boolean;
}): PortraitBackup {
  const advancedSelection = normalizePortraitAdvancedSelection(params.advancedSelection);
  const advancedLocks = normalizePortraitAdvancedLocks(params.advancedLocks);
  const advancedWeights = normalizePortraitAdvancedWeights(params.advancedWeights);
  const prompt = promptFromState(
    params.selection,
    params.weights,
    params.customText,
    params.language,
    advancedSelection,
    advancedWeights,
    Boolean(params.includeAdvanced),
  );
  return {
    schema: 't8-portrait-master',
    version: SCHEMA_VERSION,
    title: params.title,
    selection: params.selection,
    locks: params.locks,
    weights: params.weights,
    advancedSelection,
    advancedLocks,
    advancedWeights,
    customText: params.customText,
    language: params.language,
    prompt,
    exportedAt: new Date().toISOString(),
  };
}

function parsePortraitBackup(raw: unknown): PortraitBackup | null {
  if (!isRecord(raw) || raw.schema !== 't8-portrait-master') return null;
  const selection = normalizePortraitSelection(raw.selection);
  const locks = normalizePortraitLocks(raw.locks);
  const weights = normalizePortraitWeights(raw.weights);
  const advancedSelection = normalizePortraitAdvancedSelection(raw.advancedSelection);
  const advancedLocks = normalizePortraitAdvancedLocks(raw.advancedLocks);
  const advancedWeights = normalizePortraitAdvancedWeights(raw.advancedWeights);
  const customText = typeof raw.customText === 'string' ? raw.customText : '';
  const language = safeLanguage(raw.language);
  return buildPortraitBackup({
    title: typeof raw.title === 'string' ? raw.title.slice(0, 80) : undefined,
    selection,
    locks,
    weights,
    advancedSelection,
    advancedLocks,
    advancedWeights,
    customText,
    language,
  });
}

function loadPortraitFavorites(): PortraitFavorite[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PORTRAIT_FAVORITES_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const backup = parsePortraitBackup(item);
        if (!backup || !isRecord(item)) return null;
        const id = typeof item.id === 'string' && item.id ? item.id : `portrait-fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : backup.title || '未命名角色';
        return {
          ...backup,
          id,
          name,
          title: backup.title || name,
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : backup.exportedAt,
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : backup.exportedAt,
        } as PortraitFavorite;
      })
      .filter(Boolean)
      .slice(0, MAX_PORTRAIT_FAVORITES) as PortraitFavorite[];
  } catch {
    return [];
  }
}

function savePortraitFavorites(favorites: PortraitFavorite[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PORTRAIT_FAVORITES_KEY, JSON.stringify(favorites.slice(0, MAX_PORTRAIT_FAVORITES)));
  } catch {
    // localStorage may be disabled; ignore so the editor remains usable.
  }
}

function downloadJson(filename: string, payload: unknown) {
  if (typeof document === 'undefined') return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function seedFromString(value: string): number {
  const text = value.trim();
  if (!text) return Date.now() >>> 0;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pickStyledOption(groupId: string, rng: () => number, stylePackId: StylePackId) {
  const group = PORTRAIT_GROUPS.find((item) => item.id === groupId);
  if (!group || group.options.length === 0) return null;
  const pack = STYLE_PACKS.find((item) => item.id === stylePackId) || STYLE_PACKS[0];
  const hints = pack.hints.map((hint) => hint.toLowerCase());
  const pool = hints.length
    ? group.options.filter((option) => {
        const hay = `${option.label} ${option.labelEn} ${option.prompt}`.toLowerCase();
        return hints.some((hint) => hay.includes(hint));
      })
    : group.options;
  const options = pool.length > 0 ? pool : group.options;
  return options[Math.floor(rng() * options.length)] || null;
}

function applyPortraitConflictRules(selection: PortraitSelection): PortraitSelection {
  const out = { ...selection };
  if (out.outfit) {
    // 套装通常已经包含上下装形态，优先保留套装，避免 prompt 自相矛盾。
    delete out.top;
    delete out.bottom;
  }
  const hairAccessory = out.hairAccessory ? PORTRAIT_OPTION_BY_ID.get(out.hairAccessory) : null;
  if (hairAccessory && /帽|头盔|兜帽|hat|cap|helmet|hood/i.test(`${hairAccessory.label} ${hairAccessory.labelEn} ${hairAccessory.prompt}`)) {
    delete out.bangs;
  }
  return out;
}

function randomizePortraitAdvanced(params: {
  current: PortraitSelection;
  locks: PortraitLocks;
  mode: PortraitRandomMode;
  categoryId: string;
  stylePackId: StylePackId;
  seedText: string;
  offset?: number;
}): PortraitSelection {
  const rng = createRng((seedFromString(params.seedText) + (params.offset || 0) * 9973) >>> 0);
  const out: PortraitSelection = { ...params.current };
  const category = PORTRAIT_CATEGORIES.find((item) => item.id === params.categoryId);
  const categoryGroupIds = new Set(category?.groups.map((group) => group.id) || []);
  for (const group of PORTRAIT_GROUPS) {
    const locked = !!params.locks[group.id];
    const shouldRandomize =
      params.mode === 'all' ||
      (params.mode === 'empty' && !out[group.id]) ||
      (params.mode === 'category' && categoryGroupIds.has(group.id) && !locked) ||
      (params.mode === 'unlocked' && !locked);
    if (!shouldRandomize) continue;
    if (params.mode !== 'all' && locked) continue;
    if (rng() < 0.07) {
      delete out[group.id];
      continue;
    }
    const option = pickStyledOption(group.id, rng, params.stylePackId);
    if (option) out[group.id] = option.id;
  }
  return applyPortraitConflictRules(out);
}

function clampWeight(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.5, Math.min(1.8, n));
}

function shadeColor(hex: string, amount: number): string {
  const value = hex.replace('#', '');
  if (value.length !== 6) return hex;
  const n = Number.parseInt(value, 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (n & 255) + amount));
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

const PreviewEye = ({ x, preview }: { x: number; preview: PortraitPreviewState }) => {
  const stroke = '#191714';
  if (preview.eyeShape === 'cat' || preview.eyeShape === 'sharp') {
    return (
      <g transform={`translate(${x} 86)`}>
        <path d="M-12 0 Q0 -8 13 0 Q1 7 -12 0Z" fill="#fff8ec" stroke={stroke} strokeWidth="2" />
        <circle cx="1" cy="0" r="4.6" fill={preview.eye} />
        <circle cx="2" cy="-2" r="1.4" fill="#fff" opacity="0.9" />
      </g>
    );
  }
  if (preview.eyeShape === 'slender') {
    return (
      <g transform={`translate(${x} 86)`}>
        <path d="M-12 0 Q0 -5 12 0 Q0 5 -12 0Z" fill="#fff8ec" stroke={stroke} strokeWidth="2" />
        <circle cx="0" cy="0" r="3.7" fill={preview.eye} />
      </g>
    );
  }
  if (preview.eyeShape === 'droopy') {
    return (
      <g transform={`translate(${x} 87)`}>
        <path d="M-11 -2 Q0 -7 11 -1 Q1 7 -11 -2Z" fill="#fff8ec" stroke={stroke} strokeWidth="2" />
        <circle cx="0" cy="0" r="4.8" fill={preview.eye} />
        <circle cx="1.5" cy="-1.8" r="1.4" fill="#fff" opacity="0.9" />
      </g>
    );
  }
  return (
    <g transform={`translate(${x} 86)`}>
      <ellipse cx="0" cy="0" rx={preview.eyeShape === 'round' ? 8.4 : 7} ry={preview.eyeShape === 'round' ? 9 : 6.8} fill="#fff8ec" stroke={stroke} strokeWidth="2" />
      <circle cx="0" cy="0" r="4.8" fill={preview.eye} />
      <circle cx="1.6" cy="-2" r="1.4" fill="#fff" opacity="0.9" />
    </g>
  );
};

const PreviewMouth = ({ preview }: { preview: PortraitPreviewState }) => {
  const stroke = '#7b3630';
  if (preview.mouth === 'smile') return <path d="M91 121 Q110 136 129 121" fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" />;
  if (preview.mouth === 'soft-smile') return <path d="M97 123 Q110 130 123 123" fill="none" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" />;
  if (preview.mouth === 'open') return <ellipse cx="110" cy="124" rx="8" ry="5" fill={stroke} opacity="0.86" />;
  if (preview.mouth === 'smirk') return <path d="M94 123 Q111 131 128 119" fill="none" stroke={stroke} strokeWidth="2.8" strokeLinecap="round" />;
  if (preview.mouth === 'sad') return <path d="M96 128 Q110 119 124 128" fill="none" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" />;
  return <path d="M99 124 L122 124" stroke={stroke} strokeWidth="2.4" strokeLinecap="round" />;
};

const PreviewBrow = ({ x, flip, preview }: { x: number; flip?: boolean; preview: PortraitPreviewState }) => {
  const stroke = preview.brow === 'thick' ? shadeColor(preview.hair, -35) : '#2a211c';
  const width = preview.brow === 'thick' ? 4 : 3;
  let d = 'M-11 0 Q0 -5 11 0';
  if (preview.brow === 'straight') d = 'M-11 0 L11 0';
  if (preview.brow === 'sharp') d = flip ? 'M-12 4 L12 -4' : 'M-12 -4 L12 4';
  if (preview.brow === 'arched') d = 'M-12 2 Q0 -8 12 2';
  return <path d={d} transform={`translate(${x} 69)`} fill="none" stroke={stroke} strokeWidth={width} strokeLinecap="round" />;
};

const PreviewAccessory = ({ preview }: { preview: PortraitPreviewState }) => {
  const stroke = '#191714';
  if (preview.animalEars) {
    return (
      <g fill={preview.hair} stroke={stroke} strokeWidth="2">
        <path d="M72 44 L84 15 L94 52Z" />
        <path d="M126 52 L136 15 L148 44Z" />
      </g>
    );
  }
  if (preview.accessory === 'ribbon') {
    return (
      <g transform="translate(145 54)" fill={preview.accent} stroke={stroke} strokeWidth="2">
        <path d="M0 0 L20 -10 L18 12Z" />
        <path d="M0 0 L-19 -10 L-17 12Z" />
        <circle r="5" />
      </g>
    );
  }
  if (preview.accessory === 'flower') {
    return (
      <g transform="translate(147 58)" fill={preview.accent} stroke={stroke} strokeWidth="1.6">
        {[0, 60, 120, 180, 240, 300].map((angle) => (
          <ellipse key={angle} rx="5" ry="9" transform={`rotate(${angle}) translate(0 -7)`} />
        ))}
        <circle r="4" fill="#fff4c4" />
      </g>
    );
  }
  if (preview.accessory === 'crown') {
    return (
      <path d="M80 42 L91 24 L104 42 L119 22 L132 42 L132 51 L80 51Z" fill={preview.accent} stroke={stroke} strokeWidth="2" />
    );
  }
  if (preview.accessory === 'hat') {
    return (
      <g fill={shadeColor(preview.outfit, 18)} stroke={stroke} strokeWidth="2">
        <ellipse cx="110" cy="48" rx="54" ry="11" />
        <path d="M77 48 Q84 19 110 20 Q136 19 143 48Z" />
      </g>
    );
  }
  if (preview.accessory === 'veil') {
    return <path d="M65 45 Q110 15 155 45 L164 148 Q110 184 56 148Z" fill="#fff" opacity="0.25" stroke="#fff" strokeWidth="2" />;
  }
  if (preview.accessory === 'headband' || preview.accessory === 'forehead') {
    return (
      <g>
        <path d="M67 60 Q110 46 153 60" fill="none" stroke={preview.accent} strokeWidth="7" strokeLinecap="round" />
        {preview.accessory === 'forehead' && <rect x="94" y="49" width="32" height="16" rx="5" fill="#c8ccd4" stroke={stroke} strokeWidth="2" />}
      </g>
    );
  }
  return null;
};

const PreviewHair = ({ preview, layer }: { preview: PortraitPreviewState; layer: 'back' | 'front' }) => {
  const hair = preview.hair;
  const stroke = shadeColor(hair, -48);
  if (layer === 'back') {
    if (preview.hairShape === 'tails') {
      return (
        <g fill={hair} stroke={stroke} strokeWidth="2">
          <path d="M67 69 C30 82 25 142 49 172 C68 150 73 111 75 73Z" />
          <path d="M145 73 C151 111 155 150 174 172 C198 142 191 82 153 69Z" />
          <circle cx="67" cy="68" r="9" fill={preview.accent} />
          <circle cx="153" cy="68" r="9" fill={preview.accent} />
        </g>
      );
    }
    if (preview.hairShape === 'bun') {
      return (
        <g fill={hair} stroke={stroke} strokeWidth="2">
          <circle cx="110" cy="38" r="24" />
          <path d="M57 61 Q110 20 163 61 Q164 132 145 164 Q110 178 75 164 Q55 132 57 61Z" />
        </g>
      );
    }
    if (preview.hairShape === 'braid') {
      return (
        <g fill={hair} stroke={stroke} strokeWidth="2">
          <path d="M58 61 Q110 22 162 61 Q164 126 145 156 Q111 170 75 156 Q56 126 58 61Z" />
          {[0, 1, 2, 3].map((i) => (
            <ellipse key={i} cx="153" cy={110 + i * 20} rx="10" ry="13" transform={`rotate(${i % 2 ? 18 : -18} 153 ${110 + i * 20})`} />
          ))}
        </g>
      );
    }
    if (preview.hairShape === 'short' || preview.hairShape === 'bob') {
      return <path d="M61 58 Q110 20 159 58 Q171 105 152 140 Q110 162 68 140 Q49 105 61 58Z" fill={hair} stroke={stroke} strokeWidth="2" />;
    }
    if (preview.hairShape === 'updo') {
      return (
        <g fill={hair} stroke={stroke} strokeWidth="2">
          <ellipse cx="110" cy="44" rx="33" ry="22" />
          <path d="M61 63 Q110 25 159 63 Q162 112 144 139 Q110 151 76 139 Q58 112 61 63Z" />
        </g>
      );
    }
    return <path d="M57 60 Q110 18 163 60 C183 112 169 180 145 198 C132 181 123 159 110 145 C97 159 88 181 75 198 C51 180 37 112 57 60Z" fill={hair} stroke={stroke} strokeWidth="2" />;
  }

  const cap = (
    <path
      d="M62 61 Q110 21 158 61 C145 53 127 49 110 50 C93 49 75 53 62 61Z"
      fill={hair}
      stroke={stroke}
      strokeWidth="1.6"
    />
  );
  if (preview.bangs === 'none') {
    return (
      <g>
        {cap}
        <path d="M72 62 Q110 48 148 62" fill="none" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" opacity="0.65" />
      </g>
    );
  }
  if (preview.bangs === 'straight') {
    return (
      <g>
        {cap}
        <path d="M70 57 Q110 39 150 57 L146 79 Q110 72 74 79Z" fill={hair} stroke={stroke} strokeWidth="1.6" />
      </g>
    );
  }
  if (preview.bangs === 'side') {
    return (
      <g>
        {cap}
        <path d="M67 58 Q110 31 154 58 C132 67 113 79 82 105 Q75 83 67 58Z" fill={hair} stroke={stroke} strokeWidth="1.6" />
      </g>
    );
  }
  if (preview.bangs === 'curtain') {
    return (
      <g fill={hair} stroke={stroke} strokeWidth="1.6">
        {cap}
        <path d="M70 58 Q92 37 109 47 C98 65 89 84 78 104 Q72 82 70 58Z" />
        <path d="M150 58 Q128 37 111 47 C122 65 131 84 142 104 Q148 82 150 58Z" />
      </g>
    );
  }
  if (preview.bangs === 'covered') {
    return (
      <g>
        {cap}
        <path d="M64 57 Q111 27 154 58 C128 66 112 91 89 133 Q72 103 64 57Z" fill={hair} stroke={stroke} strokeWidth="1.6" />
      </g>
    );
  }
  if (preview.bangs === 'messy') {
    return (
      <g fill={hair} stroke={stroke} strokeWidth="1.5">
        {cap}
        <path d="M69 58 L82 89 L93 54 L102 95 L113 52 L124 92 L136 56 L150 82 L151 58 Q110 37 69 58Z" />
      </g>
    );
  }
  return (
    <g>
      {cap}
      <path d="M68 58 Q110 35 152 58 C137 66 126 72 111 82 C96 72 83 66 68 58Z" fill={hair} stroke={stroke} strokeWidth="1.6" />
    </g>
  );
};

const PreviewHairlineCover = ({ preview }: { preview: PortraitPreviewState }) => {
  const stroke = shadeColor(preview.hair, -48);
  return (
    <g>
      <path
        d="M64 87 C64 54 84 34 110 34 C136 34 156 54 156 87 C142 74 127 67 110 68 C93 67 78 74 64 87Z"
        fill={preview.hair}
        stroke={stroke}
        strokeWidth="1.7"
      />
      <path
        d="M70 77 C84 64 98 58 112 59 C126 58 140 64 150 77"
        fill="none"
        stroke={shadeColor(preview.hair, -22)}
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity="0.55"
      />
    </g>
  );
};

const PortraitAvatarPreview = ({ selection }: { selection: PortraitSelection }) => {
  const preview = resolvePortraitPreview(selection);
  const hair = selection.hairColor ? PORTRAIT_OPTION_BY_ID.get(selection.hairColor)?.label : '';
  const eyes = selection.eyes ? PORTRAIT_OPTION_BY_ID.get(selection.eyes)?.label : '';
  const outfitOptionId = selection.outfit || selection.top || '';
  const moodOptionId = selection.expression || selection.temperament || '';
  const outfit = outfitOptionId ? PORTRAIT_OPTION_BY_ID.get(outfitOptionId)?.label : '';
  const mood = moodOptionId ? PORTRAIT_OPTION_BY_ID.get(moodOptionId)?.label : '';
  const bgMix =
    preview.mood === 'cyber'
      ? `radial-gradient(circle at 50% 28%, ${preview.accent}55, transparent 36%), linear-gradient(135deg, ${preview.background}, #0d1320)`
      : preview.mood === 'dark'
        ? `radial-gradient(circle at 50% 24%, ${preview.accent}33, transparent 34%), linear-gradient(135deg, ${preview.background}, #15100f)`
        : `radial-gradient(circle at 50% 24%, color-mix(in srgb, var(--t8-accent) 22%, transparent), transparent 34%), linear-gradient(135deg, ${preview.background}44, var(--t8-bg-panel-muted))`;
  return (
    <div
      className="relative flex min-h-[270px] w-full flex-col overflow-hidden rounded-xl border px-4 pb-3 pt-9"
      style={{
        borderColor: 'var(--t8-border)',
        background: bgMix,
      }}
    >
      <div className="absolute left-3 top-3 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: 'var(--t8-text-dim)' }}>
        Avatar
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center pb-2">
      <svg className="h-[178px] w-full max-w-[232px] overflow-visible" viewBox="0 0 220 180" role="img" aria-label="肖像预览">
        <g>
          <ellipse cx="110" cy="166" rx="62" ry="10" fill="#000" opacity="0.12" />
        </g>
        <g>
          <path
            d="M61 174 C64 133 83 120 110 120 C137 120 156 133 159 174Z"
            fill={preview.outfit}
            stroke="#191714"
            strokeWidth="2.4"
            transform={`translate(110 0) scale(${preview.bodyScale} 1) translate(-110 0)`}
          />
        </g>
        <g>
          <path d="M93 125 L127 125 L133 153 Q110 164 87 153Z" fill={shadeColor(preview.skin, -8)} stroke="#191714" strokeWidth="2" />
          <PreviewHair preview={preview} layer="back" />
          <g transform={`translate(110 88) scale(${preview.headScaleX} ${preview.headScaleY}) translate(-110 -88)`}>
            <ellipse cx="110" cy="88" rx="43" ry="53" fill={preview.skin} stroke="#191714" strokeWidth="2.6" />
            <PreviewHairlineCover preview={preview} />
            {preview.blush !== 'transparent' && (
              <g fill={preview.blush} opacity="0.36">
                <ellipse cx="78" cy="107" rx="9" ry="5" />
                <ellipse cx="142" cy="107" rx="9" ry="5" />
              </g>
            )}
            <PreviewBrow x={86} preview={preview} />
            <PreviewBrow x={134} preview={preview} flip />
            <PreviewEye x={86} preview={preview} />
            <PreviewEye x={134} preview={preview} />
            <path d="M110 91 Q105 106 111 111" fill="none" stroke="#9f6a58" strokeWidth="2" strokeLinecap="round" />
            <PreviewMouth preview={preview} />
            {preview.mark === 'scar' && <path d="M139 79 L151 91 M143 78 L149 84" stroke="#8d2e2e" strokeWidth="2" strokeLinecap="round" />}
            {preview.mark === 'tattoo' && <path d="M73 95 q9 -15 18 0 q-9 11 -18 0Z" fill="none" stroke={preview.accent} strokeWidth="2" />}
            {preview.mark === 'magic' && <path d="M146 99 l5 8 l8 1 l-7 5 l1 8 l-7 -4 l-7 4 l1 -8 l-7 -5 l8 -1Z" fill={preview.accent} opacity="0.8" />}
            {preview.mark === 'freckles' && (
              <g fill="#9a6b52" opacity="0.65">
                <circle cx="76" cy="104" r="1.4" /><circle cx="84" cy="111" r="1.2" /><circle cx="136" cy="111" r="1.2" /><circle cx="144" cy="104" r="1.4" />
              </g>
            )}
          </g>
          <PreviewHair preview={preview} layer="front" />
          <PreviewAccessory preview={preview} />
          {preview.glasses && (
            <g fill="none" stroke="#191714" strokeWidth="2">
              <circle cx="86" cy="86" r="13" />
              <circle cx="134" cy="86" r="13" />
              <path d="M99 86 H121" />
            </g>
          )}
          <g opacity="0.34" stroke="var(--t8-text-main)" strokeWidth="1">
            <path d="M48 156 C70 141 84 137 110 140 C136 137 150 141 172 156" fill="none" />
          </g>
        </g>
      </svg>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-1.5 text-[11px]" style={{ color: 'var(--t8-text-muted)' }}>
        {[hair, eyes, outfit, mood].filter(Boolean).slice(0, 4).map((item) => (
          <span key={item} className="truncate rounded px-1.5 py-0.5" style={{ background: 'var(--t8-bg-panel-elevated)' }}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
};

const PortraitMasterNode = ({ id, data, selected }: NodeProps) => {
  const update = useUpdateNodeData(id);
  const rf = useReactFlow();
  const { activeId, canvases, loadCanvases } = useCanvasStore();
  const { templateId, customTemplates } = useThemeStore();
  const yyhPortraitIds = useHiddenFeatureStore((s) => s.yyhPortraitIds);
  const d = (data as any) || {};
  const activeTemplate = useMemo(
    () => resolveThemeTemplate(templateId, customTemplates),
    [templateId, customTemplates],
  );
  const isYyhVisual = activeTemplate.visuals?.style === 'yyh';
  const yyhHiddenMode = Boolean(isYyhVisual && isYyhPortraitEnabled(yyhPortraitIds, id));

  const jsonInputRef = useRef<HTMLInputElement | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [activeCategoryId, setActiveCategoryId] = useState(PORTRAIT_CATEGORIES[0]?.id || 'base');
  const [activeAdvancedCategoryId, setActiveAdvancedCategoryId] = useState(PORTRAIT_ADVANCED_CATEGORIES[0]?.id || 'hidden-lingerie');
  const [showAdvancedPanel, setShowAdvancedPanel] = useState(false);
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [favoriteName, setFavoriteName] = useState('');
  const [favorites, setFavorites] = useState<PortraitFavorite[]>(() => loadPortraitFavorites());
  const [randomMode, setRandomMode] = useState<PortraitRandomMode>('unlocked');
  const [stylePackId, setStylePackId] = useState<StylePackId>('any');
  const [randomSeed, setRandomSeed] = useState('');
  const [batchCount, setBatchCount] = useState(3);
  const [batchMode, setBatchMode] = useState<PortraitBatchMode>('text-nodes');
  const [targetCanvasId, setTargetCanvasId] = useState('');
  const [hiddenRandomEnabled, setHiddenRandomEnabled] = useState(false);
  const [resourceDialogOpen, setResourceDialogOpen] = useState(false);
  const [resourceCategories, setResourceCategories] = useState<api.ResourceCategory[]>([]);
  const [resourceCategoryId, setResourceCategoryId] = useState('set_uncategorized');
  const [resourceTitle, setResourceTitle] = useState('');
  const [resourceTags, setResourceTags] = useState('portrait-master, 肖像大师, 角色');
  const [resourceFavorite, setResourceFavorite] = useState(true);
  const [resourceSaving, setResourceSaving] = useState(false);
  const [resourceMessage, setResourceMessage] = useState('');

  const openEditor = useCallback(() => {
    rf.setNodes((nodes) =>
      nodes.map((node) => (node.id === id && node.selected ? { ...node, selected: false } : node)),
    );
    setIsEditorOpen(true);
  }, [id, rf]);

  const closeEditor = useCallback(() => {
    setIsEditorOpen(false);
  }, []);

  const selection = useMemo(() => normalizePortraitSelection(d.portraitSelection), [d.portraitSelection]);
  const locks = useMemo(() => normalizePortraitLocks(d.portraitLocks), [d.portraitLocks]);
  const weights = useMemo(() => normalizePortraitWeights(d.portraitWeights), [d.portraitWeights]);
  const advancedSelection = useMemo(() => normalizePortraitAdvancedSelection(d.portraitAdvancedSelection), [d.portraitAdvancedSelection]);
  const advancedLocks = useMemo(() => normalizePortraitAdvancedLocks(d.portraitAdvancedLocks), [d.portraitAdvancedLocks]);
  const advancedWeights = useMemo(() => normalizePortraitAdvancedWeights(d.portraitAdvancedWeights), [d.portraitAdvancedWeights]);
  const customText = typeof d.portraitCustomText === 'string' ? d.portraitCustomText : '';
  const language = safeLanguage(d.portraitLanguage);
  const hiddenBlockedByBase = yyhHiddenMode && portraitSelectionLooksUnderage(selection);
  const prompt = useMemo(
    () => promptFromState(selection, weights, customText, language, advancedSelection, advancedWeights, yyhHiddenMode),
    [selection, weights, customText, language, advancedSelection, advancedWeights, yyhHiddenMode],
  );
  const stats = portraitSelectionStats(selection);
  const advancedStats = portraitAdvancedStats(advancedSelection);
  const summary = summarizePortraitSelection(selection, 'zh');
  const advancedSummary = summarizePortraitAdvancedSelection(advancedSelection, 'zh');
  const activeCategory = PORTRAIT_CATEGORIES.find((item) => item.id === activeCategoryId) || PORTRAIT_CATEGORIES[0];
  const activeAdvancedCategory = PORTRAIT_ADVANCED_CATEGORIES.find((item) => item.id === activeAdvancedCategoryId) || PORTRAIT_ADVANCED_CATEGORIES[0];
  const editorCategory = showAdvancedPanel && yyhHiddenMode ? activeAdvancedCategory : activeCategory;
  const selectedTargetCanvasId = targetCanvasId || activeId || canvases[0]?.id || '';
  const selectedTargetCanvas = canvases.find((canvas) => canvas.id === selectedTargetCanvasId) || null;

  const commit = useCallback(
    (patch: Record<string, any>) => {
      const nextSelection = normalizePortraitSelection(patch.portraitSelection ?? selection);
      const nextWeights = normalizePortraitWeights(patch.portraitWeights ?? weights);
      const nextAdvancedSelection = normalizePortraitAdvancedSelection(patch.portraitAdvancedSelection ?? advancedSelection);
      const nextAdvancedWeights = normalizePortraitAdvancedWeights(patch.portraitAdvancedWeights ?? advancedWeights);
      const nextCustomText = typeof patch.portraitCustomText === 'string' ? patch.portraitCustomText : customText;
      const nextLanguage = safeLanguage(patch.portraitLanguage ?? language);
      const includeAdvanced = Boolean(patch.portraitAdvancedEnabled ?? yyhHiddenMode);
      const advancedBlocked = includeAdvanced && portraitSelectionLooksUnderage(nextSelection);
      const nextPrompt = promptFromState(
        nextSelection,
        nextWeights,
        nextCustomText,
        nextLanguage,
        nextAdvancedSelection,
        nextAdvancedWeights,
        includeAdvanced,
      );
      const portraitMetadata = {
        schema: 't8-portrait-master',
        version: SCHEMA_VERSION,
        selection: nextSelection,
        weights: nextWeights,
        advancedSelection: nextAdvancedSelection,
        advancedWeights: nextAdvancedWeights,
        advancedEnabled: includeAdvanced,
        advancedBlocked,
        customText: nextCustomText,
        language: nextLanguage,
        prompt: nextPrompt,
        preview: resolvePortraitPreview(nextSelection),
      };
      update({
        ...patch,
        prompt: nextPrompt,
        text: nextPrompt,
        outputText: nextPrompt,
        portraitMetadata,
        portraitSummary: summarizePortraitSelection(nextSelection, 'zh'),
        portraitStats: portraitSelectionStats(nextSelection),
        portraitAdvancedSummary: summarizePortraitAdvancedSelection(nextAdvancedSelection, 'zh'),
        portraitAdvancedStats: portraitAdvancedStats(nextAdvancedSelection),
        yyhPortraitHidden: includeAdvanced,
        portraitSchemaVersion: SCHEMA_VERSION,
      });
    },
    [advancedSelection, advancedWeights, customText, language, selection, update, weights, yyhHiddenMode],
  );

  useEffect(() => {
    const advancedEnabled = yyhHiddenMode;
    const advancedBlocked = advancedEnabled && portraitSelectionLooksUnderage(selection);
    const hiddenFlag = advancedEnabled;
    if (d.prompt === prompt && Boolean(d.yyhPortraitHidden) === hiddenFlag) return;
    update({
      prompt,
      text: prompt,
      outputText: prompt,
      portraitMetadata: {
        schema: 't8-portrait-master',
        version: SCHEMA_VERSION,
        selection,
        weights,
        advancedSelection,
        advancedWeights,
        advancedEnabled,
        advancedBlocked,
        customText,
        language,
        prompt,
        preview: resolvePortraitPreview(selection),
      },
      portraitSummary: summarizePortraitSelection(selection, 'zh'),
      portraitStats: portraitSelectionStats(selection),
      portraitAdvancedSummary: advancedSummary,
      portraitAdvancedStats: advancedStats,
      yyhPortraitHidden: hiddenFlag,
      portraitSchemaVersion: SCHEMA_VERSION,
    });
  }, [
    advancedSelection,
    advancedStats,
    advancedSummary,
    advancedWeights,
    customText,
    d.prompt,
    d.yyhPortraitHidden,
    language,
    prompt,
    selection,
    update,
    weights,
    yyhHiddenMode,
  ]);

  const currentBackup = useCallback(
    (title?: string) => buildPortraitBackup({
      title,
      selection,
      locks,
      weights,
      advancedSelection,
      advancedLocks,
      advancedWeights,
      customText,
      language,
      includeAdvanced: yyhHiddenMode,
    }),
    [advancedLocks, advancedSelection, advancedWeights, customText, language, locks, selection, weights, yyhHiddenMode],
  );

  const applyBackup = useCallback(
    (backup: PortraitBackup) => {
      commit({
        portraitSelection: backup.selection,
        portraitLocks: backup.locks,
        portraitWeights: backup.weights,
        portraitAdvancedSelection: backup.advancedSelection || {},
        portraitAdvancedLocks: backup.advancedLocks || {},
        portraitAdvancedWeights: backup.advancedWeights || {},
        portraitCustomText: backup.customText,
        portraitLanguage: backup.language,
      });
      logBus.success('已应用肖像角色配置', '肖像大师');
    },
    [commit],
  );

  const selectOption = (groupId: string, optionId: string) => {
    const next = { ...selection };
    if (optionId) next[groupId] = optionId;
    else delete next[groupId];
    commit({ portraitSelection: next });
  };

  const toggleLock = (groupId: string) => {
    const next: PortraitLocks = { ...locks, [groupId]: !locks[groupId] };
    commit({ portraitLocks: next });
  };

  const changeWeight = (groupId: string, value: string) => {
    const next: PortraitWeights = { ...weights, [groupId]: clampWeight(value) };
    commit({ portraitWeights: next });
  };

  const clearCategory = (categoryId: string) => {
    commit({ portraitSelection: clearCategorySelection(selection, categoryId) });
  };

  const selectAdvancedOption = (groupId: string, optionId: string) => {
    const next = { ...advancedSelection };
    if (optionId) next[groupId] = optionId;
    else delete next[groupId];
    commit({ portraitAdvancedSelection: next, portraitAdvancedEnabled: yyhHiddenMode });
  };

  const toggleAdvancedLock = (groupId: string) => {
    const next: PortraitLocks = { ...advancedLocks, [groupId]: !advancedLocks[groupId] };
    commit({ portraitAdvancedLocks: next, portraitAdvancedEnabled: yyhHiddenMode });
  };

  const changeAdvancedWeight = (groupId: string, value: string) => {
    const next: PortraitWeights = { ...advancedWeights, [groupId]: clampWeight(value) };
    commit({ portraitAdvancedWeights: next, portraitAdvancedEnabled: yyhHiddenMode });
  };

  const clearAdvancedCategory = (categoryId: string) => {
    commit({
      portraitAdvancedSelection: clearAdvancedCategorySelection(advancedSelection, categoryId),
      portraitAdvancedEnabled: yyhHiddenMode,
    });
  };

  const handleHiddenRandom = (categoryId?: string) => {
    if (!yyhHiddenMode || hiddenBlockedByBase) {
      logBus.warn('隐藏高级词条仅支持成年角色设定，当前基础人物不会输出隐藏词条。', '肖像大师');
      return;
    }
    const next = randomizePortraitHiddenAdvanced({
      current: advancedSelection,
      locks: advancedLocks,
      categoryId,
      seed: seedFromString(randomSeed || `${Date.now()}`),
    });
    commit({ portraitAdvancedSelection: next, portraitAdvancedEnabled: true });
  };

  const handleRandom = () => {
    const next = randomizePortraitAdvanced({
      current: selection,
      locks,
      mode: randomMode,
      categoryId: activeCategory.id,
      stylePackId,
      seedText: randomSeed,
    });
    const patch: Record<string, any> = { portraitSelection: next };
    if (yyhHiddenMode && hiddenRandomEnabled && !portraitSelectionLooksUnderage(next)) {
      patch.portraitAdvancedSelection = randomizePortraitHiddenAdvanced({
        current: advancedSelection,
        locks: advancedLocks,
        seed: seedFromString(randomSeed || `${Date.now()}`),
      });
      patch.portraitAdvancedEnabled = true;
    }
    commit(patch);
  };

  const handleQuickRandom = () => {
    const next = randomizePortraitSelection({ current: selection, locks });
    commit({ portraitSelection: applyPortraitConflictRules(next) });
  };

  const handleCopy = () => {
    if (!prompt.trim() || typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  };

  const handleExportJson = () => {
    const title = favoriteName.trim() || summary || 'portrait-master';
    downloadJson(`t8-portrait-master-${Date.now()}.json`, currentBackup(title));
  };

  const openSaveResourceDialog = async () => {
    const name = (favoriteName.trim() || summary || '未命名角色').slice(0, 80);
    setResourceTitle(`${name} · 肖像配置`);
    setResourceTags('portrait-master, 肖像大师, 角色');
    setResourceFavorite(true);
    setResourceMessage('');
    setResourceDialogOpen(true);
    try {
      const cats = await api.getResourceCategories('set');
      if (cats.success) {
        setResourceCategories(cats.data);
        const preferred = cats.data.find((cat) => cat.name === '角色' || cat.name === '肖像角色') || cats.data.find((cat) => cat.id === 'set_uncategorized') || cats.data[0];
        if (preferred) setResourceCategoryId(preferred.id);
        return;
      }
    } catch (e: any) {
      setResourceMessage(e?.message || '读取资源库分类失败');
    }
  };

  const handleCreateResourceCategory = async () => {
    const name = window.prompt('新建资源库分类', '角色');
    if (!name?.trim()) return;
    const created = await api.addResourceCategory('set', name.trim());
    if (created.success) {
      setResourceCategories((prev) => [...prev, created.data]);
      setResourceCategoryId(created.data.id);
      setResourceMessage(`已新建分类：${created.data.name}`);
    } else {
      setResourceMessage(created.error || '新建分类失败');
    }
  };

  const handleSaveToResourceLibrary = async () => {
    const title = (resourceTitle.trim() || favoriteName.trim() || summary || '未命名角色').slice(0, 100);
    const roleName = title.replace(/·\s*肖像配置$/, '').trim() || title;
    const backup = currentBackup(roleName);
    const text = JSON.stringify(backup, null, 2);
    const tags = resourceTags
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 20);
    setResourceSaving(true);
    setResourceMessage('');
    try {
      const saved = await api.addResourceSet({
        materialSetKind: 'text',
        materialSetItems: [{
          kind: 'text',
          text,
          name: `${roleName}.portrait.json`,
          mime: 'application/json',
        }],
        categoryId: resourceCategoryId,
        title,
        tags: tags.length ? tags : ['portrait-master', '肖像大师', '角色'],
        sourceNodeId: id,
        sourceCanvasId: activeId || '',
        favorite: resourceFavorite,
      });
      if (!saved.success) throw new Error(saved.error || '保存资源库失败');
      window.dispatchEvent(new CustomEvent('penguin:resources-changed'));
      logBus.success((saved as any).duplicate ? '资源库已有相同肖像配置' : '已保存到资源库', '肖像大师');
      setResourceMessage((saved as any).duplicate ? '资源库已有相同肖像配置，已更新分类' : '已保存到资源库');
      window.setTimeout(() => setResourceDialogOpen(false), 650);
    } catch (e: any) {
      const msg = e?.message || '保存到资源库失败';
      setResourceMessage(msg);
      logBus.warn(msg, '肖像大师');
    } finally {
      setResourceSaving(false);
    }
  };

  const handleImportJson = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        const libraryRoles = isRecord(parsed) && parsed.schema === 't8-portrait-master-library' && Array.isArray(parsed.roles)
          ? parsed.roles
          : null;
        if (libraryRoles) {
          const imported = libraryRoles
            .map((item) => {
              const backup = parsePortraitBackup(item);
              if (!backup || !isRecord(item)) return null;
              return {
                ...backup,
                id: typeof item.id === 'string' && item.id ? item.id : `portrait-fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : backup.title || '导入角色',
                createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              } as PortraitFavorite;
            })
            .filter(Boolean) as PortraitFavorite[];
          if (imported.length === 0) throw new Error('角色库 JSON 里没有有效角色');
          const next = [...imported, ...favorites]
            .filter((item, index, arr) => arr.findIndex((x) => x.id === item.id) === index)
            .slice(0, MAX_PORTRAIT_FAVORITES);
          setFavorites(next);
          savePortraitFavorites(next);
          logBus.success(`已导入 ${imported.length} 个肖像角色`, '肖像大师');
          return;
        }
        const backup = parsePortraitBackup(parsed);
        if (!backup) throw new Error('不是有效的肖像大师 JSON');
        applyBackup(backup);
      } catch (e: any) {
        logBus.warn(e?.message || '导入肖像 JSON 失败', '肖像大师');
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleSaveFavorite = () => {
    const now = new Date().toISOString();
    const name = (favoriteName.trim() || summary || '未命名角色').slice(0, 80);
    const backup = currentBackup(name);
    const fav: PortraitFavorite = {
      ...backup,
      id: `portrait-fav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      title: name,
      createdAt: now,
      updatedAt: now,
    };
    const next = [fav, ...favorites.filter((item) => item.name !== name)].slice(0, MAX_PORTRAIT_FAVORITES);
    setFavorites(next);
    savePortraitFavorites(next);
    setFavoriteName('');
    logBus.success(`已收藏角色：${name}`, '肖像大师');
  };

  const handleDeleteFavorite = (favoriteId: string) => {
    const next = favorites.filter((item) => item.id !== favoriteId);
    setFavorites(next);
    savePortraitFavorites(next);
  };

  const createTextNodesOnCurrentCanvas = (texts: string[], sourceLabel = 'portrait-master-text') => {
    const valid = texts.map((text) => text.trim()).filter(Boolean);
    if (valid.length === 0) {
      logBus.warn('没有可输出的 prompt', '肖像大师');
      return;
    }
    const nodes = rf.getNodes();
    const me = rf.getNode(id);
    const myW = (me as any)?.measured?.width || (me as any)?.width || 560;
    const baseX = (me?.position?.x ?? 0) + myW + 80;
    const baseY = me?.position?.y ?? 0;
    const size = defaultSizeOf('text');
    const desired: Rect[] = valid.map((_, index) => ({
      x: baseX + (index % 2) * (size.w + 36),
      y: baseY + Math.floor(index / 2) * (size.h + 36),
      w: size.w,
      h: size.h,
    }));
    const off = placeBatchNodes(desired, nodes, { source: `placement:${sourceLabel}` });
    const ts = Date.now();
    const newNodes = valid.map((text, index) => ({
      id: `text-portrait-${ts}-${index}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'text',
      position: { x: desired[index].x + off.dx, y: desired[index].y + off.dy },
      data: { prompt: text, text },
      selected: false,
    })) as Node[];
    rf.addNodes(newNodes);
    logBus.success(`已生成 ${newNodes.length} 个文本节点`, '肖像大师');
  };

  const createMaterialSetOnCurrentCanvas = (texts: string[]) => {
    const items = texts.map((text) => materialSetItemFromText(text)).filter(Boolean);
    if (items.length === 0) {
      logBus.warn('没有可输出为素材集的 prompt', '肖像大师');
      return;
    }
    const nodes = rf.getNodes();
    const me = rf.getNode(id);
    const myW = (me as any)?.measured?.width || (me as any)?.width || 560;
    const baseX = (me?.position?.x ?? 0) + myW + 80;
    const baseY = me?.position?.y ?? 0;
    const pos = placeSingleNode(baseX, baseY, 'material-set', nodes, { source: `placement:portrait-master-material-set:${id}` });
    const newNode: Node = {
      id: `material-set-portrait-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'material-set',
      position: pos,
      data: materialSetItemsToData('text', items as any),
      selected: false,
    } as Node;
    rf.addNodes(newNode);
    logBus.success(`已生成 ${items.length} 条文本素材集`, '肖像大师');
  };

  const createPortraitNodeData = (backup: PortraitBackup) => ({
    portraitLanguage: backup.language,
    portraitSelection: backup.selection,
    portraitLocks: backup.locks,
    portraitWeights: backup.weights,
    portraitAdvancedSelection: backup.advancedSelection || {},
    portraitAdvancedLocks: backup.advancedLocks || {},
    portraitAdvancedWeights: backup.advancedWeights || {},
    portraitCustomText: backup.customText,
    prompt: backup.prompt,
    text: backup.prompt,
    outputText: backup.prompt,
    portraitMetadata: {
      schema: 't8-portrait-master',
      version: SCHEMA_VERSION,
      selection: backup.selection,
      locks: backup.locks,
      weights: backup.weights,
      advancedSelection: backup.advancedSelection || {},
      advancedWeights: backup.advancedWeights || {},
      advancedEnabled: Boolean(backup.advancedSelection && Object.keys(backup.advancedSelection).length > 0),
      advancedBlocked: portraitSelectionLooksUnderage(backup.selection),
      customText: backup.customText,
      language: backup.language,
      prompt: backup.prompt,
      preview: resolvePortraitPreview(backup.selection),
    },
    portraitSummary: summarizePortraitSelection(backup.selection, 'zh'),
    portraitStats: portraitSelectionStats(backup.selection),
    portraitSchemaVersion: SCHEMA_VERSION,
  });

  const appendNodeToCanvas = async (targetId: string, type: 'portrait-master' | 'text', nodeData: Record<string, any>) => {
    if (!targetId) {
      logBus.warn('请选择目标画布', '肖像大师');
      return;
    }
    const targetIsCurrent = targetId === activeId;
    if (targetIsCurrent) {
      const nodes = rf.getNodes();
      const me = rf.getNode(id);
      const myW = (me as any)?.measured?.width || (me as any)?.width || 560;
      const pos = placeSingleNode((me?.position?.x ?? 0) + myW + 80, me?.position?.y ?? 0, type, nodes, {
        source: `placement:portrait-master-send-current:${type}`,
      });
      rf.addNodes({
        id: `${type}-portrait-send-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        position: pos,
        data: nodeData,
        selected: false,
      } as Node);
      logBus.success(`已发送到当前画布：${type === 'text' ? '文本节点' : '肖像大师配置'}`, '肖像大师');
      return;
    }
    try {
      const canvas = await api.getCanvasData(targetId);
      const targetNodes = Array.isArray(canvas.nodes) ? (canvas.nodes as Node[]) : [];
      const maxRight = targetNodes.reduce((right, node) => {
        const w = (node as any)?.measured?.width || (node as any)?.width || defaultSizeOf(String(node.type || '')).w;
        return Math.max(right, (node.position?.x ?? 0) + w);
      }, 0);
      const pos = placeSingleNode(maxRight + 80, 80, type, targetNodes, {
        source: `placement:portrait-master-send-target:${type}`,
      });
      const newNode: Node = {
        id: `${type}-portrait-send-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        position: pos,
        data: nodeData,
        selected: false,
      } as Node;
      await api.saveCanvasData(targetId, {
        nodes: [...targetNodes, newNode],
        edges: Array.isArray(canvas.edges) ? canvas.edges : [],
        viewport: canvas.viewport || { x: 0, y: 0, zoom: 1 },
      });
      await loadCanvases();
      logBus.success(`已发送到${selectedTargetCanvas?.name || '目标画布'}`, '肖像大师');
    } catch (e: any) {
      logBus.warn(e?.message || '发送到目标画布失败', '肖像大师');
    }
  };

  const handleCreateTextNode = () => {
    createTextNodesOnCurrentCanvas([prompt], 'portrait-master-single-text');
  };

  const handleSendPortraitConfig = () => {
    const backup = currentBackup(favoriteName.trim() || summary || '肖像大师配置');
    void appendNodeToCanvas(selectedTargetCanvasId, 'portrait-master', createPortraitNodeData(backup));
  };

  const handleSendPromptText = () => {
    const finalPrompt = prompt.trim();
    if (!finalPrompt) {
      logBus.warn('当前 prompt 为空', '肖像大师');
      return;
    }
    void appendNodeToCanvas(selectedTargetCanvasId, 'text', { prompt: finalPrompt, text: finalPrompt });
  };

  const handleBatchGenerate = () => {
    const count = Math.max(1, Math.min(24, Math.floor(Number(batchCount) || 1)));
    const baseSeed = randomSeed.trim() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const batchRandomMode = randomMode === 'empty' ? 'unlocked' : randomMode;
    const prompts: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < count; i += 1) {
      let text = '';
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const seedText = `${baseSeed}:batch-${i + 1}:try-${attempt + 1}`;
        const nextSelection = randomizePortraitAdvanced({
          current: selection,
          locks,
          mode: batchRandomMode,
          categoryId: activeCategory.id,
          stylePackId,
          seedText,
          offset: i + attempt * count + 1,
        });
        const nextAdvancedSelection = yyhHiddenMode && hiddenRandomEnabled && !portraitSelectionLooksUnderage(nextSelection)
          ? randomizePortraitHiddenAdvanced({
              current: advancedSelection,
              locks: advancedLocks,
              seed: seedFromString(`${seedText}:advanced`),
            })
          : advancedSelection;
        text = promptFromState(
          nextSelection,
          weights,
          customText,
          language,
          nextAdvancedSelection,
          advancedWeights,
          yyhHiddenMode,
        ).trim();
        if (!text || !seen.has(text)) break;
      }
      if (text) prompts.push(text);
      if (text) seen.add(text);
    }
    if (batchMode === 'material-set') createMaterialSetOnCurrentCanvas(prompts);
    else createTextNodesOnCurrentCanvas(prompts, 'portrait-master-batch-text');
  };

  const handleRun = async () => {
    const finalPrompt = prompt.trim();
    if (!finalPrompt) {
      const msg = '请先选择肖像特征或填写补充描述';
      setError(msg);
      throw new Error(msg);
    }
    setError('');
    update({
      prompt: finalPrompt,
      text: finalPrompt,
      outputText: finalPrompt,
      portraitMetadata: {
        schema: 't8-portrait-master',
        version: SCHEMA_VERSION,
        selection,
        weights,
        advancedSelection,
        advancedWeights,
        advancedEnabled: yyhHiddenMode,
        advancedBlocked: hiddenBlockedByBase,
        customText,
        language,
        prompt: finalPrompt,
        preview: resolvePortraitPreview(selection),
      },
      status: 'success',
    });
    if (yyhHiddenMode) {
      trackAchievementEvent({ type: 'hidden_mode.used', theme: 'yyh', kind: 'yyh-portrait', mode: 'used', nodeType: 'portrait-master' });
    }

    const nodes = rf.getNodes();
    const edges = rf.getEdges();
    const downstreamOutputIds = new Set(
      edges
        .filter((edge) => edge.source === id)
        .map((edge) => nodes.find((node) => node.id === edge.target))
        .filter((node): node is Node => !!node && node.type === 'output')
        .map((node) => node.id),
    );

    if (downstreamOutputIds.size > 0) {
      rf.setNodes((nds) =>
        nds.map((node) => {
          if (!downstreamOutputIds.has(node.id)) return node;
          const nd = (node.data as any) || {};
          const nextHidden = yyhHiddenMode;
          if (nd.directOutputText === finalPrompt && Boolean(nd.yyhPortraitHidden) === nextHidden) return node;
          return { ...node, data: { ...nd, directOutputText: finalPrompt, yyhPortraitHidden: nextHidden, yyhPortraitSourceNodeId: id } };
        }),
      );
      return;
    }

    const me = rf.getNode(id);
    const myW = (me as any)?.measured?.width || (me as any)?.width || 560;
    const baseX = (me?.position?.x ?? 0) + myW + 80;
    const baseY = me?.position?.y ?? 0;
    const pos = placeSingleNode(baseX, baseY, 'output', nodes, { source: `placement:portrait-master-output:${id}` });
    const ts = Date.now();
    const newId = `output-auto-portrait-master-${id}-${ts}-${Math.random().toString(36).slice(2, 6)}`;
    const newNode: Node = {
      id: newId,
      type: 'output',
      position: pos,
      data: { directOutputText: finalPrompt, yyhPortraitHidden: yyhHiddenMode, yyhPortraitSourceNodeId: id },
      selected: false,
    } as Node;
    const newEdge: Edge = {
      id: `e-auto-portrait-master-${newId}`,
      source: id,
      target: newId,
      type: 'deletable',
      className: yyhHiddenMode ? 'yyh-portrait-hidden-edge' : undefined,
      data: yyhHiddenMode ? { yyhPortraitHiddenEdge: true } : undefined,
    } as Edge;
    rf.addNodes(newNode);
    rf.setEdges((eds) => [...eds, newEdge]);
  };

  useRunTrigger(id, handleRun);

  const filteredOptionIds = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return null;
    const groups = showAdvancedPanel && yyhHiddenMode ? activeAdvancedCategory.groups : activeCategory.groups;
    return new Set(
      groups.flatMap((group) =>
        group.options
          .filter((option) =>
            `${option.label} ${option.labelEn} ${option.prompt}`.toLowerCase().includes(keyword),
          )
          .map((option) => option.id),
      ),
    );
  }, [activeAdvancedCategory, activeCategory, search, showAdvancedPanel, yyhHiddenMode]);

  return (
    <div
      className={`t8-node relative w-[560px] overflow-visible transition-all ${selected ? 'ring-2 ring-pink-300' : ''}`}
      data-node-kind="portrait-master"
      data-yyh-portrait-hidden={yyhHiddenMode ? 'true' : undefined}
    >
      <Handle type="target" position={Position.Left} style={{ background: PORT_COLOR.text, border: 0 }} />
      <Handle type="source" position={Position.Right} style={{ background: PORT_COLOR.text, border: 0 }} />

      <div className="t8-node-header flex items-center gap-2 rounded-t-[inherit] px-3 py-2">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ background: 'color-mix(in srgb, var(--t8-accent) 20%, transparent)', color: 'var(--t8-accent)' }}
        >
          <UserRoundCog size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-black">肖像大师</div>
          <div className="truncate text-[10px]" style={{ color: 'var(--t8-text-muted)' }}>
            {stats.selected}/{stats.totalGroups} 项 · prompt 捏人系统{yyhHiddenMode ? ` · 隐藏 ${advancedStats.selected}/${advancedStats.totalGroups}` : ''}
          </div>
        </div>
        <button
          type="button"
          className="t8-mini-icon-button nodrag nopan"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            openEditor();
          }}
          title="编辑肖像"
        >
          <SlidersHorizontal size={15} />
        </button>
      </div>

      <div className="space-y-3 p-3">
        <div className="grid grid-cols-[170px_1fr] gap-3">
          <PortraitAvatarPreview selection={selection} />
          <div className="flex min-w-0 flex-col gap-2">
            <div className="t8-card p-2">
              <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-bold">
                <span>角色摘要</span>
                <span style={{ color: 'var(--t8-text-dim)' }}>默认 EN prompt</span>
              </div>
              <div className="line-clamp-3 min-h-[44px] text-[11px] leading-relaxed" style={{ color: 'var(--t8-text-muted)' }}>
                {summary}
              </div>
            </div>
            <div className="t8-card flex min-h-0 flex-1 flex-col p-2">
              <div className="mb-1 text-[11px] font-bold">输出到下游 prompt</div>
              <div className="min-h-[86px] overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed" style={{ color: 'var(--t8-text-main)' }}>
                {prompt || <span style={{ color: 'var(--t8-text-dim)' }}>点击编辑或随机生成一个人物提示词...</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2">
          <button
            type="button"
            className="t8-btn min-h-8 px-2 text-[11px]"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openEditor();
            }}
          >
            <SlidersHorizontal size={13} /> 编辑
          </button>
          <button type="button" className="t8-btn min-h-8 px-2 text-[11px]" onClick={handleRandom}>
            <Shuffle size={13} /> 随机
          </button>
          <button type="button" className="t8-btn min-h-8 px-2 text-[11px]" onClick={handleCopy} disabled={!prompt.trim()}>
            <Copy size={13} /> {copied ? '已复制' : '复制'}
          </button>
          <button type="button" className="t8-btn t8-btn-primary min-h-8 px-2 text-[11px]" onClick={() => requestCanvasNodeRun(id)}>
            <Play size={13} fill="currentColor" /> 运行
          </button>
        </div>
        {error && <div className="text-[10px]" style={{ color: 'var(--t8-danger, #ef4444)' }}>{error}</div>}
      </div>

      {isEditorOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/45 p-5"
          data-canvas-floating-ui="portrait-master-editor"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <div
            className="t8-panel nodrag nopan flex max-h-[92vh] w-[1320px] max-w-[98vw] flex-col overflow-hidden"
            data-yyh-portrait-editor-hidden={yyhHiddenMode ? 'true' : undefined}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <input ref={jsonInputRef} type="file" accept="application/json" className="hidden" onChange={handleImportJson} />
            <div className="t8-node-header flex items-center gap-3 px-4 py-3">
              <UserRoundCog size={18} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-black">肖像大师编辑器</div>
                <div className="text-[11px]" style={{ color: 'var(--t8-text-muted)' }}>
                  每个参数 100 个可选词条；Avatar 只做方向预览，不消耗 API。
                </div>
              </div>
              <button type="button" className="t8-mini-icon-button" onClick={closeEditor} title="关闭">
                <X size={16} />
              </button>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)_390px] gap-3 overflow-hidden p-3">
              <aside className="t8-card min-h-0 overflow-y-auto p-2">
                <div className="space-y-1">
                  {PORTRAIT_CATEGORIES.map((category) => {
                    const active = !showAdvancedPanel && category.id === activeCategory.id;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        className={`t8-btn w-full justify-between px-2 py-2 text-left text-[11px] ${active ? 't8-btn-primary' : ''}`}
                        onClick={() => {
                          setShowAdvancedPanel(false);
                          setActiveCategoryId(category.id);
                        }}
                      >
                        <span className="truncate">{category.label}</span>
                        <span className="shrink-0 text-[10px]">{categoryOptionCount(category.id)}</span>
                      </button>
                    );
                  })}
                  {yyhHiddenMode && (
                    <>
                      <div className="px-1 pt-2 text-[10px] font-bold" style={{ color: 'var(--t8-danger)' }}>
                        幽游隐藏高级
                      </div>
                      {PORTRAIT_ADVANCED_CATEGORIES.map((category) => {
                        const active = showAdvancedPanel && category.id === activeAdvancedCategory.id;
                        return (
                          <button
                            key={category.id}
                            type="button"
                            className={`t8-btn w-full justify-between px-2 py-2 text-left text-[11px] ${active ? 't8-btn-primary' : ''}`}
                            onClick={() => {
                              setShowAdvancedPanel(true);
                              setActiveAdvancedCategoryId(category.id);
                            }}
                          >
                            <span className="truncate">{category.label}</span>
                            <span className="shrink-0 text-[10px]">{categoryAdvancedOptionCount(category.id)}</span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              </aside>

              <main className="flex min-h-0 flex-col gap-2 overflow-hidden">
                <div className="t8-card p-2">
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-black">{editorCategory.label}</div>
                      <div className="text-[11px]" style={{ color: 'var(--t8-text-muted)' }}>{editorCategory.description}</div>
                      {showAdvancedPanel && hiddenBlockedByBase && (
                        <div className="mt-1 rounded px-2 py-1 text-[10px]" style={{ background: 'color-mix(in srgb, var(--t8-danger) 14%, transparent)', color: 'var(--t8-danger)' }}>
                          当前基础人物疑似未成年或学生设定，隐藏高级词条不会输出。
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="t8-btn h-8 px-2 text-[11px]"
                      onClick={() => showAdvancedPanel ? clearAdvancedCategory(activeAdvancedCategory.id) : clearCategory(activeCategory.id)}
                    >
                      <RotateCcw size={13} /> 清空本类
                    </button>
                  </div>
                  <label className="relative block">
                    <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2" size={14} style={{ color: 'var(--t8-text-dim)' }} />
                    <input
                      className="t8-input h-8 w-full pl-8 pr-2 text-[11px]"
                      value={search}
                      placeholder={showAdvancedPanel ? '搜索隐藏高级选项...' : '搜索当前大类选项...'}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                  <div className="grid grid-cols-2 gap-2">
                    {editorCategory.groups.map((group) => {
                      const advancedGroup = showAdvancedPanel && yyhHiddenMode;
                      const optionMap = advancedGroup ? PORTRAIT_ADVANCED_OPTION_BY_ID : PORTRAIT_OPTION_BY_ID;
                      const selectedOptionId = (advancedGroup ? advancedSelection : selection)[group.id] || '';
                      const selectedOption = selectedOptionId ? optionMap.get(selectedOptionId) : null;
                      const visibleOptions = filteredOptionIds
                        ? group.options.filter((option) => filteredOptionIds.has(option.id))
                        : group.options;
                      const options = selectedOption && !visibleOptions.some((option) => option.id === selectedOption.id)
                        ? [selectedOption, ...visibleOptions]
                        : visibleOptions;
                      const weight = (advancedGroup ? advancedWeights : weights)[group.id] ?? 1;
                      const locked = advancedGroup ? advancedLocks[group.id] : locks[group.id];
                      return (
                        <section key={group.id} className="t8-card space-y-2 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-[12px] font-black">{group.label}</div>
                              <div className="truncate text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>
                                {group.labelEn} · {group.options.length} 项
                              </div>
                            </div>
                            <button
                              type="button"
                              className="t8-mini-icon-button shrink-0"
                              onClick={() => advancedGroup ? toggleAdvancedLock(group.id) : toggleLock(group.id)}
                              title={locked ? '取消锁定' : '锁定随机'}
                            >
                              {locked ? <Lock size={13} /> : <Unlock size={13} />}
                            </button>
                          </div>
                          <select
                            className="t8-select h-8 w-full px-2 text-[11px]"
                            value={selectedOptionId}
                            onChange={(event) => advancedGroup ? selectAdvancedOption(group.id, event.target.value) : selectOption(group.id, event.target.value)}
                          >
                            <option value="">不选</option>
                            {options.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label} / {option.labelEn}
                              </option>
                            ))}
                          </select>
                          <div className="grid grid-cols-[1fr_44px] items-center gap-2">
                            <input
                              className="nodrag nowheel"
                              type="range"
                              min={0.5}
                              max={1.8}
                              step={0.1}
                              value={weight}
                              onChange={(event) => advancedGroup ? changeAdvancedWeight(group.id, event.target.value) : changeWeight(group.id, event.target.value)}
                              disabled={!selectedOptionId}
                            />
                            <input
                              className="t8-input h-7 px-1 text-center text-[10px]"
                              value={weight.toFixed(1)}
                              onChange={(event) => advancedGroup ? changeAdvancedWeight(group.id, event.target.value) : changeWeight(group.id, event.target.value)}
                              disabled={!selectedOptionId}
                            />
                          </div>
                        </section>
                      );
                    })}
                  </div>
                </div>
              </main>

              <aside className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-1">
                <PortraitAvatarPreview selection={selection} />
                <div className="t8-card space-y-2 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-black">语言</span>
                    <select
                      className="t8-select h-8 px-2 text-[11px]"
                      value={language}
                      onChange={(event) => commit({ portraitLanguage: safeLanguage(event.target.value) })}
                    >
                      <option value="en">英文 prompt</option>
                      <option value="zh">中文 prompt</option>
                    </select>
                  </div>
                  <textarea
                    className="t8-input h-20 w-full resize-none px-2 py-1.5 text-[11px] leading-relaxed"
                    value={customText}
                    placeholder="自定义补充，会追加到最终 prompt..."
                    onChange={(event) => commit({ portraitCustomText: event.target.value })}
                  />
                </div>
                <div className="t8-card flex min-h-[150px] max-h-52 flex-col p-2">
                  <div className="mb-1 flex items-center justify-between gap-2 text-[12px] font-black">
                    <span>Prompt 预览</span>
                    <button type="button" className="t8-mini-icon-button" onClick={handleCopy} title="复制 prompt" disabled={!prompt.trim()}>
                      <Copy size={13} />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words pr-1 text-[11px] leading-relaxed">
                    {prompt || <span style={{ color: 'var(--t8-text-dim)' }}>暂未选择任何词条。</span>}
                  </div>
                </div>
                {yyhHiddenMode && (
                  <div className="t8-card space-y-2 p-2" data-yyh-portrait-hidden-panel="true">
                    <div className="flex items-center justify-between gap-2 text-[12px] font-black">
                      <span>隐藏高级</span>
                      <span className="text-[10px]" style={{ color: hiddenBlockedByBase ? 'var(--t8-danger)' : 'var(--t8-accent)' }}>
                        {hiddenBlockedByBase ? '已安全屏蔽' : `${advancedStats.selected}/${advancedStats.totalGroups}`}
                      </span>
                    </div>
                    <div className="text-[10px] leading-relaxed" style={{ color: 'var(--t8-text-muted)' }}>
                      {hiddenBlockedByBase ? '基础人物含少女、少年、学生等设定，隐藏成人词条不会参与 prompt。' : advancedSummary}
                    </div>
                    <label className="flex items-center justify-between gap-2 rounded px-2 py-1 text-[10px]" style={{ background: 'var(--t8-bg-panel-muted)' }}>
                      <span>随机时加入隐藏词条</span>
                      <input
                        type="checkbox"
                        checked={hiddenRandomEnabled}
                        onChange={(event) => setHiddenRandomEnabled(event.target.checked)}
                        disabled={hiddenBlockedByBase}
                      />
                    </label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button type="button" className="t8-btn min-h-8 px-2 text-[10px]" onClick={() => handleHiddenRandom(activeAdvancedCategory.id)} disabled={hiddenBlockedByBase}>
                        <Sparkles size={12} /> 随当前隐藏类
                      </button>
                      <button type="button" className="t8-btn min-h-8 px-2 text-[10px]" onClick={() => handleHiddenRandom()} disabled={hiddenBlockedByBase}>
                        <Shuffle size={12} /> 随全部隐藏
                      </button>
                    </div>
                  </div>
                )}
                <div className="t8-card space-y-2 p-2">
                  <div className="flex items-center justify-between gap-2 text-[12px] font-black">
                    <span className="inline-flex items-center gap-1"><Star size={13} /> 角色库</span>
                    <span className="text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>{favorites.length}/{MAX_PORTRAIT_FAVORITES}</span>
                  </div>
                  <input
                    className="t8-input h-8 w-full px-2 text-[11px]"
                    value={favoriteName}
                    placeholder="角色名称，可留空使用摘要"
                    onChange={(event) => setFavoriteName(event.target.value)}
                  />
                  <div className="grid grid-cols-1 gap-1.5">
                    <button type="button" className="t8-btn min-h-8 px-2 text-[10px]" onClick={handleSaveFavorite} disabled={!prompt.trim()}>
                      <Star size={12} /> 收藏
                    </button>
                  </div>
                  <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
                    {favorites.length === 0 ? (
                      <div className="rounded border border-dashed border-current/20 px-2 py-3 text-center text-[10px]" style={{ color: 'var(--t8-text-dim)' }}>
                        常用角色会显示在这里
                      </div>
                    ) : favorites.map((favorite) => (
                      <div key={favorite.id} className="flex items-center gap-1 rounded px-1.5 py-1" style={{ background: 'var(--t8-bg-panel-muted)' }}>
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-[10px] font-semibold"
                          title={favorite.name}
                          onClick={() => applyBackup(favorite)}
                        >
                          {favorite.name}
                        </button>
                        <button type="button" className="t8-mini-icon-button h-6 w-6" title="删除收藏" onClick={() => handleDeleteFavorite(favorite.id)}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="t8-card space-y-2 p-2">
                  <div className="text-[12px] font-black">JSON / 复用</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button type="button" className="t8-btn min-h-8 px-2 text-[10px]" onClick={handleExportJson} disabled={!prompt.trim()}>
                      <Download size={12} /> 导出当前
                    </button>
                    <button type="button" className="t8-btn min-h-8 px-2 text-[10px]" onClick={openSaveResourceDialog} disabled={!prompt.trim()}>
                      <PackagePlus size={12} /> 存资源库
                    </button>
                    <button type="button" className="t8-btn min-h-8 px-2 text-[10px]" onClick={handleCreateTextNode} disabled={!prompt.trim()}>
                      <FileText size={12} /> 文本节点
                    </button>
                    <button type="button" className="t8-btn min-h-8 px-2 text-[10px]" onClick={() => jsonInputRef.current?.click()}>
                      <UploadIcon size={12} /> 导入 JSON
                    </button>
                  </div>
                  <select
                    className="t8-select h-8 w-full px-2 text-[11px]"
                    value={selectedTargetCanvasId}
                    onChange={(event) => setTargetCanvasId(event.target.value)}
                  >
                    {canvases.map((canvas) => (
                      <option key={canvas.id} value={canvas.id}>
                        {canvas.name}{canvas.id === activeId ? '（当前）' : ''}
                      </option>
                    ))}
                  </select>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button type="button" className="t8-btn min-h-8 px-2 text-[10px]" onClick={handleSendPortraitConfig} disabled={!selectedTargetCanvasId}>
                      <Send size={12} /> 发配置
                    </button>
                    <button type="button" className="t8-btn min-h-8 px-2 text-[10px]" onClick={handleSendPromptText} disabled={!prompt.trim() || !selectedTargetCanvasId}>
                      <Send size={12} /> 发Prompt
                    </button>
                  </div>
                </div>
                <div className="t8-card space-y-2 p-2">
                  <div className="flex items-center justify-between gap-2 text-[12px] font-black">
                    <span className="inline-flex items-center gap-1"><Shuffle size={13} /> 高级随机</span>
                    <button type="button" className="t8-btn h-7 px-2 text-[10px]" onClick={handleQuickRandom}>
                      快速
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <select className="t8-select h-8 px-2 text-[10px]" value={randomMode} onChange={(event) => setRandomMode(safeRandomMode(event.target.value))}>
                      <option value="unlocked">重随未锁定项</option>
                      <option value="empty">只填空项</option>
                      <option value="category">只随机当前类</option>
                      <option value="all">随机全部含锁定</option>
                    </select>
                    <select className="t8-select h-8 px-2 text-[10px]" value={stylePackId} onChange={(event) => setStylePackId(safeStylePack(event.target.value))}>
                      {STYLE_PACKS.map((pack) => <option key={pack.id} value={pack.id}>{pack.label}</option>)}
                    </select>
                  </div>
                  <input
                    className="t8-input h-8 w-full px-2 text-[11px]"
                    value={randomSeed}
                    placeholder="随机种子，可留空"
                    onChange={(event) => setRandomSeed(event.target.value)}
                  />
                  <button type="button" className="t8-btn t8-btn-primary min-h-8 w-full px-2 text-[11px]" onClick={handleRandom}>
                    <Sparkles size={13} /> 按规则随机当前角色
                  </button>
                </div>
                <div className="t8-card space-y-2 p-2">
                  <div className="text-[12px] font-black">批量角色</div>
                  <div className="grid grid-cols-[1fr_1fr] gap-1.5">
                    <input
                      className="t8-input h-8 px-2 text-[11px]"
                      type="number"
                      min={1}
                      max={24}
                      value={batchCount}
                      onChange={(event) => setBatchCount(Math.max(1, Math.min(24, Number(event.target.value) || 1)))}
                    />
                    <select className="t8-select h-8 px-2 text-[10px]" value={batchMode} onChange={(event) => setBatchMode(safeBatchMode(event.target.value))}>
                      <option value="text-nodes">多个文本节点</option>
                      <option value="material-set">文本素材集</option>
                    </select>
                  </div>
                  <button type="button" className="t8-btn min-h-8 w-full px-2 text-[11px]" onClick={handleBatchGenerate}>
                    <PackagePlus size={13} /> 批量生成
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" className="t8-btn min-h-8 px-2 text-[11px]" onClick={handleRandom}>
                    <Sparkles size={13} /> 随机
                  </button>
                  <button type="button" className="t8-btn t8-btn-primary min-h-8 px-2 text-[11px]" onClick={() => requestCanvasNodeRun(id)}>
                    <Play size={13} fill="currentColor" /> 输出
                  </button>
                </div>
              </aside>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {resourceDialogOpen && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[2100] flex items-center justify-center bg-black/50 p-4"
          data-canvas-floating-ui="portrait-resource-save"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="t8-card nodrag nopan w-[420px] max-w-[calc(100vw-24px)] space-y-3 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-1.5 text-sm font-black">
                  <PackagePlus size={15} /> 保存到资源库
                </div>
                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--t8-text-muted)' }}>
                  保存为肖像大师配置，插入资源时会恢复为节点。
                </div>
              </div>
              <button type="button" className="t8-mini-icon-button" onClick={() => setResourceDialogOpen(false)} title="关闭">
                <X size={14} />
              </button>
            </div>

            <label className="block space-y-1">
              <span className="text-[11px] font-bold">名称</span>
              <input
                className="t8-input h-8 w-full px-2 text-[12px]"
                value={resourceTitle}
                onChange={(event) => setResourceTitle(event.target.value)}
                placeholder="角色名称"
              />
            </label>

            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <label className="block space-y-1">
                <span className="text-[11px] font-bold">分类</span>
                <select
                  className="t8-select h-8 w-full px-2 text-[12px]"
                  value={resourceCategoryId}
                  onChange={(event) => setResourceCategoryId(event.target.value)}
                >
                  {resourceCategories.length === 0 && <option value="set_uncategorized">未分类</option>}
                  {resourceCategories.map((cat) => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="t8-btn h-8 px-2 text-[11px]" onClick={handleCreateResourceCategory}>
                新建
              </button>
            </div>

            <label className="block space-y-1">
              <span className="text-[11px] font-bold">标签</span>
              <input
                className="t8-input h-8 w-full px-2 text-[12px]"
                value={resourceTags}
                onChange={(event) => setResourceTags(event.target.value)}
                placeholder="用逗号分隔"
              />
            </label>

            <label className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-[12px]" style={{ background: 'var(--t8-bg-panel-muted)' }}>
              <span>保存后标记为收藏</span>
              <input type="checkbox" checked={resourceFavorite} onChange={(event) => setResourceFavorite(event.target.checked)} />
            </label>

            {resourceMessage && (
              <div className="rounded px-2 py-1.5 text-[11px]" style={{ background: 'var(--t8-bg-panel-muted)', color: 'var(--t8-text-muted)' }}>
                {resourceMessage}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button type="button" className="t8-btn h-8 px-3 text-[12px]" onClick={() => setResourceDialogOpen(false)} disabled={resourceSaving}>
                取消
              </button>
              <button
                type="button"
                className="t8-btn t8-btn-primary h-8 px-3 text-[12px]"
                onClick={handleSaveToResourceLibrary}
                disabled={resourceSaving || !prompt.trim()}
              >
                <PackagePlus size={13} /> {resourceSaving ? '保存中' : '保存'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default memo(PortraitMasterNode);
