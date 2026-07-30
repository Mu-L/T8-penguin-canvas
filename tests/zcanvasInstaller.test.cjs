'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const {
  BUNDLE_SIGNATURE_SCHEMA,
  InstallerError,
  bundleSignaturePayload,
  install,
  readInstallManifest,
  rollback,
  sourceLayout,
  sourceDigest,
  uninstall,
  verifyInstallation,
} = require('../tools/zcanvas-cli/src/installer.cjs');

function createVersionedBundle(sandbox, name, version) {
  const bundle = path.join(sandbox, name);
  fs.cpSync(path.join(root, 'tools', 'zcanvas-cli'), path.join(bundle, 'cli'), { recursive: true });
  fs.cpSync(path.join(root, '.agents', 'skills', 'zhenzhen-canvas'), path.join(bundle, 'skill'), { recursive: true });
  const manifestPath = path.join(bundle, 'cli', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.skillVersion = version;
  manifest.cliVersion = version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.appendFileSync(path.join(bundle, 'skill', 'SKILL.md'), `\n<!-- installer-test ${version} -->\n`, 'utf8');
  const layout = sourceLayout({ bundlePath: bundle });
  return {
    bundle,
    digest: sourceDigest(layout),
  };
}

function createSigner(keyId = 'test-release') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId,
    privateKey,
    trustedBundleSigners: [{
      keyId,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    }],
  };
}

function signBundle(bundleInfo, signer) {
  const layout = sourceLayout({ bundlePath: bundleInfo.bundle });
  const manifest = JSON.parse(fs.readFileSync(path.join(layout.cli, 'manifest.json'), 'utf8'));
  const signature = crypto.sign(
    null,
    bundleSignaturePayload(manifest, bundleInfo.digest),
    signer.privateKey,
  ).toString('base64');
  fs.writeFileSync(path.join(bundleInfo.bundle, 'bundle-signature.json'), `${JSON.stringify({
    schema: BUNDLE_SIGNATURE_SCHEMA,
    algorithm: 'Ed25519',
    keyId: signer.keyId,
    sourceDigest: bundleInfo.digest,
    signature,
  }, null, 2)}\n`, 'utf8');
  return bundleInfo;
}

