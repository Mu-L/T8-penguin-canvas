import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  AtSign,
  Library,
  Maximize2,
  Music,
  SlidersHorizontal,
  Video as VideoIcon,
} from 'lucide-react';
import SmartImage from '../SmartImage';
import PromptExpandModal from '../PromptExpandModal';
import PromptTemplateLibraryModal from '../PromptTemplateLibraryModal';
import ImagePromptAdjustmentButton from '../ImagePromptAdjustmentButton';
import { useShortcutStore } from '../../stores/shortcuts';
import { formatShortcutList, matchesAnyShortcut } from '../../utils/keyboardShortcuts';
import {
  createCompositionLeakSnapshot,
  createPlainInputRunSnapshot,
  isImeCompositionInput,
  isImeKeyboardEvent,
  stripCompositionLeak,
  type CompositionLeakSnapshot,
  type PlainInputRunSnapshot,
} from '../../utils/imeComposition';
import type { PromptTemplateKind } from '../../data/promptTemplateLibrary';
import {
  normalizeImagePromptAdjustmentSelections,
  type ImagePromptAdjustmentSelection,
} from '../../data/imagePromptAdjustments';
import type { Material } from './useUpstreamMaterials';
import {
  getUnresolvedMentionCount,
  findMediaMentionQuery,
  insertMediaMention,
  isMentionableMaterial,
  materialMentionKey,
  resolveMediaMentions,
  tokenForMaterial,
  type MediaMention,
} from './mediaMentions';

interface Props {
  value: string;
  mentions?: MediaMention[];
  materials: Material[];
  onChange: (value: string, mentions: MediaMention[]) => void;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  isDark: boolean;
  isPixel: boolean;
  editorRef?: Ref<HTMLDivElement>;
  title?: string;
  expandable?: boolean;
  promptTemplateKind?: PromptTemplateKind | false;
  imagePromptAdjustments?: unknown;
  onImagePromptAdjustmentsChange?: (next: ImagePromptAdjustmentSelection[]) => void;
  imagePromptAdjustmentHasReferenceImages?: boolean;
  onSubmit?: (value: string, mentions: MediaMention[]) => void;
  /** Optional one-slot action rendered immediately before template/expand controls. */
  toolbarAction?: ReactNode;
  /** Force the editor to fill a flex parent instead of growing with long text. */
  fillHeight?: boolean;
}

interface QueryState {
  open: boolean;
  start: number;
  end: number;
  query: string;
  activeIndex: number;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  (ref as MutableRefObject<T | null>).current = value;
}

function fileName(url: string): string {
  try {
    return decodeURIComponent((url.split('?')[0].split('/').pop() || url).slice(0, 42));
  } catch {
    return (url.split('?')[0].split('/').pop() || url).slice(0, 42);
  }
}

