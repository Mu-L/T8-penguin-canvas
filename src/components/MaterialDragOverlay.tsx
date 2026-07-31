/**
 * MaterialDragOverlay —— 跨节点素材拖拽的全局浮层 + 命中检测
 *
 * 职责:
 *   1. 监听全局 mousemove: 更新浮层位置 + 通过 elementFromPoint 探测命中目标
 *   2. 监听全局 mouseup: 派发 penguin:material-drop CustomEvent 给目标节点
 *   3. 渲染跟随鼠标的幽灵缩略图 (createPortal 到 body, 不受 ReactFlow transform 影响)
 *   4. 拖拽期间在 body 上设置 cursor 与 user-select 状态
 *
 * 不破坏既有功能:
 *   - 仅在 store.dragging === true 时挂监听
 *   - 不直接调用任何节点 API, 仅用 CustomEvent 投递
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  MATERIAL_DROP_EVENT,
  useDragMaterialStore,
  type MaterialDropEventDetail,
  type MaterialKind,
} from '../stores/dragMaterial';
import { useThemeStore } from '../stores/theme';
import SmartImage from './SmartImage';

const PREVIEW_SIZE = 96;

const MaterialDragOverlay = () => {
  const dragging = useDragMaterialStore((s) => s.dragging);
  const payload = useDragMaterialStore((s) => s.payload);
  const clientX = useDragMaterialStore((s) => s.clientX);
  const clientY = useDragMaterialStore((s) => s.clientY);
  const hoverAccepts = useDragMaterialStore((s) => s.hoverAccepts);
  const move = useDragMaterialStore((s) => s.move);
  const end = useDragMaterialStore((s) => s.end);
  const start = useDragMaterialStore((s) => s.start);

  const { style: themeStyle } = useThemeStore();
  const isPixel = themeStyle === 'pixel';

  // === 全局 capture 阶段 pointerdown / mousedown 拦截 ===
  // 原因: ReactFlow v12 在 Pane 上使用 onPointerDownCapture 启动 userSelection.
  //       pointerdown 在 mousedown 之前触发, 仅拦截 mousedown 无效.
  // 解决: 在 document 原生 capture 阶段同时拦截 pointerdown / mousedown,
  //       document capture 会先于 React root 上的 capture 事件触发.
  //       用 elementsFromPoint 穿透任何覆盖层查找 [data-drag-source] 素材元素.
  useEffect(() => {
    const handleDown = (e: PointerEvent | MouseEvent): boolean => {
      // 仅响应 Ctrl/Meta + 左键
      if (e.button !== 0) return false;
      if (!(e.ctrlKey || e.metaKey)) return false;
      if ('isPrimary' in e && (e as PointerEvent).isPrimary === false) return false;
      // 已在拖拽中不重复启动
      if (useDragMaterialStore.getState().dragging) return false;

      // elementsFromPoint 穿透覆盖层取堆叠元素
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      let dragEl: HTMLElement | null = null;
      for (const el of stack) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.hasAttribute('data-drag-source')) {
          dragEl = el;
          break;
        }
        const closest = el.closest('[data-drag-source]') as HTMLElement | null;
        if (closest) {
          dragEl = closest;
          break;
        }
      }
      if (!dragEl) return false;

      const kind = dragEl.getAttribute('data-drag-kind') as MaterialKind | null;
      if (!kind) return false;
      const url = dragEl.getAttribute('data-drag-url') || undefined;
      const text = dragEl.getAttribute('data-drag-text') || undefined;
      const sourceNodeId = dragEl.getAttribute('data-drag-node-id') || undefined;
      const previewUrl = dragEl.getAttribute('data-drag-preview') || url;
      const name = dragEl.getAttribute('data-drag-name') || undefined;
      const mime = dragEl.getAttribute('data-drag-mime') || undefined;
      const rawSize = Number(dragEl.getAttribute('data-drag-size'));
      const size = Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : undefined;

      // 严格拦截: 阻止 ReactFlow Pane 启动选区
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // 只在首个 (pointerdown) 事件中启动拖拽, 后续 mousedown 仅拦截
      if (!useDragMaterialStore.getState().dragging) {
        start(
          { kind, url, text, sourceNodeId, previewUrl, name, mime, size },
          e.clientX,
          e.clientY,
        );
      }
      return true;
    };

    const onPointerDown = (e: PointerEvent) => { handleDown(e); };
    const onMouseDown = (e: MouseEvent) => { handleDown(e); };

    // 同时拦截 pointerdown 与 mousedown
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('mousedown', onMouseDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [start]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      // 探测命中: data-drop-kinds 节点
      // 使用 elementsFromPoint 穿透 ReactFlow SelectionPane 覆盖层
      const stack = document.elementsFromPoint(e.clientX, e.clientY);
      let dropEl: HTMLElement | null = null;
      for (const el of stack) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.hasAttribute('data-drop-kinds')) {
          dropEl = el;
          break;
        }
        const closest = el.closest('[data-drop-kinds]') as HTMLElement | null;
        if (closest) {
          dropEl = closest;
          break;
        }
      }
      let hoverTargetId: string | null = null;
      let accepts = false;
      if (dropEl) {
        const kinds = (dropEl.getAttribute('data-drop-kinds') || '').split(',').filter(Boolean);
        const targetId = dropEl.getAttribute('data-node-id') || null;
        const cur = useDragMaterialStore.getState().payload;
        const allowSelf = false;
        if (
          targetId &&
          cur &&
          kinds.includes(cur.kind) &&
          (allowSelf || cur.sourceNodeId !== targetId)
        ) {
          hoverTargetId = targetId;
          accepts = true;
        } else if (targetId) {
          hoverTargetId = targetId;
          accepts = false;
        }
      }
      move(e.clientX, e.clientY, hoverTargetId, accepts);
    };

    const onUp = (e: MouseEvent) => {
      const cur = useDragMaterialStore.getState();
      if (cur.dragging && cur.payload && cur.hoverTargetId && cur.hoverAccepts) {
        const detail: MaterialDropEventDetail = {
          targetNodeId: cur.hoverTargetId,
          payload: cur.payload,
        };
        window.dispatchEvent(new CustomEvent(MATERIAL_DROP_EVENT, { detail }));
      }
      end();
      e.stopPropagation();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end();
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('keydown', onKey, true);

    // 拖拽期 body 锁定光标 + 禁选中
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [dragging, move, end]);

  if (!dragging || !payload) return null;
  if (typeof document === 'undefined') return null;

  // 浮层样式
  const accent = hoverAccepts ? '#22c55e' : '#94a3b8'; // green-500 / slate-400
  const borderColor = isPixel ? '#1A1410' : accent;
  const borderRadius = isPixel ? 6 : 10;
  const shadow = isPixel
    ? `4px 4px 0 ${accent}`
    : `0 6px 20px ${accent}55`;

  // 内容预览
  let content: React.ReactNode = null;
  if (payload.kind === 'image' && payload.url) {
    content = (
      <SmartImage
        src={payload.previewUrl || payload.url}
        alt="dragging"
        style={{
          width: PREVIEW_SIZE,
          height: PREVIEW_SIZE,
          objectFit: 'cover',
          display: 'block',
          imageRendering: isPixel ? 'pixelated' : 'auto',
        }}
        draggable={false}
        thumbSize={160}
      />
    );
  } else if (payload.kind === 'video') {
    content = (
      <div
        style={{
          width: PREVIEW_SIZE,
          height: PREVIEW_SIZE,
          background: '#1f2937',
          color: '#a78bfa',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        🎬 VIDEO
      </div>
    );
  } else if (payload.kind === 'audio') {
    content = (
      <div
        style={{
          width: PREVIEW_SIZE,
          height: PREVIEW_SIZE,
          background: '#1f2937',
          color: '#c4b5fd',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        🎵 AUDIO
      </div>
    );
  } else if (payload.kind === 'text') {
    const text = (payload.text || '').slice(0, 40);
    content = (
      <div
        style={{
          width: PREVIEW_SIZE * 1.6,
          minHeight: PREVIEW_SIZE / 2,
          background: '#0f172a',
          color: '#7dd3fc',
          padding: '6px 8px',
          fontSize: 11,
          lineHeight: 1.4,
          fontWeight: 600,
        }}
      >
        {text || '(empty text)'}
      </div>
    );
  }

  const overlay = (
    <div
      style={{
        position: 'fixed',
        left: clientX + 12,
        top: clientY + 12,
        zIndex: 9999,
        pointerEvents: 'none',
        border: `2px solid ${borderColor}`,
        borderRadius,
        boxShadow: shadow,
        opacity: 0.92,
        overflow: 'hidden',
        background: '#000',
      }}
    >
      {content}
    </div>
  );

  return createPortal(overlay, document.body);
};

export default MaterialDragOverlay;
