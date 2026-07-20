const {
  CANVAS_SCHEMA,
  CANVAS_SCHEMA_VERSION,
  isUuid,
  stableEntityUuid,
} = require('../collaboration/protocol');

const MIGRATION_CONTRACT = 't8-project-identity-migration-v1';

class IdentityMigrationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'IdentityMigrationError';
    this.code = code;
    this.details = details;
  }
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new IdentityMigrationError('identity_json_invalid', '旧画布必须是可往返的 JSON 数据', {
      reason: error?.message || String(error),
    });
  }
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityMigrationError('identity_object_invalid', `${label} 必须是对象`);
  }
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = text(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function positiveInteger(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stableProjectEntityUuid(...parts) {
  return stableEntityUuid(...parts);
}

class IdentityRegistry {
  constructor(namespaceParts, kind, label = kind) {
    this.namespaceParts = namespaceParts;
    this.kind = kind;
    this.label = label;
    this.byUid = new Map();
    this.byAlias = new Map();
  }

  register(rawRecord, index, options = {}) {
    const source = asObject(rawRecord, `${this.label}[${index}]`);
    const identityKeys = options.identityKeys || ['id'];
    const outputKey = options.outputKey || identityKeys[0] || 'id';
    const firstIdentity = identityKeys.map((key) => text(source[key])).find(Boolean);
    const primaryAlias = firstIdentity || `${options.fallbackPrefix || this.kind}-${index + 1}`;
    const suppliedUid = text(source.entityUid);
    const uid = isUuid(suppliedUid)
      ? suppliedUid.toLowerCase()
      : (isUuid(primaryAlias)
        ? primaryAlias.toLowerCase()
        : stableProjectEntityUuid(...this.namespaceParts, this.kind, primaryAlias));

    const aliases = uniqueStrings([
      ...asArray(source.legacyAliases),
      !isUuid(suppliedUid) ? suppliedUid : '',
      primaryAlias,
    ]);

    const existingUidOwner = this.byUid.get(uid);
    if (existingUidOwner) {
      throw new IdentityMigrationError(
        'identity_uuid_collision',
        `${this.label} 的稳定 UUID 发生冲突`,
        { uid, first: existingUidOwner.primaryAlias, second: primaryAlias },
      );
    }
    const existingUidAliasOwner = this.byAlias.get(uid);
    if (existingUidAliasOwner && existingUidAliasOwner !== uid) {
      throw new IdentityMigrationError(
        'identity_uuid_collision',
        `${this.label} 的稳定 UUID 与其他旧身份别名冲突`,
        { uid, first: existingUidAliasOwner, second: primaryAlias },
      );
    }

    for (const alias of aliases) {
      const existingAliasOwner = this.byAlias.get(alias);
      if (existingAliasOwner) {
        throw new IdentityMigrationError(
          'identity_alias_collision',
          `${this.label} 的旧身份别名发生冲突`,
          { alias, first: existingAliasOwner, second: uid },
        );
      }
      const uidOwner = this.byUid.get(alias.toLowerCase());
      if (isUuid(alias) && uidOwner) {
        throw new IdentityMigrationError(
          'identity_alias_collision',
          `${this.label} 的旧身份别名与其他稳定 UUID 冲突`,
          { alias, first: uidOwner.primaryAlias, second: uid },
        );
      }
    }

    this.byUid.set(uid, { primaryAlias, index });
    for (const alias of aliases) this.byAlias.set(alias, uid);
    this.byAlias.set(uid, uid);

    const outputAliases = uniqueStrings([
      ...asArray(source.legacyAliases),
      !isUuid(suppliedUid) ? suppliedUid : '',
      !isUuid(primaryAlias) || primaryAlias.toLowerCase() !== uid ? primaryAlias : '',
    ]);
    return {
      ...source,
      [outputKey]: primaryAlias,
      entityUid: uid,
      legacyAliases: outputAliases,
    };
  }

  resolve(value) {
    const candidate = text(value);
    if (!candidate) return null;
    if (isUuid(candidate) && this.byUid.has(candidate.toLowerCase())) return candidate.toLowerCase();
    return this.byAlias.get(candidate) || null;
  }

  reserve(aliasValue, suppliedUid = null, legacyAliases = []) {
    const alias = text(aliasValue);
    if (!alias) return null;
    const resolved = this.resolve(alias);
    if (resolved) {
      if (isUuid(suppliedUid) && text(suppliedUid).toLowerCase() !== resolved) {
        throw new IdentityMigrationError(
          'identity_uuid_collision',
          `${this.label} 的删除记录与现存稳定 UUID 冲突`,
          { alias, first: resolved, second: text(suppliedUid).toLowerCase() },
        );
      }
      throw new IdentityMigrationError(
        'identity_lifecycle_collision',
        `${this.label} 的活动实体与删除记录身份冲突`,
        { alias, entityUid: resolved },
      );
    }
    return this.register({ id: alias, entityUid: suppliedUid, legacyAliases }, this.byUid.size, {
      fallbackPrefix: this.kind,
    }).entityUid;
  }
}

class VerifiedReferenceRegistry {
  constructor(baseRegistry, label) {
    this.baseRegistry = baseRegistry;
    this.label = label;
    this.byAlias = new Map();
    this.aliasByUid = new Map();
  }

  register(aliasValue, uidValue, label) {
    const alias = text(aliasValue);
    if (!alias || !isUuid(uidValue)) {
      throw new IdentityMigrationError(
        'identity_uuid_invalid',
        `${label} 的稳定身份不是 RFC4122 UUID`,
        { reference: uidValue },
      );
    }
    const uid = text(uidValue).toLowerCase();
    const baseResolved = this.baseRegistry.resolve(alias);
    if (baseResolved && baseResolved !== uid) {
      throw new IdentityMigrationError(
        'identity_reference_collision',
        `${label} 与项目定义注册表冲突`,
        { reference: alias, expected: baseResolved, actual: uid },
      );
    }
    const existingAliasOwner = this.byAlias.get(alias);
    if (existingAliasOwner && existingAliasOwner !== uid) {
      throw new IdentityMigrationError(
        'identity_reference_collision',
        `${label} 存在多个稳定身份候选`,
        { reference: alias, first: existingAliasOwner, second: uid },
      );
    }
    const existingUidAlias = this.aliasByUid.get(uid);
    if (existingUidAlias && existingUidAlias !== alias) {
      throw new IdentityMigrationError(
        'identity_alias_collision',
        `${label} 的稳定身份绑定了多个旧定义身份`,
        { uid, first: existingUidAlias, second: alias },
      );
    }
    this.byAlias.set(alias, uid);
    this.byAlias.set(uid, uid);
    this.aliasByUid.set(uid, alias);
    return uid;
  }

  resolve(value) {
    return this.baseRegistry.resolve(value) || this.byAlias.get(text(value)) || null;
  }
}

function embeddedDefinitionIsComplete(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && text(value.id)
    && isUuid(value.entityUid)
    && Number.isSafeInteger(Number(value.version))
    && Number(value.version) >= 1
    && Array.isArray(value.nodes)
    && Array.isArray(value.edges)
    && Array.isArray(value.inputs)
    && Array.isArray(value.outputs)
    && Array.isArray(value.exposedParameters));
}

function registerEmbeddedDefinitionEvidence(registry, target, projectId, label) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  const definition = target.definition;
  if (!embeddedDefinitionIsComplete(definition)) return;
  const definitionId = text(target.definitionId);
  const definitionEntityUid = text(target.definitionEntityUid);
  if (!definitionId || !definitionEntityUid) return;
  const embeddedId = text(definition.id);
  const embeddedUid = text(definition.entityUid).toLowerCase();
  const embeddedProjectId = text(definition.projectId);
  const targetProjectId = text(target.definitionProjectId);
  const targetVersion = target.definitionVersion == null ? null : Number(target.definitionVersion);
  const targetRevision = target.definitionRevision == null ? null : Number(target.definitionRevision);
  const embeddedRevision = definition.revision == null ? null : Number(definition.revision);
  if (embeddedProjectId !== projectId
    || (targetProjectId && targetProjectId !== projectId)
    || definitionId !== embeddedId
    || !isUuid(definitionEntityUid)
    || definitionEntityUid.toLowerCase() !== embeddedUid
    || (targetVersion != null && targetVersion !== Number(definition.version))
    || (targetRevision != null && targetRevision !== embeddedRevision)) {
    throw new IdentityMigrationError(
      'identity_reference_collision',
      `${label} 的内嵌子工作流定义证据冲突`,
      {
        reference: definitionId,
        suppliedEntityUid: definitionEntityUid,
        embeddedId,
        embeddedEntityUid: embeddedUid,
      },
    );
  }
  registry.register(definitionId, embeddedUid, label);
}

