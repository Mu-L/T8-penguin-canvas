import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SCRIPT_MASTER_DOMAIN_PACKS,
  SCRIPT_MASTER_PROJECT_SCHEMA,
  SCRIPT_MASTER_TARGET_CAPABILITIES,
  addScriptMasterAsset,
  adoptScriptMasterAnalysisCandidate,
  applyScriptMasterWriteback,
  buildScriptMasterDownstreamPayloads,
  compileScriptMasterProject,
  createEmptyScriptMasterProject,
  createScriptMasterAnalysisRequest,
  distributeScriptMasterShotDurations,
  duplicateScriptMasterTimelineItems,
  effectiveScriptMasterBindingsForShot,
  importScriptMasterSource,
  mergeScriptMasterTimelineItems,
  moveScriptMasterTimelineItems,
  parseScriptMasterAnalysisCandidate,
  patchScriptMasterAssetMetadata,
  patchScriptMasterBinding,
  patchScriptMasterProjectSettings,
  patchScriptMasterShot,
  patchScriptMasterTimelineTrack,
  rebuildScriptMasterTimeline,
  recordScriptMasterAnalysisCandidate,
  recordScriptMasterDownstreamApply,
  removeScriptMasterAsset,
  removeScriptMasterTimelineItems,
  restoreScriptMasterProjectSnapshot,
  sanitizeScriptMasterProject,
  scriptMasterToDirectorShots,
  splitScriptMasterTimelineItem,
  trimScriptMasterTimelineItem,
  validateScriptMasterProject,
} from '../src/utils/scriptMaster.ts';

const readFixture = (name: string) => readFileSync(new URL(`./fixtures/script-master/${name}`, import.meta.url), 'utf8');

const SOURCE = `场景 1：江边清晨
镜头 1：女主停下
画面中江水缓慢流动，女主站在画面右侧。
女主：真的要走吗？
BGM：极轻的弦乐

镜头 2：对方转身
男主：天亮前我必须离开。
SFX：远处汽笛声`;

function parsedProject() {
  return importScriptMasterSource(
    createEmptyScriptMasterProject({ projectId: 'script-master-test', title: '江边告别', fps: 24 }),
    SOURCE,
    { name: '江边告别.fountain', format: 'fountain' },
  );
}

test('script master deterministic import preserves source lines without provider inference', () => {
  const project = parsedProject();
  assert.equal(project.schema, SCRIPT_MASTER_PROJECT_SCHEMA);
  assert.equal(project.sourceDocuments.length, 1);
  assert.equal(project.sourceDocuments[0].content, SOURCE);
  assert.equal(project.scenes.length, 1);
  assert.deepEqual(project.shots.map((shot) => shot.title), ['女主停下', '对方转身']);
  assert.deepEqual(project.dialogueLines.map((line) => [line.speakerName, line.text]), [
    ['女主', '真的要走吗？'],
    ['男主', '天亮前我必须离开。'],
  ]);
  assert.deepEqual(project.audioEvents.map((event) => event.role), ['music', 'sfx']);
  assert.equal(project.sourceDocuments[0].spans.every((span) => span.startLine >= 1 && span.endChar >= span.startChar), true);
  assert.equal(project.shots[0].range.end.value, project.shots[1].range.start.value, 'picture ranges must use adjacent [start,end) frames');

  const repeated = parsedProject();
  assert.deepEqual(repeated.sourceDocuments.map((document) => document.id), project.sourceDocuments.map((document) => document.id));
  assert.deepEqual(repeated.sourceDocuments.flatMap((document) => document.spans.map((span) => span.id)), project.sourceDocuments.flatMap((document) => document.spans.map((span) => span.id)));
  assert.deepEqual(repeated.scenes.map((scene) => scene.id), project.scenes.map((scene) => scene.id));
  assert.deepEqual(repeated.shots.map((shot) => shot.id), project.shots.map((shot) => shot.id));
  assert.deepEqual(repeated.dialogueLines.map((line) => line.id), project.dialogueLines.map((line) => line.id));
});

test('bracketed sound tags stay on sound tracks instead of becoming characters', () => {
  const project = importScriptMasterSource(
    createEmptyScriptMasterProject({ projectId: 'script-master-bracketed-audio', fps: 24 }),
    `INT. 雨夜车站 - NIGHT

# 镜头 1
女孩
我们出发。
[SFX: 远处列车驶来]
【BGM：低沉弦乐】`,
    { name: '雨夜车站.fountain', format: 'fountain' },
  );

  assert.deepEqual(project.entities.map((entity) => entity.name), ['女孩']);
  assert.deepEqual(project.audioEvents.map((event) => [event.role, event.description]), [
    ['sfx', '远处列车驶来'],
    ['music', '低沉弦乐'],
  ]);
  const dialogueTrackIds = new Set(project.timeline.tracks.filter((track) => track.group === 'dialogue').map((track) => track.id));
  const soundTrackIds = new Set(project.timeline.tracks.filter((track) => track.group === 'sound').map((track) => track.id));
  assert.equal(project.timeline.items.filter((item) => dialogueTrackIds.has(item.trackId)).length, 1);
  assert.equal(project.timeline.items.filter((item) => soundTrackIds.has(item.trackId)).length, 2);
});

