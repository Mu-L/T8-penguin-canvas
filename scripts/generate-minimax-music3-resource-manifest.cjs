const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const bundleRoot = path.join(projectRoot, 'public', 'official-skills', 'minimax-music3');
const skillRoot = path.join(bundleRoot, 'music-caption-rewriter');
const sourcePath = path.join(bundleRoot, 'SOURCE.json');
const manifestPath = path.join(bundleRoot, 'resource-manifest.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function collectFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectFiles(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const files = collectFiles(skillRoot)
  .map((absolute) => {
    const relativePath = path.relative(skillRoot, absolute).split(path.sep).join('/');
    const normalized = Buffer.from(fs.readFileSync(absolute).toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    return { path: relativePath, sha256: sha256(normalized), bytes: normalized.length };
  })
  .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const treeRecords = files.map((file) => `${file.path}\0${file.sha256}`).join('\n');
const normalizedTreeSha256 = sha256(treeRecords);
const coreSkill = files.find((file) => file.path === 'SKILL.md');
const familyIndexCount = files.filter((file) => /^references\/index-[^/]+\.md$/.test(file.path)).length;
const templateCount = files.filter((file) => /^templates\/[^/]+\.txt$/.test(file.path)).length;

const mismatches = [];
if (files.length !== source.file_count) mismatches.push(`file_count expected ${source.file_count}, got ${files.length}`);
if (familyIndexCount !== source.family_index_count) mismatches.push(`family_index_count expected ${source.family_index_count}, got ${familyIndexCount}`);
if (templateCount !== source.template_count) mismatches.push(`template_count expected ${source.template_count}, got ${templateCount}`);
if (normalizedTreeSha256 !== source.normalized_tree_sha256) mismatches.push(`normalized_tree_sha256 expected ${source.normalized_tree_sha256}, got ${normalizedTreeSha256}`);
if (coreSkill?.sha256 !== source.core_skill_sha256) mismatches.push(`core_skill_sha256 expected ${source.core_skill_sha256}, got ${coreSkill?.sha256 || 'missing'}`);
if (mismatches.length) throw new Error(`MiniMax Music 3 official resource integrity failed:\n${mismatches.join('\n')}`);

const manifest = {
  schema: 't8-minimax-music3-resource-manifest-v1',
  source: {
    authority: source.authority,
    repository: source.repository,
    commit: source.commit,
    normalizedTreeSha256,
    coreSkillSha256: coreSkill.sha256,
  },
  counts: { files: files.length, familyIndexes: familyIndexCount, templates: templateCount },
  files,
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n')
    : '';
  if (current !== serialized) {
    throw new Error('MiniMax Music 3 resource manifest is stale. Run node scripts/generate-minimax-music3-resource-manifest.cjs.');
  }
  process.stdout.write(`[music3-resources] verified ${files.length} files, tree ${normalizedTreeSha256}\n`);
} else {
  fs.writeFileSync(manifestPath, serialized);
  process.stdout.write(`[music3-resources] wrote ${path.relative(projectRoot, manifestPath)} (${files.length} files)\n`);
}
