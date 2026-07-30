const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CREATOR_ARTIFACT_COMPILATION_SCHEMA,
  CREATOR_ARTIFACT_PROPOSAL_SCHEMA,
  CREATOR_ARTIFACT_VERSION_SCHEMA,
  compileCreatorArtifactVersion,
  createCreatorArtifactProposal,
  creatorArtifactKindForTaskFamily,
  creatorArtifactSummaries,
  normalizeCreatorArtifactProposal,
  normalizeCreatorArtifactVersion,
} = require('../backend/src/services/creatorAgentArtifacts');

const RESPONSE_DIGEST = 'b'.repeat(64);
const EVIDENCE_DIGEST = 'e'.repeat(64);

function proposal(overrides = {}) {
  return createCreatorArtifactProposal({
    taskFamily: 'commerce',
    prompt: '为这款咖啡做一套电商商品图',
    responseText: '# 商品图方案\n\n## 首屏\n主标题：清晨第一杯。',
    mode: 'online-model',
    responseEvidence: { evidenceDigest: EVIDENCE_DIGEST },
    ...overrides,
  });
}

function compile(value, overrides = {}) {
  return compileCreatorArtifactVersion({
    sessionId: 'cs_artifact_test_session',
    responseId: 'response-1',
    responseDigest: RESPONSE_DIGEST,
    responseText: value.content.bodyMarkdown,
    responseEvidence: { evidenceDigest: EVIDENCE_DIGEST },
    proposal: value,
    existingVersions: [],
    planDigest: 'plan-digest',
    createdAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  });
}

test('maps every Creator task family to a specific editable artifact kind', () => {
  assert.deepEqual({
    commerce: creatorArtifactKindForTaskFamily('commerce'),
    image: creatorArtifactKindForTaskFamily('image'),
    video: creatorArtifactKindForTaskFamily('video'),
    story: creatorArtifactKindForTaskFamily('story'),
    audio: creatorArtifactKindForTaskFamily('audio'),
    mixed: creatorArtifactKindForTaskFamily('mixed'),
  }, {
    commerce: 'CommerceContentPlan',
    image: 'EditPlan',
    video: 'MotionPlan',
    story: 'ScriptDoc',
    audio: 'AudioPlan',
    mixed: 'ProductionBrief',
  });
});

test('proposal preserves the exact response body and derives stable Markdown sections', () => {
  const body = '\n# 人设方案\r\n\r\n## 外观\r\n黑色短发。\r\n\r\n## 动机\r\n寻找失踪的搭档。\n';
  const value = proposal({
    taskFamily: 'story',
    responseText: body,
  });
  assert.equal(value.schema, CREATOR_ARTIFACT_PROPOSAL_SCHEMA);
  assert.equal(value.content.bodyMarkdown, body.replace(/\r\n/g, '\n'));
  assert.deepEqual(value.content.sections.map((section) => section.title), [
    '正文',
    '人设方案',
    '外观',
    '动机',
  ]);
  assert.deepEqual(normalizeCreatorArtifactProposal(value), value);
  assert.equal(Object.prototype.hasOwnProperty.call(value, 'prompt'), false);
});

test('proposal validation rejects credential and local-user-path leakage', () => {
  const secret = proposal({ responseText: '# 配置\nAPI_KEY=sk-thisShouldNeverPersist123456' });
  const localPath = proposal({ responseText: '# 文件\nC:\\Users\\Alice\\secret.png' });
  assert.equal(normalizeCreatorArtifactProposal(secret), null);
  assert.equal(normalizeCreatorArtifactProposal(localPath), null);
});

test('compiles the first response into revision 1 with an add diff', () => {
  const result = compile(proposal());
  assert.equal(result.schema, CREATOR_ARTIFACT_COMPILATION_SCHEMA);
  assert.equal(result.status, 'created');
  assert.equal(result.artifactVersion.schema, CREATOR_ARTIFACT_VERSION_SCHEMA);
  assert.equal(result.artifactVersion.revision, 1);
  assert.equal(result.artifactVersion.status, 'model-draft');
  assert.deepEqual(result.artifactVersion.diff.operations.map((item) => [item.op, item.path]), [
    ['add', '/'],
  ]);
  assert.deepEqual(normalizeCreatorArtifactVersion(result.artifactVersion), result.artifactVersion);
});

test('increments the same artifact and records a bounded semantic diff', () => {
  const first = compile(proposal()).artifactVersion;
  const secondProposal = proposal({
    responseText: '# 商品图方案\n\n## 首屏\n主标题：清醒从第一口开始。\n\n## 详情页\n补充烘焙信息。',
  });
  const second = compile(secondProposal, {
    responseId: 'response-2',
    existingVersions: [first],
    createdAt: '2026-07-29T00:01:00.000Z',
  });
  assert.equal(second.status, 'created');
  assert.equal(second.artifactVersion.artifactId, first.artifactId);
  assert.equal(second.artifactVersion.revision, 2);
  assert.equal(second.artifactVersion.diff.baseVersionId, first.versionId);
  assert.deepEqual(second.artifactVersion.diff.operations.map((item) => item.path), [
    '/bodyMarkdown',
    '/sections',
  ]);
});

test('reuses the current version when editable content is unchanged', () => {
  const value = proposal();
  const first = compile(value).artifactVersion;
  const repeated = compile(value, {
    responseId: 'response-2',
    existingVersions: [first],
  });
  assert.equal(repeated.status, 'reused');
  assert.equal(repeated.artifactVersion.versionId, first.versionId);
  assert.equal(repeated.artifactVersion.revision, 1);
});

test('invalid or mismatched proposals keep a failed compilation with no artifact side effect', () => {
  const value = proposal();
  const tampered = structuredClone(value);
  tampered.content.bodyMarkdown = '# 被篡改的正文';
  const invalid = compile(tampered);
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.artifactVersion, null);

  const mismatch = compile(value, { responseText: '# 另一份正文' });
  assert.equal(mismatch.status, 'failed');
  assert.equal(mismatch.artifactVersion, null);
});

test('summaries expose only the latest valid version for each artifact', () => {
  const first = compile(proposal()).artifactVersion;
  const second = compile(proposal({
    responseText: '# 商品图方案\n\n第二版。',
  }), {
    responseId: 'response-2',
    existingVersions: [first],
    createdAt: '2026-07-29T00:01:00.000Z',
  }).artifactVersion;
  const summaries = creatorArtifactSummaries([first, second]);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].versionId, second.versionId);
  assert.equal(summaries[0].revision, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(summaries[0], 'bodyMarkdown'), false);
});
