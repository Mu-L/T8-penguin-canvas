import type { ThemeMusic, ThemeTemplate } from './types';

export const GARDEN_THEME_MUSIC_AUTOPLAY_EVENT = 't8:garden-theme-music-autoplay';

export interface GardenThemeMusicAutoplayDetail {
  templateId: string;
  music?: ThemeMusic;
}

export function requestGardenThemeMusicAutoplay(template: ThemeTemplate): boolean {
  if (typeof window === 'undefined' || template.visuals?.style !== 'garden-defense') return false;

  window.dispatchEvent(new CustomEvent<GardenThemeMusicAutoplayDetail>(GARDEN_THEME_MUSIC_AUTOPLAY_EVENT, {
    detail: {
      templateId: template.id,
      music: template.music ? { ...template.music } : undefined,
    },
  }));
  return true;
}
