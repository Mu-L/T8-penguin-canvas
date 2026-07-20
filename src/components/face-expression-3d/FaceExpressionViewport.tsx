import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Crosshair, RotateCcw } from 'lucide-react';
import type { FaceExpression3DState, FaceExpressionOutputSettings } from '../../utils/faceExpression3D';
import {
  FaceExpressionScene,
  type FaceModelCompatibilityReport,
} from '../../three/faceExpression/FaceExpressionScene';

export interface FaceExpressionViewportHandle {
  exportImage: (output?: FaceExpressionOutputSettings) => Promise<string>;
  setState: (state: FaceExpression3DState) => Promise<void>;
  getCompatibilityReport: () => FaceModelCompatibilityReport | null;
  resetCamera: () => void;
}

interface FaceExpressionViewportProps {
  state: FaceExpression3DState;
  className?: string;
  interactive?: boolean;
  showToolbar?: boolean;
  onStateChange?: (state: FaceExpression3DState) => void;
  onCompatibility?: (report: FaceModelCompatibilityReport) => void;
  onError?: (message: string) => void;
}

const FaceExpressionViewport = forwardRef<FaceExpressionViewportHandle, FaceExpressionViewportProps>(({
  state,
  className = '',
  interactive = true,
  showToolbar = true,
  onStateChange,
  onCompatibility,
  onError,
}, ref) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<FaceExpressionScene | null>(null);
  const stateRef = useRef(state);
  const callbacksRef = useRef({ onStateChange, onCompatibility, onError });
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState('正在准备 3D 表情场景...');

  stateRef.current = state;
  callbacksRef.current = { onStateChange, onCompatibility, onError };

  useImperativeHandle(ref, () => ({
    exportImage: async (output) => {
      if (!sceneRef.current) throw new Error('3D 表情场景尚未就绪');
      return sceneRef.current.exportImage(output);
    },
    setState: async (nextState) => {
      if (!sceneRef.current) throw new Error('3D 表情场景尚未就绪');
      stateRef.current = nextState;
      await sceneRef.current.setState(nextState);
    },
    getCompatibilityReport: () => sceneRef.current?.getCompatibilityReport() || null,
    resetCamera: () => sceneRef.current?.resetCamera(),
  }), []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    try {
      const scene = new FaceExpressionScene(mount, stateRef.current, {
        interactive,
        onCameraChange: ({ position, target }) => {
          const current = stateRef.current;
          callbacksRef.current.onStateChange?.({
            ...current,
            camera: { ...current.camera, position, target, framingPreset: 'custom' },
          });
        },
        onCompatibility: (report) => {
          callbacksRef.current.onCompatibility?.(report);
          if (!disposed) setMessage(report.source === 'builtin' ? 'T8 内置中性人类白模' : `已映射 ${report.mappedChannels.length} 个表情通道`);
        },
        onError: (error) => {
          callbacksRef.current.onError?.(error);
          if (!disposed) setMessage(error);
        },
      });
      sceneRef.current = scene;
      setReady(true);
      const resize = () => scene.setSize(mount.clientWidth || 640, mount.clientHeight || 640);
      const observer = new ResizeObserver(resize);
      observer.observe(mount);
      resize();
      return () => {
        disposed = true;
        observer.disconnect();
        scene.destroy();
        if (sceneRef.current === scene) sceneRef.current = null;
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : '无法创建 3D 表情场景';
      setMessage(text);
      callbacksRef.current.onError?.(text);
    }
  }, [interactive]);

  useEffect(() => {
    stateRef.current = state;
    void sceneRef.current?.setState(state);
  }, [state]);

  return (
    <div
      className={`relative min-h-0 overflow-hidden bg-[#d9e4eb] ${className}`}
      data-testid="face-expression-viewport"
    >
      <div ref={mountRef} className="absolute inset-0" />
      {state.camera.guides && (
        <div className="pointer-events-none absolute inset-0 z-[2]" aria-hidden="true">
          <div className="absolute left-1/3 top-0 h-full border-l border-white/35" />
          <div className="absolute left-2/3 top-0 h-full border-l border-white/35" />
          <div className="absolute left-0 top-1/3 w-full border-t border-white/35" />
          <div className="absolute left-0 top-2/3 w-full border-t border-white/35" />
          <Crosshair className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/55" size={20} />
        </div>
      )}
      {showToolbar && (
        <div className="pointer-events-none absolute inset-x-3 top-3 z-[3] flex items-start justify-between gap-2">
          <div className="rounded-md border border-white/50 bg-black/55 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
            {ready ? message : '正在加载 WebGL...'}
          </div>
          <button
            type="button"
            className="nodrag pointer-events-auto inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/50 bg-black/55 text-white backdrop-blur-sm hover:bg-black/70"
            onClick={() => sceneRef.current?.resetCamera()}
            title="复位相机"
          >
            <RotateCcw size={15} />
          </button>
        </div>
      )}
    </div>
  );
});

FaceExpressionViewport.displayName = 'FaceExpressionViewport';

export default FaceExpressionViewport;
