/**
 * dragMaterial Store —— 跨节点素材拖拽全局状态
 *
 * 设计目标:
 *   节点内的图像/视频/音频/文本缩略图被「Ctrl + 鼠标左键按下」开始拖拽时,
 *   在画布顶层渲染跟随鼠标的幽灵浮层, 释放时根据 elementFromPoint 命中
 *   带有 data-drop-kinds 属性的目标节点, 把素材通过 CustomEvent 投递给目标节点。
 *
 * 关键不破坏原则:
 *   - 仅在 onMouseDown 检测到 e.ctrlKey/metaKey 时才启动 (避开 ReactFlow 节点拖动)
 *   - 启动后阻止 ReactFlow 框选 / 节点拖动 (e.stopPropagation + e.preventDefault)
 *   - 启动期间将 selectionKeyCode 临时禁用以避免 Ctrl 同步触发框选
 */
import { create } from 'zustand';

export type MaterialKind = 'image' | 'video' | 'audio' | 'text';

export interface MaterialPayload {
  kind: MaterialKind;
  /** image/video/audio 的 URL */
  url?: string;
  /** text 的内容 */
  text?: string;
  /** 来源节点 id (用于自身屏蔽: 不允许把素材拖回自己) */
  sourceNodeId?: string;
  /** 缩略图占位预览, 用于浮层显示 (可空) */
  previewUrl?: string;
  /** 原文件名；资源库 URL 本身不含扩展名，上传 Provider 时用于保留真实格式 */
  name?: string;
  /** 资源库记录的 MIME，仅作格式提示，后端仍以文件魔数校验 */
  mime?: string;
  /** 原素材字节数 */
  size?: number;
}

interface DragMaterialState {
  dragging: boolean;
  payload: MaterialPayload | null;
  /** 当前鼠标屏幕坐标 (用于浮层定位) */
  clientX: number;
  clientY: number;
  /** 命中的目标节点 id (供节点 hover 高亮) */
  hoverTargetId: string | null;
  /** 命中目标是否接受当前 payload.kind */
  hoverAccepts: boolean;

  start: (payload: MaterialPayload, clientX: number, clientY: number) => void;
  move: (clientX: number, clientY: number, hoverTargetId: string | null, hoverAccepts: boolean) => void;
  end: () => void;
}

export const useDragMaterialStore = create<DragMaterialState>((set) => ({
  dragging: false,
  payload: null,
  clientX: 0,
  clientY: 0,
  hoverTargetId: null,
  hoverAccepts: false,

  start: (payload, clientX, clientY) =>
    set({ dragging: true, payload, clientX, clientY, hoverTargetId: null, hoverAccepts: false }),
  move: (clientX, clientY, hoverTargetId, hoverAccepts) =>
    set({ clientX, clientY, hoverTargetId, hoverAccepts }),
  end: () =>
    set({ dragging: false, payload: null, hoverTargetId: null, hoverAccepts: false }),
}));

/** 投放事件名 (CustomEvent.detail = { targetNodeId, payload }) */
export const MATERIAL_DROP_EVENT = 'penguin:material-drop';

export interface MaterialDropEventDetail {
  targetNodeId: string;
  payload: MaterialPayload;
}