function collectEmbeddedDefinitionEvidence(source, registry, projectId) {
  const targets = [];
  const addNode = (node) => {
    targets.push(node);
    if (node?.data && typeof node.data === 'object' && !Array.isArray(node.data)) {
      targets.push(node.data);
    }
  };
  asArray(source.nodes).forEach(addNode);
  asArray(source.subflowInstances).forEach((instance) => targets.push(instance));
  asArray(source.subflowDefinitions).forEach((definition) => {
    asArray(definition?.nodes).forEach(addNode);
  });
  asArray(source.runs).forEach((run) => {
    targets.push(run);
    asArray(run?.nodeRuns).forEach((nodeRun) => targets.push(nodeRun));
    asArray(run?.events).forEach((event) => {
      targets.push(event);
      if (event?.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
        targets.push(event.payload);
      }
    });
  });
  targets.forEach((target, index) => registerEmbeddedDefinitionEvidence(
    registry,
    target,
    projectId,
    `embeddedDefinitionReferences[${index}]`,
  ));
}

function prepareCollection(input, registry, options = {}) {
  return asArray(input).map((record, index) => registry.register(record, index, options));
}

function requireReference(registry, value, label) {
  const resolved = registry.resolve(value);
  if (!resolved) {
    throw new IdentityMigrationError('identity_reference_missing', `${label} 指向不存在或含糊的旧身份`, {
      reference: value,
    });
  }
  return resolved;
}

