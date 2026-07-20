import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';
import * as collaborationText from '../src/utils/collaborationText.ts';

const workspaceSource = readFileSync(
  new URL('../src/components/CollaborationWorkspace.tsx', import.meta.url),
  'utf8',
).replace(/\r\n?/g, '\n');
const reviewPanelSource = readFileSync(
  new URL('../src/components/CollaborationReviewPanel.tsx', import.meta.url),
  'utf8',
).replace(/\r\n?/g, '\n');

type Envelope = collaborationText.CollaborationTextUpdateEnvelope;
type Snapshot = collaborationText.CollaborationTextBindingSnapshot;

interface RegistryView {
  key: string;
  text: string;
  canUndo: boolean;
  canRedo: boolean;
  baseRevision: number;
}

interface LegacyRecovery {
  contractVersion: 't8-collaboration-text-recovery-v1';
  projectId: string;
  canvasId: string;
  targetType: collaborationText.CollaborationTextTargetType;
  targetEntityUid: string;
  field: collaborationText.CollaborationTextField;
  legacyText: string;
  currentText: string;
  legacyTextDigest: string;
  materializedTextDigest: string;
  preserved: true;
  updatedAt: number;
}

interface RegistryLike {
  setOnline(online: boolean): void;
  open(snapshot: Snapshot, nextClientSeq: number, descriptor?: Record<string, string>): RegistryView;
  replaceText(key: string, text: string): boolean;
  undo(key: string): boolean;
  redo(key: string): boolean;
  authorityBaselineMatches(envelope: Envelope, revision: number): boolean;
  applyGatewayEvent(raw: unknown): {
    envelope: Envelope;
    revision: number;
    handled: boolean;
    view: RegistryView | null;
    authoritativeText: string | null;
  };
  invalidateAuthority(error?: unknown): void;
  close(key: string, error?: unknown): void;
  clear(error?: unknown): void;
  dispose(): void;
}

interface WorkspaceExports {
  CollaborationLatestRequestFence: new () => {
    begin(): {
      signal: AbortSignal;
      isCurrent(): boolean;
      release(): void;
    };
    cancel(): void;
  };
  collaborationRunScopeKey(
    identity: {
      id?: string;
      projectId: string;
      canvasId: string;
      memberId: string;
      authorizationEpoch: number;
    },
    recoveryGeneration: unknown,
  ): string;
  CollaborationWorkspaceTextRegistry: new (options: {
    submit: (envelope: Envelope) => Promise<unknown>;
    onView: (key: string, view: RegistryView | null) => void;
    onConflict: (item: Record<string, unknown>) => void;
    onAccepted?: (result: Record<string, unknown>, envelope: Envelope) => void;
    flushDelayMs?: number;
    createUpdateId?: () => string;
    now?: () => number;
  }) => RegistryLike;
  CollaborationTextConflictScopeVault: new () => {
    activate(scope: string): Record<string, any>[];
    isActive(scope: string): boolean;
    items(scope: string): Record<string, any>[];
    add(scope: string, item: Record<string, any>): Record<string, any>[];
    discard(scope: string, item: Record<string, any>): Record<string, any>[];
  };
  collaborationTextRecoveryScopeKey(identity: {
    id?: string;
    projectId: string;
    canvasId: string;
    memberId: string;
    authorizationEpoch?: number;
    capabilities?: string[];
  } | null): string;
  collaborationWorkspaceTextKey(descriptor: {
    targetType: string;
    targetEntityUid: string;
    field: string;
  }): string;
  normalizeCollaborationTextGatewayEvent(raw: unknown): {
    envelope: Envelope;
    revision: number;
  };
  collaborationTextGatewayRevisionAction(
    event: { envelope: Envelope; revision: number },
    context: {
      projectId: string;
      canvasId: string;
      currentRevision: number;
      recoveryInFlight: boolean;
      authorityBaselineMatches: boolean;
    },
  ): 'apply' | 'recover' | 'ignore';
  normalizeCollaborationTextLegacyRecovery(
    raw: unknown,
    expected: {
      projectId: string;
      canvasId: string;
      targetType: collaborationText.CollaborationTextTargetType;
      targetEntityUid: string;
      field: collaborationText.CollaborationTextField;
      authoritativeText?: string;
    },
  ): Promise<LegacyRecovery>;
  loadCollaborationTextBinding(
    canvasId: string,
    projectId: string,
    descriptor: {
      targetType: collaborationText.CollaborationTextTargetType;
      targetEntityUid: string;
      field: collaborationText.CollaborationTextField;
    },
    options?: {
      signal?: AbortSignal;
      isCurrentScope?: () => boolean;
      authoritativeText?: string;
    },
  ): Promise<{
    kind: 'binding';
    snapshot: Snapshot;
    nextClientSeq: number;
  } | {
    kind: 'recovery';
    recovery: LegacyRecovery;
  }>;
  collaborationTextLegacyRecoveryConflict(
    recovery: LegacyRecovery,
    descriptor?: { displayId?: string; label?: string },
  ): Record<string, any>;
  copyCollaborationTextConflictExact(
    item: Record<string, any>,
    writeText: (text: string) => void | Promise<void>,
  ): Promise<void>;
  copyCollaborationTextConflictToClipboardExact(
    item: Record<string, any>,
    exactText: string,
    environment?: {
      clipboard?: { writeText: (text: string) => void | Promise<void> } | null;
      document?: Document | null;
    },
  ): Promise<'clipboard-api' | 'exec-command'>;
  discardCollaborationTextConflict(
    current: readonly Record<string, any>[],
    item: Record<string, any>,
  ): Record<string, any>[];
  collaborationTextConflictsForConnection(
    current: readonly Record<string, any>[],
    online: boolean,
  ): readonly Record<string, any>[];
  safeCollaborationTextBindingStatus(error: unknown): string;
  submitCollaborationTextUpdate(
    envelope: Envelope,
    assertCurrentScope: () => void,
    options?: { recoveryGeneration?: string | null },
  ): Promise<unknown>;
}

function loadWorkspaceExports() {
  const output = ts.transpileModule(workspaceSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: 'CollaborationWorkspace.tsx',
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const noop = () => undefined;
  const component = () => null;
  const passthroughModule = new Proxy({ default: component }, {
    get: (target, property) => property in target ? target[property as keyof typeof target] : noop,
  });
  let uidOrdinal = 1;
  const localRequire = (id: string) => {
    if (id === 'react') {
      return {
        useCallback: (value: unknown) => value,
        useEffect: noop,
        useMemo: (factory: () => unknown) => factory(),
        useRef: (value: unknown) => ({ current: value }),
        useState: (value: unknown) => [value, noop],
      };
    }
    if (id === 'react/jsx-runtime') {
      return { Fragment: Symbol('Fragment'), jsx: component, jsxs: component };
    }
    if (id === '../utils/collaborationText') return collaborationText;
    if (id === '../utils/canvasEntityIdentity') {
      return {
        createCanvasEntityUid: () => `00000000-0000-4000-8000-${String(uidOrdinal++).padStart(12, '0')}`,
      };
    }
    if (id.endsWith('.css')) return {};
    if (id === './CollaborationConflictPanel' || id === './CollaborationAssetUpload') {
      return { __esModule: true, default: component };
    }
    return passthroughModule;
  };
  const evaluate = new Function('require', 'module', 'exports', output);
  evaluate(localRequire, module, module.exports);
  return module.exports as unknown as WorkspaceExports;
}

const workspace = loadWorkspaceExports();
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CANVAS_ID = '22222222-2222-4222-8222-222222222222';
const NODE_UID = '33333333-3333-4333-8333-333333333333';
const EPOCH = '44444444-4444-4444-8444-444444444444';

function base64(value: Uint8Array) {
  return Buffer.from(value).toString('base64');
}

function makeSnapshot(
  field: collaborationText.CollaborationTextField,
  text = '',
  revision = 1,
  targetEntityUid = NODE_UID,
): Snapshot {
  const document = new Y.Doc();
  if (text) document.getText(collaborationText.COLLABORATION_TEXT_CONTENT_NAME).insert(0, text);
  const snapshot: Snapshot = {
    contractVersion: collaborationText.COLLABORATION_TEXT_BINDING_CONTRACT,
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    revision,
    targetType: field === 'body' ? 'review' : 'node',
    targetEntityUid,
    bindingEpoch: EPOCH,
    field,
    state: base64(Y.encodeStateAsUpdate(document)),
    stateVector: base64(Y.encodeStateVector(document)),
    materializedText: text,
  };
  document.destroy();
  return snapshot;
}

function makeGatewayEvent(envelope: Envelope, revision: number) {
  return {
    type: 'collaboration.text-update',
    ...envelope,
    revision,
    actorId: 'member-a',
    timestamp: revision * 1000,
  };
}

function makeRecovery(overrides: Partial<LegacyRecovery> = {}): LegacyRecovery {
  const legacyText = overrides.legacyText ?? '旧 schema 中必须手工复制的正文';
  const currentText = overrides.currentText ?? '当前权威正文';
  return {
    contractVersion: 't8-collaboration-text-recovery-v1',
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    targetType: 'node',
    targetEntityUid: NODE_UID,
    field: 'prompt',
    legacyText,
    currentText,
    legacyTextDigest: createHash('sha256').update(legacyText).digest('hex'),
    materializedTextDigest: createHash('sha256').update(currentText).digest('hex'),
    preserved: true,
    updatedAt: 4567,
    ...overrides,
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateIdFactory(prefix = 1) {
  let ordinal = prefix;
  return () => `00000000-0000-4000-9000-${String(ordinal++).padStart(12, '0')}`;
}

function transport(data: unknown, noOp = false) {
  return { data, noOp };
}

function updateFromState(state: string, mutate: (text: Y.Text) => void) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, Buffer.from(state, 'base64'));
    const before = Y.encodeStateVector(document);
    mutate(document.getText(collaborationText.COLLABORATION_TEXT_CONTENT_NAME));
    return base64(Y.encodeStateAsUpdate(document, before));
  } finally {
    document.destroy();
  }
}