test('multiple image and audio assets get independent tracks and stable aliases', () => {
  let project = parsedProject();
  project = addScriptMasterAsset(project, { id: 'image-hero', kind: 'image', name: '女主形象', url: '/hero.png', source: 'upstream', sourceKey: 'upstream:hero' });
  project = addScriptMasterAsset(project, { id: 'image-river', kind: 'image', name: '江边场景', url: '/river.png', source: 'upstream', sourceKey: 'upstream:river' });
  project = addScriptMasterAsset(project, { id: 'audio-voice', kind: 'voice-profile', name: '女主声线', url: '/voice.wav', source: 'upstream', sourceKey: 'upstream:voice' });
  project = addScriptMasterAsset(project, { id: 'audio-bgm', kind: 'music', name: '告别配乐', url: '/bgm.mp3', source: 'upstream', sourceKey: 'upstream:bgm' });

  assert.deepEqual(project.assets.map((asset) => asset.alias), ['@image1', '@image2', '@audio1', '@audio2']);
  assert.equal(project.timeline.tracks.filter((track) => track.group === 'reference' && track.assetId).length, 2);
  assert.equal(project.timeline.tracks.filter((track) => track.group === 'sound' && track.assetId).length, 2);

  project = removeScriptMasterAsset(project, 'image-hero');
  project = removeScriptMasterAsset(project, 'audio-voice');
  project = addScriptMasterAsset(project, { id: 'image-prop', kind: 'image', name: '信物', url: '/prop.png' });
  project = addScriptMasterAsset(project, { id: 'audio-sfx', kind: 'sfx', name: '风声', url: '/wind.wav' });

  assert.deepEqual(project.assets.map((asset) => asset.alias), ['@image2', '@audio2', '@image3', '@audio3']);
  assert.equal(project.aliasCounters.image, 4);
  assert.equal(project.aliasCounters.audio, 4);
  assert.deepEqual(sanitizeScriptMasterProject(project).assets.map((asset) => asset.alias), ['@image2', '@audio2', '@image3', '@audio3']);
});

test('a shot compiles every effective reference instead of collapsing each media kind to one item', () => {
  let project = parsedProject();
  project = addScriptMasterAsset(project, { id: 'image-a', kind: 'image', name: '人物正面', url: '/a.png' });
  project = addScriptMasterAsset(project, { id: 'image-b', kind: 'image', name: '人物侧面', url: '/b.png' });
  project = addScriptMasterAsset(project, { id: 'audio-a', kind: 'dialogue-audio', name: '台词录音 A', url: '/a.wav' });
  project = addScriptMasterAsset(project, { id: 'audio-b', kind: 'ambience', name: '江水环境声', url: '/river.wav' });

  const firstShot = project.shots[0];
  const bindings = effectiveScriptMasterBindingsForShot(project, firstShot);
  assert.deepEqual(bindings.map((binding) => binding.alias), ['@audio1', '@audio2', '@image1', '@image2']);
  const compilation = compileScriptMasterProject(project, project.compileTargets[0], [firstShot.id]);
  assert.deepEqual(compilation.promptPacks[0].referenceAliases.sort(), ['@audio1', '@audio2', '@image1', '@image2']);
  assert.match(compilation.humanPrompt, /@image1/);
  assert.match(compilation.humanPrompt, /@image2/);
  assert.match(compilation.humanPrompt, /@audio1/);
  assert.match(compilation.humanPrompt, /@audio2/);

  const directorShot = scriptMasterToDirectorShots(project)[0];
  assert.deepEqual(directorShot.localRefImages, ['/a.png', '/b.png']);
  assert.deepEqual(directorShot.localRefAudios, ['/a.wav', '/river.wav']);
  assert.equal(directorShot.scriptMasterLineage.shotId, firstShot.id);
});

test('scope priority is explicit and conflicting bindings remain visible for review', () => {
  let project = parsedProject();
  project = addScriptMasterAsset(project, { id: 'global-look', kind: 'image', name: '全片造型', url: '/global.png', role: 'character-look' });
  project = addScriptMasterAsset(project, { id: 'shot-look', kind: 'image', name: '本镜造型', url: '/shot.png', role: 'character-look' });
  const shotBinding = project.bindings.find((binding) => binding.assetId === 'shot-look');
  assert.ok(shotBinding);
  project = patchScriptMasterBinding(project, shotBinding.id, { scope: 'shot', shotIds: [project.shots[0].id] });

  const effective = effectiveScriptMasterBindingsForShot(project, project.shots[0]);
  assert.deepEqual(effective.map((binding) => binding.alias), ['@image2', '@image1']);
  const report = validateScriptMasterProject(project, project.compileTargets[0]);
  assert.equal(report.issues.some((item) => item.code === 'REFERENCE_SCOPE_CONFLICT'), true);
});