function displayKind(kind: Material['kind']): string {
  if (kind === 'image') return '图像';
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  return '文本';
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getCaretPlainOffset(root: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return 0;

  const nodePlainLength = (node: Node): number => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length || 0;
    if (node instanceof HTMLElement && node.dataset.mentionToken) return node.dataset.mentionToken.length;
    if (node instanceof HTMLElement && node.tagName === 'BR') return 1;
    let len = 0;
    node.childNodes.forEach((child) => {
      len += nodePlainLength(child);
    });
    return len;
  };

  let offset = 0;
  let found = false;
  const walk = (node: Node) => {
    if (found) return;
    if (node === range.startContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += range.startOffset;
      } else {
        for (let i = 0; i < range.startOffset; i += 1) {
          const child = node.childNodes[i];
          if (child) offset += nodePlainLength(child);
        }
      }
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length || 0;
      return;
    }
    if (node instanceof HTMLElement && node.dataset.mentionToken) {
      offset += node.dataset.mentionToken.length;
      return;
    }
    if (node instanceof HTMLElement && node.tagName === 'BR') {
      offset += 1;
      return;
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return offset;
}

function setCaretPlainOffset(root: HTMLElement, targetOffset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  let offset = 0;
  let targetNode: Node | null = null;
  let targetNodeOffset = 0;

  const walk = (node: Node) => {
    if (targetNode) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length || 0;
      if (offset + len >= targetOffset) {
        targetNode = node;
        targetNodeOffset = Math.max(0, Math.min(len, targetOffset - offset));
        return;
      }
      offset += len;
      return;
    }
    if (node instanceof HTMLElement && node.dataset.mentionToken) {
      const len = node.dataset.mentionToken.length;
      if (offset + len >= targetOffset) {
        targetNode = node.parentNode || root;
        targetNodeOffset = Array.prototype.indexOf.call((targetNode as Node).childNodes, node) + 1;
        return;
      }
      offset += len;
      return;
    }
    if (node instanceof HTMLElement && node.tagName === 'BR') {
      const len = 1;
      if (offset + len >= targetOffset) {
        targetNode = node.parentNode || root;
        targetNodeOffset = Array.prototype.indexOf.call((targetNode as Node).childNodes, node) + 1;
        return;
      }
      offset += len;
      return;
    }
    node.childNodes.forEach(walk);
  };

  root.childNodes.forEach(walk);
  if (!targetNode) {
    targetNode = root;
    targetNodeOffset = root.childNodes.length;
  }
  const range = document.createRange();
  range.setStart(targetNode, targetNodeOffset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function readRichEditor(root: HTMLElement, fallbackMentions: MediaMention[]): { text: string; mentions: MediaMention[] } {
  let text = '';
  const mentions: MediaMention[] = [];
  const byId = new Map(fallbackMentions.map((mention) => [mention.id, mention]));
  const normalizeText = (raw: string) => raw.replace(/\u00a0/g, ' ');

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += normalizeText(node.textContent || '');
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset.mentionToken) {
      const token = node.dataset.mentionToken;
      const id = node.dataset.mentionId || '';
      const start = text.length;
      text += token;
      const prev = byId.get(id);
      if (prev) {
        mentions.push({ ...prev, token, start, end: text.length });
      }
      return;
    }
    if (node.tagName === 'BR') {
      text += '\n';
      return;
    }
    node.childNodes.forEach(walk);
  };

  root.childNodes.forEach(walk);
  return { text, mentions };
}