const UNVERIFIED_REFERENCE_STATUS = 'legacy-unverified';

function legacyReferenceText(value) {
  return value == null ? '' : String(value);
}

function normalizeUnverifiedIdentityReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (text(value.status) !== UNVERIFIED_REFERENCE_STATUS) return null;
  const kind = text(value.kind);
  const field = text(value.field);
  const stableField = text(value.stableField);
  const legacyReference = legacyReferenceText(value.legacyReference);
  if (!kind || !field || !stableField || !legacyReference) return null;
  const index = value.index == null ? null : Number(value.index);
  if (index != null && (!Number.isSafeInteger(index) || index < 0)) return null;
  return {
    status: UNVERIFIED_REFERENCE_STATUS,
    kind,
    field,
    stableField,
    legacyReference,
    ...(index == null ? {} : { index }),
  };
}

function unverifiedIdentityReferenceKey(value) {
  return [
    value.stableField,
    value.field,
    value.index == null ? '' : String(value.index).padStart(12, '0'),
    value.legacyReference,
    value.kind,
  ].join('\u0000');
}

function normalizeUnverifiedIdentityReferences(value) {
  const byKey = new Map();
  for (const rawReference of asArray(value)) {
    const reference = normalizeUnverifiedIdentityReference(rawReference);
    if (!reference) continue;
    byKey.set(unverifiedIdentityReferenceKey(reference), reference);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, reference]) => reference);
}

function unverifiedReferenceBarrier(references, stableField, legacyReference) {
  return references.find((reference) => (
    reference.stableField === stableField
      && reference.legacyReference === legacyReference
  )) || null;
}

function migrateOptionalIdentityReferences(target, descriptors) {
  const source = { ...target };
  const existing = normalizeUnverifiedIdentityReferences(source.unverifiedIdentityReferences);
  const managedStableFields = new Set(descriptors.map((descriptor) => descriptor.stableField));
  const references = existing.filter((reference) => !managedStableFields.has(reference.stableField));

  for (const descriptor of descriptors) {
    const {
      field,
      stableField,
      kind,
      registry,
      multiple = false,
    } = descriptor;
    const managedExisting = existing.filter((reference) => reference.stableField === stableField);
    const hasDescriptorValue = Object.prototype.hasOwnProperty.call(descriptor, 'sourceValue');
    const hasSource = hasDescriptorValue || Object.prototype.hasOwnProperty.call(source, field);
    const sourceValue = hasDescriptorValue ? descriptor.sourceValue : source[field];
    const hasStable = Object.prototype.hasOwnProperty.call(source, stableField);
    const suppliedStable = source[stableField];

    if (multiple) {
      const values = Array.isArray(sourceValue)
        ? sourceValue
        : (!hasSource && Array.isArray(suppliedStable) ? suppliedStable : null);
      delete source[stableField];
      if (values == null) {
        references.push(...managedExisting);
        continue;
      }
      const resolvedValues = [];
      values.forEach((value, index) => {
        const legacyReference = legacyReferenceText(value);
        if (!text(value)) return;
        const barrier = unverifiedReferenceBarrier(managedExisting, stableField, legacyReference);
        const resolved = barrier ? null : registry?.resolve(value);
        if (resolved) {
          resolvedValues.push(resolved);
          return;
        }
        references.push({
          status: UNVERIFIED_REFERENCE_STATUS,
          kind,
          field,
          stableField,
          legacyReference,
          index,
        });
      });
      source[stableField] = resolvedValues;
      continue;
    }

    const candidate = hasSource && sourceValue != null
      ? sourceValue
      : (!hasSource && hasStable ? suppliedStable : null);
    delete source[stableField];
    if (!text(candidate)) {
      references.push(...managedExisting);
      continue;
    }
    const legacyReference = legacyReferenceText(candidate);
    const barrier = unverifiedReferenceBarrier(managedExisting, stableField, legacyReference);
    const resolved = barrier ? null : registry?.resolve(candidate);
    if (!resolved) {
      references.push({
        status: UNVERIFIED_REFERENCE_STATUS,
        kind,
        field,
        stableField,
        legacyReference,
      });
      continue;
    }
    if (hasStable && field !== stableField && suppliedStable != null) {
      if (!isUuid(suppliedStable)) {
        throw new IdentityMigrationError(
          'identity_uuid_invalid',
          `${stableField} 不是 RFC4122 UUID`,
          { reference: suppliedStable },
        );
      }
      const supplied = text(suppliedStable).toLowerCase();
      if (supplied !== resolved) {
        throw new IdentityMigrationError(
          'identity_reference_collision',
          `${stableField} 与 ${field} 指向的稳定身份冲突`,
          { reference: candidate, expected: resolved, actual: supplied },
        );
      }
    }
    source[stableField] = resolved;
  }

  const normalized = normalizeUnverifiedIdentityReferences(references);
  if (normalized.length > 0) source.unverifiedIdentityReferences = normalized;
  else delete source.unverifiedIdentityReferences;
  return source;
}

