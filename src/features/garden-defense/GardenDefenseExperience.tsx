import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  BookOpen,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Gauge,
  Leaf,
  LockKeyhole,
  Map,
  Maximize2,
  Minimize2,
  RotateCcw,
  Shield,
  Sparkles,
  Swords,
  Trophy,
  Volume2,
  VolumeX,
  Wind,
  X,
} from 'lucide-react';
import {
  applyGardenVictory,
  collectGardenSun,
  createGardenRun,
  gardenWaveProgress,
  pauseGardenRun,
  placeGardenPlant,
  removeGardenPlant,
  startGardenRun,
  stepGardenRun,
  upgradeGardenPlant,
} from './engine.ts';
import {
  GARDEN_PLANT_ORDER,
  GARDEN_PLANTS,
  GARDEN_STAGES,
  GARDEN_ZOMBIE_ORDER,
  GARDEN_ZOMBIES,
  gardenUpgradeCost,
  getGardenStage,
} from './catalog.ts';
import { GARDEN_PLANT_ASSETS, GARDEN_UI_ASSETS, GARDEN_ZOMBIE_ASSETS } from './assets.ts';
import { loadGardenProfile, loadGardenRun, saveGardenProfile, saveGardenRun } from './storage.ts';
import { playGardenSound, unlockGardenSound } from './sound.ts';
import type { GardenCombatEffect, GardenPlantId, GardenProfile, GardenRunState } from './types.ts';

const GARDEN_VISUAL_STYLE = 'garden-defense';
const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;
const SIMULATION_STEP_MS = 1000 / 30;
const GardenDefenseStage = lazy(() => import('./GardenDefenseStage.tsx'));

export const GARDEN_PANEL_COLLAPSED_STORAGE_KEY = 't8.garden-defense.panel.collapsed.v1';

type GardenOverlay = 'none' | 'stages' | 'upgrades' | 'almanac';

interface GardenDefenseExperienceProps {
  visualStyle: string;
  canvasId: string;
  viewportMoving?: boolean;
  nodeDragging?: boolean;
}

function stageIsUnlocked(stageNumber: number, profile: GardenProfile) {
  if (stageNumber <= 1) return true;
  return profile.completedStages.includes(`garden-${String(stageNumber - 1).padStart(2, '0')}`);
}

function nextUnlockedStage(profile: GardenProfile) {
  return GARDEN_STAGES.find((stage) => !profile.completedStages.includes(stage.id) && stageIsUnlocked(stage.number, profile)) || GARDEN_STAGES[0];
}

function formatCooldown(value: number | undefined, total: number) {
  if (!value || value <= 0) return 0;
  return Math.max(0, Math.min(1, value / Math.max(1, total)));
}

function gardenPanelStyle(stageScale: number): CSSProperties & Record<'--garden-hud-texture' | '--garden-seed-texture' | '--garden-progress-texture' | '--garden-stage-scale', string> {
  return {
    '--garden-hud-texture': `url(${GARDEN_UI_ASSETS.hudBanner})`,
    '--garden-seed-texture': `url(${GARDEN_UI_ASSETS.seedPacket})`,
    '--garden-progress-texture': `url(${GARDEN_UI_ASSETS.progressFrame})`,
    '--garden-stage-scale': String(stageScale),
  };
}

function isGardenInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element
    ? Boolean(target.closest('.t8-garden-defense-world, button, a, input, textarea, select, [role="button"], [contenteditable="true"]'))
    : false;
}

function stopGardenCanvasGesture(event: SyntheticEvent<HTMLElement>) {
  if (isGardenInteractiveTarget(event.target)) return;
  event.stopPropagation();
}

function getStageResultTitle(state: GardenRunState) {
  if (state.status === 'won') return '庭院守住了';
  if (state.status === 'lost') return '温室失守';
  return '';
}