test('current-user installer handles special paths, verifies hashes, rolls forward and uninstalls only owned root', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-安装 & % ^ !-'));
  const installRoot = path.join(sandbox, '用户 Skill & CLI % 目录');
  const userDiscoveryRoot = path.join(sandbox, '用户 Home', '.agents', 'skills', 'zhenzhen-canvas');
  const codexDiscoveryRoot = path.join(sandbox, 'Codex Home', 'skills', 'zhenzhen-canvas');
  const discoveryRoots = [userDiscoveryRoot, codexDiscoveryRoot];
  const credentials = path.join(sandbox, 'credentials-v1.json');
  fs.writeFileSync(credentials, 'keep-me', 'utf8');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const first = install({ projectRoot: root, installRoot, discoveryRoots });
  assert.equal(first.updated, false);
  assert.equal(first.verified, true);
  assert.ok(first.files > 8);
  assert.equal(fs.existsSync(path.join(installRoot, 'skills', 'zhenzhen-canvas', 'SKILL.md')), true);
  assert.deepEqual(first.discoveryRoots, discoveryRoots);
  assert.equal(fs.existsSync(path.join(userDiscoveryRoot, 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(codexDiscoveryRoot, 'SKILL.md')), true);

  const wrapper = path.join(installRoot, 'skills', 'zhenzhen-canvas', 'scripts', 'zcanvas.cjs');
  const launched = spawnSync(process.execPath, [wrapper, 'version'], {
    cwd: sandbox,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(JSON.parse(launched.stdout).data.skillName, 'zhenzhen-canvas');

  const discoveredWrapper = path.join(codexDiscoveryRoot, 'scripts', 'zcanvas.cjs');
  const discoveredLaunch = spawnSync(process.execPath, [discoveredWrapper, 'version'], {
    cwd: sandbox,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      PATH: '',
      ZCANVAS_CLI: '',
    },
  });
  assert.equal(discoveredLaunch.status, 0, discoveredLaunch.stderr);
  assert.equal(JSON.parse(discoveredLaunch.stdout).data.skillName, 'zhenzhen-canvas');

  const updated = install({ projectRoot: root, installRoot, discoveryRoots });
  assert.equal(updated.updated, true);
  assert.equal(updated.rollbackAvailable, true);
  assert.equal(fs.existsSync(`${installRoot}.last-known-good`), true);
  assert.equal(verifyInstallation({ installRoot }).verified, true);
  assert.equal(rollback({ installRoot, discoveryRoots }).rolledBack, true);
  assert.equal(verifyInstallation({ installRoot }).verified, true);

  const tampered = path.join(installRoot, 'skills', 'zhenzhen-canvas', 'SKILL.md');
  fs.appendFileSync(tampered, '\n篡改', 'utf8');
  assert.throws(
    () => verifyInstallation({ installRoot }),
    (error) => error instanceof InstallerError && error.code === 'INSTALL_VERIFY_FAILED',
  );
  install({ projectRoot: root, installRoot, discoveryRoots });
  assert.equal(verifyInstallation({ installRoot }).verified, true);

  const removed = uninstall({ installRoot });
  assert.equal(removed.removed, true);
  assert.equal(removed.credentialsPreserved, true);
  assert.equal(fs.existsSync(installRoot), false);
  assert.equal(fs.existsSync(userDiscoveryRoot), false);
  assert.equal(fs.existsSync(codexDiscoveryRoot), false);
  assert.equal(fs.readFileSync(credentials, 'utf8'), 'keep-me');
});

test('versioned local bundle requires an exact digest and a trusted Ed25519 signature before replacement', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-versioned-bundle-'));
  const installRoot = path.join(sandbox, 'installed');
  const signer = createSigner();
  const bundleInfo = signBundle(createVersionedBundle(sandbox, 'bundle 0.1.0', '0.1.0-test'), signer);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const layout = sourceLayout({ bundlePath: bundleInfo.bundle });
  assert.equal(layout.distribution, 'versioned-local-bundle');
  assert.match(bundleInfo.digest, /^[a-f0-9]{64}$/);
  assert.throws(
    () => install({ bundlePath: bundleInfo.bundle, installRoot }),
    (error) => error instanceof InstallerError && error.code === 'INSTALL_BUNDLE_DIGEST_REQUIRED',
  );
  assert.throws(
    () => install({
      bundlePath: bundleInfo.bundle,
      bundleSha256: bundleInfo.digest,
      installRoot,
    }),
    (error) => error instanceof InstallerError && error.code === 'INSTALL_BUNDLE_TRUST_NOT_CONFIGURED',
  );
  const installed = install({
    bundlePath: bundleInfo.bundle,
    bundleSha256: bundleInfo.digest,
    installRoot,
    trustedBundleSigners: signer.trustedBundleSigners,
  });
  assert.equal(installed.sourceDigest, bundleInfo.digest);
  assert.equal(installed.signatureVerified, true);
  assert.equal(installed.signerKeyId, signer.keyId);
  assert.equal(readInstallManifest(installRoot).bundleSignature.keyId, signer.keyId);
  const signaturePath = path.join(bundleInfo.bundle, 'bundle-signature.json');
  const signatureDocument = JSON.parse(fs.readFileSync(signaturePath, 'utf8'));
  signatureDocument.signature = Buffer.alloc(64, 7).toString('base64');
  fs.writeFileSync(signaturePath, `${JSON.stringify(signatureDocument, null, 2)}\n`, 'utf8');
  assert.throws(
    () => install({
      bundlePath: bundleInfo.bundle,
      bundleSha256: bundleInfo.digest,
      installRoot,
    }),
    (error) => error instanceof InstallerError && error.code === 'INSTALL_BUNDLE_SIGNATURE_MISMATCH',
  );
  assert.equal(verifyInstallation({ installRoot }).verified, true);
  assert.throws(
    () => install({
      bundlePath: bundleInfo.bundle,
      bundleSha256: '0'.repeat(64),
      installRoot,
    }),
    (error) => error instanceof InstallerError && error.code === 'INSTALL_BUNDLE_DIGEST_MISMATCH',
  );
  assert.equal(verifyInstallation({ installRoot }).verified, true);
});