function normalizeViewport(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...source,
    x: finiteNumber(source.x, 0),
    y: finiteNumber(source.y, 0),
    zoom: Math.max(0.01, finiteNumber(source.zoom, 1)),
  };
}

function enrichAssetReferences(target, assetRegistry) {
  return migrateOptionalIdentityReferences(target, [
    { field: 'assetId', stableField: 'assetEntityUid', kind: 'asset', registry: assetRegistry },
    { field: 'sourceAssetId', stableField: 'sourceAssetEntityUid', kind: 'asset', registry: assetRegistry },
    { field: 'assetRefs', stableField: 'assetEntityUids', kind: 'asset', registry: assetRegistry, multiple: true },
    { field: 'outputRefs', stableField: 'outputAssetEntityUids', kind: 'asset', registry: assetRegistry, multiple: true },
  ]);
}

function enrichDefinitionReference(target, definitionRegistry) {
  return migrateOptionalIdentityReferences(target, [{
    field: 'definitionId',
    stableField: 'definitionEntityUid',
    kind: 'subflow-definition',
    registry: definitionRegistry,
  }]);
}

function enrichNode(node, assetRegistry, definitionRegistry, projectId) {
  const enriched = enrichDefinitionReference(
    enrichAssetReferences(node, assetRegistry),
    definitionRegistry,
  );
  if (node.data && typeof node.data === 'object' && !Array.isArray(node.data)) {
    enriched.data = enrichDefinitionReference(
      enrichAssetReferences(node.data, assetRegistry),
      definitionRegistry,
    );
  }
  return enriched;
}

function enrichEdge(edge, nodeRegistry, label) {
  const stableEndpoint = (key) => {
    const stableKey = `${key}EntityUid`;
    const resolved = requireReference(nodeRegistry, edge[key], `${label}.${key}`);
    if (edge[stableKey] != null) {
      if (!isUuid(edge[stableKey])) {
        throw new IdentityMigrationError(
          'identity_uuid_invalid',
          `${label}.${stableKey} 不是 RFC4122 UUID`,
          { reference: edge[stableKey] },
        );
      }
      const supplied = text(edge[stableKey]).toLowerCase();
      if (supplied !== resolved) {
        throw new IdentityMigrationError(
          'identity_reference_collision',
          `${label}.${stableKey} 与 ${key} 指向的稳定身份冲突`,
          { reference: edge[key], expected: resolved, actual: supplied },
        );
      }
    }
    return resolved;
  };
  const sourceUid = stableEndpoint('source');
  const targetUid = stableEndpoint('target');
  return {
    ...edge,
    source: text(edge.source),
    target: text(edge.target),
    sourceEntityUid: sourceUid,
    targetEntityUid: targetUid,
  };
}

function migrateAssets(preparedAssets, assetRegistry) {
  return preparedAssets.map((asset) => {
    let migrated = enrichAssetReferences(asset, assetRegistry);
    const parentIds = Array.isArray(asset.parentAssetIds)
      ? asset.parentAssetIds
      : (Array.isArray(asset.provenance?.parentAssetIds) ? asset.provenance.parentAssetIds : null);
    if (parentIds) {
      migrated = migrateOptionalIdentityReferences(migrated, [{
        field: Array.isArray(asset.parentAssetIds)
          ? 'parentAssetIds'
          : 'provenance.parentAssetIds',
        stableField: 'parentAssetEntityUids',
        kind: 'asset',
        registry: assetRegistry,
        multiple: true,
        sourceValue: parentIds,
      }]);
    }
    return migrated;
  });
}

