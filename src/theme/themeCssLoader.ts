type ThemeCssLoader = () => Promise<unknown>;

export type ThemeCssKey =
  | 'pixel'
  | 'op'
  | 'rh'
  | 'naruto'
  | 'eva'
  | 'yyh'
  | 'slamdunk'
  | 'soccer'
  | 'dragonball'
  | 'saintseiya'
  | 'tetris'
  | 'farm-story'
  | 'garden-defense';

const themeCssLoaders: Record<ThemeCssKey, ThemeCssLoader> = {
  pixel: () => import('../styles/theme-pixel.css'),
  op: () => import('../styles/theme-op.css'),
  rh: () => import('../styles/theme-rh.css'),
  naruto: () => import('../styles/theme-naruto.css'),
  eva: () => import('../styles/theme-eva.css'),
  yyh: () => import('../styles/theme-yyh.css'),
  slamdunk: () => import('../styles/theme-slamdunk.css'),
  soccer: () => import('../styles/theme-soccer.css'),
  dragonball: () => import('../styles/theme-dragonball.css'),
  saintseiya: () => import('../styles/theme-saintseiya.css'),
  tetris: () => import('../styles/theme-tetris.css'),
  'farm-story': () => import('../styles/theme-farm-story.css'),
  'garden-defense': () => import('../styles/theme-garden-defense.css'),
};

const themeStyleAliases: Readonly<Record<string, ThemeCssKey | null>> = {
  tech: null,
  default: null,
  pixel: 'pixel',
  op: 'op',
  'one-piece': 'op',
  rh: 'rh',
  naruto: 'naruto',
  eva: 'eva',
  yyh: 'yyh',
  slamdunk: 'slamdunk',
  'slam-dunk': 'slamdunk',
  soccer: 'soccer',
  'soccer-hero': 'soccer',
  dragonball: 'dragonball',
  'dragon-ball': 'dragonball',
  saintseiya: 'saintseiya',
  'saint-seiya': 'saintseiya',
  tetris: 'tetris',
  farm: 'farm-story',
  'farm-story': 'farm-story',
  garden: 'garden-defense',
  'garden-defense': 'garden-defense',
};

const loadedThemeCss = new Map<ThemeCssKey, Promise<void>>();

export function themeCssKeyForStyle(themeStyle: string): ThemeCssKey | null {
  const normalized = String(themeStyle || '').trim().toLowerCase();
  return themeStyleAliases[normalized] ?? null;
}

export function ensureThemeCssLoaded(themeStyle: string): Promise<void> {
  const key = themeCssKeyForStyle(themeStyle);
  if (!key) return Promise.resolve();
  const existing = loadedThemeCss.get(key);
  if (existing) return existing;
  const pending = themeCssLoaders[key]()
    .then(() => undefined)
    .catch((error) => {
      loadedThemeCss.delete(key);
      console.warn(`主题样式加载失败: ${key}`, error);
      throw error;
    });
  loadedThemeCss.set(key, pending);
  return pending;
}

export type ThemeCssApplyOutcome = 'applied' | 'failed' | 'stale';

export function createThemeCssApplyCoordinator(
  loadThemeCss: (themeStyle: string) => Promise<void> = ensureThemeCssLoaded,
) {
  let latestRequest = 0;
  return {
    async apply(
      themeStyle: string,
      onReady: () => void,
      onFailure: (error: unknown) => void,
    ): Promise<ThemeCssApplyOutcome> {
      const request = ++latestRequest;
      try {
        await loadThemeCss(themeStyle);
      } catch (error) {
        if (request !== latestRequest) return 'stale';
        onFailure(error);
        return 'failed';
      }
      if (request !== latestRequest) return 'stale';
      onReady();
      return 'applied';
    },
  };
}
