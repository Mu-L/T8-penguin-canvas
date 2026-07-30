const crypto = require('node:crypto');

const CREATOR_ARTIFACT_PROPOSAL_SCHEMA = 't8-creator-artifact-proposal-v1';
const CREATOR_ARTIFACT_CONTENT_SCHEMA = 't8-creator-artifact-content-v1';
const CREATOR_ARTIFACT_VERSION_SCHEMA = 't8-creator-artifact-version-v1';
const CREATOR_ARTIFACT_DIFF_SCHEMA = 't8-creator-artifact-diff-v1';
const CREATOR_ARTIFACT_COMPILATION_SCHEMA = 't8-creator-artifact-compilation-v1';

const CREATOR_ARTIFACT_MAX_BODY = 80_000;
const CREATOR_ARTIFACT_MAX_VERSIONS = 120;

const TASK_FAMILY_KINDS = Object.freeze({
  commerce: 'CommerceContentPlan',
  image: 'EditPlan',
  video: 'MotionPlan',
  story: 'ScriptDoc',
  audio: 'AudioPlan',
  mixed: 'ProductionBrief',
});

const TASK_FAMILY_TITLES = Object.freeze({
  commerce: '商品内容方案',
  image: '图像创作方案',
  video: '视频创作方案',
  story: '剧本与分镜方案',
  audio: '声音创作方案',
  mixed: '完整作品方案',
});

function stableString(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableString(value[key])}`)
    .join(',')}}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(stableString(value)).digest('hex');
}

function boundedText(value, maximum = 2_000) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maximum);
}

function boundedBody(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .slice(0, CREATOR_ARTIFACT_MAX_BODY);
}

function validDigest(value) {
  return /^[a-f0-9]{64}$/.test(String(value || '').toLowerCase());
}

function creatorArtifactKindForTaskFamily(value) {
  const family = boundedText(value, 40).toLowerCase();
  return TASK_FAMILY_KINDS[family] || TASK_FAMILY_KINDS.mixed;
}

function creatorArtifactTitleForTaskFamily(value) {
  const family = boundedText(value, 40).toLowerCase();
  return TASK_FAMILY_TITLES[family] || TASK_FAMILY_TITLES.mixed;
}

function normalizeTaskFamily(value) {
  const family = boundedText(value, 40).toLowerCase();
  return Object.prototype.hasOwnProperty.call(TASK_FAMILY_KINDS, family)
    ? family
    : 'mixed';
}

function sectionId(index, level, title) {
  return `section_${String(index + 1).padStart(2, '0')}_${digest({
    schema: 't8-creator-artifact-section-id-v1',
    index,
    level,
    title,
  }).slice(0, 12)}`;
}

function parseMarkdownSections(value) {
  const body = boundedBody(value);
  if (!body) return [];
  const lines = body.split('\n');
  const sections = [];
  let current = null;

  const pushCurrent = () => {
    if (!current) return;
    const sectionBody = current.lines.join('\n').trim();
    sections.push({
      id: sectionId(sections.length, current.level, current.title),
      title: current.title,
      level: current.level,
      bodyMarkdown: sectionBody,
    });
  };

  for (const line of lines) {
    const match = line.match(/^\s*(#{1,4})\s+(.+?)\s*$/u);
    if (!match) {
      if (!current) current = { title: '正文', level: 1, lines: [] };
      current.lines.push(line);
      continue;
    }
    pushCurrent();
    current = {
      title: boundedText(match[2].replace(/[*_`]/g, ''), 120) || '未命名段落',
      level: match[1].length,
      lines: [],
    };
  }
  pushCurrent();
  return sections.slice(0, 48);
}