function mutationResult(
  snapshot: Snapshot,
  envelope: Envelope,
  revision: number,
  text = snapshot.materializedText,
) {
  return {
    contractVersion: collaborationText.COLLABORATION_TEXT_UPDATE_CONTRACT,
    updateId: envelope.updateId,
    projectId: envelope.projectId,
    canvasId: envelope.canvasId,
    baseRevision: envelope.baseRevision,
    revision,
    targetType: envelope.targetType,
    targetEntityUid: envelope.targetEntityUid,
    bindingEpoch: envelope.bindingEpoch,
    field: envelope.field,
    state: snapshot.state,
    stateVector: snapshot.stateVector,
    text,
    textDigest: createHash('sha256').update(text).digest('hex'),
    updatedBy: 'member-a',
  };
}

function createAuthority(initialSnapshots: Snapshot[], initialRevision = 1) {
  let revision = initialRevision;
  const documents = new Map<string, Y.Doc>();
  for (const snapshot of initialSnapshots) {
    const document = new Y.Doc();
    Y.applyUpdate(document, Buffer.from(snapshot.state, 'base64'));
    documents.set(workspace.collaborationWorkspaceTextKey(snapshot), document);
  }
  return {
    get revision() { return revision; },
    async apply(envelope: Envelope) {
      assert.equal(envelope.baseRevision, revision, 'every field shares the canvas revision');
      const document = documents.get(workspace.collaborationWorkspaceTextKey(envelope));
      assert.ok(document, 'authority binding exists');
      Y.applyUpdate(document, Buffer.from(envelope.update, 'base64'));
      revision += 1;
      const text = document.getText(collaborationText.COLLABORATION_TEXT_CONTENT_NAME).toString();
      return {
        contractVersion: collaborationText.COLLABORATION_TEXT_UPDATE_CONTRACT,
        updateId: envelope.updateId,
        projectId: envelope.projectId,
        canvasId: envelope.canvasId,
        baseRevision: envelope.baseRevision,
        revision,
        targetType: envelope.targetType,
        targetEntityUid: envelope.targetEntityUid,
        bindingEpoch: envelope.bindingEpoch,
        field: envelope.field,
        state: base64(Y.encodeStateAsUpdate(document)),
        stateVector: base64(Y.encodeStateVector(document)),
        text,
        textDigest: createHash('sha256').update(text).digest('hex'),
        updatedBy: 'member-a',
      };
    },
    destroy() {
      for (const document of documents.values()) document.destroy();
    },
  };
}

test('F4 text WS waits behind an in-flight graph recovery and converges on the r3 snapshot', async () => {
  type CanvasState = { revision: number; graph: string; prompt: string };
  let current: CanvasState = { revision: 1, graph: 'graph-r1', prompt: 'prompt-r1' };
  let highWater = 0;
  let activeRecovery: Promise<void> | null = null;
  let releaseR2!: (state: CanvasState) => void;
  const delayedR2 = new Promise<CanvasState>((resolve) => { releaseR2 = resolve; });
  const requestedAfter: number[] = [];
  const serverR3: CanvasState = { revision: 3, graph: 'graph-r2', prompt: 'prompt-r3' };

  const acceptMonotonic = (next: CanvasState) => {
    if (next.revision < current.revision) return false;
    current = next;
    return true;
  };
  const fetchSync = async (afterRevision: number) => {
    requestedAfter.push(afterRevision);
    if (afterRevision === 1) return delayedR2;
    assert.equal(afterRevision, 2);
    return serverR3;
  };
  const recover = (targetRevision: number) => {
    highWater = Math.max(highWater, targetRevision);
    if (activeRecovery) return activeRecovery;
    const run = async () => {
      do {
        const desiredRevision = Math.max(highWater, current.revision);
        highWater = 0;
        const baseRevision = current.revision;
        const next = await fetchSync(baseRevision);
        acceptMonotonic(next);
        if (desiredRevision > current.revision) {
          assert.ok(current.revision > baseRevision, 'recovery must make monotonic progress');
          highWater = Math.max(highWater, desiredRevision);
        }
      } while (highWater > current.revision);
    };
    let promise!: Promise<void>;
    promise = run().finally(() => {
      if (activeRecovery === promise) activeRecovery = null;
    });
    activeRecovery = promise;
    return promise;
  };

  const graphRecovery = recover(2);
  assert.deepEqual(requestedAfter, [1], 'the r2 response is now delayed in flight');

  const r2TextSnapshot = makeSnapshot('prompt', 'prompt-r2', 2);
  const remote = collaborationText.CollaborationTextClient.fromBindingSnapshot(r2TextSnapshot, {
    online: true,
    initialClientSeq: 8,
    createUpdateId: updateIdFactory(600),
  });
  remote.replaceText('prompt-r3');
  const r3Envelope = remote.flush();
  assert.ok(r3Envelope);
  const r3Event = workspace.normalizeCollaborationTextGatewayEvent(
    makeGatewayEvent(r3Envelope, 3),
  );
  const action = workspace.collaborationTextGatewayRevisionAction(r3Event, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    currentRevision: current.revision,
    recoveryInFlight: activeRecovery !== null,
    authorityBaselineMatches: false,
  });
  assert.equal(action, 'recover');
  assert.equal(current.revision, 1, 'the text event must not jump the local document to r3');
  const textRecovery = recover(r3Event.revision);
  assert.equal(textRecovery, graphRecovery, 'the revision gap joins the existing single-flight recovery');

  releaseR2({ revision: 2, graph: 'graph-r2', prompt: 'prompt-r1' });
  await textRecovery;
  assert.deepEqual(requestedAfter, [1, 2]);
  assert.deepEqual(current, serverR3, 'the second round must use the authoritative r3 snapshot');
  assert.equal(
    acceptMonotonic({ revision: 2, graph: 'stale-r2', prompt: 'stale-r2' }),
    false,
    'a late r2 response cannot overwrite the recovered r3 state',
  );
  assert.deepEqual(current, serverR3);
  remote.dispose();
});

