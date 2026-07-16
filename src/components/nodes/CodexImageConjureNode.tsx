import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import {
  Archive,
  Copy,
  Download,
  FileDown,
  FileUp,
  ImagePlus,
  Library,
  ListChecks,
  Loader2,
  PackagePlus,
  Play,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import * as api from '../../services/api';
import { getCodexCliStatus, startCodexCliLogin, type CodexCliStatus } from '../../services/codexCli';
import { publishCodexImageConjureResult, streamCodexImageConjure, type CodexImageConjureResult } from '../../services/codexImageConjure';
import { PORT_COLOR } from '../../config/portTypes';
import { useRunTrigger } from '../../hooks/useRunTrigger';
import { createCanvasNodeRunRequestId, requestCanvasNodeRun } from '../../utils/canvasRunRequest';
import { useThemeStore } from '../../stores/theme';
import type { RunNodeLifecycleReporter } from '../../types/project';
import {
  DEFAULT_CODEX_IMAGE_TEMPLATES,
  buildCodexImageConjurePrompt,
  createCodexImageConjureTask,
  deleteCodexImageSnippet,
  deleteCodexImageTemplate,
  enqueueCodexImageConjureTasks,
  exportCodexImagePromptPack,
  importCodexImagePromptPack,
  normalizeCodexImagePromptState,
  trimCodexImageConjureHistory,
  updateCodexImageConjureTask,
  upsertCodexImageSnippet,
  upsertCodexImageTemplate,
  type CodexImageConjureTask,
  type CodexImagePromptSnippet,
  type CodexImagePromptState,
  type CodexImagePromptTemplate,
} from '../../utils/codexImageConjure';
import MentionPromptInput from './MentionPromptInput';
import MaterialPreviewSection from './MaterialPreviewSection';
import { resolveMediaMentions, type MediaMention } from './mediaMentions';
import { useUpdateNodeData } from './useUpdateNodeData';
import { useUpstreamMaterials, type Material } from './useUpstreamMaterials';
import { useOrderedMaterials } from './useOrderedMaterials';
import {
  countExcludedMaterials,
  excludeMaterialId,
  filterExcludedMaterials,
  normalizeExcludedMaterialIds,
} from '../../utils/materialExclusion';

const STORAGE_KEY = 't8.codexImageConjure.prompts.v1';
const codexLoginCommand = 'codex login';
const codexInstallCommand = 'npm install -g @openai/codex';
const CODEX_LOGIN_FLOW_STEPS = [
  '1. 点击“打开登录”，T8 会在 Windows 上打开一个可见的 Codex 登录窗口。',
  '2. 按新窗口或浏览器里的 OpenAI / Codex 授权提示完成登录；如果显示验证码或链接，请按终端提示操作。',
  '3. 登录完成后回到 T8，点击“刷新”，看到“Codex 已就绪”后即可生成。',
  '如果点击没有弹窗：点“复制登录命令”，在普通 CMD 或 PowerShell 里粘贴运行 codex login；未安装时先复制安装命令。',
];

const CODEX_CONJURE_MODELS = [
  { value: 'gpt-5.5', label: 'GPT-5.5（推荐）' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
  { value: '', label: '默认模型' },
];

type PanelKey = 'queue' | 'gallery' | 'template' | 'snippet' | 'settings';

const PANEL_TABS: Array<{ key: PanelKey; label: string }> = [
  { key: 'queue', label: '任务队列' },
  { key: 'gallery', label: '公共图库' },
  { key: 'template', label: '模板工坊' },
  { key: 'snippet', label: '片段工坊' },
  { key: 'settings', label: '设置' },
];

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numberValue)));
}

function initialPromptState(): CodexImagePromptState {
  if (typeof window === 'undefined') {
    return normalizeCodexImagePromptState({ templates: DEFAULT_CODEX_IMAGE_TEMPLATES });
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeCodexImagePromptState(JSON.parse(raw));
  } catch {
    // ignore corrupted local prompt pack
  }
  return normalizeCodexImagePromptState({ templates: DEFAULT_CODEX_IMAGE_TEMPLATES });
}

function savePromptState(state: CodexImagePromptState) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(exportCodexImagePromptPack(state)));
}