function secretLeakReason(value) {
  const body = String(value || '');
  if (/\bsk-[A-Za-z0-9_-]{12,}\b/u.test(body)) return 'credential-token';
  if (/\b(?:authorization|api[_ -]?key)\s*[:=]\s*(?:bearer\s+)?[^\s]{12,}/iu.test(body)) {
    return 'credential-field';
  }
  if (/(?:^|[\s"'`])(?:[A-Z]:\\Users\\|\/Users\/|\/home\/)[^\s"'`]+/imu.test(body)) {
    return 'local-user-path';
  }
  return '';
}

function artifactContent(bodyMarkdown) {
  const body = boundedBody(bodyMarkdown);
  const sections = parseMarkdownSections(body);
  const content = {
    schema: CREATOR_ARTIFACT_CONTENT_SCHEMA,
    bodyMarkdown: body,
    sections,
  };
  content.contentDigest = digest(content);
  return content;
}

function proposalDigestPayload(proposal) {
  return {
    schema: proposal.schema,
    proposalId: proposal.proposalId,
    taskFamily: proposal.taskFamily,
    kind: proposal.kind,
    title: proposal.title,
    mode: proposal.mode,
    promptDigest: proposal.promptDigest,
    source: proposal.source,
    content: proposal.content,
  };
}

function createCreatorArtifactProposal(input = {}) {
  const taskFamily = normalizeTaskFamily(input.taskFamily);
  const kind = creatorArtifactKindForTaskFamily(taskFamily);
  const title = boundedText(input.title, 160) || creatorArtifactTitleForTaskFamily(taskFamily);
  const mode = boundedText(input.mode, 40) || 'offline-structure';
  const promptDigest = digest({
    schema: 't8-creator-artifact-prompt-v1',
    prompt: boundedBody(input.prompt),
  });
  const content = artifactContent(input.responseText);
  const responseEvidenceDigest = boundedText(
    input.responseEvidence?.evidenceDigest || input.responseEvidenceDigest,
    64,
  ).toLowerCase();
  const source = {
    schema: 't8-creator-artifact-source-v1',
    responseBodyDigest: digest({
      schema: 't8-creator-response-body-v1',
      text: content.bodyMarkdown,
    }),
    ...(validDigest(responseEvidenceDigest) ? { responseEvidenceDigest } : {}),
  };
  const proposalId = `cap_${digest({
    schema: CREATOR_ARTIFACT_PROPOSAL_SCHEMA,
    taskFamily,
    kind,
    title,
    mode,
    promptDigest,
    source,
    contentDigest: content.contentDigest,
  }).slice(0, 32)}`;
  const proposal = {
    schema: CREATOR_ARTIFACT_PROPOSAL_SCHEMA,
    proposalId,
    taskFamily,
    kind,
    title,
    mode,
    promptDigest,
    source,
    content,
  };
  proposal.proposalDigest = digest(proposalDigestPayload(proposal));
  return proposal;
}

function normalizeCreatorArtifactContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== CREATOR_ARTIFACT_CONTENT_SCHEMA) return null;
  const bodyMarkdown = boundedBody(value.bodyMarkdown);
  if (!bodyMarkdown || secretLeakReason(bodyMarkdown)) return null;
  const expected = artifactContent(bodyMarkdown);
  if (value.contentDigest !== expected.contentDigest
    || stableString(value.sections) !== stableString(expected.sections)) return null;
  return expected;
}

function normalizeCreatorArtifactProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== CREATOR_ARTIFACT_PROPOSAL_SCHEMA) return null;
  const taskFamily = normalizeTaskFamily(value.taskFamily);
  const kind = boundedText(value.kind, 80);
  const title = boundedText(value.title, 160);
  const mode = boundedText(value.mode, 40);
  const promptDigest = boundedText(value.promptDigest, 64).toLowerCase();
  const proposalId = boundedText(value.proposalId, 80);
  const content = normalizeCreatorArtifactContent(value.content);
  const responseBodyDigest = boundedText(value.source?.responseBodyDigest, 64).toLowerCase();
  const responseEvidenceDigest = boundedText(value.source?.responseEvidenceDigest, 64).toLowerCase();
  if (kind !== creatorArtifactKindForTaskFamily(taskFamily)
    || !title || !mode || !content || !validDigest(promptDigest)
    || !/^cap_[a-f0-9]{32}$/.test(proposalId)
    || !validDigest(responseBodyDigest)
    || responseBodyDigest !== digest({
      schema: 't8-creator-response-body-v1',
      text: content.bodyMarkdown,
    })
    || (responseEvidenceDigest && !validDigest(responseEvidenceDigest))) return null;
  const proposal = {
    schema: CREATOR_ARTIFACT_PROPOSAL_SCHEMA,
    proposalId,
    taskFamily,
    kind,
    title,
    mode,
    promptDigest,
    source: {
      schema: 't8-creator-artifact-source-v1',
      responseBodyDigest,
      ...(responseEvidenceDigest ? { responseEvidenceDigest } : {}),
    },
    content,
  };
  const proposalDigest = boundedText(value.proposalDigest, 64).toLowerCase();
  if (!validDigest(proposalDigest)
    || proposalDigest !== digest(proposalDigestPayload(proposal))) return null;
  proposal.proposalDigest = proposalDigest;
  return proposal;
}

