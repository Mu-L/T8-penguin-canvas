import battlefield from '../../assets/garden-defense/garden-battlefield.png';
import sunBloom from '../../assets/garden-defense/plants/sun-bloom.png';
import peaScout from '../../assets/garden-defense/plants/pea-scout.png';
import frostBulb from '../../assets/garden-defense/plants/frost-bulb.png';
import wallRoot from '../../assets/garden-defense/plants/wall-root.png';
import emberMelon from '../../assets/garden-defense/plants/ember-melon.png';
import stormReed from '../../assets/garden-defense/plants/storm-reed.png';
import healerClover from '../../assets/garden-defense/plants/healer-clover.png';
import chronoMushroom from '../../assets/garden-defense/plants/chrono-mushroom.png';
import drifter from '../../assets/garden-defense/zombies/drifter.png';
import pothead from '../../assets/garden-defense/zombies/pothead.png';
import bucketGuard from '../../assets/garden-defense/zombies/bucket-guard.png';
import sprinter from '../../assets/garden-defense/zombies/sprinter.png';
import gatekeeper from '../../assets/garden-defense/zombies/gatekeeper.png';
import moleMiner from '../../assets/garden-defense/zombies/mole-miner.png';
import mothConductor from '../../assets/garden-defense/zombies/moth-conductor.png';
import compostTitan from '../../assets/garden-defense/zombies/compost-titan.png';
import hudBanner from '../../assets/garden-defense/ui/hud-banner.png';
import seedPacket from '../../assets/garden-defense/ui/seed-packet.png';
import sunMedallion from '../../assets/garden-defense/ui/sun-medallion.png';
import upgradeLeaf from '../../assets/garden-defense/ui/upgrade-leaf.png';
import pausePlate from '../../assets/garden-defense/ui/pause-plate.png';
import shovel from '../../assets/garden-defense/ui/shovel.png';
import progressFrame from '../../assets/garden-defense/ui/progress-frame.png';
import type { GardenPlantId, GardenZombieId } from './types.ts';

export const GARDEN_BATTLEFIELD_ASSET = battlefield;

export const GARDEN_PLANT_ASSETS: Record<GardenPlantId, string> = {
  'sun-bloom': sunBloom,
  'pea-scout': peaScout,
  'frost-bulb': frostBulb,
  'wall-root': wallRoot,
  'ember-melon': emberMelon,
  'storm-reed': stormReed,
  'healer-clover': healerClover,
  'chrono-mushroom': chronoMushroom,
};

export const GARDEN_ZOMBIE_ASSETS: Record<GardenZombieId, string> = {
  drifter,
  pothead,
  'bucket-guard': bucketGuard,
  sprinter,
  gatekeeper,
  'mole-miner': moleMiner,
  'moth-conductor': mothConductor,
  'compost-titan': compostTitan,
};

export const GARDEN_UI_ASSETS = {
  hudBanner,
  seedPacket,
  sunMedallion,
  upgradeLeaf,
  pausePlate,
  shovel,
  progressFrame,
} as const;
