'use strict';

const RH_SITE_CN = 'cn';
const RH_SITE_INTL = 'intl';

const RH_SITES = Object.freeze({
  [RH_SITE_CN]: Object.freeze({
    id: RH_SITE_CN,
    label: '国内站',
    baseUrl: 'https://www.runninghub.cn',
    host: 'www.runninghub.cn',
    keyField: 'rhApiKey',
  }),
  [RH_SITE_INTL]: Object.freeze({
    id: RH_SITE_INTL,
    label: '海外站',
    baseUrl: 'https://www.runninghub.ai',
    host: 'www.runninghub.ai',
    keyField: 'rhIntlApiKey',
  }),
});

function normalizeRhSite(value) {
  const site = String(value || '').trim().toLowerCase();
  return ['intl', 'international', 'overseas', 'global', 'ai'].includes(site)
    ? RH_SITE_INTL
    : RH_SITE_CN;
}

function alternateRhSite(value) {
  return normalizeRhSite(value) === RH_SITE_INTL ? RH_SITE_CN : RH_SITE_INTL;
}

function readRhSiteKey(settings, site) {
  const normalized = normalizeRhSite(site);
  if (normalized === RH_SITE_INTL) {
    return String(settings?.rhIntlApiKey || settings?.rhOverseasApiKey || '').trim();
  }
  return String(settings?.rhApiKey || settings?.runninghubApiKey || '').trim();
}

function getRhSiteConfig(settings, site, apiKeyOverride = '') {
  const normalized = normalizeRhSite(site);
  return {
    ...RH_SITES[normalized],
    apiKey: String(apiKeyOverride || readRhSiteKey(settings, normalized)).trim(),
  };
}

function buildRhSiteCandidates(settings, preferredSite, preferredApiKey = '') {
  const preferred = normalizeRhSite(preferredSite);
  const primary = getRhSiteConfig(settings, preferred, preferredApiKey);
  const alternate = getRhSiteConfig(settings, alternateRhSite(preferred));
  return [primary, alternate].filter((candidate, index, list) => (
    !!candidate.apiKey && list.findIndex((item) => item.id === candidate.id) === index
  ));
}

function runningHubFailureText(data) {
  const parts = [
    data?.msg,
    data?.message,
    data?.error,
    data?.data?.msg,
    data?.data?.message,
    data?.data?.error,
    data?.data?.failedReason,
    data?.data?.failReason,
  ];
  return parts
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return ''; }
      }
      return '';
    })
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function shouldRetryRhSiteResponse(response, data) {
  const status = Number(response?.status || 0);
  if ([401, 403, 404].includes(status)) return true;

  const text = runningHubFailureText(data);
  if (!text) return false;
  return /(?:api\s*key|apikey|token|unauthori[sz]ed|forbidden|auth(?:entication|orization)?|credential|令牌|密钥|鉴权|认证|无权限)/i.test(text)
    || /(?:webapp|app|应用).{0,24}(?:not\s*found|does\s*not\s*exist|invalid|不存在|无效|错误|无权限)/i.test(text)
    || /(?:task|任务).{0,24}(?:not\s*found|does\s*not\s*exist|不存在|无效|错误)/i.test(text);
}

function missingRhKeyError(site) {
  const preferred = RH_SITES[normalizeRhSite(site)];
  return `未配置 RunningHub ${preferred.label} API Key（请在设置中填写 RH APIKEY${preferred.id === RH_SITE_CN ? '国内' : '海外'}）`;
}

module.exports = {
  RH_SITE_CN,
  RH_SITE_INTL,
  RH_SITES,
  normalizeRhSite,
  alternateRhSite,
  readRhSiteKey,
  getRhSiteConfig,
  buildRhSiteCandidates,
  runningHubFailureText,
  shouldRetryRhSiteResponse,
  missingRhKeyError,
};