function diffForVersions(previous, next) {
  if (!previous) {
    return {
      schema: CREATOR_ARTIFACT_DIFF_SCHEMA,
      baseRevision: 0,
      baseVersionId: null,
      operations: [{ op: 'add', path: '/', afterDigest: next.content.contentDigest }],
    };
  }
  const operations = [];
  if (previous.title !== next.title) {
    operations.push({
      op: 'replace',
      path: '/title',
      beforeDigest: digest(previous.title),
      afterDigest: digest(next.title),
    });
  }
  if (previous.content.bodyMarkdown !== next.content.bodyMarkdown) {
    operations.push({
      op: 'replace',
      path: '/bodyMarkdown',
      beforeDigest: digest(previous.content.bodyMarkdown),
      afterDigest: digest(next.content.bodyMarkdown),
    });
  }
  if (stableString(previous.content.sections) !== stableString(next.content.sections)) {
    operations.push({
      op: 'replace',
      path: '/sections',
      beforeDigest: digest(previous.content.sections),
      afterDigest: digest(next.content.sections),
    });
  }
  return {
    schema: CREATOR_ARTIFACT_DIFF_SCHEMA,
    baseRevision: previous.revision,
    baseVersionId: previous.versionId,
    operations,
  };
}

function versionDigestPayload(value) {
  return {
    schema: value.schema,
    artifactId: value.artifactId,
    versionId: value.versionId,
    revision: value.revision,
    taskFamily: value.taskFamily,
    kind: value.kind,
    title: value.title,
    status: value.status,
    content: value.content,
    source: value.source,
    diff: value.diff,
    createdAt: value.createdAt,
  };
}

function normalizeCreatorArtifactDiff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== CREATOR_ARTIFACT_DIFF_SCHEMA) return null;
  const baseRevision = Math.max(0, Math.trunc(Number(value.baseRevision) || 0));
  const baseVersionId = value.baseVersionId == null
    ? null : boundedText(value.baseVersionId, 80);
  const operations = (Array.isArray(value.operations) ? value.operations : [])
    .slice(0, 8)
    .map((operation) => {
      const op = boundedText(operation?.op, 20);
      const path = boundedText(operation?.path, 80);
      const beforeDigest = boundedText(operation?.beforeDigest, 64).toLowerCase();
      const afterDigest = boundedText(operation?.afterDigest, 64).toLowerCase();
      if (!['add', 'replace', 'remove'].includes(op) || !path
        || (beforeDigest && !validDigest(beforeDigest))
        || (afterDigest && !validDigest(afterDigest))) return null;
      return {
        op,
        path,
        ...(beforeDigest ? { beforeDigest } : {}),
        ...(afterDigest ? { afterDigest } : {}),
      };
    })
    .filter(Boolean);
  if (operations.length === 0) return null;
  return {
    schema: CREATOR_ARTIFACT_DIFF_SCHEMA,
    baseRevision,
    baseVersionId,
    operations,
  };
}

