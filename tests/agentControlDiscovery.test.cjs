'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registry = require('../backend/src/services/agentControlRegistry.js');
const discovery = require('../tools/zcanvas-cli/src/discovery.cjs');
const {
  AgentClientError,
  assertCompatibleInstance,
} = require('../tools/zcanvas-cli/src/agentClient.cjs');
const { readManifest } = require('../tools/zcanvas-cli/src/manifest.cjs');

const INSTANCE_ID = 'a'.repeat(43);
const COMPATIBILITY = (() => {
  const manifest = readManifest();
  return {
    skillVersion: manifest.skillVersion,
    cliVersion: manifest.cliVersion,
    canvasPatchProtocol: manifest.canvasPatchProtocol,
    nodeSchemaDigest: manifest.nodeSchemaDigest,
    providerCatalogDigest: manifest.providerCatalogDigest,
    creativeCapabilityManifestDigest: manifest.creativeCapabilityManifestDigest,
    creativeCapabilityGraphDigest: manifest.creativeCapabilityGraphDigest,
    manifestDigest: manifest.manifestDigest,
  };
})();

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't8-zcanvas-discovery-'));
}

test('agent-control registry publishes no secret and removes only its own descriptor', () => {
  const root = tempRoot();
  const registration = registry.registerAgentControlInstance({
    BACKEND_INSTANCE_ID: INSTANCE_ID,
    HOST: '127.0.0.1',
    PORT: 19001,
    APP_VERSION: '2.6.4',
  }, {
    env: { ZCANVAS_INSTANCE_DIR: root },
    heartbeatMs: 30_000,
  });

  const raw = fs.readFileSync(registration.descriptorPath, 'utf8');
  const descriptor = JSON.parse(raw);
  assert.equal(descriptor.schema, 't8-agent-control-instance-v1');
  assert.equal(descriptor.origin, 'http://127.0.0.1:19001');
  assert.equal(descriptor.controlProtocol, 't8-agent-control-v1');
  assert.deepEqual(
    Object.fromEntries(Object.keys(COMPATIBILITY).map((key) => [key, descriptor[key]])),
    COMPATIBILITY,
  );
  assert.doesNotMatch(raw, /token|secret|api.?key|authorization/i);

  registration.stop();
  assert.equal(fs.existsSync(registration.descriptorPath), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('CLI discovery rejects stale, oversized, symlink, remote-origin, and malformed descriptors', () => {
  const root = tempRoot();
  const now = Date.now();
  const base = {
    schema: 't8-agent-control-instance-v1',
    instanceId: INSTANCE_ID,
    pid: 123,
    origin: 'http://127.0.0.1:19002',
    statusUrl: 'http://127.0.0.1:19002/api/status',
    appVersion: '2.6.4',
    controlProtocol: 't8-agent-control-v1',
    ...COMPATIBILITY,
    heartbeatAt: new Date(now).toISOString(),
    staleAfterMs: 20_000,
  };

  fs.writeFileSync(path.join(root, `${INSTANCE_ID}.json`), JSON.stringify(base), 'utf8');
  assert.equal(discovery.readInstanceDescriptors({
    env: { ZCANVAS_INSTANCE_DIR: root },
    homeDir: '',
    now,
  }).length, 1);

  fs.writeFileSync(path.join(root, `${INSTANCE_ID}.json`), JSON.stringify({
    ...base,
    heartbeatAt: new Date(now - 30_000).toISOString(),
  }), 'utf8');
  assert.equal(discovery.readInstanceDescriptors({
    env: { ZCANVAS_INSTANCE_DIR: root },
    homeDir: '',
    now,
  }).length, 0);

  fs.writeFileSync(path.join(root, `${INSTANCE_ID}.json`), JSON.stringify({
    ...base,
    origin: 'https://attacker.example:19002',
  }), 'utf8');
  assert.equal(discovery.readInstanceDescriptors({
    env: { ZCANVAS_INSTANCE_DIR: root },
    homeDir: '',
    now,
  }).length, 0);

  fs.writeFileSync(path.join(root, `${INSTANCE_ID}.json`), 'x'.repeat(discovery.INSTANCE_FILE_LIMIT + 1), 'utf8');
  assert.equal(discovery.readInstanceDescriptors({
    env: { ZCANVAS_INSTANCE_DIR: root },
    homeDir: '',
    now,
  }).length, 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('CLI probe accepts only a matching live T8 backend identity', async () => {
  const descriptor = {
    schema: 't8-agent-control-instance-v1',
    instanceId: INSTANCE_ID,
    pid: 123,
    origin: 'http://127.0.0.1:19003',
    statusUrl: 'http://127.0.0.1:19003/api/status',
    appVersion: '2.6.4',
    controlProtocol: 't8-agent-control-v1',
    ...COMPATIBILITY,
    heartbeatAt: new Date().toISOString(),
    staleAfterMs: 20_000,
  };
  const response = (body) => ({
    ok: true,
    json: async () => body,
  });

  const live = await discovery.probeInstance(descriptor, {
    fetch: async () => response({
      ok: true,
      service: 't8-penguin-canvas-backend',
      version: '2.6.4',
      port: 19003,
      instanceId: INSTANCE_ID,
    }),
  });
  assert.equal(live.live, true);

  const mismatch = await discovery.probeInstance(descriptor, {
    fetch: async () => response({
      ok: true,
      service: 't8-penguin-canvas-backend',
      version: '2.6.4',
      port: 19003,
      instanceId: 'b'.repeat(43),
    }),
  });
  assert.equal(mismatch, null);
});

test('CLI compatibility gate rejects old or malformed desktop versions before any request', () => {
  const manifest = {
    controlProtocol: 't8-agent-control-v1',
    minimumDesktopVersion: '2.6.4',
    ...COMPATIBILITY,
  };
  const compatible = {
    instanceId: INSTANCE_ID,
    appVersion: '2.6.4',
    controlProtocol: 't8-agent-control-v1',
    ...COMPATIBILITY,
  };
  assert.equal(assertCompatibleInstance(compatible, { manifest }), compatible);

  assert.throws(
    () => assertCompatibleInstance({ ...compatible, appVersion: '2.6.3' }, { manifest }),
    (error) => error instanceof AgentClientError && error.code === 'APP_VERSION_INCOMPATIBLE',
  );
  assert.throws(
    () => assertCompatibleInstance({ ...compatible, appVersion: 'development' }, { manifest }),
    (error) => error instanceof AgentClientError && error.code === 'APP_VERSION_INVALID',
  );
  assert.throws(
    () => assertCompatibleInstance({ ...compatible, controlProtocol: 't8-agent-control-v2' }, { manifest }),
    (error) => error instanceof AgentClientError && error.code === 'AGENT_CONTROL_PROTOCOL_MISMATCH',
  );
  assert.throws(
    () => assertCompatibleInstance({ ...compatible, nodeSchemaDigest: 'drift' }, { manifest }),
    (error) => error instanceof AgentClientError && error.code === 'NODE_SCHEMA_DIGEST_MISMATCH',
  );
  assert.throws(
    () => assertCompatibleInstance({ ...compatible, creativeCapabilityManifestDigest: 'drift' }, { manifest }),
    (error) => error instanceof AgentClientError && error.code === 'CREATIVE_CAPABILITY_MANIFEST_DIGEST_MISMATCH',
  );
  assert.throws(
    () => assertCompatibleInstance({ ...compatible, creativeCapabilityGraphDigest: 'drift' }, { manifest }),
    (error) => error instanceof AgentClientError && error.code === 'CREATIVE_CAPABILITY_GRAPH_DIGEST_MISMATCH',
  );
});