function migrateSubflowDefinition(
  definition,
  definitionRegistry,
  assetRegistry,
  projectId,
) {
  const definitionUid = definition.entityUid;
  const nodeRegistry = new IdentityRegistry(
    [projectId, definitionUid],
    'node',
    `subflow ${definition.id || definitionUid} node`,
  );
  const edgeRegistry = new IdentityRegistry(
    [projectId, definitionUid],
    'edge',
    `subflow ${definition.id || definitionUid} edge`,
  );
  const nodes = prepareCollection(definition.nodes, nodeRegistry, { fallbackPrefix: 'node' })
    .map((node) => enrichNode(node, assetRegistry, definitionRegistry, projectId));
  const edges = prepareCollection(definition.edges, edgeRegistry, { fallbackPrefix: 'edge' })
    .map((edge, index) => enrichEdge(edge, nodeRegistry, `subflow.edges[${index}]`));

  const inputCount = asArray(definition.inputs).length;
  const rawPorts = [...asArray(definition.inputs), ...asArray(definition.outputs)];
  const portRegistry = new IdentityRegistry(
    [projectId, definitionUid],
    'port',
    `subflow ${definition.id || definitionUid} port`,
  );
  const ports = prepareCollection(rawPorts, portRegistry, { fallbackPrefix: 'port' })
    .map((port, index) => ({
      ...port,
      internalNodeEntityUid: requireReference(
        nodeRegistry,
        port.internalNodeId,
        `subflow.ports[${index}].internalNodeId`,
      ),
    }));

  const parameterRegistry = new IdentityRegistry(
    [projectId, definitionUid],
    'parameter',
    `subflow ${definition.id || definitionUid} parameter`,
  );
  const exposedParameters = prepareCollection(
    definition.exposedParameters,
    parameterRegistry,
    { fallbackPrefix: 'parameter' },
  ).map((parameter, index) => ({
    ...parameter,
    nodeEntityUid: requireReference(
      nodeRegistry,
      parameter.nodeId,
      `subflow.exposedParameters[${index}].nodeId`,
    ),
  }));

  return enrichAssetReferences({
    ...definition,
    nodes,
    edges,
    inputs: ports.slice(0, inputCount),
    outputs: ports.slice(inputCount),
    exposedParameters,
  }, assetRegistry);
}

function migrateSubflowInstances(input, projectId, canvasId, definitionRegistry, nodeRegistry) {
  const registry = new IdentityRegistry(
    [projectId, canvasId],
    'subflow-instance',
    'subflow instance',
  );
  return prepareCollection(input, registry, {
    identityKeys: ['instanceId', 'id'],
    outputKey: 'instanceId',
    fallbackPrefix: 'subflow-instance',
  }).map((instance) => {
    let migrated = enrichDefinitionReference(instance, definitionRegistry);
    if (instance.nodeId != null) {
      migrated = migrateOptionalIdentityReferences(migrated, [{
        field: 'nodeId',
        stableField: 'nodeEntityUid',
        kind: 'node',
        registry: nodeRegistry,
      }]);
    }
    return migrated;
  });
}

function migrateRuns(input, context) {
  const { projectId, canvasId, nodeRegistry, assetRegistry, definitionRegistry } = context;
  const runRegistry = new IdentityRegistry([projectId], 'run', 'run');
  const preparedRuns = prepareCollection(input, runRegistry, { fallbackPrefix: 'run' });
  const preparedRunEntries = preparedRuns.map((run, runIndex) => {
    const nodeRunRegistry = new IdentityRegistry(
      [projectId, run.entityUid],
      'node-run',
      `run[${runIndex}] node run`,
    );
    return {
      run,
      runIndex,
      nodeRunRegistry,
      preparedNodeRuns: prepareCollection(run.nodeRuns, nodeRunRegistry, {
        fallbackPrefix: 'node-run',
      }),
    };
  });
  const allNodeRunAliases = new Map();
  for (const { preparedNodeRuns } of preparedRunEntries) {
    for (const nodeRun of preparedNodeRuns) {
      const aliases = uniqueStrings([
        nodeRun.id,
        nodeRun.entityUid,
        ...nodeRun.legacyAliases,
      ]);
      for (const alias of aliases) {
        const existing = allNodeRunAliases.get(alias);
        if (existing && existing !== nodeRun.entityUid) {
          throw new IdentityMigrationError(
            'identity_alias_collision',
            'node run 的跨 Run 旧身份别名发生冲突',
            { alias, first: existing, second: nodeRun.entityUid },
          );
        }
        allNodeRunAliases.set(alias, nodeRun.entityUid);
      }
    }
  }
  const allNodeRunResolver = { resolve: (value) => allNodeRunAliases.get(text(value)) || null };

  return preparedRunEntries.map(({ run, runIndex, nodeRunRegistry, preparedNodeRuns }) => {
    const nodeRuns = preparedNodeRuns.map((nodeRun, nodeRunIndex) => {
      const attemptRegistry = new IdentityRegistry(
        [projectId, nodeRun.entityUid],
        'attempt',
        `run[${runIndex}].nodeRuns[${nodeRunIndex}] attempt`,
      );
      const attempts = prepareCollection(nodeRun.attempts, attemptRegistry, {
        fallbackPrefix: 'attempt',
      }).map((attempt) => ({
        ...attempt,
        nodeRunEntityUid: nodeRun.entityUid,
      }));
      const nodeReferenceField = text(nodeRun.nodeId) ? 'nodeId' : 'originalNodeId';
      let migrated = migrateOptionalIdentityReferences({
        ...nodeRun,
        attempts,
      }, [
        {
          field: nodeReferenceField,
          stableField: 'nodeEntityUid',
          kind: 'node',
          registry: nodeRegistry,
        },
        {
          field: 'parentNodeRunId',
          stableField: 'parentNodeRunEntityUid',
          kind: 'node-run',
          registry: allNodeRunResolver,
        },
      ]);
      migrated = enrichDefinitionReference(
        enrichAssetReferences(migrated, assetRegistry),
        definitionRegistry,
      );
      return migrated;
    });

    const eventRegistry = new IdentityRegistry(
      [projectId, run.entityUid],
      'event',
      `run[${runIndex}] event`,
    );
    const events = prepareCollection(run.events, eventRegistry, { fallbackPrefix: 'event' })
      .map((event) => {
        let migrated = migrateOptionalIdentityReferences({
          ...event,
          runEntityUid: run.entityUid,
        }, [{
          field: 'nodeRunId',
          stableField: 'nodeRunEntityUid',
          kind: 'node-run',
          registry: nodeRunRegistry,
        }]);
        if (event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
          migrated.payload = enrichAssetReferences(event.payload, assetRegistry);
        }
        return migrated;
      });

    let migratedRun = migrateOptionalIdentityReferences({
      ...run,
      nodeRuns,
      events,
    }, [
      {
        field: 'parentRunId',
        stableField: 'parentRunEntityUid',
        kind: 'run',
        registry: runRegistry,
      },
      {
        field: 'nodeIds',
        stableField: 'nodeEntityUids',
        kind: 'node',
        registry: nodeRegistry,
        multiple: true,
      },
    ]);
    migratedRun = enrichAssetReferences(migratedRun, assetRegistry);
    return migratedRun;
  });
}

