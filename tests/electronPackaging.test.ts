import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

test('encrypted Electron loader only falls back to app require for bare packages', () => {
  const loader = read('../electron/loader.cjs');
  assert.match(loader, /function canFallbackToLoaderRequire/);
  assert.match(loader, /!text\.startsWith\('\.'\)/);
  assert.match(loader, /!path\.isAbsolute\(text\)/);
  assert.match(loader, /if \(!canFallbackToLoaderRequire\(id\)\) throw e;/);
  assert.match(loader, /if \(!canFallbackToLoaderRequire\(request\)\) throw e;/);
  assert.match(loader, /return require\(id\)/);
  assert.match(loader, /return require\.resolve\(request, options\)/);
});

test('clean installs include Three.js typings for Panorama3D type-check', () => {
  const packageJson = JSON.parse(read('../package.json'));
  const lock = read('../package-lock.json');
  const panorama = read('../src/components/nodes/Panorama3DNode.tsx');

  assert.equal(packageJson.devDependencies['@types/three'], '^0.184.1');
  assert.match(lock, /"node_modules\/@types\/three"/);
  assert.doesNotMatch(lock, /registry\.npmmirror\.com/);
  assert.match(panorama, /type ThreeModule = typeof import\('three'\)/);
});

test('dir packaging verification ignores stale release metadata unless update artifacts are required', () => {
  const postBuild = read('../electron/_post_build.cjs');
  const pkg = read('../package.json');
  assert.match(postBuild, /const strict = process\.env\.T8_REQUIRE_UPDATE_ARTIFACTS === '1'/);
  assert.match(postBuild, /const directoryBuild = process\.env\.T8_DIRECTORY_BUILD === '1'/);
  assert.match(pkg, /cross-env T8_DIRECTORY_BUILD=1 node electron\/_post_build\.cjs/);
  assert.match(pkg, /"rebuild:electron": "electron-rebuild -f -w better-sqlite3 --arch x64"/);
  assert.match(pkg, /electron-builder --win --x64 --dir --config\.npmRebuild=false/);
  assert.match(pkg, /electron-builder --win --x64 --config\.npmRebuild=false/);
  assert.match(postBuild, /const hasInstaller = fs\.existsSync\(installer\)/);
  assert.match(postBuild, /const hasBlockmap = fs\.existsSync\(blockmap\)/);
  assert.match(postBuild, /!strict && \(directoryBuild \|\| \(!hasInstaller && !hasBlockmap\)\)/);
  assert.match(postBuild, /skipping installer\/latest\.yml checks for dir build/);
});

test('Electron bytecode compilation is pinned to the project-local locked runtime', () => {
  const packageJson = JSON.parse(read('../package.json'));
  const packageLock = JSON.parse(read('../package-lock.json'));
  const encrypt = read('../electron/encrypt.cjs');

  assert.equal(
    packageJson.scripts.encrypt,
    'cross-env ELECTRON_RUN_AS_NODE=1 node node_modules/electron/cli.js electron/encrypt.cjs',
  );
  assert.equal(
    packageLock.packages['node_modules/electron'].version,
    packageJson.devDependencies.electron.replace(/^\^/, ''),
  );
  assert.match(encrypt, /function assertElectronCompilerRuntime\(\)/);
  assert.match(encrypt, /package-lock=\$\{expected\}, compiler=\$\{actual\}/);
  assert.match(encrypt, /project-local Electron \$\{expected\} is incomplete/);
  assert.match(encrypt, /assertElectronCompilerRuntime\(\);/);
});

test('Electron does not open the renderer before the packaged backend is ready', () => {
  const main = read('../electron/main.cjs');
  assert.match(main, /const backendReady = await waitForBackend\(backendPort, 30\)/);
  assert.match(main, /if \(!backendReady\) throw new Error\(`后端未能在端口 \$\{backendPort\} 就绪`\)/);
  assert.ok(main.indexOf('if (!backendReady)') < main.indexOf('createMainWindow();', main.indexOf('app.whenReady()')));
});

