import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import RhImageCapabilityButton from './RhImageCapabilityButton';
import type { RunRhImageCapabilityBatchResult } from '../services/rhToolboxCapabilities';
import {
  RH_IMAGE_NODE_CAPABILITY_PRESETS,
  resolveRhImageCapabilityPreset,
  type RhImageCapabilityPresetId,
} from '../utils/rhToolboxCapabilities';
import type { QueueSecondaryProviderAction } from '../utils/secondaryProviderAction';

interface RhImageCapabilityRailProps {
  secondaryActionNodeId: string;
  queueSecondaryAction: QueueSecondaryProviderAction;
  sourceUrl?: string;
  sourceUrls?: string[];
  accent: string;
  isDark: boolean;
  isPixel?: boolean;
  presets?: RhImageCapabilityPresetId[];
  onComplete: (result: RunRhImageCapabilityBatchResult) => void;
  onError?: (message: string) => void;
  onRunningChange?: (running: boolean) => void;
  style?: CSSProperties;
}

export default function RhImageCapabilityRail({
  secondaryActionNodeId,
  queueSecondaryAction,
  sourceUrl,
  sourceUrls,
  accent,
  isDark,
  isPixel = false,
  presets = RH_IMAGE_NODE_CAPABILITY_PRESETS,
  onComplete,
  onError,
  onRunningChange,
  style,
}: RhImageCapabilityRailProps) {
  const [runningPresetIds, setRunningPresetIds] = useState<Set<string>>(() => new Set());
  const runningPresetIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    onRunningChange?.(runningPresetIds.size > 0);
  }, [onRunningChange, runningPresetIds]);

  const setPresetRunning = useCallback((presetId: string, running: boolean) => {
    const next = new Set(runningPresetIdsRef.current);
    if (running) next.add(presetId);
    else next.delete(presetId);
    runningPresetIdsRef.current = next;
    setRunningPresetIds(next);
    onRunningChange?.(next.size > 0);
  }, [onRunningChange]);

  if (presets.length === 0) return null;

  return (
    <div
      className="nodrag nopan rh-image-capability-rail"
      data-rh-image-capability-rail
      data-rh-image-capability-count={presets.length}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 44,
        left: -44,
        zIndex: 32,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        maxHeight: 'calc(100% - 58px)',
        overflowX: 'visible',
        overflowY: 'auto',
        padding: '2px',
        scrollbarWidth: 'thin',
        pointerEvents: 'auto',
        ...style,
      }}
    >
      {presets.map((presetId) => {
        const preset = resolveRhImageCapabilityPreset(presetId);
        return (
          <RhImageCapabilityButton
            key={preset.id}
            secondaryActionNodeId={secondaryActionNodeId}
            queueSecondaryAction={queueSecondaryAction}
            sourceUrl={sourceUrl}
            sourceUrls={sourceUrls}
            accent={accent}
            isDark={isDark}
            isPixel={isPixel}
            preset={presetId}
            label={preset.label}
            shortLabel={preset.shortLabel}
            title={preset.title}
            variant="rail"
            onComplete={onComplete}
            onError={onError}
            onRunningChange={(running) => setPresetRunning(preset.id, running)}
          />
        );
      })}
    </div>
  );
}