test('targets without native audio externalize audio to AudioPlan', () => {
  let project = parsedProject();
  project = addScriptMasterAsset(project, { id: 'audio-a', kind: 'music', name: '配乐', url: '/music.wav' });
  const target = { ...project.compileTargets[0], id: 'video-no-audio', supportsNativeAudio: false, maxAudioReferences: 0 };
  const compilation = compileScriptMasterProject(project, target, [project.shots[0].id]);
  assert.equal(compilation.promptPacks[0].references.some((item) => item.mediaKind === 'audio'), false);
  assert.equal(compilation.promptPacks[0].audioPlan.some((item) => item.alias === '@audio1'), true);
  assert.doesNotMatch(compilation.promptPacks[0].prompt, /@audio1/);
  assert.equal(compilation.qualityReport.issues.some((item) => item.code === 'AUDIO_PLAN_EXTERNALIZED'), true);
  assert.equal(compilation.qualityReport.issues.some((item) => item.code === 'AUDIO_REFERENCE_LIMIT'), false);
});

test('shot layout edits retime linked dialogue and sound without frame drift', () => {
  let project = parsedProject();
  const firstShot = project.shots[0];
  const secondShot = project.shots[1];
  const secondDialogue = project.dialogueLines.find((line) => line.shotId === secondShot.id);
  const secondSound = project.audioEvents.find((event) => event.shotId === secondShot.id);
  assert.ok(secondDialogue);
  assert.ok(secondSound);

  project = patchScriptMasterShot(project, firstShot.id, {
    durationFrames: firstShot.range.end.value - firstShot.range.start.value + 24,
  });
  assert.equal(project.shots[1].range.start.value, secondShot.range.start.value + 24);
  assert.equal(project.dialogueLines.find((line) => line.id === secondDialogue.id)?.range.start.value, secondDialogue.range.start.value + 24);
  assert.equal(project.audioEvents.find((event) => event.id === secondSound.id)?.range.start.value, secondSound.range.start.value + 24);

  project = removeScriptMasterTimelineItems(project, [`timeline-shot-${firstShot.id}`]);
  assert.equal(project.shots[0].id, secondShot.id);
  assert.equal(project.shots[0].range.start.value, 0);
  assert.equal(project.dialogueLines[0].range.start.value, 0);
  assert.equal(project.audioEvents[0].range.start.value, 0);
});

test('removing a shot does not revise bindings that do not reference it', () => {
  let project = parsedProject();
  project = addScriptMasterAsset(project, { id: 'second-shot-look', kind: 'image', name: '第二镜造型', url: '/second.png' });
  const binding = project.bindings.find((item) => item.assetId === 'second-shot-look');
  assert.ok(binding);
  project = patchScriptMasterBinding(project, binding.id, { scope: 'shot', shotIds: [project.shots[1].id] });
  const before = project.bindings.find((item) => item.id === binding.id);
  assert.ok(before);

  project = removeScriptMasterTimelineItems(project, [`timeline-shot-${project.shots[0].id}`]);
  const after = project.bindings.find((item) => item.id === binding.id);
  assert.ok(after);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.shotIds, before.shotIds);
});

test('five timeline groups and track controls survive every derived rebuild', () => {
  let project = parsedProject();
  assert.deepEqual([...new Set(project.timeline.tracks.map((track) => track.group))], ['picture', 'transition', 'reference', 'dialogue', 'sound']);
  project = patchScriptMasterTimelineTrack(project, 'track-sound-main', { locked: true, hidden: true, muted: true });
  project = distributeScriptMasterShotDurations(project);
  const soundTrack = project.timeline.tracks.find((track) => track.id === 'track-sound-main');
  assert.deepEqual(soundTrack && [soundTrack.locked, soundTrack.hidden, soundTrack.muted], [true, true, true]);
  assert.equal(project.timeline.items.filter((item) => item.kind === 'transition').length, project.shots.length - 1);
});

test('picture clips reorder and split on integer frames while keeping stable shot identities', () => {
  let project = parsedProject();
  const [first, second] = project.shots;
  const duration = project.targetDurationFrames;
  project = moveScriptMasterTimelineItems(project, [`timeline-shot-${second.id}`], -duration);
  assert.deepEqual(project.shots.map((shot) => shot.id), [second.id, first.id]);
  assert.equal(project.shots[0].range.start.value, 0);
  const splitFrame = project.shots[0].range.start.value + Math.floor((project.shots[0].range.end.value - project.shots[0].range.start.value) / 2);
  project = splitScriptMasterTimelineItem(project, `timeline-shot-${second.id}`, splitFrame);
  assert.equal(project.shots.length, 3);
  assert.equal(project.targetDurationFrames, duration);
  assert.equal(project.shots[0].id, second.id);
  assert.equal(project.shots[0].range.end.value, project.shots[1].range.start.value);
  assert.equal(project.shots[1].range.end.value, project.shots[2].range.start.value);
});

