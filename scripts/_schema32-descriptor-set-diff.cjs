'use strict';

const fs = require('node:fs');
const { stableJson } = require('../tests/helpers/projectDatabaseSchemaManifest.cjs');

function readDescriptor(filename) {
  const payload = JSON.parse(fs.readFileSync(filename, 'utf8'));
  return payload.schema31Descriptor || payload.descriptor;
}

const left = readDescriptor(process.argv[2]);
const right = readDescriptor(process.argv[3]);
for (const kind of ['tables', 'triggers', 'views']) {
  const leftByName = new Map(left[kind].map((component) => [component.name, component]));
  const rightByName = new Map(right[kind].map((component) => [component.name, component]));
  for (const name of [...new Set([...leftByName.keys(), ...rightByName.keys()])].sort()) {
    const leftComponent = leftByName.get(name);
    const rightComponent = rightByName.get(name);
    if (stableJson(leftComponent) === stableJson(rightComponent)) continue;
    process.stdout.write(`${JSON.stringify({
      key: `${kind}:${name}`,
      leftColumns: leftComponent?.columns?.map((column) => column.name),
      rightColumns: rightComponent?.columns?.map((column) => column.name),
    })}\n`);
  }
}
