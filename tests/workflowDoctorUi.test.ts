import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workbench = readFileSync(new URL('../src/components/ProjectWorkbench.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/services/api.ts', import.meta.url), 'utf8');
const doctor = readFileSync(new URL('../src/utils/workflowDoctor.ts', import.meta.url), 'utf8');
const canvas = readFileSync(new URL('../src/components/Canvas.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles/index.css', import.meta.url), 'utf8');

test('workflow doctor UI renders the stable rule, evidence, location, fixability, and version contract', () => {
  assert.match(workbench, /data-testid="workflow-doctor"/);
  assert.match(workbench, /WORKFLOW_DOCTOR_RULE_COUNT/);
  assert.match(workbench, /data-rule-id=\{item\.ruleId\}/);
  assert.match(workbench, /item\.fixability === 'automatic'/);
  assert.match(workbench, /item\.applicableVersion\.minAppVersion/);
  assert.match(workbench, /item\.location\.scope/);
  assert.match(workbench, /Object\.entries\(item\.evidence\.facts\)/);
  assert.match(workbench, /稳定证据 · \{item\.evidence\.code\}/);
});

test('doctor context is bounded and uses only proven project asset references', () => {
  assert.match(workbench, /collectWorkflowAssetIds\(props\.nodes\)/);
  assert.match(workbench, /props\.open && tab === 'doctor' \? collectWorkflowAssetIds\(props\.nodes\) : \[\]/);
  assert.match(workbench, /doctorAssetIds\.slice\(0, 64\)/);
  assert.match(workbench, /index \+= 6/);
  assert.match(workbench, /api\.getProjectAsset\(assetId, \{ signal: controller\.signal \}\)/);
  assert.match(doctor, /顶层 sourceAssetId/);
  assert.doesNotMatch(doctor, /key === 'assetId'/);
});

