'use strict';

const { createHash } = require('node:crypto');

const {
  PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_CONTRACT,
  PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_SCOPE,
} = require('./projectDatabaseMigration32');

const LOGICAL_DIGEST_HEADER_32 = Buffer.from(
  't8-project-database-logical-content-digest-v2\0',
  'utf8',
);
const LOGICAL_DIGEST_ALGORITHM_32 = 'sha256';
const LOGICAL_DIGEST_EXCLUDED_TABLES_32 = Object.freeze([
  'project_database_backup_receipts',
  'project_database_canonical_backup_head',
]);
const PROJECT_DATABASE_LOGICAL_DIGEST_IMPLEMENTATION_CONTRACT_32 = Object.freeze({
  format: 't8-project-database-logical-content-digest-v2',
  algorithm: 'sha256',
  scope: PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_SCOPE,
  streamHeader: 't8-project-database-logical-content-digest-v2\0',
  lengthEncoding: 'unsigned-64-bit-big-endian',
  excludedObjectNames: LOGICAL_DIGEST_EXCLUDED_TABLES_32,
  tableOrder: 'main-table-name-utf8-buffer-compare-ascending',
  columnOrder: 'pragma-table-xinfo-cid-ascending-hidden-nonzero-excluded',
  rowOrder: Object.freeze({
    withPrimaryKey:
      'canonical-primary-key-tuple-buffer-compare-ascending-then-canonical-full-row-tuple-buffer-compare-ascending',
    withoutPrimaryKey: 'canonical-full-row-tuple-buffer-compare-ascending',
    implicitRowidPolicy: 'never-read-or-order-by-rowid',
  }),
  frames: Object.freeze({
    table: Object.freeze({
      typeByte: 'T',
      bytes: 'ascii-T-plus-u64be-utf8-name-byte-length-plus-utf8-name',
    }),
    column: Object.freeze({
      typeByte: 'C',
      bytes: 'ascii-C-plus-u64be-utf8-name-byte-length-plus-utf8-name',
    }),
    row: Object.freeze({
      typeByte: 'R',
      bytes: 'ascii-R-plus-u64be-canonical-tuple-byte-length-plus-canonical-tuple',
    }),
    tableEnd: Object.freeze({
      typeByte: 'E',
      bytes: 'ascii-E-plus-u64be-row-count',
    }),
  }),
  valueEncoding: Object.freeze({
    framing: 'ascii-type-byte-plus-u64be-payload-byte-length-plus-payload',
    null: 'ascii-n-plus-u64be-zero',
    integer: 'ascii-i-plus-u64be-payload-length-plus-canonical-base10-ascii',
    real: 'ascii-r-plus-u64be-eight-plus-ieee754-binary64-big-endian',
    text: 'ascii-t-plus-u64be-utf8-byte-length-plus-utf8',
    blob: 'ascii-b-plus-u64be-raw-byte-length-plus-raw-bytes',
  }),
});
if (JSON.stringify(PROJECT_DATABASE_LOGICAL_DIGEST_IMPLEMENTATION_CONTRACT_32)
  !== JSON.stringify(PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_CONTRACT)) {
  throw new Error('schema32 logical digest implementation does not match the frozen migration contract');
}
const SORT_TUPLE_FUNCTION = '__t8_schema32_canonical_tuple_v1';
const CONCAT_TUPLE_FUNCTION = '__t8_schema32_concat_tuple_v1';
const SQLITE_FUNCTION_ARGUMENT_CHUNK = 48;
const MAX_UINT64 = (1n << 64n) - 1n;
const MIN_SQLITE_INTEGER = -(1n << 63n);
const MAX_SQLITE_INTEGER = (1n << 63n) - 1n;
const registeredDatabases = new WeakSet();

class ProjectDatabaseLogicalDigest32Error extends Error {
  constructor(reason, message, details = {}, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProjectDatabaseLogicalDigest32Error';
    this.code = 'project_database_logical_digest_unavailable';
    this.reason = String(reason || 'unknown');
    this.details = Object.freeze({ reason: this.reason, ...details });
  }
}

function uint64Buffer(value, field = 'value') {
  let normalized;
  try {
    normalized = typeof value === 'bigint' ? value : BigInt(value);
  } catch (cause) {
    throw new ProjectDatabaseLogicalDigest32Error(
      'framing-invalid',
      `schema32 logical digest ${field} is not an unsigned 64-bit integer`,
      { field },
      cause,
    );
  }
  if (normalized < 0n || normalized > MAX_UINT64) {
    throw new ProjectDatabaseLogicalDigest32Error(
      'framing-invalid',
      `schema32 logical digest ${field} is outside unsigned 64-bit range`,
      { field },
    );
  }
  const output = Buffer.allocUnsafe(8);
  output.writeBigUInt64BE(normalized);
  return output;
}

