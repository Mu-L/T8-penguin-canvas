import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowIssue } from '../src/utils/workflowDoctor.ts';
import {
  analyzeWorkflow,
  applyCanvasPatch,
} from '../src/utils/workflowDoctor.ts';
import {
  WORKFLOW_DOCTOR_E5_BAD_CASES,
  WORKFLOW_DOCTOR_E5_CLEAN_CASES,
  WORKFLOW_DOCTOR_E5_CORPUS,
  canonicalWorkflowDoctorE5Graph,
  workflowDoctorE5ExpectedDiagnosticKey,
  workflowDoctorE5IssueKey,
  type WorkflowDoctorE5ExpectedDiagnostic,
} from './helpers/workflowDoctorE5Corpus.ts';

interface DiagnosticScore {
  tp: number;
  fp: number;
  fn: number;
}

interface RuleScore extends DiagnosticScore {
  expected: number;
  actual: number;
}

function countKeys(keys: readonly string[]) {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  return counts;
}

function scoreKeys(expectedKeys: readonly string[], actualKeys: readonly string[]): DiagnosticScore {
  const expected = countKeys(expectedKeys);
  const actual = countKeys(actualKeys);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  for (const key of keys) {
    const expectedCount = expected.get(key) || 0;
    const actualCount = actual.get(key) || 0;
    tp += Math.min(expectedCount, actualCount);
    fp += Math.max(0, actualCount - expectedCount);
    fn += Math.max(0, expectedCount - actualCount);
  }
  return { tp, fp, fn };
}

function expectedKeys(diagnostics: readonly WorkflowDoctorE5ExpectedDiagnostic[]) {
  return diagnostics.map(workflowDoctorE5ExpectedDiagnosticKey);
}

function actualKeys(issues: readonly WorkflowIssue[]) {
  return issues.map(workflowDoctorE5IssueKey);
}

function addScore(target: DiagnosticScore, score: DiagnosticScore) {
  target.tp += score.tp;
  target.fp += score.fp;
  target.fn += score.fn;
}

test('E5 corpus contains fixed per-case truth for 120 bad workflows and 20 clean controls', () => {
  assert.equal(WORKFLOW_DOCTOR_E5_BAD_CASES.length, 120);
  assert.equal(WORKFLOW_DOCTOR_E5_CLEAN_CASES.length, 20);
  assert.equal(WORKFLOW_DOCTOR_E5_CORPUS.length, 140);
  assert.equal(new Set(WORKFLOW_DOCTOR_E5_CORPUS.map((item) => item.id)).size, 140);

  const familyCounts = Object.fromEntries(
    [...new Set(WORKFLOW_DOCTOR_E5_CORPUS.map((item) => item.family))]
      .map((family) => [
        family,
        WORKFLOW_DOCTOR_E5_CORPUS.filter((item) => item.family === family).length,
      ]),
  );
  assert.deepEqual(familyCounts, {
    'invalid-position': 30,
    'dangling-edge': 30,
    'self-edge': 30,
    'duplicate-edge': 30,
    'clean-text': 20,
  });

  for (const item of WORKFLOW_DOCTOR_E5_BAD_CASES) {
    assert.equal(item.kind, 'bad', item.id);
    assert.ok(item.expectedDiagnostics.length > 0, `${item.id} 缺少逐例诊断真值`);
    assert.ok(item.repair, `${item.id} 缺少自动修复真值`);
    const keys = expectedKeys(item.expectedDiagnostics);
    assert.equal(new Set(keys).size, keys.length, `${item.id} 包含重复诊断真值`);
  }
  for (const item of WORKFLOW_DOCTOR_E5_CLEAN_CASES) {
    assert.equal(item.kind, 'clean', item.id);
    assert.deepEqual(item.expectedDiagnostics, [], `${item.id} 不是严格干净控制`);
    assert.equal(item.repair, undefined, `${item.id} 不应声明修复`);
  }
});