test('F4 text WS applies only a continuous event with a matching active binding baseline', () => {
  const snapshot = makeSnapshot('prompt', 'before', 1);
  let view: RegistryView | null = null;
  const registry = new workspace.CollaborationWorkspaceTextRegistry({
    submit: async () => assert.fail('remote WS application must not POST'),
    onView: (_key, next) => { view = next; },
    onConflict: () => assert.fail('continuous remote text must not conflict'),
  });
  registry.setOnline(true);
  registry.open(snapshot, 0);

  const remote = collaborationText.CollaborationTextClient.fromBindingSnapshot(snapshot, {
    online: true,
    initialClientSeq: 12,
    createUpdateId: updateIdFactory(700),
  });
  remote.replaceText('after');
  const envelope = remote.flush();
  assert.ok(envelope);
  const event = workspace.normalizeCollaborationTextGatewayEvent(makeGatewayEvent(envelope, 2));
  const baselineMatches = registry.authorityBaselineMatches(event.envelope, 1);
  assert.equal(baselineMatches, true);
  assert.equal(workspace.collaborationTextGatewayRevisionAction(event, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    currentRevision: 1,
    recoveryInFlight: false,
    authorityBaselineMatches: baselineMatches,
  }), 'apply');
  registry.applyGatewayEvent(makeGatewayEvent(envelope, 2));
  assert.equal(view?.text, 'after');
  assert.equal(view?.baseRevision, 2);
  assert.equal(workspace.collaborationTextGatewayRevisionAction(event, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    currentRevision: 2,
    recoveryInFlight: false,
    authorityBaselineMatches: false,
  }), 'ignore', 'an already applied WS echo must not start another recovery');
  remote.dispose();
  registry.dispose();
});

