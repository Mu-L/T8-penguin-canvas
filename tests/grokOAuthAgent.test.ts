import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';
import { streamGrokOAuthAgent } from '../src/services/grokOAuth.ts';

function read(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function readOptional(path: string) {
  const url = new URL(path, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

test('Grok OAuth Agent is registered as an independent public-shell node', () => {
  const types = read('../src/types/canvas.ts');
  const registry = read('../src/config/nodeRegistry.ts');
  const canvas = read('../src/components/Canvas.tsx');
  const sidebar = read('../src/components/Sidebar.tsx');
  const features = read('../features.json');

  assert.match(types, /'grok-oauth-agent'/);
  assert.match(types, /'grok'/);
  assert.match(registry, /label:\s*'GROK OAuth'/);
  assertProductionNodeSchema('grok-oauth-agent', {
    label: 'Grok OAuth Agent',
    category: 'grok',
    inputs: ['text', 'image', 'video', 'audio'],
    outputs: ['text', 'image', 'video', 'audio'],
    executable: true,
  });
  assert.match(canvas, /GrokOAuthAgentNode/);
  assert.match(canvas, /import\('\.\/nodes\/GrokOAuthAgentNode'\)/);
  assert.match(canvas, /'grok-oauth-agent': GrokOAuthAgentNode/);
  assert.match(sidebar, /'grok-oauth-agent': 'Bot'/);
  assert.match(features, /grokOAuthAgentPublicShell/);
});

test('Grok OAuth public backend exposes hook-backed routes with private-module fallback', () => {
  const route = read('../backend/src/routes/grokOAuth.js');
  const server = read('../backend/src/server.js');

  assert.match(server, /const grokOAuthRouter = require\('\.\/routes\/grokOAuth'\)/);
  assert.match(server, /app\.use\('\/api\/grok-oauth', grokOAuthRouter\)/);
  assert.match(route, /Grok OAuth 私有模块未启用，请使用带私有模块的本地版本。/);
  assert.match(route, /runLocalHooks\(`grokOAuth\.\$\{action\}`/);
  assert.match(route, /router\.get\('\/status'/);
  assert.match(route, /router\.post\('\/login\/start'/);
  assert.match(route, /router\.post\('\/login\/poll'/);
  assert.match(route, /router\.post\('\/login\/complete'/);
  assert.match(route, /router\.post\('\/logout'/);
  assert.match(route, /router\.post\('\/agent\/stream'/);
  assert.match(route, /turn\.started/);
  assert.match(route, /turn\.completed/);
  assert.match(route, /decorateAgentArtifact/);
  assert.match(route, /sourceArtifactIds/);
  assert.match(route, /parentArtifactId/);
  assert.match(route, /tool\.progress/);
  assert.match(route, /artifact\.completed/);
  assert.match(route, /artifact\.failed/);
  assert.match(route, /router\.post\('\/chat\/stream'/);
  assert.match(route, /router\.post\('\/image'/);
  assert.match(route, /router\.post\('\/video\/submit'/);
  assert.match(route, /router\.post\('\/video\/status'/);
  assert.match(route, /router\.post\('\/audio\/tts'/);
  assert.match(route, /router\.post\('\/audio\/stt'/);
  assert.match(route, /saveOneMediaOutput/);
  assert.match(route, /\/files\/output\//);
});

test('Grok OAuth frontend service and node use an Agent studio with manual publishing', () => {
  const service = read('../src/services/grokOAuth.ts');
  const node = read('../src/components/nodes/GrokOAuthAgentNode.tsx');
  const canvas = read('../src/components/Canvas.tsx');
  const output = read('../src/components/nodes/OutputNode.tsx');

  assert.match(service, /streamGrokOAuthChat/);
  assert.match(service, /streamGrokOAuthAgent/);
  assert.match(service, /\/agent\/stream/);
  assert.match(service, /runLegacyGrokOAuthAgentFallback/);
  assert.match(service, /agentEventMeta/);
  assert.match(service, /turn\.started/);
  assert.match(service, /turn\.completed/);
  assert.match(service, /Cannot POST\\s\+\\\/api\\\/grok-oauth\\\/agent\\\/stream/);
  assert.match(service, /artifact\.failed/);
  assert.match(service, /completeGrokOAuthLogin/);
  assert.match(service, /response\.output_text\.delta/);
  assert.match(service, /choices\?\.\[0\]\?\.delta\?\.content/);
  assert.match(service, /generateGrokOAuthImage/);
  assert.match(service, /submitGrokOAuthVideo/);
  assert.match(service, /queryGrokOAuthVideoStatus/);
  assert.match(service, /generateGrokOAuthTts/);
  assert.match(service, /transcribeGrokOAuthAudio/);
  assert.match(node, /Grok 创作台/);
  assert.match(node, /\{loginPanel\(true\)\}/);
  assert.match(node, /loginPanel=\{loginPanel\(false\)\}/);
  assert.match(node, /status\?\.loggedIn \? '重新登录 \/ 绑定' : '登录 \/ 绑定'/);
  assert.match(node, /type GrokArtifactTab = 'image' \| 'video' \| 'audio' \| 'text'/);
  assert.match(node, /useState<GrokArtifactTab>\('image'\)/);
  assert.match(node, /artifactTabs\.map/);
  assert.match(node, /activeArtifactTab/);
  assert.match(node, /<ArtifactGroup[\s\S]*title=\{activeArtifactTab\.title\}/);
  assert.match(node, /createPortal/);
  assert.match(node, /agentMessages/);
  assert.match(node, /agentArtifacts/);
  assert.match(node, /const autoPublishArtifacts = d\.autoPublishArtifacts === true/);
  assert.match(node, /const persistPrompt = d\.grokPersistPrompt === true/);
  assert.match(node, /const persistLocalMaterials = d\.grokPersistLocalMaterials === true/);
  assert.match(node, /const DEFAULT_GROK_CONTEXT_LIMIT = 30/);
  assert.match(node, /const MAX_GROK_CONTEXT_LIMIT = 80/);
  assert.match(node, /旧输出已收纳到 Grok 创作台产物库/);
  assert.match(node, /streamGrokOAuthAgent/);
  assert.match(node, /function buildArtifactOutputPatch/);
  assert.match(node, /const shouldShowToolMessage = inferredMode !== 'chat'/);
  assert.match(node, /if \(toolMessageId\) updateMessage\(toolMessageId/);
  assert.match(node, /function buildConversationContext/);
  assert.match(node, /grokContextSummary/);
  assert.match(node, /grokContextCompressedCount/);
  assert.match(node, /压缩记忆/);
  assert.match(node, /function buildConversationMessages/);
  assert.match(node, /item\.role === 'assistant' \? 'assistant'/);
  assert.match(node, /const chatConversationMessages = inferredMode === 'chat'/);
  assert.match(node, /buildConversationContext\(messagesRef\.current, base\.prompt/);
  assert.match(node, /runtimeModePayload\.messages = chatConversationMessages/);
  assert.match(node, /conversationContextLimit: chatSettings\.contextLimit/);
  assert.match(node, /conversationMessages: inferredMode === 'chat' \? chatConversationMessages/);
  assert.match(node, /artifact\.completed/);
  assert.match(node, /publishArtifact/);
  assert.match(node, /const patch = buildArtifactOutputPatch\(current/);
  assert.match(node, /lastPublishedArtifactId/);
  assert.match(node, /lastRunSummary: newestArtifact \? `\$\{artifactKindLabel\(newestArtifact\.kind\)\} 已进入创作台产物库`/);
  assert.doesNotMatch(node, /generateGrokOAuthImage/);
  assert.doesNotMatch(node, /submitGrokOAuthVideo/);
  assert.match(node, /流式聊天/);
  assert.match(node, /无法建立连接/);
  assert.match(node, /完成授权/);
  assert.match(node, /imageUrl/);
  assert.match(node, /videoUrl/);
  assert.match(node, /audioUrl/);
  assert.match(node, /outputText/);
  assert.match(node, /MentionPromptInput/);
  assert.match(node, /onSubmit=\{\(value, mentions\) => onRun\(\{ prompt: value, mentions \}\)\}/);
  assert.match(node, /const quickPrompt = String\(d\.quickPrompt \|\| ''\)/);
  assert.match(node, /const quickPromptMentions = \(Array\.isArray\(d\.quickPromptMentions\) \? d\.quickPromptMentions : \[\]\) as MediaMention\[\]/);
  assert.match(node, /const handleQuickRun = useCallback/);
  assert.match(node, /title="Grok 简易 Prompt"/);
  assert.match(node, /onSubmit=\{\(value, mentions\) => requestGrokCanvasRun\('quick', \{ prompt: value, mentions \}\)\}/);
  assert.match(node, /promptTemplateKind=\{mode === 'video' \? 'video' : 'image'\}/);
  assert.match(node, /小节点简易生成不会写入 Grok 创作台历史/);
  assert.match(node, /update\(\{ quickPrompt: '', quickPromptMentions: \[\] \}\)/);
  assert.match(node, /update\(\{[\s\S]*\.\.\.buildArtifactOutputPatch\(outputArtifact/);
  assert.match(node, /quickLastRunSummary/);
  assert.match(node, /conversationMessages: \[\]/);
  assert.match(node, /uploadFile/);
  assert.match(node, /GROK_UPLOAD_ACCEPT/);
  assert.match(node, /grokLocalMaterials/);
  assert.match(node, /LocalUploadBar/);
  assert.match(node, /onRemoveLocal=\{onRemoveLocalMaterial\}/);
  assert.match(node, /提示词持久化/);
  assert.match(node, /任务发送后自动清空 Prompt/);
  assert.match(node, /shouldClearPromptAfterDispatch = !persistPrompt/);
  assert.match(node, /promptMentions:\s*\[\]/);
  assert.match(node, /onPersistPromptChange/);
  assert.match(node, /grokPersistPrompt: value/);
  assert.match(node, /素材持久化/);
  assert.match(node, /创作台上传素材只参与本轮运行/);
  assert.match(node, /对话上下文/);
  assert.match(node, /上下文条数/);
  assert.match(node, /超过条数的旧对话会自动压缩成长期记忆/);
  assert.match(node, /Temperature/);
  assert.match(node, /Top P/);
  assert.match(node, /Top K/);
  assert.match(node, /最大输出/);
  assert.match(node, /grokContextLimit/);
  assert.match(node, /grokTemperature/);
  assert.match(node, /grokTopP/);
  assert.match(node, /grokTopK/);
  assert.match(node, /grokMaxOutputTokens/);
  assert.match(node, /buildChatGenerationPayload\(chatSettings\)/);
  assert.match(node, /startNewConversation/);
  assert.match(node, /已开启新对话，右侧产物库已保留。/);
  assert.match(node, /清空全部/);
  assert.match(node, /grokDeletedArtifactKeys/);
  assert.match(node, /artifactDeleteKeys/);
  assert.match(node, /artifactMatchesDeletedKeys/);
  assert.match(node, /filterDeletedArtifacts\(sanitizeArtifacts\(d\.agentArtifacts\), deletedArtifactKeys\)/);
  assert.match(node, /if \(artifactMatchesDeletedKeys\(prepared, deletedArtifactKeysRef\.current\)\) return null/);
  assert.match(node, /deleteArtifacts/);
  assert.match(node, /artifactBatchMode/);
  assert.match(node, /selectedArtifactIds/);
  assert.match(node, /删选中/);
  assert.match(node, /全选当前/);
  assert.match(node, /已清空 Grok 产物库/);
  assert.match(node, /onDeleteArtifacts/);
  assert.match(node, /clearTransientLocalMaterials/);
  assert.match(node, /grokLocalMaterials:\s*\[\]/);
  assert.match(node, /shouldClearTransientMaterials = !persistLocalMaterials/);
  assert.match(node, /const primaryUrl = String\(artifact\.url \|\| allUrls\[0\] \|\| ''\)\.trim\(\)/);
  assert.match(node, /const urls = primaryUrl \? \[primaryUrl\] : \[\]/);
  assert.match(node, /generatedImages:\s*\[\]/);
  assert.match(node, /directImageUrls:\s*\[\]/);
  assert.match(node, /directVideoUrls:\s*\[\]/);
  assert.match(node, /directAudioUrls:\s*\[\]/);
  assert.match(node, /disabled=\{!!artifact\.publishedAt\}/);
  assert.match(node, /artifactToSendableMaterial/);
  assert.match(node, /openArtifactSendModal/);
  assert.match(node, /penguin:open-send-materials/);
  assert.match(node, /saveArtifactToResourceLibrary/);
  assert.match(node, /api\.addResourceItem/);
  assert.match(node, /api\.addResourceSet/);
  assert.match(node, /发送画布/);
  assert.match(node, /入库/);
  assert.match(node, /nodeId=\{id\}/);
  assert.match(node, /sourceNodeId=\{nodeId\}/);
  assert.match(node, /useUpstreamMaterials/);
  assert.match(node, /data-grok-studio-copyable/);
  assert.match(node, /data-grok-message-copyable/);
  assert.match(node, /copyMessage/);
  assert.match(node, /stopImmediatePropagation/);
  assert.match(node, /document\.addEventListener\('pointerdown', stopSelectableTextGesture, true\)/);
  assert.match(node, /userSelect:\s*'text'/);
  assert.match(node, /useRunTrigger\([\s\S]*reporter\.runContext\?\.requestId === liveData\?\.grokRunRequestId[\s\S]*await handleRun\(\)[\s\S]*await handleQuickRun\(undefined, reporter\)[\s\S]*grokRunRequestId: ''[\s\S]*'grok-oauth-agent'[\s\S]*lifecycleAware:\s*true/);
  assert.match(node, /onRun=\{\(override\) => requestGrokCanvasRun\('studio', override\)\}/);
  assert.match(canvas, /'grok-oauth-agent'/);
  assert.match(canvas, /pushTxt\(d\.outputText\)/);
  assert.match(canvas, /kind:\s*'text' \| 'image' \| 'video' \| 'audio'/);
  assert.match(output, /pickKind === 'text'/);
  assert.match(node, /t8-grok-oauth-agent-node/);
  assert.match(node, /t8-grok-oauth-agent-handle/);
});

test('Grok OAuth Agent studio derives readable text colors for themed controls', () => {
  const node = read('../src/components/nodes/GrokOAuthAgentNode.tsx');
  const palette = readOptional('../src/utils/readableStudioPalette.ts');

  assert.match(palette, /createReadableStudioPalette/);
  assert.match(palette, /readableTextOn/);
  assert.match(node, /createReadableStudioPalette/);
  assert.match(node, /studioAccentText/);
  assert.match(node, /studioHeaderText/);
  assert.doesNotMatch(node, /color:\s*active \? \(isPixel \? 'var\(--px-surface\)' : '#031712'\) : text/);
  assert.doesNotMatch(node, /color:\s*isPixel \? 'var\(--px-surface\)' : '#031712'/);
});

test('Grok OAuth Agent supports slash commands and continuous artifact references', () => {
  const node = read('../src/components/nodes/GrokOAuthAgentNode.tsx');
  const mentions = read('../src/components/nodes/mediaMentions.ts');
  const input = read('../src/components/nodes/MentionPromptInput.tsx');
  const ime = read('../src/utils/imeComposition.ts');

  assert.match(node, /const SLASH_COMMANDS/);
  assert.match(node, /command:\s*'image'/);
  assert.match(node, /command:\s*'video'/);
  assert.match(node, /command:\s*'audio'/);
  assert.match(node, /command:\s*'tts'/);
  assert.match(node, /command:\s*'stt'/);
  assert.match(node, /parseSlashCommand/);
  assert.match(node, /function slashCommandFromMode/);
  assert.match(node, /const activeSlashCommand = useMemo\(\(\) => parseSlashCommand\(localPrompt\)\?\.command \|\| slashCommandFromMode\(mode\)/);
  assert.match(node, /normalizePromptMentionTokens/);
  assert.match(node, /SlashCommandBar/);
  assert.match(node, /activeCommand=\{activeSlashCommand\}/);
  assert.match(node, /onInsertSlashCommand/);
  assert.match(node, /const active = item\.command === activeCommand/);
  assert.doesNotMatch(node, /item\.command === 'image' \? accent : 'transparent'/);
  assert.match(node, /artifactToMaterial/);
  assert.match(node, /assignMissingArtifactRefIds/);
  assert.match(node, /ensureArtifactRefId/);
  assert.doesNotMatch(node, /artifactTokenPrefix\(artifact\.kind\)\}\?/);
  assert.match(node, /mentionKey:\s*`artifact:\$\{artifact\.id\}`/);
  assert.match(node, /mentionToken:\s*refId/);
  assert.match(node, /referencedArtifactIds/);
  assert.match(node, /referencedMediaByMentions/);
  assert.match(node, /referencedFirstUrls/);
  assert.match(node, /referenceImages/);
  assert.match(node, /referenceImageUrls/);
  assert.match(node, /inputImages/);
  assert.match(node, /sourceImageUrl/);
  assert.match(node, /hasExplicitImageReferences/);
  assert.match(node, /referenceImageCount/);
  assert.match(node, /参考图 \$\{referenceImageCount\} 张/);
  assert.match(node, /conversationMessages/);
  assert.match(node, /conversationArtifacts/);
  assert.match(node, /sourceArtifactIds/);
  assert.match(node, /parentArtifactId/);
  assert.match(node, /onArtifactReference/);
  assert.match(node, /onArtifactContinue/);
  assert.match(node, /onArtifactMakeVideo/);
  assert.match(node, /v\{artifact\.revision \|\| 2\}/);

  assert.match(mentions, /MediaMentionKind = 'image' \| 'video' \| 'audio' \| 'text'/);
  assert.match(mentions, /mention\.kind === 'image' && \/\^@img\\d\+\\b\//);
  assert.match(mentions, /mention\.kind === 'text' && \/\^@txt\\d\+\\b\//);
  assert.match(mentions, /customToken/);
  assert.match(mentions, /customKey/);
  assert.match(mentions, /replacement = mention\.kind === 'text' \? material\.url : currentToken/);
  assert.match(input, /item\.material\.kind === 'audio' \? '♪' : 'T'/);
  assert.match(input, /isImeKeyboardEvent/);
  assert.match(input, /stripCompositionLeak/);
  assert.match(ime, /function isImeKeyboardEvent/);
  assert.match(ime, /keyCode === 229/);
  assert.match(ime, /function stripCompositionLeak/);
  assert.match(input, /compositionLeakRef/);
  assert.match(input, /lastPlainInputRef/);
});

test('Grok OAuth video mode routes text and image video models safely', () => {
  const node = read('../src/components/nodes/GrokOAuthAgentNode.tsx');

  assert.match(node, /const DEFAULT_TEXT_VIDEO_MODEL = 'grok-imagine-video'/);
  assert.match(node, /const DEFAULT_IMAGE_VIDEO_MODEL = 'grok-imagine-video-1\.5-preview'/);
  assert.match(node, /const VIDEO_MODELS = \[DEFAULT_TEXT_VIDEO_MODEL, DEFAULT_IMAGE_VIDEO_MODEL\]/);
  assert.match(node, /function isGrokImageOnlyVideoModel/);
  assert.match(node, /只支持图生视频/);
  assert.match(node, /videoOperation/);
  assert.match(node, /referenceVideos/);
  assert.match(node, /DEFAULT_TEXT_VIDEO_MODEL/);
  assert.match(node, /images: isGrokImageOnlyVideoModel\(videoModel\) \? imageRefs\.slice\(0, 1\) : imageRefs/);
  assert.match(node, /const latestErrorRef = useRef\(''\)/);
});

test('Grok OAuth video polling does not hang after submit', () => {
  const route = read('../backend/src/routes/grokOAuth.js');
  const service = read('../src/services/grokOAuth.ts');
  const privateHook = readOptional('../local-private/extensions/backend/grokOAuth.cjs');

  assert.match(route, /Grok OAuth 视频任务已提交但没有返回 requestId/);
  assert.match(route, /first\.message \? `\$\{first\.message\} 正在轮询结果\.\.\.`/);
  assert.match(route, /isCompletedVideoStatus\(data\.status\)/);
  assert.match(route, /hasVideoOutput\(data\)/);
  assert.match(route, /completed_without_video_url/);
  assert.match(route, /function uniqueUrls/);
  assert.match(route, /const remoteVideoUrls = uniqueUrls/);
  assert.match(route, /const GROK_VIDEO_AGENT_POLL_INTERVAL_MS = 5000/);
  assert.match(route, /const GROK_VIDEO_AGENT_MAX_POLLS = 180/);
  assert.match(route, /await sleep\(GROK_VIDEO_AGENT_POLL_INTERVAL_MS, res\)/);
  assert.match(route, /requestId: \$\{requestId\}/);
  assert.doesNotMatch(route, /await sleep\(3500, req\)/);
  assert.doesNotMatch(route, /req\.once\('close', onClose\)/);
  assert.doesNotMatch(route, /if \(!requestId\) \{[\s\S]*?return endAgentSse\(res, first, meta\);/);

  assert.match(service, /Grok OAuth 视频任务已提交但没有返回 requestId/);
  assert.match(service, /isCompletedVideoStatus\(result\.status\)/);
  assert.match(service, /hasVideoOutput\(result\)/);
  assert.match(service, /completed_without_video_url/);
  assert.match(service, /const GROK_VIDEO_AGENT_POLL_INTERVAL_MS = 5000/);
  assert.match(service, /const GROK_VIDEO_AGENT_MAX_POLLS = 180/);
  assert.match(service, /await fallbackDelay\(GROK_VIDEO_AGENT_POLL_INTERVAL_MS, options\.signal\)/);
  assert.match(service, /const VIDEO_DONE_STATUSES = new Set/);
  assert.match(service, /'complete'/);
  assert.match(service, /'finished'/);
  assert.match(service, /'success'/);

  if (privateHook) {
    assert.match(privateHook, /function videoStatusEndpointCandidates/);
    assert.match(privateHook, /\/videos\/\$\{encodeURIComponent\(requestId\)\}[\s\S]*\/videos\/generations\/\$\{encodeURIComponent\(requestId\)\}/);
    assert.match(privateHook, /function fetchVideoStatusResult/);
    assert.match(privateHook, /function normalizeVideoOperation/);
    assert.match(privateHook, /\/videos\/edits/);
    assert.match(privateHook, /\/videos\/extensions/);
    assert.match(privateHook, /payload\.video = \{ url: firstVideo \}/);
    assert.match(privateHook, /const minDuration = firstVideo \? 2 : 1/);
    assert.match(privateHook, /mimeFromMediaExt/);
    assert.match(privateHook, /video\/mp4/);
    assert.match(privateHook, /VIDEO_DONE_STATUSES/);
    assert.match(privateHook, /'complete'/);
    assert.match(privateHook, /'finished'/);
    assert.match(privateHook, /'success'/);
    assert.match(privateHook, /const done = Boolean\(videoUrl\) \|\| VIDEO_DONE_STATUSES\.has\(rawStatus\)/);
    assert.match(privateHook, /completed video did not return a video URL/);
  }
});

test('Grok OAuth stream awaits lifecycle evidence before consuming the next event', async () => {
  const previousFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const sse = [
    'data: {"type":"tool.progress","requestId":"req-order-1","progress":5}',
    '',
    'data: {"type":"done","done":true,"result":{"status":"completed"}}',
    '',
  ].join('\n');
  const order: string[] = [];
  let requestHeaders: Headers | null = null;

  globalThis.fetch = async (_input, init) => {
    requestHeaders = new Headers(init?.headers);
    return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
  };

  try {
    await streamGrokOAuthAgent(
      { mode: 'chat', prompt: 'ordering test' },
      {
        submissionKey: 'attempt-grok-order-0001',
        onEvent: async (event) => {
          const label = String(event.type || event.event || '');
          order.push(`${label}:start`);
          await Promise.resolve();
          order.push(`${label}:persisted`);
        },
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(order, [
    'tool.progress:start',
    'tool.progress:persisted',
    'done:start',
    'done:persisted',
  ]);
  assert.equal(requestHeaders?.get('X-T8-Provider-Submission'), 'attempt-grok-order-0001');
});

test('Grok OAuth Agent has stable studio status, previews, and publish guards', () => {
  const node = read('../src/components/nodes/GrokOAuthAgentNode.tsx');
  const privateHook = readOptional('../local-private/extensions/backend/grokOAuth.cjs');
  const backendRoute = read('../backend/src/routes/grokOAuth.js');

  assert.match(node, /const noticeBusy = !error && \(isBusy \|\| !!uploadingKind\)/);
  assert.match(node, /const noticeCardText = readablePalette\.noticeText/);
  assert.match(node, /const noticeCardSubText = readablePalette\.noticeSubText/);
  assert.match(node, /background: noticeCardBg/);
  assert.match(node, /color: noticeCardText/);
  assert.match(node, /noticeBusy \? \(/);
  assert.match(node, /<CheckCircle2 size=\{14\}/);
  assert.match(node, /let activeToolMessageId = ''/);
  assert.match(node, /updateMessage\(activeToolMessageId, \{ status: 'error', progress: 100, content: message \}\)/);
  assert.match(node, /function ArtifactImagePreview/);
  assert.match(node, /Grok 产物 100% 预览/);
  assert.match(node, /publishingArtifactIdsRef/);
  assert.match(node, /publishingArtifactIdsRef\.current\.has\(current\.id\)/);
  assert.match(node, /submissionKey:\s*reporter\?\.providerSubmissionKey/);
  assert.match(backendRoute, /router\.use\(providerSubmissionContextMiddleware\)/);
  assert.match(backendRoute, /providerSubmissionKey:\s*currentProviderSubmissionKey\(\) \|\| undefined/);

  if (privateHook) {
    assert.match(privateHook, /buildChatGenerationParams/);
    assert.match(privateHook, /body\.top_k \?\? body\.topK \?\? body\.grokTopK/);
    assert.match(privateHook, /responses\.max_output_tokens = maxOutputTokens/);
    assert.match(privateHook, /chat\.max_tokens = maxOutputTokens/);
    assert.match(privateHook, /chat\.top_k = topK/);
    assert.match(privateHook, /openXaiStreamWithParamRetry/);
    assert.match(privateHook, /\['temperature', 'top_p', 'max_output_tokens'\]/);
    assert.match(privateHook, /\['temperature', 'top_p', 'top_k', 'max_tokens'\]/);
    assert.match(privateHook, /referenceImageUrlsFromBody/);
    assert.match(privateHook, /body\.images/);
    assert.match(privateHook, /body\.imageUrl/);
    assert.match(privateHook, /MAX_XAI_IMAGE_EDIT_REFERENCES = 3/);
    assert.match(privateHook, /normalizeProviderSubmissionKey\(providerSubmissionKey\) \|\| crypto\.randomUUID\(\)/);
    assert.match(privateHook, /providerSubmissionHeaders\(providerSubmissionKey\)/);
    assert.match(privateHook, /\(\{ body, providerSubmissionKey \}\) => videoSubmit\(body, providerSubmissionKey\)/);
    assert.match(privateHook, /imageEditPart/);
    assert.match(privateHook, /return \{ type: 'image_url', url \}/);
    assert.match(privateHook, /\/images\/edits/);
    assert.match(privateHook, /\/images\/generations/);
    assert.match(privateHook, /image: imageEditPart\(referenceImages\[0\]\)/);
    assert.match(privateHook, /images: referenceImages\.map\(imageEditPart\)/);
    assert.match(privateHook, /xAI image editing/);
    assert.doesNotMatch(privateHook, /buildReferenceAwareImagePrompt/);
    assert.doesNotMatch(privateHook, /xAI reference image prompt planning/);
    assert.match(privateHook, /usedReferenceImages/);
  }
});