function enrichReviewAnchor(anchor, context) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) return anchor;
  const { nodeRegistry, edgeRegistry, assetRegistry } = context;
  return migrateOptionalIdentityReferences(anchor, [
    { field: 'nodeId', stableField: 'nodeEntityUid', kind: 'node', registry: nodeRegistry },
    { field: 'edgeId', stableField: 'edgeEntityUid', kind: 'edge', registry: edgeRegistry },
    { field: 'assetId', stableField: 'assetEntityUid', kind: 'asset', registry: assetRegistry },
  ]);
}

function migrateReviewThreads(input, context) {
  const { projectId, canvasId } = context;
  const threadRegistry = new IdentityRegistry(
    [projectId, canvasId],
    'review-thread',
    'review thread',
  );
  const threads = prepareCollection(input, threadRegistry, { fallbackPrefix: 'review-thread' });
  return threads.map((thread, threadIndex) => {
    const commentRegistry = new IdentityRegistry(
      [projectId, thread.entityUid],
      'comment',
      `reviewThreads[${threadIndex}] comment`,
    );
    const preparedComments = prepareCollection(thread.comments, commentRegistry, {
      fallbackPrefix: 'comment',
    });
    const comments = preparedComments.map((comment) => ({
      ...comment,
      threadEntityUid: thread.entityUid,
      ...(comment.parentId ? {
        parentEntityUid: requireReference(
          commentRegistry,
          comment.parentId,
          `reviewThreads[${threadIndex}].comment.parentId`,
        ),
      } : {}),
    }));
    return {
      ...thread,
      anchor: enrichReviewAnchor(thread.anchor, context),
      comments,
    };
  });
}

