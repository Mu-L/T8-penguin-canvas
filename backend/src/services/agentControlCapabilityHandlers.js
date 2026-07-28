'use strict';

const creativeModule = require('./agentControlCreative');
const runModule = require('./agentControlRuns');
const assetModule = require('./agentControlAssets');
const deliveryModule = require('./agentControlDelivery');
const browserModule = require('./agentControlBrowser');

let contracts = null;

function assertServiceFactory(factory, expectedMembers, label) {
  if (typeof factory !== 'function') {
    throw new Error(`Creative capability implementation is unavailable: ${label}`);
  }
  const service = factory({});
  for (const member of expectedMembers) {
    if (typeof service?.[member] !== 'function') {
      throw new Error(`Creative capability implementation is unavailable: ${label}.${member}`);
    }
  }
  return service;
}

function runtimeContracts() {
  if (contracts) return contracts;
  assertServiceFactory(
    creativeModule.createAgentControlCreativeService,
    ['createPlan', 'actionPlan', 'readAction'],
    'agentControlCreative',
  );
  assertServiceFactory(
    runModule.createAgentControlRunService,
    ['startPreview'],
    'agentControlRuns',
  );
  assertServiceFactory(
    assetModule.createAgentControlAssetService,
    ['inspectImport', 'inspectPlace'],
    'agentControlAssets',
  );
  assertServiceFactory(
    deliveryModule.createAgentControlDeliveryService,
    ['inspectPackage'],
    'agentControlDelivery',
  );
  if (typeof browserModule.createBrowserHandoff !== 'function'
    || !(browserModule.HANDOFF_ACTIONS instanceof Set)
    || !browserModule.HANDOFF_ACTIONS.has('open')) {
    throw new Error('Creative capability implementation is unavailable: agentControlBrowser.open');
  }
  contracts = Object.freeze({
    planKinds: new Set(creativeModule.CREATIVE_PLAN_KINDS),
    creativeActions: new Set(creativeModule.CREATIVE_ACTIONS),
    creativeReadActions: new Set(creativeModule.CREATIVE_READ_ACTIONS),
  });
  return contracts;
}

function binding(handler, service, method, operation) {
  return Object.freeze({
    handler,
    service,
    method,
    operation,
  });
}

function resolveCreativeCapabilityHandler(handlerValue) {
  const handler = String(handlerValue || '').trim();
  const available = runtimeContracts();
  if (handler.startsWith('creative-plan:')) {
    const operation = handler.slice('creative-plan:'.length);
    const kind = operation.startsWith('create.') ? operation.slice('create.'.length) : '';
    if (kind && kind !== 'plan-card' && available.planKinds.has(kind)) {
      return binding(handler, 'agentControlCreative', 'createPlan', kind);
    }
    return null;
  }
  if (handler.startsWith('creative-action:')) {
    const operation = handler.slice('creative-action:'.length);
    if (available.creativeActions.has(operation)) {
      return binding(handler, 'agentControlCreative', 'actionPlan', operation);
    }
    return null;
  }
  if (handler.startsWith('creative-read:')) {
    const operation = handler.slice('creative-read:'.length);
    const action = operation.startsWith('iterate.') ? operation.slice('iterate.'.length) : operation;
    if (available.creativeReadActions.has(action)) {
      return binding(handler, 'agentControlCreative', 'readAction', action);
    }
    return null;
  }
  if (handler === 'run:start') {
    return binding(handler, 'agentControlRuns', 'startPreview', 'start');
  }
  if (handler === 'asset:place') {
    return binding(handler, 'agentControlAssets', 'inspectPlace', 'place');
  }
  if (handler === 'asset:import') {
    return binding(handler, 'agentControlAssets', 'inspectImport', 'import');
  }
  if (handler === 'delivery:package') {
    return binding(handler, 'agentControlDelivery', 'inspectPackage', 'package');
  }
  if (handler === 'browser:open') {
    return binding(handler, 'agentControlBrowser', 'createBrowserHandoff', 'open');
  }
  return null;
}

function validateCreativeCapabilityHandlers(manifest) {
  const seenHandlers = new Set();
  for (const capability of manifest?.capabilities || []) {
    const id = String(capability?.id || '(empty)');
    const handler = String(capability?.handler || '').trim();
    if (seenHandlers.has(handler)) {
      throw new Error(`Creative capability ${id} duplicates handler binding: ${handler || '(empty)'}`);
    }
    seenHandlers.add(handler);
    if (!resolveCreativeCapabilityHandler(handler)) {
      throw new Error(`Creative capability ${id} uses an unbound handler: ${handler || '(empty)'}`);
    }
  }
  return manifest;
}

function publicCreativeCapabilityBindings(manifest) {
  return (manifest?.capabilities || []).map((capability) => {
    const resolved = resolveCreativeCapabilityHandler(capability.handler);
    if (!resolved) {
      throw new Error(`Creative capability ${capability?.id || '(empty)'} uses an unbound handler`);
    }
    return {
      capabilityId: String(capability.id),
      handler: resolved.handler,
      service: resolved.service,
      method: resolved.method,
      operation: resolved.operation,
    };
  });
}

module.exports = {
  publicCreativeCapabilityBindings,
  resolveCreativeCapabilityHandler,
  validateCreativeCapabilityHandlers,
};