test('failed rollback restores the exact current version and every managed discovery copy', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-rollback-atomic-'));
  const installRoot = path.join(sandbox, 'installed');
  const userDiscoveryRoot = path.join(sandbox, 'home', '.agents', 'skills', 'zhenzhen-canvas');
  const codexDiscoveryRoot = path.join(sandbox, 'codex', 'skills', 'zhenzhen-canvas');
  const discoveryRoots = [userDiscoveryRoot, codexDiscoveryRoot];
  const signer = createSigner('rollback-test-release');
  const v1 = signBundle(createVersionedBundle(sandbox, 'bundle-v1', '1.0.0-test'), signer);
  const v2 = signBundle(createVersionedBundle(sandbox, 'bundle-v2', '2.0.0-test'), signer);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  install({
    bundlePath: v1.bundle,
    bundleSha256: v1.digest,
    installRoot,
    discoveryRoots,
    trustedBundleSigners: signer.trustedBundleSigners,
  });
  install({
    bundlePath: v2.bundle,
    bundleSha256: v2.digest,
    installRoot,
    discoveryRoots,
  });
  assert.equal(verifyInstallation({ installRoot }).skillVersion, '2.0.0-test');

  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = function renameWithInjectedDiscoveryFailure(source, destination) {
    if (!injected
      && path.resolve(destination) === path.resolve(codexDiscoveryRoot)
      && path.basename(source).startsWith('.zhenzhen-canvas.stage-')) {
      injected = true;
      throw new Error('injected discovery activation failure');
    }
    return originalRename.call(fs, source, destination);
  };
  try {
    assert.throws(
      () => rollback({ installRoot, discoveryRoots }),
      (error) => error instanceof InstallerError && error.code === 'INSTALL_ROLLBACK_FAILED',
    );
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(injected, true);
  assert.equal(verifyInstallation({ installRoot }).skillVersion, '2.0.0-test');
  assert.equal(
    verifyInstallation({ installRoot: `${installRoot}.last-known-good`, verifyDiscovery: false }).skillVersion,
    '1.0.0-test',
  );
  assert.equal(
    fs.readFileSync(path.join(userDiscoveryRoot, 'SKILL.md'), 'utf8').includes('installer-test 2.0.0-test'),
    true,
  );
  assert.equal(
    fs.readFileSync(path.join(codexDiscoveryRoot, 'SKILL.md'), 'utf8').includes('installer-test 2.0.0-test'),
    true,
  );
});