test('F4 schema mismatch loads strict legacy recovery for memory-only copy or discard', async () => {
  const recovery = makeRecovery();
  const requests: string[] = [];
  let storageTouched = false;
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;
  const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() { storageTouched = true; throw new Error('recovery must remain memory-only'); },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { storageTouched = true; throw new Error('recovery must remain memory-only'); },
  });
  (globalThis as { window?: unknown }).window = globalThis;
  globalThis.fetch = (async (url: string | URL | Request) => {
    requests.push(String(url));
    if (requests.length === 1) {
      return new Response(JSON.stringify({
        success: false,
        code: 'collaboration_text_schema_mismatch',
        error: 'legacy mismatch',
        details: {
          recoveryAvailable: true,
          recoveryContractVersion: 't8-collaboration-text-recovery-v1',
        },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: true, data: recovery }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const loaded = await workspace.loadCollaborationTextBinding(
      CANVAS_ID,
      PROJECT_ID,
      { targetType: 'node', targetEntityUid: NODE_UID, field: 'prompt' },
      { authoritativeText: recovery.currentText, isCurrentScope: () => true },
    );
    assert.equal(loaded.kind, 'recovery');
    assert.match(requests[0], new RegExp(`/canvases/${CANVAS_ID}/text\\?`));
    assert.match(requests[1], new RegExp(`/canvases/${CANVAS_ID}/text/recovery\\?`));
    assert.match(requests[1], /targetType=node/);
    assert.match(requests[1], new RegExp(`targetEntityUid=${NODE_UID}`));
    assert.match(requests[1], /field=prompt/);
    assert.equal(storageTouched, false);
    if (loaded.kind !== 'recovery') assert.fail('expected recovery result');

    const conflict = workspace.collaborationTextLegacyRecoveryConflict(loaded.recovery, {
      displayId: 'node-display',
      label: 'Prompt',
    });
    assert.equal(conflict.reason, 'schema');
    assert.equal(conflict.localText, recovery.legacyText);
    assert.equal(Object.hasOwn(conflict, 'currentText'), false);
    assert.equal(Object.hasOwn(conflict, 'materializedTextDigest'), false);
    let copied = '';
    await workspace.copyCollaborationTextConflictExact(conflict, (text) => { copied = text; });
    assert.equal(copied, recovery.legacyText, 'copy receives the exact preserved legacy text');
    const discarded = workspace.discardCollaborationTextConflict([conflict], conflict);
    assert.deepEqual(discarded, []);
    assert.equal(storageTouched, false);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
    if (originalSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('F4 exact conflict copy prefers Clipboard API and synchronously falls back for LAN HTTP', async () => {
  const exactText = `LAN 完整恢复正文\n${'甲😀乙'.repeat(400)}`;
  const conflict = {
    id: 'lan-copy-conflict',
    kind: 'text',
    reason: 'offline',
    target: { entityType: 'node', entityUid: NODE_UID },
    field: 'prompt',
    localText: exactText,
    createdAt: 1,
  };

  let clipboardText = '';
  let unexpectedFallback = 0;
  const clipboardMethod = await workspace.copyCollaborationTextConflictToClipboardExact(
    conflict,
    exactText,
    {
      clipboard: { writeText: (text) => { clipboardText = text; } },
      document: {
        execCommand: () => { unexpectedFallback += 1; return true; },
      } as unknown as Document,
    },
  );
  assert.equal(clipboardMethod, 'clipboard-api');
  assert.equal(clipboardText, exactText);
  assert.equal(unexpectedFallback, 0, 'successful Clipboard API must remain the preferred path');

  const events: string[] = [];
  const textarea = {
    value: '',
    readOnly: false,
    tabIndex: 0,
    style: {} as Record<string, string>,
    setAttribute: (name: string, value: string) => events.push(`attribute:${name}:${value}`),
    focus: () => events.push('textarea:focus'),
    select: () => events.push('textarea:select'),
    setSelectionRange: (start: number, end: number) => events.push(`range:${start}:${end}`),
    remove: () => events.push('textarea:remove'),
  };
  const fallbackDocument = {
    body: { appendChild: (node: unknown) => { assert.equal(node, textarea); events.push('append'); } },
    activeElement: { focus: () => events.push('focus:restore') },
    createElement: (tag: string) => {
      assert.equal(tag, 'textarea');
      events.push('create:textarea');
      return textarea;
    },
    execCommand: (command: string) => {
      assert.equal(command, 'copy');
      assert.equal(textarea.value, exactText, 'legacy path must copy the exact, untruncated text');
      events.push('exec:copy');
      return true;
    },
  } as unknown as Document;
  const fallbackPromise = workspace.copyCollaborationTextConflictToClipboardExact(
    conflict,
    exactText,
    { clipboard: null, document: fallbackDocument },
  );
  assert.ok(
    events.includes('exec:copy'),
    'missing Clipboard API must execute the textarea fallback before the click handler yields',
  );
  assert.equal(await fallbackPromise, 'exec-command');
  assert.equal(textarea.value, exactText);
  assert.ok(events.indexOf('append') < events.indexOf('exec:copy'));
  assert.ok(events.indexOf('exec:copy') < events.indexOf('textarea:remove'));

  let rejectedFallbackCalls = 0;
  const rejectedMethod = await workspace.copyCollaborationTextConflictToClipboardExact(
    conflict,
    exactText,
    {
      clipboard: { writeText: () => Promise.reject(new Error('secure clipboard denied')) },
      document: {
        body: { appendChild: () => undefined },
        activeElement: null,
        createElement: () => ({
          value: '', readOnly: false, tabIndex: 0, style: {}, setAttribute: () => undefined,
          focus: () => undefined, select: () => undefined, setSelectionRange: () => undefined,
          remove: () => undefined,
        }),
        execCommand: () => { rejectedFallbackCalls += 1; return true; },
      } as unknown as Document,
    },
  );
  assert.equal(rejectedMethod, 'exec-command');
  assert.equal(rejectedFallbackCalls, 1, 'rejected Clipboard API must fall back once');

  let failedFallbackRemoved = false;
  await assert.rejects(
    workspace.copyCollaborationTextConflictToClipboardExact(conflict, exactText, {
      clipboard: null,
      document: {
        body: { appendChild: () => undefined },
        activeElement: null,
        createElement: () => ({
          value: '', readOnly: false, tabIndex: 0, style: {}, setAttribute: () => undefined,
          focus: () => undefined, select: () => undefined, setSelectionRange: () => undefined,
          remove: () => { failedFallbackRemoved = true; },
        }),
        execCommand: () => false,
      } as unknown as Document,
    }),
    /展开完整正文并手工选择复制/,
  );
  assert.equal(failedFallbackRemoved, true, 'failed legacy copy still removes its hidden textarea');
  assert.throws(
    () => workspace.copyCollaborationTextConflictToClipboardExact(conflict, `${exactText}篡改`, {
      clipboard: { writeText: () => assert.fail('identity mismatch must not touch clipboard') },
      document: null,
    }),
    /复制身份不一致/,
  );

  const handlerStart = workspaceSource.indexOf('const copyTextConflict = useCallback');
  const handlerEnd = workspaceSource.indexOf('\n\n  const requestRun', handlerStart);
  const handler = workspaceSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /await copyCollaborationTextConflictToClipboardExact\(item, exactText\);/);
  assert.ok(
    handler.indexOf('await copyCollaborationTextConflictToClipboardExact')
      < handler.indexOf('removeTextConflict(item)'),
    'a rejected copy must keep the memory-only conflict available',
  );
});

test('F4 legacy recovery rejects cross-scope, malformed, stale and unauthorized responses', async () => {
  const expected = {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    targetType: 'node' as const,
    targetEntityUid: NODE_UID,
    field: 'prompt' as const,
    authoritativeText: '当前权威正文',
  };
  await assert.rejects(
    workspace.normalizeCollaborationTextLegacyRecovery(
      { ...makeRecovery(), canvasId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      expected,
    ),
    /作用域或目标不匹配/,
  );
  await assert.rejects(
    workspace.normalizeCollaborationTextLegacyRecovery(
      { ...makeRecovery(), sessionId: 'must-not-be-accepted' },
      expected,
    ),
    /字段不完整/,
  );
  await assert.rejects(
    workspace.normalizeCollaborationTextLegacyRecovery(
      { ...makeRecovery(), legacyTextDigest: '0'.repeat(64) },
      expected,
    ),
    /摘要不匹配/,
  );
  await assert.rejects(
    workspace.normalizeCollaborationTextLegacyRecovery(
      makeRecovery({ currentText: 'stale current text' }),
      expected,
    ),
    /正文、摘要或保留状态无效/,
  );
  assert.equal(
    workspace.safeCollaborationTextBindingStatus(Object.assign(new Error('secret target'), {
      status: 403,
      code: 'collaboration_text_permission_denied',
    })),
    '当前会话无权读取该协同文本字段或其旧正文恢复内容。',
  );
  assert.equal(
    workspace.safeCollaborationTextBindingStatus(Object.assign(new Error('secret existence'), {
      status: 404,
      code: 'collaboration_text_recovery_unavailable',
    })),
    '该协同文本字段或旧正文恢复内容当前不可用。',
  );

  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;
  (globalThis as { window?: unknown }).window = globalThis;
  let requestCount = 0;
  let releaseRecovery!: (response: Response) => void;
  let markRecoveryRequested!: () => void;
  const recoveryRequested = new Promise<void>((resolve) => { markRecoveryRequested = resolve; });
  const delayedRecovery = new Promise<Response>((resolve) => { releaseRecovery = resolve; });
  globalThis.fetch = (async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(JSON.stringify({
        success: false,
        code: 'collaboration_text_schema_mismatch',
        error: 'legacy mismatch',
        details: { recoveryAvailable: true },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    markRecoveryRequested();
    return delayedRecovery;
  }) as typeof fetch;
  let currentScope = true;
  try {
    const pending = workspace.loadCollaborationTextBinding(
      CANVAS_ID,
      PROJECT_ID,
      { targetType: 'node', targetEntityUid: NODE_UID, field: 'prompt' },
      { authoritativeText: '当前权威正文', isCurrentScope: () => currentScope },
    );
    await recoveryRequested;
    currentScope = false;
    releaseRecovery(new Response(JSON.stringify({ success: true, data: makeRecovery() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await assert.rejects(pending, (error: any) => error?.name === 'AbortError');
    const recoveryConflict = workspace.collaborationTextLegacyRecoveryConflict(makeRecovery());
    assert.equal(workspace.collaborationTextConflictsForConnection([recoveryConflict], true).length, 1);
    assert.deepEqual(
      workspace.collaborationTextConflictsForConnection([recoveryConflict], false),
      [recoveryConflict],
      'transient disconnect retains memory-only recovery items for exact copy',
    );

    const aborted = new AbortController();
    aborted.abort();
    const requestsBeforeAbort = requestCount;
    await assert.rejects(workspace.loadCollaborationTextBinding(
      CANVAS_ID,
      PROJECT_ID,
      { targetType: 'node', targetEntityUid: NODE_UID, field: 'prompt' },
      { signal: aborted.signal },
    ), (error: any) => error?.name === 'AbortError');
    assert.equal(requestCount, requestsBeforeAbort, 'an aborted binding load never reaches the network');
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

test('F4 workspace serializes title and Prompt through one global clientSeq/revision lane', async () => {
  const title = makeSnapshot('title');
  const prompt = makeSnapshot('prompt');
  const authority = createAuthority([title, prompt]);
  const submitted: Envelope[] = [];
  const views = new Map<string, RegistryView>();
  let storageTouched = false;
  const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() { storageTouched = true; throw new Error('text must not touch storage'); },
  });
  try {
    const registry = new workspace.CollaborationWorkspaceTextRegistry({
      flushDelayMs: 100,
      createUpdateId: updateIdFactory(),
      submit: async (envelope) => {
        submitted.push(envelope);
        return transport(await authority.apply(envelope));
      },
      onView: (key, view) => { if (view) views.set(key, view); else views.delete(key); },
      onConflict: () => assert.fail('valid online edits must not conflict'),
    });
    registry.setOnline(true);
    const titleView = registry.open(title, 0, { displayId: 'node-1' });
    const promptView = registry.open(prompt, 0, { displayId: 'node-1' });
    registry.replaceText(titleView.key, '权威标题');
    registry.replaceText(promptView.key, 'cinematic penguin prompt');
    await wait(280);

    assert.deepEqual(submitted.map((item) => item.clientSeq), [0, 1]);
    assert.deepEqual(submitted.map((item) => item.baseRevision), [1, 2]);
    assert.deepEqual(submitted.map((item) => item.field), ['title', 'prompt']);
    assert.equal(submitted[0].targetType, 'node');
    assert.equal(submitted[0].targetEntityUid, NODE_UID);
    assert.equal('payload' in submitted[0], false, 'title uses the Yjs text envelope, never node.patch');
    assert.equal(new Set(submitted.map((item) => item.updateId)).size, 2);
    assert.equal(authority.revision, 3);
    assert.equal(views.get(titleView.key)?.baseRevision, 3);
    assert.equal(views.get(promptView.key)?.baseRevision, 3);
    assert.equal(storageTouched, false);
    registry.dispose();
  } finally {
    authority.destroy();
    if (originalSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});

test('F4 state-level no-op keeps the global clientSeq and the next meaningful update reuses it', async () => {
  const snapshot = makeSnapshot('prompt', 'baseline');
  const authority = createAuthority([snapshot]);
  const submitted: Envelope[] = [];
  const accepted: Array<Record<string, unknown>> = [];
  const conflicts: Array<Record<string, unknown>> = [];
  const nextUpdateId = updateIdFactory(25);
  let currentView: RegistryView | null = null;
  const registry = new workspace.CollaborationWorkspaceTextRegistry({
    flushDelayMs: 100,
    createUpdateId: nextUpdateId,
    submit: async (envelope) => {
      submitted.push(envelope);
      if (submitted.length === 1) {
        return transport(mutationResult(snapshot, envelope, snapshot.revision), true);
      }
      return transport(await authority.apply(envelope));
    },
    onView: (_key, view) => { currentView = view; },
    onConflict: (item) => conflicts.push(item),
    onAccepted: (result) => accepted.push(result),
  });
  registry.setOnline(true);
  const key = registry.open(snapshot, 0).key;
  const noOpEnvelope: Envelope = {
    contractVersion: collaborationText.COLLABORATION_TEXT_UPDATE_CONTRACT,
    updateId: nextUpdateId(),
    clientSeq: 999,
    projectId: snapshot.projectId,
    canvasId: snapshot.canvasId,
    baseRevision: snapshot.revision,
    targetType: snapshot.targetType,
    targetEntityUid: snapshot.targetEntityUid,
    bindingEpoch: snapshot.bindingEpoch,
    field: snapshot.field,
    update: updateFromState(snapshot.state, () => undefined),
  };
  await (registry as unknown as {
    dispatch(key: string, envelope: Envelope): Promise<void>;
  }).dispatch(key, noOpEnvelope);

  assert.equal(currentView?.text, 'baseline');
  assert.equal(currentView?.baseRevision, 1);
  assert.equal(accepted.length, 0, 'state-level no-op is not a materialized mutation callback');
  registry.replaceText(key, 'baseline + meaningful');
  await wait(160);

  assert.deepEqual(submitted.map((item) => item.clientSeq), [0, 0]);
  assert.deepEqual(submitted.map((item) => item.baseRevision), [1, 1]);
  assert.equal(submitted[0].updateId, noOpEnvelope.updateId);
  assert.notEqual(submitted[1].updateId, noOpEnvelope.updateId);
  assert.equal(authority.revision, 2);
  assert.equal(currentView?.text, 'baseline + meaningful');
  assert.equal(currentView?.baseRevision, 2);
  assert.equal(accepted.length, 1);
  assert.equal(conflicts.length, 0);
  registry.dispose();
  authority.destroy();
});

test('F4 closing one editor during its ACK preserves the unaccepted text without reusing its global sequence', async () => {
  const title = makeSnapshot('title');
  const prompt = makeSnapshot('prompt');
  const authority = createAuthority([title, prompt]);
  const submitted: Envelope[] = [];
  const conflicts: Array<Record<string, any>> = [];
  const registry = new workspace.CollaborationWorkspaceTextRegistry({
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(50),
    submit: async (envelope) => {
      submitted.push(envelope);
      if (submitted.length === 1) await wait(70);
      return transport(await authority.apply(envelope));
    },
    onView: () => undefined,
    onConflict: (item) => conflicts.push(item),
  });
  registry.setOnline(true);
  const titleKey = registry.open(title, 0).key;
  const promptKey = registry.open(prompt, 0).key;
  registry.replaceText(titleKey, 'accepted while closing');
  await wait(120);
  registry.close(titleKey);
  registry.replaceText(promptKey, 'next field');
  await wait(230);
  assert.deepEqual(submitted.map((item) => item.clientSeq), [0, 1]);
  assert.deepEqual(submitted.map((item) => item.baseRevision), [1, 2]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].localText, 'accepted while closing');
  registry.dispose();
  authority.destroy();
});

test('F4 immediate node switch, same-key reload, and clean close preserve only unaccepted text', async () => {
  const conflicts: Array<Record<string, any>> = [];
  const views = new Map<string, RegistryView>();
  let submitCount = 0;
  const registry = new workspace.CollaborationWorkspaceTextRegistry({
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(75),
    submit: async () => {
      submitCount += 1;
      return assert.fail('an editor closed before its flush must not submit later');
    },
    onView: (key, view) => {
      if (view) views.set(key, view);
      else views.delete(key);
    },
    onConflict: (item) => conflicts.push(item),
  });
  registry.setOnline(true);

  const firstKey = registry.open(makeSnapshot('title', 'node A'), 0).key;
  registry.replaceText(firstKey, 'node A local draft');
  registry.close(firstKey);
  assert.equal(views.has(firstKey), false);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].localText, 'node A local draft');

  const cleanKey = registry.open(makeSnapshot('prompt', 'clean authority'), 0).key;
  registry.close(cleanKey);
  assert.equal(conflicts.length, 1, 'clean node selection teardown must not create a fake conflict');

  const reloadedKey = registry.open(makeSnapshot('title', 'authority before reload'), 0).key;
  registry.replaceText(reloadedKey, 'same key local draft');
  const reloadedView = registry.open(makeSnapshot('title', 'authority after reload'), 0);
  assert.equal(reloadedView.key, reloadedKey);
  assert.equal(reloadedView.text, 'authority after reload');
  assert.equal(conflicts.length, 2);
  assert.equal(conflicts[1].localText, 'same key local draft');

  registry.close(reloadedKey);
  assert.equal(conflicts.length, 2, 'the newly loaded clean binding closes without recovery noise');
  await wait(130);
  assert.equal(submitCount, 0);
  registry.dispose();
});

test('F4 comment switching and explicit close preserve each buffered body exactly', async () => {
  const commentA = '55555555-5555-4555-8555-555555555555';
  const commentB = '66666666-6666-4666-8666-666666666666';
  const conflicts: Array<Record<string, any>> = [];
  let submitCount = 0;
  const registry = new workspace.CollaborationWorkspaceTextRegistry({
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(85),
    submit: async () => {
      submitCount += 1;
      return assert.fail('closed comment buffers must not be submitted');
    },
    onView: () => undefined,
    onConflict: (item) => conflicts.push(item),
  });
  registry.setOnline(true);

  const firstKey = registry.open(makeSnapshot('body', 'comment A', 1, commentA), 0).key;
  registry.replaceText(firstKey, 'comment A buffered edit');
  registry.close(firstKey);
  const secondKey = registry.open(makeSnapshot('body', 'comment B', 1, commentB), 0).key;
  registry.replaceText(secondKey, 'comment B buffered edit');
  registry.close(secondKey);

  assert.deepEqual(conflicts.map((item) => item.localText), [
    'comment A buffered edit',
    'comment B buffered edit',
  ]);
  await wait(130);
  assert.equal(submitCount, 0);
  registry.dispose();
});

test('F4 auth refresh vault retains same-subject recovery and isolates cross-principal plaintext', () => {
  const identity = {
    id: 'session-a',
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    memberId: 'member-a',
    authorizationEpoch: 1,
    capabilities: ['editGraph'],
  };
  const refreshedIdentity = {
    ...identity,
    authorizationEpoch: 2,
    capabilities: ['comment'],
  };
  const otherPrincipal = {
    ...identity,
    id: 'session-b',
    memberId: 'member-b',
    authorizationEpoch: 9,
  };
  const originalScope = workspace.collaborationTextRecoveryScopeKey(identity);
  const refreshedScope = workspace.collaborationTextRecoveryScopeKey(refreshedIdentity);
  const otherScope = workspace.collaborationTextRecoveryScopeKey(otherPrincipal);
  assert.equal(refreshedScope, originalScope, 'epoch/capability changes retain the same recovery scope');
  assert.notEqual(otherScope, originalScope, 'session/member changes isolate recovery plaintext');

  const vault = new workspace.CollaborationTextConflictScopeVault();
  vault.activate(originalScope);
  const legacyConflict = {
    id: 'legacy:existing-recovery',
    kind: 'text',
    reason: 'schema',
    target: { entityType: 'node', entityUid: NODE_UID },
    field: 'prompt',
    localText: 'existing exact recovery',
    createdAt: 1,
  };
  vault.add(originalScope, legacyConflict);

  const registry = new workspace.CollaborationWorkspaceTextRegistry({
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(95),
    submit: async () => assert.fail('authorization refresh must cancel buffered dispatch'),
    onView: () => undefined,
    onConflict: (item) => { vault.add(originalScope, item); },
  });
  registry.setOnline(true);
  const pendingKey = registry.open(makeSnapshot('title', 'authority title'), 0).key;
  const cleanKey = registry.open(makeSnapshot('prompt', 'authority prompt'), 0).key;
  registry.replaceText(pendingKey, 'pending across authorization refresh');
  registry.clear({ code: 'collaboration_text_permission_denied', status: 403 });

  const sameSubjectItems = vault.activate(refreshedScope);
  assert.deepEqual(sameSubjectItems.map((item) => item.localText), [
    'existing exact recovery',
    'pending across authorization refresh',
  ]);
  assert.equal(sameSubjectItems.length, 2, 'the clean binding must not create a recovery item');
  assert.throws(() => registry.replaceText(cleanKey, 'closed'), /绑定尚未载入/);

  assert.deepEqual(vault.activate(otherScope), [], 'another principal cannot observe old plaintext');
  const otherConflict = {
    ...legacyConflict,
    id: 'text:other-principal',
    localText: 'other principal recovery',
  };
  vault.add(otherScope, otherConflict);
  assert.deepEqual(vault.items(otherScope).map((item) => item.localText), ['other principal recovery']);
  assert.deepEqual(vault.items(originalScope).map((item) => item.localText), [
    'existing exact recovery',
    'pending across authorization refresh',
  ]);

  const restored = vault.activate(originalScope);
  assert.deepEqual(restored.map((item) => item.localText), [
    'existing exact recovery',
    'pending across authorization refresh',
  ]);
  vault.discard(originalScope, restored[0]);
  vault.discard(originalScope, restored[1]);
  assert.deepEqual(vault.activate(otherScope).map((item) => item.localText), ['other principal recovery']);
  assert.deepEqual(vault.activate(originalScope), [], 'explicit discard is retained inside its own scope');
  registry.dispose();
});

test('F4 workspace merges independent Y.Text edits and personal undo keeps remote text', async () => {
  const snapshot = makeSnapshot('prompt');
  const authority = createAuthority([snapshot]);
  const aSubmitted: Envelope[] = [];
  const bSubmitted: Envelope[] = [];
  let aView: RegistryView | null = null;
  let bView: RegistryView | null = null;
  const registryA = new workspace.CollaborationWorkspaceTextRegistry({
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(100),
    submit: async (envelope) => { aSubmitted.push(envelope); return transport(await authority.apply(envelope)); },
    onView: (_key, view) => { aView = view; },
    onConflict: () => assert.fail('A must not conflict'),
  });
  const registryB = new workspace.CollaborationWorkspaceTextRegistry({
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(200),
    submit: async (envelope) => { bSubmitted.push(envelope); return transport(await authority.apply(envelope)); },
    onView: (_key, view) => { bView = view; },
    onConflict: () => assert.fail('B must not conflict'),
  });
  registryA.setOnline(true);
  registryB.setOnline(true);
  const keyA = registryA.open(snapshot, 0).key;
  const keyB = registryB.open(snapshot, 0).key;
  registryA.replaceText(keyA, 'A');
  await wait(160);
  assert.equal(aSubmitted.length, 1);
  registryB.applyGatewayEvent(makeGatewayEvent(aSubmitted[0], 2));
  assert.equal(bView?.text, 'A');

  registryB.replaceText(keyB, 'AB');
  await wait(160);
  assert.equal(bSubmitted.length, 1);
  registryA.applyGatewayEvent(makeGatewayEvent(bSubmitted[0], 3));
  assert.equal(aView?.text, 'AB');
  assert.equal(registryA.undo(keyA), true);
  assert.equal(aView?.text, 'B', 'undo removes only A local origin and retains B remote origin');
  await wait(160);
  assert.equal(aSubmitted[1]?.baseRevision, 3);
  assert.equal(aSubmitted[1]?.clientSeq, 1);
  assert.equal(authority.revision, 4);

  registryA.dispose();
  registryB.dispose();
  authority.destroy();
});

test('F4 stale-base ACK merges the full authoritative state and routes revision gaps to recovery', async () => {
  const snapshot = makeSnapshot('prompt');
  const submitted: Envelope[] = [];
  const conflicts: Array<Record<string, unknown>> = [];
  const accepted: Array<Record<string, unknown>> = [];
  let currentView: RegistryView | null = null;
  const authority = new Y.Doc();
  Y.applyUpdate(authority, Buffer.from(snapshot.state, 'base64'));
  const registry = new workspace.CollaborationWorkspaceTextRegistry({
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(250),
    submit: async (envelope) => {
      submitted.push(envelope);
      authority.getText(collaborationText.COLLABORATION_TEXT_CONTENT_NAME).insert(0, '远端');
      Y.applyUpdate(authority, Buffer.from(envelope.update, 'base64'));
      const text = authority.getText(collaborationText.COLLABORATION_TEXT_CONTENT_NAME).toString();
      const authoritativeSnapshot: Snapshot = {
        ...snapshot,
        revision: 3,
        state: base64(Y.encodeStateAsUpdate(authority)),
        stateVector: base64(Y.encodeStateVector(authority)),
        materializedText: text,
      };
      return transport(mutationResult(authoritativeSnapshot, envelope, 3, text));
    },
    onView: (_key, view) => { currentView = view; },
    onConflict: (item) => conflicts.push(item),
    onAccepted: (result) => accepted.push(result),
  });
  registry.setOnline(true);
  const key = registry.open(snapshot, 0).key;
  registry.replaceText(key, '本地');
  await wait(170);

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].baseRevision, 1);
  assert.equal(currentView?.baseRevision, 3);
  assert.match(currentView?.text || '', /远端/);
  assert.match(currentView?.text || '', /本地/);
  assert.equal(accepted[0]?.revision, 3);
  assert.equal(conflicts.length, 0);

  const staleBaseEvent = workspace.normalizeCollaborationTextGatewayEvent(
    makeGatewayEvent(submitted[0], 3),
  );
  assert.equal(workspace.collaborationTextGatewayRevisionAction(staleBaseEvent, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    currentRevision: 2,
    recoveryInFlight: false,
    authorityBaselineMatches: false,
  }), 'recover', 'a valid stale-base event never skips the missing canvas revision');
  assert.throws(
    () => workspace.normalizeCollaborationTextGatewayEvent(makeGatewayEvent(submitted[0], 1)),
    /revision/,
    'a WebSocket event still must advance beyond its declared baseRevision',
  );

  assert.equal(registry.undo(key), true);
  assert.equal(currentView?.text, '远端', 'personal undo removes only the local origin after ACK merge');
  registry.dispose();
  authority.destroy();
});

test('F4 exact WS confirmation resolves an unknown HTTP outcome; unconfirmed authority errors stay memory-only', async () => {
  const snapshot = makeSnapshot('prompt');
  const conflicts: Array<Record<string, unknown>> = [];
  const submitted: Envelope[] = [];
  let currentView: RegistryView | null = null;
  const registry = new workspace.CollaborationWorkspaceTextRegistry({
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(300),
    submit: async (envelope) => {
      submitted.push(envelope);
      await wait(90);
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    },
    onView: (_key, view) => { currentView = view; },
    onConflict: (item) => conflicts.push(item),
  });
  registry.setOnline(true);
  const key = registry.open(snapshot, 0).key;
  registry.replaceText(key, 'server accepted before response vanished');
  await wait(120);
  assert.equal(submitted.length, 1);
  const unknownOutcomeEvent = workspace.normalizeCollaborationTextGatewayEvent(
    makeGatewayEvent(submitted[0], 2),
  );
  const unknownOutcomeBaseline = registry.authorityBaselineMatches(
    unknownOutcomeEvent.envelope,
    1,
  );
  assert.equal(workspace.collaborationTextGatewayRevisionAction(unknownOutcomeEvent, {
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    currentRevision: 1,
    recoveryInFlight: false,
    authorityBaselineMatches: unknownOutcomeBaseline,
  }), 'apply', 'an exact in-flight WS confirmation remains eligible for direct application');
  const confirmed = registry.applyGatewayEvent(makeGatewayEvent(submitted[0], 2));
  assert.equal(confirmed.authoritativeText, 'server accepted before response vanished');
  await wait(110);
  assert.equal(conflicts.length, 0, 'exact same updateId/body WS is an authority confirmation');
  assert.equal(currentView?.text, 'server accepted before response vanished');
  assert.equal(currentView?.baseRevision, 2);
  registry.dispose();

  const rejectedConflicts: Array<Record<string, unknown>> = [];
  const rejected = new workspace.CollaborationWorkspaceTextRegistry({
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(400),
    submit: async () => {
      throw Object.assign(new Error('deleted'), {
        status: 409,
        code: 'collaboration_text_target_deleted',
      });
    },
    onView: () => undefined,
    onConflict: (item) => rejectedConflicts.push(item),
    now: () => 1234,
  });
  assert.throws(() => rejected.open(snapshot, 0), /只允许在线编辑/);
  rejected.setOnline(true);
  const rejectedKey = rejected.open(snapshot, 0).key;
  rejected.replaceText(rejectedKey, 'copy this exact local draft');
  await wait(150);
  assert.equal(rejectedConflicts.length, 1);
  assert.equal(rejectedConflicts[0].reason, 'deleted');
  assert.equal(rejectedConflicts[0].localText, 'copy this exact local draft');
  assert.equal(rejectedConflicts[0].createdAt, 1234);
  assert.throws(() => rejected.replaceText(rejectedKey, 'must be closed'), /绑定尚未载入/);
  rejected.setOnline(false);
  rejected.dispose();

  const disconnectedViews = new Map<string, RegistryView>();
  const disconnectedConflicts: Array<Record<string, unknown>> = [];
  let disconnectedSubmitCount = 0;
  const disconnected = new workspace.CollaborationWorkspaceTextRegistry({
    submit: async () => {
      disconnectedSubmitCount += 1;
      return assert.fail('offline teardown must cancel buffered text, not submit it');
    },
    onView: (key, view) => {
      if (view) disconnectedViews.set(key, view);
      else disconnectedViews.delete(key);
    },
    onConflict: (item) => disconnectedConflicts.push(item),
    createUpdateId: updateIdFactory(450),
    flushDelayMs: 100,
  });
  disconnected.setOnline(true);
  const disconnectedKey = disconnected.open(snapshot, 0).key;
  const cleanTitleKey = disconnected.open(makeSnapshot('title', 'accepted title'), 0).key;
  disconnected.replaceText(disconnectedKey, 'preserve on disconnect');
  disconnected.setOnline(false);
  assert.equal(disconnectedViews.has(disconnectedKey), false);
  assert.equal(disconnectedViews.has(cleanTitleKey), false);
  assert.equal(disconnectedConflicts.length, 1, 'only the field with unaccepted text becomes a recovery item');
  assert.equal(disconnectedConflicts[0].reason, 'offline');
  assert.equal(disconnectedConflicts[0].localText, 'preserve on disconnect');
  assert.throws(
    () => disconnected.replaceText(disconnectedKey, 'no offline queue'),
    /只允许在线编辑/,
  );
  await wait(120);
  assert.equal(disconnectedSubmitCount, 0, 'disconnect never queues or replays the buffered Yjs update');
  assert.equal(disconnectedConflicts.length, 1, 'the copyable recovery item survives the transient gap');
  disconnected.setOnline(true);
  assert.throws(
    () => disconnected.replaceText(disconnectedKey, 'must explicitly reopen'),
    /绑定尚未载入/,
  );
  disconnected.dispose();
});

test('F4 authority snapshot invalidation preserves only unaccepted local text', () => {
  const title = makeSnapshot('title', 'accepted title');
  const prompt = makeSnapshot('prompt', 'accepted prompt');
  const views = new Map<string, RegistryView>();
  const conflicts: Array<Record<string, unknown>> = [];
  const registry = new workspace.CollaborationWorkspaceTextRegistry({
    submit: async () => assert.fail('snapshot invalidation must cancel buffered dispatch'),
    onView: (key, view) => { if (view) views.set(key, view); else views.delete(key); },
    onConflict: (item) => conflicts.push(item),
    createUpdateId: updateIdFactory(475),
    flushDelayMs: 100,
  });
  registry.setOnline(true);
  const titleKey = registry.open(title, 0).key;
  const promptKey = registry.open(prompt, 0).key;
  registry.replaceText(titleKey, 'unaccepted local title');
  registry.invalidateAuthority({ code: 'collaboration_text_revision_conflict' });
  assert.equal(views.has(titleKey), false);
  assert.equal(views.has(promptKey), false);
  assert.equal(conflicts.length, 1, 'clean authoritative Prompt is destroyed without leaking recovery text');
  assert.equal(conflicts[0].reason, 'revision');
  assert.equal(conflicts[0].localText, 'unaccepted local title');
  registry.dispose();
});

test('F4 POST transport accepts only exact 0/1 no-op headers without changing the JSON contract', async () => {
  const snapshot = makeSnapshot('prompt', 'baseline');
  const noOpEnvelope: Envelope = {
    contractVersion: collaborationText.COLLABORATION_TEXT_UPDATE_CONTRACT,
    updateId: updateIdFactory(490)(),
    clientSeq: 4,
    projectId: snapshot.projectId,
    canvasId: snapshot.canvasId,
    baseRevision: snapshot.revision,
    targetType: snapshot.targetType,
    targetEntityUid: snapshot.targetEntityUid,
    bindingEpoch: snapshot.bindingEpoch,
    field: snapshot.field,
    update: updateFromState(snapshot.state, () => undefined),
  };
  const publicResult = mutationResult(snapshot, noOpEnvelope, snapshot.revision);
  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;
  (globalThis as { window?: unknown }).window = globalThis;
  try {
    for (const [header, expected] of [['0', false], ['1', true]] as const) {
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        assert.equal(init?.credentials, 'same-origin');
        return new Response(JSON.stringify({ success: true, data: publicResult }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-T8-Collaboration-Text-Noop': header,
          },
        });
      }) as typeof fetch;
      const submission = await workspace.submitCollaborationTextUpdate(noOpEnvelope, () => undefined);
      assert.equal((submission as any).noOp, expected);
      assert.deepEqual((submission as any).data, publicResult);
      assert.deepEqual(Object.keys((submission as any).data).sort(), [
        'baseRevision',
        'bindingEpoch',
        'canvasId',
        'contractVersion',
        'field',
        'projectId',
        'revision',
        'state',
        'stateVector',
        'targetEntityUid',
        'targetType',
        'text',
        'textDigest',
        'updateId',
        'updatedBy',
      ]);
    }

    for (const value of [null, 'true', '01', '2']) {
      let attempts = 0;
      globalThis.fetch = (async () => {
        attempts += 1;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (value != null) headers['X-T8-Collaboration-Text-Noop'] = value;
        return new Response(JSON.stringify({ success: true, data: publicResult }), {
          status: 200,
          headers,
        });
      }) as typeof fetch;
      await assert.rejects(
        workspace.submitCollaborationTextUpdate(noOpEnvelope, () => undefined),
        (error: any) => error?.code === 'collaboration_text_transport_invalid',
      );
      assert.equal(attempts, 2, 'invalid/missing transport metadata retries the exact request once');
    }
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

test('F4 POST retry reuses the exact envelope once and gateway parsing sanitizes the flat broadcast', async () => {
  const snapshot = makeSnapshot('title');
  const client = collaborationText.CollaborationTextClient.fromBindingSnapshot(snapshot, {
    online: true,
    initialClientSeq: 7,
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(500),
  });
  client.replaceText('retry exact body');
  const envelope = client.flush();
  assert.ok(envelope);
  client.dispose();

  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: unknown; init: RequestInit | undefined }> = [];
  let guards = 0;
  (globalThis as { window?: unknown }).window = globalThis;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url, init });
    throw new TypeError('network vanished');
  }) as typeof fetch;
  try {
    const recoveryGeneration = '11111111-1111-4111-8111-111111111111';
    await assert.rejects(workspace.submitCollaborationTextUpdate(
      envelope,
      () => { guards += 1; },
      { recoveryGeneration },
    ));
    assert.equal(requests.length, 2);
    assert.equal(guards, 2);
    assert.equal(requests[0].init?.body, requests[1].init?.body);
    assert.equal(new Headers(requests[0].init?.headers).get('X-T8-Canvas-Generation'), recoveryGeneration);
    assert.equal(new Headers(requests[1].init?.headers).get('X-T8-Canvas-Generation'), recoveryGeneration);
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), envelope);
    assert.match(String(requests[0].url), /\/text\/updates$/);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }

  const event = workspace.normalizeCollaborationTextGatewayEvent({
    ...makeGatewayEvent(envelope, 2),
    sessionId: 'must-not-enter-envelope',
    materializedText: 'must-not-enter-envelope',
  });
  assert.deepEqual(Object.keys(event.envelope).sort(), [
    'baseRevision',
    'bindingEpoch',
    'canvasId',
    'clientSeq',
    'contractVersion',
    'field',
    'projectId',
    'targetEntityUid',
    'targetType',
    'update',
    'updateId',
  ]);
  assert.throws(() => workspace.normalizeCollaborationTextGatewayEvent({
    ...makeGatewayEvent(envelope, 2),
    clientSeq: undefined,
  }), /clientSeq/);
});

test('F4 mutation response is discarded when its authorization/generation fence changes in flight', async () => {
  const snapshot = makeSnapshot('title');
  const client = collaborationText.CollaborationTextClient.fromBindingSnapshot(snapshot, {
    online: true,
    initialClientSeq: 11,
    flushDelayMs: 100,
    createUpdateId: updateIdFactory(700),
  });
  client.replaceText('must not land after generation change');
  const envelope = client.flush();
  assert.ok(envelope);
  client.dispose();

  const originalWindow = (globalThis as { window?: unknown }).window;
  const originalFetch = globalThis.fetch;
  const recoveryGeneration = '22222222-2222-4222-8222-222222222222';
  let current = true;
  let capturedGeneration = '';
  (globalThis as { window?: unknown }).window = globalThis;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    capturedGeneration = new Headers(init?.headers).get('X-T8-Canvas-Generation') || '';
    current = false;
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-t8-collaboration-text-noop': '0',
      },
    });
  }) as typeof fetch;
  try {
    await assert.rejects(
      workspace.submitCollaborationTextUpdate(
        envelope,
        () => {
          if (!current) {
            throw Object.assign(new Error('stale mutation response'), {
              code: 'collaboration_mutation_scope_changed',
            });
          }
        },
        { recoveryGeneration },
      ),
      (error: any) => error?.code === 'collaboration_mutation_scope_changed',
    );
    assert.equal(capturedGeneration, recoveryGeneration);
  } finally {
    globalThis.fetch = originalFetch;
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

test('F4 recovery generation creates a distinct fail-closed run read scope', () => {
  const identity = {
    id: 'session-a',
    projectId: PROJECT_ID,
    canvasId: CANVAS_ID,
    memberId: 'member-a',
    authorizationEpoch: 7,
  };
  const generationA = '11111111-1111-4111-8111-111111111111';
  const generationB = '22222222-2222-4222-8222-222222222222';
  const scopeA = workspace.collaborationRunScopeKey(identity, generationA);
  const scopeB = workspace.collaborationRunScopeKey(identity, generationB);
  assert.ok(scopeA);
  assert.ok(scopeB);
  assert.notEqual(scopeA, scopeB);
  assert.equal(workspace.collaborationRunScopeKey(identity, null), '');
  assert.equal(workspace.collaborationRunScopeKey(identity, 'not-a-generation'), '');
});

test('F4 latest-request fence rejects an older comment binding that resolves after the newer target', async () => {
  const fence = new workspace.CollaborationLatestRequestFence();
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondResponse = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const applied: string[] = [];
  const first = fence.begin();
  const firstLoad = firstResponse.then(() => {
    if (first.isCurrent()) applied.push('comment-a');
    first.release();
  });
  const second = fence.begin();
  const secondLoad = secondResponse.then(() => {
    if (second.isCurrent()) applied.push('comment-b');
    second.release();
  });

  assert.equal(first.signal.aborted, true, 'opening B aborts the in-flight A request');
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  releaseSecond();
  await secondLoad;
  releaseFirst();
  await firstLoad;
  assert.deepEqual(applied, ['comment-b']);
  assert.equal(second.isCurrent(), false, 'released leases cannot mutate later state');

  const third = fence.begin();
  fence.cancel();
  assert.equal(third.signal.aborted, true);
  assert.equal(third.isCurrent(), false, 'closing the editor invalidates its in-flight request');
});

test('F4 Workspace wiring remains online-only and keeps text outside the F2 move queue', () => {
  assert.match(workspaceSource, /flushDelayMs: 150/);
  assert.match(workspaceSource, /x-t8-text-next-client-seq/);
  assert.match(workspaceSource, /targetEntityUid: descriptor\.targetEntityUid/);
  assert.match(workspaceSource, /message\.type === 'collaboration\.text-update'/);
  assert.match(workspaceSource, /<CollaborationConflictPanel/);
  assert.match(workspaceSource, /data-testid="collaboration-text-node-title"/);
  assert.match(workspaceSource, /data-testid="collaboration-text-node-prompt"/);
  assert.match(reviewPanelSource, /data-testid="collaboration-text-review-body"/);
  assert.match(reviewPanelSource, /safeMemberId\(comment\.createdBy\) === safeMemberId\(memberId\)/);
  const reviewLoadStart = workspaceSource.indexOf('const openReviewCommentBody = useCallback');
  const reviewLoadEnd = workspaceSource.indexOf('\n\n  useEffect(() => {\n    if (!editingReviewTextKey)', reviewLoadStart);
  const reviewLoad = workspaceSource.slice(reviewLoadStart, reviewLoadEnd);
  assert.match(reviewLoad, /reviewTextLoadFenceRef\.current!\.begin\(\)/);
  assert.match(reviewLoad, /loadLease\.isCurrent\(\)/);
  assert.match(reviewLoad, /signal: loadLease\.signal/);
  assert.match(reviewLoad, /loadLease\.release\(\)/);
  const closeReviewStart = workspaceSource.indexOf('const closeReviewCommentBody = useCallback');
  const closeReviewEnd = workspaceSource.indexOf('\n\n  const replaceCollaborativeText', closeReviewStart);
  assert.match(workspaceSource.slice(closeReviewStart, closeReviewEnd), /reviewTextLoadFenceRef\.current\?\.cancel\(\)/);
  assert.doesNotMatch(workspaceSource, /collaborationNodeLabelPatchDraft/);
  const renameStart = workspaceSource.indexOf('const renameSelectedNode = useCallback');
  const renameEnd = workspaceSource.indexOf('\n\n  const restoreDeletedNode', renameStart);
  const rename = workspaceSource.slice(renameStart, renameEnd);
  assert.match(rename, /field: 'title'/);
  assert.match(rename, /textRegistryRef\.current\?\.replaceText\(key, nextTitle\)/);
  assert.doesNotMatch(rename, /submitStructuralOperations|node\.patch|data\.label|dataPatch/);
  assert.match(workspaceSource, /data-testid="collaboration-text-title-prompt"/);
  const textEventStart = workspaceSource.indexOf("if (message.type === 'collaboration.text-update')");
  const textEventEnd = workspaceSource.indexOf("if (message.type === 'subflow.published')", textEventStart);
  const textEventHandler = workspaceSource.slice(textEventStart, textEventEnd);
  assert.match(textEventHandler, /collaborationTextGatewayRevisionAction/);
  assert.match(textEventHandler, /recoveryInFlight: syncTaskRef\.current\?\.scopeGeneration === scopeGeneration/);
  assert.match(textEventHandler, /void recoverCanvas\(normalized\.revision\)/);
  assert.doesNotMatch(textEventHandler, /void loadCanvas\(/);
  const submitStart = workspaceSource.indexOf('async function submitCollaborationTextUpdate');
  const submitEnd = workspaceSource.indexOf('\n\nfunction displayNode', submitStart);
  const submit = workspaceSource.slice(submitStart, submitEnd);
  assert.match(submit, /const body = JSON\.stringify\(normalized\)/);
  assert.match(submit, /attempt < 2/);
  assert.match(submit, /x-t8-collaboration-text-noop/);
  assert.match(submit, /value !== '0' && value !== '1'/);
  assert.doesNotMatch(submit, /sessionStorage|commitOfflineQueue|enqueueCollaborationOperation|saveCollaborationQueue/);
  const registryStart = workspaceSource.indexOf('export class CollaborationWorkspaceTextRegistry');
  const registryEnd = workspaceSource.indexOf('\n\ninterface Session', registryStart);
  const registry = workspaceSource.slice(registryStart, registryEnd);
  assert.doesNotMatch(registry, /sessionStorage|localStorage|indexedDB|commitOfflineQueue/);
  assert.match(registry, /private dispatchTail: Promise<void>/);
  assert.match(registry, /private nextClientSeq: number \| null/);
  assert.match(registry, /if \(submission\.noOp\)/);
  assert.match(registry, /if \(entry\) this\.failEntry\(key, entry, error\)/);
  assert.match(registry, /for \(const \[key, entry\] of \[\.\.\.this\.entries\]\) this\.failEntry/);
  const scopeEffectStart = workspaceSource.indexOf('    const recoveryScope = collaborationTextRecoveryScopeKey(session);');
  const scopeEffectEnd = workspaceSource.indexOf('\n  }, [', scopeEffectStart);
  const scopeEffect = workspaceSource.slice(scopeEffectStart, scopeEffectEnd);
  assert.match(scopeEffect, /textConflictVaultRef\.current\.activate\(recoveryScope\)/);
  assert.doesNotMatch(scopeEffect, /setTextConflicts\(\[\]\)|textDismissedRecoveryIdsRef\.current\.clear/);
  assert.match(workspaceSource, /textScopeRef\.current === renderedTextScope \? textViews : \{\}/);
  assert.match(workspaceSource, /textRecoveryScopeRef\.current === renderedTextRecoveryScope/);
  const moveQueueStart = workspaceSource.indexOf('const sendOperations = useCallback');
  const moveQueueEnd = workspaceSource.indexOf('\n\n  const submitStructuralOperations', moveQueueStart);
  const moveQueue = workspaceSource.slice(moveQueueStart, moveQueueEnd);
  assert.match(moveQueue, /operation\.type !== 'node\.move'/);
  assert.match(moveQueue, /type: 'node\.move'/);
  assert.doesNotMatch(moveQueue, /collaboration\.text-update|text\.update|collaboration-text-noop/);
});
