import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const routing = require('../backend/src/providers/runninghubSite.js');

test('RunningHub site routing keeps the legacy key on the domestic site', () => {
  const settings = { rhApiKey: 'cn-key', rhIntlApiKey: 'intl-key' };
  const domestic = routing.getRhSiteConfig(settings, 'cn');
  const overseas = routing.getRhSiteConfig(settings, 'intl');

  assert.equal(domestic.baseUrl, 'https://www.runninghub.cn');
  assert.equal(domestic.host, 'www.runninghub.cn');
  assert.equal(domestic.apiKey, 'cn-key');
  assert.equal(overseas.baseUrl, 'https://www.runninghub.ai');
  assert.equal(overseas.host, 'www.runninghub.ai');
  assert.equal(overseas.apiKey, 'intl-key');
  assert.equal(routing.normalizeRhSite(undefined), 'cn');
});

test('RunningHub site candidates prefer the selected site and can use the configured alternate', () => {
  const settings = { rhApiKey: 'cn-key', rhIntlApiKey: 'intl-key' };
  assert.deepEqual(
    routing.buildRhSiteCandidates(settings, 'intl').map((item: any) => [item.id, item.apiKey]),
    [['intl', 'intl-key'], ['cn', 'cn-key']],
  );
  assert.deepEqual(
    routing.buildRhSiteCandidates({ rhApiKey: 'cn-key' }, 'intl').map((item: any) => item.id),
    ['cn'],
  );
});

test('RunningHub automatic site fallback is limited to credentials and missing app or task errors', () => {
  assert.equal(routing.shouldRetryRhSiteResponse({ status: 401 }, {}), true);
  assert.equal(routing.shouldRetryRhSiteResponse({ status: 200 }, { msg: 'API key invalid' }), true);
  assert.equal(routing.shouldRetryRhSiteResponse({ status: 200 }, { msg: 'webapp does not exist' }), true);
  assert.equal(routing.shouldRetryRhSiteResponse({ status: 200 }, { msg: 'task not found' }), true);
  assert.equal(routing.shouldRetryRhSiteResponse({ status: 200 }, { msg: 'Custom validation failed for node 12' }), false);
  assert.equal(routing.shouldRetryRhSiteResponse({ status: 500 }, { msg: 'server busy' }), false);
});

test('RunningHub settings and RH node surfaces expose independent domestic and overseas configuration', () => {
  const settingsRoute = readFileSync(new URL('../backend/src/routes/settings.js', import.meta.url), 'utf8');
  const apiSettings = readFileSync(new URL('../src/components/ApiSettings.tsx', import.meta.url), 'utf8');
  const generation = readFileSync(new URL('../src/services/generation.ts', import.meta.url), 'utf8');
  const runningHubNode = readFileSync(new URL('../src/components/nodes/RunningHubNode.tsx', import.meta.url), 'utf8');
  const rhToolsEditor = readFileSync(new URL('../src/components/nodes/RHToolEditorModal.tsx', import.meta.url), 'utf8');
  const rhToolbox = readFileSync(new URL('../src/utils/rhToolbox.ts', import.meta.url), 'utf8');

  assert.match(settingsRoute, /rhIntlApiKey:\s*''/);
  assert.match(settingsRoute, /rhIntlApiKey:\s*maskKey\(settings\.rhIntlApiKey\)/);
  assert.match(apiSettings, /RH APIKEY国内/);
  assert.match(apiSettings, /RH APIKEY海外/);
  assert.match(generation, /site\?: RhSite/);
  assert.match(generation, /site=\$\{encodeURIComponent\(site\)\}/);
  assert.match(runningHubNode, /国内站 · runninghub\.cn/);
  assert.match(runningHubNode, /海外站 · runninghub\.ai/);
  assert.match(rhToolsEditor, /aria-label="RunningHub 站点"/);
  assert.match(rhToolbox, /rhSite\?: 'cn' \| 'intl'/);
});