function migrateStandaloneReviewComments(input, reviewThreads, context) {
  const { projectId, canvasId } = context;
  if (!Array.isArray(input)) return undefined;
  const threadByAlias = new Map();
  for (const thread of reviewThreads) {
    threadByAlias.set(thread.entityUid, thread);
    for (const alias of thread.legacyAliases) threadByAlias.set(alias, thread);
    if (thread.id != null) threadByAlias.set(text(thread.id), thread);
  }
  const threadResolver = {
    resolve: (value) => threadByAlias.get(text(value))?.entityUid || null,
  };
  const registries = new Map();
  const prepared = input.map((comment, index) => {
    const record = asObject(comment, `reviewComments[${index}]`);
    const existingReferences = normalizeUnverifiedIdentityReferences(
      record.unverifiedIdentityReferences,
    );
    const threadField = record.threadId != null ? 'threadId' : 'threadEntityUid';
    const explicitThreadReference = record.threadId ?? record.threadEntityUid;
    const existingThreadReference = existingReferences.find((reference) => (
      reference.stableField === 'threadEntityUid'
    ))?.legacyReference;
    const threadReference = explicitThreadReference ?? existingThreadReference ?? 'orphan-thread';
    const rawThreadReference = legacyReferenceText(threadReference);
    const barrier = unverifiedReferenceBarrier(
      existingReferences,
      'threadEntityUid',
      rawThreadReference,
    );
    const thread = barrier ? null : threadByAlias.get(text(threadReference));
    const threadNamespace = thread?.entityUid
      || `legacy-unverified:${rawThreadReference || 'orphan-thread'}`;
    let registry = registries.get(threadNamespace);
    if (!registry) {
      registry = new IdentityRegistry(
        [projectId, canvasId, threadNamespace],
        'comment',
        'review comment',
      );
      registries.set(threadNamespace, registry);
    }
    return {
      comment: registry.register(record, index, {
        fallbackPrefix: 'comment',
      }),
      registry,
      threadField,
      threadReference,
    };
  });
  return prepared.map(({ comment, registry, threadField, threadReference }, index) => {
    const migrated = migrateOptionalIdentityReferences(comment, [{
      field: threadField,
      stableField: 'threadEntityUid',
      kind: 'review-thread',
      registry: threadResolver,
      sourceValue: threadReference,
    }]);
    if (comment.parentId) {
      migrated.parentEntityUid = requireReference(
        registry,
        comment.parentId,
        `reviewComments[${index}].parentId`,
      );
    }
    return migrated;
  });
}

function migrateTombstoneMap(input, registry, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).map(([legacyId, rawRecord]) => {
    const record = rawRecord && typeof rawRecord === 'object' && !Array.isArray(rawRecord)
      ? rawRecord
      : { legacyValue: rawRecord };
    const entityUid = registry.reserve(legacyId, record.entityUid, asArray(record.legacyAliases));
    let migrated = {
      ...record,
      entityUid,
      legacyAliases: uniqueStrings([...asArray(record.legacyAliases), legacyId]),
    };
    if (options.referenceRegistry) {
      migrated = migrateOptionalIdentityReferences(migrated, [
        {
          field: 'source',
          stableField: 'sourceEntityUid',
          kind: options.referenceKind || 'node',
          registry: options.referenceRegistry,
        },
        {
          field: 'target',
          stableField: 'targetEntityUid',
          kind: options.referenceKind || 'node',
          registry: options.referenceRegistry,
        },
      ]);
    }
    return [legacyId, migrated];
  }));
}

