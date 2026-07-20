import { useCallback, useEffect, useState } from 'react';
import { BookmarkPlus, CloudUpload, Copy, FolderPlus, Library, Palette, Plus, Save, Send, Tags, WandSparkles, X } from 'lucide-react';
import { useThemeStore } from '../stores/theme';
import { useCanvasStore } from '../stores/canvas';
import { trackAchievementEvent } from '../stores/achievements';
import * as api from '../services/api';
import type { CloudUploadTargetConfig } from '../types/canvas';
import type { ResourceCategory, ResourceKind, ResourceMaterialSetKind, ResourceMediaKind } from '../services/api';
import type { PromptTemplateKind } from '../data/promptTemplateLibrary';
import {
  getPromptTemplateCategories,
  getPromptTemplateCategoryLabel,
  type PromptTemplateCategory,
} from '../data/promptTemplateLibrary';
import {
  createPromptTemplateFromMaterial,
  loadPromptTemplateUserState,
  savePromptTemplateUserState,
} from '../services/promptTemplateLibrary';
import {
  ARTIST_STYLE_MASTER_STORAGE_KEY,
  createArtistStyleFromMaterial,
  normalizeArtistStyleLibrary,
  upsertArtistStyleInLibrary,
} from '../utils/artistStyleMaster';
import {
  ANIME_TAG_MASTER_EVENT,
  ANIME_TAG_MASTER_STORAGE_KEY,
  createAnimeTagFromMaterial,
  normalizeAnimeTagLibrary,
  upsertAnimeTagInLibrary,
} from '../utils/animeTagMaster';
import { copyImageUrlToClipboard } from '../utils/imageClipboard';
import SmartImage from './SmartImage';

interface MenuState {
  x: number;
  y: number;
  kind: ResourceKind;
  url?: string;
  previewUrl?: string;
  sourceNodeId?: string;
  title?: string;
  materialSetKind?: ResourceMaterialSetKind;
  materialSetItems?: NonNullable<Parameters<typeof api.addResourceSet>[0]['materialSetItems']>;
  promptTemplateKind?: PromptTemplateKind;
  promptTemplateCategoryId?: string;
  promptTemplatePrompt?: string;
  promptTemplateNegative?: string;
}

interface ArtistStyleDraft {
  name: string;
  categoryZh: string;
  prompt: string;
  negativePrompt: string;
  tags: string;
}

interface AnimeTagDraft {
  name: string;
  categoryName: string;
  prompt: string;
  negativePrompt: string;
  tags: string;
}

interface MissingPromptDraft {
  value: string;
}

function isResourceKind(value: string | null): value is ResourceMediaKind {
  return value === 'image' || value === 'video' || value === 'audio';
}

function baseName(url: string) {
  try {
    const u = url.startsWith('http') ? new URL(url) : new URL(url, 'http://local');
    const b = decodeURIComponent(u.pathname.split('/').pop() || '');
    return b || '资源';
  } catch {
    return url.split('/').pop() || '资源';
  }
}

function normalizePromptTemplateKind(value: string | null, fallback: PromptTemplateKind): PromptTemplateKind {
  return value === 'image' || value === 'video' ? value : fallback;
}

function formatCloudError(error: string, data?: any) {
  const parts = [
    error,
    data?.hint,
    data?.providerCode ? `Code: ${data.providerCode}` : '',
    data?.requestId ? `RequestId: ${data.requestId}` : '',
  ].filter(Boolean);
  return parts.join('；');
}

