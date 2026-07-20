'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require('node:worker_threads');
const {
  stableJson,
} = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');

const filename = isMainThread ? process.argv[2] : workerData.filename;
if (!filename) throw new Error('descriptor JSON path is required');
const targets = new Set(isMainThread ? process.argv.slice(3) : workerData.targets);
const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
const fixedExtraComponents = new Set(String(process.env.T8_FIXED_EXTRA_COMPONENTS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean));
const fixedExtraLabel = String(process.env.T8_FIXED_EXTRA_LABEL || '');
for (const [index, extraFilename] of String(process.env.T8_EXTRA_SCHEMA_DESCRIPTORS || '')
  .split(path.delimiter)
  .filter(Boolean)
  .entries()) {
  const extra = JSON.parse(fs.readFileSync(extraFilename, 'utf8'));
  const descriptor = extra.schema31Descriptor || extra.descriptor;
  if (!descriptor) throw new Error(`schema31 descriptor missing from ${extraFilename}`);
  payload.descriptors.push({
    label: `source-reconstruction-${index + 1}`,
    descriptor,
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const byFingerprint = new Map();
for (const entry of payload.descriptors) {
  const serialized = stableJson(entry.descriptor);
  const fingerprint = sha256(serialized);
  const current = byFingerprint.get(fingerprint);
  if (current) current.labels.push(entry.label);
  else byFingerprint.set(fingerprint, {
    fingerprint,
    labels: [entry.label],
    descriptor: entry.descriptor,
  });
}
const unique = [...byFingerprint.values()];
const base = unique[0].descriptor;

function variantsFor(kind, name) {
  const variants = new Map();
  for (const entry of unique) {
    const component = entry.descriptor[kind].find((candidate) => candidate.name === name);
    if (!component) throw new Error(`${kind}:${name} missing from ${entry.fingerprint}`);
    const serialized = stableJson(component);
    const variant = variants.get(serialized);
    if (variant) variant.labels.push(...entry.labels);
    else variants.set(serialized, { serialized, labels: [...entry.labels] });
  }
  const values = [...variants.values()];
  if (!fixedExtraComponents.has(`${kind}:${name}`)) return values;
  const fixed = values.filter((variant) => variant.labels.some(
    (label) => fixedExtraLabel
      ? String(label) === fixedExtraLabel
      : String(label).startsWith('source-reconstruction-'),
  ));
  if (fixed.length !== 1) {
    throw new Error(`expected one source reconstruction variant for ${kind}:${name}, got ${fixed.length}`);
  }
  return fixed;
}

const tokens = [];
function constant(value) {
  const previous = tokens.at(-1);
  if (previous?.constant != null) previous.constant += value;
  else tokens.push({ constant: value });
}
function arrayTokens(kind) {
  for (const [index, component] of base[kind].entries()) {
    if (index > 0) constant(',');
    const variants = variantsFor(kind, component.name);
    if (variants.length === 1) constant(variants[0].serialized);
    else tokens.push({ key: `${kind}:${component.name}`, variants });
  }
}

constant(`{"counts":${stableJson(base.counts)},"tables":[`);
arrayTokens('tables');
constant('],"triggers":[');
arrayTokens('triggers');
constant(`],"version":${stableJson(base.version)},"views":[`);
arrayTokens('views');
constant(']}');

const varying = tokens.filter((token) => token.variants);
const combinationCount = varying.reduce(
  (total, token) => total * BigInt(token.variants.length),
  1n,
);
if (isMainThread) {
  process.stdout.write(`${JSON.stringify({
    uniqueDescriptors: unique.map((entry) => ({
      fingerprint: entry.fingerprint,
      labels: entry.labels,
    })),
    varyingComponents: varying.map((token) => ({
      key: token.key,
      variantCount: token.variants.length,
      variants: token.variants.map((variant) => ({ labels: [...new Set(variant.labels)].sort() })),
    })),
    combinationCount: combinationCount.toString(),
  }, null, 2)}\n`);
}

if (isMainThread && targets.size === 0) process.exit(0);
const maximumCombinations = BigInt(process.env.T8_MAX_SCHEMA_COMBINATIONS || '10000000');
if (combinationCount > maximumCombinations) {
  throw new Error(`refusing exhaustive search of ${combinationCount} combinations`);
}

let variableIndex = 0;
for (const token of tokens) {
  if (token.variants) token.variableIndex = variableIndex++;
}

function search(prefixes) {
  const matches = [];
  let checked = 0;

  function visit(index, hash, choices, prefix) {
  if (index >= tokens.length) {
    checked += 1;
    const fingerprint = hash.digest('hex');
    if (targets.has(fingerprint)) matches.push({ fingerprint, choices: { ...choices } });
    return;
  }
  const token = tokens[index];
  if (token.constant != null) {
    hash.update(token.constant);
    visit(index + 1, hash, choices, prefix);
    return;
  }
  const restrictedIndex = prefix[token.variableIndex];
  const variants = restrictedIndex == null
    ? token.variants.entries()
    : [[restrictedIndex, token.variants[restrictedIndex]]];
  for (const [variantIndex, variant] of variants) {
    const branch = hash.copy();
    branch.update(variant.serialized);
    choices[token.key] = {
      variantIndex,
      labels: [...new Set(variant.labels)].sort(),
    };
    visit(index + 1, branch, choices, prefix);
  }
  delete choices[token.key];
  }

  for (const prefix of prefixes) {
    visit(0, crypto.createHash('sha256'), {}, prefix);
  }
  return { checked, matches };
}

if (!isMainThread) {
  parentPort.postMessage(search(workerData.prefixes));
} else {
  const workerCount = Math.min(12, os.availableParallelism());
  let splitDepth = 0;
  let prefixCount = 1;
  while (splitDepth < varying.length && prefixCount < workerCount * 8) {
    prefixCount *= varying[splitDepth].variants.length;
    splitDepth += 1;
  }
  const prefixes = [];
  function enumeratePrefix(index, prefix) {
    if (index >= splitDepth) {
      prefixes.push([...prefix]);
      return;
    }
    for (let choice = 0; choice < varying[index].variants.length; choice += 1) {
      prefix.push(choice);
      enumeratePrefix(index + 1, prefix);
      prefix.pop();
    }
  }
  enumeratePrefix(0, []);
  const shards = Array.from({ length: Math.min(workerCount, prefixes.length) }, () => []);
  prefixes.forEach((prefix, index) => shards[index % shards.length].push(prefix));
  const jobs = shards.map((workerPrefixes) => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: {
        filename,
        targets: [...targets],
        prefixes: workerPrefixes,
      },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`descriptor worker exited with code ${code}`));
    });
  }));
  Promise.all(jobs).then((results) => {
    const output = {
      checked: results.reduce((total, result) => total + result.checked, 0),
      matches: results.flatMap((result) => result.matches),
      workers: shards.length,
      splitDepth,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
