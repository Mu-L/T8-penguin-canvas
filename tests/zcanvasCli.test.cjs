'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'tools', 'zcanvas-cli', 'bin', 'zcanvas.cjs');
const wrapper = path.join(root, '.agents', 'skills', 'zhenzhen-canvas', 'scripts', 'zcanvas.cjs');

function run(file, args = [], env = {}) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: { ...process.env, ...env },
  });
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null,
  };
}

test('zcanvas version returns the versioned agent-control envelope', () => {
  const result = run(cli, ['version']);
  assert.equal(result.status, 0);
  assert.equal(result.json.schema, 't8-agent-control-response-v1');
  assert.equal(result.json.ok, true);
  assert.equal(result.json.data.controlProtocol, 't8-agent-control-v1');
  assert.equal(result.json.data.canvasPatchProtocol, 't8-canvas-patch-v1');
  assert.equal(result.json.data.skillName, 'zhenzhen-canvas');
});

test('zcanvas capabilities separates implementation from current runtime availability', () => {
  const result = run(cli, ['capabilities'], {
    ZCANVAS_INSTANCE_DIR: path.join(root, '.zcanvas-test-empty-capability-registry'),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(
    result.json.data.implemented,
    [
      'help', 'version', 'capabilities', 'status', 'skill', 'app', 'auth', 'workspace',
      'doctor', 'patch', 'graph', 'asset', 'delivery', 'model', 'media', 'run', 'ask', 'continue',
      'sessions', 'recipe', 'create', 'edit', 'iterate', 'story', 'director', 'video-edit', 'browser',
    ],
  );
  assert.equal(result.json.data.semantics, 'implementation-and-runtime-availability');
  assert.equal(result.json.data.appConnected, false);
  assert.deepEqual(result.json.data.runtimeAvailable, ['help', 'version', 'capabilities', 'status', 'skill', 'app', 'sessions']);
  assert.deepEqual(result.json.data.planned, []);
  assert.equal(
    result.json.data.creativeCapabilityCoverage.counts.operations,
    result.json.data.creativeCapabilities.reduce(
      (sum, capability) => sum + capability.operations.length,
      0,
    ),
  );
  assert.deepEqual(
    result.json.data.creativeCapabilityCoverage.coverageReceipt.inventory.nodes,
    { total: 72, executable: 53, generatable: 8 },
  );
  assert.deepEqual(
    result.json.data.creativeCapabilityCoverage.coverageReceipt.inventory.runtime,
    { llm: 29, image: 28, video: 88, audio: 8, actions: 47 },
  );
  assert.equal(result.json.data.creativeCapabilityCoverage.coverageReceipt.complete, true);
  assert.equal(result.json.data.creativeCapabilityCoverage.counts.missingOperationRisk, 0);
  assert.deepEqual(result.json.data.creativeCapabilityCoverage.staticRuntime, {
    known: 200,
    executable: 0,
    requiresLiveReadiness: 200,
  });
  assert.equal(
    result.json.data.creativeCapabilities.every((item) => item.operations.length === item.supports.length),
    true,
  );
  assert.equal(result.json.data.creativeCapabilityGraphReady, false);
  assert.equal(result.json.data.creativeRuntimeReadiness, null);
  assert.ok(result.json.data.operations.some((item) =>
    item.operation === 'browser.screenshot'
    && item.evidence.includes('handoff-contract-tested')));
  assert.ok(result.json.data.operations.some((item) =>
    item.operation === 'create.audio'
    && item.verified === true));
  assert.ok(result.json.data.operations.some((item) =>
    item.operation === 'doctor.simulate'
    && item.implemented === true
    && item.verified === true
    && item.requires.includes('desktop-instance')));
  assert.ok(result.json.data.operations.some((item) =>
    item.operation === 'asset.place'
    && item.implemented === true));
  assert.ok(result.json.data.operations.some((item) =>
    item.operation === 'media.extract-frames'
    && item.verified === true));
});

test('capability runtime accepts matching live readiness and fails closed on graph drift', async () => {
  const { capabilityRuntime } = require('../tools/zcanvas-cli/src/cli.cjs');
  const { readManifest } = require('../tools/zcanvas-cli/src/manifest.cjs');
  const manifest = readManifest();
  const instance = { instanceId: 'instance-runtime', origin: 'http://127.0.0.1:18766' };
  const baseOptions = {
    selectInstance: async () => instance,
    loadSession: () => ({ accessToken: 'a'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' }),
    getWorkspaceContext: () => ({ projectId: 'project-local', canvasId: 'canvas-runtime' }),
    now: () => 1,
  };
  const live = await capabilityRuntime([instance], {
    ...baseOptions,
    requestAgentControl: async (_instance, pathname) => pathname.endsWith('/session')
      ? { data: { scopes: ['canvas:read'] } }
      : {
          data: {
            schema: 't8-creative-capability-manifest-v1',
            capabilityGraph: {
              schema: 't8-creative-capability-graph-v1',
              aggregateDigest: manifest.creativeCapabilityGraphDigest,
              artifactDigest: manifest.creativeCapabilityGraphArtifactDigest,
              counts: { missingOperationRisk: 0 },
              readinessSummary: { known: 193, executable: 128, blocked: 65 },
            },
          },
        },
  });
  assert.equal(live.pairingAuthenticated, true);
  assert.equal(live.workspaceBound, true);
  assert.equal(live.creativeCapabilityGraphReady, true);
  assert.deepEqual(live.creativeRuntimeReadiness, { known: 193, executable: 128, blocked: 65 });
  assert.equal(live.creativeCapabilityRuntimeError, null);

  const drifted = await capabilityRuntime([instance], {
    ...baseOptions,
    requestAgentControl: async (_instance, pathname) => pathname.endsWith('/session')
      ? { data: { scopes: ['canvas:read'] } }
      : {
          data: {
            schema: 't8-creative-capability-manifest-v1',
            capabilityGraph: {
              schema: 't8-creative-capability-graph-v1',
              aggregateDigest: '0'.repeat(64),
              artifactDigest: manifest.creativeCapabilityGraphArtifactDigest,
              counts: { missingOperationRisk: 0 },
              readinessSummary: { known: 193, executable: 0, blocked: 193 },
            },
          },
        },
  });
  assert.equal(drifted.pairingAuthenticated, true);
  assert.equal(drifted.creativeCapabilityGraphReady, false);
  assert.equal(drifted.creativeRuntimeReadiness, null);
  assert.equal(drifted.creativeCapabilityRuntimeError.code, 'CREATIVE_CAPABILITY_DRIFT');
});

test('capability matrix requires a live pairing and workspace before business operations', () => {
  const { operationCapabilities } = require('../tools/zcanvas-cli/src/cli.cjs');
  const unpaired = operationCapabilities({
    instanceSelected: true,
    pairingAuthenticated: false,
    workspaceBound: false,
    hostChromeAvailable: false,
    scopes: [],
  });
  const byName = (items, operation) => items.find((item) => item.operation === operation);

  assert.equal(byName(unpaired, 'auth.pair').runtimeAvailable, true);
  assert.equal(byName(unpaired, 'workspace.list').runtimeAvailable, false);
  assert.deepEqual(byName(unpaired, 'workspace.list').missing, ['pairing', 'scope:canvas:read']);
  assert.equal(byName(unpaired, 'ask').runtimeAvailable, false);
  assert.deepEqual(byName(unpaired, 'ask').missing, ['pairing', 'workspace-context', 'scope:canvas:read']);
  assert.equal(byName(unpaired, 'browser.open').runtimeAvailable, false);
  assert.deepEqual(
    byName(unpaired, 'browser.open').missing,
    ['pairing', 'workspace-context', 'scope:browser:handoff', 'host-chrome-capability'],
  );

  const pairedWithoutWorkspace = operationCapabilities({
    instanceSelected: true,
    pairingAuthenticated: true,
    workspaceBound: false,
    hostChromeAvailable: false,
    scopes: ['canvas:read'],
  });
  assert.equal(byName(pairedWithoutWorkspace, 'workspace.list').runtimeAvailable, true);
  assert.equal(byName(pairedWithoutWorkspace, 'workspace.use').runtimeAvailable, true);
  assert.deepEqual(
    byName(pairedWithoutWorkspace, 'workspace.list').requires,
    ['desktop-instance', 'pairing', 'canvas:read'],
  );
  assert.deepEqual(byName(pairedWithoutWorkspace, 'workspace.list').missing, []);
  assert.equal(byName(pairedWithoutWorkspace, 'workspace.current').runtimeAvailable, false);
  assert.deepEqual(byName(pairedWithoutWorkspace, 'workspace.current').missing, ['workspace-context']);

  const paired = operationCapabilities({
    instanceSelected: true,
    pairingAuthenticated: true,
    workspaceBound: true,
    hostChromeAvailable: false,
    scopes: [
      'canvas:read',
      'canvas:write',
      'run:read',
      'run:execute',
      'asset:read',
      'asset:transfer',
    ],
  });
  assert.equal(byName(paired, 'ask').runtimeAvailable, true);
  assert.equal(byName(paired, 'delivery.package').runtimeAvailable, true);
  assert.equal(byName(paired, 'browser.highlight').runtimeAvailable, false);
  assert.deepEqual(
    byName(paired, 'browser.highlight').missing,
    ['scope:browser:handoff', 'host-chrome-capability'],
  );

  const readOnly = operationCapabilities({
    instanceSelected: true,
    pairingAuthenticated: true,
    workspaceBound: true,
    hostChromeAvailable: false,
    scopes: ['canvas:read', 'run:read', 'asset:read'],
  });
  assert.equal(byName(readOnly, 'ask').runtimeAvailable, true);
  assert.equal(byName(readOnly, 'doctor.inspect').runtimeAvailable, true);
  assert.equal(byName(readOnly, 'create.image').runtimeAvailable, false);
  assert.deepEqual(byName(readOnly, 'create.image').missing, ['scope:canvas:write']);
  assert.equal(byName(readOnly, 'create.image').requires.includes('configured-provider'), false);
  assert.equal(byName(readOnly, 'create.image').requires.includes('explicit-run-approval'), false);
  assert.equal(byName(readOnly, 'run.start').runtimeAvailable, false);
  assert.deepEqual(byName(readOnly, 'run.start').missing, ['scope:run:execute']);
  assert.equal(byName(readOnly, 'asset.download').runtimeAvailable, false);
  assert.deepEqual(byName(readOnly, 'asset.download').missing, ['scope:asset:transfer']);
});

test('CLI help and packaged manifest share one top-level command inventory', () => {
  const { COMMANDS } = require('../tools/zcanvas-cli/src/cli.cjs');
  const { readManifest } = require('../tools/zcanvas-cli/src/manifest.cjs');
  const manifest = readManifest();
  assert.deepEqual(manifest.commands, COMMANDS.map((item) => item.name));
  assert.match(manifest.commandCatalogDigest, /^[a-f0-9]{64}$/);
});

test('delivery verification accepts a separately pinned digest flag', () => {
  const { parseArgs } = require('../tools/zcanvas-cli/src/args.cjs');
  const digest = 'a'.repeat(64);
  const parsed = parseArgs(['delivery', 'verify', '--from', 'C:\\delivery', '--digest', digest]);
  assert.deepEqual(parsed.positionals, ['delivery', 'verify']);
  assert.equal(parsed.flags.get('from'), 'C:\\delivery');
  assert.equal(parsed.flags.get('digest'), digest);
});

test('local media commands map exact bounded inputs to their dedicated creative actions', () => {
  const { parseArgs } = require('../tools/zcanvas-cli/src/args.cjs');
  const { localMediaCreativeRequest } = require('../tools/zcanvas-cli/src/cli.cjs');
  assert.deepEqual(
    localMediaCreativeRequest('extract-frames', parseArgs(['--node', 'video-a', '--count', '6'])),
    { action: 'video.extract-frames', input: { sourceNodeId: 'video-a', count: 6 } },
  );
  assert.deepEqual(
    localMediaCreativeRequest('remove-solid-background', parseArgs(['--source', 'image-a'])),
    { action: 'image.remove-solid-background', input: { sourceNodeId: 'image-a' } },
  );
  assert.deepEqual(
    localMediaCreativeRequest('resample-upscale', parseArgs(['--node', 'image-a', '--scale', '1.5'])),
    { action: 'image.resample-upscale', input: { sourceNodeId: 'image-a', scale: 1.5 } },
  );
  assert.throws(
    () => localMediaCreativeRequest('extract-frames', parseArgs(['--node', 'video-a', '--count', '21'])),
    (error) => error.code === 'USAGE_ERROR' && /1-20/.test(error.message),
  );
});

test('zcanvas status fails closed until local app discovery is implemented', () => {
  const result = run(cli, ['status'], {
    ZCANVAS_INSTANCE_DIR: path.join(root, '.zcanvas-test-empty-status-registry'),
  });
  assert.equal(result.status, 3);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, 'APP_NOT_RUNNING');
  assert.equal(result.json.data.cliReady, true);
  assert.equal(result.json.data.appConnected, false);
  assert.equal(result.json.data.recovery.existingWorkSafe, true);
  assert.match(result.json.data.recovery.existingWorkState, /没有执行画布写入或 Provider 请求/);
});

test('creator-facing failures explain what failed, whether existing work is safe, and how to continue', () => {
  const { creatorRecoveryForError } = require('../tools/zcanvas-cli/src/cli.cjs');
  const disconnected = creatorRecoveryForError({ code: 'APP_NOT_RUNNING' });
  assert.match(disconnected.whatFailed, /没有连接/);
  assert.equal(disconnected.existingWorkSafe, true);
  assert.match(disconnected.existingWorkState, /没有执行画布写入或 Provider 请求/);
  assert.equal(disconnected.nextActions.length, 1);

  const timeout = creatorRecoveryForError({
    code: 'RUN_WATCH_TIMEOUT',
    details: { intentId: 'intent-a', cursor: '12:4:running:run-a' },
  });
  assert.match(timeout.whatFailed, /观察已超时/);
  assert.match(timeout.existingWorkState, /原 intent\/cursor 继续观察/);
  assert.equal(timeout.duplicateSubmissionPrevented, true);

  const unsignedBundle = creatorRecoveryForError({ code: 'INSTALL_BUNDLE_SIGNATURE_REQUIRED' });
  assert.match(unsignedBundle.whatFailed, /签名/);
  assert.match(unsignedBundle.existingWorkState, /当前版本.*保持不变/);
  assert.match(unsignedBundle.nextActions[0], /官方签名/);

  const unownedDiscovery = creatorRecoveryForError({ code: 'DISCOVERY_TARGET_UNOWNED' });
  assert.match(unownedDiscovery.whatFailed, /不属于当前安装/);
  assert.match(unownedDiscovery.existingWorkState, /没有覆盖/);

  const rollback = creatorRecoveryForError({ code: 'INSTALL_ROLLBACK_FAILED' });
  assert.match(rollback.whatFailed, /原子恢复/);
  assert.match(rollback.nextActions[0], /skill verify/);
});

test('run watch recovery never treats an unverified Provider completion as a finished work', () => {
  const { runWatchEnvelope } = require('../tools/zcanvas-cli/src/cli.cjs');
  const pending = runWatchEnvelope({
    id: 'intent-a',
    status: 'completed',
    completionVerified: false,
    queueRevision: 8,
    updatedAt: 123,
    runId: 'run-a',
  }, 'watch', 1);
  assert.equal(pending.ok, false);
  assert.equal(pending.code, 'RUN_ARTIFACT_VERIFICATION_PENDING');
  assert.equal(pending.data.watch.stage, 'artifact-verification');
  assert.equal(pending.data.recovery.existingWorkSafe, true);
  assert.match(pending.data.recovery.existingWorkState, /不会被误报为成功/);
  assert.match(pending.nextActions[0], /不要重新提交 Provider/);

  const failed = runWatchEnvelope({
    id: 'intent-b',
    status: 'failed',
    completionVerified: false,
    queueRevision: 9,
    updatedAt: 456,
    runId: 'run-b',
  }, 'resume', 2);
  assert.equal(failed.data.recovery.duplicateSubmissionPrevented, true);
  assert.match(failed.data.recovery.existingWorkState, /已成功并验证的素材继续保留/);
  assert.match(failed.nextActions[0], /只重试失败范围/);
});

test('run watch streams changed snapshots immediately and resumes after the supplied cursor', async () => {
  const {
    runWatchCursor,
    watchRunIntent,
  } = require('../tools/zcanvas-cli/src/cli.cjs');
  const snapshots = [
    {
      id: 'intent-stream',
      status: 'queued',
      queueRevision: 1,
      updatedAt: 100,
      runId: 'run-stream',
      completionVerified: false,
    },
    {
      id: 'intent-stream',
      status: 'running',
      queueRevision: 2,
      updatedAt: 200,
      runId: 'run-stream',
      completionVerified: false,
    },
    {
      id: 'intent-stream',
      status: 'completed',
      queueRevision: 3,
      updatedAt: 300,
      runId: 'run-stream',
      completionVerified: true,
    },
  ];
  const emitted = [];
  const pending = [...snapshots];
  const events = await watchRunIntent(null, null, {}, 'intent-stream', {
    action: 'resume',
    cursor: runWatchCursor(snapshots[0]),
    intervalMs: 250,
    timeoutMs: 1_000,
    fetchIntent: async () => pending.shift(),
    sleep: async () => {},
    onEvent: async (event) => {
      emitted.push(event.data.status);
    },
  });
  assert.deepEqual(emitted, ['running', 'completed']);
  assert.deepEqual(events.map((event) => event.data.status), ['running', 'completed']);
  assert.equal(events[1].data.watch.cursor, runWatchCursor(snapshots[2]));
  assert.equal(events[1].data.watch.terminal, true);
});

test('zcanvas rejects unknown flags and commands with stable JSON errors', () => {
  const flag = run(cli, ['--unsafe']);
  assert.equal(flag.status, 2);
  assert.equal(flag.json.code, 'USAGE_ERROR');

  const command = run(cli, ['not-a-command']);
  assert.equal(command.status, 2);
  assert.equal(command.json.code, 'USAGE_ERROR');
});

test('zcanvas exposes creator commands without treating a missing app as a successful mutation', () => {
  const result = run(cli, [
    'create', 'story',
    '--prompt', '雨夜追逐',
    '--duration', '60',
    '--ratio', '16:9',
    '--llm-provider', 'zhenzhen',
    '--llm-model', 'gemini-3.5-flash',
    '--image-provider', 'zhenzhen',
    '--image-model', 'zhenzhen-image-g2-t2i',
    '--video-provider', 'zhenzhen',
    '--video-model', 'doubao-seedance-2-0-fast-260128',
  ], {
    ZCANVAS_INSTANCE_DIR: path.join(root, '.zcanvas-test-empty-creator-registry'),
  });
  assert.equal(result.status, 3);
  assert.equal(result.json.code, 'APP_NOT_RUNNING');
  assert.equal(result.json.ok, false);
});

test('every catalog command with subcommands passes the shared positional gate', () => {
  const emptyRegistry = path.join(root, '.zcanvas-test-empty-subcommand-registry');
  for (const [command, subcommand] of [
    ['graph', 'add'],
    ['graph', 'connect'],
    ['delivery', 'collect'],
    ['edit', 'image'],
    ['story', 'inspect'],
    ['asset', 'place'],
    ['media', 'extract-frames'],
    ['media', 'remove-solid-background'],
  ]) {
    const result = run(cli, [command, subcommand], {
      ZCANVAS_INSTANCE_DIR: emptyRegistry,
    });
    assert.notEqual(result.json.code, 'USAGE_ERROR', `${command} ${subcommand}: ${result.stdout}`);
  }
});

test('zcanvas app list is a safe no-instance discovery command', () => {
  const emptyRegistry = path.join(root, '.zcanvas-test-empty-registry');
  const result = run(cli, ['app', 'list'], { ZCANVAS_INSTANCE_DIR: emptyRegistry });
  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.data.instances, []);
});

test('skill wrapper resolves the project CLI without a shell', () => {
  const result = run(wrapper, ['version']);
  assert.equal(result.status, 0);
  assert.equal(result.json.data.cliVersion, '0.1.0-dev');
  assert.equal(result.stderr, '');
});

test('creative script file input preserves long UTF-8 content and rejects ambiguity', () => {
  const filename = path.join(root, '.zcanvas-test-long-story.txt');
  const content = `《雨夜唐人街》\n${'镜头：两位女主角在雨中对峙。\n'.repeat(760)}`;
  fs.writeFileSync(filename, content, 'utf8');
  try {
    const { parseArgs } = require('../tools/zcanvas-cli/src/args.cjs');
    const { readCreativePrompt } = require('../tools/zcanvas-cli/src/cli.cjs');
    const parsed = parseArgs(['--file', filename]);
    assert.equal(readCreativePrompt(parsed), content);
    assert.throws(
      () => readCreativePrompt(parseArgs(['--file', filename, '--prompt', '冲突内容'])),
      (error) => error.code === 'CREATIVE_INPUT_AMBIGUOUS',
    );
  } finally {
    fs.rmSync(filename, { force: true });
  }
});

test('one-line creator entry accepts the creator request as one positional argument and infers edit/Story intent', () => {
  const { parseArgs } = require('../tools/zcanvas-cli/src/args.cjs');
  const {
    inferCreatorKind,
    inferCreatorRecipe,
    readCreativePrompt,
    creatorContinuationReferenceNodeIds,
    creatorReferenceNodeIds,
  } = require('../tools/zcanvas-cli/src/cli.cjs');
  const parsed = parseArgs(['ask', '把这段剧本做成30秒竖屏短片']);
  assert.equal(readCreativePrompt(parsed), '把这段剧本做成30秒竖屏短片');
  assert.equal(inferCreatorKind(readCreativePrompt(parsed)), 'story');
  assert.equal(inferCreatorKind('把这张图里的纸船换成白色爱心，人物别变'), 'edit-image');
  assert.equal(inferCreatorKind('把当前视频延长五秒，动作保持连续'), 'edit-video');
  assert.equal(inferCreatorKind('让这张人物照片跟着旁白音频自然对口型'), 'video');
  assert.equal(inferCreatorKind('用这首歌做 30 秒竖屏 MV，先给节奏、镜头和素材计划。'), 'story');
  assert.equal(inferCreatorKind('用温和女声朗读这段产品旁白'), 'audio');
  assert.equal(inferCreatorKind('为透明折叠伞做 20 秒雨季广告'), 'story');
  assert.equal(inferCreatorRecipe('为透明折叠伞做 20 秒雨季广告'), 'tvc');
  assert.equal(inferCreatorRecipe('做一条20秒透明雨伞TVC广告'), 'tvc');

  const referenced = creatorReferenceNodeIds([
    ...Array.from({ length: 10 }, (_, index) => `node-${index}`),
    'node-0',
    '',
  ]);
  assert.equal(referenced.length, 8);
  assert.equal(new Set(referenced).size, 8);
  assert.deepEqual(referenced.slice(0, 2), ['node-0', 'node-1']);
  assert.equal(require('../tools/zcanvas-cli/src/cli.cjs').helpData().examples
    .some((example) => example.includes('ask') && example.includes('--node')), true);

  assert.deepEqual(
    creatorContinuationReferenceNodeIds(['node-existing'], '', false, false),
    ['node-existing'],
  );
  assert.deepEqual(
    creatorContinuationReferenceNodeIds(['node-existing'], '', false, true),
    [],
  );
  assert.deepEqual(
    creatorContinuationReferenceNodeIds(['node-existing'], 'node-new,node-new', true, true),
    ['node-new'],
  );

  const result = run(cli, ['ask', '做一张电影感角色海报'], {
    ZCANVAS_INSTANCE_DIR: path.join(root, '.zcanvas-test-empty-one-line-registry'),
  });
  assert.equal(result.status, 3);
  assert.equal(result.json.code, 'APP_NOT_RUNNING');

  const attachmentOnly = run(cli, ['ask', '--asset', 'asset-reference-image'], {
    ZCANVAS_INSTANCE_DIR: path.join(root, '.zcanvas-test-empty-attachment-only-registry'),
  });
  assert.equal(attachmentOnly.status, 3);
  assert.equal(attachmentOnly.json.code, 'APP_NOT_RUNNING');
  assert.doesNotMatch(attachmentOnly.json.message, /必须提供 --prompt 或 --file/);
});

test('one-line creator entry auto-selects one canvas and returns named choices for ambiguous workspaces', () => {
  const {
    selectUnambiguousCreatorWorkspace,
  } = require('../tools/zcanvas-cli/src/cli.cjs');
  assert.deepEqual(selectUnambiguousCreatorWorkspace({
    projectId: 'project-local',
    canvases: [{ id: 'canvas-a', projectId: 'project-local', name: '雨夜短片' }],
  }), {
    projectId: 'project-local',
    canvasId: 'canvas-a',
  });
  assert.throws(
    () => selectUnambiguousCreatorWorkspace({
      projectId: 'project-local',
      canvases: [
        { id: 'canvas-a', name: '雨夜短片', revision: 8 },
        { id: 'canvas-b', name: '产品广告', revision: 3 },
      ],
    }),
    (error) => error.code === 'WORKSPACE_AMBIGUOUS'
      && error.details.canvases.map((item) => item.name).join(',') === '雨夜短片,产品广告',
  );
  assert.throws(
    () => selectUnambiguousCreatorWorkspace({ projectId: 'project-local', canvases: [] }),
    (error) => error.code === 'WORKSPACE_EMPTY',
  );
});

test('free-text continuation compiles a non-destructive incremental plan against the same production', () => {
  const { compileIncrementalDirection } = require('../tools/zcanvas-cli/src/cli.cjs');
  const session = {
    kind: 'story',
    storyNodeId: 'story-node-a',
    linkedNodeId: 'story-node-a',
  };
  const background = compileIncrementalDirection(
    '继续刚才采用的方向，只把第2镜头背景换成清晨，人物和构图别变',
    session,
    { storyId: 'story-rain' },
  );
  assert.equal(background.target.nodeId, 'story-node-a');
  assert.equal(background.target.sameProduction, true);
  assert.equal(background.scope, 'explicit-affected-only');
  assert.deepEqual(background.shotIndexes, [2]);
  assert.deepEqual(background.changeDimensions, ['background']);
  assert.equal(background.preserve.includes('identity'), true);
  assert.equal(background.preserve.includes('composition'), true);
  assert.equal(background.preserve.includes('accepted-results'), true);
  assert.equal(background.preserve.includes('completed-unaffected'), true);
  assert.equal(background.duplicateSourceWorkflow, false);
  assert.equal(background.providerCallsNow, 0);

  const retry = compileIncrementalDirection('继续最近失败的视频，只重试失败镜头', session);
  assert.equal(retry.operation, 'run.retry-failed');
  assert.equal(retry.scope, 'failed-only');
  assert.equal(retry.requiresRunIntentLookup, true);
  assert.equal(retry.preserve.includes('successful-attempts'), true);
});

test('Story plan JSON reader accepts a structured local plan without shell interpolation', () => {
  const filename = path.join(root, '.zcanvas-test-story-plan.json');
  const payload = {
    title: '雨夜对峙',
    scenes: [{ id: 'scene-1', title: '后巷', sourceText: '雨夜后巷。' }],
    shots: [{ id: 'shot-1', title: '建立环境', sourceText: '雨夜后巷。', durationSec: 6 }],
    assets: [{ id: 'hero-a', kind: 'character', name: '女主 A' }],
  };
  fs.writeFileSync(filename, JSON.stringify(payload), 'utf8');
  try {
    const { readStoryPlanFile } = require('../tools/zcanvas-cli/src/cli.cjs');
    assert.deepEqual(readStoryPlanFile(filename), payload);
  } finally {
    fs.rmSync(filename, { force: true });
  }
});

test('candidate review reader accepts only a bounded absolute JSON object', () => {
  const filename = path.join(root, '.zcanvas-test-creative-review.json');
  const payload = {
    schema: 't8-creative-review-v1',
    source: 'visual-inspection',
    evidence: { url: '/outputs/candidate-a.png' },
    dimensions: {
      composition: { status: 'pass', summary: '主体清楚' },
    },
  };
  fs.writeFileSync(filename, JSON.stringify(payload), 'utf8');
  try {
    const { readCreativeReviewFile } = require('../tools/zcanvas-cli/src/cli.cjs');
    assert.deepEqual(readCreativeReviewFile(filename), payload);
    assert.throws(
      () => readCreativeReviewFile('relative-review.json'),
      (error) => error.code === 'CREATIVE_REVIEW_FILE_PATH_INVALID',
    );
  } finally {
    fs.rmSync(filename, { force: true });
  }
});

test('graph node data reader accepts a bounded absolute JSON object and rejects arrays', () => {
  const filename = path.join(root, '.zcanvas-test-node-data.json');
  const arrayFilename = path.join(root, '.zcanvas-test-node-data-array.json');
  fs.writeFileSync(filename, JSON.stringify({
    model: 'gpt-image-2',
    gptImageQuality: 'high',
  }), 'utf8');
  fs.writeFileSync(arrayFilename, '[]', 'utf8');
  try {
    const { readGraphNodeDataFile } = require('../tools/zcanvas-cli/src/cli.cjs');
    assert.deepEqual(readGraphNodeDataFile(filename), {
      model: 'gpt-image-2',
      gptImageQuality: 'high',
    });
    assert.deepEqual(readGraphNodeDataFile(''), {});
    assert.throws(
      () => readGraphNodeDataFile('relative.json'),
      (error) => error.code === 'GRAPH_NODE_DATA_PATH_INVALID',
    );
    assert.throws(
      () => readGraphNodeDataFile(arrayFilename),
      (error) => error.code === 'GRAPH_NODE_DATA_INVALID',
    );
  } finally {
    fs.rmSync(filename, { force: true });
    fs.rmSync(arrayFilename, { force: true });
  }
});

test('doctor simulate uses the authoritative read-only execution plan and accepts an optional bounded proposal', () => {
  const filename = path.join(root, '.zcanvas-test-execution-proposal.json');
  const proposal = {
    schema: 't8-canvas-agent-execution-proposal-v1',
    baseRevision: 7,
    operations: [
      {
        type: 'node.create',
        node: {
          id: 'prompt-a',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { text: '雨夜唐人街' },
        },
      },
    ],
  };
  fs.writeFileSync(filename, JSON.stringify(proposal), 'utf8');
  try {
    const { parseArgs } = require('../tools/zcanvas-cli/src/args.cjs');
    const {
      doctorRequestForAction,
      readSimulationProposalFile,
    } = require('../tools/zcanvas-cli/src/cli.cjs');
    assert.deepEqual(readSimulationProposalFile(filename), proposal);
    assert.deepEqual(
      doctorRequestForAction('simulate', parseArgs([])),
      { tool: 'simulateExecutionPlan', input: {} },
    );
    assert.deepEqual(
      doctorRequestForAction('simulate', parseArgs(['--file', filename])),
      { tool: 'simulateExecutionPlan', input: { proposal } },
    );
    assert.deepEqual(
      doctorRequestForAction('validate', parseArgs([])),
      { tool: 'validateCanvas', input: {} },
    );
    assert.throws(
      () => readSimulationProposalFile('relative-proposal.json'),
      (error) => error.code === 'SIMULATION_FILE_PATH_INVALID',
    );
  } finally {
    fs.rmSync(filename, { force: true });
  }
});

test('zhenzhen-canvas skill is concise, routed, and discoverable by Codex', () => {
  const skillDir = path.join(root, '.agents', 'skills', 'zhenzhen-canvas');
  const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const metadata = fs.readFileSync(path.join(skillDir, 'agents', 'openai.yaml'), 'utf8');
  const runner = require('../backend/src/utils/codexCliRunner.js');

  assert.match(skill, /^---\r?\nname: zhenzhen-canvas\r?\n/);
  assert.match(skill, /scripts\/zcanvas\.cjs/);
  assert.match(skill, /references\/creative-workflows\.md/);
  assert.doesNotMatch(skill, /\[TODO/);
  assert.ok(skill.split(/\r?\n/).length < 500);
  assert.match(metadata, /display_name: "贞贞无限画布创作 Agent"/);
  assert.match(metadata, /Use \$zhenzhen-canvas/);

  const skills = runner.listCodexSkills({ workspaceDir: root });
  const discovered = skills.find((item) => item.name === 'zhenzhen-canvas');
  assert.ok(discovered);
  assert.equal(discovered.scope, 'project');
});