test('reference and audio clips trim, split and duplicate without allocating new aliases', () => {
  let project = parsedProject();
  project = addScriptMasterAsset(project, { id: 'image-a', kind: 'image', name: '人物正面', url: '/a.png' });
  project = addScriptMasterAsset(project, { id: 'image-b', kind: 'image', name: '人物侧面', url: '/b.png' });
  project = addScriptMasterAsset(project, { id: 'audio-a', kind: 'music', name: '配乐 A', url: '/a.wav' });
  project = addScriptMasterAsset(project, { id: 'audio-b', kind: 'ambience', name: '环境 B', url: '/b.wav' });
  const aliases = project.assets.map((asset) => asset.alias);
  const imageBinding = project.bindings.find((binding) => binding.assetId === 'image-a');
  const audioBinding = project.bindings.find((binding) => binding.assetId === 'audio-a');
  assert.ok(imageBinding);
  assert.ok(audioBinding);
  const cut = Math.floor(project.targetDurationFrames / 2);
  project = trimScriptMasterTimelineItem(project, `timeline-binding-${imageBinding.id}`, 'end', cut);
  project = splitScriptMasterTimelineItem(project, `timeline-binding-${imageBinding.id}`, Math.floor(cut / 2));
  project = duplicateScriptMasterTimelineItems(project, [`timeline-binding-${audioBinding.id}`]);
  assert.deepEqual(project.assets.map((asset) => asset.alias), aliases);
  assert.equal(project.bindings.filter((binding) => binding.alias === '@image1').length, 2);
  assert.equal(project.bindings.filter((binding) => binding.alias === '@audio1').length, 2);
  assert.equal(project.timeline.tracks.filter((track) => track.assetId === 'image-a').length, 1);
  assert.equal(project.timeline.tracks.filter((track) => track.assetId === 'audio-a').length, 1);
});

test('500 picture fragments keep integer-frame adjacency through reorder, split and distribution', () => {
  const fps = 24;
  const totalFrames = fps * 60 * 30;
  const baseClipFrames = Math.floor(totalFrames / 500);
  const longerClipCount = totalFrames - baseClipFrames * 500;
  const base = createEmptyScriptMasterProject({ projectId: 'script-master-500-fragments', fps });
  const sceneId = 'scene-pressure';
  const shots = Array.from({ length: 500 }, (_, index) => {
    const startFrame = index * baseClipFrames + Math.min(index, longerClipCount);
    const endFrame = startFrame + baseClipFrames + (index < longerClipCount ? 1 : 0);
    return ({
    id: `shot-pressure-${index + 1}`,
    sceneId,
    title: `压力镜头 ${index + 1}`,
    purpose: '',
    visualDescription: `画面 ${index + 1}`,
    action: '',
    shotSize: '中景',
    camera: '固定机位',
    transitionIn: index === 0 ? '开场' : '硬切',
    transitionOut: '硬切',
    range: { start: { value: startFrame, rate: fps }, end: { value: endFrame, rate: fps } },
    sourceSpanIds: [],
    characterIds: [],
    bindingIds: [],
    mustInclude: [],
    mustAvoid: [],
    locked: false,
    revision: 1,
  });
  });
  let project = rebuildScriptMasterTimeline({
    ...base,
    scenes: [{ id: sceneId, title: '压力场景', sourceSpanIds: [], shotIds: shots.map((shot) => shot.id), revision: 1 }],
    shots,
    targetDurationFrames: totalFrames,
  });
  assert.equal(project.timeline.items.filter((item) => item.kind === 'shot').length, 500);
  assert.equal(project.targetDurationFrames, 43_200);

  project = moveScriptMasterTimelineItems(project, ['timeline-shot-shot-pressure-1'], project.targetDurationFrames);
  assert.equal(project.shots.at(-1)?.id, 'shot-pressure-1');
  const middle = project.shots[249];
  project = splitScriptMasterTimelineItem(project, `timeline-shot-${middle.id}`, middle.range.start.value + Math.floor((middle.range.end.value - middle.range.start.value) / 2));
  assert.equal(project.shots.length, 501);
  assert.equal(project.targetDurationFrames, 43_200);
  project = mergeScriptMasterTimelineItems(project, [`timeline-shot-${project.shots[249].id}`, `timeline-shot-${project.shots[250].id}`]);
  assert.equal(project.shots.length, 500);
  assert.equal(project.targetDurationFrames, 43_200);
  project = distributeScriptMasterShotDurations(project);

  project.shots.forEach((shot, index) => {
    assert.equal(Number.isInteger(shot.range.start.value), true);
    assert.equal(Number.isInteger(shot.range.end.value), true);
    assert.equal(shot.range.end.value > shot.range.start.value, true);
    if (index > 0) assert.equal(project.shots[index - 1].range.end.value, shot.range.start.value);
  });
  assert.equal(project.shots.at(-1)?.range.end.value, project.targetDurationFrames);
  const report = validateScriptMasterProject(project, { ...project.compileTargets[0], maxDurationFrames: fps * 60 });
  assert.equal(report.issues.some((item) => item.code === 'PICTURE_GAP' || item.code === 'PICTURE_OVERLAP'), false);
});