function taggedPayloadFrame(tag, payload) {
  const tagBuffer = Buffer.from(String(tag), 'ascii');
  if (tagBuffer.length !== 1) {
    throw new ProjectDatabaseLogicalDigest32Error(
      'framing-invalid',
      'schema32 logical digest frame tag must be exactly one ASCII byte',
      { tag },
    );
  }
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([tagBuffer, uint64Buffer(bytes.length, 'payloadLength'), bytes]);
}

function encodeProjectDatabaseSqliteValue32(value) {
  if (value === null) return taggedPayloadFrame('n', Buffer.alloc(0));
  if (typeof value === 'bigint') {
    if (value < MIN_SQLITE_INTEGER || value > MAX_SQLITE_INTEGER) {
      throw new ProjectDatabaseLogicalDigest32Error(
        'sqlite-value-invalid',
        'schema32 logical digest integer is outside SQLite signed 64-bit range',
      );
    }
    return taggedPayloadFrame('i', Buffer.from(value.toString(10), 'ascii'));
  }
  if (typeof value === 'number') {
    const payload = Buffer.allocUnsafe(8);
    payload.writeDoubleBE(value);
    return taggedPayloadFrame('r', payload);
  }
  if (typeof value === 'string') {
    return taggedPayloadFrame('t', Buffer.from(value, 'utf8'));
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return taggedPayloadFrame('b', Buffer.from(value));
  }
  throw new ProjectDatabaseLogicalDigest32Error(
    'sqlite-value-invalid',
    `schema32 logical digest rejects unsupported SQLite value type ${typeof value}`,
  );
}

