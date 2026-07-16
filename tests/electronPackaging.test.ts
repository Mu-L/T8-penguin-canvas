import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

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

  assert.match(distRelease, /const releaseApproval = `release-\$\{pkg\.version\}`/);
  assert.match(distRelease, /function assertReleaseApproval\(\)/);
  assert.match(distRelease, /process\.env\.T8_RELEASE_APPROVAL === releaseApproval/);
  assert.match(distRelease, /refusing to run Electron release without explicit approval/);
  assert.match(distRelease, /only after the user explicitly asks to publish/);
  assert.match(distRelease, /github release upload \+ verify/);

  assert.match(githubRelease, /const releaseApproval = `release-\$\{version\}`/);
  assert.match(githubRelease, /function assertReleaseApproval\(\)/);
  assert.match(githubRelease, /if \(dryRun\) return/);
  assert.match(githubRelease, /process\.env\.T8_RELEASE_APPROVAL === releaseApproval/);
  assert.match(githubRelease, /refusing to publish GitHub Release without explicit approval/);
});

test('Electron release keeps one packaged ffmpeg runtime and excludes installer duplicate', () => {
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

  assert.match(distRelease, /T8_REQUIRE_LOCAL_PRIVATE:\s*['"]1['"]/);

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