test('source edits preserve stable identities and keep locked shot content intact', () => {
  let project = parsedProject();
  const originalShotIds = project.shots.map((shot) => shot.id);
  const originalDialogueIds = project.dialogueLines.map((line) => line.id);
  const lockedVisual = project.shots[0].visualDescription;
  project = patchScriptMasterShot(project, project.shots[0].id, { locked: true });
  project = importScriptMasterSource(
    project,
    SOURCE.replace('画面中江水缓慢流动，女主站在画面右侧。', '画面中江水翻涌，女主走向左侧。').replace('天亮前我必须离开。', '日出前我必须离开。'),
    { name: '江边告别.fountain', format: 'fountain' },
  );
  assert.deepEqual(project.shots.map((shot) => shot.id), originalShotIds);
  assert.deepEqual(project.dialogueLines.map((line) => line.id), originalDialogueIds);
  assert.equal(project.shots[0].visualDescription, lockedVisual);
  assert.equal(project.shots[0].locked, true);
  assert.equal(project.unresolvedItems.some((item) => item.kind === 'locked-source-change'), true);
  assert.equal(project.dialogueLines[1].text, '日出前我必须离开。');
});

test('qualified same-name speakers remain distinct while delivery markers reuse one identity', () => {
  const project = importScriptMasterSource(
    createEmptyScriptMasterProject({ projectId: 'script-master-same-name', fps: 24 }),
    '场景 1：教室\n镜头 1：点名\n王明（老师）：请回答。\n王明（学生）：我来回答。\nALICE (V.O.): Listen.\nALICE: I hear you.',
    { name: 'same-name.fountain', format: 'fountain' },
  );
  const wang = project.entities.filter((entity) => entity.name.startsWith('王明'));
  assert.equal(wang.length, 2);
  assert.notEqual(wang[0].id, wang[1].id);
  assert.equal(wang.every((entity) => entity.aliases.includes('王明')), true);
  const alice = project.entities.filter((entity) => entity.name === 'ALICE');
  assert.equal(alice.length, 1);
  assert.equal(alice[0].aliases.includes('ALICE (V.O.)'), true);
});

test('explicit LLM analysis stays a reviewable candidate and cannot modify locked or stale scope', () => {
  let project = parsedProject();
  const lockedShot = project.shots[0];
  const editableShot = project.shots[1];
  project = patchScriptMasterShot(project, lockedShot.id, { locked: true });
  const request = createScriptMasterAnalysisRequest(project, [editableShot.id]);
  assert.deepEqual(request.scopeShotIds, [editableShot.id]);
  assert.match(request.system, /不得改写事实或生成媒体/);
  const candidate = parseScriptMasterAnalysisCandidate(project, JSON.stringify({
    domain: 'narrative',
    confidence: 0.92,
    shots: [{ shotId: editableShot.id, confidence: 0.9, fields: { purpose: '完成告别转折', action: '男主停顿后转身' } }],
    unresolvedItems: [{ kind: 'continuity', shotId: editableShot.id, message: '男主外套颜色未在原文出现' }],
  }), { provider: 'zhenzhen', model: 'test-llm', version: '1' }, [editableShot.id]);
  project = recordScriptMasterAnalysisCandidate(project, candidate);
  assert.equal(project.analysis.status, 'candidate');
  assert.equal(project.shots[1].purpose, '', 'candidate preview must not mutate the project');
  project = adoptScriptMasterAnalysisCandidate(project, candidate.id);
  assert.equal(project.shots[1].purpose, '完成告别转折');
  assert.equal(project.shots[0].visualDescription, lockedShot.visualDescription);
  assert.equal(project.analysis.candidates.find((item) => item.id === candidate.id)?.status, 'accepted');

  assert.throws(() => parseScriptMasterAnalysisCandidate(project, JSON.stringify({
    confidence: 1,
    shots: [{ shotId: project.shots[0].id, confidence: 1, fields: { action: '覆盖锁定内容' } }],
    unresolvedItems: [],
  }), { provider: 'zhenzhen', model: 'test-llm', version: '1' }, [project.shots[0].id]), /锁定镜头/);

  const fresh = parseScriptMasterAnalysisCandidate(project, JSON.stringify({
    confidence: 0.5,
    shots: [{ shotId: project.shots[1].id, confidence: 0.5, fields: { camera: '缓慢推近' } }],
    unresolvedItems: [],
  }), { provider: 'zhenzhen', model: 'test-llm', version: '1' }, [project.shots[1].id]);
  project = recordScriptMasterAnalysisCandidate(project, fresh);
  project = patchScriptMasterShot(project, project.shots[1].id, { shotSize: '近景' });
  assert.equal(project.analysis.candidates.find((item) => item.id === fresh.id)?.status, 'stale');
  assert.throws(() => adoptScriptMasterAnalysisCandidate(project, fresh.id), /已失效/);
});

