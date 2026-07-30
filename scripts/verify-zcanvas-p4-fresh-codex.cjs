'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BUNDLE_SIGNATURE_SCHEMA,
  BUNDLE_TRUST_POLICY_SCHEMA,
  bundleSignaturePayload,
  sourceDigest,
  sourceLayout,
} = require('../tools/zcanvas-cli/src/installer.cjs');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PARENT = path.join(ROOT, 'artifacts');
const ARTIFACT_DIR = path.join(ARTIFACT_PARENT, 'creator-agent-p4-fresh-codex');
const REPORT_PATH = path.join(ARTIFACT_DIR, 'report.json');
const PROJECT_CLI = path.join(ROOT, 'tools', 'zcanvas-cli', 'bin', 'zcanvas.cjs');

function assertInside(parent, candidate, label) {
  const parentPath = path.resolve(parent);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(parentPath, candidatePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`拒绝清理非 ${label} 目录`);
  }
  return candidatePath;
}

function resetArtifacts() {
  fs.rmSync(assertInside(ARTIFACT_PARENT, ARTIFACT_DIR, 'P4-E 证据'), {
    recursive: true,
    force: true,
  });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

function treeDigest(directory, exclusions = new Set()) {
  const records = [];
  const stack = [{ absolute: path.resolve(directory), relative: '' }];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current.absolute, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = path.join(current.relative, entry.name);
      if (exclusions.has(relative.split(path.sep).join('/'))) continue;
      const stat = fs.lstatSync(absolute);
      assert.equal(stat.isSymbolicLink(), false, '验收目录不得包含符号链接');
      if (stat.isDirectory()) {
        stack.push({ absolute, relative });
      } else {
        assert.equal(stat.isFile(), true);
        records.push([
          relative.split(path.sep).join('/'),
          stat.size,
          crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
        ].join('\u0000'));
      }
    }
  }
  return crypto.createHash('sha256').update(records.sort().join('\n')).digest('hex');
}

function createBundle(sandbox, name, version, signer) {
  const bundle = path.join(sandbox, name);
  fs.cpSync(path.join(ROOT, 'tools', 'zcanvas-cli'), path.join(bundle, 'cli'), { recursive: true });
  fs.cpSync(path.join(ROOT, '.agents', 'skills', 'zhenzhen-canvas'), path.join(bundle, 'skill'), {
    recursive: true,
  });
  const manifestPath = path.join(bundle, 'cli', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.skillVersion = version;
  manifest.cliVersion = version;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.appendFileSync(path.join(bundle, 'skill', 'SKILL.md'), `\n<!-- p4e-version ${version} -->\n`, 'utf8');
  const layout = sourceLayout({ bundlePath: bundle });
  const digest = sourceDigest(layout);
  const signature = crypto.sign(
    null,
    bundleSignaturePayload(manifest, digest),
    signer.privateKey,
  ).toString('base64');
  fs.writeFileSync(path.join(bundle, 'bundle-signature.json'), `${JSON.stringify({
    schema: BUNDLE_SIGNATURE_SCHEMA,
    algorithm: 'Ed25519',
    keyId: signer.keyId,
    sourceDigest: digest,
    signature,
  }, null, 2)}\n`, 'utf8');
  return {
    path: bundle,
    digest,
    skillDigest: treeDigest(path.join(bundle, 'skill')),
    version,
  };
}

function isolatedEnvironment(sandbox, suffix = '') {
  const base = suffix ? path.join(sandbox, suffix) : sandbox;
  const home = path.join(base, 'user-home');
  const codexHome = path.join(base, 'codex-home');
  const localAppData = path.join(base, 'local-app-data');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    LOCALAPPDATA: localAppData,
    PATH: '',
    ZCANVAS_CLI: '',
  };
  delete env.ZCANVAS_INSTALL_ROOT;
  return {
    base,
    home,
    codexHome,
    localAppData,
    installRoot: path.join(localAppData, 'ZhenzhenCanvas', 'Agent'),
    agentsSkill: path.join(home, '.agents', 'skills', 'zhenzhen-canvas'),
    codexSkill: path.join(codexHome, 'skills', 'zhenzhen-canvas'),
    env,
  };
}