const MentionPromptInput = ({
  value,
  mentions = [],
  materials,
  onChange,
  placeholder,
  className,
  style,
  isDark,
  isPixel,
  editorRef,
  title = '提示词编辑',
  expandable = true,
  promptTemplateKind = false,
  imagePromptAdjustments,
  onImagePromptAdjustmentsChange,
  imagePromptAdjustmentHasReferenceImages = false,
  onSubmit,
  toolbarAction,
  fillHeight = false,
}: Props) => {
  const localRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const lastPlainInputRef = useRef<PlainInputRunSnapshot | null>(null);
  const compositionLeakRef = useRef<CompositionLeakSnapshot | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const expandShortcuts = useShortcutStore((s) => s.shortcuts['editor.expand-prompt']);
  const [isFocused, setIsFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [draftValue, setDraftValue] = useState(value || '');
  const [draftMentions, setDraftMentions] = useState<MediaMention[]>(mentions || []);
  const [queryState, setQueryState] = useState<QueryState>({
    open: false,
    start: 0,
    end: 0,
    query: '',
    activeIndex: 0,
  });
  const [popupRect, setPopupRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const templateEnabled = expandable && promptTemplateKind !== false;
  const adjustmentEnabled = typeof onImagePromptAdjustmentsChange === 'function';
  const effectiveTemplateKind = promptTemplateKind || 'image';
  const normalizedAdjustments = useMemo(
    () => normalizeImagePromptAdjustmentSelections(imagePromptAdjustments),
    [imagePromptAdjustments],
  );
  const inactiveReferenceAdjustmentCount = imagePromptAdjustmentHasReferenceImages
    ? 0
    : normalizedAdjustments.filter((selection) => selection.applicability === 'reference').length;
  const editorActionCount = (expandable ? 1 : 0)
    + (templateEnabled ? 1 : 0)
    + (adjustmentEnabled ? 1 : 0)
    + (toolbarAction ? 1 : 0);

  const mentionableMaterials = useMemo(
    () => materials.filter(isMentionableMaterial),
    [materials],
  );

  const filteredMaterials = useMemo(() => {
    const q = queryState.query.trim().toLowerCase();
    if (!q) return mentionableMaterials;
    return mentionableMaterials.filter((material) => {
      const token = tokenForMaterial(material, mentionableMaterials).toLowerCase();
      const label = `${material.label || ''} ${fileName(material.url)} ${displayKind(material.kind)}`.toLowerCase();
      return token.includes(q) || label.includes(q);
    });
  }, [mentionableMaterials, queryState.query]);

  const mentionMaterialMap = useMemo(() => {
    const map = new Map<string, Material>();
    for (const material of mentionableMaterials) {
      map.set(materialMentionKey(material), material);
    }
    return map;
  }, [mentionableMaterials]);

  const inlineMentions = useMemo(
    () =>
      mentions
        .filter((mention) => value.slice(mention.start, mention.end) === mention.token)
        .map((mention) => {
          const material = mentionMaterialMap.get(mention.materialKey);
          return material ? { mention, material, token: tokenForMaterial(material, mentionableMaterials) } : null;
        })
        .filter((item): item is { mention: MediaMention; material: Material; token: string } => !!item),
    [mentions, value, mentionMaterialMap, mentionableMaterials],
  );

  const resolvedPreview = useMemo(
    () => resolveMediaMentions(value, mentions, mentionableMaterials),
    [value, mentions, mentionableMaterials],
  );
  const unresolvedCount = useMemo(
    () => getUnresolvedMentionCount(mentions, mentionableMaterials),
    [mentions, mentionableMaterials],
  );

  const setEditorRef = (el: HTMLDivElement | null) => {
    localRef.current = el;
    assignRef(editorRef, el);
  };

  const openExpanded = () => {
    setDraftValue(value || '');
    setDraftMentions(mentions || []);
    setQueryState((s) => ({ ...s, open: false }));
    setExpanded(true);
  };

  const closeExpanded = () => {
    setExpanded(false);
    window.setTimeout(() => localRef.current?.focus(), 0);
  };

  const applyExpanded = () => {
    onChange(draftValue, draftMentions);
    closeExpanded();
  };

  const editorHtml = useMemo(() => {
    const validMentions = inlineMentions.map((item) => item.mention).sort((a, b) => a.start - b.start);
    let html = '';
    let pos = 0;
    for (const mention of validMentions) {
      if (mention.start > pos) html += escapeText(value.slice(pos, mention.start));
      html += `<span data-mention-id="${escapeText(mention.id)}" data-mention-token="${escapeText(mention.token)}" contenteditable="false"></span>`;
      pos = mention.end;
    }
    html += escapeText(value.slice(pos));
    return html.replace(/\n/g, '<br>');
  }, [value, inlineMentions]);

  const syncPopupRect = () => {
    const el = localRef.current;
    if (!el || typeof window === 'undefined') return;
    const rect = el.getBoundingClientRect();
    const selection = window.getSelection();
    let anchorRect: DOMRect | null = null;
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (el.contains(range.startContainer)) {
        const caretRange = range.cloneRange();
        caretRange.collapse(true);
        const caretRect = caretRange.getBoundingClientRect();
        if (caretRect.width || caretRect.height) anchorRect = caretRect;
      }
    }
    const targetRect = anchorRect || rect;
    const width = Math.min(Math.max(rect.width, 220), 360);
    const left = Math.min(Math.max(8, targetRect.left), Math.max(8, window.innerWidth - width - 8));
    const below = targetRect.bottom + 8;
    const top = below > window.innerHeight - 220 ? Math.max(8, targetRect.top - 228) : below;
    setPopupRect({ left, top, width });
  };

  useLayoutEffect(() => {
    if (!queryState.open) return;
    syncPopupRect();
  }, [queryState.open, queryState.query, value]);

  useLayoutEffect(() => {
    const el = localRef.current;
    if (!el) return;
    if (composingRef.current) return;
    const keepCaret = document.activeElement === el ? getCaretPlainOffset(el) : null;
    if (el.innerHTML !== editorHtml) el.innerHTML = editorHtml;
    for (const item of inlineMentions) {
      const span = Array.from(el.querySelectorAll<HTMLElement>('[data-mention-id]'))
        .find((candidate) => candidate.dataset.mentionId === item.mention.id);
      if (!span) continue;
      span.title = item.token;
      span.style.cssText = [
        'display:inline-block',
        'position:relative',
        'box-sizing:border-box',
        'width:24px',
        'height:24px',
        'min-width:24px',
        'vertical-align:middle',
        'margin:0 4px',
        'overflow:hidden',
        'line-height:24px',
        'font-size:14px',
        `border-radius:${isPixel ? '6px' : '5px'}`,
        `border:${isPixel ? '1.5px solid var(--px-ink, #1a1410)' : '1px solid rgba(255,255,255,.22)'}`,
        `background:${item.material.kind === 'audio' ? 'rgba(250,204,21,.18)' : 'rgba(15,23,42,.18)'}`,
        `box-shadow:${isPixel ? '1px 1px 0 var(--px-ink, #1a1410)' : '0 2px 8px rgba(0,0,0,.16)'}`,
      ].join(';');
      const content = document.createElement('span');
      content.style.cssText = [
        'position:absolute',
        'inset:0',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'overflow:hidden',
        'line-height:1',
      ].join(';');
      if (item.material.kind === 'image') {
        const img = document.createElement('img');
        img.src = item.material.url;
        img.alt = '';
        img.draggable = false;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
        content.appendChild(img);
      } else {
        content.textContent = item.material.kind === 'video' ? '▶' : item.material.kind === 'audio' ? '♪' : 'T';
        content.style.fontWeight = '900';
      }
      span.replaceChildren(content);
    }
    if (document.activeElement === el) {
      const caret = pendingCaretRef.current ?? keepCaret;
      pendingCaretRef.current = null;
      if (caret !== null) setCaretPlainOffset(el, caret);
    }
  }, [editorHtml, inlineMentions, isDark, isPixel]);

  const openFromCaret = (text: string, caret: number, mentionList: MediaMention[] = mentions) => {
    const query = findMediaMentionQuery(text, caret, mentionList);
    if (!query) {
      setQueryState((s) => ({ ...s, open: false }));
      return;
    }
    setQueryState({ ...query, open: true, activeIndex: 0 });
  };

  const openFromEditor = () => {
    const el = localRef.current;
    if (!el || composingRef.current) return;
    const caret = getCaretPlainOffset(el);
    const { text, mentions: nextMentions } = readRichEditor(el, mentions);
    openFromCaret(text, caret, nextMentions);
  };

  const handleEditorInput = (event?: FormEvent<HTMLDivElement>) => {
    const el = localRef.current;
    if (!el) return;
    const nativeEvent = event?.nativeEvent;
    const inputEvent = nativeEvent as (InputEvent & { data?: string; inputType?: string }) | undefined;
    if (isImeCompositionInput(nativeEvent) || composingRef.current) {
      if (
        inputEvent?.inputType === 'insertText' &&
        /^[A-Za-z]$/.test(String(inputEvent.data || ''))
      ) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const caret = getCaretPlainOffset(el);
        const { text: composingText } = readRichEditor(el, mentions);
        lastPlainInputRef.current = createPlainInputRunSnapshot({
          text: composingText,
          caret,
          data: String(inputEvent.data),
          now,
        });
        compositionLeakRef.current = createCompositionLeakSnapshot(lastPlainInputRef.current, now) || compositionLeakRef.current;
      }
      composingRef.current = true;
      return;
    }
    const caret = getCaretPlainOffset(el);
    const { text: nextValue, mentions: nextMentions } = readRichEditor(el, mentions);
    if (
      inputEvent?.inputType === 'insertText' &&
      /^[A-Za-z]$/.test(String(inputEvent.data || '')) &&
      caret > 0
    ) {
      lastPlainInputRef.current = createPlainInputRunSnapshot({
        text: nextValue,
        caret,
        data: String(inputEvent.data),
        now: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      });
    } else {
      lastPlainInputRef.current = null;
    }
    onChange(nextValue, nextMentions);
    if (composingRef.current) return;
    openFromCaret(nextValue, caret, nextMentions);
  };

  const flushEditorToData = () => {
    const el = localRef.current;
    if (!el) return null;
    const caret = getCaretPlainOffset(el);
    const { text, mentions: nextMentions } = readRichEditor(el, mentions);
    onChange(text, nextMentions);
    return { text, mentions: nextMentions, caret };
  };

  const selectMaterial = (material: Material) => {
    if (!localRef.current) return;
    const current = readRichEditor(localRef.current, mentions);
    const result = insertMediaMention(
      current.text,
      current.mentions,
      material,
      mentionableMaterials,
      queryState.start,
      queryState.end,
    );
    onChange(result.text, result.mentions);
    pendingCaretRef.current = result.caret;
    setQueryState((s) => ({ ...s, open: false }));
    window.setTimeout(() => {
      const el = localRef.current;
      if (!el) return;
      el.focus();
      setCaretPlainOffset(el, result.caret);
    }, 0);
  };

  const activeMaterial = filteredMaterials[Math.min(queryState.activeIndex, Math.max(0, filteredMaterials.length - 1))];
  const fillLayout = fillHeight || !expandable;

  const popup =
    queryState.open && popupRect && typeof document !== 'undefined'
      ? createPortal(
          <div
            data-canvas-floating-ui
            className="nodrag nowheel"
            style={{
              position: 'fixed',
              left: popupRect.left,
              top: popupRect.top,
              width: popupRect.width,
              zIndex: expandable ? 10050 : 10120,
              border: isPixel ? '2px solid var(--px-ink, #1a1410)' : '1px solid rgba(255,255,255,.18)',
              borderRadius: isPixel ? 14 : 10,
              background: isPixel
                ? 'var(--px-surface, #fff7df)'
                : isDark
                  ? 'rgba(16,18,24,.98)'
                  : 'rgba(255,255,255,.98)',
              color: isPixel ? 'var(--px-ink, #1a1410)' : isDark ? '#f8fafc' : '#111827',
              boxShadow: isPixel
                ? '4px 4px 0 var(--px-ink, #1a1410)'
                : '0 18px 48px rgba(0,0,0,.32)',
              padding: 6,
            }}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 7px 7px',
                fontSize: 10,
                opacity: 0.72,
                fontWeight: 700,
              }}
            >
              <AtSign size={12} />
              可引用的当前素材
            </div>
            {filteredMaterials.length === 0 ? (
              <div style={{ padding: '10px 8px', fontSize: 11, opacity: 0.65 }}>暂无匹配素材</div>
            ) : (
              <div style={{ maxHeight: 210, overflowY: 'auto', display: 'grid', gap: 4 }}>
                {filteredMaterials.map((material, index) => {
                  const token = tokenForMaterial(material, mentionableMaterials);
                  const active = activeMaterial?.id === material.id;
                  return (
                    <button
                      key={`${material.id}:${index}`}
                      type="button"
                      className="nodrag"
                      onClick={() => selectMaterial(material)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '38px 1fr auto',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        minHeight: 44,
                        padding: 5,
                        borderRadius: isPixel ? 10 : 8,
                        border: active
                          ? (isPixel ? '2px solid var(--px-ink, #1a1410)' : '1px solid rgba(94,234,212,.65)')
                          : '1px solid transparent',
                        background: active
                          ? (isPixel ? 'var(--px-yellow, #ffe08a)' : 'rgba(20,184,166,.16)')
                          : 'transparent',
                        color: 'inherit',
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: isPixel ? 8 : 7,
                          border: isPixel ? '1.5px solid var(--px-ink, #1a1410)' : '1px solid rgba(255,255,255,.16)',
                          overflow: 'hidden',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: material.kind === 'audio' ? 'rgba(250,204,21,.18)' : 'rgba(15,23,42,.18)',
                        }}
                      >
                        {material.kind === 'image' ? (
                          <SmartImage src={material.url} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} thumbSize={160} />
                        ) : material.kind === 'video' ? (
                          <VideoIcon size={18} />
                        ) : material.kind === 'audio' ? (
                          <Music size={18} />
                        ) : (
                          <span style={{ fontSize: 13, fontWeight: 900 }}>T</span>
                        )}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 11, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {material.label || fileName(material.url)}
                        </span>
                        <span style={{ display: 'block', fontSize: 10, opacity: 0.62 }}>
                          {displayKind(material.kind)}
                        </span>
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 900, opacity: 0.82 }}>{token}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      className={`nodrag nowheel ${
        fillHeight ? 'flex min-h-0 flex-1 flex-col' : expandable ? '' : 'flex h-full min-h-0 flex-col'
      }`}
    >
      <div className={fillLayout ? 'relative flex min-h-0 flex-1 flex-col' : 'relative'}>
        <div
          ref={setEditorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          tabIndex={0}
          data-placeholder={placeholder || ''}
          onInput={handleEditorInput}
          onBeforeInput={(event) => {
            if (isImeCompositionInput(event.nativeEvent)) composingRef.current = true;
          }}
          onCompositionStart={() => {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            compositionLeakRef.current = createCompositionLeakSnapshot(lastPlainInputRef.current, now);
            composingRef.current = true;
            setQueryState((s) => ({ ...s, open: false }));
          }}
          onCompositionEnd={() => {
            const el = localRef.current;
            window.setTimeout(() => {
              if (!el) return;
              if (composingRef.current) {
                // Some Chromium IME paths leave the component in a composing state after focus moves away.
                composingRef.current = false;
              }
              const flushed = flushEditorToData();
              if (!flushed) return;
              const fixed = stripCompositionLeak(flushed.text, flushed.mentions, compositionLeakRef.current);
              compositionLeakRef.current = null;
              lastPlainInputRef.current = null;
              const text = fixed.changed ? fixed.text : flushed.text;
              const nextMentions = fixed.changed ? fixed.mentions : flushed.mentions;
              const caret = Math.max(0, flushed.caret + fixed.caretDelta);
              if (fixed.changed) onChange(text, nextMentions);
              pendingCaretRef.current = caret;
              openFromCaret(text, caret, nextMentions);
            }, 16);
          }}
          onFocus={() => {
            setIsFocused(true);
          }}
          onClick={() => {
            openFromEditor();
          }}
          onKeyUp={(e) => {
            const el = localRef.current;
            if (!el) return;
            if (composingRef.current || isImeKeyboardEvent(e.nativeEvent)) return;
            if (['Escape', 'Enter', 'Tab', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
            const { text, mentions: nextMentions } = readRichEditor(el, mentions);
            openFromCaret(text, getCaretPlainOffset(el), nextMentions);
          }}
          onKeyDown={(e) => {
            if (isImeKeyboardEvent(e.nativeEvent)) {
              composingRef.current = true;
              setQueryState((s) => ({ ...s, open: false }));
              return;
            }
            if (composingRef.current) return;
            if (expandable && matchesAnyShortcut(expandShortcuts, e.nativeEvent)) {
              e.preventDefault();
              e.stopPropagation();
              openExpanded();
              return;
            }
            if (
              onSubmit &&
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              !queryState.open
            ) {
              e.preventDefault();
              e.stopPropagation();
              const flushed = flushEditorToData();
              onSubmit(flushed?.text ?? value, flushed?.mentions ?? mentions);
              return;
            }
            if (e.key === '@' || e.key === '＠') {
              window.setTimeout(openFromEditor, 0);
            }
            if (!queryState.open) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              setQueryState((s) => ({ ...s, open: false }));
              return;
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setQueryState((s) => ({ ...s, activeIndex: Math.min(filteredMaterials.length - 1, s.activeIndex + 1) }));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setQueryState((s) => ({ ...s, activeIndex: Math.max(0, s.activeIndex - 1) }));
              return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && activeMaterial) {
              e.preventDefault();
              selectMaterial(activeMaterial);
            }
          }}
          onBlur={() => {
            composingRef.current = false;
            flushEditorToData();
            setIsFocused(false);
            window.setTimeout(() => setQueryState((s) => ({ ...s, open: false })), 120);
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
          }}
          className={className}
          style={{
            ...style,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowY: 'auto',
            height: fillLayout ? '100%' : style?.height,
            minHeight: fillLayout ? 0 : (style?.minHeight ?? 56),
            lineHeight: 1.45,
            caretColor: 'currentColor',
            cursor: 'text',
            paddingRight: editorActionCount > 0
              ? Math.max(Number(style?.paddingRight) || 0, 6 + editorActionCount * 28)
              : style?.paddingRight,
            paddingLeft: style?.paddingLeft ?? 10,
          }}
        />
        {!value && !isFocused && placeholder && (
          <div
            className="pointer-events-none absolute left-2 top-1 text-[11px]"
            style={{
              left: style?.paddingLeft ?? 10,
              color: isPixel
                ? 'var(--px-ink-soft, rgba(26,20,16,.62))'
                : isDark
                  ? 'rgba(255,255,255,.30)'
                  : 'rgba(15,23,42,.38)',
            }}
          >
            {placeholder}
          </div>
        )}
        {(expandable || adjustmentEnabled || toolbarAction) && (
          <>
          {toolbarAction && (
            <div
              data-prompt-toolbar-action
              className="nodrag nopan absolute top-1.5 z-10"
              style={{
                right: 6 + (expandable ? 28 : 0) + (templateEnabled ? 28 : 0),
              }}
            >
              {toolbarAction}
            </div>
          )}
          {adjustmentEnabled && onImagePromptAdjustmentsChange && (
            <div
              className="nodrag nopan absolute top-1.5 z-10"
              style={{
                right: 6 + (expandable ? 28 : 0) + (templateEnabled ? 28 : 0) + (toolbarAction ? 28 : 0),
              }}
            >
              <ImagePromptAdjustmentButton
                selections={normalizedAdjustments}
                onChange={onImagePromptAdjustmentsChange}
                isDark={isDark}
                isPixel={isPixel}
                hasReferenceImages={imagePromptAdjustmentHasReferenceImages}
              />
            </div>
          )}
          {templateEnabled && (
            <button
              type="button"
              data-prompt-template-trigger
              className="nodrag nopan absolute right-[34px] top-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-black/45 text-white/70 shadow-sm hover:text-white"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setTemplateOpen(true);
              }}
              title="提示词模板库"
              aria-label="提示词模板库"
            >
              <Library size={12} />
            </button>
          )}
          <button
            style={{ display: expandable ? undefined : 'none' }}
            type="button"
            data-prompt-expand-trigger
            className="nodrag nopan absolute right-1.5 top-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-black/45 text-white/70 shadow-sm hover:text-white"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openExpanded();
            }}
            title={`放大编辑 (${formatShortcutList(expandShortcuts)})`}
            aria-label="放大编辑"
          >
            <Maximize2 size={12} />
          </button>
          </>
        )}
      </div>
      {adjustmentEnabled && normalizedAdjustments.length > 0 && (
        <div
          data-image-prompt-adjustment-summary
          className="mt-1 flex min-w-0 items-center gap-1 rounded px-2 py-1 text-[9px]"
          style={{
            border: isPixel ? '1.5px solid var(--px-ink, #1a1410)' : '1px solid rgba(163,230,53,.22)',
            background: isPixel
              ? 'var(--px-muted, rgba(255,255,255,.52))'
              : isDark
                ? 'rgba(163,230,53,.07)'
                : 'rgba(77,124,15,.07)',
            color: isPixel ? 'var(--px-ink, #1a1410)' : isDark ? 'rgba(217,249,157,.86)' : '#365314',
          }}
          title={normalizedAdjustments.map((selection) => `${selection.labelZh}：${selection.promptZh}`).join('\n')}
        >
          <SlidersHorizontal size={10} className="shrink-0" />
          <span className="shrink-0 font-semibold">调节后缀</span>
          <span className="min-w-0 flex-1 truncate">
            {normalizedAdjustments.slice(0, 3).map((selection) => selection.labelZh).join(' · ')}
            {normalizedAdjustments.length > 3 ? ` · +${normalizedAdjustments.length - 3}` : ''}
          </span>
          <span className="shrink-0 opacity-55">
            {inactiveReferenceAdjustmentCount > 0
              ? `${inactiveReferenceAdjustmentCount} 项待参考图`
              : '运行时生效'}
          </span>
        </div>
      )}
      {mentions.length > 0 && (
        <div
          className="mt-1 rounded px-2 py-1 text-[10px]"
          style={{
            border: isPixel ? '1.5px solid var(--px-ink, #1a1410)' : '1px solid rgba(255,255,255,.12)',
            background: isPixel
              ? 'var(--px-muted, rgba(255,255,255,.52))'
              : isDark
                ? 'rgba(255,255,255,.06)'
                : 'rgba(15,23,42,.06)',
            color: isPixel ? 'var(--px-ink, #1a1410)' : isDark ? 'rgba(255,255,255,.78)' : 'rgba(15,23,42,.76)',
          }}
        >
          <span style={{ fontWeight: 800 }}>实际发送: </span>
          <span className="break-all">{resolvedPreview.length > 120 ? `${resolvedPreview.slice(0, 120)}...` : resolvedPreview}</span>
        </div>
      )}
      {unresolvedCount > 0 && (
        <div className="mt-1 flex items-center gap-1 rounded border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-200">
          <AlertTriangle size={11} />
          有 {unresolvedCount} 个 @ 素材已断开，生成时会按普通文本保留
        </div>
      )}
      {popup}
      <PromptExpandModal
        open={expanded}
        title={title}
        value={draftValue}
        onValueChange={setDraftValue}
        onApply={applyExpanded}
        onCancel={closeExpanded}
        placeholder={placeholder}
        isDark={isDark}
        isPixel={isPixel}
      >
        <MentionPromptInput
          value={draftValue}
          mentions={draftMentions}
          materials={materials}
          onChange={(nextValue, nextMentions) => {
            setDraftValue(nextValue);
            setDraftMentions(nextMentions);
          }}
          placeholder={placeholder}
          isDark={isDark}
          isPixel={isPixel}
          title={title}
          expandable={false}
          promptTemplateKind={promptTemplateKind}
          imagePromptAdjustments={normalizedAdjustments}
          onImagePromptAdjustmentsChange={onImagePromptAdjustmentsChange}
          imagePromptAdjustmentHasReferenceImages={imagePromptAdjustmentHasReferenceImages}
          className="h-full w-full rounded border px-3 py-2 text-sm leading-relaxed outline-none"
          style={{
            background: isPixel
              ? 'var(--px-surface, #fff7df)'
              : isDark
                ? 'rgba(255,255,255,.055)'
                : 'rgba(15,23,42,.035)',
            color: isPixel ? 'var(--px-ink, #1a1410)' : isDark ? '#f8fafc' : '#111827',
            border: isPixel
              ? '2px solid var(--px-ink, #1a1410)'
              : isDark
                ? '1px solid rgba(255,255,255,.14)'
                : '1px solid rgba(15,23,42,.14)',
          }}
        />
      </PromptExpandModal>
      <PromptTemplateLibraryModal
        open={templateOpen}
        initialKind={effectiveTemplateKind}
        value={value || ''}
        onApply={(nextValue) => {
          const keepMentions = nextValue.startsWith(value || '');
          onChange(nextValue, keepMentions ? mentions : []);
        }}
        onClose={() => {
          setTemplateOpen(false);
          window.setTimeout(() => localRef.current?.focus(), 0);
        }}
        isDark={isDark}
        isPixel={isPixel}
      />
    </div>
  );
};

export default memo(MentionPromptInput);
