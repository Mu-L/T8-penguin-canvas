import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import {
  GARDEN_CELL_HEIGHT,
  GARDEN_CELL_WIDTH,
  GARDEN_COLUMNS,
  GARDEN_FIELD_HEIGHT,
  GARDEN_FIELD_WIDTH,
  GARDEN_FIELD_X,
  GARDEN_FIELD_Y,
  GARDEN_ROWS,
  type GardenCombatEffect,
  type GardenPlantId,
  type GardenRunState,
} from './types.ts';
import { gardenCellFromPoint } from './engine.ts';
import { GARDEN_BATTLEFIELD_ASSET, GARDEN_PLANT_ASSETS, GARDEN_UI_ASSETS, GARDEN_ZOMBIE_ASSETS } from './assets.ts';

interface GardenDefenseStageProps {
  state: GardenRunState;
  selectedPlant: GardenPlantId;
  shovelActive: boolean;
  reducedMotion: boolean;
  interactionLocked?: boolean;
  onCellClick: (row: number, column: number) => void;
  onCollectSun: (sunId: string) => void;
}

interface GardenStageBridge {
  props: GardenDefenseStageProps;
  scene?: GardenDefenseScene;
}

const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;
const SUN_HUD_X = 323;
const SUN_HUD_Y = 62;

class GardenDefenseScene extends Phaser.Scene {
  private bridge: GardenStageBridge;
  private plantSprites = new Map<string, Phaser.GameObjects.Image>();
  private zombieSprites = new Map<string, Phaser.GameObjects.Image>();
  private projectileSprites = new Map<string, Phaser.GameObjects.Arc>();
  private sunSprites = new Map<string, Phaser.GameObjects.Image>();
  private mowerSprites = new Map<number, Phaser.GameObjects.Image>();
  private processedEffectIds = new Set<string>();
  private activeRunId = '';
  private healthGraphics?: Phaser.GameObjects.Graphics;
  private selectionGraphics?: Phaser.GameObjects.Graphics;
  private nightOverlay?: Phaser.GameObjects.Rectangle;
  private hoveredCell: { row: number; column: number } | null = null;

  constructor(bridge: GardenStageBridge) {
    super({ key: 'garden-defense-main' });
    this.bridge = bridge;
  }

  preload() {
    this.load.image('garden-background', GARDEN_BATTLEFIELD_ASSET);
    Object.entries(GARDEN_PLANT_ASSETS).forEach(([id, url]) => this.load.image(`plant-${id}`, url));
    Object.entries(GARDEN_ZOMBIE_ASSETS).forEach(([id, url]) => this.load.image(`zombie-${id}`, url));
    this.load.image('garden-sun', GARDEN_UI_ASSETS.sunMedallion);
    this.load.image('garden-mower', GARDEN_UI_ASSETS.shovel);
  }