export default function GardenDefenseExperience({
  visualStyle,
  canvasId,
  viewportMoving = false,
  nodeDragging = false,
}: GardenDefenseExperienceProps) {
  const active = visualStyle === GARDEN_VISUAL_STYLE;
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(GARDEN_PANEL_COLLAPSED_STORAGE_KEY) === '1';
  });
  const [hasOpenedPanel, setHasOpenedPanel] = useState(() => !collapsed);
  const [profile, setProfile] = useState<GardenProfile>(() => loadGardenProfile());
  const [run, setRun] = useState<GardenRunState>(() => loadGardenRun(canvasId, nextUnlockedStage(loadGardenProfile()).id));
  const [selectedPlant, setSelectedPlant] = useState<GardenPlantId>('pea-scout');
  const [shovelActive, setShovelActive] = useState(false);
  const [overlay, setOverlay] = useState<GardenOverlay>('none');
  const [feedback, setFeedback] = useState('选择植物，再点击草坪格子部署。');
  const [sunPulseKey, setSunPulseKey] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [isStageMode, setIsStageMode] = useState(false);
  const [stageScale, setStageScale] = useState(1);
  const [windowReady, setWindowReady] = useState(() => (
    typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus())
  ));
  const [autoPauseReason, setAutoPauseReason] = useState<string | null>(null);
  const profileRef = useRef(profile);
  const autoPausedRef = useRef(false);
  const previousEventIdRef = useRef<string | null>(run.events[0]?.id || null);
  const processedCombatEffectIdsRef = useRef(new Set(run.effects.map((effect) => effect.id)));
  const processedCombatRunIdRef = useRef(run.runId);
  const previousCanvasIdRef = useRef(canvasId);
  const panelRootRef = useRef<HTMLDivElement | null>(null);
  const activeAutoPauseReason = collapsed && !isStageMode
    ? '游戏已隐藏，战斗自动暂停'
    : !windowReady
      ? '窗口失焦，战斗自动暂停'
      : viewportMoving
        ? '画布移动中，战斗自动暂停'
        : nodeDragging
          ? '节点拖动中，战斗自动暂停'
          : !hovered
            ? '鼠标离开，战斗自动暂停'
            : null;
  const interactionLocked = Boolean(activeAutoPauseReason) || overlay !== 'none';
  const stage = useMemo(() => getGardenStage(run.stageId), [run.stageId]);
  const progress = gardenWaveProgress(run);

  useEffect(() => {
    profileRef.current = profile;
    saveGardenProfile(profile);
  }, [profile]);

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    window.localStorage.setItem(GARDEN_PANEL_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  }, [active, collapsed]);

  useEffect(() => {
    if (active || !isStageMode) return;
    setIsStageMode(false);
    setHovered(false);
  }, [active, isStageMode]);

  useEffect(() => {
    if (!active || !isStageMode || typeof document === 'undefined' || typeof window === 'undefined') return;
    const updateStageScale = () => {
      const horizontalPadding = window.innerWidth <= 640 ? 24 : 48;
      const verticalPadding = window.innerHeight <= 640 ? 24 : 48;
      const nextScale = Math.max(0.25, Math.min(
        (window.innerWidth - horizontalPadding) / GAME_WIDTH,
        (window.innerHeight - verticalPadding) / GAME_HEIGHT,
        1.45,
      ));
      setStageScale(Math.round(nextScale * 10000) / 10000);
    };
    document.body.classList.add('t8-garden-defense-stage-open');
    updateStageScale();
    window.addEventListener('resize', updateStageScale);
    const focusFrame = window.requestAnimationFrame(() => panelRootRef.current?.focus({ preventScroll: true }));
    return () => {
      document.body.classList.remove('t8-garden-defense-stage-open');
      window.removeEventListener('resize', updateStageScale);
      window.cancelAnimationFrame(focusFrame);
    };
  }, [active, isStageMode]);

  useEffect(() => {
    if (!active || !isStageMode || typeof window === 'undefined') return;
    const handleStageKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (overlay !== 'none') {
        setOverlay('none');
        return;
      }
      setIsStageMode(false);
      setHovered(false);
    };
    window.addEventListener('keydown', handleStageKeyDown, true);
    return () => window.removeEventListener('keydown', handleStageKeyDown, true);
  }, [active, isStageMode, overlay]);

  useEffect(() => {
    if (!collapsed) setHasOpenedPanel(true);
  }, [collapsed]);

  useEffect(() => {
    if (previousCanvasIdRef.current === canvasId) return;
    saveGardenRun(previousCanvasIdRef.current, run);
    previousCanvasIdRef.current = canvasId;
    const nextProfile = loadGardenProfile();
    setProfile(nextProfile);
    setRun(loadGardenRun(canvasId, nextUnlockedStage(nextProfile).id));
    processedCombatEffectIdsRef.current.clear();
    setOverlay('none');
    setFeedback('已载入该画布的庭院防线。');
  }, [canvasId, run]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => saveGardenRun(canvasId, run), 420);
    return () => window.clearTimeout(timer);
  }, [active, canvasId, run]);

  useEffect(() => {
    if (!active || typeof document === 'undefined' || typeof window === 'undefined') return;
    const syncWindowReady = () => {
      setWindowReady(document.visibilityState === 'visible' && document.hasFocus());
    };
    syncWindowReady();
    document.addEventListener('visibilitychange', syncWindowReady);
    window.addEventListener('focus', syncWindowReady);
    window.addEventListener('blur', syncWindowReady);
    return () => {
      document.removeEventListener('visibilitychange', syncWindowReady);
      window.removeEventListener('focus', syncWindowReady);
      window.removeEventListener('blur', syncWindowReady);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    if (activeAutoPauseReason) {
      if (run.status === 'running') {
        autoPausedRef.current = true;
        setAutoPauseReason(activeAutoPauseReason);
        setRun((current) => current.status === 'running' ? pauseGardenRun(current) : current);
      } else if (autoPausedRef.current) {
        setAutoPauseReason(activeAutoPauseReason);
      }
      return;
    }
    if (!autoPausedRef.current || run.status !== 'paused') return;
    autoPausedRef.current = false;
    setAutoPauseReason(null);
    setRun((current) => current.status === 'paused' ? startGardenRun(current) : current);
  }, [active, activeAutoPauseReason, run.status]);

  useEffect(() => {
    if (!active || run.status !== 'running' || interactionLocked) return;
    let frameId = 0;
    let previous = performance.now();
    let accumulator = 0;
    const frame = (now: number) => {
      const elapsed = Math.min(250, Math.max(0, now - previous));
      previous = now;
      accumulator += elapsed;
      const steps = Math.floor(accumulator / SIMULATION_STEP_MS);
      if (steps > 0) {
        accumulator -= steps * SIMULATION_STEP_MS;
        setRun((current) => stepGardenRun(current, steps * SIMULATION_STEP_MS, profileRef.current));
      }
      frameId = window.requestAnimationFrame(frame);
    };
    frameId = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(frameId);
  }, [active, interactionLocked, run.status]);

  useEffect(() => {
    if (run.status !== 'won' || run.rewardClaimed) return;
    setProfile((current) => applyGardenVictory(current, run));
    setRun((current) => current.runId === run.runId ? { ...current, rewardClaimed: true } : current);
    playGardenSound('win', profileRef.current.soundEnabled);
    setFeedback(`通关 ${stage.name}，获得 ${stage.rewardLeaves} 枚叶章。`);
  }, [run, stage.name, stage.rewardLeaves]);

  useEffect(() => {
    const discovered = new Set(profile.discoveredZombies);
    let changed = false;
    run.zombies.forEach((zombie) => {
      if (!discovered.has(zombie.zombieId)) {
        discovered.add(zombie.zombieId);
        changed = true;
      }
    });
    if (changed) setProfile((current) => ({ ...current, discoveredZombies: [...discovered] }));
  }, [profile.discoveredZombies, run.zombies]);

  useEffect(() => {
    const event = run.events[0];
    if (!event || event.id === previousEventIdRef.current) return;
    previousEventIdRef.current = event.id;
    if (event.tone === 'boss') playGardenSound('wave', profile.soundEnabled);
    if (event.title.includes('第 ') && event.title.includes('波')) playGardenSound('wave', profile.soundEnabled);
    if (run.status === 'lost') playGardenSound('lose', profile.soundEnabled);
  }, [profile.soundEnabled, run.events, run.status]);

  useEffect(() => {
    if (processedCombatRunIdRef.current === run.runId) return;
    processedCombatRunIdRef.current = run.runId;
    processedCombatEffectIdsRef.current.clear();
    previousEventIdRef.current = run.events[0]?.id || null;
  }, [run.runId]);

  useEffect(() => {
    const processed = processedCombatEffectIdsRef.current;
    const freshEffects = run.effects.filter((effect) => !processed.has(effect.id));
    if (freshEffects.length === 0) return;
    const cueForEffect = (effect: GardenCombatEffect) => {
      if (effect.kind === 'sun-collected') return 'sun' as const;
      if (effect.kind === 'projectile-fired') {
        return effect.variant === 'frost' ? 'frost-shot' as const : effect.variant === 'ember' ? 'ember-shot' as const : 'seed-shot' as const;
      }
      if (effect.kind === 'projectile-hit') {
        return effect.variant === 'frost' ? 'frost-hit' as const : effect.variant === 'ember' ? 'ember-hit' as const : 'seed-hit' as const;
      }
      if (effect.kind === 'chain-hit') return 'chain-hit' as const;
      if (effect.kind === 'chrono-hit') return 'chrono-hit' as const;
      if (effect.kind === 'zombie-bite') return 'bite' as const;
      if (effect.kind === 'boss-strike') return 'boss-hit' as const;
      return 'mower' as const;
    };
    freshEffects.forEach((effect) => {
      processed.add(effect.id);
      playGardenSound(cueForEffect(effect), profile.soundEnabled, {
        pan: effect.x / GAME_WIDTH * 2 - 1,
        intensity: effect.intensity,
      });
    });
    if (processed.size > 180) {
      const liveIds = new Set(run.effects.map((effect) => effect.id));
      processed.forEach((id) => { if (!liveIds.has(id)) processed.delete(id); });
    }
  }, [profile.soundEnabled, run.effects]);

  const handleCellClick = useCallback((row: number, column: number) => {
    unlockGardenSound(profileRef.current.soundEnabled);
    setRun((current) => {
      const result = shovelActive
        ? removeGardenPlant(current, row, column)
        : placeGardenPlant(current, selectedPlant, row, column, profileRef.current);
      setFeedback(result.error || (shovelActive ? '植物已移栽，返还少量阳光。' : `${GARDEN_PLANTS[selectedPlant].name} 已加入防线。`));
      if (result.changed) playGardenSound('plant', profileRef.current.soundEnabled);
      return result.state;
    });
  }, [selectedPlant, shovelActive]);

  const handleCollectSun = useCallback((sunId: string) => {
    unlockGardenSound(profileRef.current.soundEnabled);
    setRun((current) => {
      const result = collectGardenSun(current, sunId);
      if (result.changed) setSunPulseKey((value) => value + 1);
      return result.state;
    });
  }, []);

  const handleToggleRun = useCallback(() => {
    unlockGardenSound(profileRef.current.soundEnabled);
    autoPausedRef.current = false;
    setAutoPauseReason(null);
    setRun((current) => current.status === 'running' ? pauseGardenRun(current) : startGardenRun(current));
  }, []);

  const handleRestart = useCallback(() => {
    autoPausedRef.current = false;
    setAutoPauseReason(null);
    const next = createGardenRun({ stageId: run.stageId, profile: profileRef.current });
    setRun(next);
    setFeedback('防线已重置，重新布置后开始战斗。');
    setOverlay('none');
  }, [run.stageId]);

  const selectStage = useCallback((stageId: string) => {
    const nextStage = getGardenStage(stageId);
    if (!stageIsUnlocked(nextStage.number, profileRef.current)) {
      setFeedback('先完成上一关，才能解锁这片庭院。');
      return;
    }
    setRun(createGardenRun({ stageId, profile: profileRef.current }));
    setOverlay('none');
    setFeedback(`已选择 ${nextStage.name}，布置完成后开始。`);
  }, []);

  const handleUpgrade = useCallback((plantId: GardenPlantId) => {
    setProfile((current) => {
      const result = upgradeGardenPlant(current, plantId);
      setFeedback(result.error || `${GARDEN_PLANTS[plantId].name} 已升级。`);
      if (result.changed) playGardenSound('upgrade', current.soundEnabled);
      return result.profile;
    });
  }, []);

  const handleToggleStageMode = useCallback(() => {
    setCollapsed(false);
    setHasOpenedPanel(true);
    setHovered(!isStageMode);
    setIsStageMode(!isStageMode);
  }, [isStageMode]);

  if (!active) return null;

  const panelMarkup = (
    <div
      ref={panelRootRef}
      className={`t8-garden-defense-panel nodrag nopan${collapsed ? ' is-collapsed' : ' is-expanded'}${hovered ? ' is-hovered' : ''}${isStageMode ? ' is-stage-mode' : ''}`}
      style={gardenPanelStyle(stageScale)}
      data-canvas-floating-ui="garden-defense-panel"
      data-garden-panel-state={collapsed && !isStageMode ? 'hidden' : isStageMode ? 'stage' : 'visible'}
      data-garden-stage-mode={isStageMode ? 'true' : 'false'}
      onPointerDownCapture={stopGardenCanvasGesture}
      onPointerMoveCapture={stopGardenCanvasGesture}
      onPointerUpCapture={stopGardenCanvasGesture}
      onPointerCancelCapture={stopGardenCanvasGesture}
      onMouseDownCapture={stopGardenCanvasGesture}
      onMouseMoveCapture={stopGardenCanvasGesture}
      onMouseUpCapture={stopGardenCanvasGesture}
      onClickCapture={stopGardenCanvasGesture}
      onDoubleClickCapture={stopGardenCanvasGesture}
      onWheelCapture={stopGardenCanvasGesture}
      onContextMenuCapture={stopGardenCanvasGesture}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      tabIndex={isStageMode ? 0 : -1}
    >
      <button
        type="button"
        className="t8-garden-defense-panel__toggle t8-toolbar-button"
        aria-controls="t8-garden-defense-battle-panel"
        aria-expanded={!collapsed}
        aria-pressed={!collapsed}
        title={collapsed ? '显示庭院守卫' : '隐藏庭院守卫'}
        onClick={() => setCollapsed((value) => !value)}
      >
        <Leaf size={15} />
        <span>庭院守卫</span>
        <small>{collapsed ? '显示' : run.status === 'running' ? '战斗中' : run.status === 'paused' ? '已暂停' : `第${stage.number}关`}</small>
      </button>

      {(hasOpenedPanel || isStageMode) && (
        <div
          id="t8-garden-defense-battle-panel"
          className="t8-garden-defense-panel__popover"
          hidden={collapsed && !isStageMode}
          aria-hidden={collapsed && !isStageMode}
        >
          <div className="t8-garden-defense-panel__viewport">
        <section
          className="t8-garden-defense-world nodrag nopan nowheel"
          data-garden-defense-status={run.status}
          data-garden-defense-overlay={overlay}
          data-garden-defense-stage={stage.id}
          data-garden-reduced-motion={profile.reducedMotion ? 'true' : 'false'}
          data-garden-interaction-locked={interactionLocked ? 'true' : 'false'}
          data-garden-auto-pause-reason={autoPauseReason || undefined}
          aria-label="庭院守卫任务栏战场"
        >
          <Suspense fallback={<div className="t8-garden-defense-stage-loading">正在唤醒庭院守卫...</div>}>
            <GardenDefenseStage
              state={run}
              selectedPlant={selectedPlant}
              shovelActive={shovelActive}
              reducedMotion={profile.reducedMotion}
              interactionLocked={interactionLocked || run.status === 'won' || run.status === 'lost'}
              onCellClick={handleCellClick}
              onCollectSun={handleCollectSun}
            />
          </Suspense>

          <header className="t8-garden-defense-hud" data-garden-defense-ui="hud">
            <div className="t8-garden-defense-brand">
              <span className="t8-garden-defense-brand__mark"><Leaf size={20} /></span>
              <span><b>庭院守卫</b><small>{stage.subtitle}</small></span>
            </div>
            <div
              key={`garden-sun-${sunPulseKey}`}
              className={`t8-garden-defense-sun${sunPulseKey > 0 ? ' is-collecting' : ''}`}
              data-garden-sun-pulse={sunPulseKey}
              aria-label={`当前阳光 ${run.sun}`}
            >
              <img src={GARDEN_UI_ASSETS.sunMedallion} alt="" />
              <span><b>{run.sun}</b><small>阳光</small></span>
            </div>
            <div className="t8-garden-defense-wave">
              <span><b>第 {run.wave} 波</b><small>{stage.name}</small></span>
              <div className="t8-garden-defense-wave__track"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            </div>
            <div className="t8-garden-defense-rank">
              <span><Trophy size={16} /> RANK {profile.rank}</span>
              <span><img src={GARDEN_UI_ASSETS.upgradeLeaf} alt="" /> {profile.leafTokens} 叶章</span>
            </div>
            <nav className="t8-garden-defense-actions" aria-label="庭院守卫控制">
              <button type="button" onClick={handleToggleRun} title={run.status === 'running' ? '暂停' : '开始'}>
                {run.status === 'running' ? <CirclePause size={20} /> : <CirclePlay size={20} />}
              </button>
              <button type="button" onClick={handleRestart} title="重新开始"><RotateCcw size={18} /></button>
              <button type="button" onClick={() => setOverlay('stages')} title="关卡地图"><Map size={18} /></button>
              <button type="button" onClick={() => setOverlay('upgrades')} title="植物升级"><Sparkles size={18} /></button>
              <button type="button" onClick={() => setOverlay('almanac')} title="庭院图鉴"><BookOpen size={18} /></button>
              <button
                type="button"
                aria-pressed={profile.reducedMotion}
                onClick={() => setProfile((current) => ({ ...current, reducedMotion: !current.reducedMotion }))}
                title={profile.reducedMotion ? '开启完整战斗动效' : '减少战斗动态效果'}
              >
                <Wind size={18} />
              </button>
              <button
                type="button"
                onClick={() => setProfile((current) => {
                  const soundEnabled = !current.soundEnabled;
                  if (soundEnabled) unlockGardenSound(true);
                  return { ...current, soundEnabled };
                })}
                title={profile.soundEnabled ? '关闭游戏音效' : '开启游戏音效'}
              >
                {profile.soundEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
              </button>
              <button
                type="button"
                className="t8-garden-defense-stage-toggle"
                aria-pressed={isStageMode}
                onClick={handleToggleStageMode}
                title={isStageMode ? '退出沉浸大屏' : '沉浸大屏游玩'}
              >
                {isStageMode ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
              </button>
            </nav>
          </header>

          <aside className="t8-garden-defense-seed-tray" aria-label="植物卡牌">
            <div className="t8-garden-defense-seed-tray__title"><Swords size={15} /><span>植物小队</span></div>
            <div className="t8-garden-defense-seed-grid">
              {GARDEN_PLANT_ORDER.map((plantId, index) => {
                const definition = GARDEN_PLANTS[plantId];
                const unlocked = profile.unlockedPlants.includes(plantId);
                const cooldown = formatCooldown(run.cooldowns[plantId], definition.cooldownMs);
                const selected = !shovelActive && selectedPlant === plantId;
                return (
                  <button
                    key={plantId}
                    type="button"
                    className={selected ? 'is-selected' : ''}
                    disabled={!unlocked}
                    data-plant-role={definition.role}
                    onClick={() => { setSelectedPlant(plantId); setShovelActive(false); setFeedback(`${index + 1}. ${definition.name}：${definition.description}`); }}
                    title={unlocked ? `${definition.name} · ${definition.cost} 阳光` : `第 ${definition.unlockStage} 关解锁`}
                  >
                    <img src={GARDEN_PLANT_ASSETS[plantId]} alt="" />
                    <span><b>{definition.name}</b><small>{definition.cost}</small></span>
                    {!unlocked && <span className="t8-garden-defense-card-lock"><LockKeyhole size={13} /></span>}
                    {cooldown > 0 && <i className="t8-garden-defense-card-cooldown" style={{ height: `${Math.round(cooldown * 100)}%` }} />}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className={`t8-garden-defense-shovel${shovelActive ? ' is-active' : ''}`}
              onClick={() => { setShovelActive((value) => !value); setFeedback(shovelActive ? '已切回植物部署。' : '铲子已选中：点击植物将其移栽。'); }}
            >
              <img src={GARDEN_UI_ASSETS.shovel} alt="" /><span><b>移栽铲</b><small>返还 20% 阳光</small></span>
            </button>
          </aside>

          <div className="t8-garden-defense-feedback" role="status" aria-live="polite">
            <span>{feedback}</span>
            {autoPauseReason && <b>{autoPauseReason}</b>}
            {!autoPauseReason && overlay !== 'none' && run.status === 'running' && <b>功能面板打开，战斗已临时冻结</b>}
          </div>

          {run.status === 'paused' && overlay === 'none' && (
            <div className="t8-garden-defense-pause-banner" role="status">
              <img src={GARDEN_UI_ASSETS.pausePlate} alt="" />
              <span><b>战斗暂停</b><small>{autoPauseReason || '可以调整植物选择，准备好后继续。'}</small></span>
            </div>
          )}

          {run.status === 'ready' && overlay === 'none' && (
            <div className="t8-garden-defense-start-card">
              <span className="t8-garden-defense-start-card__eyebrow">STAGE {String(stage.number).padStart(2, '0')}</span>
              <h2>{stage.name}</h2>
              <p>{stage.subtitle}。共 {stage.totalWaves} 波，初始阳光 {stage.startingSun}。</p>
              <div><span><Shield size={16} /> 5 条清道器防线</span><span><Leaf size={16} /> 首胜奖励 {stage.rewardLeaves + 1}</span></div>
              <button type="button" onClick={handleToggleRun}><CirclePlay size={20} /> 开始防守</button>
            </div>
          )}

          {(run.status === 'won' || run.status === 'lost') && overlay === 'none' && (
            <div className={`t8-garden-defense-result is-${run.status}`}>
              <span>{run.status === 'won' ? <Trophy size={34} /> : <Shield size={34} />}</span>
              <h2>{getStageResultTitle(run)}</h2>
              <p>击退 {run.stats.defeated} · 收集 {run.stats.sunCollected} 阳光 · 损失 {run.stats.plantsLost} 株植物</p>
              <div>
                <button type="button" onClick={handleRestart}><RotateCcw size={17} /> 再战一次</button>
                <button type="button" onClick={() => setOverlay('stages')}><Map size={17} /> 选择关卡</button>
              </div>
            </div>
          )}

          {overlay !== 'none' && (
            <div className="t8-garden-defense-overlay" role="dialog" aria-modal="true" aria-label="庭院守卫功能面板">
              <div className="t8-garden-defense-overlay__panel">
                <header>
                  <span>
                    {overlay === 'stages' && <Map size={21} />}
                    {overlay === 'upgrades' && <Sparkles size={21} />}
                    {overlay === 'almanac' && <BookOpen size={21} />}
                    <b>{overlay === 'stages' ? '庭院地图' : overlay === 'upgrades' ? '植物培育室' : '庭院图鉴'}</b>
                  </span>
                  <button type="button" onClick={() => setOverlay('none')} title="关闭"><X size={19} /></button>
                </header>

                {overlay === 'stages' && (
                  <div className="t8-garden-defense-stage-map">
                    {GARDEN_STAGES.map((item) => {
                      const unlocked = stageIsUnlocked(item.number, profile);
                      const completed = profile.completedStages.includes(item.id);
                      return (
                        <button key={item.id} type="button" disabled={!unlocked} className={item.id === stage.id ? 'is-current' : ''} onClick={() => selectStage(item.id)}>
                          <span>{completed ? <Trophy size={15} /> : unlocked ? String(item.number).padStart(2, '0') : <LockKeyhole size={15} />}</span>
                          <b>{item.name}</b>
                          <small>{item.totalWaves} 波 · 难度 {item.difficulty.toFixed(1)}</small>
                          <ChevronRight size={15} />
                        </button>
                      );
                    })}
                  </div>
                )}

                {overlay === 'upgrades' && (
                  <div className="t8-garden-defense-upgrade-grid">
                    {GARDEN_PLANT_ORDER.map((plantId) => {
                      const definition = GARDEN_PLANTS[plantId];
                      const unlocked = profile.unlockedPlants.includes(plantId);
                      const level = profile.plantUpgrades[plantId] || 0;
                      const cost = gardenUpgradeCost(plantId, level);
                      return (
                        <article key={plantId} className={!unlocked ? 'is-locked' : ''}>
                          <img src={GARDEN_PLANT_ASSETS[plantId]} alt="" />
                          <span><b>{definition.name}</b><small>Lv.{level} / 5 · {definition.role}</small></span>
                          <p>{definition.upgradeBlurb}</p>
                          <div>{Array.from({ length: 5 }, (_, index) => <i key={index} className={index < level ? 'is-filled' : ''} />)}</div>
                          <button type="button" disabled={!unlocked || level >= 5} onClick={() => handleUpgrade(plantId)}>
                            {unlocked ? level >= 5 ? '已满级' : <><Leaf size={14} /> {cost} 叶章升级</> : `第 ${definition.unlockStage} 关解锁`}
                          </button>
                        </article>
                      );
                    })}
                  </div>
                )}

                {overlay === 'almanac' && (
                  <div className="t8-garden-defense-almanac">
                    <section>
                      <h3><Leaf size={17} /> 植物档案</h3>
                      <div>
                        {GARDEN_PLANT_ORDER.map((plantId) => {
                          const item = GARDEN_PLANTS[plantId];
                          const unlocked = profile.unlockedPlants.includes(plantId);
                          return <article key={plantId} className={!unlocked ? 'is-unknown' : ''}><img src={GARDEN_PLANT_ASSETS[plantId]} alt="" /><span><b>{unlocked ? item.name : '未知植物'}</b><small>{unlocked ? item.description : `第 ${item.unlockStage} 关发现`}</small></span></article>;
                        })}
                      </div>
                    </section>
                    <section>
                      <h3><Gauge size={17} /> 入侵者档案</h3>
                      <div>
                        {GARDEN_ZOMBIE_ORDER.map((zombieId) => {
                          const item = GARDEN_ZOMBIES[zombieId];
                          const discovered = profile.discoveredZombies.includes(zombieId);
                          return <article key={zombieId} className={!discovered ? 'is-unknown' : ''}><img src={GARDEN_ZOMBIE_ASSETS[zombieId]} alt="" /><span><b>{discovered ? item.name : '未知入侵者'}</b><small>{discovered ? item.description : '在战斗中首次遭遇后解锁'}</small></span></article>;
                        })}
                      </div>
                    </section>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
          </div>
        </div>
      )}
    </div>
  );

  return isStageMode && typeof document !== 'undefined'
    ? createPortal(panelMarkup, document.body)
    : panelMarkup;
}
