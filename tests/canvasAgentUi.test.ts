import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const workbench = readSource('../src/components/ProjectWorkbench.tsx');
const api = readSource('../src/services/api.ts');
const agent = readSource('../src/utils/canvasAgent.ts');

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing source end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertOrdered(source: string, ...needles: string[]) {
  let cursor = -1;
  for (const needle of needles) {
    const index = source.indexOf(needle, cursor + 1);
    assert.ok(index > cursor, `expected ordered source fragment: ${needle}`);
    cursor = index;
  }
}

test('Canvas Agent exposes an ephemeral session and four explicit UI stages', () => {
  assert.match(agent, /export type CanvasAgentStage = 'explain' \| 'generate' \| 'preview' \| 'apply';/);
  assert.match(workbench, /interface CanvasAgentSessionState \{[\s\S]{0,240}scopeKey: string;[\s\S]{0,160}baseRevision: number;[\s\S]{0,120}generation: number;[\s\S]{0,120}stage: CanvasAgentStage;/);
  assert.match(workbench, /data-testid="canvas-agent-ephemeral"/);
  assert.match(workbench, /临时会话：关闭工作台、离开医生页或切换项目\/画布即清空/);
  assert.match(workbench, /data-testid="canvas-agent-stages"/);
  assert.match(workbench, /\[\['explain', '1 说明'\], \['generate', '2 计划'\], \['preview', '3 预览'\], \['apply', '4 应用'\]\]/);
  assert.match(workbench, />只解释<\/button>/);
  assert.match(workbench, /生成方案/);
  assert.match(workbench, /预览修改/);
  assert.match(workbench, /确认并原子应用/);
});

test('explain is isolated from tools, preview, apply, and queue creation', () => {
  const explain = sourceBetween(workbench, 'const explainAgentPrompt = useCallback', 'const generateAgentPlan = useCallback');
  assert.match(explain, /const explanation = explainCanvasAgentRequest\(agentPrompt\)/);
  assert.match(explain, /stage: 'explain'/);
  assert.match(explain, /setAgentExplanation\(explanation\)/);
  assert.match(explain, /setAgentPlan\(null\)/);
  assert.match(explain, /setAgentPatchQueue\(\[\]\)/);
  assert.doesNotMatch(explain, /executeCanvasAgentTool|executeTool\(|openPatchPreview|onPreviewPatch|onApplyPatch|createCanvasAgentPatchQueueItem/);
});

test('workflow generation completes bounded semantic subflow searches before contextual tools and pins only an eligible definition', () => {
  const generate = sourceBetween(workbench, 'const generateAgentPlan = useCallback', 'const changeAgentPrompt = useCallback');
  assertOrdered(
    generate,
    "const subflowQuery = buildCanvasAgentSearchQuery(agentPrompt)",
    'const subflowQueries = buildCanvasAgentSearchQueries(agentPrompt)',
    'for (let index = 0; index < subflowQueries.length; index += 1)',
    "searchResults.push(await executeTool('searchSubflows'",
    'const subflowCandidates = searchResults.flatMap(canvasAgentSubflowCandidatesFromResult)',
    'const contextual = await Promise.allSettled',
    "executeTool('inspectCanvas'",
  );
  assert.match(generate, /if \(searchResults\.some\(\(result\) => result\.truncated\)\) throw new Error\('子工作流搜索响应被截断，已停止生成'\)/);
  for (const tool of ['inspectCanvas', 'inspectNodeSchema', 'inspectRun', 'searchAssets', 'validateCanvas', 'simulateExecutionPlan', 'estimateRun']) {
    assert.match(generate, new RegExp(`executeTool\\('${tool}'`));
  }
  assert.match(generate, /const rankedSubflowCandidates = rankCanvasAgentSubflowCandidates\(agentPrompt, subflowCandidates\)/);
  assert.match(generate, /for \(const rankedCandidate of rankedSubflowCandidates\.filter\(\(item\) => item\.eligible\)\)/);
  assert.match(generate, /const candidate = rankedCandidate\.candidate/);
  assert.match(generate, /api\.getSubflow\(candidate\.id, candidate\.version, props\.projectId, \{ signal: controller\.signal \}\)/);
  assert.match(generate, /candidateDefinition\.id !== candidate\.id/);
  assert.match(generate, /candidateDefinition\.version !== candidate\.version/);
  assert.match(generate, /Number\(candidateDefinition\.revision \|\| candidateDefinition\.version\) !== candidate\.revision/);
  assert.match(generate, /String\(candidateDefinition\.projectId \|\| props\.projectId\) !== props\.projectId/);
  assert.match(generate, /canCanvasAgentReuseResolvedSubflow\(candidate, candidateDefinition, props\.projectId\)/);
  assert.match(generate, /resolvedSubflow = candidateDefinition;[\s\S]{0,80}break;/);
  assertOrdered(generate, 'const preliminaryPlan = buildCanvasAgentWorkflowPlan', 'canvasAgentExecutionProposalFromPlan(preliminaryPlan)', "executeTool('simulateExecutionPlan'", 'const finalPlan = buildCanvasAgentWorkflowPlan');
  assert.match(generate, /if \(!proposal\) throw new Error\('Agent 计划无法编译为受控的应用后画布模拟'\)/);
  assert.match(generate, /executeTool\('simulateExecutionPlan', \{ proposal \}, 6\)/);
  assert.match(generate, /currentEdges: canvasData\.edges \|\| \[\]/);

  assert.match(agent, /const rankedCandidates = rankCanvasAgentSubflowCandidates\(prompt, candidates\)/);
  assert.match(agent, /const eligibleCandidates = rankedCandidates\.filter\(\(item\) => item\.eligible\)/);
  assert.match(agent, /matchedResolvedSubflow\(eligibleCandidates, input\.resolvedSubflow, projectId\)/);
});

test('generation only creates one validated queue item and never previews or applies directly', () => {
  const generate = sourceBetween(workbench, 'const generateAgentPlan = useCallback', 'const changeAgentPrompt = useCallback');
  assert.match(generate, /setAgentPatchQueue\(finalPlan\.status === 'ready' && finalPlan\.patchDraft \? \[createCanvasAgentPatchQueueItem\(finalPlan\)\] : \[\]\)/);
  assert.doesNotMatch(generate, /openPatchPreview|confirmPatchPreview|props\.onPreviewPatch|props\.onApplyPatch|materializeCanvasPatchDraft/);

  const queueUi = sourceBetween(workbench, 'data-testid="canvas-agent-patch-queue"', 'data-testid="canvas-patch-history"');
  assert.match(queueUi, /agentPatchQueue\.length\}\/1/);
  assert.match(queueUi, /openPatchPreview\(item\.draft, item\.id\)/);
  assert.match(queueUi, /\['queued', 'failed', 'previewed'\]\.includes\(item\.status\)/);
  assert.match(queueUi, /这里没有直接应用按钮/);
  assert.doesNotMatch(queueUi, /confirmPatchPreview|props\.onApplyPatch|确认并原子应用/);
});

test('queue preview validates scope and revision while apply remains an explicit confirmation', () => {
  assert.match(workbench, /const agentPreviewApplyBlocked = Boolean\(patchPreview\?\.queueItemId && \(/);
  assert.match(workbench, /agentPreviewQueueItem\.status !== 'previewed'/);
  assert.match(workbench, /agentPreviewQueueItem\.projectId !== props\.projectId/);
  assert.match(workbench, /agentPreviewQueueItem\.canvasId !== props\.canvasId/);
  assert.match(workbench, /agentPreviewQueueItem\.baseRevision !== props\.canvasRevision/);
  assert.match(workbench, /agentPreviewQueueItem\.previewDigest !== patchPreview\.preview\.previewDigest/);
  const preview = sourceBetween(workbench, 'const openPatchPreview = useCallback', 'const confirmPatchPreview = useCallback');
  assert.match(preview, /queueItem\.projectId !== props\.projectId/);
  assert.match(preview, /queueItem\.canvasId !== props\.canvasId/);
  assert.match(preview, /queueItem\.baseRevision !== props\.canvasRevision/);
  assert.match(preview, /updateAgentQueueItem\(queueItemId, \{ status: 'previewing'/);
  assert.match(preview, /stage: 'preview'/);
  assert.match(preview, /const authoritative = await props\.onPreviewPatch\(draft\)/);
  assert.match(preview, /authoritative\.patch\.requiresConfirmation !== true/);
  assert.match(preview, /\/\^\[a-f0-9\]\{64\}\$\/i\.test\(authoritative\.preview\.previewDigest\)/);
  assert.match(preview, /status: 'previewed', previewDigest: authoritative\.preview\.previewDigest/);

  const apply = sourceBetween(workbench, 'const confirmPatchPreview = useCallback', 'const revertPatchRecord = useCallback');
  assert.match(apply, /patchPreview\.patch\.requiresConfirmation !== true/);
  assertOrdered(
    apply,
    'agentPatchQueueRef.current.find((item) => item.id === patchPreview.queueItemId)',
    "queueItem?.status === 'previewed'",
    'queueItem.projectId === props.projectId',
    'queueItem.canvasId === props.canvasId',
    'queueItem.baseRevision === props.canvasRevision',
    'queueItem.previewDigest === patchPreview.preview.previewDigest',
    'if (!queueIsCurrent)',
    'return;',
    'const requestId = patchApplyRequestRef.current + 1',
  );
  assert.match(apply, /updateAgentQueueItem\(queueItem\.id, \{ status: 'stale', error: message \}\)/);
  assert.match(apply, /status: 'applying'/);
  assert.match(apply, /stage: 'apply'/);
  assertOrdered(apply, 'await props.onApplyPatch(patchPreview.patch, patchPreview.preview)', "status: 'applied'", 'setPatchPreview(null)');
  assert.match(workbench, /openPatchPreview\(patchPreview\.draft, patchPreview\.queueItemId\)/);
  assert.match(workbench, /disabled=\{patchApplyBusy \|\| patchPreviewBusy \|\| agentPreviewApplyBlocked/);
  assert.match(workbench, /onClick=\{\(\) => void confirmPatchPreview\(\)\}[\s\S]{0,220}确认并原子应用/);
});

test('agent requests are guarded by identity, revision snapshot, generation, and AbortController', () => {
  assert.match(workbench, /const agentIdentityScopeKey = useMemo\([\s\S]{0,180}props\.projectId, props\.canvasId \|\| '', props\.open, tab === 'doctor'/);
  assert.match(workbench, /const agentSnapshotScopeKey = useMemo\([\s\S]{0,140}agentIdentityScopeKey, props\.canvasRevision/);
  assert.match(workbench, /const agentGenerationRef = useRef\(0\)/);
  assert.match(workbench, /const agentAbortRef = useRef<AbortController \| null>\(null\)/);
  assert.match(workbench, /const agentRevisionRef = useRef\(props\.canvasRevision\)/);

  const generate = sourceBetween(workbench, 'const generateAgentPlan = useCallback', 'const changeAgentPrompt = useCallback');
  assert.match(generate, /const generation = \+\+agentGenerationRef\.current/);
  assert.match(generate, /agentAbortRef\.current\?\.abort\(\)/);
  assert.match(generate, /const controller = new AbortController\(\)/);
  assert.match(generate, /controller\.signal\.aborted \|\| generation !== agentGenerationRef\.current/);
  assert.match(generate, /requestScopeKey !== agentIdentityScopeRef\.current/);
  assert.match(generate, /requestSnapshotKey !== agentSnapshotScopeRef\.current/);
  assert.match(generate, /api\.executeCanvasAgentTool\(request, \{ signal: controller\.signal \}\)/);
  assert.match(generate, /result\.canvasRevision !== baseRevision/);

  const promptChange = sourceBetween(workbench, 'const changeAgentPrompt = useCallback', 'const loadPatchHistory = useCallback');
  assert.match(promptChange, /agentGenerationRef\.current \+= 1/);
  assert.match(promptChange, /agentAbortRef\.current\?\.abort\(\)/);
  assert.match(promptChange, /item\.status === 'applied' \? item : \{ \.\.\.item, status: 'stale'/);
});

test('scope changes clear ephemeral state and revision changes stale every unapplied queue item', () => {
  const reset = sourceBetween(
    workbench,
    'useEffect(() => {\n    doctorLoadGenerationRef.current += 1;',
    'useEffect(() => {\n    if (agentRevisionIdentityRef.current !== agentIdentityScopeKey)',
  );
  assert.match(reset, /subflowLoadAbortRef\.current\?\.abort\(\)/);
  assert.match(reset, /runLoadAbortRef\.current\?\.abort\(\)/);
  assert.match(reset, /agentGenerationRef\.current \+= 1/);
  assert.match(reset, /agentAbortRef\.current\?\.abort\(\)/);
  assert.match(reset, /setAgentSession\(null\)/);
  assert.match(reset, /setAgentExplanation\(null\)/);
  assert.match(reset, /setAgentPlan\(null\)/);
  assert.match(reset, /setAgentPatchQueue\(\[\]\)/);
  assert.match(reset, /setAgentToolTrace\(\[\]\)/);
  assert.match(reset, /\}, \[props\.canvasId, props\.open, props\.projectId, tab\]\);/);

  const revision = sourceBetween(
    workbench,
    'useEffect(() => {\n    if (agentRevisionIdentityRef.current !== agentIdentityScopeKey)',
    'useEffect(() => {\n    if (!props.open) return;',
  );
  assert.match(revision, /const previousRevision = agentRevisionRef\.current/);
  assert.match(revision, /if \(previousRevision === props\.canvasRevision\) return/);
  assert.match(revision, /agentGenerationRef\.current \+= 1/);
  assert.match(revision, /agentAbortRef\.current\?\.abort\(\)/);
  assert.match(revision, /item\.status === 'applied' \? item : \{/);
  assert.match(revision, /status: 'stale'/);
  assert.match(revision, /画布已从 r\$\{item\.baseRevision\} 更新到 r\$\{props\.canvasRevision\}/);
});

test('subflow and run loaders retain project identity and reject late responses', () => {
  const subflows = sourceBetween(workbench, 'const loadSubflows = useCallback', 'const loadRuns = useCallback');
  assert.match(subflows, /const generation = \+\+subflowLoadGenerationRef\.current/);
  assert.match(subflows, /subflowLoadAbortRef\.current\?\.abort\(\)/);
  assert.match(subflows, /api\.listSubflows\(searchQuery, props\.projectId, \{ signal: controller\.signal \}\)/);
  assert.match(subflows, /controller\.signal\.aborted \|\| generation !== subflowLoadGenerationRef\.current \|\| requestScopeKey !== patchScopeKeyRef\.current/);

  const runs = sourceBetween(workbench, 'const loadRuns = useCallback', 'const updateAgentQueueItem = useCallback');
  assert.match(runs, /const generation = \+\+runLoadGenerationRef\.current/);
  assert.match(runs, /runLoadAbortRef\.current\?\.abort\(\)/);
  assert.match(runs, /api\.listProjectRuns\(\{ projectId: props\.projectId, canvasId: props\.canvasId \|\| undefined,/);
  assert.match(runs, /\}, \{ signal: controller\.signal \}\)/);
  assert.match(runs, /api\.getProjectRunRetention\(props\.projectId\)/);
  assert.match(runs, /controller\.signal\.aborted \|\| generation !== runLoadGenerationRef\.current \|\| requestScopeKey !== patchScopeKeyRef\.current/);
});

test('Workbench consistently uses projectId for project-scoped library and run operations', () => {
  assert.match(workbench, /const favoriteStorageKey = `t8-subflow-favorites:\$\{props\.projectId \|\| 'project-local'\}`/);
  assert.doesNotMatch(workbench, /t8-subflow-favorites:\$\{props\.canvasId/);
  assert.match(workbench, /api\.importSubflowPackage\(subflowPackageDraft\.file, subflowPackageDraft\.inspection\.archiveSha256, props\.projectId\)/);
  assert.match(workbench, /api\.listSubflowVersions\(definition\.id, definition\.projectId \|\| props\.projectId\)/);
  assert.match(workbench, /projectId: definition\.projectId \|\| props\.projectId/);
  assert.match(workbench, /api\.updateProjectRunRetention\(\{ \.\.\.runRetention, projectId: props\.projectId \}\)/);
  assert.match(workbench, /api\.pruneProjectRuns\(props\.projectId\)/);
  assert.equal([...workbench.matchAll(/api\.listProjectRuns\(\{ projectId: props\.projectId, canvasId: props\.canvasId \|\| undefined/g)].length, 2);
});

test('API forwards AbortSignal and parses every Agent response at the trust boundary', () => {
  const execute = sourceBetween(api, 'export async function executeCanvasAgentTool', 'export async function syncCanvasData');
  assert.match(execute, /options: \{ signal\?: AbortSignal \} = \{\}/);
  assert.match(execute, /new TextEncoder\(\)\.encode\(serialized\)\.byteLength > 64 \* 1024/);
  assert.match(execute, /`\$\{BASE\}\/canvas-agent\/tools`/);
  assert.match(execute, /signal: options\.signal/);
  assert.match(execute, /return parseCanvasAgentToolResult\(res\.data, body\)/);

  assert.match(api, /export async function listProjectRuns\([^\n]+options: \{ signal\?: AbortSignal \} = \{\}/);
  assert.match(api, /`\$\{BASE\}\/project-runs\$\{suffix\}`, \{ signal: options\.signal \}/);
  assert.match(api, /export async function listSubflows\(query = '', projectId\?: string, options: \{ signal\?: AbortSignal \} = \{\}/);
  assert.match(api, /`\$\{BASE\}\/subflows\$\{suffix\}`, \{ signal: options\.signal \}/);
  assert.match(api, /export async function getSubflow\(id: string, version\?: number, projectId\?: string, options: \{ signal\?: AbortSignal \} = \{\}/);
  assert.match(api, /export async function listSubflowVersions\(id: string, projectId\?: string, options: \{ signal\?: AbortSignal \} = \{\}/);

  const parser = sourceBetween(agent, 'export function parseCanvasAgentToolResult', 'export function canvasAgentSubflowCandidatesFromResult');
  assert.match(parser, /Object\.keys\(result\)\.some\(\(key\) => !AGENT_RESULT_KEYS\.has\(key\)\)/);
  assert.match(parser, /result\.tool !== expected\.tool/);
  assert.match(parser, /result\.requestId !== expected\.requestId/);
  assert.match(parser, /result\.projectId !== expected\.projectId \|\| result\.canvasId !== expected\.canvasId/);
  assert.match(parser, /result\.readOnly !== true/);
  assert.match(parser, /nodeSchemaDigest !== CANVAS_AGENT_LOCAL_NODE_SCHEMA_DIGEST/);
  assert.match(parser, /assertPublicJson\(result\.data, 'Agent data'\)/);
  assert.match(parser, /canvasAgentDigest\(digestEnvelope\) !== digest/);
  assert.match(parser, /byteLength > 64 \* 1024/);
});
