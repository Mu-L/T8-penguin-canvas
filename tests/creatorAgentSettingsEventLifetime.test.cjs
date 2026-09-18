const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');

const panelPath = path.resolve(__dirname, '../src/components/CreatorAgentPanelV2.tsx');
const panelText = readFileSync(panelPath, 'utf8');
const panel = ts.createSourceFile(panelPath, panelText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Execute the actual JSX handler, not a copied implementation. Keep the updater
// queued until React's event currentTarget would have been cleared.
function providerChangeHandler(setSettingsDraft) {
  const matches = [];
  function visit(node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(panel) === 'select') {
      const attributes = node.attributes.properties;
      const isProvider = attributes.some((attribute) => ts.isJsxAttribute(attribute)
        && attribute.name.getText(panel) === 'ref'
        && attribute.initializer?.getText(panel) === '{settingsFirstSelectRef}');
      if (isProvider) {
        const change = attributes.find((attribute) => ts.isJsxAttribute(attribute)
          && attribute.name.getText(panel) === 'onChange');
        assert.ok(change && ts.isJsxExpression(change.initializer));
        assert.ok(change.initializer.expression);
        matches.push(change.initializer.expression.getText(panel));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(panel);
  assert.equal(matches.length, 1, 'the real provider select must have exactly one handler');
  const javascript = ts.transpileModule(`(${matches[0]})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(javascript, { setSettingsDraft });
}

function draft() {
  return {
    providerId: 'auto',
    llm: { providerId: 'old', modelId: 'chat' },
    image: { providerId: 'old', modelId: 'image' },
    video: { providerId: 'old', modelId: 'video' },
    catalogDigest: 'keep-catalog-identity',
  };
}

test('Creator provider change survives event cleanup before its queued updater runs', () => {
  const pending = [];
  const handler = providerChangeHandler((updater) => pending.push(updater));
  const event = { currentTarget: { value: 'seedance-nz' } };
  handler(event);
  event.currentTarget = null;
  assert.equal(pending.length, 1);
  const previous = draft();
  const next = pending[0](previous);
  assert.equal(next.providerId, 'seedance-nz');
  assert.equal(next.llm, null);
  assert.equal(next.image, null);
  assert.equal(next.video, null);
  assert.equal(next.catalogDigest, previous.catalogDigest);
  assert.equal(previous.providerId, 'auto', 'do not mutate the prior settings');
  assert.notEqual(previous.llm, null);
});

test('Creator queued provider changes use the value captured by each individual event', () => {
  const pending = [];
  const handler = providerChangeHandler((updater) => pending.push(updater));
  const control = { value: 'seedance-nz' };
  const first = { currentTarget: control };
  handler(first);
  first.currentTarget = null;
  control.value = 'zhenzhen';
  const second = { currentTarget: control };
  handler(second);
  second.currentTarget = null;
  control.value = 'later-dom-value';
  assert.equal(pending.length, 2);
  const firstDraft = pending[0](draft());
  assert.equal(firstDraft.providerId, 'seedance-nz');
  assert.equal(pending[1](firstDraft).providerId, 'zhenzhen');
});

test('Creator updater replays are independent from the event and preserve newer state fields', () => {
  const pending = [];
  const handler = providerChangeHandler((updater) => pending.push(updater));
  const event = { currentTarget: { value: 'auto' } };
  handler(event);
  Object.defineProperty(event, 'currentTarget', {
    get() { throw new Error('the finished event must never be read again'); },
  });
  const previous = { ...draft(), catalogDigest: 'newer-catalog-identity' };
  const next = pending[0](previous);
  assert.equal(next.providerId, 'auto');
  assert.equal(next.catalogDigest, 'newer-catalog-identity');
  assert.deepEqual(pending[0](previous), next);
});