test('Electron package verifies the crash-recovery service used on backend startup', () => {
  const postBuild = read('../electron/_post_build.cjs');
  const server = read('../backend/src/server.js');
  assert.match(postBuild, /services['"], ['"]runRecovery\.t8c/);
  assert.match(server, /getRunRecoveryManager\(\{\}\)\.recoverPendingRuns\(\)/);
  assert.match(server, /\[run-recovery\] startup failed/);
});

test('Electron package locks canvas Agent bytecode and shared node schema to source SHA-256', () => {
  const encrypt = read('../electron/encrypt.cjs');
  const postBuild = read('../electron/_post_build.cjs');
  const schema = JSON.parse(read('../backend/src/shared/canvasNodeSchema.json'));
  const requiredSources = [
    'routes/canvasAgentTools.js',
    'services/canvasAgentTools.js',
    'services/canvasAgentPublicView.js',
    'services/runEvidenceDiagnosis.js',
    'shared/canvasNodeSchema.json',
  ];
  const requiredOutputs = [
    'routes/canvasAgentTools.t8c',
    'services/canvasAgentTools.t8c',
    'services/canvasAgentPublicView.t8c',
    'services/runEvidenceDiagnosis.t8c',
    'shared/canvasNodeSchema.json',
  ];

  assert.equal(schema.schema, 't8-canvas-node-schema-v1');
  assert.equal(schema.version, 1);
  assert.equal(schema.types.length, 69);
  for (const source of requiredSources) assert.ok(encrypt.includes(`source: '${source}'`), source);
  for (const output of requiredOutputs) {
    assert.ok(encrypt.includes(`output: '${output}'`), output);
    assert.ok(postBuild.includes(`output: '${output}'`), output);
  }
  assert.match(encrypt, /writeCanvasAgentIntegrityManifest\(canvasAgentBuildHashes\)/);
  assert.match(encrypt, /const sourceSha256 = sha256Buffer\(sourceBytes\)/);
  assert.match(encrypt, /const canvasAgentBuildHashes = new Map\(\)/);
  assert.match(encrypt, /canvasAgentBuildHashes\.set\(rel, hashes\)/);
  assert.match(encrypt, /captured\.sourceSha256 !== sourceSha256 \|\| captured\.outputSha256 !== outputSha256/);
  assert.match(encrypt, /canvas Agent source\/output changed during encryption/);
  assert.match(encrypt, /item\.format === 'json' && sourceSha256 !== outputSha256/);
  assert.match(postBuild, /function checkCanvasAgentIntegrity\(\)/);
  assert.match(postBuild, /canvas Agent encrypted output was built from stale source/);
  assert.match(postBuild, /canvas Agent packaged output SHA-256 mismatch/);
  assert.match(postBuild, /header !== 'T8ENC1\\n'/);
  assert.match(postBuild, /checkCanvasAgentIntegrity\(\)/);
  assert.match(postBuild, /services['"], ['"]runEvidenceDiagnosis\.t8c/);
});

test('Electron package verifies the intelligent asset center and picker media coverage', () => {
  const packageJson = JSON.parse(read('../package.json'));
  const postBuild = read('../electron/_post_build.cjs');
  const encrypt = read('../electron/encrypt.cjs');
  const main = read('../electron/main.cjs');
  const workbench = read('../src/components/ProjectWorkbench.tsx');
  const assetCenter = read('../src/components/assets/AssetCenter.tsx');
  const semanticResource = packageJson.build.extraResources.find(
    (item: { from?: string; to?: string }) => item.to === 'tools/asset-semantic',
  );

  assert.match(postBuild, /routes['"], ['"]projectAssets\.t8c/);
  assert.match(postBuild, /routes['"], ['"]files\.t8c/);
  assert.match(postBuild, /services['"], ['"]assetIndexer\.t8c/);
  assert.match(postBuild, /services['"], ['"]assetPreviewPipeline\.t8c/);
  assert.match(postBuild, /services['"], ['"]assetSemanticModels\.t8c/);
  assert.match(postBuild, /services['"], ['"]assetSemanticWorker\.t8c/);
  assert.match(postBuild, /services['"], ['"]assetSemanticPipeline\.t8c/);
  assert.match(postBuild, /services['"], ['"]modelPreviewRenderer\.t8c/);
  assert.match(postBuild, /services['"], ['"]assetPublicView\.t8c/);
  assert.match(postBuild, /services['"], ['"]projectDatabase\.t8c/);
  assert.match(postBuild, /services['"], ['"]assetBlobStore\.t8c/);
  assert.match(postBuild, /services['"], ['"]assetUploadManager\.t8c/);
  assert.match(postBuild, /collaboration['"], ['"]gateway\.t8c/);
  assert.match(encrypt, /const backendFiles = walk\(BACKEND_SRC\)/);
  assert.match(postBuild, /tools['"], ['"]asset-semantic['"], ['"]semantic_runner\.py/);
  assert.deepEqual(semanticResource, {
    from: 'tools/asset-semantic',
    to: 'tools/asset-semantic',
    filter: ['semantic_runner.py'],
  });
  assert.match(postBuild, /requiredAssetEncoders = \['libx264', 'aac', 'libwebp'\]/);
  assert.match(main, /\['\.mp3', \{ kind: 'audio'/);
  assert.match(main, /\['\.glb', \{ kind: 'model3d'/);
  assert.match(main, /\['image', 'video', 'audio', 'model3d'\]/);
  assert.match(workbench, /<AssetCenter/);
  assert.match(assetCenter, /kinds: \['image', 'video', 'audio', 'model3d'\]/);
  assert.match(assetCenter, /<AssetSemanticSettingsPanel/);
});

test('Electron release publishing requires explicit per-version approval', () => {
  const distRelease = read('../scripts/dist-release.cjs');
  const githubRelease = read('../scripts/release-github.cjs');
  const releaseProvenance = read('../scripts/release-provenance.cjs');
  const latestYml = read('../scripts/latest-yml.cjs');

  assert.match(distRelease, /const releaseApproval = `release-\$\{pkg\.version\}`/);
  assert.match(distRelease, /function assertReleaseApproval\(\)/);
  assert.match(distRelease, /process\.env\.T8_RELEASE_APPROVAL === releaseApproval/);
  assert.match(distRelease, /refusing to run Electron release without explicit approval/);
  assert.match(distRelease, /only after the user explicitly asks to publish/);
  assert.match(distRelease, /function assertReleaseTarget\(\)/);
  assert.match(distRelease, /T8_RELEASE_TARGET must be the exact 40-character source commit SHA/);
  assert.match(distRelease, /const target = explicitTarget \|\| head/);
  assert.match(distRelease, /\['ls-remote', releaseRemote, 'refs\/heads\/main'\]/);
  assert.match(distRelease, /env\.T8_RELEASE_TARGET = target/);
  assert.match(distRelease, /fixed release target/);
  assert.match(distRelease, /crypto\.randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(distRelease, /T8_RELEASE_BUILD_NONCE/);
  assert.match(distRelease, /removed stale automatic-update artifacts/);
  assert.match(distRelease, /writeReleaseProvenance/);
  assert.match(distRelease, /assertReleaseTarget\(\)/);
  assert.match(distRelease, /github release upload \+ verify/);
  assert.match(distRelease, /run\('rebuild native modules for Electron', command\('npm'\), \['run', 'rebuild:electron'\]\)/);
  assert.match(distRelease, /\['--win', '--x64', '--config\.npmRebuild=false'\]/);

  assert.match(githubRelease, /const releaseApproval = `release-\$\{version\}`/);
  assert.match(githubRelease, /function assertReleaseApproval\(\)/);
  assert.match(githubRelease, /if \(dryRun\) return/);
  assert.match(githubRelease, /process\.env\.T8_RELEASE_APPROVAL === releaseApproval/);
  assert.match(githubRelease, /refusing to publish GitHub Release without explicit approval/);
  assert.match(githubRelease, /formal automatic-update tag must be \$\{expectedTag\}/);
  assert.match(githubRelease, /function assertReleaseGitState\(target\)/);
  assert.match(githubRelease, /refs\/heads\/main/);
  assert.match(githubRelease, /refs\/tags\/\$\{tag\}/);
  assert.match(githubRelease, /source worktree is not release-clean/);
  assert.match(githubRelease, /function existingReleaseMetadata\(\)/);
  assert.match(githubRelease, /published release \$\{tag\} is immutable/);
  assert.match(githubRelease, /creating draft release/);
  assert.match(githubRelease, /'--draft',[\s\S]*'--latest=false'/);
  assert.match(githubRelease, /verifyRelease\('prepublish'\)/);
  assert.match(githubRelease, /'--draft=false',[\s\S]*'--latest'/);
  assert.match(githubRelease, /const publishResult = run\('gh',[\s\S]*\{ allowFailure: true \}/);
  assert.match(githubRelease, /verifyRelease\('final'\)/);
  assert.match(githubRelease, /publish command exited with/);
  assert.match(githubRelease, /returnReleaseToDraft/);
  assert.match(githubRelease, /assertReleaseProvenance/);
  assert.match(githubRelease, /T8_RELEASE_BUILD_NONCE/);
  assert.match(githubRelease, /hashFile\(installer, 'sha512', 'base64'\)/);
  assert.match(githubRelease, /assertLatestYamlArtifact/);
  assert.match(latestYml, /yaml\.load/);
  assert.match(latestYml, /files\.length !== 1/);
  assert.match(releaseProvenance, /t8-electron-release-provenance-v1/);
  assert.match(releaseProvenance, /provenance source target does not match T8_RELEASE_TARGET/);
  assert.match(releaseProvenance, /provenance build nonce does not match this dist:release process/);
  assert.match(releaseProvenance, /artifact provenance mismatch/);

  const require = createRequire(import.meta.url);
  const {
    artifactPaths,
    assertReleaseProvenance,
    writeReleaseProvenance,
  } = require('../scripts/release-provenance.cjs');
  const { assertLatestYamlArtifact } = require('../scripts/latest-yml.cjs');
  const { withReleaseTemp } = require('../scripts/verify-github-release.cjs');
  const fixtureInstallerName = 'T8-ProvenanceFixture-Setup-9.9.9.exe';
  const fixtureInstallerSha512 = 'fixture-installer-sha512';
  const latestFixture = ({
    version = '9.9.9',
    entrySha512 = fixtureInstallerSha512,
    topLevelSha512 = fixtureInstallerSha512,
  } = {}) => [
    `version: ${version}`,
    'files:',
    `  - url: ${fixtureInstallerName}`,
    `    sha512: ${entrySha512}`,
    '    size: 128',
    `path: ${fixtureInstallerName}`,
    `sha512: ${topLevelSha512}`,
    'releaseDate: 2026-07-16T00:00:00.000Z',
  ].join('\n');
  assert.doesNotThrow(() => assertLatestYamlArtifact({
    text: latestFixture(),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }));
  assert.throws(() => assertLatestYamlArtifact({
    text: latestFixture({ version: '9.9.90' }),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /version mismatch/);
  assert.throws(() => assertLatestYamlArtifact({
    text: latestFixture({ version: '[9.9.9]' }),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /version mismatch/);
  assert.throws(() => assertLatestYamlArtifact({
    text: latestFixture().replace(
      `  - url: ${fixtureInstallerName}`,
      `  - url: [${fixtureInstallerName}]`,
    ),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /missing or duplicated/);
  assert.throws(() => assertLatestYamlArtifact({
    text: latestFixture().replace(
      `path: ${fixtureInstallerName}`,
      `path: [${fixtureInstallerName}]`,
    ),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /top-level path mismatch/);
  assert.throws(() => assertLatestYamlArtifact({
    text: latestFixture({
      entrySha512: 'wrong-files-entry-sha512',
      topLevelSha512: fixtureInstallerSha512,
    }),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /sha512 mismatch/);
  assert.throws(() => assertLatestYamlArtifact({
    text: [
      'version: 9.9.9',
      'unrelated:',
      `  - url: ${fixtureInstallerName}`,
      `    sha512: ${fixtureInstallerSha512}`,
      '    size: 128',
      'files:',
      '  - url: wrong-installer.exe',
      `    sha512: ${fixtureInstallerSha512}`,
      '    size: 128',
      `path: ${fixtureInstallerName}`,
      `sha512: ${fixtureInstallerSha512}`,
    ].join('\n'),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /missing or duplicated/);
  assert.throws(() => assertLatestYamlArtifact({
    text: latestFixture().replace(
      `    sha512: ${fixtureInstallerSha512}`,
      [
        '    sha512: wrong-files-entry-sha512',
        '    metadata:',
        `      sha512: ${fixtureInstallerSha512}`,
      ].join('\n'),
    ),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /installer sha512 mismatch/);
  assert.throws(() => assertLatestYamlArtifact({
    text: latestFixture().replace(
      [
        `    sha512: ${fixtureInstallerSha512}`,
        '    size: 128',
      ].join('\n'),
      [
        '    metadata:',
        `      sha512: ${fixtureInstallerSha512}`,
        '      size: 128',
      ].join('\n'),
    ),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /installer sha512 is missing/);
  assert.throws(() => assertLatestYamlArtifact({
    text: latestFixture().replace(
      `  - url: ${fixtureInstallerName}`,
      [
        '  - url: unexpected-first-installer.exe',
        `    sha512: ${fixtureInstallerSha512}`,
        '    size: 128',
        `  - url: ${fixtureInstallerName}`,
      ].join('\n'),
    ),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /exactly one entry/);
  assert.throws(() => assertLatestYamlArtifact({
    text: `${latestFixture()}\nversion: 9.9.9`,
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /YAML parse failed/);
  assert.throws(() => assertLatestYamlArtifact({
    text: latestFixture().replace(
      `    size: 128`,
      `    size: 128\n    size: 128`,
    ),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /YAML parse failed/);
  assert.throws(() => assertLatestYamlArtifact({
    text: `${latestFixture()}\nfiles:\n  - url: duplicate.exe`,
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /YAML parse failed/);
  assert.throws(() => assertLatestYamlArtifact({
    text: latestFixture().replace(
      `\nsha512: ${fixtureInstallerSha512}\n`,
      '\nsha512: wrong-top-level-sha512\n',
    ),
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /top-level sha512 mismatch/);
  assert.throws(() => assertLatestYamlArtifact({
    text: `${latestFixture()}\nbad: [`,
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /YAML parse failed/);
  assert.throws(() => assertLatestYamlArtifact({
    text: `${latestFixture()}\n---\nversion: 9.9.9`,
    version: '9.9.9',
    installerName: fixtureInstallerName,
    installerSha512: fixtureInstallerSha512,
    installerSize: 128,
  }), /YAML parse failed/);
  let failedVerifyTemp = '';
  assert.throws(() => withReleaseTemp((tempDir: string) => {
    failedVerifyTemp = tempDir;
    writeFileSync(join(tempDir, 'partial-installer.exe'), Buffer.alloc(16));
    throw new Error('fixture verification failure');
  }), /fixture verification failure/);
  assert.equal(existsSync(failedVerifyTemp), false);
  const fixtureRoot = mkdtempSync(join(tmpdir(), 't8-release-provenance-'));
  const fixturePackage = { version: '9.9.9', build: { productName: 'T8-ProvenanceFixture' } };
  const target = 'c'.repeat(40);
  const nonce = 'ab'.repeat(32);
  try {
    const paths = artifactPaths(fixtureRoot, fixturePackage);
    mkdirSync(paths.distDir, { recursive: true });
    for (const [index, artifact] of paths.artifacts.entries()) {
      writeFileSync(artifact.path, Buffer.alloc(128 + index, index + 1));
    }
    writeReleaseProvenance({
      root: fixtureRoot,
      pkg: fixturePackage,
      target,
      nonce,
    });
    assert.equal(assertReleaseProvenance({
      root: fixtureRoot,
      pkg: fixturePackage,
      target,
      nonce,
    }).target, target);
    assert.throws(() => assertReleaseProvenance({
      root: fixtureRoot,
      pkg: fixturePackage,
      target,
      nonce: 'de'.repeat(32),
    }), /build nonce/);
    writeFileSync(paths.artifacts[1].path, Buffer.from('changed blockmap'));
    assert.throws(() => assertReleaseProvenance({
      root: fixtureRoot,
      pkg: fixturePackage,
      target,
      nonce,
    }), /artifact provenance mismatch/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Electron release verifies packaged media and offline runtime sidecars', () => {
  const packageJson = JSON.parse(read('../package.json'));
  const files = packageJson.build.files;
  const resources = packageJson.build.extraResources.map((item: any) => `${item.from}->${item.to}`);
  const ffmpegResource = packageJson.build.extraResources.find((item: any) => item.to === 'tools/ffmpeg');
  const llmMedia = read('../backend/src/providers/llmMedia.js');

  assert.equal(packageJson.build.compression, 'normal');
  assert.ok(files.includes('!node_modules/@ffmpeg-installer/**/*'));
  assert.ok(resources.includes('tools/ffmpeg-runtime->tools/ffmpeg'));
  const sharedResource = packageJson.build.extraResources.find((item: any) => item.to === 'shared');
  assert.deepEqual(ffmpegResource.filter, ['ffmpeg.exe', 'ffmpeg', 'ffprobe.exe', 'ffprobe', 'README.md']);
  assert.ok(sharedResource.filter.includes('videoTransitions.json'));
  assert.match(llmMedia, /resRoot && path\.join\(resRoot, 'tools', 'ffmpeg', binary\)/);
  assert.match(llmMedia, /function resolveBundledFfprobe\(\)/);
  assert.match(llmMedia, /resRoot && path\.join\(resRoot, 'tools', 'ffmpeg', binary\)/);
  assert.match(llmMedia, /ffprobeBinaryName/);
  assert.match(llmMedia, /optional dev fallback only/);

  const postBuild = read('../electron/_post_build.cjs');
  const runtimeArchivePrep = read('../scripts/prepare-runtime-archives.cjs');
  assert.match(postBuild, /function loadPackagedVideoTransitions\(\)/);
  assert.match(postBuild, /videoTransitions\.json/);
  assert.match(postBuild, /for \(const transition of loadPackagedVideoTransitions\(\)\)/);
  assert.match(postBuild, /transition\.quality !== 'native-xfade'/);
  assert.match(postBuild, /transition\.xfade/);
  assert.match(postBuild, /missingTransitions/);
  assert.match(postBuild, /function checkFfprobeRuntime\(\)/);
  assert.match(postBuild, /ffprobe/);
  assert.match(postBuild, /show_format/);
  assert.match(postBuild, /packaged ffprobe JSON probe verified/);
  assert.match(runtimeArchivePrep, /function assertStrictRuntimeSource\(/);
  assert.match(runtimeArchivePrep, /python\/Scripts\/remove-ai-watermarks\.exe/);
  assert.match(runtimeArchivePrep, /parsehub\/__init__\.py/);
  assert.match(runtimeArchivePrep, /minimumSourceFiles: 40_000/);
  assert.match(runtimeArchivePrep, /archiveSha256: sha256File\(archivePath\)/);
  assert.match(runtimeArchivePrep, /sourceSha256: sourceHash\.digest\('hex'\)/);
  assert.match(runtimeArchivePrep, /String\(entry\.sourceSha256\)\.toLowerCase\(\) === sourceStats\.sourceSha256/);
  assert.ok(runtimeArchivePrep.includes("if (!/^[a-f0-9]{64}$/i.test(String(entry.archiveSha256 || ''))) return true;"));
  assert.match(postBuild, /function verifyPackagedRuntimeArchive\(/);
  assert.match(postBuild, /minimumArchiveBytes: 500_000_000/);
  assert.match(postBuild, /entry\.sourceSha256/);
  assert.match(postBuild, /spawnSync\(path7za, \['t'/);
  assert.match(postBuild, /packaged runtime archive is missing required entries/);
  assert.match(postBuild, /archive SHA-256, CRC and required entries verified/);
  assert.match(postBuild, /if \(archiveStrict\) \{[\s\S]*verifyPackagedRuntimeArchive\([\s\S]*verifyDirectAiWatermarkRuntime\(runtimeRoot\)/);
  assert.match(postBuild, /if \(archiveStrict\) \{[\s\S]*verifyPackagedRuntimeArchive\([\s\S]*verifyDirectParseHubRuntime\(libsRoot\)/);
  assert.match(postBuild, /function verifyDirectAiWatermarkRuntime\(/);
  assert.match(postBuild, /function verifyDirectParseHubRuntime\(/);

  const fixtureRoot = mkdtempSync(join(tmpdir(), 't8-runtime-gate-'));
  const postBuildPath = fileURLToPath(new URL('../electron/_post_build.cjs', import.meta.url));
  const runHelper = (helper: string, env: Record<string, string>) => spawnSync(
    process.execPath,
    ['-e', `require(${JSON.stringify(postBuildPath)}).${helper}(${JSON.stringify(fixtureRoot)})`],
    {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  try {
    const aiRoot = join(fixtureRoot, 'tools', 'remove-ai-watermarks');
    mkdirSync(aiRoot, { recursive: true });
    writeFileSync(join(aiRoot, 'remove-ai-watermarks.exe'), Buffer.alloc(32 * 1024, 1));
    writeFileSync(join(aiRoot, 'runtime-manifest.json'), '{}');
    const strictArchiveFirst = runHelper('checkAiWatermarkRuntime', {
      T8_REQUIRE_AI_WATERMARK_RUNTIME: '1',
      T8_REQUIRE_RUNTIME_ARCHIVES: '1',
    });
    assert.equal(strictArchiveFirst.status, 1, strictArchiveFirst.stderr || strictArchiveFirst.stdout);
    assert.match(
      `${strictArchiveFirst.stdout}\n${strictArchiveFirst.stderr}`,
      /packaged runtime archive is missing/,
    );

    writeFileSync(join(aiRoot, 'remove-ai-watermarks.exe'), Buffer.from([1]));
    const tinyDirectAi = runHelper('checkAiWatermarkRuntime', {
      T8_REQUIRE_AI_WATERMARK_RUNTIME: '1',
      T8_REQUIRE_RUNTIME_ARCHIVES: '0',
    });
    assert.equal(tinyDirectAi.status, 1, tinyDirectAi.stderr || tinyDirectAi.stdout);
    assert.match(
      `${tinyDirectAi.stdout}\n${tinyDirectAi.stderr}`,
      /direct remove-ai-watermarks runtime is incomplete or implausibly small/,
    );

    const parseBridge = join(fixtureRoot, 'tools', 'parsehub-bridge');
    const parseLibs = join(fixtureRoot, 'tools', 'parsehub-pythonlibs');
    mkdirSync(parseBridge, { recursive: true });
    mkdirSync(parseLibs, { recursive: true });
    writeFileSync(join(parseBridge, 'parsehub_bridge.py'), '# fixture');
    const emptyDirectParseHub = runHelper('checkParseHubRuntime', {
      T8_REQUIRE_PARSEHUB_RUNTIME: '1',
      T8_REQUIRE_RUNTIME_ARCHIVES: '0',
    });
    assert.equal(emptyDirectParseHub.status, 1, emptyDirectParseHub.stderr || emptyDirectParseHub.stdout);
    assert.match(
      `${emptyDirectParseHub.stdout}\n${emptyDirectParseHub.stderr}`,
      /direct ParseHub runtime is incomplete or implausibly small/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Electron packaging verifies encrypted local extension hook points', () => {
  const postBuild = read('../electron/_post_build.cjs');
  const encrypt = read('../electron/encrypt.cjs');

  assert.match(postBuild, /extensions['"], ['"]runtimeHooks\.t8c/);
  assert.match(postBuild, /routes['"], ['"]figma\.t8c/);
  assert.match(postBuild, /routes['"], ['"]grokOAuth\.t8c/);
  assert.match(postBuild, /routes['"], ['"]codexCli\.t8c/);
  assert.match(postBuild, /utils['"], ['"]codexCliRunner\.t8c/);
  assert.match(postBuild, /utils['"], ['"]figmaBridge\.t8c/);
  assert.match(postBuild, /checkFigmaBridgeRuntime/);
  assert.match(postBuild, /tools['"], ['"]figma-bridge/);
  assert.match(encrypt, /const LOCAL_PRIVATE_BACKEND_DIRS = \[/);
  assert.match(encrypt, /path\.join\(LOCAL_PRIVATE_SRC, 'extensions', 'backend'\)/);
  assert.match(encrypt, /path\.join\(LOCAL_PRIVATE_SRC, 'recharge', 'backend'\)/);
  assert.doesNotMatch(encrypt, /walk\(LOCAL_PRIVATE_SRC\)/);
  const packageJson = JSON.parse(read('../package.json'));
  const resources = packageJson.build.extraResources.map((item: any) => `${item.from}->${item.to}`);
  assert.ok(resources.includes('tools/figma-bridge->tools/figma-bridge'));
  const localHook = new URL('../local-private/extensions/build/post-build.cjs', import.meta.url);
  if (existsSync(localHook)) {
    const localPostBuild = read('../local-private/extensions/build/post-build.cjs');
    assert.match(localPostBuild, /zhenzhenGroups\.t8c/);
    assert.match(localPostBuild, /private New API group source must be encrypted/);
    assert.match(localPostBuild, /backend-enc['"], ['"]local-private/);
  }
});

test('formal Electron releases fail closed when required private sidecars are missing', () => {
  const distRelease = read('../scripts/dist-release.cjs');
  const viteConfig = read('../vite.config.ts');
  const encrypt = read('../electron/encrypt.cjs');
  const postBuild = read('../electron/_post_build.cjs');

  assert.match(distRelease, /T8_REQUIRE_AI_WATERMARK_RUNTIME:\s*['"]1['"]/);
  assert.match(distRelease, /T8_REQUIRE_PARSEHUB_RUNTIME:\s*['"]1['"]/);
  assert.match(distRelease, /T8_REQUIRE_RUNTIME_ARCHIVES:\s*['"]1['"]/);
  assert.match(distRelease, /T8_REQUIRE_UPDATE_ARTIFACTS:\s*['"]1['"]/);
  assert.match(distRelease, /T8_REQUIRE_LOCAL_PRIVATE:\s*['"]1['"]/);
  assert.match(distRelease, /T8_ENABLE_LOCAL_PRIVATE:\s*['"]1['"]/);
  assert.match(distRelease, /T8_DISABLE_LOCAL_EXTENSIONS:\s*['"]0['"]/);
  assert.doesNotMatch(distRelease, /T8_REQUIRE_[A-Z_]+:\s*process\.env\./);

  assert.match(viteConfig, /LOCAL_REQUIRED_FRONTEND_ENTRY/);
  assert.match(viteConfig, /process\.env\.T8_REQUIRE_LOCAL_PRIVATE !== ['"]1['"]/);
  assert.match(viteConfig, /formal release requires local private frontend/);
  assert.match(viteConfig, /formal release cannot disable local private extensions/);

  assert.match(encrypt, /REQUIRED_LOCAL_PRIVATE_BACKEND/);
  assert.match(encrypt, /REQUIRED_LOCAL_PRIVATE_OUTPUT/);
  assert.match(encrypt, /recharge['"], ['"]backend['"], ['"]routes\.cjs/);
  assert.match(encrypt, /recharge['"], ['"]backend['"], ['"]routes\.t8c/);
  assert.match(encrypt, /formal release requires local private backend/);
  assert.match(encrypt, /local private bytecode missing after encryption/);

  assert.match(postBuild, /const required = process\.env\.T8_REQUIRE_LOCAL_PRIVATE === ['"]1['"]/);
  assert.match(postBuild, /formal release cannot disable local private build hook/);
  assert.match(postBuild, /formal release requires local private build hook/);
  assert.match(postBuild, /function checkRequiredLocalPrivateArtifacts\(\)/);
  assert.match(postBuild, /formal release missing encrypted local private backend/);
  assert.match(postBuild, /formal release leaked local private backend source/);
  assert.match(postBuild, /local-private['"], ['"]recharge['"], ['"]backend['"], ['"]routes\.t8c/);
  assert.match(postBuild, /checkRequiredLocalPrivateArtifacts\(\)/);
});
