export type ThemeMode = 'dark' | 'light';
export type LegacyThemeStyle = 'tech' | 'pixel';
export type ThemeVisualStyle =
  | 'plain'
  | 'tech'
  | 'pixel'
  | 'op'
  | 'rh'
  | 'naruto'
  | 'eva'
  | 'yyh'
  | 'slamdunk'
  | 'soccer-hero'
  | 'dragon-ball'
  | 'saint-seiya'
  | 'tetris'
  | 'farm-story'
  | 'garden-defense';
export type ThemeIntensity = 'subtle' | 'medium' | 'strong';
export type ThemeMusicPreset =
  | 'tech-pulse'
  | 'pixel-pop'
  | 'grand-line-adventure'
  | 'rh-pulse'
  | 'shinobi-flame'
  | 'eva-sync'
  | 'spirit-gun'
  | 'buzzer-beater'
  | 'golden-goal'
  | 'ki-burst'
  | 'shenron-aura'
  | 'pegasus-cosmos'
  | 'hades-eclipse'
  | 'block-drop'
  | 'farm-breeze'
  | 'garden-march';
export type ThemeMusicSource = 'synth' | 'url' | 'upload';

export interface ThemeTokens {
  appBg: string;
  canvasBg: string;
  panelBg: string;
  panelBgElevated: string;
  panelBgMuted: string;
  nodeBg: string;
  nodeHeaderBg: string;
  textMain: string;
  textMuted: string;
  textDim: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentHover: string;
  accentText: string;
  secondary: string;
  warning: string;
  danger: string;
  success: string;
  shadowPanel: string;
  shadowButton: string;
  shadowStrong: string;
  radiusPanel: string;
  radiusButton: string;
  radiusNode: string;
  gridDot: string;
  edge: string;
  edgeSelected: string;
  selectionBg: string;
  selectionBorder: string;
  portText: string;
  portImage: string;
  portVideo: string;
  portAudio: string;
  fontFamily: string;
  displayFont: string;
}

export interface ThemeModeDefinition {
  tokens: ThemeTokens;
}

export interface ThemeVisuals {
  style: ThemeVisualStyle;
  intensity?: ThemeIntensity;
  iconPack?: 'default' | 'op' | 'naruto' | 'eva' | 'yyh' | 'slamdunk' | 'soccer' | 'dragon-ball' | 'saint-seiya' | 'tetromino-well' | 'farm-tools' | 'garden-guard';
  canvasPattern?: 'none' | 'dots' | 'map' | 'circuit' | 'confetti' | 'hub' | 'chakra' | 'eva-grid' | 'spirit-map' | 'court' | 'pitch' | 'dragon-radar' | 'sanctuary-zodiac' | 'tetris-stack' | 'pasture-map' | 'defense-lawn';
  nodeFrame?: 'plain' | 'glass' | 'sticker' | 'wanted' | 'hub-card' | 'shinobi-scroll' | 'eva-panel' | 'spirit-case' | 'scoreboard-card' | 'match-card' | 'capsule-card' | 'cloth-box-card' | 'arcade-cabinet-card' | 'farm-sign-card' | 'garden-card';
  headerMark?: string;
}

export interface ThemeMusic {
  title: string;
  preset: ThemeMusicPreset;
  source?: ThemeMusicSource;
  url?: string;
  hiddenTitle?: string;
  hiddenUrl?: string;
  hiddenVolume?: number;
  volume?: number;
  bpm?: number;
  copyrightNote?: string;
}

export interface ThemeTemplate {
  schema: 't8-theme-template';
  version: 1 | 2;
  id: string;
  name: string;
  description?: string;
  author?: string;
  builtIn?: boolean;
  legacyStyle: LegacyThemeStyle;
  visuals?: ThemeVisuals;
  music?: ThemeMusic;
  modes: Record<ThemeMode, ThemeModeDefinition>;
}

export const THEME_SCHEMA = 't8-theme-template' as const;
export const THEME_TEMPLATE_VERSION = 2 as const;