function encodeProjectDatabaseSqliteTuple32(values) {
  if (!Array.isArray(values)) {
    throw new ProjectDatabaseLogicalDigest32Error(
      'sqlite-value-invalid',
      'schema32 logical digest tuple must be an array',
    );
  }
  return Buffer.concat(values.map(encodeProjectDatabaseSqliteValue32));
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function buildTupleExpression(columnNames) {
  if (!Array.isArray(columnNames) || columnNames.length < 1) {
    throw new ProjectDatabaseLogicalDigest32Error(
      'schema-invalid',
      'schema32 logical digest cannot encode a table with no visible columns',
    );
  }
  let expressions = [];
  for (let offset = 0; offset < columnNames.length; offset += SQLITE_FUNCTION_ARGUMENT_CHUNK) {
    const columns = columnNames
      .slice(offset, offset + SQLITE_FUNCTION_ARGUMENT_CHUNK)
      .map(quoteIdentifier)
      .join(', ');
    expressions.push(`${SORT_TUPLE_FUNCTION}(${columns})`);
  }
  while (expressions.length > 1) {
    const combined = [];
    for (let offset = 0; offset < expressions.length; offset += SQLITE_FUNCTION_ARGUMENT_CHUNK) {
      combined.push(
        `${CONCAT_TUPLE_FUNCTION}(${expressions
          .slice(offset, offset + SQLITE_FUNCTION_ARGUMENT_CHUNK)
          .join(', ')})`,
      );
    }
    expressions = combined;
  }
  return expressions[0];
}

function registerCanonicalTupleFunctions(database) {
  if (registeredDatabases.has(database)) return;
  database.function(SORT_TUPLE_FUNCTION, {
    deterministic: true,
    directOnly: true,
    safeIntegers: true,
    varargs: true,
  }, (...values) => encodeProjectDatabaseSqliteTuple32(values));
  database.function(CONCAT_TUPLE_FUNCTION, {
    deterministic: true,
    directOnly: true,
    varargs: true,
  }, (...buffers) => {
    if (buffers.some((value) => !Buffer.isBuffer(value))) {
      throw new ProjectDatabaseLogicalDigest32Error(
        'sqlite-value-invalid',
        'schema32 logical digest tuple chunks must be SQLite BLOB values',
      );
    }
    return Buffer.concat(buffers);
  });
  registeredDatabases.add(database);
}

function visibleTableColumns(database, tableName) {
  const rows = database.prepare(`
    SELECT cid, name, pk, hidden
    FROM pragma_table_xinfo(?)
    ORDER BY cid ASC
  `).all(tableName);
  const columns = rows
    .filter((row) => Number(row.hidden) === 0)
    .map((row) => Object.freeze({
      cid: Number(row.cid),
      name: String(row.name),
      primaryKeyOrder: Number(row.pk),
    }));
  if (columns.length < 1
    || columns.some((column, index) => !Number.isSafeInteger(column.cid)
      || column.cid < 0
      || (index > 0 && column.cid <= columns[index - 1].cid)
      || !column.name)) {
    throw new ProjectDatabaseLogicalDigest32Error(
      'schema-invalid',
      'schema32 logical digest found an invalid visible column manifest',
      { tableName },
    );
  }
  return columns;
}

function logicalTableNames(database) {
  const excluded = new Set(LOGICAL_DIGEST_EXCLUDED_TABLES_32);
  const names = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
  `).all()
    .map((row) => String(row.name))
    .filter((name) => !name.toLocaleLowerCase('en-US').startsWith('sqlite_'))
    .filter((name) => !excluded.has(name));
  names.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  if (new Set(names).size !== names.length) {
    throw new ProjectDatabaseLogicalDigest32Error(
      'schema-invalid',
      'schema32 logical digest found duplicate table names',
    );
  }
  return names;
}

function updateTaggedName(hash, tag, value) {
  hash.update(taggedPayloadFrame(tag, Buffer.from(String(value), 'utf8')));
}

function computeLogicalDigestSnapshot(database) {
  registerCanonicalTupleFunctions(database);
  const hash = createHash(LOGICAL_DIGEST_ALGORITHM_32);
  hash.update(LOGICAL_DIGEST_HEADER_32);
  const tables = [];
  let totalRows = 0n;
  for (const tableName of logicalTableNames(database)) {
    const columns = visibleTableColumns(database, tableName);
    const columnNames = columns.map((column) => column.name);
    const primaryKeyColumns = columns
      .filter((column) => column.primaryKeyOrder > 0)
      .sort((left, right) => left.primaryKeyOrder - right.primaryKeyOrder)
      .map((column) => column.name);
    updateTaggedName(hash, 'T', tableName);
    for (const columnName of columnNames) updateTaggedName(hash, 'C', columnName);

    const fullRowExpression = buildTupleExpression(columnNames);
    const orderExpressions = primaryKeyColumns.length > 0
      ? [buildTupleExpression(primaryKeyColumns), fullRowExpression]
      : [fullRowExpression];
    const statement = database.prepare(`
      SELECT ${columnNames.map(quoteIdentifier).join(', ')}
      FROM ${quoteIdentifier(tableName)}
      ORDER BY ${orderExpressions.map((expression) => `${expression} ASC`).join(', ')}
    `).raw(true).safeIntegers(true);
    let tableRows = 0n;
    for (const row of statement.iterate()) {
      const tuple = encodeProjectDatabaseSqliteTuple32(row);
      hash.update(taggedPayloadFrame('R', tuple));
      tableRows += 1n;
      totalRows += 1n;
    }
    hash.update(Buffer.concat([Buffer.from('E', 'ascii'), uint64Buffer(tableRows, 'tableRowCount')]));
    tables.push(Object.freeze({
      name: tableName,
      columns: Object.freeze([...columnNames]),
      primaryKeyColumns: Object.freeze([...primaryKeyColumns]),
      rowCount: tableRows,
    }));
  }
  return Object.freeze({
    algorithm: LOGICAL_DIGEST_ALGORITHM_32,
    scope: PROJECT_DATABASE_SCHEMA_32_LOGICAL_CONTENT_DIGEST_SCOPE,
    digest: hash.digest('hex'),
    tableCount: tables.length,
    rowCount: totalRows,
    tables: Object.freeze(tables),
  });
}

function projectDatabaseLogicalContentDigest32(database, options = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('schema32 logical digest requires an open better-sqlite3 database');
  }
  if (options.requireQueryOnly === true
    && Number(database.pragma('query_only', { simple: true })) !== 1) {
    throw new ProjectDatabaseLogicalDigest32Error(
      'query-only-required',
      'schema32 logical digest verifier requires PRAGMA query_only=ON',
    );
  }
  const alreadyInTransaction = database.inTransaction === true;
  try {
    if (!alreadyInTransaction) database.exec('BEGIN');
    const result = computeLogicalDigestSnapshot(database);
    if (!alreadyInTransaction) database.exec('COMMIT');
    return result;
  } catch (cause) {
    if (!alreadyInTransaction && database.inTransaction === true) {
      try { database.exec('ROLLBACK'); } catch (_) {}
    }
    if (cause instanceof ProjectDatabaseLogicalDigest32Error) throw cause;
    throw new ProjectDatabaseLogicalDigest32Error(
      'snapshot-failed',
      '无法计算 schema32 项目数据库逻辑内容摘要',
      { errorCode: cause?.code || null },
      cause,
    );
  }
}

module.exports = Object.freeze({
  LOGICAL_DIGEST_ALGORITHM_32,
  LOGICAL_DIGEST_EXCLUDED_TABLES_32,
  LOGICAL_DIGEST_HEADER_32,
  PROJECT_DATABASE_LOGICAL_DIGEST_IMPLEMENTATION_CONTRACT_32,
  ProjectDatabaseLogicalDigest32Error,
  encodeProjectDatabaseSqliteTuple32,
  encodeProjectDatabaseSqliteValue32,
  projectDatabaseLogicalContentDigest32,
});