test('capability-aware compilation segments on integer frames with deterministic continuity and audio policy', () => {
  let project = parsedProject();
  project = addScriptMasterAsset(project, {
    id: 'native-music', kind: 'music', name: '原生配乐', url: '/music.wav', probeStatus: 'ready', durationFrames: 240,
  });
  const nativeTarget = SCRIPT_MASTER_TARGET_CAPABILITIES.find((target) => target.id === 'seedance-2-fast-native-audio-v1');
  const videoOnlyTarget = SCRIPT_MASTER_TARGET_CAPABILITIES.find((target) => target.id === 'seedance-2-video-only-v1');
  assert.ok(nativeTarget);
  assert.ok(videoOnlyTarget);
  const segmentedTarget = { ...nativeTarget, id: 'test-native-segmented-v1', maxDurationFrames: 40 };
  const first = compileScriptMasterProject(project, segmentedTarget);
  const repeated = compileScriptMasterProject(project, segmentedTarget);
  assert.equal(first.deterministicHash, repeated.deterministicHash);
  assert.deepEqual(first.promptPacks.map((pack) => pack.deterministicHash), repeated.promptPacks.map((pack) => pack.deterministicHash));
  assert.equal(first.promptPacks.length, project.shots.reduce((sum, shot) => sum + Math.ceil((shot.range.end.value - shot.range.start.value) / segmentedTarget.maxDurationFrames), 0));
  assert.equal(first.promptPacks.some((pack) => pack.segmentCount > 1), true);
  first.promptPacks.forEach((pack, index) => {
    assert.equal(Number.isInteger(pack.range.start.value) && Number.isInteger(pack.range.end.value), true);
    if (pack.segmentIndex > 0) assert.equal(pack.continuity.previousSegmentId, first.promptPacks[index - 1].segmentId);
  });
  assert.equal(first.promptPacks.some((pack) => pack.references.some((reference) => reference.alias === '@audio1')), true);
  const videoOnly = compileScriptMasterProject(project, videoOnlyTarget);
  assert.equal(videoOnly.promptPacks.some((pack) => pack.references.some((reference) => reference.mediaKind === 'audio')), false);
  assert.equal(videoOnly.audioPlan.some((item) => item.alias === '@audio1'), true);
});

test('capability segmentation cuts at dialogue boundaries and blocks an indivisible overlong line', () => {
  const base = parsedProject();
  const firstShot = base.shots[0];
  const firstDialogue = base.dialogueLines.find((line) => line.shotId === firstShot.id);
  assert.ok(firstDialogue);
  const project = sanitizeScriptMasterProject({
    ...base,
    dialogueLines: base.dialogueLines.map((line) => line.id === firstDialogue.id ? {
      ...line,
      range: { start: { value: firstShot.range.start.value + 30, rate: base.fps }, end: { value: firstShot.range.start.value + 90, rate: base.fps } },
    } : line),
  });
  const safeTarget = { ...project.compileTargets[0], id: 'dialogue-safe-cut-test', maxDurationFrames: 60 };
  const compilation = compileScriptMasterProject(project, safeTarget, [firstShot.id]);
  assert.deepEqual(compilation.promptPacks.map((pack) => [pack.range.start.value, pack.range.end.value]), [[0, 30], [30, 90], [90, 120]]);
  assert.equal(compilation.qualityReport.issues.some((item) => item.code === 'DIALOGUE_TARGET_DURATION_EXCEEDED' && item.shotId === firstShot.id), false);
  const blocked = validateScriptMasterProject(project, { ...safeTarget, id: 'dialogue-too-short-test', maxDurationFrames: 40 });
  assert.equal(blocked.issues.some((item) => item.code === 'DIALOGUE_TARGET_DURATION_EXCEEDED' && item.shotId === firstShot.id && item.severity === 'blocker'), true);
});

