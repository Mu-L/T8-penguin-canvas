'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { stableJson } = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');

const matrix = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const extra = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const descriptors = matrix.descriptors.map((entry) => ({
  label: entry.label,
  descriptor: entry.descriptor,
}));
descriptors.push({
  label: path.basename(process.argv[3]),
  descriptor: extra.schema31Descriptor || extra.descriptor,
});

const [kind, name] = String(process.argv[4] || '').split(':');
if (!kind || !name) throw new Error('component kind:name is required');
const variants = new Map();
for (const entry of descriptors) {
  const component = entry.descriptor[kind].find((candidate) => candidate.name === name);
  const serialized = stableJson(component);
  if (!variants.has(serialized)) variants.set(serialized, { labels: [], component });
  variants.get(serialized).labels.push(entry.label);
}
let index = 0;
for (const variant of variants.values()) {
  index += 1;
  process.stdout.write(`${JSON.stringify({
    variant: index,
    labels: variant.labels,
    columns: variant.component.columns?.map((column) => column.name),
    definition: variant.component.definition,
    triggerDefinition: kind === 'triggers' ? variant.component.definition : undefined,
  }, null, 2)}\n`);
}
