'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const COMMAND_CATALOG_PATH = path.join(ROOT, 'commandCatalog.json');
const CREATIVE_CAPABILITY_MANIFEST_PATH = path.join(ROOT, 'creativeCapabilityManifest.json');
const CREATIVE_CAPABILITY_GRAPH_PATH = path.join(ROOT, 'generated', 'creative-capability-graph.json');
const CREATIVE_CAPABILITY_SURFACES_PATH = path.join(ROOT, 'generated', 'creative-capability-surfaces.json');

const RESPONSE_SCHEMA = 't8-agent-control-response-v1';
const CONTROL_PROTOCOL = 't8-agent-control-v1';

const EXIT_CODES = Object.freeze({
  OK: 0,
  USAGE_ERROR: 2,
  APP_NOT_RUNNING: 3,
  AUTH_ERROR: 4,
  VERSION_INCOMPATIBLE: 5,
  CONFLICT: 6,
  CONFIRMATION_REQUIRED: 7,
  CAPABILITY_UNAVAILABLE: 8,
  INTERNAL_ERROR: 9,
});

module.exports = {
  CONTROL_PROTOCOL,
  COMMAND_CATALOG_PATH,
  CREATIVE_CAPABILITY_GRAPH_PATH,
  CREATIVE_CAPABILITY_SURFACES_PATH,
  CREATIVE_CAPABILITY_MANIFEST_PATH,
  EXIT_CODES,
  MANIFEST_PATH,
  RESPONSE_SCHEMA,
  ROOT,
};