test('strict QC blocks missing transition handles, unread media, stale revisions and real audio overruns', () => {
  let project = patchScriptMasterProjectSettings(parsedProject(), { strictMode: true });
  project = patchScriptMasterShot(project, project.shots[1].id, { transitionIn: '叠化', transitionInFrames: 0 });
  project = addScriptMasterAsset(project, {
    id: 'dialogue-overrun', kind: 'dialogue-audio', name: '超长台词', url: '/dialogue.wav', durationFrames: project.targetDurationFrames * 2,
  });
  let report = validateScriptMasterProject(project, project.compileTargets[0]);
  for (const code of ['TRANSITION_HANDLE_UNSPECIFIED', 'REFERENCE_MEDIA_UNPROBED', 'DIALOGUE_AUDIO_DURATION_EXCEEDS_RANGE']) {
    assert.equal(report.issues.some((item) => item.code === code && item.severity === 'blocker'), true, code);
  }
  project = patchScriptMasterShot(project, project.shots[1].id, { transitionInFrames: 24 });
  project = patchScriptMasterAssetMetadata(project, 'dialogue-overrun', { probeStatus: 'ready', durationFrames: 48, mime: 'audio/wav' });
  report = validateScriptMasterProject(project, project.compileTargets[0]);
  assert.equal(report.issues.some((item) => ['TRANSITION_HANDLE_UNSPECIFIED', 'TRANSITION_HANDLE_INSUFFICIENT', 'REFERENCE_MEDIA_UNPROBED', 'DIALOGUE_AUDIO_DURATION_EXCEEDS_RANGE'].includes(item.code)), false);

  project = addScriptMasterAsset(project, {
    id: 'wrong-character-audio', kind: 'voice-profile', name: '错误人物视觉引用', url: '/voice.wav', role: 'character-look', probeStatus: 'ready', waveformPeaks: [0.1, 0.8, 0.4],
  });
  report = validateScriptMasterProject(project, project.compileTargets[0]);
  assert.equal(report.issues.some((item) => item.code === 'REFERENCE_MEDIA_TYPE_MISMATCH' && item.assetId === 'wrong-character-audio'), true);
  assert.deepEqual(sanitizeScriptMasterProject(project).assets.find((asset) => asset.id === 'wrong-character-audio')?.waveformPeaks, [0.1, 0.8, 0.4]);
});

test('merge and crash-recovery snapshot round trips keep authoritative duration and identities', () => {
  const original = parsedProject();
  const merged = mergeScriptMasterTimelineItems(original, original.shots.map((shot) => `timeline-shot-${shot.id}`));
  assert.equal(merged.shots.length, 1);
  assert.equal(merged.targetDurationFrames, original.targetDurationFrames);
  assert.equal(merged.dialogueLines.every((line) => line.shotId === merged.shots[0].id), true);
  const recovered = restoreScriptMasterProjectSnapshot(merged, original, '崩溃恢复测试');
  assert.deepEqual(recovered.shots.map((shot) => shot.id), original.shots.map((shot) => shot.id));
  assert.equal(recovered.targetDurationFrames, original.targetDurationFrames);
  assert.equal(recovered.timeline.items.filter((item) => item.kind === 'shot').length, original.shots.length);
});

test('10,000-plus Chinese characters parse deterministically under the two-second local target', () => {
  const source = Array.from({ length: 260 }, (_, index) => `场景 ${index + 1}：测试空间 ${index + 1}\n镜头 ${index + 1}：动作 ${index + 1}\n画面：人物执行第 ${index + 1} 个明确动作并保留原文证据，环境、道具和结束状态均写在当前镜头中。`).join('\n');
  assert.ok(source.length > 10_000);
  const startedAt = performance.now();
  const project = importScriptMasterSource(createEmptyScriptMasterProject({ projectId: 'script-master-10k', fps: 24 }), source);
  const elapsed = performance.now() - startedAt;
  assert.equal(project.shots.length, 260);
  assert.ok(elapsed < 2_000, `deterministic parse took ${elapsed.toFixed(1)}ms`);
});

test('six domain packs expose critic evidence and domain-specific blockers only when evidence is missing', () => {
  assert.deepEqual(Object.keys(SCRIPT_MASTER_DOMAIN_PACKS).sort(), ['advertising', 'documentary', 'ecommerce', 'music-video', 'narrative', 'tutorial']);
  Object.values(SCRIPT_MASTER_DOMAIN_PACKS).forEach((pack) => {
    assert.ok(pack.focusFields.length >= 2);
    assert.ok(pack.requiredEvidence.length >= 2);
    assert.ok(pack.criticRules.length >= 2);
  });
  const domainCases = [
    ['ecommerce', 'ECOMMERCE_PRODUCT_EVIDENCE'],
    ['advertising', 'ADVERTISING_BRAND_CONSTRAINT'],
    ['music-video', 'MV_MUSIC_EVIDENCE'],
    ['tutorial', 'TUTORIAL_STEP_ORDER'],
  ] as const;
  domainCases.forEach(([domain, code]) => {
    const project = patchScriptMasterProjectSettings(importScriptMasterSource(
      createEmptyScriptMasterProject({ projectId: `domain-missing-${domain}`, fps: 24 }),
      '场景 1：空白房间\n镜头 1：静止画面\n画面：一个人站在窗边。',
      { name: `${domain}.fountain`, format: 'fountain' },
    ), { domain });
    assert.equal(validateScriptMasterProject(project).issues.some((item) => item.code === code), true, domain);
  });
});

