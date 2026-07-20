#!/usr/bin/env node
'use strict';

/**
 * Static ProjectDatabase method classification and writer-policy inventory.
 *
 * This script parses source text only. It deliberately does not require
 * projectDatabase.js, better-sqlite3, backend config, or any runtime service.
 * Complete method classification is not proof that the writer policy, storage
 * capacity, ownership, or recovery boundaries have been implemented.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');

const REPORT_VERSION = 2;
const REPORT_STATUS = 'classification-complete-policy-incomplete';
const DEFAULT_ROOT = path.resolve(__dirname, '..');
const METHOD_CLASSIFICATION_FILE = 'scripts/project-database-method-classification.json';
const METHOD_CLASSIFICATION_VERSION = 1;
const METHOD_CLASSIFICATION_SEMANTICS = 'persistent-side-effect';
const METHOD_CLASSIFICATION_CATEGORIES = Object.freeze([
  'read',
  'write',
  'maintenance',
  'migration',
  'test-only',
]);
const MEMBER_NODE_TYPES = new Set(['MemberExpression', 'OptionalMemberExpression']);
const CALL_NODE_TYPES = new Set(['CallExpression', 'OptionalCallExpression']);
const FUNCTION_NODE_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'ClassMethod',
  'ClassPrivateMethod',
  'ObjectMethod',
]);
const TRANSACTION_INVOCATION_KINDS = new Set(['default', 'deferred', 'immediate', 'exclusive']);
const FILESYSTEM_MUTATION_METHODS = new Set([
  'appendFile', 'appendFileSync', 'chmod', 'chmodSync', 'chown', 'chownSync',
  'copyFile', 'copyFileSync', 'createWriteStream', 'fdatasync', 'fdatasyncSync',
  'fsync', 'fsyncSync', 'link', 'linkSync', 'mkdir', 'mkdirSync', 'open', 'openSync',
  'rename', 'renameSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'symlink',
  'symlinkSync', 'truncate', 'truncateSync', 'unlink', 'unlinkSync', 'write',
  'writeFile', 'writeFileSync', 'writeSync', 'writev', 'writevSync',
]);
const PREPARED_STATEMENT_CHAIN_METHODS = new Set([
  'bind', 'columns', 'expand', 'pluck', 'raw', 'safeIntegers',
]);
const CALL_WRAPPER_METHODS = new Set(['apply', 'bind', 'call']);
const INLINE_COORDINATOR_CALLBACK_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
]);
const ASYNC_BOUNDARY_IDENTIFIERS = new Set([
  'queueMicrotask',
  'setImmediate',
  'setInterval',
  'setTimeout',
]);
const ASYNC_BOUNDARY_MEMBER_METHODS = new Set(['catch', 'finally', 'then']);
const INTERNAL_TRANSACTION_ASSERTION_METHOD = '_assertProjectDatabaseMutationTransaction';
const INTERNAL_TRANSACTION_ASSERTION_CONTEXTS = new Set([
  'coordinator',
  'existing-transaction',
]);

function normalizePath(value) {
  return String(value).replace(/\\/g, '/');
}

function relativePath(root, filename) {
  return normalizePath(path.relative(root, filename));
}

function staticText(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral' || node.type === 'DirectiveLiteral') return node.value;
  if (node.type === 'TemplateLiteral') {
    let value = '';
    for (let index = 0; index < node.quasis.length; index += 1) {
      value += node.quasis[index].value.cooked ?? node.quasis[index].value.raw ?? '';
      if (index < node.expressions.length) value += '${...}';
    }
    return value;
  }
  return null;
}

function propertyName(node) {
  if (!isMemberNode(node)) return null;
  if (!node.computed && (node.property.type === 'Identifier' || node.property.type === 'PrivateName')) {
    return node.property.name || node.property.id?.name || null;
  }
  return staticText(node.property);
}

function isMemberNode(node) {
  return Boolean(node && MEMBER_NODE_TYPES.has(node.type));
}

function isCallNode(node) {
  return Boolean(node && CALL_NODE_TYPES.has(node.type));
}

function memberChain(node) {
  if (!node) return [];
  if (node.type === 'ThisExpression') return ['this'];
  if (node.type === 'Identifier') return [node.name];
  if (!isMemberNode(node)) return [];
  const name = propertyName(node);
  if (!name) return [];
  const prefix = memberChain(node.object);
  return prefix.length > 0 ? [...prefix, name] : [];
}

function parseSource(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const isTypeScript = /\.(?:cts|mts|ts|tsx)$/.test(filename);
  const isJsx = /\.(?:jsx|tsx)$/.test(filename);
  const ast = parser.parse(source, {
    sourceType: 'unambiguous',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    errorRecovery: false,
    plugins: [
      'classProperties',
      'classPrivateProperties',
      'classPrivateMethods',
      'dynamicImport',
      'importMeta',
      'optionalCatchBinding',
      'optionalChaining',
      'topLevelAwait',
      ...(isTypeScript ? ['typescript'] : []),
      ...(isJsx ? ['jsx'] : []),
    ],
  });
  return { source, ast };
}

function walk(node, visitor, ancestors = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  visitor(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if ([
      'start', 'end', 'loc', 'extra', 'errors', 'comments', 'tokens',
      'leadingComments', 'innerComments', 'trailingComments',
    ].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && typeof child.type === 'string') {
          walk(child, visitor, nextAncestors, seen);
        }
      }
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walk(value, visitor, nextAncestors, seen);
    }
  }
}

function parentMap(ast) {
  const parents = new WeakMap();
  walk(ast, (node, ancestors) => {
    if (ancestors.length > 0) parents.set(node, ancestors[ancestors.length - 1]);
  });
  return parents;
}

function containingScope(node, parents) {
  let current = node;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type) || current.type === 'Program') return current;
    current = parents.get(current);
  }
  return null;
}

function exactProjectDatabaseWriteCoordinatorCall(node) {
  return isCallNode(node)
    && isMemberNode(node.callee)
    && memberChain(node.callee).join('.') === 'this.withProjectDatabaseWrite';
}

function exactInternalTransactionAssertionCallee(node) {
  return Boolean(
    node
    && node.type === 'CallExpression'
    && node.optional !== true
    && node.callee?.type === 'MemberExpression'
    && node.callee.optional !== true
    && node.callee.computed === false
    && node.callee.object?.type === 'ThisExpression'
    && node.callee.property?.type === 'Identifier'
    && node.callee.property.name === INTERNAL_TRANSACTION_ASSERTION_METHOD
  );
}

function internalTransactionAssertionInventory(descriptor) {
  const body = descriptor.body?.type === 'BlockStatement' ? descriptor.body : null;
  const firstStatement = body?.body?.[0] || null;
  const firstExpression = firstStatement?.type === 'ExpressionStatement'
    ? firstStatement.expression
    : null;
  const exactCalls = [];
  walk(descriptor.body, (node) => {
    if (exactInternalTransactionAssertionCallee(node)) exactCalls.push(node);
  });
  const firstCallUsesExactCallee = exactInternalTransactionAssertionCallee(firstExpression);
  const argument = firstCallUsesExactCallee && firstExpression.arguments?.length === 1
    ? firstExpression.arguments[0]
    : null;
  const context = argument?.type === 'StringLiteral' ? argument.value : null;
  const failureReasons = [];
  if (descriptor.visibility !== 'internal') failureReasons.push('method-not-internal');
  if (descriptor.async) failureReasons.push('method-async');
  if (!body) failureReasons.push('method-body-not-block');
  if (exactCalls.length === 0) failureReasons.push('exact-assertion-call-missing');
  if (exactCalls.length > 1) failureReasons.push('multiple-exact-assertion-calls');
  if (!firstCallUsesExactCallee) failureReasons.push('assertion-not-first-direct-statement');
  if (firstCallUsesExactCallee && firstExpression.arguments?.length !== 1) {
    failureReasons.push('assertion-argument-count-invalid');
  }
  if (firstCallUsesExactCallee && argument?.type !== 'StringLiteral') {
    failureReasons.push('assertion-context-not-string-literal');
  }
  if (firstCallUsesExactCallee && argument?.type === 'StringLiteral'
    && !INTERNAL_TRANSACTION_ASSERTION_CONTEXTS.has(context)) {
    failureReasons.push('assertion-context-invalid');
  }
  return {
    method: INTERNAL_TRANSACTION_ASSERTION_METHOD,
    allowedContexts: [...INTERNAL_TRANSACTION_ASSERTION_CONTEXTS],
    exactCallCount: exactCalls.length,
    firstStatementLine: firstStatement?.loc?.start?.line || null,
    assertionLine: firstCallUsesExactCallee ? firstExpression.loc?.start?.line || null : null,
    context,
    proven: failureReasons.length === 0,
    failureReasons,
  };
}

function potentialAsyncBoundary(node) {
  if (node?.type === 'NewExpression' && node.callee?.type === 'Identifier'
    && node.callee.name === 'Promise') return 'promise-constructor';
  if (!isCallNode(node)) return null;
  if (node.callee?.type === 'Identifier' && ASYNC_BOUNDARY_IDENTIFIERS.has(node.callee.name)) {
    return node.callee.name;
  }
  const chain = memberChain(node.callee);
  if (chain[0] === 'Promise') return 'promise-static-call';
  if (chain.length === 2 && chain[0] === 'process' && chain[1] === 'nextTick') {
    return 'process.nextTick';
  }
  if (ASYNC_BOUNDARY_MEMBER_METHODS.has(chain.at(-1))) return `promise.${chain.at(-1)}`;
  return null;
}

function inlineCoordinatorCallbackInventory(call) {
  const callback = call.arguments?.[1];
  const inline = Boolean(callback && INLINE_COORDINATOR_CALLBACK_TYPES.has(callback.type));
  const reasons = [];
  const asyncBoundaries = [];
  let nestedFunctionCount = 0;
  let awaitOrYieldCount = 0;
  if (!inline) {
    reasons.push('callback-not-inline');
  } else {
    if (callback.async) reasons.push('callback-async');
    if (callback.generator) reasons.push('callback-generator');
    walk(callback.body, (node) => {
      if (isFunctionNode(node)) nestedFunctionCount += 1;
      if (node.type === 'AwaitExpression' || node.type === 'YieldExpression') awaitOrYieldCount += 1;
      const boundary = potentialAsyncBoundary(node);
      if (boundary) {
        asyncBoundaries.push({
          line: node.loc?.start?.line || callback.loc?.start?.line || call.loc?.start?.line || 0,
          kind: boundary,
        });
      }
    });
    if (nestedFunctionCount > 0) reasons.push('nested-function-boundary');
    if (awaitOrYieldCount > 0) reasons.push('await-or-yield-observed');
    if (asyncBoundaries.length > 0) reasons.push('async-boundary-observed');
  }
  const id = inline ? `${callback.start}:${callback.end}` : null;
  return {
    id,
    line: call.loc?.start?.line || 0,
    callbackLine: callback?.loc?.start?.line || null,
    callbackType: callback?.type || null,
    inline,
    async: Boolean(callback?.async),
    generator: Boolean(callback?.generator),
    nestedFunctionCount,
    awaitOrYieldCount,
    asyncBoundaryCount: asyncBoundaries.length,
    asyncBoundaries,
    eligible: inline && reasons.length === 0,
    reasons,
  };
}

function sourceLine(source, line) {
  return String(source.split(/\r?\n/)[Math.max(0, Number(line) - 1)] || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 260);
}

function isWritePragmaText(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('=')
    || /^(?:wal_checkpoint|incremental_vacuum|optimize)(?:\s|\(|$)/.test(normalized);
}

function isReadOnlyFilesystemOpen(method, call) {
  if (!['open', 'openSync'].includes(method)) return false;
  const flags = staticText(call?.arguments?.[1]);
  return ['r', 'rs', 'sr'].includes(String(flags || '').toLowerCase());
}

function isMutationSqlText(value) {
  const normalized = String(value || '')
    .replace(/--[^\r\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, ' ')
    .replace(/"(?:""|[^"])*"/g, ' ')
    .replace(/`(?:``|[^`])*`/g, ' ')
    .replace(/\[(?:\]\]|[^\]])*\]/g, ' ')
    .trim();
  if (!normalized) return false;
  let depth = 0;
  const topLevelTokens = [];
  for (let index = 0; index < normalized.length;) {
    const character = normalized[index];
    if (character === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (end < normalized.length && /[A-Za-z0-9_]/.test(normalized[end])) end += 1;
      topLevelTokens.push(normalized.slice(index, end).toUpperCase());
      index = end;
      continue;
    }
    index += 1;
  }
  const mutationKeywords = new Set([
    'ALTER', 'ATTACH', 'CREATE', 'DELETE', 'DETACH', 'DROP', 'INSERT',
    'REINDEX', 'REPLACE', 'UPDATE', 'VACUUM',
  ]);
  const first = topLevelTokens[0];
  if (mutationKeywords.has(first)) return true;
  if (first !== 'WITH') return false;
  return topLevelTokens.slice(1).some((token) => mutationKeywords.has(token));
}

function isThisDbCall(node, method) {
  if (!isCallNode(node) || !isMemberNode(node.callee) || propertyName(node.callee) !== method) return false;
  return memberChain(node.callee.object).join('.') === 'this.db';
}

function boundThisMethodName(node) {
  if (!isCallNode(node) || !isMemberNode(node.callee) || propertyName(node.callee) !== 'bind') return null;
  const chain = memberChain(node.callee.object);
  if (chain.length !== 2 || chain[0] !== 'this' || chain[1] === 'db') return null;
  return chain[1];
}

function thisMethodReferenceName(node) {
  const chain = memberChain(node);
  if (chain.length !== 2 || chain[0] !== 'this' || chain[1] === 'db') return null;
  return chain[1];
}

function preparedStatementExpression(node, matchesDb, preparedAlias = () => null) {
  let current = node;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.type === 'Identifier') {
      const alias = preparedAlias(current.name);
      if (alias && typeof alias === 'object') return alias;
      return alias != null ? { sql: alias } : null;
    }
    if (!isCallNode(current) || !isMemberNode(current.callee)) return null;
    const method = propertyName(current.callee);
    if (method === 'prepare' && matchesDb(current.callee.object)) {
      return {
        sql: staticText(current.arguments?.[0]),
        prepareLine: current.loc?.start?.line || null,
      };
    }
    if (!PREPARED_STATEMENT_CHAIN_METHODS.has(method)) return null;
    current = current.callee.object;
  }
  return null;
}

function thisDbHandleMatcher(container) {
  const ownerAliases = new Set(['this']);
  const handleAliases = new Set();
  const matchesOwner = (node) => {
    if (node?.type === 'ThisExpression') return true;
    return node?.type === 'Identifier' && ownerAliases.has(node.name);
  };
  const matchesHandle = (node) => {
    if (node?.type === 'Identifier' && handleAliases.has(node.name)) return true;
    return isMemberNode(node)
      && propertyName(node) === 'db'
      && matchesOwner(node.object);
  };

  let changed = true;
  while (changed) {
    changed = false;
    walk(container, (node) => {
      if (node.type === 'VariableDeclarator') {
        if (node.id.type === 'Identifier') {
          if (matchesOwner(node.init) && !ownerAliases.has(node.id.name)) {
            ownerAliases.add(node.id.name);
            changed = true;
          }
          if (matchesHandle(node.init) && !handleAliases.has(node.id.name)) {
            handleAliases.add(node.id.name);
            changed = true;
          }
        }
        if (node.id.type === 'ObjectPattern' && matchesOwner(node.init)) {
          for (const property of node.id.properties) {
            if (property.type !== 'ObjectProperty') continue;
            const key = property.key?.type === 'Identifier' ? property.key.name : staticText(property.key);
            const value = property.value?.type === 'AssignmentPattern'
              ? property.value.left
              : property.value;
            const local = value?.type === 'Identifier' ? value.name : null;
            if (key === 'db' && local && !handleAliases.has(local)) {
              handleAliases.add(local);
              changed = true;
            }
          }
        }
      }
      if (node.type !== 'AssignmentExpression' || node.left.type !== 'Identifier') return;
      if (matchesOwner(node.right) && !ownerAliases.has(node.left.name)) {
        ownerAliases.add(node.left.name);
        changed = true;
      }
      if (matchesHandle(node.right) && !handleAliases.has(node.left.name)) {
        handleAliases.add(node.left.name);
        changed = true;
      }
    });
  }
  return matchesHandle;
}

function isFsRequireCall(node) {
  return isCallNode(node)
    && node.callee?.type === 'Identifier'
    && node.callee.name === 'require'
    && ['fs', 'node:fs'].includes(staticText(node.arguments?.[0]));
}

function filesystemMutationAliasInventory(containers) {
  const roots = Array.isArray(containers) ? containers : [containers];
  const walkRoots = (visitor) => {
    for (const root of roots) walk(root, visitor);
  };
  const objectAliases = new Set(['fs']);
  const functionAliases = new Map();
  const matchesObject = (node) => {
    if (isFsRequireCall(node)) return true;
    const chain = memberChain(node);
    if (chain.length === 0 || !objectAliases.has(chain[0])) return false;
    return chain.slice(1).every((part) => part === 'promises');
  };
  const mutationMember = (node) => {
    if (!isMemberNode(node) || !matchesObject(node.object)) return null;
    const method = propertyName(node);
    return FILESYSTEM_MUTATION_METHODS.has(method) ? method : null;
  };

  walkRoots((node) => {
    if (node.type !== 'ImportDeclaration' || !['fs', 'node:fs'].includes(staticText(node.source))) return;
    for (const specifier of node.specifiers || []) {
      if (specifier.type === 'ImportDefaultSpecifier' || specifier.type === 'ImportNamespaceSpecifier') {
        objectAliases.add(specifier.local.name);
        continue;
      }
      const imported = specifier.imported?.type === 'Identifier'
        ? specifier.imported.name
        : staticText(specifier.imported);
      if (imported === 'promises') objectAliases.add(specifier.local.name);
      if (FILESYSTEM_MUTATION_METHODS.has(imported)) functionAliases.set(specifier.local.name, imported);
    }
  });

  let changed = true;
  while (changed) {
    changed = false;
    walkRoots((node) => {
      if (node.type === 'VariableDeclarator') {
        if (node.id.type === 'Identifier') {
          if (matchesObject(node.init) && !objectAliases.has(node.id.name)) {
            objectAliases.add(node.id.name);
            changed = true;
          }
          const method = mutationMember(node.init);
          if (method && functionAliases.get(node.id.name) !== method) {
            functionAliases.set(node.id.name, method);
            changed = true;
          }
          if (node.init?.type === 'Identifier' && functionAliases.has(node.init.name)
            && functionAliases.get(node.id.name) !== functionAliases.get(node.init.name)) {
            functionAliases.set(node.id.name, functionAliases.get(node.init.name));
            changed = true;
          }
        }
        if (node.id.type === 'ObjectPattern' && matchesObject(node.init)) {
          for (const property of node.id.properties) {
            if (property.type !== 'ObjectProperty') continue;
            const key = property.key?.type === 'Identifier' ? property.key.name : staticText(property.key);
            const value = property.value?.type === 'AssignmentPattern'
              ? property.value.left
              : property.value;
            const local = value?.type === 'Identifier' ? value.name : null;
            if (!local) continue;
            if (key === 'promises' && !objectAliases.has(local)) {
              objectAliases.add(local);
              changed = true;
            }
            if (FILESYSTEM_MUTATION_METHODS.has(key) && functionAliases.get(local) !== key) {
              functionAliases.set(local, key);
              changed = true;
            }
          }
        }
      }
      if (node.type !== 'AssignmentExpression' || node.left.type !== 'Identifier') return;
      if (matchesObject(node.right) && !objectAliases.has(node.left.name)) {
        objectAliases.add(node.left.name);
        changed = true;
      }
      const method = mutationMember(node.right);
      if (method && functionAliases.get(node.left.name) !== method) {
        functionAliases.set(node.left.name, method);
        changed = true;
      }
      if (node.right?.type === 'Identifier' && functionAliases.has(node.right.name)
        && functionAliases.get(node.left.name) !== functionAliases.get(node.right.name)) {
        functionAliases.set(node.left.name, functionAliases.get(node.right.name));
        changed = true;
      }
    });
  }

  return {
    mutationCall(node) {
      if (!isCallNode(node)) return null;
      if (node.callee?.type === 'Identifier') return functionAliases.get(node.callee.name) || null;
      return mutationMember(node.callee);
    },
  };
}

function projectDatabaseMethodAliasMap(container) {
  const aliases = new Map();
  const referencedMethod = (node) => {
    return thisMethodReferenceName(node) || boundThisMethodName(node);
  };
  let changed = true;
  while (changed) {
    changed = false;
    walk(container, (node) => {
      if (node.type !== 'VariableDeclarator' && node.type !== 'AssignmentExpression') return;
      const left = node.type === 'VariableDeclarator' ? node.id : node.left;
      const right = node.type === 'VariableDeclarator' ? node.init : node.right;
      if (left?.type !== 'Identifier') return;
      const target = referencedMethod(right)
        || (right?.type === 'Identifier' ? aliases.get(right.name) : null);
      if (target && aliases.get(left.name) !== target) {
        aliases.set(left.name, target);
        changed = true;
      }
    });
  }
  return aliases;
}

function transactionInvocationKinds(factory, parents, container) {
  const kinds = new Set();
  const parent = parents.get(factory);
  const grandparent = parent ? parents.get(parent) : null;
  let alias = null;

  if (parent?.type === 'VariableDeclarator' && parent.init === factory && parent.id.type === 'Identifier') {
    alias = parent.id.name;
  }
  if (isMemberNode(parent) && parent.object === factory && isCallNode(grandparent) && grandparent.callee === parent) {
    const kind = propertyName(parent);
    if (TRANSACTION_INVOCATION_KINDS.has(kind)) kinds.add(kind);
  }
  if (isCallNode(parent) && parent.callee === factory) kinds.add('default');

  if (alias && container) {
    walk(container, (node) => {
      if (!isCallNode(node)) return;
      if (node.callee.type === 'Identifier' && node.callee.name === alias) {
        kinds.add('default');
        return;
      }
      if (isMemberNode(node.callee)
        && node.callee.object?.type === 'Identifier'
        && node.callee.object.name === alias) {
        const kind = propertyName(node.callee);
        if (TRANSACTION_INVOCATION_KINDS.has(kind)) kinds.add(kind);
      }
    });
  }

  if (kinds.size === 0) kinds.add('factory-only');
  return [...kinds].sort();
}

function projectDatabaseMethodName(method) {
  if (method.kind === 'constructor') return 'constructor';
  if (method.key?.type === 'Identifier' || method.key?.type === 'PrivateName') {
    return method.key.name || method.key.id?.name || '<private>';
  }
  return staticText(method.key) || '<computed>';
}

function findProjectDatabaseClass(ast) {
  let match = null;
  walk(ast, (node) => {
    if (!match && node.type === 'ClassDeclaration' && node.id?.name === 'ProjectDatabase') match = node;
  });
  if (!match) throw new Error('ProjectDatabase class declaration was not found');
  return match;
}

function classPropertyName(member) {
  if (member.key?.type === 'Identifier' || member.key?.type === 'PrivateName') {
    return member.key.name || member.key.id?.name || '<private>';
  }
  return staticText(member.key) || `<computed@${member.loc?.start?.line || 0}>`;
}

function isFunctionNode(node) {
  return Boolean(node && FUNCTION_NODE_TYPES.has(node.type));
}

function projectDatabaseCallableMembers(ast, projectDatabaseClass) {
  const members = [];
  for (const member of projectDatabaseClass.body.body) {
    if (['ClassMethod', 'ClassPrivateMethod'].includes(member.type)) {
      const name = projectDatabaseMethodName(member);
      members.push({
        node: member,
        body: member.body,
        name,
        visibility: member.type === 'ClassPrivateMethod' || name.startsWith('_')
          ? 'internal'
          : 'public',
        kind: member.kind || 'method',
        async: Boolean(member.async),
        definitionResolved: name !== '<computed>',
        seedCalledMethods: [],
      });
      continue;
    }
    if (!['ClassProperty', 'ClassPrivateProperty'].includes(member.type)) continue;
    const isFieldFunction = isFunctionNode(member.value);
    const aliasedMethod = thisMethodReferenceName(member.value) || boundThisMethodName(member.value);
    if (!isFieldFunction && !aliasedMethod) continue;
    const name = classPropertyName(member);
    members.push({
      node: member,
      body: isFieldFunction ? (member.value.body || member.value) : member.value,
      name,
      visibility: member.type === 'ClassPrivateProperty' || name.startsWith('_') ? 'internal' : 'public',
      kind: isFieldFunction
        ? 'field-function'
        : boundThisMethodName(member.value)
          ? 'field-bound-method'
          : 'field-method-alias',
      async: Boolean(member.value.async),
      definitionResolved: !name.startsWith('<computed@'),
      seedCalledMethods: aliasedMethod ? [aliasedMethod] : [],
    });
  }

  const projectDatabaseClassAliases = new Set(['ProjectDatabase']);
  const prototypeAliases = new Set(['ProjectDatabase.prototype']);
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    for (const alias of projectDatabaseClassAliases) {
      const prototypeAlias = `${alias}.prototype`;
      if (!prototypeAliases.has(prototypeAlias)) {
        prototypeAliases.add(prototypeAlias);
        aliasesChanged = true;
      }
    }
    walk(ast, (node) => {
      if (node.type === 'VariableDeclarator'
        && node.id.type === 'Identifier'
        && node.init?.type === 'Identifier'
        && projectDatabaseClassAliases.has(node.init.name)
        && !projectDatabaseClassAliases.has(node.id.name)) {
        projectDatabaseClassAliases.add(node.id.name);
        aliasesChanged = true;
      }
      if (node.type === 'VariableDeclarator'
        && node.id.type === 'ObjectPattern'
        && node.init?.type === 'Identifier'
        && projectDatabaseClassAliases.has(node.init.name)) {
        for (const property of node.id.properties) {
          if (property.type !== 'ObjectProperty') continue;
          const key = property.key?.type === 'Identifier' ? property.key.name : staticText(property.key);
          const value = property.value?.type === 'AssignmentPattern'
            ? property.value.left
            : property.value;
          const local = value?.type === 'Identifier' ? value.name : null;
          if (key === 'prototype' && local && !prototypeAliases.has(local)) {
            prototypeAliases.add(local);
            aliasesChanged = true;
          }
        }
      }
      if (node.type === 'AssignmentExpression'
        && node.left.type === 'ObjectPattern'
        && node.right?.type === 'Identifier'
        && projectDatabaseClassAliases.has(node.right.name)) {
        for (const property of node.left.properties) {
          if (property.type !== 'ObjectProperty') continue;
          const key = property.key?.type === 'Identifier' ? property.key.name : staticText(property.key);
          const value = property.value?.type === 'AssignmentPattern'
            ? property.value.left
            : property.value;
          const local = value?.type === 'Identifier' ? value.name : null;
          if (key === 'prototype' && local && !prototypeAliases.has(local)) {
            prototypeAliases.add(local);
            aliasesChanged = true;
          }
        }
      }
      if (node.type === 'VariableDeclarator'
        && node.id.type === 'Identifier'
        && prototypeAliases.has(memberChain(node.init).join('.'))
        && !prototypeAliases.has(node.id.name)) {
        prototypeAliases.add(node.id.name);
        aliasesChanged = true;
      }
      if (node.type === 'AssignmentExpression'
        && node.left.type === 'Identifier'
        && node.right.type === 'Identifier'
        && projectDatabaseClassAliases.has(node.right.name)
        && !projectDatabaseClassAliases.has(node.left.name)) {
        projectDatabaseClassAliases.add(node.left.name);
        aliasesChanged = true;
      }
      if (node.type === 'AssignmentExpression'
        && node.left.type === 'Identifier'
        && prototypeAliases.has(memberChain(node.right).join('.'))
        && !prototypeAliases.has(node.left.name)) {
        prototypeAliases.add(node.left.name);
        aliasesChanged = true;
      }
    });
  }
  const isProjectDatabasePrototype = (node) => prototypeAliases.has(memberChain(node).join('.'));
  const prototypeMutationCallAliases = new Map();
  const prototypeMutationKinds = (node) => {
    const chain = memberChain(node).join('.');
    if (chain === 'Object.assign') return new Set(['assign']);
    if (chain === 'Object.defineProperties') return new Set(['defineProperties']);
    if (chain === 'Object.defineProperty' || chain === 'Reflect.defineProperty') {
      return new Set(['defineProperty']);
    }
    if (isCallNode(node)
      && isMemberNode(node.callee)
      && propertyName(node.callee) === 'bind') {
      return prototypeMutationKinds(node.callee.object);
    }
    return node?.type === 'Identifier'
      ? new Set(prototypeMutationCallAliases.get(node.name) || [])
      : new Set();
  };
  const directPrototypeMutationKind = (node) => {
    const kinds = [...prototypeMutationKinds(node)].sort();
    return kinds.length === 1 ? kinds[0] : kinds.length > 1 ? 'dynamic' : null;
  };
  let mutationAliasesChanged = true;
  while (mutationAliasesChanged) {
    mutationAliasesChanged = false;
    walk(ast, (node) => {
      if (node.type === 'VariableDeclarator' || node.type === 'AssignmentExpression') {
        const left = node.type === 'VariableDeclarator' ? node.id : node.left;
        const right = node.type === 'VariableDeclarator' ? node.init : node.right;
        if (left?.type === 'Identifier') {
          const target = prototypeMutationCallAliases.get(left.name) || new Set();
          for (const kind of prototypeMutationKinds(right)) {
            if (target.has(kind)) continue;
            target.add(kind);
            mutationAliasesChanged = true;
          }
          if (target.size > 0) prototypeMutationCallAliases.set(left.name, target);
        }
        if (left?.type === 'ObjectPattern') {
          const owner = memberChain(right).join('.');
          if (!['Object', 'Reflect'].includes(owner)) return;
          for (const property of left.properties) {
            if (property.type !== 'ObjectProperty') continue;
            const key = property.key?.type === 'Identifier' ? property.key.name : staticText(property.key);
            const value = property.value?.type === 'AssignmentPattern'
              ? property.value.left
              : property.value;
            const local = value?.type === 'Identifier' ? value.name : null;
            const kind = key === 'assign' && owner === 'Object'
              ? 'assign'
              : key === 'defineProperties' && owner === 'Object'
                ? 'defineProperties'
                : key === 'defineProperty'
                  ? 'defineProperty'
                  : null;
            if (kind && local) {
              const target = prototypeMutationCallAliases.get(local) || new Set();
              if (!target.has(kind)) {
                target.add(kind);
                prototypeMutationCallAliases.set(local, target);
                mutationAliasesChanged = true;
              }
            }
          }
        }
      }
    });
  }
  const prototypeMutationInvocation = (node) => {
    if (!isCallNode(node)) return null;
    let target = node.callee;
    let args = node.arguments || [];
    let argumentsResolved = true;
    if (isMemberNode(target) && ['apply', 'call'].includes(propertyName(target))) {
      const wrapper = propertyName(target);
      target = target.object;
      if (wrapper === 'call') {
        args = args.slice(1);
      } else if (args[1]?.type === 'ArrayExpression') {
        args = args[1].elements.filter(Boolean);
      } else {
        args = [];
        argumentsResolved = false;
      }
    }
    const kind = directPrototypeMutationKind(target);
    return kind ? { kind, args, argumentsResolved } : null;
  };
  const prototypeMethodReference = (node) => {
    if (isMemberNode(node) && isProjectDatabasePrototype(node.object)) {
      return propertyName(node);
    }
    if (isCallNode(node) && isMemberNode(node.callee) && propertyName(node.callee) === 'bind') {
      const target = node.callee.object;
      if (isMemberNode(target) && isProjectDatabasePrototype(target.object)) return propertyName(target);
    }
    return null;
  };
  const valueDefinition = (value) => {
    const dependency = prototypeMethodReference(value);
    return {
      body: isFunctionNode(value) ? (value.body || value) : value,
      async: Boolean(value?.async),
      definitionResolved: isFunctionNode(value) || Boolean(dependency),
      seedCalledMethods: dependency ? [dependency] : [],
    };
  };
  const descriptorValue = (descriptorNode) => {
    if (descriptorNode?.type !== 'ObjectExpression') return { value: null, resolved: false };
    let value = null;
    let hasValue = false;
    let resolved = true;
    for (const property of descriptorNode.properties) {
      if (property.type === 'SpreadElement') {
        resolved = false;
        continue;
      }
      if (!['ObjectMethod', 'ObjectProperty'].includes(property.type)) {
        resolved = false;
        continue;
      }
      const key = property.key?.type === 'Identifier' ? property.key.name : staticText(property.key);
      if (!key) {
        resolved = false;
        continue;
      }
      if (property.type === 'ObjectMethod' && property.kind !== 'method') resolved = false;
      if (key === 'get' || key === 'set') resolved = false;
      if (key === 'value') {
        value = property.type === 'ObjectMethod' ? property : property.value;
        hasValue = true;
      }
    }
    return { value, resolved: resolved && hasValue };
  };
  const pushPrototypeMember = ({ node, body, name, kind, definitionResolved, seedCalledMethods, async }) => {
    members.push({
      node,
      body: body || node,
      name,
      visibility: name.startsWith('_') ? 'internal' : 'public',
      kind,
      async: Boolean(async),
      definitionResolved: Boolean(definitionResolved),
      seedCalledMethods: seedCalledMethods || [],
    });
  };

  walk(ast, (node) => {
    if (node.type === 'AssignmentExpression' && isMemberNode(node.left)) {
      if (!isProjectDatabasePrototype(node.left.object)) return;
      const staticName = propertyName(node.left);
      const name = staticName || `<computed-prototype@${node.loc?.start?.line || 0}>`;
      const definition = valueDefinition(node.right);
      pushPrototypeMember({
        node,
        name,
        kind: 'prototype-assignment',
        ...definition,
        definitionResolved: Boolean(staticName) && definition.definitionResolved,
      });
      return;
    }
    const invocation = prototypeMutationInvocation(node);
    if (!invocation) return;
    const mutationKind = invocation.kind;
    if (!invocation.argumentsResolved || mutationKind === 'dynamic') {
      pushPrototypeMember({
        node,
        body: node,
        name: `<dynamic-prototype-mutation@${node.loc?.start?.line || 0}>`,
        kind: 'prototype-dynamic-mutation',
        definitionResolved: false,
        seedCalledMethods: [],
        async: false,
      });
      return;
    }
    if (!isProjectDatabasePrototype(invocation.args?.[0])) return;
    if (mutationKind === 'defineProperty') {
      const staticName = staticText(invocation.args?.[1]);
      const name = staticName || `<dynamic-define-property@${node.loc?.start?.line || 0}>`;
      const descriptor = descriptorValue(invocation.args?.[2]);
      const definition = valueDefinition(descriptor.value);
      pushPrototypeMember({
        node,
        name,
        kind: 'prototype-define-property',
        ...definition,
        definitionResolved: Boolean(staticName) && descriptor.resolved && definition.definitionResolved,
      });
      return;
    }
    if (mutationKind === 'defineProperties') {
      const descriptors = invocation.args?.[1];
      if (descriptors?.type !== 'ObjectExpression') {
        pushPrototypeMember({
          node: descriptors || node,
          body: descriptors || node,
          name: `<dynamic-define-properties@${node.loc?.start?.line || 0}>`,
          kind: 'prototype-define-properties',
          definitionResolved: false,
          seedCalledMethods: [],
          async: false,
        });
        return;
      }
      for (const property of descriptors.properties) {
        if (property.type === 'SpreadElement') {
          pushPrototypeMember({
            node: property,
            body: property.argument,
            name: `<dynamic-define-properties-spread@${property.loc?.start?.line || 0}>`,
            kind: 'prototype-define-properties',
            definitionResolved: false,
            seedCalledMethods: [],
            async: false,
          });
          continue;
        }
        if (property.type !== 'ObjectProperty') continue;
        const staticName = property.key?.type === 'Identifier'
          ? property.key.name
          : staticText(property.key);
        const name = staticName || `<computed-define-properties@${property.loc?.start?.line || 0}>`;
        const descriptor = descriptorValue(property.value);
        const definition = valueDefinition(descriptor.value);
        pushPrototypeMember({
          node: property,
          name,
          kind: 'prototype-define-properties',
          ...definition,
          definitionResolved: Boolean(staticName) && descriptor.resolved && definition.definitionResolved,
        });
      }
      return;
    }
    if (mutationKind !== 'assign') return;
    const appendObjectSource = (sourceNode, sourceIndex, seenSources = new Set()) => {
      const sourceObject = sourceNode?.type === 'ObjectExpression' ? sourceNode : null;
      if (!sourceObject || seenSources.has(sourceObject)) {
        pushPrototypeMember({
          node: sourceNode || node,
          body: sourceNode || node,
          name: `<dynamic-prototype-assign@${node.loc?.start?.line || 0}:${sourceIndex}>`,
          kind: 'prototype-object-assign',
          definitionResolved: false,
          seedCalledMethods: [],
          async: false,
        });
        return;
      }
      const nextSeen = new Set(seenSources);
      nextSeen.add(sourceObject);
      for (const property of sourceObject.properties) {
        if (property.type === 'SpreadElement') {
          appendObjectSource(property.argument, `${sourceIndex}:spread`, nextSeen);
          continue;
        }
        if (!['ObjectMethod', 'ObjectProperty'].includes(property.type)) continue;
        const staticName = property.key?.type === 'Identifier'
          ? property.key.name
          : staticText(property.key);
        const name = staticName || `<computed-object-method@${property.loc?.start?.line || 0}>`;
        const value = property.type === 'ObjectMethod' ? property : property.value;
        const definition = valueDefinition(value);
        pushPrototypeMember({
          node: property,
          name,
          kind: 'prototype-object-assign',
          ...definition,
          definitionResolved: Boolean(staticName)
            && property.kind !== 'get'
            && property.kind !== 'set'
            && definition.definitionResolved,
        });
      }
    };
    for (let sourceIndex = 1; sourceIndex < invocation.args.length; sourceIndex += 1) {
      appendObjectSource(invocation.args[sourceIndex], sourceIndex);
    }
  });

  return members.sort((left, right) => (
    (left.node.loc?.start?.line || 0) - (right.node.loc?.start?.line || 0)
    || left.name.localeCompare(right.name)
  ));
}

function inventoryProjectDatabase(root) {
  const filename = path.join(root, 'backend', 'src', 'services', 'projectDatabase.js');
  const { source, ast } = parseSource(filename);
  const parents = parentMap(ast);
  const projectDatabaseClass = findProjectDatabaseClass(ast);
  const moduleAliasRoots = ast.program.body.filter((node) => (
    node.type === 'ImportDeclaration' || node.type === 'VariableDeclaration'
  ));
  const methods = [];

  for (const descriptor of projectDatabaseCallableMembers(ast, projectDatabaseClass)) {
    const method = descriptor.node;
    const name = descriptor.name;
    const internalTransactionAssertion = internalTransactionAssertionInventory(descriptor);
    const runCalls = [];
    const execCalls = [];
    const backupCalls = [];
    const writePragmas = [];
    const filesystemMutationCalls = [];
    const mutationQueryCalls = [];
    const transactionFactories = [];
    const storageCapacityTranslations = [];
    const calledMethods = new Set(descriptor.seedCalledMethods || []);
    const calledMethodSites = [];
    const calledMethodSiteKeys = new Set();
    const databaseEffectSites = [];
    const dynamicProjectDatabaseCalls = [];
    const preparedSqlAliases = new Map();
    const matchesThisDb = thisDbHandleMatcher(descriptor.body);
    const filesystemAliases = filesystemMutationAliasInventory([...moduleAliasRoots, descriptor.body]);
    const methodAliases = projectDatabaseMethodAliasMap(descriptor.body);
    const coordinatorCalls = [];
    const inlineCoordinatorCallbacks = new Map();
    walk(descriptor.body, (node) => {
      if (!exactProjectDatabaseWriteCoordinatorCall(node)) return;
      const inventory = inlineCoordinatorCallbackInventory(node);
      coordinatorCalls.push(inventory);
      const callback = node.arguments?.[1];
      if (inventory.inline) inlineCoordinatorCallbacks.set(callback, inventory);
    });
    const callbackIdForSite = (node) => (
      inlineCoordinatorCallbacks.get(containingScope(node, parents))?.id || null
    );
    const recordDatabaseEffect = (kind, node, details = {}) => {
      databaseEffectSites.push({
        kind,
        line: node.loc?.start?.line || method.loc.start.line,
        callbackId: callbackIdForSite(node),
        ...details,
      });
    };
    const recordCalledMethod = (calledName, node) => {
      if (!calledName) return;
      calledMethods.add(calledName);
      const key = `${node.start}:${node.end}:${calledName}`;
      if (calledMethodSiteKeys.has(key)) return;
      calledMethodSiteKeys.add(key);
      calledMethodSites.push({
        name: calledName,
        line: node.loc?.start?.line || method.loc.start.line,
        callbackId: callbackIdForSite(node),
      });
    };
    const preparedAlias = (name) => {
      const values = [...(preparedSqlAliases.get(name) || [])].sort();
      if (values.length === 0) return null;
      return { sql: values.find((value) => isMutationSqlText(value)) ?? values[0] };
    };

    let preparedAliasesChanged = true;
    while (preparedAliasesChanged) {
      preparedAliasesChanged = false;
      walk(descriptor.body, (node) => {
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier') return;
        const prepared = preparedStatementExpression(node.init, matchesThisDb, preparedAlias);
        const sqlValues = new Set();
        if (prepared?.sql != null) sqlValues.add(prepared.sql);
        if (node.init?.type === 'Identifier') {
          for (const sql of preparedSqlAliases.get(node.init.name) || []) sqlValues.add(sql);
        }
        const target = preparedSqlAliases.get(node.id.name) || new Set();
        for (const sql of sqlValues) {
          if (target.has(sql)) continue;
          target.add(sql);
          preparedAliasesChanged = true;
        }
        if (target.size > 0) preparedSqlAliases.set(node.id.name, target);
      });
    }

    walk(descriptor.body, (node) => {
      if (!isCallNode(node)) return;
      if (node.callee?.type === 'Identifier'
        && node.callee.name === 'translateProjectDatabaseStorageCapacityError') {
        const line = node.loc?.start?.line || method.loc.start.line;
        storageCapacityTranslations.push({ line, snippet: sourceLine(source, line) });
      }
      const line = node.loc?.start?.line || method.loc.start.line;
      const filesystemMutation = filesystemAliases.mutationCall(node);
      if (filesystemMutation && !isReadOnlyFilesystemOpen(filesystemMutation, node)) {
        filesystemMutationCalls.push({
          line,
          method: filesystemMutation,
          snippet: sourceLine(source, line),
        });
      }
      if (node.callee?.type === 'Identifier' && methodAliases.has(node.callee.name)) {
        recordCalledMethod(methodAliases.get(node.callee.name), node);
      }
      if (!isMemberNode(node.callee)) return;
      const property = propertyName(node.callee);
      const chain = memberChain(node.callee);
      if (node.callee.object?.type === 'ThisExpression' && node.callee.computed && !property) {
        dynamicProjectDatabaseCalls.push({ line, snippet: sourceLine(source, line) });
      }
      if (property === 'run') {
        runCalls.push({ line, snippet: sourceLine(source, line) });
        recordDatabaseEffect('run', node);
      }
      if (property === 'exec') {
        execCalls.push({ line, snippet: sourceLine(source, line) });
        recordDatabaseEffect('exec', node);
      }
      if (property === 'backup') backupCalls.push({ line, snippet: sourceLine(source, line) });
      if (property === 'pragma') {
        const pragma = staticText(node.arguments?.[0]);
        if (isWritePragmaText(pragma)) {
          writePragmas.push({ line, pragma, snippet: sourceLine(source, line) });
          recordDatabaseEffect('write-pragma', node, { pragma });
        }
      }
      if (['all', 'get', 'iterate'].includes(property)) {
        const receiver = node.callee.object;
        const directPrepared = preparedStatementExpression(receiver, matchesThisDb, preparedAlias);
        const sql = directPrepared?.sql
          ?? (receiver?.type === 'Identifier' ? preparedAlias(receiver.name)?.sql : null);
        if (isMutationSqlText(sql)) {
          mutationQueryCalls.push({
            line,
            method: property,
            sql,
            snippet: sourceLine(source, line),
          });
          recordDatabaseEffect('mutation-query', node, { method: property, sql });
        }
      }
      if (property === 'transaction' && matchesThisDb(node.callee.object)) {
        transactionFactories.push({
          line,
          invocationTypes: transactionInvocationKinds(node, parents, method),
          snippet: sourceLine(source, line),
        });
      }
      if (chain.length === 2 && chain[0] === 'this' && chain[1] !== 'db') {
        recordCalledMethod(chain[1], node);
      }
      if (chain.length === 3
        && chain[0] === 'this'
        && chain[1] !== 'db'
        && ['apply', 'call'].includes(chain[2])) {
        recordCalledMethod(chain[1], node);
      }
      if (chain.length === 2
        && node.callee.object?.type === 'Identifier'
        && methodAliases.has(node.callee.object.name)
        && ['apply', 'call'].includes(chain[1])) {
        recordCalledMethod(methodAliases.get(node.callee.object.name), node);
      }
    });

    const transactionTypes = [...new Set(transactionFactories.flatMap((entry) => entry.invocationTypes))].sort();
    methods.push({
      name,
      line: method.loc.start.line,
      endLine: method.loc.end.line,
      visibility: descriptor.visibility,
      kind: descriptor.kind,
      async: descriptor.async,
      definitionResolved: descriptor.definitionResolved !== false,
      internalTransactionAssertion,
      direct: {
        runCount: runCalls.length,
        runCalls,
        execCount: execCalls.length,
        execCalls,
        writePragmaCount: writePragmas.length,
        writePragmas,
        filesystemMutationCount: filesystemMutationCalls.length,
        filesystemMutationCalls,
        mutationQueryCount: mutationQueryCalls.length,
        mutationQueryCalls,
        backupCount: backupCalls.length,
        backupCalls,
        transactionFactoryCount: transactionFactories.length,
        transactionFactories,
        transactionTypes,
        storageCapacityTranslationCount: storageCapacityTranslations.length,
        storageCapacityTranslations,
        databaseEffectCount: databaseEffectSites.length,
        databaseEffectSites,
        coordinatorCallCount: coordinatorCalls.length,
        coordinatorCalls,
        dynamicProjectDatabaseCallCount: dynamicProjectDatabaseCalls.length,
        dynamicProjectDatabaseCalls,
      },
      hasDirectSqlMutationCandidate: runCalls.length + execCalls.length
        + writePragmas.length + mutationQueryCalls.length > 0,
      hasDirectPersistentMutationCandidate: runCalls.length + execCalls.length
        + writePragmas.length + mutationQueryCalls.length
        + filesystemMutationCalls.length + backupCalls.length > 0,
      calledProjectDatabaseMethods: [...calledMethods].sort(),
      calledProjectDatabaseMethodCallCount: calledMethodSites.length,
      calledProjectDatabaseMethodCalls: calledMethodSites,
    });
  }

  methods.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
  return {
    file: relativePath(root, filename),
    className: 'ProjectDatabase',
    methodCount: methods.length,
    methods,
  };
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function issueSort(left, right) {
  return String(left.code || '').localeCompare(String(right.code || ''))
    || String(left.category || '').localeCompare(String(right.category || ''))
    || String(left.name || '').localeCompare(String(right.name || ''));
}

function loadProjectDatabaseMethodClassification(root) {
  const filename = path.join(root, ...METHOD_CLASSIFICATION_FILE.split('/'));
  const source = fs.readFileSync(filename, 'utf8');
  return {
    filename,
    file: relativePath(root, filename),
    sha256: sha256Text(source),
    manifest: JSON.parse(source),
  };
}

function classifyProjectDatabaseMethods(projectDatabase, loadedManifest) {
  const issues = [];
  const manifest = loadedManifest?.manifest || loadedManifest || {};
  const manifestFile = loadedManifest?.file || METHOD_CLASSIFICATION_FILE;
  const manifestSha256 = loadedManifest?.sha256 || sha256Text(JSON.stringify(manifest));
  const sourceNames = projectDatabase.methods.map((method) => method.name);
  const sourceCounts = new Map();
  for (const name of sourceNames) sourceCounts.set(name, (sourceCounts.get(name) || 0) + 1);
  for (const [name, count] of sourceCounts) {
    if (count > 1) issues.push({ code: 'duplicate-source-method', name, count });
  }

  if (manifest.manifestVersion !== METHOD_CLASSIFICATION_VERSION) {
    issues.push({
      code: 'manifest-version-mismatch',
      expected: METHOD_CLASSIFICATION_VERSION,
      actual: manifest.manifestVersion ?? null,
    });
  }
  if (manifest.sourceFile !== projectDatabase.file) {
    issues.push({
      code: 'manifest-source-mismatch',
      expected: projectDatabase.file,
      actual: manifest.sourceFile ?? null,
    });
  }
  if (manifest.classificationSemantics !== METHOD_CLASSIFICATION_SEMANTICS) {
    issues.push({
      code: 'manifest-semantics-mismatch',
      expected: METHOD_CLASSIFICATION_SEMANTICS,
      actual: manifest.classificationSemantics ?? null,
    });
  }

  const categories = manifest.categories && typeof manifest.categories === 'object'
    ? manifest.categories
    : {};
  const unexpectedCategories = Object.keys(categories)
    .filter((category) => !METHOD_CLASSIFICATION_CATEGORIES.includes(category))
    .sort();
  for (const category of unexpectedCategories) {
    issues.push({ code: 'unexpected-category', category });
  }

  const classificationByName = new Map();
  const manifestCounts = {};
  for (const category of METHOD_CLASSIFICATION_CATEGORIES) {
    const entries = categories[category];
    if (!Array.isArray(entries)) {
      issues.push({ code: 'missing-category-array', category });
      manifestCounts[category] = 0;
      continue;
    }
    manifestCounts[category] = entries.length;
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : '';
      if (!name) {
        issues.push({ code: 'invalid-method-name', category, name: String(entry) });
        continue;
      }
      if (classificationByName.has(name)) {
        issues.push({
          code: 'duplicate-manifest-method',
          category,
          name,
          previousCategory: classificationByName.get(name),
        });
        continue;
      }
      classificationByName.set(name, category);
    }
  }

  const sourceNameSet = new Set(sourceNames);
  for (const name of [...classificationByName.keys()].sort()) {
    if (!sourceNameSet.has(name)) {
      issues.push({ code: 'unknown-manifest-method', name, category: classificationByName.get(name) });
    }
  }
  for (const name of [...sourceNameSet].sort()) {
    if (!classificationByName.has(name)) issues.push({ code: 'unclassified-source-method', name });
  }

  issues.sort(issueSort);
  const methods = projectDatabase.methods.map((method) => ({
    ...method,
    classification: classificationByName.get(method.name) || 'unclassified',
  }));
  const classificationComplete = issues.length === 0
    && methods.every((method) => method.classification !== 'unclassified');
  const methodsByName = new Map(methods.map((method) => [method.name, method]));
  const consistencyIssues = [];
  for (const method of methods.filter((entry) => entry.definitionResolved === false)) {
    consistencyIssues.push({
      code: 'method-definition-unresolved',
      name: method.name,
    });
  }
  for (const method of methods.filter((entry) => entry.classification === 'read')) {
    if (method.hasDirectPersistentMutationCandidate) {
      consistencyIssues.push({
        code: 'read-has-direct-persistent-mutation-candidate',
        name: method.name,
      });
    }
    const dependency = firstStatefulDependency(method, methodsByName);
    if (dependency) {
      consistencyIssues.push({
        code: 'read-reaches-stateful-method',
        name: method.name,
        dependency: dependency.name,
        dependencyClassification: dependency.classification,
      });
    }
  }
  consistencyIssues.sort(issueSort);
  const classificationConsistent = consistencyIssues.length === 0;
  const classificationGatePassed = classificationComplete && classificationConsistent;
  const counts = Object.fromEntries(METHOD_CLASSIFICATION_CATEGORIES.map((category) => [
    category,
    methods.filter((method) => method.classification === category).length,
  ]));
  counts.unclassified = methods.filter((method) => method.classification === 'unclassified').length;

  return {
    projectDatabase: { ...projectDatabase, methods },
    classification: {
      manifestFile,
      manifestVersion: manifest.manifestVersion ?? null,
      manifestSha256,
      sourceFile: manifest.sourceFile ?? null,
      semantics: manifest.classificationSemantics ?? null,
      categories: [...METHOD_CLASSIFICATION_CATEGORIES],
      manifestCounts,
      counts,
      methodNameFingerprint: sha256Text(JSON.stringify(methods.map((method) => ({
        name: method.name,
        classification: method.classification,
      })))),
      classificationComplete,
      classificationConsistent,
      classificationGatePassed,
      issueCount: issues.length,
      issues,
      consistencyIssueCount: consistencyIssues.length,
      consistencyIssues,
    },
  };
}

function firstStatefulDependency(method, methodsByName, seen = new Set()) {
  if (seen.has(method.name)) return null;
  const nextSeen = new Set(seen);
  nextSeen.add(method.name);
  for (const calledName of method.calledProjectDatabaseMethods) {
    if (calledName === method.name) continue;
    const called = methodsByName.get(calledName);
    if (!called) return { name: calledName, classification: 'unclassified' };
    if (called.classification !== 'read') {
      return { name: called.name, classification: called.classification };
    }
    const nested = firstStatefulDependency(called, methodsByName, nextSeen);
    if (nested) return nested;
  }
  return null;
}

function directCoordinatorBoundaryProof(method, methodsByName) {
  const coordinatorCalls = Array.isArray(method.direct?.coordinatorCalls)
    ? method.direct.coordinatorCalls
    : [];
  const eligibleCallbackIds = new Set(
    coordinatorCalls.filter((call) => call.eligible && call.id).map((call) => call.id),
  );
  const databaseEffects = Array.isArray(method.direct?.databaseEffectSites)
    ? method.direct.databaseEffectSites
    : [];
  const methodCallSites = Array.isArray(method.calledProjectDatabaseMethodCalls)
    ? method.calledProjectDatabaseMethodCalls
    : [];
  const statefulCallSites = [];
  const unsafeStatefulCallees = [];
  const locatedCalledNames = new Set();
  for (const site of methodCallSites) {
    locatedCalledNames.add(site.name);
    if (site.name === 'withProjectDatabaseWrite') continue;
    const callee = methodsByName.get(site.name);
    if (callee?.classification === 'read') continue;
    statefulCallSites.push({
      name: site.name,
      line: site.line,
      callbackId: site.callbackId || null,
      classification: callee?.classification || 'unclassified',
    });
    if (!callee
      || callee.definitionResolved === false
      || callee.async
      || ['migration', 'test-only', 'unclassified'].includes(callee.classification)) {
      unsafeStatefulCallees.push({
        name: site.name,
        line: site.line,
        reason: !callee
          ? 'callee-missing'
          : callee.definitionResolved === false
            ? 'callee-definition-unresolved'
            : callee.async
              ? 'callee-async'
              : `callee-${callee.classification}`,
      });
    }
  }
  const unlocatedStatefulCallees = [];
  for (const calledName of method.calledProjectDatabaseMethods || []) {
    if (calledName === 'withProjectDatabaseWrite' || locatedCalledNames.has(calledName)) continue;
    const callee = methodsByName.get(calledName);
    if (callee?.classification === 'read') continue;
    unlocatedStatefulCallees.push({
      name: calledName,
      classification: callee?.classification || 'unclassified',
    });
  }
  const effects = [
    ...databaseEffects.map((site) => ({
      kind: `database:${site.kind}`,
      line: site.line,
      callbackId: site.callbackId || null,
    })),
    ...statefulCallSites.map((site) => ({
      kind: `stateful:${site.classification}:${site.name}`,
      line: site.line,
      callbackId: site.callbackId || null,
    })),
  ];
  const uncoveredEffects = effects.filter((site) => !eligibleCallbackIds.has(site.callbackId));
  const failureReasons = [];
  if (coordinatorCalls.length === 0) failureReasons.push('no-exact-inline-coordinator-call');
  if (coordinatorCalls.some((call) => !call.eligible)) {
    failureReasons.push('coordinator-callback-not-strictly-synchronous-inline');
  }
  if (effects.length === 0) failureReasons.push('no-observable-database-or-stateful-effect');
  if (uncoveredEffects.length > 0) failureReasons.push('effect-outside-eligible-coordinator-callback');
  if (Number(method.direct?.transactionFactoryCount || 0) > 0) failureReasons.push('raw-transaction-observed');
  if (Number(method.direct?.filesystemMutationCount || 0) > 0) failureReasons.push('filesystem-mutation-observed');
  if (Number(method.direct?.backupCount || 0) > 0) failureReasons.push('backup-mutation-observed');
  if (Number(method.direct?.dynamicProjectDatabaseCallCount || 0) > 0) {
    failureReasons.push('dynamic-project-database-call-observed');
  }
  if (unsafeStatefulCallees.length > 0) failureReasons.push('unsafe-stateful-callee-observed');
  if (unlocatedStatefulCallees.length > 0) failureReasons.push('stateful-callee-location-unresolved');
  return {
    proven: failureReasons.length === 0,
    coordinatorCallCount: coordinatorCalls.length,
    eligibleCoordinatorCallCount: coordinatorCalls.filter((call) => call.eligible).length,
    databaseEffectCount: databaseEffects.length,
    statefulEffectCount: statefulCallSites.length,
    coveredEffectCount: effects.length - uncoveredEffects.length,
    uncoveredEffectCount: uncoveredEffects.length,
    uncoveredEffects,
    unsafeStatefulCalleeCount: unsafeStatefulCallees.length,
    unsafeStatefulCallees,
    unlocatedStatefulCalleeCount: unlocatedStatefulCallees.length,
    unlocatedStatefulCallees,
    failureReasons,
  };
}

function internalTransactionBoundaryProof(method, methodsByName) {
  const failureReasons = [...(method.internalTransactionAssertion?.failureReasons || [])];
  const unsafeCallees = [];
  if (Number(method.direct?.filesystemMutationCount || 0) > 0) {
    failureReasons.push('filesystem-mutation-observed');
  }
  if (Number(method.direct?.backupCount || 0) > 0) failureReasons.push('backup-mutation-observed');
  if (Number(method.direct?.transactionFactoryCount || 0) > 0) {
    failureReasons.push('raw-transaction-observed');
  }
  if (Number(method.direct?.coordinatorCallCount || 0) > 0) {
    failureReasons.push('nested-direct-coordinator-observed');
  }
  if (Number(method.direct?.dynamicProjectDatabaseCallCount || 0) > 0) {
    failureReasons.push('dynamic-project-database-call-observed');
  }

  const inspectCallee = (callee, path, seen) => {
    if (!callee || seen.has(callee.name)) return;
    const nextSeen = new Set(seen);
    nextSeen.add(callee.name);
    const calleePath = [...path, callee.name];
    const direct = callee.direct || {};
    const hazards = [];
    if (callee.definitionResolved === false) hazards.push('definition-unresolved');
    if (callee.async) hazards.push('async');
    if (['migration', 'test-only', 'unclassified'].includes(callee.classification)) {
      hazards.push(`classification-${callee.classification}`);
    }
    if (Number(direct.filesystemMutationCount || 0) > 0) hazards.push('filesystem-mutation');
    if (Number(direct.backupCount || 0) > 0) hazards.push('backup-mutation');
    if (Number(direct.dynamicProjectDatabaseCallCount || 0) > 0) {
      hazards.push('dynamic-project-database-call');
    }
    if (hazards.length > 0) {
      unsafeCallees.push({ path: calleePath, hazards });
      return;
    }
    for (const calledName of callee.calledProjectDatabaseMethods || []) {
      if (calledName === INTERNAL_TRANSACTION_ASSERTION_METHOD) continue;
      const nested = methodsByName.get(calledName);
      if (!nested) {
        unsafeCallees.push({ path: [...calleePath, calledName], hazards: ['callee-missing'] });
        continue;
      }
      if (nested.classification === 'read') continue;
      inspectCallee(nested, calleePath, nextSeen);
    }
  };
  for (const calledName of method.calledProjectDatabaseMethods || []) {
    if (calledName === INTERNAL_TRANSACTION_ASSERTION_METHOD) continue;
    const callee = methodsByName.get(calledName);
    if (!callee) {
      unsafeCallees.push({ path: [method.name, calledName], hazards: ['callee-missing'] });
      continue;
    }
    if (callee.classification === 'read') continue;
    inspectCallee(callee, [method.name], new Set([method.name]));
  }
  if (unsafeCallees.length > 0) failureReasons.push('unsafe-transitive-callee-observed');
  return {
    proven: failureReasons.length === 0,
    context: method.internalTransactionAssertion?.context || null,
    unsafeCalleeCount: unsafeCallees.length,
    unsafeCallees,
    failureReasons: [...new Set(failureReasons)],
  };
}

function annotateProjectDatabaseWriterPolicy(projectDatabase, classificationComplete, externalInventory) {
  const methodsByName = new Map(projectDatabase.methods.map((method) => [method.name, method]));
  const methods = projectDatabase.methods.map((method) => {
    const coordinatorBoundaryProof = directCoordinatorBoundaryProof(method, methodsByName);
    const internalTransactionProof = internalTransactionBoundaryProof(method, methodsByName);
    const annotatedMethod = { ...method, coordinatorBoundaryProof, internalTransactionProof };
    if (method.definitionResolved === false) {
      return {
        ...annotatedMethod,
        policyApplicable: true,
        policyCompliant: false,
        policyReason: 'method-definition-unresolved',
      };
    }
    if (['migration', 'test-only'].includes(method.classification)) {
      return {
        ...annotatedMethod,
        policyApplicable: false,
        policyCompliant: null,
        policyReason: `${method.classification}-excluded`,
      };
    }
    if (method.classification === 'read') {
      const dependency = firstStatefulDependency(method, methodsByName);
      const compliant = !method.hasDirectPersistentMutationCandidate && !dependency;
      return {
        ...annotatedMethod,
        policyApplicable: true,
        policyCompliant: compliant,
        policyReason: method.hasDirectPersistentMutationCandidate
          ? 'read-has-direct-persistent-mutation-candidate'
          : dependency
            ? `read-reaches-${dependency.classification}:${dependency.name}`
            : 'read-no-static-persistent-mutation-observed',
      };
    }
    if (method.classification === 'unclassified') {
      return {
        ...annotatedMethod,
        policyApplicable: true,
        policyCompliant: false,
        policyReason: 'classification-missing',
      };
    }

    const directlyCoordinates = method.name === 'withProjectDatabaseWrite'
      || method.calledProjectDatabaseMethods.includes('withProjectDatabaseWrite');
    if (method.name === 'withProjectDatabaseWrite') {
      return {
        ...annotatedMethod,
        policyApplicable: true,
        policyCompliant: true,
        policyReason: 'project-database-write-coordinator',
      };
    }
    if (method.visibility === 'internal') {
      if (internalTransactionProof.proven) {
        return {
          ...annotatedMethod,
          policyApplicable: true,
          policyCompliant: true,
          policyReason: method.internalTransactionAssertion.context === 'coordinator'
            ? 'internal-coordinator-transaction-assertion-proven'
            : 'internal-existing-transaction-assertion-proven',
        };
      }
      return {
        ...annotatedMethod,
        policyApplicable: true,
        policyCompliant: null,
        policyReason: 'internal-caller-boundary-not-statically-proven',
      };
    }
    if (directlyCoordinates && coordinatorBoundaryProof.proven) {
      return {
        ...annotatedMethod,
        policyApplicable: true,
        policyCompliant: true,
        policyReason: 'direct-coordinator-boundary-proven',
      };
    }
    if (directlyCoordinates) {
      return {
        ...annotatedMethod,
        policyApplicable: true,
        policyCompliant: null,
        policyReason: 'direct-coordinator-call-observed-boundary-not-proven',
      };
    }
    return {
      ...annotatedMethod,
      policyApplicable: true,
      policyCompliant: false,
      policyReason: 'public-stateful-method-without-direct-coordinator',
    };
  });

  const policyFalse = methods.filter((method) => method.policyCompliant === false);
  const policyUnknown = methods.filter((method) => (
    method.policyApplicable === true && method.policyCompliant == null
  ));
  const policyTrue = methods.filter((method) => method.policyCompliant === true);
  const externalRawEntryCount = Number(externalInventory?.entryCount || 0);
  const policyCompliant = classificationComplete
    && policyFalse.length === 0
    && policyUnknown.length === 0
    && externalRawEntryCount === 0;

  return {
    projectDatabase: { ...projectDatabase, methods },
    policy: {
      policyCompliant,
      methodCounts: {
        compliant: policyTrue.length,
        noncompliant: policyFalse.length,
        unresolved: policyUnknown.length,
        notApplicable: methods.filter((method) => method.policyApplicable === false).length,
      },
      noncompliantPublicMethods: policyFalse
        .filter((method) => method.visibility === 'public')
        .map((method) => method.name),
      unresolvedInternalMethods: policyUnknown
        .filter((method) => method.visibility === 'internal')
        .map((method) => method.name),
      externalRawEntryCount,
      externalRawUnclassifiedCount: (externalInventory?.entries || [])
        .filter((entry) => /unclassified/.test(String(entry.classification || ''))).length,
    },
  };
}

function listJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile() && /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(entry.name)) files.push(target);
    }
  }
  return files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));
}

function rawDbHandleMatcher(source, ast) {
  const aliasesThisDb = /this\.db\s*=\s*(?:this\.)?database\.db\b/.test(source);
  const parents = parentMap(ast);
  const programScope = 'Program:0';
  const ownerAliases = new Map();
  const handleAliases = new Map();
  const aliasesFor = (map, scope) => {
    if (!map.has(scope)) map.set(scope, new Set());
    return map.get(scope);
  };
  const scopeFor = (node) => scopeKey(node, parents);
  const hasScopedAlias = (map, scope, name) => (
    aliasesFor(map, scope).has(name)
    || (scope !== programScope && aliasesFor(map, programScope).has(name))
  );
  aliasesFor(ownerAliases, programScope).add('database');
  aliasesFor(ownerAliases, programScope).add('projectDatabase');
  if (aliasesThisDb) aliasesFor(handleAliases, programScope).add('this.db');

  const isKnownOwner = (node, scope) => {
    if (node?.type === 'Identifier' && hasScopedAlias(ownerAliases, scope, node.name)) return true;
    const chain = memberChain(node);
    return chain.length > 0
      && (hasScopedAlias(ownerAliases, scope, chain.join('.'))
        || ['database', 'projectDatabase'].includes(chain[chain.length - 1]));
  };
  const isDirectHandle = (node, scope) => {
    const chain = memberChain(node);
    if (node?.type === 'Identifier' && hasScopedAlias(handleAliases, scope, node.name)) return true;
    if (hasScopedAlias(handleAliases, scope, chain.join('.'))) return true;
    if (chain.length < 2 || chain[chain.length - 1] !== 'db') return false;
    if (chain.join('.') === 'this.db') return aliasesThisDb;
    return isKnownOwner(node.object, scope)
      || chain.includes('database')
      || chain.includes('projectDatabase');
  };

  let changed = true;
  while (changed) {
    changed = false;
    walk(ast, (node) => {
      const scope = scopeFor(node);
      if (node.type === 'VariableDeclarator') {
        if (node.id.type === 'Identifier') {
          if (isKnownOwner(node.init, scope) && !aliasesFor(ownerAliases, scope).has(node.id.name)) {
            aliasesFor(ownerAliases, scope).add(node.id.name);
            changed = true;
          }
          if (isDirectHandle(node.init, scope) && !aliasesFor(handleAliases, scope).has(node.id.name)) {
            aliasesFor(handleAliases, scope).add(node.id.name);
            changed = true;
          }
        }
        if (node.id.type === 'ObjectPattern') {
          for (const property of node.id.properties) {
            if (property.type !== 'ObjectProperty') continue;
            const key = property.key?.type === 'Identifier' ? property.key.name : staticText(property.key);
            const value = property.value?.type === 'AssignmentPattern'
              ? property.value.left
              : property.value;
            const local = value?.type === 'Identifier' ? value.name : null;
            if (['database', 'projectDatabase'].includes(key)
              && local
              && !aliasesFor(ownerAliases, scope).has(local)) {
              aliasesFor(ownerAliases, scope).add(local);
              changed = true;
            }
            if (key === 'db'
              && local
              && isKnownOwner(node.init, scope)
              && !aliasesFor(handleAliases, scope).has(local)) {
              aliasesFor(handleAliases, scope).add(local);
              changed = true;
            }
          }
        }
      }
      if (node.type === 'AssignmentExpression'
        && node.left.type === 'Identifier') {
        if (isKnownOwner(node.right, scope) && !aliasesFor(ownerAliases, scope).has(node.left.name)) {
          aliasesFor(ownerAliases, scope).add(node.left.name);
          changed = true;
        }
        if (isDirectHandle(node.right, scope) && !aliasesFor(handleAliases, scope).has(node.left.name)) {
          aliasesFor(handleAliases, scope).add(node.left.name);
          changed = true;
        }
      }
    });
  }
  return (node) => {
    const scope = scopeFor(node);
    if (node?.type === 'Identifier' && hasScopedAlias(handleAliases, scope, node.name)) return true;
    const chain = memberChain(node);
    return hasScopedAlias(handleAliases, scope, chain.join('.')) || isDirectHandle(node, scope);
  };
}

function isRawDbMethodCall(node, method, matchesRawDb) {
  return isCallNode(node)
    && isMemberNode(node.callee)
    && propertyName(node.callee) === method
    && matchesRawDb(node.callee.object);
}

function scopeKey(node, parents) {
  const scope = containingScope(node, parents);
  return scope ? `${scope.type}:${scope.start}` : 'unknown';
}

function externalRawDatabaseInventory(root) {
  const backendRoot = path.join(root, 'backend', 'src');
  const projectDatabaseFile = normalizePath(path.join(backendRoot, 'services', 'projectDatabase.js'));
  const entries = [];

  for (const filename of listJavaScriptFiles(backendRoot)) {
    if (normalizePath(filename) === projectDatabaseFile) continue;
    const { source, ast } = parseSource(filename);
    const matchesRawDb = rawDbHandleMatcher(source, ast);
    const parents = parentMap(ast);
    const preparedAliases = new Map();
    const preparedKey = (scope, name) => `${scope}:${name}`;
    const preparedEntries = (scope, name) => {
      const local = preparedAliases.get(preparedKey(scope, name));
      if (local?.size > 0) return local;
      const program = preparedAliases.get(preparedKey('Program:0', name));
      return program?.size > 0 ? program : null;
    };
    const representativePreparedAlias = (scope, name) => {
      const values = [...(preparedEntries(scope, name)?.values() || [])]
        .sort((left, right) => String(left.sql).localeCompare(String(right.sql)));
      return values.find((entry) => isMutationSqlText(entry.sql)) || values[0] || null;
    };

    let preparedAliasesChanged = true;
    while (preparedAliasesChanged) {
      preparedAliasesChanged = false;
      walk(ast, (node) => {
        if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier') return;
        const scope = scopeKey(node, parents);
        const lookup = (name) => representativePreparedAlias(scope, name);
        const prepared = preparedStatementExpression(node.init, matchesRawDb, lookup);
        const candidates = [];
        if (prepared?.sql != null) candidates.push(prepared);
        if (node.init?.type === 'Identifier') {
          for (const entry of preparedEntries(scope, node.init.name)?.values() || []) candidates.push(entry);
        }
        const key = preparedKey(scope, node.id.name);
        const target = preparedAliases.get(key) || new Map();
        for (const entry of candidates) {
          const sqlKey = String(entry.sql);
          if (target.has(sqlKey)) continue;
          target.set(sqlKey, {
            prepareLine: entry.prepareLine || node.loc.start.line,
            sql: entry.sql,
          });
          preparedAliasesChanged = true;
        }
        if (target.size > 0) preparedAliases.set(key, target);
      });
    }

    walk(ast, (node) => {
      if (!isCallNode(node) || !isMemberNode(node.callee)) return;
      const line = node.loc?.start?.line || 1;
      const file = relativePath(root, filename);

      if (isRawDbMethodCall(node, 'transaction', matchesRawDb)) {
        const container = containingScope(node, parents);
        entries.push({
          file,
          line,
          kind: 'raw-transaction-boundary',
          transactionTypes: transactionInvocationKinds(node, parents, container),
          classification: 'mutation-candidate-unclassified',
          snippet: sourceLine(source, line),
        });
        return;
      }
      if (isRawDbMethodCall(node, 'exec', matchesRawDb)) {
        entries.push({
          file,
          line,
          kind: 'raw-exec',
          sql: staticText(node.arguments?.[0]),
          classification: 'mutation-candidate',
          snippet: sourceLine(source, line),
        });
        return;
      }
      if (isRawDbMethodCall(node, 'pragma', matchesRawDb)) {
        const pragma = staticText(node.arguments?.[0]);
        if (isWritePragmaText(pragma)) {
          entries.push({
            file,
            line,
            kind: 'raw-write-pragma',
            pragma,
            classification: 'mutation-candidate',
            snippet: sourceLine(source, line),
          });
        }
        return;
      }
      const invocationMethod = propertyName(node.callee);
      if (!['all', 'get', 'iterate', 'run'].includes(invocationMethod)) return;
      const receiver = node.callee.object;
      const scope = scopeKey(node, parents);
      const prepared = preparedStatementExpression(
        receiver,
        matchesRawDb,
        (name) => representativePreparedAlias(scope, name),
      );
      if (!prepared) return;
      if (invocationMethod !== 'run' && !isMutationSqlText(prepared.sql)) return;
      entries.push({
        file,
        line,
        kind: invocationMethod === 'run' ? 'raw-prepared-run' : 'raw-prepared-mutation-query',
        prepareLine: prepared.prepareLine || receiver.loc?.start?.line || line,
        sql: prepared.sql,
        classification: 'mutation',
        snippet: sourceLine(source, line),
      });
    });
  }

  entries.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.kind.localeCompare(right.kind));
  const byFile = new Map();
  for (const entry of entries) {
    const state = byFile.get(entry.file) || { file: entry.file, count: 0, kinds: new Set(), lines: [] };
    state.count += 1;
    state.kinds.add(entry.kind);
    state.lines.push(entry.line);
    byFile.set(entry.file, state);
  }
  const files = [...byFile.values()].map((entry) => ({
    file: entry.file,
    count: entry.count,
    kinds: [...entry.kinds].sort(),
    lines: [...new Set(entry.lines)].sort((left, right) => left - right),
  })).sort((left, right) => left.file.localeCompare(right.file));

  return {
    scannedRoot: relativePath(root, backendRoot),
    entryCount: entries.length,
    fileCount: files.length,
    files,
    entries,
  };
}

function nearestRoute(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = ancestors[index];
    if (!isCallNode(candidate) || !isMemberNode(candidate.callee)) continue;
    const method = String(propertyName(candidate.callee) || '').toLowerCase();
    if (!['delete', 'get', 'patch', 'post', 'put', 'use'].includes(method)) continue;
    const receiver = memberChain(candidate.callee.object).join('.');
    if (!/(?:^|\.)(?:app|router)$/.test(receiver)) continue;
    return { method: method.toUpperCase(), path: staticText(candidate.arguments?.[0]) };
  }
  return { method: null, path: null };
}

function fixedRouteStatusInventory(root) {
  const routesRoot = path.join(root, 'backend', 'src', 'routes');
  const entries = [];
  for (const filename of listJavaScriptFiles(routesRoot)) {
    const { source, ast } = parseSource(filename);
    walk(ast, (node, ancestors) => {
      if (!isCallNode(node) || !isMemberNode(node.callee) || propertyName(node.callee) !== 'status') return;
      const argument = node.arguments?.[0];
      if (argument?.type !== 'NumericLiteral' || ![400, 500].includes(argument.value)) return;
      const line = node.loc?.start?.line || 1;
      const route = nearestRoute(ancestors);
      entries.push({
        file: relativePath(root, filename),
        line,
        status: argument.value,
        routeMethod: route.method,
        routePath: route.path,
        insideCatch: ancestors.some((ancestor) => ancestor.type === 'CatchClause'),
        snippet: sourceLine(source, line),
      });
    });
  }
  entries.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.status - right.status);
  const fileCounts = new Map();
  for (const entry of entries) {
    const state = fileCounts.get(entry.file) || { file: entry.file, status400: 0, status500: 0, lines: [] };
    if (entry.status === 400) state.status400 += 1;
    if (entry.status === 500) state.status500 += 1;
    state.lines.push(entry.line);
    fileCounts.set(entry.file, state);
  }
  const files = [...fileCounts.values()].map((entry) => ({
    ...entry,
    lines: [...new Set(entry.lines)].sort((left, right) => left - right),
  })).sort((left, right) => left.file.localeCompare(right.file));
  return {
    scannedRoot: relativePath(root, routesRoot),
    statuses: [400, 500],
    entryCount: entries.length,
    fileCount: files.length,
    files,
    entries,
  };
}

function parserVersion() {
  try {
    return require('@babel/parser/package.json').version;
  } catch (_) {
    return null;
  }
}

function buildWriterInventory(root = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(root);
  const rawProjectDatabase = inventoryProjectDatabase(resolvedRoot);
  const loadedClassification = loadProjectDatabaseMethodClassification(resolvedRoot);
  const classified = classifyProjectDatabaseMethods(rawProjectDatabase, loadedClassification);
  const externalProductionRawDatabase = externalRawDatabaseInventory(resolvedRoot);
  const annotated = annotateProjectDatabaseWriterPolicy(
    classified.projectDatabase,
    classified.classification.classificationGatePassed,
    externalProductionRawDatabase,
  );
  const classificationComplete = classified.classification.classificationComplete;
  const classificationGatePassed = classified.classification.classificationGatePassed;
  const policyCompliant = annotated.policy.policyCompliant;
  const status = !classificationComplete
    ? 'classification-incomplete'
    : !classificationGatePassed
      ? 'classification-inconsistent'
      : policyCompliant
        ? 'classification-complete-policy-complete'
        : REPORT_STATUS;
  return {
    reportVersion: REPORT_VERSION,
    status,
    evidenceLevel: 'static-source-inventory-only',
    classificationComplete,
    classificationGatePassed,
    policyCompliant,
    disclaimer: [
      'Complete method classification is not writer-policy implementation or completion evidence.',
      'The scanner reads source text only and never opens a ProjectDatabase or retained database.',
      'Internal writer proof accepts only one exact synchronous first-statement transaction assertion.',
      'Unasserted internal writers remain unresolved until their lifecycle or caller boundary is reviewed.',
      'External raw database access remains an independent policy domain.',
      'External aliases are isolated by containing function; closure capture and lexical shadowing are not proof-complete.',
      'Dynamic SQL, arbitrary higher-order calls, and runtime prototype mutation remain outside static proof.',
      'Fixed 400/500 hits are structural findings, not proof that each path mishandles a capacity error.',
    ],
    parser: { package: '@babel/parser', version: parserVersion() },
    methodClassification: classified.classification,
    writerPolicy: annotated.policy,
    projectDatabase: annotated.projectDatabase,
    externalProductionRawDatabase,
    fixedRouteStatuses: fixedRouteStatusInventory(resolvedRoot),
  };
}

function parseArguments(argv) {
  const options = { root: DEFAULT_ROOT, compact: false, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires a path');
      options.root = path.resolve(value);
      index += 1;
    } else if (argument === '--compact') {
      options.compact = true;
    } else if (argument === '--check') {
      options.check = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function helpText() {
  return [
    'Usage: node scripts/audit-project-database-writers.cjs [--root <repo>] [--compact] [--check]',
    '',
    'Emits deterministic JSON to stdout without opening any SQLite database.',
    '--check fails when the explicit manifest drifts or a declared read method',
    'gains a statically observable SQL/filesystem/stateful dependency, or a',
    'callable/prototype definition cannot be resolved fail-closed;',
    'writerPolicy.policyCompliant remains a separate implementation gate.',
  ].join('\n');
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const report = buildWriterInventory(options.root);
  process.stdout.write(`${JSON.stringify(report, null, options.compact ? 0 : 2)}\n`);
  if (options.check && !report.classificationGatePassed) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[project-db-writer-audit] ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  INTERNAL_TRANSACTION_ASSERTION_CONTEXTS,
  INTERNAL_TRANSACTION_ASSERTION_METHOD,
  METHOD_CLASSIFICATION_CATEGORIES,
  METHOD_CLASSIFICATION_FILE,
  METHOD_CLASSIFICATION_SEMANTICS,
  METHOD_CLASSIFICATION_VERSION,
  REPORT_STATUS,
  REPORT_VERSION,
  annotateProjectDatabaseWriterPolicy,
  buildWriterInventory,
  classifyProjectDatabaseMethods,
  fixedRouteStatusInventory,
  inventoryProjectDatabase,
  loadProjectDatabaseMethodClassification,
  externalRawDatabaseInventory,
};