test('E5 corpus computes exact TP/FP/FN, precision/recall, and per-rule localization metrics', (t) => {
  const aggregate: DiagnosticScore = { tp: 0, fp: 0, fn: 0 };
  const failures: Array<{
    id: string;
    expected: string[];
    actual: string[];
    score: DiagnosticScore;
  }> = [];
  const perRule = new Map<string, RuleScore>();

  for (const item of WORKFLOW_DOCTOR_E5_CORPUS) {
    const issues = analyzeWorkflow(item.nodes, item.edges, item.context);
    const expected = expectedKeys(item.expectedDiagnostics);
    const actual = actualKeys(issues);
    const score = scoreKeys(expected, actual);
    addScore(aggregate, score);
    if (score.fp > 0 || score.fn > 0) {
      failures.push({ id: item.id, expected, actual, score });
    }

    const ruleIds = new Set([
      ...item.expectedDiagnostics.map((diagnostic) => diagnostic.ruleId),
      ...issues.map((issue) => issue.ruleId),
    ]);
    for (const ruleId of ruleIds) {
      const expectedForRule = item.expectedDiagnostics
        .filter((diagnostic) => diagnostic.ruleId === ruleId)
        .map(workflowDoctorE5ExpectedDiagnosticKey);
      const actualForRule = issues
        .filter((issue) => issue.ruleId === ruleId)
        .map(workflowDoctorE5IssueKey);
      const scoreForRule = scoreKeys(expectedForRule, actualForRule);
      const current = perRule.get(ruleId) || {
        expected: 0,
        actual: 0,
        tp: 0,
        fp: 0,
        fn: 0,
      };
      current.expected += expectedForRule.length;
      current.actual += actualForRule.length;
      addScore(current, scoreForRule);
      perRule.set(ruleId, current);
    }
  }

  const precision = aggregate.tp + aggregate.fp === 0
    ? 1
    : aggregate.tp / (aggregate.tp + aggregate.fp);
  const recall = aggregate.tp + aggregate.fn === 0
    ? 1
    : aggregate.tp / (aggregate.tp + aggregate.fn);
  const report = {
    schema: 't8-workflow-doctor-e5-evaluation-v1',
    cases: WORKFLOW_DOCTOR_E5_CORPUS.length,
    badCases: WORKFLOW_DOCTOR_E5_BAD_CASES.length,
    cleanControls: WORKFLOW_DOCTOR_E5_CLEAN_CASES.length,
    expectedDiagnostics: WORKFLOW_DOCTOR_E5_CORPUS
      .reduce((sum, item) => sum + item.expectedDiagnostics.length, 0),
    ...aggregate,
    precision,
    recall,
    perRule: Object.fromEntries([...perRule.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };

  t.diagnostic(JSON.stringify(report));
  assert.equal(aggregate.tp, 150);
  assert.equal(aggregate.fp, 0, JSON.stringify(failures, null, 2));
  assert.equal(aggregate.fn, 0, JSON.stringify(failures, null, 2));
  assert.equal(precision, 1);
  assert.equal(recall, 1);
  assert.deepEqual([...perRule.keys()].sort(), [
    'layout.invalid-position',
    'topology.cycle',
    'topology.dangling-edge',
    'topology.duplicate-edge',
    'topology.self-edge',
  ]);
});

test('E5 corpus computes automatic-repair opportunities and rejects graph drift as misrepair', (t) => {
  let repairOpportunities = 0;
  let appliedRepairs = 0;
  let misrepairs = 0;
  const failures: Array<{ id: string; reason: string }> = [];

  for (const item of WORKFLOW_DOCTOR_E5_BAD_CASES) {
    if (!item.repair) continue;
    repairOpportunities += 1;
    const originalGraph = canonicalWorkflowDoctorE5Graph(item);
    const issues = analyzeWorkflow(item.nodes, item.edges, item.context);
    const repairKey = workflowDoctorE5ExpectedDiagnosticKey(item.repair.diagnostic);
    const repairIssue = issues.find((issue) => workflowDoctorE5IssueKey(issue) === repairKey);
    if (!repairIssue?.patch) {
      misrepairs += 1;
      failures.push({ id: item.id, reason: '没有找到带 Patch 的预期诊断' });
      continue;
    }

    try {
      const result = applyCanvasPatch(item.nodes, item.edges, repairIssue.patch);
      appliedRepairs += 1;
      const graphMatches = canonicalWorkflowDoctorE5Graph(result)
        === canonicalWorkflowDoctorE5Graph(item.repair.expectedGraph);
      const remainingIssues = analyzeWorkflow(result.nodes, result.edges, item.context);
      const remainingScore = scoreKeys(
        expectedKeys(item.repair.expectedRemainingDiagnostics),
        actualKeys(remainingIssues),
      );
      const sourceUnchanged = canonicalWorkflowDoctorE5Graph(item) === originalGraph;
      if (!graphMatches || remainingScore.fp > 0 || remainingScore.fn > 0 || !sourceUnchanged) {
        misrepairs += 1;
        failures.push({
          id: item.id,
          reason: JSON.stringify({
            graphMatches,
            sourceUnchanged,
            remainingScore,
            remainingActual: actualKeys(remainingIssues),
          }),
        });
      }
    } catch (error) {
      misrepairs += 1;
      failures.push({
        id: item.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const misrepairRate = repairOpportunities === 0 ? 0 : misrepairs / repairOpportunities;
  t.diagnostic(JSON.stringify({
    schema: 't8-workflow-doctor-e5-repair-evaluation-v1',
    repairOpportunities,
    appliedRepairs,
    misrepairs,
    misrepairRate,
  }));
  assert.equal(repairOpportunities, 120);
  assert.equal(appliedRepairs, 120);
  assert.equal(misrepairs, 0, JSON.stringify(failures, null, 2));
  assert.equal(misrepairRate, 0);
});