function normalizeCreatorArtifactVersion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== CREATOR_ARTIFACT_VERSION_SCHEMA) return null;
  const artifactId = boundedText(value.artifactId, 80);
  const versionId = boundedText(value.versionId, 80);
  const revision = Math.max(1, Math.trunc(Number(value.revision) || 0));
  const taskFamily = normalizeTaskFamily(value.taskFamily);
  const kind = boundedText(value.kind, 80);
  const title = boundedText(value.title, 160);
  const status = boundedText(value.status, 40);
  const content = normalizeCreatorArtifactContent(value.content);
  const diff = normalizeCreatorArtifactDiff(value.diff);
  const createdAt = boundedText(value.createdAt, 80);
  const source = value.source && typeof value.source === 'object' && !Array.isArray(value.source)
    ? {
        responseId: boundedText(value.source.responseId, 160),
        responseDigest: boundedText(value.source.responseDigest, 64).toLowerCase(),
        responseBodyDigest: boundedText(value.source.responseBodyDigest, 64).toLowerCase(),
        responseEvidenceDigest: boundedText(value.source.responseEvidenceDigest, 64).toLowerCase(),
        planDigest: boundedText(value.source.planDigest, 160) || null,
        proposalDigest: boundedText(value.source.proposalDigest, 64).toLowerCase(),
      }
    : null;
  if (!/^ca_[a-f0-9]{32}$/.test(artifactId)
    || !/^cav_[a-f0-9]{32}$/.test(versionId)
    || kind !== creatorArtifactKindForTaskFamily(taskFamily)
    || !title || !['model-draft', 'offline-draft'].includes(status)
    || !content || !diff || !createdAt || !source?.responseId
    || !validDigest(source.responseDigest)
    || !validDigest(source.responseBodyDigest)
    || !validDigest(source.proposalDigest)
    || (source.responseEvidenceDigest && !validDigest(source.responseEvidenceDigest))) return null;
  const normalized = {
    schema: CREATOR_ARTIFACT_VERSION_SCHEMA,
    artifactId,
    versionId,
    revision,
    taskFamily,
    kind,
    title,
    status,
    content,
    source,
    diff,
    createdAt,
  };
  const versionDigest = boundedText(value.versionDigest, 64).toLowerCase();
  if (!validDigest(versionDigest)
    || versionDigest !== digest(versionDigestPayload(normalized))) return null;
  normalized.versionDigest = versionDigest;
  return normalized;
}

function normalizeCreatorArtifactVersions(value) {
  return (Array.isArray(value) ? value : [])
    .slice(-CREATOR_ARTIFACT_MAX_VERSIONS)
    .map(normalizeCreatorArtifactVersion)
    .filter(Boolean);
}

