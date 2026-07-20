'use strict';

// Test-side source transformer used only to collect schema descriptors from
// the existing deterministic TEMP migration matrix. The production source and
// the frozen matrix test remain unchanged.

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const filename = path.join(root, 'tests', 'projectDatabaseSchemaManifestB2.test.cjs');
let source = fs.readFileSync(filename, 'utf8');

source = source.replace(
  '  const schema32Mappings = new Map();\n  const schema32ExtensionFingerprints = new Set();',
  '  const schema32Mappings = new Map();\n'
    + '  const schema32ExtensionFingerprints = new Set();\n'
    + '  const schema31Descriptors = new Map();\n'
    + '  const schema32Descriptors = new Map();',
);
source = source.replace(
  '        const previous = schema32Mappings.get(sourceManifest.fingerprint);',
  '        schema32Descriptors.set(entry.label, targetManifest.descriptor);\n'
    + '        const previous = schema32Mappings.get(sourceManifest.fingerprint);',
);
source = source.replace(
  '        const receipt = rawSchema31.prepare(`\n'
    + '          SELECT to_fingerprint FROM schema_migration_receipts WHERE version = 31\n'
    + '        `).get();',
  '        schema31Descriptors.set(entry.label, sourceManifest.descriptor);\n'
    + '        const receipt = rawSchema31.prepare(`\n'
    + '          SELECT to_fingerprint FROM schema_migration_receipts WHERE version = 31\n'
    + '        `).get();',
);
source = source.replace(
  `  assert.fail(JSON.stringify({
    mappings: [...schema32Mappings.entries()]
      .map(([fromFingerprint, toFingerprint]) => ({ fromFingerprint, toFingerprint }))
      .sort((left, right) => left.fromFingerprint.localeCompare(right.fromFingerprint)),
    extensionFingerprints: [...schema32ExtensionFingerprints].sort(),
  }));`,
  `  fs.writeFileSync(process.env.T8_SCHEMA_DESCRIPTOR_OUTPUT, JSON.stringify({
    descriptors: [...schema31Descriptors.entries()].map(([label, descriptor]) => ({ label, descriptor })),
    targetDescriptors: [...schema32Descriptors.entries()].map(([label, descriptor]) => ({ label, descriptor })),
    mappings: [...schema32Mappings.entries()]
      .map(([fromFingerprint, toFingerprint]) => ({ fromFingerprint, toFingerprint }))
      .sort((left, right) => left.fromFingerprint.localeCompare(right.fromFingerprint)),
    extensionFingerprints: [...schema32ExtensionFingerprints].sort(),
  }));`,
);

if (!source.includes('schema31Descriptors.set(entry.label, sourceManifest.descriptor)')) {
  throw new Error('descriptor capture insertion failed');
}
if (!source.includes('schema32Descriptors.set(entry.label, targetManifest.descriptor)')) {
  throw new Error('target descriptor capture insertion failed');
}
if (source.includes('assert.fail(JSON.stringify({\n    mappings: [...schema32Mappings.entries()]')) {
  throw new Error('matrix terminal assertion replacement failed');
}

const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(source, filename);
