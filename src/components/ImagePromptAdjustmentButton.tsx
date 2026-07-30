import {
  Check,
  ChevronLeft,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  IMAGE_PROMPT_ADJUSTMENT_CATEGORIES,
  IMAGE_PROMPT_ADJUSTMENTS,
  normalizeImagePromptAdjustmentSelections,
  toggleImagePromptAdjustmentSelection,
  type ImagePromptAdjustmentItem,
  type ImagePromptAdjustmentSelection,
} from '../data/imagePromptAdjustments';

interface Props {
  selections: unknown;
  onChange: (next: ImagePromptAdjustmentSelection[]) => void;
  isDark: boolean;
  isPixel: boolean;
  hasReferenceImages: boolean;
  className?: string;
}

const PANEL_WIDTH = 432;
const PANEL_HEIGHT = 520;
const VIEWPORT_GAP = 10;

const stopCanvasEvent = (event: { stopPropagation: () => void }) => event.stopPropagation();

function normalizedSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

const ImagePromptAdjustmentButton = ({
  selections,
  onChange,
  isDark,
  isPixel,
  hasReferenceImages,
  className = '',
}: Props) => {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const normalizedSelections = useMemo(
    () => normalizeImagePromptAdjustmentSelections(selections),
    [selections],
  );
  const selectedIds = useMemo(
    () => new Set(normalizedSelections.map((selection) => selection.itemId)),
    [normalizedSelections],
  );
  const selectedByCategory = useMemo(
    () => new Map(normalizedSelections.map((selection) => [selection.categoryId, selection])),
    [normalizedSelections],
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCategoryId, setActiveCategoryId] = useState(
    IMAGE_PROMPT_ADJUSTMENT_CATEGORIES[0]?.id || '',
  );
  const [previousSelections, setPreviousSelections] = useState<ImagePromptAdjustmentSelection[] | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});

  const activeCategory = IMAGE_PROMPT_ADJUSTMENT_CATEGORIES.find(
    (category) => category.id === activeCategoryId,
  ) || IMAGE_PROMPT_ADJUSTMENT_CATEGORIES[0];

  const visibleItems = useMemo(() => {
    const search = normalizedSearch(query);
    const source = search
      ? IMAGE_PROMPT_ADJUSTMENTS
      : IMAGE_PROMPT_ADJUSTMENTS.filter((item) => item.categoryId === activeCategory?.id);
    if (!search) return source;
    return source.filter((item) => {
      const category = IMAGE_PROMPT_ADJUSTMENT_CATEGORIES.find(
        (candidate) => candidate.id === item.categoryId,
      );
      return [
        item.id,
        item.labelZh,
        item.labelEn,
        item.promptZh,
        item.promptEn,
        category?.labelZh || '',
        category?.labelEn || '',
      ].some((text) => text.toLocaleLowerCase().includes(search));
    });
  }, [activeCategory?.id, query]);

  const updatePosition = () => {
    const button = triggerRef.current;
    if (!button || typeof window === 'undefined') return;
    const rect = button.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, Math.max(300, window.innerWidth - VIEWPORT_GAP * 2));
    const height = Math.min(PANEL_HEIGHT, Math.max(360, window.innerHeight - VIEWPORT_GAP * 2));
    const left = Math.min(
      Math.max(VIEWPORT_GAP, rect.right - width),
      Math.max(VIEWPORT_GAP, window.innerWidth - width - VIEWPORT_GAP),
    );
    const availableBelow = window.innerHeight - rect.bottom - VIEWPORT_GAP;
    const top = availableBelow >= Math.min(height, 400)
      ? rect.bottom + 6
      : Math.max(VIEWPORT_GAP, rect.top - height - 6);
    setPanelStyle({ left, top, width, height, maxHeight: height });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleResize = () => updatePosition();
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      setOpen(false);
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    document.addEventListener('pointerdown', handleOutsidePointer, true);
    window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
      document.removeEventListener('pointerdown', handleOutsidePointer, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const applyItem = (item: ImagePromptAdjustmentItem) => {
    if (item.applicability === 'reference' && !hasReferenceImages) {
      setAnnouncement(`${item.labelZh}需要至少一张参考图`);
      return;
    }
    const before = normalizedSelections;
    const next = toggleImagePromptAdjustmentSelection(before, item);
    setPreviousSelections(before);
    onChange(next);
    const removed = before.filter((selection) => (
      !next.some((candidate) => candidate.itemId === selection.itemId)
      && selection.itemId !== item.id
    ));
    const nowSelected = next.some((selection) => selection.itemId === item.id);
    setAnnouncement(
      nowSelected
        ? removed.length > 0
          ? `已应用${item.labelZh}，并替换冲突项${removed.map((entry) => entry.labelZh).join('、')}`
          : `已应用${item.labelZh}`
        : `已移除${item.labelZh}`,
    );
  };

  const restorePrevious = () => {
    if (!previousSelections) return;
    const current = normalizedSelections;
    onChange(previousSelections);
    setPreviousSelections(current);
    setAnnouncement('已撤销上一次调节更改');
  };

  const clearAll = () => {
    if (normalizedSelections.length === 0) return;
    setPreviousSelections(normalizedSelections);
    onChange([]);
    setAnnouncement('已清空全部图像调节');
  };

  const focusVisibleOption = (index: number) => {
    if (visibleItems.length === 0) return;
    const safeIndex = Math.max(0, Math.min(visibleItems.length - 1, index));
    optionRefs.current.get(visibleItems[safeIndex].id)?.focus();
  };

  const handleOptionKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusVisibleOption(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index === 0) searchRef.current?.focus();
      else focusVisibleOption(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusVisibleOption(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusVisibleOption(visibleItems.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const themeStyle: CSSProperties = isPixel
    ? {
        color: 'var(--px-ink, #1a1410)',
        background: 'var(--px-surface, #fff7df)',
        border: '2px solid var(--px-ink, #1a1410)',
        boxShadow: '4px 4px 0 var(--px-ink, #1a1410)',
      }
    : isDark
      ? {
          color: '#f8fafc',
          background: 'rgba(13, 18, 15, .985)',
          border: '1px solid rgba(163, 230, 53, .30)',
          boxShadow: '0 20px 55px rgba(0,0,0,.48)',
        }
      : {
          color: '#172015',
          background: 'rgba(250, 253, 247, .99)',
          border: '1px solid rgba(54, 83, 42, .22)',
          boxShadow: '0 20px 50px rgba(15,23,42,.22)',
        };

  const panel = open && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="图像调节助手"
          data-image-prompt-adjustment-panel
          className="nodrag nopan nowheel fixed z-[10080] flex overflow-hidden rounded-xl text-[11px]"
          style={{ ...panelStyle, ...themeStyle }}
          onPointerDown={stopCanvasEvent}
          onMouseDown={stopCanvasEvent}
          onClick={stopCanvasEvent}
          onWheel={stopCanvasEvent}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-current/10 px-3">
              <SlidersHorizontal size={14} className="text-lime-400" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">图像调节</div>
                <div className="truncate text-[9px] opacity-55">
                  点击即应用 · 同类自动替换 · 本地免费
                </div>
              </div>
              {normalizedSelections.length > 0 && (
                <span className="rounded-full bg-lime-400/15 px-1.5 py-0.5 text-[9px] font-semibold text-lime-300">
                  {normalizedSelections.length} 项
                </span>
              )}
              <button
                type="button"
                className="rounded p-1 opacity-65 hover:bg-current/10 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
                onClick={close}
                aria-label="关闭图像调节助手"
                title="关闭"
              >
                <X size={14} />
              </button>
            </div>

            <div className="shrink-0 px-3 py-2">
              <label className="flex h-8 items-center gap-2 rounded-lg border border-current/15 bg-current/[0.035] px-2 focus-within:border-lime-400/65">
                <Search size={13} className="opacity-55" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' && visibleItems.length > 0) {
                      event.preventDefault();
                      focusVisibleOption(0);
                    }
                  }}
                  placeholder="搜索调节名称、效果或场景…"
                  className="nodrag nopan min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:opacity-40"
                  aria-label="搜索图像调节"
                />
                {query && (
                  <button
                    type="button"
                    className="rounded p-0.5 opacity-50 hover:opacity-100"
                    onClick={() => setQuery('')}
                    aria-label="清空搜索"
                  >
                    <X size={12} />
                  </button>
                )}
              </label>
            </div>

            <div className="flex min-h-0 flex-1 border-y border-current/10">
              <nav
                aria-label="图像调节分类"
                className="nowheel w-[116px] shrink-0 overflow-y-auto border-r border-current/10 p-1.5"
              >
                {IMAGE_PROMPT_ADJUSTMENT_CATEGORIES.map((category) => {
                  const selected = selectedByCategory.get(category.id);
                  const active = !query && activeCategory?.id === category.id;
                  return (
                    <button
                      key={category.id}
                      type="button"
                      className={`mb-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 ${
                        active ? 'bg-lime-400/16 text-lime-300' : 'hover:bg-current/[0.06]'
                      }`}
                      aria-current={active ? 'page' : undefined}
                      title={category.descriptionZh}
                      onClick={() => {
                        setQuery('');
                        setActiveCategoryId(category.id);
                      }}
                    >
                      <span
                        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[8px] font-bold ${
                          selected ? 'bg-lime-400 text-black' : 'bg-current/10'
                        }`}
                      >
                        {selected ? <Check size={10} strokeWidth={3} /> : category.code}
                      </span>
                      <span className="min-w-0 flex-1 leading-tight">{category.labelZh}</span>
                    </button>
                  );
                })}
              </nav>

              <div className="flex min-w-0 flex-1 flex-col">
                <div className="shrink-0 border-b border-current/10 px-3 py-2">
                  {query ? (
                    <div className="flex items-center gap-1 opacity-70">
                      <ChevronLeft size={12} />
                      搜索结果 · {visibleItems.length} 项
                    </div>
                  ) : (
                    <>
                      <div className="font-semibold">{activeCategory?.labelZh}</div>
                      <div className="mt-0.5 line-clamp-2 text-[9px] leading-relaxed opacity-55">
                        {activeCategory?.descriptionZh}
                      </div>
                    </>
                  )}
                </div>
                <div
                  role="listbox"
                  aria-label={query ? '图像调节搜索结果' : activeCategory?.labelZh}
                  aria-multiselectable="true"
                  className="nowheel min-h-0 flex-1 overflow-y-auto p-1.5"
                >
                  {visibleItems.map((item, index) => {
                    const category = IMAGE_PROMPT_ADJUSTMENT_CATEGORIES.find(
                      (candidate) => candidate.id === item.categoryId,
                    );
                    const selected = selectedIds.has(item.id);
                    const disabled = item.applicability === 'reference' && !hasReferenceImages;
                    return (
                      <button
                        key={item.id}
                        id={`image-adjustment-${item.id}`}
                        ref={(element) => {
                          if (element) optionRefs.current.set(item.id, element);
                          else optionRefs.current.delete(item.id);
                        }}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-disabled={disabled}
                        disabled={disabled}
                        className={`mb-1 flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 ${
                          selected
                            ? 'border-lime-400/60 bg-lime-400/13'
                            : 'border-transparent hover:border-current/10 hover:bg-current/[0.045]'
                        } ${disabled ? 'cursor-not-allowed opacity-35' : ''}`}
                        title={disabled ? '连接或上传至少一张参考图后可用' : item.promptZh}
                        onClick={() => applyItem(item)}
                        onKeyDown={(event) => handleOptionKeyDown(event, index)}
                      >
                        <span
                          className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            selected
                              ? 'border-lime-400 bg-lime-400 text-black'
                              : 'border-current/20'
                          }`}
                          aria-hidden="true"
                        >
                          {selected && <Check size={10} strokeWidth={3} />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 font-medium">
                            {item.labelZh}
                            {query && (
                              <span className="rounded bg-current/[0.07] px-1 text-[8px] opacity-60">
                                {category?.labelZh}
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block line-clamp-2 text-[9px] leading-relaxed opacity-55">
                            {disabled ? '需要参考图 · 当前未连接' : item.promptZh}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {visibleItems.length === 0 && (
                    <div className="px-3 py-8 text-center opacity-45">没有匹配的调节项</div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex h-10 shrink-0 items-center gap-2 px-3">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-current/15 px-2 py-1 opacity-75 hover:bg-current/[0.06] disabled:cursor-not-allowed disabled:opacity-25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
                disabled={!previousSelections}
                onClick={restorePrevious}
              >
                <RotateCcw size={11} />
                撤销
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-current/15 px-2 py-1 opacity-75 hover:bg-red-400/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
                disabled={normalizedSelections.length === 0}
                onClick={clearAll}
              >
                <Trash2 size={11} />
                清空
              </button>
              <div className="min-w-0 flex-1 truncate text-right text-[9px] opacity-45">
                {hasReferenceImages ? '参考图调节可用' : '参考图类需先连接图片'}
              </div>
            </div>
            <div className="sr-only" aria-live="polite">{announcement}</div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-image-prompt-adjustment-trigger
        className={`nodrag nopan relative inline-flex h-6 w-6 items-center justify-center rounded border shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 ${
          normalizedSelections.length > 0
            ? 'border-lime-400/70 bg-lime-400/20 text-lime-300'
            : 'border-white/10 bg-black/45 text-white/70 hover:text-white'
        } ${className}`}
        aria-label={`图像调节助手${normalizedSelections.length ? `，已选 ${normalizedSelections.length} 项` : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={normalizedSelections.length > 0 ? `图像调节 · 已选 ${normalizedSelections.length} 项` : '图像调节助手'}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <SlidersHorizontal size={12} />
        {normalizedSelections.length > 0 && (
          <span className="absolute -right-1.5 -top-1.5 min-w-3.5 rounded-full bg-lime-400 px-1 text-[8px] font-black leading-[14px] text-black">
            {normalizedSelections.length > 9 ? '9+' : normalizedSelections.length}
          </span>
        )}
      </button>
      {panel}
    </>
  );
};

export default memo(ImagePromptAdjustmentButton);
