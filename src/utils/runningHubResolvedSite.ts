import type { RhSite } from '../services/generation';

function normalizeRhSite(value: unknown): RhSite | null {
  if (value === 'intl') return 'intl';
  if (value === 'cn') return 'cn';
  return null;
}

export function resolvedRhSiteFromAppInfo(
  appInfo: unknown,
  webappId: string,
): RhSite | null {
  if (!appInfo || typeof appInfo !== 'object') return null;
  const record = appInfo as Record<string, unknown>;
  const site = normalizeRhSite(record.rhSite);
  if (!site) return null;
  const resolvedWebappId = String(record.webappId || '').trim();
  const currentWebappId = String(webappId || '').trim();
  if (resolvedWebappId && currentWebappId && resolvedWebappId !== currentWebappId) return null;
  return site;
}

export function resolveRunningHubDisplaySite(
  storedSite: unknown,
  webappId: string,
  appInfo: unknown,
): RhSite {
  return resolvedRhSiteFromAppInfo(appInfo, webappId)
    || (storedSite === 'intl' ? 'intl' : 'cn');
}