test('installer discovers project, Electron resource and verified current-user layouts without guessing paths', (t) => {
  assert.equal(sourceLayout({ projectRoot: root }).distribution, 'project-source');

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-layout-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const packagedCli = path.join(sandbox, 'tools', 'zcanvas-cli');
  const packagedSkill = path.join(sandbox, 'agent', 'skills', 'zhenzhen-canvas');
  fs.mkdirSync(packagedCli, { recursive: true });
  fs.mkdirSync(packagedSkill, { recursive: true });
  fs.writeFileSync(path.join(packagedCli, 'manifest.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(packagedSkill, 'SKILL.md'), '---\nname: zhenzhen-canvas\n---\n', 'utf8');
  const packaged = sourceLayout({ projectRoot: sandbox });
  assert.equal(packaged.distribution, 'electron-resources');
  assert.equal(packaged.cli, packagedCli);
  assert.equal(packaged.skill, packagedSkill);
});

test('installer rejects path-traversal versions before constructing a staged runtime path', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-version-traversal-'));
  const installRoot = path.join(sandbox, 'installed');
  const signer = createSigner();
  const bundleInfo = createVersionedBundle(sandbox, 'bundle-invalid-version', '1.0.0-test');
  const manifestPath = path.join(bundleInfo.bundle, 'cli', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.cliVersion = '../../outside';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const digest = sourceDigest(sourceLayout({ bundlePath: bundleInfo.bundle }));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  assert.throws(
    () => install({
      bundlePath: bundleInfo.bundle,
      bundleSha256: digest,
      installRoot,
      trustedBundleSigners: signer.trustedBundleSigners,
    }),
    (error) => error instanceof InstallerError && error.code === 'INSTALL_SOURCE_MANIFEST_INVALID',
  );
  assert.equal(fs.existsSync(path.join(sandbox, 'outside')), false);
});

test('verification rejects untracked executable files not covered by the immutable manifest', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-untracked-file-'));
  const installRoot = path.join(sandbox, 'installed');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  install({ projectRoot: root, installRoot, discoveryRoots: [] });
  fs.writeFileSync(path.join(installRoot, 'runtime', 'unexpected.cjs'), 'process.exit(0);\n', 'utf8');
  assert.throws(
    () => verifyInstallation({ installRoot }),
    (error) => error instanceof InstallerError && error.code === 'INSTALL_VERIFY_FAILED',
  );
});

test('project Skill and CLI take precedence over an older managed global discovery copy', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-project-precedence-'));
  const project = path.join(sandbox, 'project');
  const projectCli = path.join(project, 'tools', 'zcanvas-cli', 'bin', 'zcanvas.cjs');
  const projectSkill = path.join(project, '.agents', 'skills', 'zhenzhen-canvas', 'SKILL.md');
  const discovery = path.join(sandbox, 'global-skill');
  const wrapper = path.join(discovery, 'scripts', 'zcanvas.cjs');
  const staleInstall = path.join(sandbox, 'stale-install');
  const staleCli = path.join(staleInstall, 'runtime', '0.0.1-stale', 'bin', 'zcanvas.cjs');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  fs.mkdirSync(path.dirname(projectCli), { recursive: true });
  fs.mkdirSync(path.dirname(projectSkill), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(path.dirname(staleCli), { recursive: true });
  fs.writeFileSync(projectCli, "process.stdout.write('project\\n');\n", 'utf8');
  fs.writeFileSync(projectSkill, '---\nname: zhenzhen-canvas\n---\n', 'utf8');
  fs.copyFileSync(path.join(root, '.agents', 'skills', 'zhenzhen-canvas', 'scripts', 'zcanvas.cjs'), wrapper);
  fs.writeFileSync(path.join(discovery, '.zcanvas-managed.json'), `${JSON.stringify({
    schema: 't8-zcanvas-discovery-copy-v1',
    installRoot: staleInstall,
    skillDigest: 'stale',
  })}\n`, 'utf8');
  fs.writeFileSync(path.join(staleInstall, '.zcanvas-install.json'), `${JSON.stringify({
    schema: 't8-zcanvas-install-v1',
    cliVersion: '0.0.1-stale',
  })}\n`, 'utf8');
  fs.writeFileSync(staleCli, "process.stdout.write('global\\n');\n", 'utf8');

  const launched = spawnSync(process.execPath, [wrapper, 'version'], {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: { ...process.env, ZCANVAS_CLI: '', PATH: '' },
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout.trim(), 'project');
});

test('installer rejects a disk root and refuses unmarked directories', (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zcanvas-unmarked-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  assert.throws(
    () => install({ projectRoot: root, installRoot: path.parse(sandbox).root }),
    (error) => error instanceof InstallerError && error.code === 'INSTALL_TARGET_UNSAFE',
  );
  assert.throws(
    () => uninstall({ installRoot: sandbox }),
    (error) => error instanceof InstallerError && error.code === 'INSTALL_NOT_FOUND',
  );
  assert.equal(fs.existsSync(sandbox), true);
});
