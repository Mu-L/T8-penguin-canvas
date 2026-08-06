'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('Electron development can load the live Vite renderer without weakening packaged navigation', () => {
  const source = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');

  assert.match(source, /process\.env\.T8PC_DEV_SERVER_URL/);
  assert.match(source, /\['127\.0\.0\.1', 'localhost', '\[::1\]', '::1'\]/);
  assert.match(source, /process\.env\.T8PC_FRONTEND_URL = developmentFrontendUrl\(\)/);
  assert.match(source, /const url = developmentFrontendUrl\(\) \|\| backendUrl/);
  assert.match(source, /if \(isPackaged\(\)\) return ''/);
});

test('development Electron and Vite can share a loopback-only isolated backend port', () => {
  const electron = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
  const vite = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');

  assert.match(electron, /function developmentBackendPortPreference\(\)/);
  assert.match(electron, /if \(isPackaged\(\)\) return 18766/);
  assert.match(electron, /process\.env\.T8PC_DEV_BACKEND_PORT/);
  assert.match(electron, /findFreePort\(developmentBackendPortPreference\(\)\)/);
  assert.match(vite, /process\.env\.T8PC_DEV_BACKEND_ORIGIN/);
  assert.match(vite, /\^http:\\\/\\\/127\\\.0\\\.0\\\.1:/);
  assert.match(vite, /collaborationManagementProxy\(managementToken, backendTarget\)/);
  assert.match(vite, /target: backendTarget/g);
});

test('development and pairing acceptance use the canonical TypeScript Vite config', () => {
  const packageManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const pairingAcceptanceSource = fs.readFileSync(
    path.join(root, 'scripts', 'verify-creator-agent-p4-pairing.cjs'),
    'utf8',
  );
  const uiAcceptanceSource = fs.readFileSync(
    path.join(root, 'scripts', 'verify-creator-agent-p4-ui.cjs'),
    'utf8',
  );
  for (const scriptName of ['dev', 'dev:vite', 'build', 'preview']) {
    assert.match(
      String(packageManifest.scripts?.[scriptName] || ''),
      /--config vite\.config\.ts/,
      `${scriptName} must not silently load the legacy generated vite.config.js`,
    );
  }
  assert.match(pairingAcceptanceSource, /'--config',\s*path\.join\(ROOT, 'vite\.config\.ts'\)/);
  assert.match(uiAcceptanceSource, /'--config',\s*path\.join\(ROOT, 'vite\.config\.ts'\)/);
  assert.match(uiAcceptanceSource, /const backendPort = await findFreePort\(\)/);
  assert.match(uiAcceptanceSource, /T8PC_DEV_BACKEND_ORIGIN: backendUrl/);
  assert.doesNotMatch(uiAcceptanceSource, /const BACKEND_PORT = 18766/);
  assert.match(uiAcceptanceSource, /const ELECTRON = require\('electron'\)/);
  assert.match(uiAcceptanceSource, /const backend = launch\(ELECTRON/);
  assert.match(uiAcceptanceSource, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(uiAcceptanceSource, /T8PC_PACKAGED: '0'/);
  assert.match(uiAcceptanceSource, /T8PC_DEV_DATA_ROOT: USER_DATA/);
});

function readConfigPaths(environment) {
  const script = `
    const config = require(${JSON.stringify(path.join(root, 'backend', 'src', 'config.js'))});
    process.stdout.write(JSON.stringify({
      baseDir: config.BASE_DIR,
      dataDir: config.DATA_DIR,
      isPackaged: config.IS_PACKAGED,
    }));
  `;
  const result = childProcess.spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      T8_COLLAB_MANAGEMENT_TOKEN: 'A'.repeat(43),
      T8PC_BACKEND_INSTANCE_ID: 'B'.repeat(43),
      ...environment,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('development QA may isolate its data root without changing the default project root', () => {
  const isolatedRoot = path.join(os.tmpdir(), 't8-electron-dev-data-root-test');
  const isolated = readConfigPaths({
    T8PC_PACKAGED: '0',
    T8PC_DEV_DATA_ROOT: isolatedRoot,
  });
  assert.equal(isolated.isPackaged, false);
  assert.equal(path.resolve(isolated.baseDir), path.resolve(isolatedRoot));
  assert.equal(path.resolve(isolated.dataDir), path.join(path.resolve(isolatedRoot), 'data'));

  const normal = readConfigPaths({
    T8PC_PACKAGED: '0',
    T8PC_DEV_DATA_ROOT: '',
  });
  assert.equal(path.resolve(normal.baseDir), root);
});

test('packaged mode ignores the development-only root override', () => {
  const packagedRoot = path.join(os.tmpdir(), 't8-electron-packaged-data-root-test');
  const packaged = readConfigPaths({
    T8PC_PACKAGED: '1',
    T8PC_USER_DATA: packagedRoot,
    T8PC_DEV_DATA_ROOT: path.join(os.tmpdir(), 'must-not-win'),
  });
  assert.equal(packaged.isPackaged, true);
  assert.equal(path.resolve(packaged.baseDir), path.resolve(packagedRoot));
});

test('packaged data directories preserve a Chinese Windows user path', () => {
  const packagedRoot = path.join(os.tmpdir(), 'Windows用户-自定义账户', 'AppData', 'Roaming', 'T8-PenguinCanvas');
  const packaged = readConfigPaths({
    T8PC_PACKAGED: '1',
    T8PC_USER_DATA: packagedRoot,
  });
  assert.equal(path.resolve(packaged.baseDir), path.resolve(packagedRoot));
  assert.equal(path.resolve(packaged.dataDir), path.join(path.resolve(packagedRoot), 'data'));
});