function runCli(entry, args, env, options = {}) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: options.cwd || path.dirname(entry),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env,
    timeout: 60_000,
  });
  let payload = null;
  try {
    payload = JSON.parse(String(result.stdout || '').trim());
  } catch (_) {}
  if (!options.allowFailure) {
    assert.equal(
      result.status,
      0,
      `zcanvas 命令失败: ${args.join(' ')}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.equal(payload?.ok, true, `zcanvas 未返回成功 envelope: ${result.stdout}`);
  }
  return { ...result, payload };
}

function versionFromSkill(skillRoot, env) {
  const wrapper = path.join(skillRoot, 'scripts', 'zcanvas.cjs');
  const result = runCli(wrapper, ['version'], env);
  return result.payload.data;
}

function assertInstalledSkill(versioned, environment) {
  const exclusions = new Set(['.zcanvas-managed.json']);
  const masterSkill = path.join(environment.installRoot, 'skills', 'zhenzhen-canvas');
  assert.equal(treeDigest(masterSkill), versioned.skillDigest);
  assert.equal(treeDigest(environment.agentsSkill, exclusions), versioned.skillDigest);
  assert.equal(treeDigest(environment.codexSkill, exclusions), versioned.skillDigest);
  assert.equal(versionFromSkill(environment.agentsSkill, environment.env).skillVersion, versioned.version);
  assert.equal(versionFromSkill(environment.codexSkill, environment.env).skillVersion, versioned.version);
}

function run() {
  resetArtifacts();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 't8-zcanvas-p4e-'));
  const report = {
    schema: 't8-zcanvas-p4-fresh-codex-acceptance-v1',
    generatedAt: new Date().toISOString(),
    passed: false,
  };
  try {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const signer = { keyId: 'p4e-isolated-release', privateKey };
    const trustPolicy = path.join(sandbox, 'trusted-release-keys.json');
    fs.writeFileSync(trustPolicy, `${JSON.stringify({
      schema: BUNDLE_TRUST_POLICY_SCHEMA,
      signers: [{
        keyId: signer.keyId,
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }],
    }, null, 2)}\n`, 'utf8');
    const v1 = createBundle(sandbox, 'bundle-v1', '1.0.0-p4e', signer);
    const v2 = createBundle(sandbox, 'bundle-v2', '2.0.0-p4e', signer);
    const fresh = isolatedEnvironment(sandbox, 'fresh');
    const credentials = path.join(fresh.base, 'credentials.json');
    fs.writeFileSync(credentials, 'creator-owned', 'utf8');

    const installed = runCli(PROJECT_CLI, [
      'skill',
      'install',
      '--bundle',
      v1.path,
      '--sha256',
      v1.digest,
      '--trust-policy',
      trustPolicy,
    ], fresh.env);
    assert.equal(installed.payload.data.updated, false);
    assert.equal(installed.payload.data.skillVersion, v1.version);
    assertInstalledSkill(v1, fresh);

    const freshCodexWrapper = path.join(fresh.codexSkill, 'scripts', 'zcanvas.cjs');
    const updated = runCli(freshCodexWrapper, [
      'skill',
      'update',
      '--bundle',
      v2.path,
      '--sha256',
      v2.digest,
    ], fresh.env);
    assert.equal(updated.payload.data.updated, true);
    assert.equal(updated.payload.data.rollbackAvailable, true);
    assertInstalledSkill(v2, fresh);

    const invalidDigest = runCli(freshCodexWrapper, [
      'skill',
      'update',
      '--bundle',
      v1.path,
      '--sha256',
      '0'.repeat(64),
    ], fresh.env, { allowFailure: true });
    assert.notEqual(invalidDigest.status, 0);
    assert.equal(invalidDigest.payload?.code, 'INSTALL_BUNDLE_DIGEST_MISMATCH');
    assertInstalledSkill(v2, fresh);

    const signaturePath = path.join(v1.path, 'bundle-signature.json');
    const originalSignature = fs.readFileSync(signaturePath, 'utf8');
    const signatureDocument = JSON.parse(originalSignature);
    signatureDocument.signature = Buffer.alloc(64, 9).toString('base64');
    fs.writeFileSync(signaturePath, `${JSON.stringify(signatureDocument, null, 2)}\n`, 'utf8');
    const invalidSignature = runCli(freshCodexWrapper, [
      'skill',
      'update',
      '--bundle',
      v1.path,
      '--sha256',
      v1.digest,
    ], fresh.env, { allowFailure: true });
    assert.notEqual(invalidSignature.status, 0);
    assert.equal(invalidSignature.payload?.code, 'INSTALL_BUNDLE_SIGNATURE_MISMATCH');
    assertInstalledSkill(v2, fresh);
    fs.writeFileSync(signaturePath, originalSignature, 'utf8');

    const rolledBack = runCli(freshCodexWrapper, ['skill', 'rollback'], fresh.env);
    assert.equal(rolledBack.payload.data.rolledBack, true);
    assert.equal(rolledBack.payload.data.skillVersion, v1.version);
    assertInstalledSkill(v1, fresh);

    const shadow = isolatedEnvironment(sandbox, 'unowned-shadow');
    fs.mkdirSync(shadow.codexSkill, { recursive: true });
    const shadowSentinel = path.join(shadow.codexSkill, 'creator-owned.txt');
    fs.writeFileSync(shadowSentinel, 'do-not-overwrite', 'utf8');
    const shadowInstall = runCli(PROJECT_CLI, [
      'skill',
      'install',
      '--bundle',
      v1.path,
      '--sha256',
      v1.digest,
      '--trust-policy',
      trustPolicy,
    ], shadow.env, { allowFailure: true });
    assert.notEqual(shadowInstall.status, 0);
    assert.equal(shadowInstall.payload?.code, 'DISCOVERY_TARGET_UNOWNED');
    assert.equal(fs.readFileSync(shadowSentinel, 'utf8'), 'do-not-overwrite');
    assert.equal(fs.existsSync(shadow.installRoot), false);
    assert.equal(fs.existsSync(shadow.agentsSkill), false);

    const uninstalled = runCli(
      path.join(fresh.agentsSkill, 'scripts', 'zcanvas.cjs'),
      ['skill', 'uninstall'],
      fresh.env,
    );
    assert.equal(uninstalled.payload.data.removed, true);
    assert.equal(fs.existsSync(fresh.installRoot), false);
    assert.equal(fs.existsSync(`${fresh.installRoot}.last-known-good`), false);
    assert.equal(fs.existsSync(fresh.agentsSkill), false);
    assert.equal(fs.existsSync(fresh.codexSkill), false);
    assert.equal(fs.readFileSync(credentials, 'utf8'), 'creator-owned');

    Object.assign(report, {
      passed: true,
      isolatedUserHome: true,
      isolatedCodexHome: true,
      realGlobalSkillTouched: false,
      immutableBundleDigestVerified: true,
      externalTrustPolicyVerified: true,
      ed25519BundleSignatureVerified: true,
      tamperedSignatureFailedClosed: true,
      freshInstallVerified: true,
      managedDiscoveryWrappersExecuted: 2,
      stalePathFallbackDisabled: true,
      updateVerified: {
        from: v1.version,
        to: v2.version,
        masterAndDiscoveryDigestsMatch: true,
      },
      tamperedDigestFailedClosed: true,
      rollbackVerified: {
        restored: v1.version,
        exactSkillDigestRestored: true,
        managedDiscoveryCopiesRestored: 2,
      },
      unownedGlobalSkillFailedClosed: true,
      unownedGlobalSkillPreserved: true,
      uninstallOwnedRootsOnly: true,
      creatorOwnedCredentialsPreserved: true,
      providerCalls: 0,
      canvasWrites: 0,
      electronBuilds: 0,
    });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