  create() {
    this.add.image(0, 0, 'garden-background').setOrigin(0).setDisplaySize(GAME_WIDTH, GAME_HEIGHT);
    this.nightOverlay = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x071d3c, 0).setOrigin(0).setDepth(2);
    const grid = this.add.graphics().setDepth(3);
    grid.lineStyle(1.5, 0xf7f2b6, 0.18);
    for (let column = 0; column <= GARDEN_COLUMNS; column += 1) {
      const x = GARDEN_FIELD_X + column * GARDEN_CELL_WIDTH;
      grid.lineBetween(x, GARDEN_FIELD_Y, x, GARDEN_FIELD_Y + GARDEN_FIELD_HEIGHT);
    }
    for (let row = 0; row <= GARDEN_ROWS; row += 1) {
      const y = GARDEN_FIELD_Y + row * GARDEN_CELL_HEIGHT;
      grid.lineBetween(GARDEN_FIELD_X, y, GARDEN_FIELD_X + GARDEN_FIELD_WIDTH, y);
    }
    this.selectionGraphics = this.add.graphics().setDepth(10);
    this.healthGraphics = this.add.graphics().setDepth(31);
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      const point = this.gamePoint(pointer);
      this.hoveredCell = gardenCellFromPoint(point.x, point.y);
      this.drawSelection();
    });
    this.input.on('pointerout', () => {
      this.hoveredCell = null;
      this.drawSelection();
    });
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      const point = this.gamePoint(pointer);
      this.game.canvas.dataset.gardenLastPointer = `${Math.round(point.x)},${Math.round(point.y)}`;
      this.game.canvas.dataset.gardenLastRawPointer = `${Math.round(pointer.x)},${Math.round(pointer.y)}`;
      this.game.canvas.dataset.gardenPointerLocked = this.bridge.props.interactionLocked ? 'true' : 'false';
      if (this.bridge.props.interactionLocked) return;
      const hitSun = Array.from(this.sunSprites.values()).find((sprite) => {
        if (!sprite.visible) return false;
        const bounds = sprite.getBounds();
        return point.x >= bounds.x
          && point.x <= bounds.x + bounds.width
          && point.y >= bounds.y
          && point.y <= bounds.y + bounds.height;
      });
      const hitSunId = hitSun?.getData('garden-sun-id');
      this.game.canvas.dataset.gardenLastHitSun = typeof hitSunId === 'string' ? hitSunId : '';
      if (typeof hitSunId === 'string') {
        if (hitSun?.getData('garden-sun-collecting')) return;
        hitSun?.setData('garden-sun-collecting', true).disableInteractive();
        this.bridge.props.onCollectSun(hitSunId);
        return;
      }
      const cell = gardenCellFromPoint(point.x, point.y);
      if (cell) this.bridge.props.onCellClick(cell.row, cell.column);
    });
    this.bridge.scene = this;
    this.activeRunId = this.bridge.props.state.runId;
    this.bridge.props.state.effects.forEach((effect) => this.processedEffectIds.add(effect.id));
    this.sync(this.bridge.props.state);
    this.game.canvas.dataset.gardenSceneReady = 'true';
  }

  private gamePoint(pointer: Phaser.Input.Pointer) {
    const event = pointer.event as PointerEvent | MouseEvent | undefined;
    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    const rect = this.game.canvas.getBoundingClientRect();
    if (Number.isFinite(clientX) && Number.isFinite(clientY) && rect.width > 0 && rect.height > 0) {
      return {
        x: (clientX - rect.left) * GAME_WIDTH / rect.width,
        y: (clientY - rect.top) * GAME_HEIGHT / rect.height,
      };
    }
    return { x: pointer.x, y: pointer.y };
  }

  private drawSelection() {
    const graphics = this.selectionGraphics;
    if (!graphics) return;
    graphics.clear();
    if (!this.hoveredCell || this.bridge.props.interactionLocked) return;
    const { row, column } = this.hoveredCell;
    const occupied = this.bridge.props.state.plants.some((plant) => plant.row === row && plant.column === column);
    const shovel = this.bridge.props.shovelActive;
    const color = shovel ? 0xffd36a : occupied ? 0xe75b45 : 0xb9ff6a;
    graphics.fillStyle(color, 0.18);
    graphics.lineStyle(3, color, 0.92);
    graphics.fillRoundedRect(
      GARDEN_FIELD_X + column * GARDEN_CELL_WIDTH + 4,
      GARDEN_FIELD_Y + row * GARDEN_CELL_HEIGHT + 4,
      GARDEN_CELL_WIDTH - 8,
      GARDEN_CELL_HEIGHT - 8,
      12,
    );
    graphics.strokeRoundedRect(
      GARDEN_FIELD_X + column * GARDEN_CELL_WIDTH + 4,
      GARDEN_FIELD_Y + row * GARDEN_CELL_HEIGHT + 4,
      GARDEN_CELL_WIDTH - 8,
      GARDEN_CELL_HEIGHT - 8,
      12,
    );
  }

  sync(state: GardenRunState) {
    if (!this.sys.isActive()) return;
    if (this.activeRunId !== state.runId) {
      this.activeRunId = state.runId;
      this.processedEffectIds.clear();
    }
    const isNight = state.stageId === 'garden-10' || state.stageId === 'garden-11' || state.stageId === 'garden-12' || state.stageId === 'garden-14';
    this.nightOverlay?.setAlpha(isNight ? 0.17 : 0);
    this.syncPlants(state);
    this.syncZombies(state);
    this.syncProjectiles(state);
    this.syncSuns(state);
    this.syncMowers(state);
    this.drawHealth(state);
    this.drawSelection();
    this.syncEffects(state);
  }

  private syncEffects(state: GardenRunState) {
    state.effects.forEach((effect) => {
      if (this.processedEffectIds.has(effect.id)) return;
      this.processedEffectIds.add(effect.id);
      this.playEffect(effect);
    });
    if (this.processedEffectIds.size > 180) {
      const liveIds = new Set(state.effects.map((effect) => effect.id));
      this.processedEffectIds.forEach((id) => { if (!liveIds.has(id)) this.processedEffectIds.delete(id); });
    }
  }

  private playEffect(effect: GardenCombatEffect) {
    if (effect.kind === 'sun-collected') {
      this.playSunCollection(effect);
      return;
    }
    if (effect.kind === 'projectile-fired') {
      const color = effect.variant === 'frost' ? 0x9beaff : effect.variant === 'ember' ? 0xff8a3d : 0x8de05c;
      this.playImpact(effect.x, effect.y, color, 13, 0.55);
      return;
    }
    if (effect.kind === 'projectile-hit') {
      const color = effect.variant === 'frost' ? 0xb8f3ff : effect.variant === 'ember' ? 0xff6b35 : 0x9fe46b;
      this.playImpact(effect.x, effect.y, color, effect.variant === 'ember' ? 52 : 26, effect.intensity || 1);
      return;
    }
    if (effect.kind === 'chain-hit') {
      this.playChain(effect);
      return;
    }
    if (effect.kind === 'chrono-hit') {
      this.playImpact(effect.x, effect.y, 0xc59cff, 62, effect.intensity || 1);
      return;
    }
    if (effect.kind === 'zombie-bite') {
      const target = effect.entityId ? this.plantSprites.get(effect.entityId) : null;
      if (target && !this.bridge.props.reducedMotion) {
        this.tweens.add({ targets: target, x: target.x - 7, duration: 45, yoyo: true, repeat: 2, ease: 'Sine.inOut' });
      }
      this.playImpact(effect.x, effect.y, 0xe8cf8b, 22, 0.8);
      return;
    }
    if (effect.kind === 'boss-strike') {
      if (!this.bridge.props.reducedMotion) this.cameras.main.shake(150, 0.0045);
      this.playImpact(effect.x, effect.y, 0xd98551, 86, 1.45);
      return;
    }
    this.playMowerTrail(effect);
  }

  private playSunCollection(effect: GardenCombatEffect) {
    const reduced = this.bridge.props.reducedMotion;
    const sun = this.add.image(effect.x, effect.y, 'garden-sun').setDisplaySize(58, 58).setDepth(78);
    const baseScaleX = sun.scaleX;
    const baseScaleY = sun.scaleY;
    const valueText = this.add.text(effect.x, effect.y - 42, `+${effect.value || 0}`, {
      color: '#fff4a4',
      fontFamily: 'Arial, sans-serif',
      fontSize: '22px',
      fontStyle: 'bold',
      stroke: '#4b3018',
      strokeThickness: 5,
    }).setOrigin(0.5).setDepth(79);
    this.tweens.add({ targets: valueText, y: valueText.y - (reduced ? 18 : 42), alpha: 0, duration: reduced ? 180 : 520, ease: 'Cubic.Out', onComplete: () => valueText.destroy() });

    const sparkCount = reduced ? 2 : 8;
    for (let index = 0; index < sparkCount; index += 1) {
      const angle = index / sparkCount * Math.PI * 2;
      const spark = this.add.circle(effect.x, effect.y, index % 3 === 0 ? 5 : 3, index % 2 ? 0xffd84f : 0xfff2a6, 0.92).setDepth(77);
      this.tweens.add({
        targets: spark,
        x: effect.x + Math.cos(angle) * (reduced ? 18 : 38),
        y: effect.y + Math.sin(angle) * (reduced ? 14 : 30),
        scale: 0.2,
        alpha: 0,
        delay: index * (reduced ? 5 : 18),
        duration: reduced ? 150 : 360,
        ease: 'Cubic.Out',
        onComplete: () => spark.destroy(),
      });
    }

    if (reduced) {
      this.tweens.add({ targets: sun, x: SUN_HUD_X, y: SUN_HUD_Y, alpha: 0, duration: 180, ease: 'Quad.Out', onComplete: () => sun.destroy() });
      return;
    }

    const curve = new Phaser.Curves.QuadraticBezier(
      new Phaser.Math.Vector2(effect.x, effect.y),
      new Phaser.Math.Vector2((effect.x + SUN_HUD_X) / 2, Math.min(effect.y, SUN_HUD_Y) - 120),
      new Phaser.Math.Vector2(SUN_HUD_X, SUN_HUD_Y),
    );
    this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 460,
      ease: 'Cubic.InOut',
      onUpdate: (tween) => {
        const progress = tween.getValue() || 0;
        const point = curve.getPoint(progress);
        const pop = 1 + Math.sin(progress * Math.PI) * 0.22;
        const shrink = 1 - progress * 0.48;
        sun.setPosition(point.x, point.y).setScale(baseScaleX * pop * shrink, baseScaleY * pop * shrink).setAngle(progress * 210);
      },
      onComplete: () => sun.destroy(),
    });
  }

  private playImpact(x: number, y: number, color: number, radius: number, intensity: number) {
    const reduced = this.bridge.props.reducedMotion;
    const ring = this.add.circle(x, y, 5, color, 0.18).setStrokeStyle(reduced ? 3 : 5, color, 0.95).setDepth(72);
    this.tweens.add({
      targets: ring,
      displayWidth: radius * 2 * Math.max(0.75, intensity),
      displayHeight: radius * 2 * Math.max(0.75, intensity),
      alpha: 0,
      duration: reduced ? 120 : 250,
      ease: 'Cubic.Out',
      onComplete: () => ring.destroy(),
    });
    const shardCount = reduced ? 2 : Math.max(4, Math.min(9, Math.round(5 * intensity)));
    for (let index = 0; index < shardCount; index += 1) {
      const angle = index / shardCount * Math.PI * 2 + 0.35;
      const shard = this.add.rectangle(x, y, index % 2 ? 7 : 4, 3, color, 0.94).setAngle(angle * 180 / Math.PI).setDepth(73);
      this.tweens.add({
        targets: shard,
        x: x + Math.cos(angle) * radius * (0.55 + index % 3 * 0.16),
        y: y + Math.sin(angle) * radius * (0.55 + index % 2 * 0.18),
        alpha: 0,
        scaleX: 0.3,
        duration: reduced ? 120 : 240,
        ease: 'Quad.Out',
        onComplete: () => shard.destroy(),
      });
    }
  }

  private playChain(effect: GardenCombatEffect) {
    const graphics = this.add.graphics().setDepth(74);
    graphics.lineStyle(4, 0xbff8ff, 0.95);
    const segments = this.bridge.props.reducedMotion ? 3 : 7;
    let x = effect.x - 58;
    let y = effect.y;
    graphics.beginPath().moveTo(x, y);
    for (let index = 1; index <= segments; index += 1) {
      x += 116 / segments;
      y = effect.y + (index % 2 ? -18 : 16);
      graphics.lineTo(x, y);
    }
    graphics.strokePath();
    this.tweens.add({ targets: graphics, alpha: 0, duration: this.bridge.props.reducedMotion ? 100 : 230, ease: 'Quad.Out', onComplete: () => graphics.destroy() });
    this.playImpact(effect.x, effect.y, 0x8fefff, 38, effect.intensity || 1);
  }

  private playMowerTrail(effect: GardenCombatEffect) {
    const trail = this.add.rectangle(GARDEN_FIELD_X, effect.y, 26, 16, 0xffd45f, 0.82).setOrigin(0, 0.5).setDepth(69);
    this.tweens.add({
      targets: trail,
      displayWidth: GARDEN_FIELD_WIDTH,
      alpha: 0,
      duration: this.bridge.props.reducedMotion ? 180 : 480,
      ease: 'Cubic.Out',
      onComplete: () => trail.destroy(),
    });
  }

  private syncPlants(state: GardenRunState) {
    const live = new Set(state.plants.map((plant) => plant.id));
    this.plantSprites.forEach((sprite, id) => {
      if (!live.has(id)) {
        sprite.destroy();
        this.plantSprites.delete(id);
      }
    });
    state.plants.forEach((plant) => {
      let sprite = this.plantSprites.get(plant.id);
      if (!sprite) {
        sprite = this.add.image(plant.x, plant.y + 6, `plant-${plant.plantId}`).setDepth(20 + plant.row);
        const height = plant.plantId === 'wall-root' ? 112 : plant.plantId === 'chrono-mushroom' ? 106 : 96;
        sprite.setDisplaySize(height * (sprite.width / Math.max(1, sprite.height)), height);
        if (!this.bridge.props.reducedMotion) {
          this.tweens.add({ targets: sprite, y: sprite.y - 4, duration: 820 + plant.row * 60, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
        }
        this.plantSprites.set(plant.id, sprite);
      }
      sprite.setAlpha(plant.hp < plant.maxHp * 0.25 ? 0.78 : 1);
    });
  }

  private syncZombies(state: GardenRunState) {
    const live = new Set(state.zombies.map((zombie) => zombie.id));
    this.zombieSprites.forEach((sprite, id) => {
      if (!live.has(id)) {
        sprite.destroy();
        this.zombieSprites.delete(id);
      }
    });
    state.zombies.forEach((zombie) => {
      let sprite = this.zombieSprites.get(zombie.id);
      if (!sprite) {
        sprite = this.add.image(zombie.x, zombie.y - 3, `zombie-${zombie.zombieId}`).setDepth(22 + zombie.row);
        const height = zombie.zombieId === 'compost-titan' ? 188 : zombie.zombieId === 'gatekeeper' ? 132 : 118;
        sprite.setDisplaySize(height * (sprite.width / Math.max(1, sprite.height)), height);
        if (!this.bridge.props.reducedMotion) {
          this.tweens.add({ targets: sprite, angle: { from: -1.5, to: 1.5 }, duration: 360, yoyo: true, repeat: -1, ease: 'Sine.inOut' });
        }
        this.zombieSprites.set(zombie.id, sprite);
      }
      sprite.setPosition(zombie.x, zombie.y - 3);
      sprite.setTint(zombie.slowRemainingMs > 0 ? 0xbfe9ff : zombie.tunneled ? 0x9d846b : 0xffffff);
      sprite.setAlpha(zombie.tunneled ? 0.52 : 1);
    });
  }

  private syncProjectiles(state: GardenRunState) {
    const live = new Set(state.projectiles.map((projectile) => projectile.id));
    this.projectileSprites.forEach((sprite, id) => {
      if (!live.has(id)) {
        sprite.destroy();
        this.projectileSprites.delete(id);
      }
    });
    state.projectiles.forEach((projectile) => {
      let sprite = this.projectileSprites.get(projectile.id);
      if (!sprite) {
        const color = projectile.kind === 'frost' ? 0x8feaff : projectile.kind === 'ember' ? 0xff713d : 0x67c848;
        const radius = projectile.kind === 'ember' ? 10 : 7;
        sprite = this.add.circle(projectile.x, projectile.y, radius, color, 1).setDepth(25);
        sprite.setStrokeStyle(2, 0xffffff, 0.74);
        this.projectileSprites.set(projectile.id, sprite);
      }
      sprite.setPosition(projectile.x, projectile.y);
    });
  }

  private syncSuns(state: GardenRunState) {
    const live = new Set(state.suns.map((sun) => sun.id));
    this.sunSprites.forEach((sprite, id) => {
      if (!live.has(id)) {
        sprite.destroy();
        this.sunSprites.delete(id);
      }
    });
    state.suns.forEach((sun) => {
      let sprite = this.sunSprites.get(sun.id);
      if (!sprite) {
        sprite = this.add.image(sun.x, sun.y, 'garden-sun').setDisplaySize(58, 58).setDepth(40).setInteractive({ useHandCursor: true });
        sprite.setData('garden-sun-id', sun.id);
        if (!this.bridge.props.reducedMotion) this.tweens.add({ targets: sprite, angle: { from: -5, to: 5 }, duration: 780, yoyo: true, repeat: -1 });
        this.sunSprites.set(sun.id, sprite);
      }
      sprite.setPosition(sun.x, sun.y).setAlpha(Math.max(0.28, 1 - Math.max(0, sun.ageMs - 8000) / 3500));
    });
  }

  private syncMowers(state: GardenRunState) {
    state.mowers.forEach((mower) => {
      let sprite = this.mowerSprites.get(mower.row);
      if (!sprite) {
        sprite = this.add.image(GARDEN_FIELD_X - 42, GARDEN_FIELD_Y + mower.row * GARDEN_CELL_HEIGHT + GARDEN_CELL_HEIGHT / 2, 'garden-mower')
          .setDisplaySize(34, 62)
          .setAngle(26)
          .setDepth(18 + mower.row);
        this.mowerSprites.set(mower.row, sprite);
      }
      sprite.setVisible(mower.active).setAlpha(mower.active ? 0.92 : 0);
    });
  }

  private drawHealth(state: GardenRunState) {
    const graphics = this.healthGraphics;
    if (!graphics) return;
    graphics.clear();
    const draw = (x: number, y: number, ratio: number, width: number, color: number) => {
      if (ratio >= 0.995) return;
      graphics.fillStyle(0x172114, 0.78).fillRoundedRect(x - width / 2, y, width, 6, 3);
      graphics.fillStyle(color, 0.96).fillRoundedRect(x - width / 2 + 1, y + 1, Math.max(1, (width - 2) * Math.max(0, ratio)), 4, 2);
    };
    state.plants.forEach((plant) => draw(plant.x, plant.y + 40, plant.hp / plant.maxHp, 62, 0x85d85e));
    state.zombies.forEach((zombie) => draw(zombie.x, zombie.y - (zombie.zombieId === 'compost-titan' ? 92 : 62), zombie.hp / zombie.maxHp, zombie.zombieId === 'compost-titan' ? 112 : 66, zombie.zombieId === 'compost-titan' ? 0xffb33d : 0xe95f57));
  }
}

export default function GardenDefenseStage(props: GardenDefenseStageProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bridgeRef = useRef<GardenStageBridge>({ props });
  bridgeRef.current.props = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const bridge = bridgeRef.current;
    const scene = new GardenDefenseScene(bridge);
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host,
      width: GAME_WIDTH,
      height: GAME_HEIGHT,
      transparent: false,
      backgroundColor: '#5f9b3c',
      render: { antialias: true, pixelArt: false, roundPixels: false },
      scale: { mode: Phaser.Scale.NONE, autoCenter: Phaser.Scale.NO_CENTER },
      audio: { noAudio: true },
      scene: [scene],
    });
    return () => {
      bridge.scene = undefined;
      game.destroy(true);
    };
  }, []);

  useEffect(() => {
    bridgeRef.current.scene?.sync(props.state);
  }, [props.state, props.selectedPlant, props.shovelActive, props.reducedMotion, props.interactionLocked]);

  return (
    <div
      ref={hostRef}
      className="t8-garden-defense-stage"
      data-garden-defense-renderer="phaser"
      data-garden-effect-count={props.state.effects.length}
      data-garden-last-effect={props.state.effects.at(-1)?.kind || ''}
      data-garden-effect-kinds={props.state.effects.map((effect) => effect.kind).join(',')}
      data-garden-sun-count={props.state.suns.length}
    />
  );
}