test('closed and non-doctor workbench states skip analysis while node drags keep a stable remote request key', () => {
  const issuesMemo = workbench.slice(workbench.indexOf('const issues = useMemo'), workbench.indexOf('const favoriteStorageKey'));
  const remoteEffectStart = workbench.lastIndexOf('useEffect(() => {', workbench.indexOf('const remotePromise'));
  const remoteEffect = workbench.slice(remoteEffectStart, workbench.indexOf('\n\n  if (!props.open) return null;', remoteEffectStart));
  const effectDependencies = remoteEffect.slice(remoteEffect.lastIndexOf('}, ['));
  assert.match(issuesMemo, /if \(!props\.open \|\| tab !== 'doctor'\) return \[\];/);
  assert.ok(issuesMemo.indexOf("tab !== 'doctor'") < issuesMemo.indexOf('analyzeWorkflow('));
  assert.match(workbench, /const doctorAssetIdKey = useMemo\(/);
  assert.match(effectDependencies, /doctorAssetIdKey/);
  assert.match(effectDependencies, /props\.canvasRevision/);
  assert.doesNotMatch(effectDependencies, /doctorAssetIds/);
});

test('remote doctor state is scope-bound, reset on load, and keeps missing and cross-project asset facts', () => {
  assert.match(workbench, /interface DoctorRemoteContext \{\s+scopeKey: string;/);
  assert.match(workbench, /doctorRemoteContext\.scopeKey === doctorScopeKey/);
  const issuesMemo = workbench.slice(workbench.indexOf('const issues = useMemo'), workbench.indexOf('const favoriteStorageKey'));
  assert.match(issuesMemo, /scopedDoctorRemoteContext\.assets/);
  assert.doesNotMatch(issuesMemo, /doctorRemoteContext\./);
  assert.match(workbench, /setDoctorRemoteContext\(EMPTY_DOCTOR_REMOTE_CONTEXT\)/);
  assert.match(workbench, /setDoctorRemoteContext\(\{\s+\.\.\.EMPTY_DOCTOR_REMOTE_CONTEXT,\s+scopeKey: doctorScopeKey,/);
  assert.match(workbench, /JSON\.stringify\(\[props\.projectId, props\.canvasId \|\| '', props\.canvasRevision,/);
  assert.doesNotMatch(workbench, /setDoctorRemoteContext\(\(current\) => \(\{ \.\.\.current/);
  assert.match(workbench, /result\.status === 'rejected'[\s\S]{0,260}status === 404[\s\S]{0,80}'missing'/);
  assert.match(workbench, /unavailableAssetCount \+= 1/);
  assert.match(workbench, /unavailableAssetCount > 0/);
  assert.doesNotMatch(workbench, /availability: 'unverified'/);
  assert.match(workbench, /projectId: result\.value\.projectId/);
  assert.match(workbench, /projectId: props\.projectId,\s+providers:/);
});

test('provider context passes capability facts and booleans, never raw settings or execution tokens', () => {
  assert.match(workbench, /advancedProviderModelOptions\(provider, 'image'\)/);
  assert.match(workbench, /advancedProviderModelOptions\(provider, 'video'\)/);
  assert.match(workbench, /advancedProviderModelOptions\(provider, 'llm'\)/);
  assert.match(workbench, /regionCredentialConfigured: hasAdvancedProviderSecret\(provider\.apiKey\)/);
  assert.doesNotMatch(workbench, /getRawSettings/);
  assert.match(workbench, /activeNodeIds: \[\.\.\.new Set\(\[\.\.\.liveRunningNodeIds, \.\.\.Object\.keys\(liveExecutionTokenNodeIds\)\]\)\]/);
  assert.doesNotMatch(workbench, /executionToken:\s*liveExecutionToken/);
});

test('doctor loads explicit run, intent, and host policy context through scoped APIs', () => {
  assert.match(workbench, /api\.listProjectRuns\(\{ projectId: props\.projectId, canvasId: props\.canvasId \|\| undefined, limit: 30 \}, \{ signal: controller\.signal \}\)/);
  assert.match(workbench, /api\.listCollaborationRunIntents\('actionable', props\.projectId, props\.canvasId, \{ signal: controller\.signal \}\)/);
  assert.match(workbench, /const policyPromise = intentsPromise\.then\(\(intents\) => \{[\s\S]*selectDoctorReservedRunIntent\(intents\)[\s\S]*excludeIntentId: reservedIntent\?\.id/);
  assert.match(api, /export async function getCollaborationExecutionPolicy\([\s\S]{0,160}options: \{ signal\?: AbortSignal; excludeIntentId\?: string \}/);
  assert.match(api, /params\.set\('excludeIntentId', options\.excludeIntentId\)/);
  assert.match(api, /collaboration\/execution-policy/);
});

test('doctor passes authoritative cost limits and keeps raw IDs local to actions only', () => {
  assert.match(workbench, /dailyCost: usage\?\.dailyCost/);
  assert.match(workbench, /dailyCostLimit: policy\?\.dailyCostLimit/);
  assert.match(workbench, /allowedModels: policy\?\.allowedModels/);
  assert.match(workbench, /activeCount: usage\?\.activeCount/);
  assert.match(workbench, /concurrencyLimit: policy\?\.concurrencyLimit/);
  assert.match(workbench, /reservedIntent\?\.estimatedCostKnown === true/);
  assert.doesNotMatch(workbench, /Math\.max\(\.\.\.pendingEstimatedCosts\)/);
  assert.match(workbench, /props\.onFocusNode\(item\.targetNodeIds\?\.\[0\] \|\| item\.nodeIds\[0\]\)/);
  assert.match(workbench, />定位 \{item\.nodeIds\[0\]\}</);
  assert.match(workbench, /affectedNodeIds\.map\(\(id\) => workflowDisplayId\(id\)\)/);
  assert.match(workbench, /affectedEdgeIds\.map\(\(id\) => workflowDisplayId\(id\)\)/);
  assert.match(workbench, /workflowDisplayId\(change\.targetId\)/);
  assert.doesNotMatch(workbench, /patchPreview\.operations\.map/);
});

test('E5 Doctor merges digest-verified recursive validation and clears non-invasive canvas markers outside the Doctor tab', () => {
  assert.match(workbench, /tool: 'validateCanvas'/);
  assert.match(workbench, /workflowIssuesFromCanvasAgentValidation\(/);
  assert.match(workbench, /onDoctorHighlightsChange:/);
  assert.match(workbench, /buildWorkflowDoctorCanvasHighlights\(issues, props\.edges\)/);
  assert.match(workbench, /props\.onDoctorHighlightsChange\(\[\]\)/);
  assert.match(canvas, /WorkflowDoctorHighlightContext/);
  assert.match(canvas, /t8-workflow-doctor-node-marker/);
  assert.match(canvas, /t8-workflow-doctor-port-highlight/);
  assert.match(styles, /\.t8-workflow-doctor-node-marker/);
  assert.match(styles, /\.react-flow__handle\.t8-workflow-doctor-port-highlight/);
  assert.doesNotMatch(canvas, /data:\s*\{\s*\.\.\.\(node\.data[\s\S]{0,120}doctor/i);
});