test('downstream payloads keep stable node identities across apply, retry and revision-guarded writeback', () => {
  let project = parsedProject();
  const targets = ['story', 'director-storyboard', 'seedance', 'audio', 'video-edit'] as const;
  targets.forEach((target) => assert.ok(buildScriptMasterDownstreamPayloads(project, target).length > 0));
  const initial = buildScriptMasterDownstreamPayloads(project, 'seedance');
  assert.equal(initial.every((payload) => payload.mode === 'create' && payload.nodeType === 'seedance'), true);
  project = recordScriptMasterDownstreamApply(project, initial, 'script-master-patch-test', 7);
  const retry = buildScriptMasterDownstreamPayloads(project, 'seedance');
  assert.deepEqual(retry.map((payload) => payload.nodeId), initial.map((payload) => payload.nodeId));
  assert.equal(retry.every((payload) => payload.mode === 'update'), true);
  const first = retry[0];
  project = applyScriptMasterWriteback(project, {
    schema: 't8-script-master-writeback-v1',
    projectId: project.projectId,
    projectRevision: project.revision,
    target: 'seedance',
    nodeId: first.nodeId,
    runId: 'run-seedance-1',
    shots: [{ shotId: project.shots[0].id, segmentId: 'segment-1', videoUrl: '/outputs/shot-1.mp4' }],
  });
  assert.equal(project.assets.some((asset) => asset.sourceKey.includes('writeback:') && asset.url === '/outputs/shot-1.mp4'), true);
  const link = project.downstreamLinks.find((item) => item.nodeId === first.nodeId);
  assert.equal(link?.runId, 'run-seedance-1');
  assert.equal(link?.status, 'applied');
  assert.equal(link?.projectRevision, project.revision);
  assert.throws(() => applyScriptMasterWriteback(project, {
    schema: 't8-script-master-writeback-v1', projectId: project.projectId, projectRevision: project.revision - 1,
    target: 'seedance', nodeId: first.nodeId, runId: 'stale-run', shots: [],
  }), /revision 已过期/);
});

test('eleven domain golden inputs are source-covered, deterministic and provider-passive', () => {
  const samples = JSON.parse(readFixture('frozen-samples.json')) as Array<{ id: string; domain: keyof typeof SCRIPT_MASTER_DOMAIN_PACKS; source: string }>;
  assert.equal(samples.length, 11);
  samples.forEach((sample) => {
    const create = () => patchScriptMasterProjectSettings(importScriptMasterSource(
      createEmptyScriptMasterProject({ projectId: `frozen-${sample.id}`, title: sample.id, fps: 24 }),
      sample.source,
      { name: `${sample.id}.fountain`, format: 'fountain' },
    ), { domain: sample.domain, strictMode: true });
    const first = create();
    const second = create();
    const firstCompilation = compileScriptMasterProject(first);
    const secondCompilation = compileScriptMasterProject(second);
    assert.equal(first.analysis.providerCalls, 0, sample.id);
    assert.equal(firstCompilation.qualityReport.sourceCoveragePercent, 100, sample.id);
    assert.equal(firstCompilation.deterministicHash, secondCompilation.deterministicHash, sample.id);
    assert.deepEqual(first.shots.map((shot) => shot.id), second.shots.map((shot) => shot.id), sample.id);
    assert.equal(firstCompilation.promptPacks.every((pack) => pack.reverseMap.length >= 4), true, sample.id);
    assert.equal(first.entities.some((entity) => ['confirmed', 'locked'].includes(entity.status) && entity.sourceSpanIds.length === 0), false, sample.id);
  });
});

test('frozen acceptance manifest preserves all eleven roadmap scenarios and structured review evidence', () => {
  const manifest = JSON.parse(readFixture('frozen-acceptance-manifest.json')) as {
    schema: string;
    reviewer: string;
    cases: Array<{
      id: string;
      requirement: string;
      input: string;
      structuredOutput: Record<string, unknown>;
      timelineSnapshot: Record<string, unknown>;
      compileEvidence: Record<string, unknown>;
      evidenceTest: string;
      manualScore: Record<string, number>;
    }>;
  };
  assert.equal(manifest.schema, 't8-script-master-frozen-acceptance-v1');
  assert.match(manifest.reviewer, /not human artwork review/);
  assert.equal(manifest.cases.length, 11);
  assert.equal(new Set(manifest.cases.map((item) => item.id)).size, 11);
  manifest.cases.forEach((item, index) => {
    assert.equal(item.id.startsWith(String(index + 1).padStart(2, '0')), true);
    assert.ok(item.requirement && item.input && item.evidenceTest);
    assert.ok(Object.keys(item.structuredOutput).length > 0);
    assert.ok(Object.keys(item.timelineSnapshot).length > 0);
    assert.ok(Object.keys(item.compileEvidence).length > 0);
    assert.equal(Object.values(item.manualScore).every((score) => Number.isInteger(score) && score >= 1 && score <= 5), true);
  });
});