function downloadJsonFile(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function fileNameFromUrl(url: string) {
  try {
    return decodeURIComponent(url.split('?')[0].split('/').pop() || url).slice(0, 72);
  } catch {
    return (url.split('?')[0].split('/').pop() || url).slice(0, 72);
  }
}

function materialKey(material: Material) {
  return `${material.kind}:${material.url}`;
}

function resultImageUrls(result?: CodexImageConjureResult | null) {
  return unique([...(Array.isArray(result?.imageUrls) ? result.imageUrls : []), result?.imageUrl || '']);
}

function resultArray<T>(result: api.Result<T[]>): T[] {
  return result.success && Array.isArray(result.data) ? result.data : [];
}

function normalizeTasks(value: unknown): CodexImageConjureTask[] {
  if (!Array.isArray(value)) return [];
  return value.map((task) => createCodexImageConjureTask(task)).slice(0, 80);
}

function taskStatusLabel(task: CodexImageConjureTask) {
  if (task.status === 'queued') return '待运行';
  if (task.status === 'running') return '生成中';
  if (task.status === 'completed') return '已完成';
  if (task.status === 'cancelled') return '已取消';
  return '失败';
}

function compactText(value: string, max = 72) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function isRouteMissingMessage(message: string) {
  return /后端路由未加载|HTTP\s*404|404\s*\(Not Found\)/i.test(message || '');
}

function friendlyCodexErrorMessage(message: any) {
  const text = String(message || '').trim();
  if (!text) return '';
  if (isRouteMissingMessage(text)) return 'Codex CLI 后端路由未加载：请重启后端服务或桌面应用，让 /api/codex-cli 生效。';
  return text;
}

const CodexImageConjureNode = ({ id, data, selected }: NodeProps) => {
  const d = data as any;
  const update = useUpdateNodeData(id);
  const rf = useReactFlow();
  const { theme, style } = useThemeStore();
  const isDark = theme === 'dark';
  const isPixel = style === 'pixel';
  const upstream = useUpstreamMaterials(id);
  const importRef = useRef<HTMLInputElement | null>(null);
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const tasksRef = useRef<CodexImageConjureTask[]>([]);
  const [status, setStatus] = useState<CodexCliStatus | null>(null);
  const [promptState, setPromptState] = useState<CodexImagePromptState>(() => initialPromptState());
  const [galleryItems, setGalleryItems] = useState<api.ResourceItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [panel, setPanel] = useState<PanelKey>('queue');
  const [templateDraft, setTemplateDraft] = useState({
    id: '',
    title: '',
    shortTitle: '',
    category: '常用',
    content: '',
    notes: '',
    tags: '',
  });
  const [snippetDraft, setSnippetDraft] = useState({
    id: '',
    tag: '',
    title: '',
    category: '常用',
    content: '',
  });

  const prompt = String(d.codexConjurePrompt || '');
  const mentions: MediaMention[] = Array.isArray(d.codexConjurePromptMentions) ? d.codexConjurePromptMentions : [];
  const galleryRefs: string[] = Array.isArray(d.codexConjureGalleryRefs) ? d.codexConjureGalleryRefs : [];
  const tasks = useMemo(() => trimCodexImageConjureHistory(normalizeTasks(d.codexConjureTasks), 30), [d.codexConjureTasks]);
  const latestResult = d.codexConjureLastResult as CodexImageConjureResult | undefined;
  const latestUrls = resultImageUrls(latestResult);
  const count = clampNumber(d.codexConjureCount, 1, 4, 1);
  const batchCount = clampNumber(d.codexConjureBatchCount, 1, 20, 1);
  const concurrency = clampNumber(d.codexConjureConcurrency, 1, 4, 1);
  const autoPublish = d.codexConjureAutoPublish !== false;
  const persistPrompt = Boolean(d.codexConjurePersistPrompt);
  const persistRefs = d.codexConjurePersistRefs !== false;
  const materialOrder: string[] = Array.isArray(d.codexConjureMaterialOrder) ? d.codexConjureMaterialOrder : [];
  const excludedMaterialIds = useMemo(
    () => normalizeExcludedMaterialIds(d.codexConjureExcludedMaterialIds),
    [d.codexConjureExcludedMaterialIds],
  );

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  const galleryMaterials = useMemo<Material[]>(() => (
    galleryRefs.map((url, index) => ({
      id: `gallery:${index}:${url}`,
      kind: 'image' as const,
      url,
      sourceNodeId: id,
      origin: 'local' as const,
      label: fileNameFromUrl(url),
    }))
  ), [galleryRefs, id]);
  const visibleUpstreamTexts = useMemo(
    () => filterExcludedMaterials(upstream.texts, excludedMaterialIds),
    [upstream.texts, excludedMaterialIds],
  );
  const visibleUpstreamImages = useMemo(
    () => filterExcludedMaterials(upstream.images, excludedMaterialIds),
    [upstream.images, excludedMaterialIds],
  );
  const inputImageMaterials = useMemo(
    () => [...visibleUpstreamImages, ...galleryMaterials],
    [galleryMaterials, visibleUpstreamImages],
  );
  const orderedInputImages = useOrderedMaterials(inputImageMaterials, materialOrder);
  const orderedInputTexts = useOrderedMaterials(visibleUpstreamTexts, materialOrder);
  const excludedUpstreamCount = useMemo(
    () => countExcludedMaterials(excludedMaterialIds, [...upstream.texts, ...upstream.images]),
    [excludedMaterialIds, upstream.texts, upstream.images],
  );
  const setMaterialOrder = useCallback((nextOrder: string[]) => update({ codexConjureMaterialOrder: nextOrder }), [update]);
  const excludeUpstreamMaterial = useCallback((material: Material) => {
    if (material.origin !== 'upstream') return;
    update({
      codexConjureExcludedMaterialIds: excludeMaterialId(excludedMaterialIds, material.id),
      codexConjureMaterialOrder: materialOrder.filter((itemId) => itemId !== material.id),
    });
  }, [excludedMaterialIds, materialOrder, update]);
  const removeGalleryMaterial = useCallback((material: Material) => {
    if (material.origin !== 'local') return;
    update({
      codexConjureGalleryRefs: galleryRefs.filter((url) => url !== material.url),
      codexConjureMaterialOrder: materialOrder.filter((itemId) => itemId !== material.id),
    });
  }, [galleryRefs, materialOrder, update]);
  const restoreExcludedMaterials = useCallback(() => update({ codexConjureExcludedMaterialIds: [] }), [update]);

  const mentionMaterials = useMemo<Material[]>(() => {
    const all = [...orderedInputTexts, ...orderedInputImages];
    const seen = new Set<string>();
    return all.filter((item) => {
      const key = materialKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [orderedInputImages, orderedInputTexts]);

  const selectedTemplate = useMemo(
    () => promptState.templates.find((item) => item.id === d.codexConjureTemplateId) || promptState.templates[0] || null,
    [d.codexConjureTemplateId, promptState.templates],
  );

  const filteredSnippets = useMemo(() => {
    const query = String(d.codexConjureSnippetQuery || '').trim().replace(/^~+/, '').toLowerCase();
    const pool = promptState.snippets;
    if (!query) return pool.slice(0, 12);
    return pool
      .filter((item) => `${item.tag} ${item.title} ${item.category} ${item.content}`.toLowerCase().includes(query))
      .slice(0, 12);
  }, [d.codexConjureSnippetQuery, promptState.snippets]);

  const accent = isPixel ? 'var(--px-cyan)' : isDark ? '#38bdf8' : '#0284c7';
  const bg = isPixel ? 'var(--px-surface)' : isDark ? 'rgba(8,13,28,0.97)' : '#f8fdff';
  const surface = isPixel ? 'var(--px-muted)' : isDark ? 'rgba(255,255,255,0.06)' : 'rgba(14,165,233,0.08)';
  const surfaceStrong = isPixel ? 'var(--px-yellow)' : isDark ? 'rgba(56,189,248,0.18)' : 'rgba(14,165,233,0.16)';
  const text = isPixel ? 'var(--px-ink)' : isDark ? '#ecfeff' : '#0f172a';
  const subText = isPixel ? 'var(--px-ink-soft)' : isDark ? 'rgba(236,254,255,0.68)' : '#4b6475';
  const border = isPixel ? 'var(--px-ink)' : isDark ? 'rgba(125,211,252,0.28)' : 'rgba(2,132,199,0.25)';

  const rootStyle: CSSProperties = {
    width: 520,
    background: bg,
    color: text,
    border: `2px solid ${selected ? accent : border}`,
    borderRadius: isPixel ? 8 : 18,
    boxShadow: isPixel ? '4px 4px 0 var(--px-ink)' : '0 18px 50px rgba(2, 8, 23, 0.32)',
    overflow: 'visible',
  };

  const cardStyle: CSSProperties = {
    border: `1px solid ${border}`,
    background: surface,
    borderRadius: isPixel ? 6 : 14,
  };

  const inputStyle: CSSProperties = {
    border: `1px solid ${border}`,
    background: isDark ? 'rgba(2,6,23,0.75)' : '#ffffff',
    color: text,
    borderRadius: isPixel ? 4 : 10,
  };

  const buttonStyle: CSSProperties = {
    border: `1px solid ${border}`,
    background: surfaceStrong,
    color: text,
    borderRadius: isPixel ? 4 : 10,
  };

  const setTasks = useCallback((next: CodexImageConjureTask[]) => {
    const trimmed = trimCodexImageConjureHistory(next, 30);
    tasksRef.current = trimmed;
    update({ codexConjureTasks: trimmed });
  }, [update]);

  const patchTask = useCallback((taskId: string, patch: Partial<CodexImageConjureTask>) => {
    setTasks(updateCodexImageConjureTask(tasksRef.current, taskId, patch));
  }, [setTasks]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getCodexCliStatus(String(d.codexExecutablePath || '').trim() || undefined);
      setStatus(next);
      if (next.available && d.error && /Codex CLI 不可用|没有登录|需要登录|后端路由未加载/i.test(String(d.error))) {
        update({ error: '' });
      }
    } catch (error: any) {
      setStatus({ available: false, message: friendlyCodexErrorMessage(error?.message || 'Codex CLI 状态检查失败') });
    }
  }, [d.codexExecutablePath, d.error, update]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    let alive = true;
    api.getResourceItems({ kind: 'image', q: String(d.codexConjureGalleryQuery || '') })
      .then((result) => {
        if (alive) setGalleryItems(resultArray(result).slice(0, 10));
      })
      .catch(() => {
        if (alive) setGalleryItems([]);
      });
    return () => {
      alive = false;
    };
  }, [d.codexConjureGalleryQuery]);

  const applyPromptState = useCallback((next: CodexImagePromptState) => {
    setPromptState(next);
    savePromptState(next);
  }, []);

  const importPromptPack = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const textValue = await file.text();
      const parsed = JSON.parse(textValue);
      const next = importCodexImagePromptPack(parsed, promptState);
      applyPromptState(next);
      update({ codexConjureLastRunSummary: `已导入 ${next.templates.length} 个模板、${next.snippets.length} 个片段` });
    } catch (error: any) {
      update({ error: error?.message || '导入失败' });
    }
  }, [applyPromptState, promptState, update]);

  const exportPromptPack = useCallback(() => {
    downloadJsonFile('codex-image-conjure-prompts.json', exportCodexImagePromptPack(promptState));
  }, [promptState]);

  const copyCodexSetupCommand = useCallback((value: string, label: string) => {
    const textValue = String(value || '').trim();
    if (!textValue) return;
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (!clipboard?.writeText) {
      update({ codexConjureLastRunSummary: '当前环境不支持直接复制，请手动选中命令复制。' });
      return;
    }
    void clipboard.writeText(textValue)
      .then(() => update({ codexConjureLastRunSummary: `已复制${label}：${textValue}` }))
      .catch((error: any) => update({ codexConjureLastRunSummary: error?.message || `${label}复制失败，请手动选中命令复制。` }));
  }, [update]);

  const openCodexLogin = useCallback(async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    const openingMessage = '正在打开 Codex 登录窗口；如果没有弹出窗口，请复制 codex login 到 CMD 或 PowerShell 手动运行。';
    setStatus((previous) => ({ ...(previous || { available: false }), available: false, message: openingMessage }));
    update({ error: '', codexConjureLastRunSummary: openingMessage });
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
      update({
        error: '',
        codexConjureLastRunSummary: message,
      });
      setTimeout(() => void refreshStatus(), 1600);
    } catch (error: any) {
      const message = friendlyCodexErrorMessage(error?.message || '打开 Codex 登录失败');
      setStatus({ available: false, message });
      update({ error: message });
    } finally {
      setLoginBusy(false);
    }
  }, [d.codexExecutablePath, loginBusy, refreshStatus, update]);

  const applyTemplate = useCallback((templateId: string) => {
    const template = promptState.templates.find((item) => item.id === templateId);
    update({
      codexConjureTemplateId: templateId,
      codexConjurePrompt: template?.content || prompt,
      codexConjurePromptMentions: [],
    });
  }, [prompt, promptState.templates, update]);

  const loadTemplateDraft = useCallback((template?: CodexImagePromptTemplate | null) => {
    setTemplateDraft({
      id: template?.id || '',
      title: template?.title || '',
      shortTitle: template?.shortTitle || '',
      category: template?.category || '常用',
      content: template?.content || '',
      notes: template?.notes || '',
      tags: template?.tags?.join(', ') || '',
    });
    setPanel('template');
  }, []);

  const saveTemplateDraft = useCallback(() => {
    if (!templateDraft.title.trim() || !templateDraft.content.trim()) {
      update({ error: '模板需要名称和提示词内容。' });
      return;
    }
    const next = upsertCodexImageTemplate(promptState, {
      id: templateDraft.id,
      title: templateDraft.title,
      shortTitle: templateDraft.shortTitle || templateDraft.title,
      category: templateDraft.category || '常用',
      content: templateDraft.content,
      notes: templateDraft.notes,
      tags: templateDraft.tags.split(/[,\s，、]+/).filter(Boolean),
      mode: 'any',
      modelHint: 'gpt-image-2',
    });
    applyPromptState(next);
    const saved = next.templates.find((item) => item.title === templateDraft.title);
    update({ codexConjureTemplateId: saved?.id || d.codexConjureTemplateId, codexConjureLastRunSummary: '模板已保存，可在下拉列表中选择。' });
  }, [applyPromptState, d.codexConjureTemplateId, promptState, templateDraft, update]);

  const removeTemplateDraft = useCallback(() => {
    const targetId = templateDraft.id || selectedTemplate?.id;
    if (!targetId) return;
    const next = deleteCodexImageTemplate(promptState, targetId);
    applyPromptState(next);
    setTemplateDraft({ id: '', title: '', shortTitle: '', category: '常用', content: '', notes: '', tags: '' });
    update({ codexConjureTemplateId: next.templates[0]?.id || '', codexConjureLastRunSummary: '模板已删除。' });
  }, [applyPromptState, promptState, selectedTemplate?.id, templateDraft.id, update]);

  const saveSnippetDraft = useCallback(() => {
    if (!snippetDraft.tag.trim() || !snippetDraft.content.trim()) {
      update({ error: '片段需要触发词和内容。' });
      return;
    }
    const next = upsertCodexImageSnippet(promptState, {
      id: snippetDraft.id,
      tag: snippetDraft.tag,
      title: snippetDraft.title || snippetDraft.tag,
      category: snippetDraft.category || '常用',
      content: snippetDraft.content,
    });
    applyPromptState(next);
    update({ codexConjureLastRunSummary: '片段已保存，可用 ~tag 插入。' });
  }, [applyPromptState, promptState, snippetDraft, update]);

  const removeSnippetDraft = useCallback((snippet?: CodexImagePromptSnippet) => {
    const target = snippet?.tag || snippetDraft.tag || snippetDraft.id;
    if (!target) return;
    const next = deleteCodexImageSnippet(promptState, target);
    applyPromptState(next);
    if (!snippet) setSnippetDraft({ id: '', tag: '', title: '', category: '常用', content: '' });
    update({ codexConjureLastRunSummary: '片段已删除。' });
  }, [applyPromptState, promptState, snippetDraft.id, snippetDraft.tag, update]);

  const insertSnippet = useCallback((tag: string) => {
    const next = prompt ? `${prompt.trim()} ~${tag}` : `~${tag}`;
    update({ codexConjurePrompt: next });
  }, [prompt, update]);

  const toggleGalleryRef = useCallback((url: string) => {
    const next = galleryRefs.includes(url) ? galleryRefs.filter((item) => item !== url) : [...galleryRefs, url];
    update({ codexConjureGalleryRefs: next.slice(0, 12), codexConjureLastRunSummary: galleryRefs.includes(url) ? '已移除参考图。' : '已加入参考图。' });
  }, [galleryRefs, update]);

  const buildCurrentTaskInput = useCallback(() => {
    const upstreamTexts = orderedInputTexts.map((item) => item.url).filter(Boolean);
    const resolvedLocal = resolveMediaMentions(prompt, mentions, mentionMaterials).trim();
    const mentionedImageUrls = mentions.filter((mention) => mention.kind === 'image').map((mention) => mention.url);
    const imageRefs = unique([
      ...mentionedImageUrls,
      ...orderedInputImages.map((item) => item.url),
    ]);
    const promptBody = buildCodexImageConjurePrompt({
      upstreamTexts,
      templateNotes: selectedTemplate?.notes || '',
      prompt: resolvedLocal,
      snippets: promptState.snippets,
      negativePrompt: String(d.codexConjureNegativePrompt || ''),
      outputSettings: {
        model: String(d.codexConjureModel || 'gpt-5.5'),
        size: String(d.codexConjureSize || '2K'),
        aspectRatio: String(d.codexConjureAspectRatio || '9:16'),
        quality: String(d.codexConjureQuality || '高'),
        count,
        promptMode: String(d.codexConjurePromptMode || '原始模式'),
        format: String(d.codexConjureFormat || 'png'),
        background: String(d.codexConjureBackground || '自动'),
      },
    });
    const referenceInstruction = imageRefs.length
      ? `参考图要求: 已附加 ${imageRefs.length} 张参考图。生成时必须优先继承参考图中的主体身份、构图关系、色彩线索和材质细节；如果用户要求变体，也要保持与参考图的可识别关联。`
      : '';
    return {
      prompt: [referenceInstruction, promptBody].filter(Boolean).join('\n\n').trim(),
      images: imageRefs,
      model: String(d.codexConjureModel || 'gpt-5.5'),
      size: String(d.codexConjureSize || '2K'),
      aspectRatio: String(d.codexConjureAspectRatio || '9:16'),
      quality: String(d.codexConjureQuality || '高'),
      count,
    };
  }, [count, d.codexConjureAspectRatio, d.codexConjureBackground, d.codexConjureFormat, d.codexConjureModel, d.codexConjureNegativePrompt, d.codexConjurePromptMode, d.codexConjureQuality, d.codexConjureSize, mentionMaterials, mentions, orderedInputImages, orderedInputTexts, prompt, promptState.snippets, selectedTemplate?.notes]);

  const addLatestToLibrary = useCallback(async () => {
    const url = latestUrls[0];
    if (!url) return;
    try {
      const added = await api.addResourceItem({
        url,
        kind: 'image',
        title: fileNameFromUrl(url),
        tags: ['codex', 'conjure'],
        sourceNodeId: id,
      });
      if (!added.success) throw new Error(added.error || '入库失败');
      update({ codexConjureLastRunSummary: '已入库到资源库图像素材' });
      void api.getResourceItems({ kind: 'image', q: String(d.codexConjureGalleryQuery || '') }).then((result) => setGalleryItems(resultArray(result).slice(0, 10)));
    } catch (error: any) {
      update({ error: error?.message || '入库失败' });
    }
  }, [d.codexConjureGalleryQuery, id, latestUrls, update]);

  const runTask = useCallback(async (task: CodexImageConjureTask, reporter?: RunNodeLifecycleReporter) => {
    const controller = new AbortController();
    controllersRef.current.set(task.id, controller);
    let reply = '';
    patchTask(task.id, { status: 'running', progressText: 'Codex 正在生成...', startedAt: new Date().toISOString(), error: '' });
    setStreamText('');
    try {
      await reporter?.providerRequest({
        provider: 'codex-cli',
        ...(task.model ? { model: task.model } : {}),
        requestId: task.id,
        queueIndex: task.queueIndex,
      });
      const result = await streamCodexImageConjure(
        {
          nodeId: id,
          prompt: task.prompt,
          images: task.images,
          selectedSkillNames: ['imagegen'],
          model: task.model,
          size: task.size,
          aspectRatio: task.aspectRatio,
          quality: task.quality,
          count: task.count,
          executablePath: String(d.codexExecutablePath || ''),
        },
        {
          signal: controller.signal,
          onDelta: (delta) => {
            reply += delta;
            setStreamText((prev) => `${prev}${delta}`);
          },
        },
      );
      const published = publishCodexImageConjureResult(result, { maxImages: task.count }) as CodexImageConjureResult;
      const canvasPublished = publishCodexImageConjureResult(result, { maxImages: task.count, includeText: false }) as CodexImageConjureResult;
      patchTask(task.id, {
        status: 'completed',
        progressText: `完成 ${published.imageUrls.length} 张`,
        resultImageUrls: published.imageUrls,
        resultText: published.outputText || reply,
        completedAt: new Date().toISOString(),
      });
      update({
        status: 'success',
        error: '',
        codexConjureLastResult: published,
        codexConjureLastRunSummary: `已生成 ${published.imageUrls.length} 张图像${autoPublish ? '，并发布到输出素材' : ''}`,
        ...(autoPublish ? {
          imageUrl: canvasPublished.imageUrl,
          imageUrls: canvasPublished.imageUrls,
          outputText: canvasPublished.outputText,
        } : {}),
        ...(persistPrompt ? {} : { codexConjurePrompt: '', codexConjurePromptMentions: [] }),
        ...(persistRefs ? {} : { codexConjureGalleryRefs: [] }),
      });
      await reporter?.providerResponse({
        provider: 'codex-cli',
        ...(task.model ? { model: task.model } : {}),
        requestId: task.id,
        status: 'succeeded',
        outputCount: published.imageUrls.length,
      });
      return published;
    } catch (error: any) {
      const aborted = error?.name === 'AbortError';
      patchTask(task.id, {
        status: aborted ? 'cancelled' : 'failed',
        error: aborted ? '用户停止' : (error?.message || '生成失败'),
        progressText: aborted ? '已停止' : '失败',
        completedAt: new Date().toISOString(),
      });
      if (!aborted) {
        update({ status: 'error', error: error?.message || '生成失败' });
      }
      await reporter?.providerResponse({
        provider: 'codex-cli',
        ...(task.model ? { model: task.model } : {}),
        requestId: task.id,
        status: aborted ? 'stopped' : 'failed',
        error: error?.message || (aborted ? '用户停止' : '生成失败'),
      });
      return null;
    } finally {
      controllersRef.current.delete(task.id);
    }
  }, [autoPublish, d.codexExecutablePath, id, patchTask, persistPrompt, persistRefs, update]);

  const handleGenerate = useCallback(async (reporter?: RunNodeLifecycleReporter) => {
    if (busy) throw new Error('Codex 图像节点已有任务正在运行，请先停止后再试。');
    const input = buildCurrentTaskInput();
    if (!input.prompt) {
      const message = '请填写提示词，或连接上游文本节点。';
      update({ status: 'error', error: message });
      throw new Error(message);
    }
    const task = createCodexImageConjureTask(input);
    setTasks([...tasksRef.current, task]);
    setBusy(true);
    update({ status: 'running', error: '', codexConjureLastRunSummary: 'Codex 正在生成图像...' });
    try {
      await runTask(task, reporter);
    } finally {
      setBusy(false);
    }
  }, [buildCurrentTaskInput, busy, runTask, setTasks, update]);

  const addToQueue = useCallback(() => {
    const input = buildCurrentTaskInput();
    if (!input.prompt) {
      update({ error: '请填写提示词，或连接上游文本节点。' });
      return;
    }
    const next = enqueueCodexImageConjureTasks(tasksRef.current, input, batchCount);
    setTasks(next);
    setPanel('queue');
    update({ codexConjureLastRunSummary: `已加入 ${batchCount} 个任务到队列。` });
  }, [batchCount, buildCurrentTaskInput, setTasks, update]);

  const runQueue = useCallback(async (reporter?: RunNodeLifecycleReporter) => {
    if (busy) throw new Error('Codex 图像节点已有任务正在运行，请先停止后再试。');
    let pending = tasksRef.current.filter((task) => task.status === 'queued');
    if (!pending.length) {
      const input = buildCurrentTaskInput();
      if (!input.prompt) {
        const message = '请填写提示词，或连接上游文本节点。';
        update({ status: 'error', error: message });
        throw new Error(message);
      }
      const next = enqueueCodexImageConjureTasks(tasksRef.current, input, batchCount);
      setTasks(next);
      pending = next.filter((task) => task.status === 'queued');
    }
    setBusy(true);
    update({ status: 'running', error: '', codexConjureLastRunSummary: `队列启动：${pending.length} 个任务，并发 ${concurrency}` });
    let failedCount = 0;
    try {
      while (pending.length) {
        const batch = pending.slice(0, concurrency);
        const results = await Promise.all(batch.map((task) => runTask(task, reporter)));
        failedCount += results.filter((result) => !result).length;
        pending = tasksRef.current.filter((task) => task.status === 'queued');
        if (!pending.length) break;
      }
      if (failedCount > 0) {
        const message = `任务队列有 ${failedCount} 个任务失败或停止`;
        update({ status: 'error', error: message, codexConjureLastRunSummary: message });
        throw new Error(message);
      }
      update({ status: 'success', codexConjureLastRunSummary: '任务队列已完成。' });
    } finally {
      setBusy(false);
    }
  }, [batchCount, buildCurrentTaskInput, busy, concurrency, runTask, setTasks, update]);

  const handleStop = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    const cancelled = tasksRef.current.map((task) => (task.status === 'running' || task.status === 'queued'
      ? createCodexImageConjureTask({ ...task, status: 'cancelled', progressText: '已停止', completedAt: new Date().toISOString() })
      : task));
    setTasks(cancelled);
    setBusy(false);
    update({ status: 'idle', codexConjureLastRunSummary: '已停止生成' });
  }, [setTasks, update]);

  const clearFinishedTasks = useCallback(() => {
    setTasks(tasksRef.current.filter((task) => task.status === 'queued' || task.status === 'running'));
  }, [setTasks]);

  const createVariant = useCallback(() => {
    const url = latestUrls[0];
    update({
      codexConjureGalleryRefs: url ? unique([...galleryRefs, url]).slice(0, 12) : galleryRefs,
      codexConjurePrompt: prompt ? `${prompt}\n\n变体：保持核心主体和风格，换一个构图、光线或背景方案。` : '变体：保持核心主体和风格，换一个构图、光线或背景方案。',
      codexConjureLastRunSummary: '已准备变体提示词。',
    });
  }, [galleryRefs, latestUrls, prompt, update]);

  const requestQueueRun = useCallback(() => {
    const requestId = createCanvasNodeRunRequestId(id, 'codex-queue');
    update({
      codexConjureRunMode: 'queue',
      codexConjureRunRequestId: requestId,
    });
    // Persist the exact secondary intent before Canvas snapshots the node for
    // its execution digest and confirmation preview.
    window.requestAnimationFrame(() => {
      if (requestCanvasNodeRun(id, { requestId })) return;
      const liveData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
      if (liveData?.codexConjureRunRequestId !== requestId) return;
      update({
        codexConjureRunMode: 'single',
        codexConjureRunRequestId: '',
        status: 'error',
        error: '无法请求任务队列运行体检',
      });
    });
  }, [id, rf, update]);

  useRunTrigger(id, async (reporter) => {
    const liveData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
    const contextRequestId = String(reporter.runContext?.requestId || '').trim();
    const persistedRequestId = String(liveData?.codexConjureRunRequestId || '').trim();
    const requestedMode = String(liveData?.codexConjureRunMode || '').trim();
    try {
      // Ordinary canvas/group runs have no persisted node-surface intent and
      // retain the normal single-generation behavior.
      if (!persistedRequestId) {
        await handleGenerate(reporter);
        return;
      }
      if (!contextRequestId || contextRequestId !== persistedRequestId) {
        throw new Error('Codex 队列运行请求已变化或失效，已拒绝执行。');
      }
      if (requestedMode !== 'queue') {
        throw new Error('Codex 队列运行模式无效，已拒绝执行。');
      }
      await runQueue(reporter);
    } finally {
      if (contextRequestId) {
        const latestData = rf.getNode(id)?.data as Record<string, unknown> | undefined;
        if (latestData?.codexConjureRunRequestId === contextRequestId) {
          update({
            codexConjureRunMode: 'single',
            codexConjureRunRequestId: '',
          });
        }
      }
    }
  }, 'codex-image-conjure', { lifecycleAware: true });

  const statusText = status?.available ? (status.version ? `Codex ${status.version}` : 'Codex 已就绪') : (status?.message || '正在检查 Codex CLI');
  const routeMissing = isRouteMissingMessage(statusText);
  const imageGenerationReady = status?.featureNames?.includes('image_generation') || status?.features?.some((feature) => feature.name === 'image_generation');
  const statusHint = routeMissing
    ? '当前后端没有加载 /api/codex-cli，请重启后端服务或桌面应用后再刷新。'
    : status?.available
      ? (imageGenerationReady ? '已登录，imagegen 生图能力可用。' : '已登录；若生成失败，请升级 Codex CLI 或确认 image_generation feature 已启用。')
      : '首次使用可直接在本节点打开 Codex CLI 登录，登录完成后点刷新。';
  const queuedCount = tasks.filter((task) => task.status === 'queued').length;
  const runningCount = tasks.filter((task) => task.status === 'running').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;

  const renderPanel = () => {
    if (panel === 'gallery') {
      return (
        <section className="space-y-2 p-3" style={cardStyle}>
          <div className="flex items-center gap-2 font-bold"><Library size={15} /> 公共图库</div>
          <div className="flex items-center gap-2 px-2 py-2" style={inputStyle}>
            <Search size={14} style={{ color: subText }} />
            <input
              className="nodrag min-w-0 flex-1 bg-transparent text-sm outline-none"
              value={String(d.codexConjureGalleryQuery || '')}
              onChange={(event) => update({ codexConjureGalleryQuery: event.currentTarget.value })}
              placeholder="搜索资源库图片"
            />
          </div>
          <div className="grid grid-cols-5 gap-2">
            {galleryItems.slice(0, 10).map((item) => {
              const url = item.thumbUrl || item.fileUrl;
              const active = galleryRefs.includes(item.fileUrl);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="nodrag group relative aspect-square overflow-hidden rounded-lg border"
                  style={{ borderColor: active ? accent : border, background: surface }}
                  onClick={() => toggleGalleryRef(item.fileUrl)}
                  title={active ? '移除参考' : '加入参考'}
                >
                  <img src={url} alt={item.title} className="h-full w-full object-cover" />
                  <span className="absolute inset-x-1 bottom-1 rounded px-1 py-0.5 text-[10px] font-bold" style={{ background: active ? accent : 'rgba(2,6,23,0.78)', color: active ? '#00111a' : '#fff' }}>
                    {active ? '移除参考' : '加入参考'}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="text-[11px]" style={{ color: subText }}>已选参考 {galleryRefs.length} 张，上游参考 {upstream.images.length} 张。</div>
        </section>
      );
    }

    if (panel === 'template') {
      return (
        <section className="space-y-2 p-3" style={cardStyle}>
          <div className="flex items-center justify-between gap-2">
            <div className="font-bold">模板工坊</div>
            <button type="button" className="nodrag px-2 py-1 text-xs font-bold" style={buttonStyle} onClick={() => loadTemplateDraft(null)}>新建</button>
          </div>
          <select className="nodrag w-full px-2 py-2 text-sm font-bold outline-none" style={inputStyle} value={selectedTemplate?.id || ''} onChange={(event) => loadTemplateDraft(promptState.templates.find((item) => item.id === event.currentTarget.value))}>
            {promptState.templates.map((template) => <option key={template.id} value={template.id}>{template.category} · {template.title}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input className="nodrag px-2 py-2 text-xs outline-none" style={inputStyle} value={templateDraft.title} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, title: event.currentTarget.value }))} placeholder="模板名称" />
            <input className="nodrag px-2 py-2 text-xs outline-none" style={inputStyle} value={templateDraft.category} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, category: event.currentTarget.value }))} placeholder="分类" />
            <input className="nodrag px-2 py-2 text-xs outline-none" style={inputStyle} value={templateDraft.shortTitle} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, shortTitle: event.currentTarget.value }))} placeholder="短标题" />
            <input className="nodrag px-2 py-2 text-xs outline-none" style={inputStyle} value={templateDraft.tags} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, tags: event.currentTarget.value }))} placeholder="标签，用逗号分隔" />
          </div>
          <textarea className="nodrag min-h-20 w-full resize-y px-2 py-2 text-xs outline-none" style={inputStyle} value={templateDraft.content} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, content: event.currentTarget.value }))} placeholder="模板提示词" />
          <textarea className="nodrag min-h-12 w-full resize-y px-2 py-2 text-xs outline-none" style={inputStyle} value={templateDraft.notes} onChange={(event) => setTemplateDraft((prev) => ({ ...prev, notes: event.currentTarget.value }))} placeholder="用途说明" />
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={saveTemplateDraft}><Save size={14} /> 保存/重命名</button>
            <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={removeTemplateDraft}><Trash2 size={14} /> 删除</button>
          </div>
        </section>
      );
    }

    if (panel === 'snippet') {
      return (
        <section className="space-y-2 p-3" style={cardStyle}>
          <div className="flex items-center justify-between gap-2">
            <div className="font-bold">片段工坊</div>
            <span className="text-[11px]" style={{ color: subText }}>输入 ~tag 快速展开</span>
          </div>
          <div className="flex items-center gap-2 px-2 py-2" style={inputStyle}>
            <Search size={14} style={{ color: subText }} />
            <input className="nodrag min-w-0 flex-1 bg-transparent text-sm outline-none" value={String(d.codexConjureSnippetQuery || '')} onChange={(event) => update({ codexConjureSnippetQuery: event.currentTarget.value })} placeholder="搜索片段，例如 cinematic / product" />
          </div>
          <div className="flex max-h-24 flex-wrap gap-1 overflow-auto pr-1">
            {filteredSnippets.map((snippet) => (
              <button key={snippet.tag} type="button" className="nodrag rounded-full px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => {
                setSnippetDraft({ id: snippet.id, tag: snippet.tag, title: snippet.title, category: snippet.category, content: snippet.content });
                insertSnippet(snippet.tag);
              }}>
                ~{snippet.tag}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className="nodrag px-2 py-2 text-xs outline-none" style={inputStyle} value={snippetDraft.tag} onChange={(event) => setSnippetDraft((prev) => ({ ...prev, tag: event.currentTarget.value }))} placeholder="tag，不用写 ~" />
            <input className="nodrag px-2 py-2 text-xs outline-none" style={inputStyle} value={snippetDraft.category} onChange={(event) => setSnippetDraft((prev) => ({ ...prev, category: event.currentTarget.value }))} placeholder="分类" />
            <input className="nodrag col-span-2 px-2 py-2 text-xs outline-none" style={inputStyle} value={snippetDraft.title} onChange={(event) => setSnippetDraft((prev) => ({ ...prev, title: event.currentTarget.value }))} placeholder="片段名称" />
          </div>
          <textarea className="nodrag min-h-16 w-full resize-y px-2 py-2 text-xs outline-none" style={inputStyle} value={snippetDraft.content} onChange={(event) => setSnippetDraft((prev) => ({ ...prev, content: event.currentTarget.value }))} placeholder="片段内容" />
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={saveSnippetDraft}><Save size={14} /> 保存/重命名</button>
            <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={() => removeSnippetDraft()}><Trash2 size={14} /> 删除</button>
          </div>
        </section>
      );
    }

    if (panel === 'settings') {
      return (
        <section className="space-y-2 p-3" style={cardStyle}>
          <div className="font-bold">工作台设置</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs font-bold" style={inputStyle}>
              <input type="checkbox" checked={autoPublish} onChange={(event) => update({ codexConjureAutoPublish: event.currentTarget.checked })} /> 自动发布
            </label>
            <label className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs font-bold" style={inputStyle}>
              <input type="checkbox" checked={persistPrompt} onChange={(event) => update({ codexConjurePersistPrompt: event.currentTarget.checked })} /> 提示词持久化
            </label>
            <label className="flex items-center gap-2 rounded-lg px-2 py-2 text-xs font-bold" style={inputStyle}>
              <input type="checkbox" checked={persistRefs} onChange={(event) => update({ codexConjurePersistRefs: event.currentTarget.checked })} /> 素材持久化
            </label>
            <select className="nodrag px-2 py-2 text-xs font-bold outline-none" style={inputStyle} value={String(d.codexConjurePromptMode || '原始模式')} onChange={(event) => update({ codexConjurePromptMode: event.currentTarget.value })}>
              {['原始模式', '保真模式', '创意模式'].map((item) => <option key={item}>{item}</option>)}
            </select>
          </div>
          <textarea className="nodrag min-h-16 w-full resize-y px-2 py-2 text-xs outline-none" style={inputStyle} value={String(d.codexConjureNegativePrompt || '')} onChange={(event) => update({ codexConjureNegativePrompt: event.currentTarget.value })} placeholder="Negative prompt，可选" />
          <input ref={importRef} type="file" accept="application/json" className="hidden" onChange={importPromptPack} />
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={() => importRef.current?.click()}><FileUp size={14} /> 导入</button>
            <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={exportPromptPack}><FileDown size={14} /> 导出</button>
          </div>
        </section>
      );
    }

    return (
      <section className="space-y-2 p-3" style={cardStyle}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-bold"><ListChecks size={15} /> 任务队列 / 历史</div>
          <span className="text-[11px]" style={{ color: subText }}>待 {queuedCount} · 运行 {runningCount} · 完成 {completedCount}</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <button type="button" className="nodrag px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={addToQueue}>加入队列</button>
          <button type="button" className="nodrag px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={requestQueueRun} disabled={busy}>开始队列</button>
          <button type="button" className="nodrag px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={clearFinishedTasks}>清空完成</button>
        </div>
        <div className="max-h-32 space-y-1 overflow-auto pr-1">
          {tasks.length === 0 && <div className="rounded-lg px-2 py-2 text-xs" style={{ ...inputStyle, color: subText }}>暂无队列任务，可直接生成或先加入队列。</div>}
          {tasks.slice(0, 8).map((task) => (
            <div key={task.id} className="rounded-lg px-2 py-1.5 text-xs" style={inputStyle}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold">#{task.queueIndex} {taskStatusLabel(task)}</span>
                <span style={{ color: subText }}>{task.resultImageUrls.length ? `${task.resultImageUrls.length} 图` : task.size}</span>
              </div>
              <div className="truncate" style={{ color: subText }}>{task.error || task.progressText || compactText(task.prompt)}</div>
            </div>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div data-codex-image-conjure-root className="relative p-4 text-sm" style={rootStyle}>
      <Handle type="target" id="text" position={Position.Left} style={{ top: 180, background: PORT_COLOR.text }} />
      <Handle type="target" id="image" position={Position.Left} style={{ top: 220, background: PORT_COLOR.image }} />
      <Handle type="source" id="image" position={Position.Right} style={{ top: 196, background: PORT_COLOR.image }} />
      <Handle type="source" id="text" position={Position.Right} style={{ top: 236, background: PORT_COLOR.text }} />

      <header data-codex-image-conjure-drag-surface="true" className="flex cursor-grab items-center gap-3 pb-3 active:cursor-grabbing">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: accent, color: isDark ? '#00111a' : '#fff' }}>
          <ImagePlus size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-black leading-tight">Codex 生图工作台</div>
          <div className="truncate text-xs" style={{ color: subText }}>Codex CLI · imagegen · 队列/模板/片段/公共图库</div>
        </div>
        <button type="button" className="nodrag inline-flex items-center gap-1 px-2 py-1 text-xs font-bold" style={buttonStyle} onClick={() => void refreshStatus()}>
          <RefreshCw size={13} /> 刷新
        </button>
      </header>

      <div
        data-codex-image-conjure-body
        className="nowheel space-y-3 overflow-y-auto pr-1"
        style={{ maxHeight: 760 }}
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <section className="p-3" style={cardStyle}>
          <div className="flex items-center justify-between gap-2">
            <div className="font-bold">{status?.available ? 'Codex 已就绪' : routeMissing ? '后端路由未加载' : '登录 Codex CLI'}</div>
            <span className="rounded-full px-2 py-0.5 text-[11px]" style={{ background: status?.available ? 'rgba(34,197,94,0.16)' : 'rgba(251,191,36,0.18)', color: status?.available ? '#22c55e' : '#f59e0b' }}>
              {status?.available ? '可生成' : '需登录'}
            </span>
          </div>
          <div className="mt-1 text-xs" style={{ color: subText }}>{statusText}</div>
          <div className="mt-1 text-[11px] leading-relaxed" style={{ color: subText }}>{statusHint}</div>
          <div className="mt-2 rounded-lg border px-2 py-1.5 text-[10px] leading-relaxed" style={{ borderColor: border, background: bg, color: subText }}>
            <div className="mb-1 font-black" style={{ color: text }}>登录流程</div>
            <ol className="m-0 list-decimal space-y-0.5 pl-4">
              {CODEX_LOGIN_FLOW_STEPS.map((step) => (
                <li key={step}>{step.replace(/^\d+\.\s*/, '')}</li>
              ))}
            </ol>
          </div>
          <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
            <input
              className="nodrag min-w-0 px-2 py-2 text-xs outline-none"
              style={inputStyle}
              value={String(d.codexExecutablePath || '')}
              onChange={(event) => update({ codexExecutablePath: event.currentTarget.value })}
              placeholder="Codex 可执行文件路径，留空使用 codex"
            />
            <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={() => void refreshStatus()}>
              <RefreshCw size={13} /> 刷新
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold"
              style={{ ...buttonStyle, background: status?.available ? surfaceStrong : accent, color: status?.available ? text : (isDark ? '#00111a' : '#fff'), borderColor: status?.available ? border : accent }}
              disabled={loginBusy}
              onClick={() => void openCodexLogin()}
            >
              {loginBusy ? <Loader2 size={14} className="animate-spin" /> : <TerminalSquare size={14} />}
              {status?.available ? '重新登录' : '打开登录'}
            </button>
            <button type="button" className="nodrag px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={() => copyCodexSetupCommand(codexLoginCommand, '登录命令')}>
              复制登录命令
            </button>
          </div>
          {!status?.available && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5" style={{ borderColor: border, background: bg }}>
              <code className="truncate text-[11px]">{codexInstallCommand}</code>
              <button type="button" className="nodrag rounded-md px-2 py-1 text-[11px] font-bold" style={buttonStyle} onClick={() => copyCodexSetupCommand(codexInstallCommand, '安装命令')}>
                复制安装
              </button>
            </div>
          )}
        </section>

        <section className="grid grid-cols-2 gap-2 p-3" style={cardStyle}>
          <label className="col-span-2 text-xs font-bold">提示词模板</label>
          <select
            className="nodrag col-span-2 px-2 py-2 text-sm font-bold outline-none"
            style={inputStyle}
            value={selectedTemplate?.id || ''}
            onChange={(event) => applyTemplate(event.currentTarget.value)}
          >
            {promptState.templates.length === 0 && <option value="">暂无系统模板</option>}
            {promptState.templates.map((template) => (
              <option key={template.id} value={template.id}>{template.category} · {template.shortTitle || template.title}</option>
            ))}
          </select>
          <select
            className="nodrag px-2 py-2 text-sm font-bold outline-none"
            style={inputStyle}
            value={String(d.codexConjureModel || 'gpt-5.5')}
            onChange={(event) => update({ codexConjureModel: event.currentTarget.value })}
          >
            {CODEX_CONJURE_MODELS.map((model) => <option key={model.value || 'default'} value={model.value}>{model.label}</option>)}
          </select>
          <select
            className="nodrag px-2 py-2 text-sm font-bold outline-none"
            style={inputStyle}
            value={String(d.codexConjureAspectRatio || '9:16')}
            onChange={(event) => update({ codexConjureAspectRatio: event.currentTarget.value })}
          >
            {['1:1', '4:5', '3:4', '9:16', '16:9', '3:2', '21:9'].map((ratio) => <option key={ratio}>{ratio}</option>)}
          </select>
          <label className="space-y-1 text-[11px] font-bold">
            <span>尺寸</span>
            <select className="nodrag w-full px-2 py-2 text-sm font-bold outline-none" style={inputStyle} value={String(d.codexConjureSize || '2K')} onChange={(event) => update({ codexConjureSize: event.currentTarget.value })}>
              {['1K', '2K', '4K'].map((size) => <option key={size}>{size}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-bold">
            <span>质量</span>
            <select className="nodrag w-full px-2 py-2 text-sm font-bold outline-none" style={inputStyle} value={String(d.codexConjureQuality || '高')} onChange={(event) => update({ codexConjureQuality: event.currentTarget.value })}>
              {['自动', '低', '中', '高'].map((quality) => <option key={quality}>{quality}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-[11px] font-bold">
            <span>数量</span>
            <input className="nodrag w-full px-2 py-2 text-sm outline-none" style={inputStyle} type="number" min={1} max={4} value={count} onChange={(event) => update({ codexConjureCount: clampNumber(event.currentTarget.value, 1, 4, 1) })} />
          </label>
          <label className="space-y-1 text-[11px] font-bold">
            <span>并发</span>
            <input className="nodrag w-full px-2 py-2 text-sm outline-none" style={inputStyle} type="number" min={1} max={4} value={concurrency} onChange={(event) => update({ codexConjureConcurrency: clampNumber(event.currentTarget.value, 1, 4, 1) })} />
          </label>
        </section>

        {(orderedInputImages.length > 0 || excludedUpstreamCount > 0) && (
          <section data-codex-image-conjure-input-materials="true">
            <MaterialPreviewSection
              texts={[]}
              images={orderedInputImages}
              videos={[]}
              audios={[]}
              order={materialOrder}
              onReorder={setMaterialOrder}
              onRemoveLocal={removeGalleryMaterial}
              onExcludeUpstream={excludeUpstreamMaterial}
              excludedCount={excludedUpstreamCount}
              onRestoreExcluded={restoreExcludedMaterials}
              selected={selected}
              isDark={isDark}
              isPixel={isPixel}
              title="输入参考图"
            />
          </section>
        )}

        <section className="p-2" style={{ ...cardStyle, borderColor: accent }}>
          <MentionPromptInput
            value={prompt}
            mentions={mentions}
            materials={mentionMaterials}
            onChange={(value, nextMentions) => update({ codexConjurePrompt: value, codexConjurePromptMentions: nextMentions })}
            onSubmit={() => requestCanvasNodeRun(id)}
            placeholder="描述要生成的图像；可用 @ 引用上游素材，也可写 ~cinematic 片段..."
            title="输入提示词 / 对话"
            promptTemplateKind="image"
            isDark={isDark}
            isPixel={isPixel}
            expandable
            className="rounded-lg px-2 py-2 text-sm outline-none"
            style={{ color: text, background: isDark ? 'rgba(2,6,23,0.76)' : '#ffffff', minHeight: 180, height: 180 }}
          />
          <div className="mt-2 text-[11px]" style={{ color: subText }}>
            参考图 {unique(orderedInputImages.map((item) => item.url)).length} 张 · 文本 {orderedInputTexts.length} 段 · Skill imagegen
          </div>
        </section>

        <nav className="grid grid-cols-5 gap-1">
          {PANEL_TABS.map((tab) => (
            <button key={tab.key} type="button" className="nodrag px-2 py-2 text-[11px] font-bold" style={{ ...buttonStyle, background: panel === tab.key ? accent : surfaceStrong, color: panel === tab.key && !isDark ? '#fff' : text }} onClick={() => setPanel(tab.key)}>
              {tab.label}
            </button>
          ))}
        </nav>

        {renderPanel()}

        <section className="p-3" style={cardStyle}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="font-bold">完成反馈</div>
            {busy && <Loader2 size={15} className="animate-spin" />}
          </div>
          <div className="min-h-10 text-xs leading-relaxed" style={{ color: subText }}>
            {d.error || d.codexConjureLastRunSummary || '生成后会直接发布到输出素材，不在节点内显示大预览图。'}
            {streamText && <div className="mt-1 line-clamp-3">{streamText}</div>}
          </div>
          {latestUrls.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={() => void addLatestToLibrary()}>
                <PackagePlus size={14} /> 入库
              </button>
              <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold" style={buttonStyle} onClick={createVariant}>
                <Archive size={14} /> 变体
              </button>
              <a className="nodrag inline-flex items-center justify-center gap-1 px-2 py-2 text-xs font-bold no-underline" style={buttonStyle} href={latestUrls[0]} download>
                <Download size={14} /> 下载
              </a>
            </div>
          )}
        </section>
      </div>

      <footer className="mt-3 flex items-center gap-2">
        {!busy ? (
          <button type="button" className="nodrag flex flex-1 items-center justify-center gap-2 px-4 py-3 text-base font-black" style={{ ...buttonStyle, background: `linear-gradient(180deg, ${surfaceStrong}, ${accent})`, color: isDark ? '#ecfeff' : '#ffffff' }} onClick={() => requestCanvasNodeRun(id)}>
            <Play size={18} /> 开始生成
          </button>
        ) : (
          <button type="button" className="nodrag flex flex-1 items-center justify-center gap-2 px-4 py-3 text-base font-black" style={buttonStyle} onClick={handleStop}>
            <Square size={17} /> 停止
          </button>
        )}
        <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-3 py-3 text-xs font-bold" style={buttonStyle} onClick={requestQueueRun} disabled={busy}>
          <ListChecks size={15} /> 队列
        </button>
        <button type="button" className="nodrag inline-flex items-center justify-center gap-1 px-3 py-3 text-xs font-bold" style={buttonStyle} onClick={() => navigator.clipboard?.writeText(prompt)}>
          <Copy size={15} /> 复制
        </button>
      </footer>

      <Sparkles className="pointer-events-none absolute right-4 top-16 opacity-20" size={30} style={{ color: accent }} />
    </div>
  );
};

export default memo(CodexImageConjureNode);