export default function MaterialContextMenu() {
  const { theme, style } = useThemeStore();
  const activeCanvasId = useCanvasStore((s) => s.activeId);
  const isDark = theme === 'dark';
  const isPixel = style === 'pixel';
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [categories, setCategories] = useState<ResourceCategory[]>([]);
  const [cloudTargets, setCloudTargets] = useState<CloudUploadTargetConfig[]>([]);
  const [cloudUploadingId, setCloudUploadingId] = useState('');
  const [promptCategoryId, setPromptCategoryId] = useState('');
  const [message, setMessage] = useState('');
  const [cloudResult, setCloudResult] = useState<api.CloudUploadAssetResult | null>(null);
  const [artistStyleDraft, setArtistStyleDraft] = useState<ArtistStyleDraft | null>(null);
  const [animeTagDraft, setAnimeTagDraft] = useState<AnimeTagDraft | null>(null);
  const [promptCategoryDraft, setPromptCategoryDraft] = useState<string | null>(null);
  const [resourceCategoryDraft, setResourceCategoryDraft] = useState<string | null>(null);
  const [missingPromptDraft, setMissingPromptDraft] = useState<MissingPromptDraft | null>(null);
  const [copyingImage, setCopyingImage] = useState(false);
  const [sendingToPhotoshop, setSendingToPhotoshop] = useState(false);

  const close = useCallback(() => {
    setMenu(null);
    setMessage('');
    setCloudUploadingId('');
    setCloudResult(null);
    setPromptCategoryId('');
    setArtistStyleDraft(null);
    setAnimeTagDraft(null);
    setPromptCategoryDraft(null);
    setResourceCategoryDraft(null);
    setMissingPromptDraft(null);
    setCopyingImage(false);
    setSendingToPhotoshop(false);
  }, []);

  const loadCategories = useCallback(async (kind: ResourceKind) => {
    const r = await api.getResourceCategories(kind);
    if (r.success) setCategories(r.data);
  }, []);

  const loadCloudTargets = useCallback(async () => {
    const r = await api.getCloudUploadStatus();
    if (r.success) {
      setCloudTargets((r.data.targets || []).filter((target) => target.enabled));
    }
  }, []);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const source = target?.closest('[data-drag-source]') as HTMLElement | null;
      if (!source) return;
      const kind = source.getAttribute('data-drag-kind');
      const url = source.getAttribute('data-drag-url') || '';
      if (!isResourceKind(kind) || !url) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const next: MenuState = {
        x: e.clientX,
        y: e.clientY,
        kind,
        url,
        previewUrl: source.getAttribute('data-drag-preview') || url,
        sourceNodeId: source.getAttribute('data-drag-node-id') || '',
        title: source.getAttribute('data-resource-title') || source.getAttribute('alt') || baseName(url),
        promptTemplateKind: normalizePromptTemplateKind(
          source.getAttribute('data-prompt-template-kind'),
          kind === 'image' ? 'image' : 'video',
        ),
        promptTemplateCategoryId: source.getAttribute('data-prompt-template-category') || '',
        promptTemplatePrompt: source.getAttribute('data-prompt-template-prompt') || '',
        promptTemplateNegative: source.getAttribute('data-prompt-template-negative') || '',
      };
      setMenu(next);
      setPromptCategoryId(next.promptTemplateCategoryId || '');
      setMessage('');
      setCloudResult(null);
      setArtistStyleDraft(null);
      setAnimeTagDraft(null);
      setPromptCategoryDraft(null);
      setResourceCategoryDraft(null);
      setMissingPromptDraft(null);
      setCopyingImage(false);
      setSendingToPhotoshop(false);
      loadCategories(kind);
      loadCloudTargets();
    };
    const onMaterialSetMenu = (e: Event) => {
      const detail = (e as CustomEvent)?.detail || {};
      const materialSetKind = detail.materialSetKind as ResourceMaterialSetKind | undefined;
      const materialSetItems = Array.isArray(detail.materialSetItems) ? detail.materialSetItems : [];
      if (!materialSetKind || materialSetItems.length === 0) return;
      setMenu({
        x: Number(detail.x) || window.innerWidth / 2,
        y: Number(detail.y) || window.innerHeight / 2,
        kind: 'set',
        sourceNodeId: String(detail.sourceNodeId || ''),
        title: String(detail.title || '素材集'),
        materialSetKind,
        materialSetItems,
      });
      setMessage('');
      setPromptCategoryId('');
      setCloudResult(null);
      setArtistStyleDraft(null);
      setAnimeTagDraft(null);
      setPromptCategoryDraft(null);
      setResourceCategoryDraft(null);
      setMissingPromptDraft(null);
      setCopyingImage(false);
      setSendingToPhotoshop(false);
      loadCategories('set');
    };
    document.addEventListener('contextmenu', onContext, true);
    window.addEventListener('penguin:open-material-set-resource-menu', onMaterialSetMenu as EventListener);
    return () => {
      document.removeEventListener('contextmenu', onContext, true);
      window.removeEventListener('penguin:open-material-set-resource-menu', onMaterialSetMenu as EventListener);
    };
  }, [loadCategories, loadCloudTargets]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[data-resource-context-menu]')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu, close]);

  const addToCategory = async (categoryId: string) => {
    if (!menu) return;
    const r = menu.kind === 'set'
      ? await api.addResourceSet({
          materialSetKind: menu.materialSetKind!,
          materialSetItems: menu.materialSetItems || [],
          categoryId,
          title: menu.title,
          sourceNodeId: menu.sourceNodeId,
          sourceCanvasId: activeCanvasId || '',
        })
      : await api.addResourceItem({
          url: menu.url || '',
          kind: menu.kind as ResourceMediaKind,
          categoryId,
          title: menu.title,
          sourceNodeId: menu.sourceNodeId,
          sourceCanvasId: activeCanvasId || '',
        });
    if (r.success) {
      const duplicate = (r as any).duplicate;
      if (!duplicate) {
        trackAchievementEvent({
          type: 'resource.saved',
          kind: menu.kind === 'set' ? `${menu.materialSetKind || 'material'}-set` : menu.kind,
          category: categoryId,
        });
      }
      setMessage(duplicate ? '已存在，已定位到该分类' : '已加入资源库');
      window.dispatchEvent(new CustomEvent('penguin:resources-changed'));
      window.setTimeout(close, 650);
    } else {
      setMessage(r.error || '加入失败');
    }
  };

  const promptTemplateState = menu && menu.kind !== 'set' ? loadPromptTemplateUserState() : null;
  const promptTemplateKind = menu && menu.kind !== 'set'
    ? normalizePromptTemplateKind(String(menu.promptTemplateKind || ''), menu.kind === 'image' ? 'image' : 'video')
    : 'image';
  const promptTemplateCategories: PromptTemplateCategory[] = promptTemplateState
    ? getPromptTemplateCategories(promptTemplateKind, promptTemplateState.customCategories)
    : [];
  const selectedPromptCategoryId =
    promptCategoryId ||
    menu?.promptTemplateCategoryId ||
    promptTemplateCategories[0]?.id ||
    '';

  const savePromptTemplateWithPrompt = (promptValue: string) => {
    if (!menu || menu.kind === 'set' || !menu.url) return;
    const prompt = promptValue.trim();
    if (!prompt) {
      setMessage('未保存：缺少提示词');
      return;
    }
    const titleBase = (menu.title || baseName(menu.url)).replace(/\.[a-z0-9]{2,8}$/i, '').trim();
    const item = createPromptTemplateFromMaterial({
      mediaKind: menu.kind as ResourceMediaKind,
      url: menu.url,
      previewUrl: menu.previewUrl,
      prompt,
      negative: menu.promptTemplateNegative,
      title: titleBase || prompt.slice(0, 32),
      templateKind: menu.promptTemplateKind,
      categoryId: selectedPromptCategoryId,
      sourceNodeId: menu.sourceNodeId,
    });
    const current = loadPromptTemplateUserState();
    savePromptTemplateUserState({
      ...current,
      customItems: [item, ...current.customItems],
    });
    window.dispatchEvent(new CustomEvent('penguin:prompt-templates-changed', { detail: { id: item.id } }));
    setMissingPromptDraft(null);
    setMessage(`已保存到提示词模板库：${item.titleZh}`);
  };

  const saveToPromptTemplate = () => {
    if (!menu || menu.kind === 'set' || !menu.url) return;
    const prompt = (menu.promptTemplatePrompt || '').trim();
    if (!prompt) {
      setMissingPromptDraft({ value: missingPromptDraft?.value || '' });
      setMessage('请先补充提示词，再保存到模板库。');
      return;
    }
    savePromptTemplateWithPrompt(prompt);
  };

  const openArtistStyleSaveDialog = () => {
    if (!menu || menu.kind !== 'image' || !menu.url) return;
    const titleBase = (menu.title || baseName(menu.url)).replace(/\.[a-z0-9]{2,8}$/i, '').trim();
    const prompt = (menu.promptTemplatePrompt || '').trim();
    setArtistStyleDraft({
      name: titleBase || '素材风格',
      categoryZh: '素材收藏',
      prompt,
      negativePrompt: (menu.promptTemplateNegative || '').trim(),
      tags: '素材右键, image',
    });
    setMessage(prompt ? '已自动获取来源提示词，请确认或修改风格提示词。' : '未检测到来源提示词，请手动填写后保存。');
  };

  const fillArtistStylePrompt = () => {
    if (!menu || !artistStyleDraft) return;
    const prompt = (menu.promptTemplatePrompt || '').trim();
    if (!prompt) {
      setMessage('未检测到来源提示词，请手动填写。');
      return;
    }
    setArtistStyleDraft((draft) => draft ? {
      ...draft,
      prompt,
      negativePrompt: (menu.promptTemplateNegative || draft.negativePrompt || '').trim(),
    } : draft);
    setMessage('已重新填入自动获取的提示词，请确认后保存。');
  };

  const saveToArtistStyleMaster = () => {
    if (!menu || menu.kind !== 'image' || !menu.url || !artistStyleDraft) return;
    if (!artistStyleDraft.prompt.trim()) {
      setMessage('请确认或修改风格提示词后保存。');
      return;
    }
    let current = normalizeArtistStyleLibrary(null);
    try {
      const raw = window.localStorage.getItem(ARTIST_STYLE_MASTER_STORAGE_KEY);
      current = raw ? normalizeArtistStyleLibrary(JSON.parse(raw)) : normalizeArtistStyleLibrary(null);
    } catch {
      current = normalizeArtistStyleLibrary(null);
    }
    const style = createArtistStyleFromMaterial({
      imageUrl: menu.url,
      title: artistStyleDraft.name || menu.title || baseName(menu.url),
      prompt: artistStyleDraft.prompt,
      negativePrompt: artistStyleDraft.negativePrompt,
      categoryZh: artistStyleDraft.categoryZh || '素材收藏',
      tags: artistStyleDraft.tags.split(/[,\s，、]+/).filter(Boolean),
      sourceNodeId: menu.sourceNodeId,
    });
    const next = upsertArtistStyleInLibrary(current, style, { id: style.category, name: style.categoryZh });
    window.localStorage.setItem(ARTIST_STYLE_MASTER_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('penguin:artist-style-master-changed', { detail: { id: style.id } }));
    setArtistStyleDraft(null);
    setMessage(`已保存到艺术风格大师：${style.chineseName}`);
  };

  const openAnimeTagSaveDialog = () => {
    if (!menu || menu.kind !== 'image' || !menu.url) return;
    const titleBase = (menu.title || baseName(menu.url)).replace(/\.[a-z0-9]{2,8}$/i, '').trim();
    const prompt = (menu.promptTemplatePrompt || '').trim();
    setAnimeTagDraft({
      name: titleBase || '动漫标签参考',
      categoryName: '素材收藏',
      prompt,
      negativePrompt: (menu.promptTemplateNegative || '').trim(),
      tags: prompt
        ? prompt.split(/[,\n，、]+/).slice(0, 12).map((item) => item.trim()).filter(Boolean).join(', ')
        : 'anime, reference',
    });
    setMessage(prompt ? '已自动获取来源提示词，请确认或修改动漫标签提示词。' : '未检测到来源提示词，请手动填写后保存。');
  };

  const fillAnimeTagPrompt = () => {
    if (!menu || !animeTagDraft) return;
    const prompt = (menu.promptTemplatePrompt || '').trim();
    if (!prompt) {
      setMessage('未检测到来源提示词，请手动填写。');
      return;
    }
    setAnimeTagDraft((draft) => draft ? {
      ...draft,
      prompt,
      negativePrompt: (menu.promptTemplateNegative || draft.negativePrompt || '').trim(),
      tags: prompt.split(/[,\n，、]+/).slice(0, 12).map((item) => item.trim()).filter(Boolean).join(', '),
    } : draft);
    setMessage('已重新填入自动获取的提示词，请确认后保存。');
  };

  const saveToAnimeTagMaster = () => {
    if (!menu || menu.kind !== 'image' || !menu.url || !animeTagDraft) return;
    if (!animeTagDraft.prompt.trim() && !animeTagDraft.tags.trim()) {
      setMessage('请确认或修改动漫标签提示词后保存。');
      return;
    }
    let current = normalizeAnimeTagLibrary(null);
    try {
      const raw = window.localStorage.getItem(ANIME_TAG_MASTER_STORAGE_KEY);
      current = raw ? normalizeAnimeTagLibrary(JSON.parse(raw)) : normalizeAnimeTagLibrary(null);
    } catch {
      current = normalizeAnimeTagLibrary(null);
    }
    const tag = createAnimeTagFromMaterial({
      imageUrl: menu.url,
      title: animeTagDraft.name || menu.title || baseName(menu.url),
      prompt: animeTagDraft.prompt,
      negativePrompt: animeTagDraft.negativePrompt,
      categoryName: animeTagDraft.categoryName || '素材收藏',
      tags: animeTagDraft.tags.split(/[,\s，、]+/).filter(Boolean),
      sourceNodeId: menu.sourceNodeId,
    });
    const next = upsertAnimeTagInLibrary(current, tag, { id: tag.categoryId, name: tag.categoryName });
    window.localStorage.setItem(ANIME_TAG_MASTER_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(ANIME_TAG_MASTER_EVENT, { detail: { id: tag.id } }));
    setAnimeTagDraft(null);
    setMessage(`已保存到动漫标签大师：${tag.chineseName}`);
  };

  const createPromptTemplateCategory = () => {
    if (!menu || menu.kind === 'set') return;
    setPromptCategoryDraft('');
    setMessage(promptTemplateKind === 'image' ? '请输入图像模板分类名称' : '请输入视频模板分类名称');
  };

  const submitPromptTemplateCategory = () => {
    if (!menu || menu.kind === 'set') return;
    const name = (promptCategoryDraft || '').trim();
    if (!name) {
      setMessage('请填写模板分类名称');
      return;
    }
    const current = loadPromptTemplateUserState();
    const id = `custom-${promptTemplateKind}-${Date.now().toString(36)}`;
    const category: PromptTemplateCategory = {
      id,
      kind: promptTemplateKind,
      labelZh: name,
      labelEn: name,
      descriptionZh: '从素材右键保存时创建的分类',
      descriptionEn: 'Created while saving material to prompt templates',
      order: 1000 + current.customCategories.length,
      builtIn: false,
    };
    savePromptTemplateUserState({
      ...current,
      customCategories: [...current.customCategories, category],
    });
    setPromptCategoryId(id);
    setPromptCategoryDraft(null);
    window.dispatchEvent(new CustomEvent('penguin:prompt-templates-changed', { detail: { categoryId: id } }));
    setMessage(`已创建模板分类：${category.labelZh}`);
  };

  const createCategory = () => {
    if (!menu) return;
    setResourceCategoryDraft('');
    setMessage('请输入资源分类名称');
  };

  const submitResourceCategory = async () => {
    if (!menu) return;
    const name = (resourceCategoryDraft || '').trim();
    if (!name) {
      setMessage('请填写资源分类名称');
      return;
    }
    const r = await api.addResourceCategory(menu.kind, name);
    if (r.success) {
      setCategories((prev) => [...prev, r.data]);
      setResourceCategoryDraft(null);
      await addToCategory(r.data.id);
    } else {
      setMessage(r.error || '分类创建失败');
    }
  };

  const uploadToCloud = async (target: CloudUploadTargetConfig) => {
    if (!menu || menu.kind === 'set' || !menu.url) return;
    setCloudUploadingId(target.id);
    setCloudResult(null);
    setMessage(`正在上传到 ${target.label || '云端'}...`);
    const r = await api.uploadCloudAsset({
      targetId: target.id,
      url: menu.url,
      kind: menu.kind,
      filename: menu.title,
      title: menu.title,
      sourceNodeId: menu.sourceNodeId,
      sourceCanvasId: activeCanvasId || '',
    });
    setCloudUploadingId('');
    if (r.success) {
      setCloudResult(r.data);
      const copyValue = r.data.url || r.data.path || '';
      if (copyValue) {
        try {
          await navigator.clipboard?.writeText(copyValue);
          setMessage(`已上传到 ${target.label || '云端'}，链接已复制`);
        } catch {
          setMessage(`已上传到 ${target.label || '云端'}`);
        }
      } else {
        setMessage(`已上传到 ${target.label || '云端'}`);
      }
    } else {
      setMessage(formatCloudError(r.error || '云端上传失败', r.data));
    }
  };

  const sendCurrentImageToPhotoshop = async () => {
    if (!menu || menu.kind !== 'image' || !menu.url) return;
    setSendingToPhotoshop(true);
    setMessage('正在发送到 Photoshop...');
    const r = await api.sendToPhotoshop({
      materials: [{
        kind: 'image',
        url: menu.url,
        name: menu.title || baseName(menu.url),
        id: menu.sourceNodeId || undefined,
        tags: ['canvas-context-menu'],
      }],
      tags: ['T8 画布右键'],
      sourceCanvasId: activeCanvasId || undefined,
      sourceLabel: '画布右键图片',
    });
    setSendingToPhotoshop(false);
    if (r.success) {
      const sent = r.data.sent || 1;
      const skipped = r.data.skipped ? `，跳过 ${r.data.skipped} 项` : '';
      setMessage(`已发送到 Photoshop 面板队列：${sent} 张${skipped}，请查看 PS 面板置入状态`);
    } else {
      setMessage(r.error || '发送到 Photoshop 失败，请确认 T8 Photoshop Link 面板已连接。');
    }
  };

  const copyImageToClipboard = async () => {
    if (!menu || menu.kind !== 'image' || !menu.url) return;
    setCopyingImage(true);
    setMessage('正在复制图片到剪切板...');
    try {
      await copyImageUrlToClipboard(menu.url);
      setMessage('图片已复制到剪切板');
    } catch (error: any) {
      setMessage(error?.message || '复制图片到剪切板失败');
    } finally {
      setCopyingImage(false);
    }
  };

  if (!menu) return null;

  const itemCls = isPixel
    ? 'w-full text-left px-3 py-2 text-[12px] flex items-center gap-2 hover:bg-[var(--px-yellow)]'
    : `w-full text-left px-3 py-2 text-[12px] flex items-center gap-2 ${
        isDark ? 'text-zinc-100 hover:bg-white/10' : 'text-zinc-800 hover:bg-black/5'
      }`;

  return (
    <>
    <div
      data-resource-context-menu
      className="fixed z-[80] overflow-hidden"
      style={{
        left: Math.min(menu.x, window.innerWidth - 240),
        top: Math.min(menu.y, window.innerHeight - 360),
        width: 220,
        background: isPixel ? '#FFFFFF' : isDark ? 'rgba(20,20,22,.98)' : 'rgba(255,255,255,.98)',
        color: isPixel ? '#1A1410' : isDark ? '#fff' : '#18181b',
        border: isPixel ? '2px solid #1A1410' : `1px solid ${isDark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.1)'}`,
        borderRadius: isPixel ? 12 : 8,
        boxShadow: isPixel ? '4px 4px 0 #1A1410' : '0 18px 50px rgba(0,0,0,.35)',
      }}
    >
      <div
        className="px-3 py-2 text-[11px] font-semibold flex items-center gap-2"
        style={{
          borderBottom: isPixel ? '2px solid #1A1410' : `1px solid ${isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'}`,
          background: isPixel ? '#A8E6C9' : 'transparent',
        }}
      >
        <Library size={13} />
        <span className="flex-1 truncate">{menu.kind === 'set' ? '保存素材集' : '加入资源库'}</span>
        <button onClick={close} title="关闭">
          <X size={12} />
        </button>
      </div>
      {menu.kind === 'image' && menu.previewUrl && (
        <div className="h-24 bg-black overflow-hidden">
          <SmartImage src={menu.previewUrl} className="w-full h-full object-cover" draggable={false} thumbSize={320} />
        </div>
      )}
      {menu.kind === 'set' && (
        <div className={`px-3 py-2 text-[11px] ${isPixel ? 'bg-[var(--px-muted)]' : isDark ? 'bg-white/5 text-white/65' : 'bg-black/5 text-zinc-600'}`}>
          {menu.title || '素材集'} · {menu.materialSetItems?.length || 0} 项
        </div>
      )}
      {menu.kind !== 'set' && (
        <div
          className="space-y-1 py-1 px-2"
          style={{
            borderBottom: isPixel ? '2px solid #1A1410' : `1px solid ${isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'}`,
          }}
        >
          {menu.kind === 'image' && (
            <>
              <button className={`${itemCls} !px-1`} onClick={copyImageToClipboard} disabled={copyingImage}>
                <Copy size={12} />
                <span className="truncate">{copyingImage ? '正在复制图片...' : '复制图片到剪切板'}</span>
              </button>
              <button className={`${itemCls} !px-1`} onClick={sendCurrentImageToPhotoshop} disabled={sendingToPhotoshop}>
                <Send size={12} />
                <span className="truncate">{sendingToPhotoshop ? '正在发送到 Photoshop...' : '发送到 Photoshop'}</span>
              </button>
            </>
          )}
          <div className="flex items-center gap-1.5">
            <select
              value={selectedPromptCategoryId}
              onChange={(event) => setPromptCategoryId(event.target.value)}
              className="min-w-0 flex-1 rounded border px-2 py-1.5 text-[11px] outline-none"
              style={{
                borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.14)',
                background: isPixel ? '#FFF7C2' : isDark ? 'rgba(255,255,255,.08)' : '#fff',
                color: isPixel ? '#1A1410' : isDark ? '#fff' : '#18181b',
              }}
              title="选择保存到哪个提示词模板分类"
            >
              {promptTemplateCategories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {getPromptTemplateCategoryLabel(cat, 'zh')}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={isPixel ? 'px-btn px-btn--sm px-btn--ghost !px-2 !py-1' : 'rounded border px-2 py-1.5 text-[11px] hover:bg-black/5'}
              onClick={createPromptTemplateCategory}
              title="新建模板分类"
            >
              <FolderPlus size={12} />
            </button>
          </div>
          {promptCategoryDraft !== null && (
            <form
              data-material-prompt-category-form
              className="space-y-1 rounded border px-2 py-2"
              style={{
                borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(125,211,252,.32)' : 'rgba(14,165,233,.22)',
                background: isPixel ? '#fffbea' : isDark ? 'rgba(14,165,233,.08)' : 'rgba(14,165,233,.06)',
              }}
              onSubmit={(event) => {
                event.preventDefault();
                submitPromptTemplateCategory();
              }}
            >
              <div className={`text-[10px] font-bold ${isPixel ? '' : isDark ? 'text-white/70' : 'text-zinc-600'}`}>
                {promptTemplateKind === 'image' ? '新建图像模板分类' : '新建视频模板分类'}
              </div>
              <input
                value={promptCategoryDraft}
                onChange={(event) => setPromptCategoryDraft(event.target.value)}
                className="w-full rounded border px-2 py-1.5 text-[11px] outline-none"
                style={{
                  borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                  background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.08)' : '#fff',
                  color: isPixel ? '#1A1410' : isDark ? '#fff' : '#18181b',
                }}
                placeholder="分类名称"
                autoFocus
              />
              <div className="flex justify-end gap-1">
                <button type="button" className={isPixel ? 'px-btn px-btn--sm px-btn--ghost !px-2 !py-1' : 'rounded border px-2 py-1 text-[10px]'} onClick={() => setPromptCategoryDraft(null)}>
                  取消
                </button>
                <button type="submit" className={isPixel ? 'px-btn px-btn--sm !px-2 !py-1' : 'rounded border px-2 py-1 text-[10px] font-bold'}>
                  保存
                </button>
              </div>
            </form>
          )}
          <button className={`${itemCls} !px-1`} onClick={saveToPromptTemplate}>
            <BookmarkPlus size={12} />
            <span className="truncate">保存到提示词模板库</span>
          </button>
          {missingPromptDraft && (
            <form
              data-material-missing-prompt-form
              className="space-y-1 rounded border px-2 py-2"
              style={{
                borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(250,204,21,.36)' : 'rgba(202,138,4,.24)',
                background: isPixel ? '#fffbea' : isDark ? 'rgba(250,204,21,.08)' : 'rgba(250,204,21,.10)',
              }}
              onSubmit={(event) => {
                event.preventDefault();
                savePromptTemplateWithPrompt(missingPromptDraft.value);
              }}
            >
              <div className={`text-[10px] font-bold ${isPixel ? '' : isDark ? 'text-white/70' : 'text-zinc-600'}`}>
                补充提示词后保存
              </div>
              <textarea
                value={missingPromptDraft.value}
                onChange={(event) => setMissingPromptDraft({ value: event.target.value })}
                className="min-h-[72px] w-full resize-y rounded border px-2 py-1.5 text-[11px] leading-relaxed outline-none"
                style={{
                  borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                  background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.08)' : '#fff',
                  color: isPixel ? '#1A1410' : isDark ? '#fff' : '#18181b',
                }}
                placeholder="输入这个素材对应的提示词"
              />
              <div className="flex justify-end gap-1">
                <button type="button" className={isPixel ? 'px-btn px-btn--sm px-btn--ghost !px-2 !py-1' : 'rounded border px-2 py-1 text-[10px]'} onClick={() => setMissingPromptDraft(null)}>
                  取消
                </button>
                <button type="submit" className={isPixel ? 'px-btn px-btn--sm !px-2 !py-1' : 'rounded border px-2 py-1 text-[10px] font-bold'}>
                  保存
                </button>
              </div>
            </form>
          )}
          {menu.kind === 'image' && (
            <>
              <button className={`${itemCls} !px-1`} onClick={openArtistStyleSaveDialog}>
                <Palette size={12} />
                <span className="truncate">保存风格到艺术风格大师</span>
              </button>
              <button className={`${itemCls} !px-1`} onClick={openAnimeTagSaveDialog}>
                <Tags size={12} />
                <span className="truncate">保存动漫标签到动漫标签大师</span>
              </button>
            </>
          )}
          {!menu.promptTemplatePrompt && (
            <div className={`px-3 pb-1 text-[10px] ${isPixel ? 'opacity-75' : isDark ? 'text-white/45' : 'text-zinc-500'}`}>
              未检测到来源提示词时会询问补充。
            </div>
          )}
        </div>
      )}
      <div className="max-h-56 overflow-y-auto py-1">
        {categories.map((cat) => (
          <button key={cat.id} className={itemCls} onClick={() => addToCategory(cat.id)}>
            <Plus size={12} />
            <span className="truncate">{cat.name}</span>
          </button>
        ))}
        <button className={itemCls} onClick={createCategory}>
          <FolderPlus size={12} />
          <span>新建分类...</span>
        </button>
        {resourceCategoryDraft !== null && (
          <form
            data-material-resource-category-form
            className="mx-2 my-1 space-y-1 rounded border px-2 py-2"
            style={{
              borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.12)',
              background: isPixel ? '#fffbea' : isDark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.025)',
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void submitResourceCategory();
            }}
          >
            <div className={`text-[10px] font-bold ${isPixel ? '' : isDark ? 'text-white/70' : 'text-zinc-600'}`}>
              新建资源分类
            </div>
            <input
              value={resourceCategoryDraft}
              onChange={(event) => setResourceCategoryDraft(event.target.value)}
              className="w-full rounded border px-2 py-1.5 text-[11px] outline-none"
              style={{
                borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.08)' : '#fff',
                color: isPixel ? '#1A1410' : isDark ? '#fff' : '#18181b',
              }}
              placeholder="分类名称"
              autoFocus
            />
            <div className="flex justify-end gap-1">
              <button type="button" className={isPixel ? 'px-btn px-btn--sm px-btn--ghost !px-2 !py-1' : 'rounded border px-2 py-1 text-[10px]'} onClick={() => setResourceCategoryDraft(null)}>
                取消
              </button>
              <button type="submit" className={isPixel ? 'px-btn px-btn--sm !px-2 !py-1' : 'rounded border px-2 py-1 text-[10px] font-bold'}>
                创建
              </button>
            </div>
          </form>
        )}
      </div>
      {menu.kind !== 'set' && (
        <div
          className="py-1"
          style={{
            borderTop: isPixel ? '2px solid #1A1410' : `1px solid ${isDark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'}`,
          }}
        >
          <div className={`px-3 py-1.5 text-[10px] font-bold flex items-center gap-1.5 ${isDark && !isPixel ? 'text-white/65' : ''}`}>
            <CloudUpload size={12} />
            <span>上传到云端</span>
          </div>
          {cloudTargets.length === 0 ? (
            <div className={`px-3 pb-2 text-[11px] ${isPixel ? '' : isDark ? 'text-white/55' : 'text-zinc-500'}`}>
              未启用云端目标，请先到 API 设置中配置。
            </div>
          ) : (
            <div className="max-h-36 overflow-y-auto">
              {cloudTargets.map((target) => (
                <button
                  key={target.id}
                  className={itemCls}
                  onClick={() => uploadToCloud(target)}
                  disabled={!!cloudUploadingId}
                  title={target.label}
                >
                  <CloudUpload size={12} />
                  <span className="truncate">{target.label || target.id}</span>
                  {cloudUploadingId === target.id && <span className="ml-auto text-[10px]">上传中</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {message && (
        <div className={`px-3 py-2 text-[11px] ${isPixel ? 'border-t-2 border-[var(--px-ink)] bg-[var(--px-yellow)]' : isDark ? 'border-t border-white/10 text-white/70' : 'border-t border-black/10 text-zinc-600'}`}>
          {message}
          {cloudResult?.url && (
            <div className="mt-1 truncate" title={cloudResult.url}>
              {cloudResult.url}
            </div>
          )}
        </div>
      )}
    </div>
    {artistStyleDraft && menu?.kind === 'image' && (
      <div
        data-resource-context-menu
        className="fixed inset-0 z-[90] flex items-center justify-center bg-black/35 p-4 nodrag nopan"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setArtistStyleDraft(null);
        }}
      >
        <section
          className="w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-xl"
          style={{
            background: isPixel ? '#fffbea' : isDark ? 'rgba(16,20,28,.98)' : 'rgba(255,255,255,.98)',
            color: isPixel ? '#1A1410' : isDark ? '#f8fafc' : '#111827',
            border: isPixel ? '2px solid #1A1410' : `1px solid ${isDark ? 'rgba(125,211,252,.32)' : 'rgba(15,23,42,.16)'}`,
            boxShadow: isPixel ? '6px 6px 0 #1A1410' : '0 26px 70px rgba(0,0,0,.42)',
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header
            className="flex items-center gap-3 px-4 py-3"
            style={{
              borderBottom: isPixel ? '2px solid #1A1410' : `1px solid ${isDark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.08)'}`,
              background: isPixel ? '#A8E6C9' : isDark ? 'rgba(14,165,233,.12)' : 'rgba(14,165,233,.08)',
            }}
          >
            <Palette size={18} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold">保存风格到艺术风格大师</div>
              <div className={`text-[11px] ${isPixel ? 'opacity-75' : isDark ? 'text-white/60' : 'text-zinc-500'}`}>
                请确认或修改风格提示词，保存后会进入艺术风格大师自定义库。
              </div>
            </div>
            <button type="button" onClick={() => setArtistStyleDraft(null)} title="关闭">
              <X size={16} />
            </button>
          </header>
          <div className="grid gap-3 p-4 sm:grid-cols-[160px_minmax(0,1fr)]">
            <div
              className="overflow-hidden rounded-lg border"
              style={{
                borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.12)',
                background: '#000',
              }}
            >
              <SmartImage src={menu.previewUrl || menu.url || ''} alt={artistStyleDraft.name} className="h-40 w-full object-contain" thumbSize={480} draggable={false} />
            </div>
            <div className="min-w-0 space-y-2">
              <label className="block text-[11px] font-bold">
                风格名称
                <input
                  value={artistStyleDraft.name}
                  onChange={(event) => setArtistStyleDraft((draft) => draft ? { ...draft, name: event.target.value } : draft)}
                  className="mt-1 w-full rounded border px-3 py-2 text-[12px] outline-none"
                  style={{
                    borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                    background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.06)' : '#fff',
                    color: 'inherit',
                  }}
                />
              </label>
              <label className="block text-[11px] font-bold">
                分类
                <input
                  value={artistStyleDraft.categoryZh}
                  onChange={(event) => setArtistStyleDraft((draft) => draft ? { ...draft, categoryZh: event.target.value } : draft)}
                  className="mt-1 w-full rounded border px-3 py-2 text-[12px] outline-none"
                  style={{
                    borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                    background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.06)' : '#fff',
                    color: 'inherit',
                  }}
                />
              </label>
              <label className="block text-[11px] font-bold">
                标签
                <input
                  value={artistStyleDraft.tags}
                  onChange={(event) => setArtistStyleDraft((draft) => draft ? { ...draft, tags: event.target.value } : draft)}
                  className="mt-1 w-full rounded border px-3 py-2 text-[12px] outline-none"
                  style={{
                    borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                    background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.06)' : '#fff',
                    color: 'inherit',
                  }}
                  placeholder="用逗号分隔"
                />
              </label>
            </div>
            <label className="sm:col-span-2 block text-[11px] font-bold">
              风格提示词
              <textarea
                value={artistStyleDraft.prompt}
                onChange={(event) => setArtistStyleDraft((draft) => draft ? { ...draft, prompt: event.target.value } : draft)}
                className="mt-1 min-h-[120px] w-full resize-y rounded border px-3 py-2 text-[12px] leading-relaxed outline-none"
                style={{
                  borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(56,189,248,.45)' : 'rgba(14,165,233,.38)',
                  background: isPixel ? '#fff' : isDark ? 'rgba(2,6,23,.72)' : '#fff',
                  color: 'inherit',
                }}
                placeholder="可以手动填写，或点击自动获取提示词后再确认。"
              />
            </label>
            <label className="sm:col-span-2 block text-[11px] font-bold">
              负面提示词（可选）
              <input
                value={artistStyleDraft.negativePrompt}
                onChange={(event) => setArtistStyleDraft((draft) => draft ? { ...draft, negativePrompt: event.target.value } : draft)}
                className="mt-1 w-full rounded border px-3 py-2 text-[12px] outline-none"
                style={{
                  borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                  background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.06)' : '#fff',
                  color: 'inherit',
                }}
              />
            </label>
          </div>
          <footer
            className="flex flex-wrap justify-end gap-2 px-4 py-3"
            style={{
              borderTop: isPixel ? '2px solid #1A1410' : `1px solid ${isDark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.08)'}`,
            }}
          >
            <button type="button" className={isPixel ? 'px-btn px-btn--sm px-btn--ghost' : 'rounded border px-3 py-2 text-[12px]'} onClick={fillArtistStylePrompt}>
              <WandSparkles size={13} className="inline-block mr-1" />
              自动获取提示词
            </button>
            <button type="button" className={isPixel ? 'px-btn px-btn--sm px-btn--ghost' : 'rounded border px-3 py-2 text-[12px]'} onClick={() => setArtistStyleDraft(null)}>
              取消
            </button>
            <button
              type="button"
              className={isPixel ? 'px-btn px-btn--sm' : 'rounded border px-3 py-2 text-[12px] font-bold'}
              style={{
                background: isPixel ? undefined : isDark ? 'rgba(20,184,166,.22)' : 'rgba(20,184,166,.14)',
                borderColor: isPixel ? undefined : isDark ? 'rgba(94,234,212,.42)' : 'rgba(13,148,136,.28)',
              }}
              onClick={saveToArtistStyleMaster}
            >
              <Save size={13} className="inline-block mr-1" />
              确认保存
            </button>
          </footer>
        </section>
      </div>
    )}
    {animeTagDraft && menu?.kind === 'image' && (
      <div
        data-resource-context-menu
        className="fixed inset-0 z-[90] flex items-center justify-center bg-black/35 p-4 nodrag nopan"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setAnimeTagDraft(null);
        }}
      >
        <section
          className="w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-xl"
          style={{
            background: isPixel ? '#fffbea' : isDark ? 'rgba(16,20,28,.98)' : 'rgba(255,255,255,.98)',
            color: isPixel ? '#1A1410' : isDark ? '#f8fafc' : '#111827',
            border: isPixel ? '2px solid #1A1410' : `1px solid ${isDark ? 'rgba(125,211,252,.32)' : 'rgba(15,23,42,.16)'}`,
            boxShadow: isPixel ? '6px 6px 0 #1A1410' : '0 26px 70px rgba(0,0,0,.42)',
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header
            className="flex items-center gap-3 px-4 py-3"
            style={{
              borderBottom: isPixel ? '2px solid #1A1410' : `1px solid ${isDark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.08)'}`,
              background: isPixel ? '#A8E6C9' : isDark ? 'rgba(132,204,22,.16)' : 'rgba(132,204,22,.12)',
            }}
          >
            <Tags size={18} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold">保存动漫标签到动漫标签大师</div>
              <div className={`text-[11px] ${isPixel ? 'opacity-75' : isDark ? 'text-white/60' : 'text-zinc-500'}`}>
                请确认或修改动漫标签提示词，保存后会进入动漫标签大师自定义库。
              </div>
            </div>
            <button type="button" onClick={() => setAnimeTagDraft(null)} title="关闭">
              <X size={16} />
            </button>
          </header>
          <div className="grid gap-3 p-4 sm:grid-cols-[160px_minmax(0,1fr)]">
            <div
              className="overflow-hidden rounded-lg border"
              style={{
                borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.12)',
                background: '#000',
              }}
            >
              <SmartImage src={menu.previewUrl || menu.url || ''} alt={animeTagDraft.name} className="h-40 w-full object-contain" thumbSize={480} draggable={false} />
            </div>
            <div className="min-w-0 space-y-2">
              <label className="block text-[11px] font-bold">
                标签名称
                <input
                  value={animeTagDraft.name}
                  onChange={(event) => setAnimeTagDraft((draft) => draft ? { ...draft, name: event.target.value } : draft)}
                  className="mt-1 w-full rounded border px-3 py-2 text-[12px] outline-none"
                  style={{
                    borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                    background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.06)' : '#fff',
                    color: 'inherit',
                  }}
                />
              </label>
              <label className="block text-[11px] font-bold">
                分类
                <input
                  value={animeTagDraft.categoryName}
                  onChange={(event) => setAnimeTagDraft((draft) => draft ? { ...draft, categoryName: event.target.value } : draft)}
                  className="mt-1 w-full rounded border px-3 py-2 text-[12px] outline-none"
                  style={{
                    borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                    background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.06)' : '#fff',
                    color: 'inherit',
                  }}
                />
              </label>
              <label className="block text-[11px] font-bold">
                标签
                <input
                  value={animeTagDraft.tags}
                  onChange={(event) => setAnimeTagDraft((draft) => draft ? { ...draft, tags: event.target.value } : draft)}
                  className="mt-1 w-full rounded border px-3 py-2 text-[12px] outline-none"
                  style={{
                    borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                    background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.06)' : '#fff',
                    color: 'inherit',
                  }}
                  placeholder="1girl, solo, key visual"
                />
              </label>
            </div>
            <label className="sm:col-span-2 block text-[11px] font-bold">
              动漫标签提示词
              <textarea
                value={animeTagDraft.prompt}
                onChange={(event) => setAnimeTagDraft((draft) => draft ? { ...draft, prompt: event.target.value } : draft)}
                className="mt-1 min-h-[120px] w-full resize-y rounded border px-3 py-2 text-[12px] leading-relaxed outline-none"
                style={{
                  borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(132,204,22,.55)' : 'rgba(101,163,13,.36)',
                  background: isPixel ? '#fff' : isDark ? 'rgba(2,6,23,.72)' : '#fff',
                  color: 'inherit',
                }}
                placeholder="可以手动填写，或点击自动获取提示词后再确认。"
              />
            </label>
            <label className="sm:col-span-2 block text-[11px] font-bold">
              负面提示词（可选）
              <input
                value={animeTagDraft.negativePrompt}
                onChange={(event) => setAnimeTagDraft((draft) => draft ? { ...draft, negativePrompt: event.target.value } : draft)}
                className="mt-1 w-full rounded border px-3 py-2 text-[12px] outline-none"
                style={{
                  borderColor: isPixel ? '#1A1410' : isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.14)',
                  background: isPixel ? '#fff' : isDark ? 'rgba(255,255,255,.06)' : '#fff',
                  color: 'inherit',
                }}
              />
            </label>
          </div>
          <footer
            className="flex flex-wrap justify-end gap-2 px-4 py-3"
            style={{
              borderTop: isPixel ? '2px solid #1A1410' : `1px solid ${isDark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.08)'}`,
            }}
          >
            <button type="button" className={isPixel ? 'px-btn px-btn--sm px-btn--ghost' : 'rounded border px-3 py-2 text-[12px]'} onClick={fillAnimeTagPrompt}>
              <WandSparkles size={13} className="inline-block mr-1" />
              自动获取提示词
            </button>
            <button type="button" className={isPixel ? 'px-btn px-btn--sm px-btn--ghost' : 'rounded border px-3 py-2 text-[12px]'} onClick={() => setAnimeTagDraft(null)}>
              取消
            </button>
            <button
              type="button"
              className={isPixel ? 'px-btn px-btn--sm' : 'rounded border px-3 py-2 text-[12px] font-bold'}
              style={{
                background: isPixel ? undefined : isDark ? 'rgba(132,204,22,.24)' : 'rgba(132,204,22,.16)',
                borderColor: isPixel ? undefined : isDark ? 'rgba(190,242,100,.48)' : 'rgba(101,163,13,.32)',
              }}
              onClick={saveToAnimeTagMaster}
            >
              <Save size={13} className="inline-block mr-1" />
              确认保存
            </button>
          </footer>
        </section>
      </div>
    )}
    </>
  );
}