function migrateLegacyProjectDocument(input, options = {}) {
  const source = asObject(cloneJson(input), 'legacy canvas');
  const projectId = text(options.projectId || source.projectId) || 'project-local';
  const canvasId = text(options.canvasId || source.canvasId || source.id) || 'canvas-local';
  const nodeRegistry = new IdentityRegistry([projectId, canvasId], 'node', 'canvas node');
  const edgeRegistry = new IdentityRegistry([projectId, canvasId], 'edge', 'canvas edge');
  const assetRegistry = new IdentityRegistry([projectId], 'asset', 'asset');
  const definitionRegistry = new IdentityRegistry(
    [projectId],
    'subflow-definition',
    'subflow definition',
  );

  const preparedNodes = prepareCollection(source.nodes, nodeRegistry, { fallbackPrefix: 'node' });
  const preparedEdges = prepareCollection(source.edges, edgeRegistry, { fallbackPrefix: 'edge' });
  const preparedAssets = prepareCollection(source.assets, assetRegistry, { fallbackPrefix: 'asset' });
  const preparedDefinitions = prepareCollection(source.subflowDefinitions, definitionRegistry, {
    fallbackPrefix: 'subflow-definition',
  });
  const definitionReferenceRegistry = new VerifiedReferenceRegistry(
    definitionRegistry,
    'subflow definition reference',
  );
  collectEmbeddedDefinitionEvidence(source, definitionReferenceRegistry, projectId);

  const nodes = preparedNodes.map((node) => enrichNode(
    node,
    assetRegistry,
    definitionReferenceRegistry,
    projectId,
  ));
  const edges = preparedEdges.map((edge, index) => enrichEdge(edge, nodeRegistry, `edges[${index}]`));
  const assets = migrateAssets(preparedAssets, assetRegistry);
  const subflowDefinitions = preparedDefinitions.map((definition) => migrateSubflowDefinition(
    definition,
    definitionReferenceRegistry,
    assetRegistry,
    projectId,
  ));
  const subflowInstances = migrateSubflowInstances(
    source.subflowInstances,
    projectId,
    canvasId,
    definitionReferenceRegistry,
    nodeRegistry,
  );
  const context = {
    projectId,
    canvasId,
    nodeRegistry,
    edgeRegistry,
    assetRegistry,
    definitionRegistry: definitionReferenceRegistry,
  };
  const runs = migrateRuns(source.runs, context);
  const reviewThreads = migrateReviewThreads(source.reviewThreads, context);
  const reviewComments = migrateStandaloneReviewComments(source.reviewComments, reviewThreads, context);
  const sourceTombstones = source.tombstones && typeof source.tombstones === 'object'
    ? source.tombstones
    : {};

  return {
    ...source,
    schema: CANVAS_SCHEMA,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    identityContract: MIGRATION_CONTRACT,
    projectId,
    canvasId,
    entityUid: isUuid(source.entityUid)
      ? text(source.entityUid).toLowerCase()
      : stableProjectEntityUuid(projectId, canvasId, 'canvas'),
    revision: positiveInteger(source.revision, 1),
    nodes,
    edges,
    viewport: normalizeViewport(source.viewport),
    assets,
    subflowDefinitions,
    subflowInstances,
    runs,
    reviewThreads,
    ...(reviewComments ? { reviewComments } : {}),
    tombstones: {
      ...sourceTombstones,
      nodes: migrateTombstoneMap(sourceTombstones.nodes, nodeRegistry),
      edges: migrateTombstoneMap(sourceTombstones.edges, edgeRegistry, {
        referenceRegistry: nodeRegistry,
        referenceKind: 'node',
      }),
    },
    updatedAt: positiveInteger(options.updatedAt ?? source.updatedAt ?? source.modifiedAt, 1),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function countCanonicalEntities(document) {
  let subflowNodes = 0;
  let subflowEdges = 0;
  let subflowPorts = 0;
  let subflowParameters = 0;
  for (const definition of document.subflowDefinitions) {
    subflowNodes += definition.nodes.length;
    subflowEdges += definition.edges.length;
    subflowPorts += definition.inputs.length + definition.outputs.length;
    subflowParameters += definition.exposedParameters.length;
  }
  let nodeRuns = 0;
  let attempts = 0;
  let runEvents = 0;
  for (const run of document.runs) {
    nodeRuns += run.nodeRuns.length;
    runEvents += run.events.length;
    for (const nodeRun of run.nodeRuns) attempts += nodeRun.attempts.length;
  }
  let reviewComments = asArray(document.reviewComments).length;
  for (const thread of document.reviewThreads) reviewComments += thread.comments.length;
  return {
    nodes: document.nodes.length,
    edges: document.edges.length,
    assets: document.assets.length,
    subflowDefinitions: document.subflowDefinitions.length,
    subflowNodes,
    subflowEdges,
    subflowPorts,
    subflowParameters,
    subflowInstances: document.subflowInstances.length,
    runs: document.runs.length,
    nodeRuns,
    attempts,
    runEvents,
    reviewThreads: document.reviewThreads.length,
    reviewComments,
  };
}

function validateCanonicalProjectDocument(input) {
  const document = asObject(cloneJson(input), 'canonical canvas');
  if (document.schema !== CANVAS_SCHEMA || document.schemaVersion !== CANVAS_SCHEMA_VERSION) {
    throw new IdentityMigrationError('identity_schema_invalid', '画布不是 canonical CanvasDocument v2');
  }
  if (document.identityContract !== MIGRATION_CONTRACT) {
    throw new IdentityMigrationError('identity_contract_invalid', '画布缺少 B1 稳定身份契约');
  }
  if (!isUuid(document.entityUid)) {
    throw new IdentityMigrationError('identity_uuid_invalid', '画布稳定身份不是 RFC4122 UUID');
  }
  const remigrated = migrateLegacyProjectDocument(document, {
    projectId: document.projectId,
    canvasId: document.canvasId,
    updatedAt: document.updatedAt,
  });
  if (stableJson(remigrated) !== stableJson(document)) {
    throw new IdentityMigrationError(
      'identity_canonical_mismatch',
      '画布身份或交叉引用不是可幂等验证的 canonical v2',
    );
  }
  return {
    valid: true,
    schema: CANVAS_SCHEMA,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    identityContract: MIGRATION_CONTRACT,
    counts: countCanonicalEntities(document),
  };
}

function serializeCanonicalProjectDocument(input, options = {}) {
  validateCanonicalProjectDocument(input);
  return JSON.stringify(input, null, options.pretty ? 2 : 0);
}

function parseCanonicalProjectDocument(serialized) {
  let document;
  try {
    document = JSON.parse(String(serialized));
  } catch (error) {
    throw new IdentityMigrationError('identity_json_parse_failed', 'canonical v2 JSON 无法解析', {
      reason: error?.message || String(error),
    });
  }
  validateCanonicalProjectDocument(document);
  return document;
}

module.exports = {
  IdentityMigrationError,
  MIGRATION_CONTRACT,
  migrateLegacyCanvasProject: migrateLegacyProjectDocument,
  migrateLegacyProjectDocument,
  migrateProjectIdentityV2: migrateLegacyProjectDocument,
  parseCanonicalProjectDocument,
  serializeCanonicalProjectDocument,
  stableProjectEntityUuid,
  validateCanonicalProjectDocument,
};