function latestCreatorArtifactVersions(value) {
  const latest = new Map();
  for (const version of normalizeCreatorArtifactVersions(value)) {
    const current = latest.get(version.artifactId);
    if (!current || version.revision > current.revision) latest.set(version.artifactId, version);
  }
  return [...latest.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function failedCompilation(code, message, proposalDigest = '') {
  return {
    schema: CREATOR_ARTIFACT_COMPILATION_SCHEMA,
    status: 'failed',
    code,
    message,
    ...(validDigest(proposalDigest) ? { proposalDigest } : {}),
    artifactVersion: null,
  };
}

function compileCreatorArtifactVersion(input = {}) {
  const proposal = normalizeCreatorArtifactProposal(input.proposal);
  if (!proposal) {
    return failedCompilation(
      'artifact-proposal-invalid',
      '本轮正文已保留，但可编辑产物结构校验失败，未写入产物版本',
      boundedText(input.proposal?.proposalDigest, 64).toLowerCase(),
    );
  }
  const responseText = boundedBody(input.responseText);
  const responseId = boundedText(input.responseId, 160);
  const responseDigest = boundedText(input.responseDigest, 64).toLowerCase();
  const responseEvidenceDigest = boundedText(
    input.responseEvidence?.evidenceDigest || input.responseEvidenceDigest,
    64,
  ).toLowerCase();
  if (!responseId || !validDigest(responseDigest)
    || responseText !== proposal.content.bodyMarkdown
    || proposal.source.responseBodyDigest !== digest({
      schema: 't8-creator-response-body-v1',
      text: responseText,
    })
    || (proposal.source.responseEvidenceDigest
      && proposal.source.responseEvidenceDigest !== responseEvidenceDigest)) {
    return failedCompilation(
      'artifact-response-binding-invalid',
      '本轮正文已保留，但产物与回复证据不一致，未写入产物版本',
      proposal.proposalDigest,
    );
  }
  const sessionId = boundedText(input.sessionId, 160);
  const artifactId = `ca_${digest({
    schema: 't8-creator-artifact-id-v1',
    sessionId,
    taskFamily: proposal.taskFamily,
    kind: proposal.kind,
  }).slice(0, 32)}`;
  const versions = normalizeCreatorArtifactVersions(input.existingVersions);
  const previous = versions
    .filter((version) => version.artifactId === artifactId)
    .sort((left, right) => right.revision - left.revision)[0] || null;
  if (previous?.content.contentDigest === proposal.content.contentDigest
    && previous.title === proposal.title) {
    return {
      schema: CREATOR_ARTIFACT_COMPILATION_SCHEMA,
      status: 'reused',
      code: 'artifact-content-unchanged',
      message: `内容未变化，继续使用 ${proposal.title} v${previous.revision}`,
      proposalDigest: proposal.proposalDigest,
      artifactVersion: previous,
    };
  }
  const revision = (previous?.revision || 0) + 1;
  const createdAt = boundedText(input.createdAt, 80) || new Date().toISOString();
  const source = {
    responseId,
    responseDigest,
    responseBodyDigest: proposal.source.responseBodyDigest,
    responseEvidenceDigest,
    planDigest: boundedText(input.planDigest, 160) || null,
    proposalDigest: proposal.proposalDigest,
  };
  const versionSeed = {
    artifactId,
    revision,
    taskFamily: proposal.taskFamily,
    kind: proposal.kind,
    title: proposal.title,
    contentDigest: proposal.content.contentDigest,
    source,
  };
  const versionId = `cav_${digest({
    schema: CREATOR_ARTIFACT_VERSION_SCHEMA,
    ...versionSeed,
  }).slice(0, 32)}`;
  const partial = {
    schema: CREATOR_ARTIFACT_VERSION_SCHEMA,
    artifactId,
    versionId,
    revision,
    taskFamily: proposal.taskFamily,
    kind: proposal.kind,
    title: proposal.title,
    status: proposal.mode === 'online-model' ? 'model-draft' : 'offline-draft',
    content: proposal.content,
    source,
    createdAt,
  };
  partial.diff = diffForVersions(previous, partial);
  partial.versionDigest = digest(versionDigestPayload(partial));
  return {
    schema: CREATOR_ARTIFACT_COMPILATION_SCHEMA,
    status: 'created',
    code: 'artifact-version-created',
    message: `已形成可编辑${proposal.title} v${revision}`,
    proposalDigest: proposal.proposalDigest,
    artifactVersion: partial,
  };
}

function creatorArtifactSummaries(value) {
  return latestCreatorArtifactVersions(value).map((version) => ({
    artifactId: version.artifactId,
    versionId: version.versionId,
    revision: version.revision,
    taskFamily: version.taskFamily,
    kind: version.kind,
    title: version.title,
    status: version.status,
    contentDigest: version.content.contentDigest,
    updatedAt: version.createdAt,
  }));
}

module.exports = {
  CREATOR_ARTIFACT_COMPILATION_SCHEMA,
  CREATOR_ARTIFACT_CONTENT_SCHEMA,
  CREATOR_ARTIFACT_DIFF_SCHEMA,
  CREATOR_ARTIFACT_MAX_VERSIONS,
  CREATOR_ARTIFACT_PROPOSAL_SCHEMA,
  CREATOR_ARTIFACT_VERSION_SCHEMA,
  compileCreatorArtifactVersion,
  createCreatorArtifactProposal,
  creatorArtifactKindForTaskFamily,
  creatorArtifactSummaries,
  creatorArtifactTitleForTaskFamily,
  latestCreatorArtifactVersions,
  normalizeCreatorArtifactProposal,
  normalizeCreatorArtifactVersion,
  normalizeCreatorArtifactVersions,
  parseMarkdownSections,
};
