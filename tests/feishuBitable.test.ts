import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertFeishuOpenApiBase,
  buildFeishuRecordFieldsFromMappings,
  collectFeishuBitableRowsFromNodeData,
  createFeishuBitableWriteRecords,
  maskFeishuCredential,
  normalizeFeishuBitableRecord,
  parseFeishuBitableLink,
  resolveFeishuBitableLocation,
} from '../src/utils/feishuBitable.ts';
import { assertProductionNodeSchema } from './helpers/canvasNodeSchema.ts';

const require = createRequire(import.meta.url);

function read(rel: string) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Feishu Bitable links parse app, table and view without keeping unrelated URL noise', () => {
  assert.deepEqual(
    parseFeishuBitableLink('https://acme.feishu.cn/base/bascnDemoToken?table=tblDemo123&view=vewDemo456&foo=bar'),
    {
      appToken: 'bascnDemoToken',
      tableId: 'tblDemo123',
      viewId: 'vewDemo456',
      host: 'acme.feishu.cn',
    },
  );

  assert.deepEqual(
    parseFeishuBitableLink('app_token=bascnInlineToken&table_id=tblInline&view_id=vewInline'),
    {
      appToken: 'bascnInlineToken',
      tableId: 'tblInline',
      viewId: 'vewInline',
    },
  );

  assert.equal(parseFeishuBitableLink('  bascnOnlyToken  ').appToken, 'bascnOnlyToken');
});

test('Feishu Bitable location resolver makes pasted links usable without a separate parse click', () => {
  assert.deepEqual(
    resolveFeishuBitableLocation({
      link: 'https://acme.feishu.cn/base/bascnDemoToken?table=tblDemo123&view=vewDemo456',
      appToken: '',
      tableId: '',
      viewId: '',
    }),
    {
      appToken: 'bascnDemoToken',
      tableId: 'tblDemo123',
      viewId: 'vewDemo456',
    },
  );

  assert.deepEqual(
    resolveFeishuBitableLocation({
      link: 'https://acme.feishu.cn/base/bascnLinkToken?table=tblFromLink&view=vewFromLink',
      appToken: 'bascnManualToken',
      tableId: 'tblManual',
      viewId: '',
    }),
    {
      appToken: 'bascnManualToken',
      tableId: 'tblManual',
      viewId: 'vewFromLink',
    },
  );
});

test('Feishu record normalization extracts row text and media attachments for canvas ports', () => {
  const normalized = normalizeFeishuBitableRecord({
    appToken: 'bascnDemoToken',
    tableId: 'tblDemo123',
    record: {
      record_id: 'rec1',
      fields: {
        Prompt: [{ text: '一只企鹅在画布上写提示词' }],
        Score: 9,
        Reference: [
          {
            file_token: 'boxcnImageToken',
            name: 'penguin.png',
            type: 'image/png',
            size: 1234,
            url: 'https://tmp.feishu.cn/penguin.png',
          },
        ],
      },
    },
    fields: [
      { field_id: 'fldText', field_name: 'Prompt', type: 1, is_primary: true },
      { field_id: 'fldAttach', field_name: 'Reference', type: 17 },
    ],
  });

  assert.equal(normalized.recordId, 'rec1');
  assert.equal(normalized.rowData.Prompt, '一只企鹅在画布上写提示词');
  assert.deepEqual(normalized.texts, ['一只企鹅在画布上写提示词', '9']);
  assert.equal(normalized.media[0]?.kind, 'image');
  assert.equal(normalized.media[0]?.fileToken, 'boxcnImageToken');
  assert.equal(normalized.media[0]?.url, 'https://tmp.feishu.cn/penguin.png');
});

test('Feishu write mapping formats text and attachment fields without leaking local paths into Bitable', () => {
  const fields = buildFeishuRecordFieldsFromMappings({
    mappings: [
      { targetField: 'T8 描述', targetType: 'text', source: 'allText' },
      { targetField: 'T8 图片', targetType: 'attachment', source: 'images' },
      { targetField: 'T8 状态', targetType: 'text', source: 'status' },
    ],
    texts: ['第一段', '第二段'],
    media: [
      {
        kind: 'image',
        name: 'result.png',
        url: '/files/output/result.png',
        fileToken: 'boxcnUploaded',
      },
    ],
    status: 'success',
  });

  assert.equal(fields['T8 描述'], '第一段\n第二段');
  assert.deepEqual(fields['T8 图片'], [{ file_token: 'boxcnUploaded' }]);
  assert.equal(fields['T8 状态'], 'success');

  assert.throws(
    () => buildFeishuRecordFieldsFromMappings({
      mappings: [{ targetField: 'T8 图片', targetType: 'attachment', source: 'images' }],
      media: [{ kind: 'image', name: 'local.png', url: '/files/output/local.png' }],
    }),
    /fileToken|上传/i,
  );

  const placeholders = buildFeishuRecordFieldsFromMappings({
    mappings: [{ targetField: 'T8 图片', targetType: 'attachment', source: 'images' }],
    media: [{ kind: 'image', name: 'local.png', url: '/files/output/local.png' }],
    allowLocalAttachmentPlaceholders: true,
  });
  assert.deepEqual(placeholders['T8 图片'], [{ name: 'local.png', url: '/files/output/local.png', kind: 'image' }]);
});

test('Feishu row metadata can travel through canvas data and build original-record updates', () => {
  const row = normalizeFeishuBitableRecord({
    appToken: 'bascnDemoToken',
    tableId: 'tblDemo123',
    record: {
      record_id: 'recOriginal',
      fields: {
        Prompt: '生成一张蓝色陶瓷杯',
        Result: '',
      },
    },
    fields: [
      { field_id: 'fldPrompt', field_name: 'Prompt', type: 1 },
      { field_id: 'fldResult', field_name: 'Result', type: 1 },
    ],
  });

  const rows = collectFeishuBitableRowsFromNodeData({
    feishuRows: [row],
    metadata: {
      feishuBitable: {
        appToken: 'bascnDemoToken',
        tableId: 'tblDemo123',
        rows: [row],
      },
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.recordId, 'recOriginal');
  assert.equal(rows[0]?.appToken, 'bascnDemoToken');
  assert.equal(rows[0]?.tableId, 'tblDemo123');

  const writeRecords = createFeishuBitableWriteRecords({
    rows,
    mappings: [
      { targetField: 'Result', targetType: 'text', source: 'firstText' },
      { targetField: 'T8状态', targetType: 'text', source: 'status' },
    ],
    texts: ['蓝色陶瓷杯已经生成'],
    media: [],
    status: 'success',
    mode: 'update',
  });

  assert.deepEqual(writeRecords, [
    {
      recordId: 'recOriginal',
      fields: {
        Result: '蓝色陶瓷杯已经生成',
        T8状态: 'success',
      },
    },
  ]);

  assert.throws(
    () => createFeishuBitableWriteRecords({
      rows: [row, { ...row, recordId: 'recSecond' }],
      mappings: [{ targetField: 'Result', targetType: 'text', source: 'firstText' }],
      texts: ['只有一条结果'],
      media: [],
      status: 'success',
      mode: 'update',
    }),
    /数量|记录|一一对应/,
  );
});

test('Feishu OpenAPI base is locked to official hosts and credentials are masked', () => {
  assert.equal(assertFeishuOpenApiBase('https://open.feishu.cn/open-apis/foo'), 'https://open.feishu.cn');
  assert.equal(assertFeishuOpenApiBase('https://open.larksuite.com'), 'https://open.larksuite.com');
  assert.throws(() => assertFeishuOpenApiBase('https://example.com'), /官方|official|Feishu|Lark/i);
  assert.throws(() => assertFeishuOpenApiBase('https://open.feishu.cn:8443'), /官方|official|Feishu|Lark|端口/i);

  assert.deepEqual(
    maskFeishuCredential({ appId: 'cli_aabbccdd', appSecret: 'sec_1234567890' }),
    {
      appId: 'cli_****ccdd',
      appSecret: 'sec_****7890',
      hasAppId: true,
      hasAppSecret: true,
    },
  );
});

test('Feishu backend route helpers keep secrets private and resolve only known local upload URLs', async () => {
  const route = require('../backend/src/routes/feishuBitable.js');
  const helpers = route.__test__;
  assert.ok(helpers, 'backend route should expose test helpers');

  assert.equal(helpers.resolveFeishuApiBase('https://open.feishu.cn/open-apis'), 'https://open.feishu.cn');
  assert.equal(helpers.resolveFeishuApiBase('https://open.larksuite.com'), 'https://open.larksuite.com');
  assert.throws(() => helpers.resolveFeishuApiBase('https://evil.invalid'), /官方|official|Feishu|Lark/i);
  assert.throws(() => helpers.resolveFeishuApiBase('https://open.feishu.cn:8443'), /官方|official|Feishu|Lark|端口/i);

  const masked = helpers.maskFeishuSettings({ appId: 'cli_xxyyzz99', appSecret: 'top_secret_123456' });
  assert.equal(masked.hasAppSecret, true);
  assert.doesNotMatch(JSON.stringify(masked), /top_secret_123456/);

  const resolved = helpers.resolveKnownLocalFile('/files/output/demo/result.png');
  assert.match(resolved.replace(/\\/g, '/'), /\/output\/demo\/result\.png$/);
  assert.equal(helpers.resolveKnownLocalFile('https://cdn.example.com/result.png'), null);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('unexpected fetch for unsafe path');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => helpers.normalizeWriteFields(
        { apiBase: 'https://open.feishu.cn', appId: 'cli_mock_app', appSecret: 'mock_secret' },
        'bascnDemoToken',
        { T8附件: [{ name: 'package.json', path: join(process.cwd(), 'package.json') }] },
      ),
      /只允许|input\/output|路径越界/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Feishu backend route talks to mocked official OpenAPI for fields, paged records and attachment update', async () => {
  const express = require('express');
  const route = require('../backend/src/routes/feishuBitable.js');
  const helpers = route.__test__;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/feishu-bitable', route);

  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/feishu-bitable`;

  const privateFile = helpers.PRIVATE_FILE as string;
  const previousPrivate = existsSync(privateFile) ? readFileSync(privateFile) : null;
  const outputFile = join(process.cwd(), 'output', 'feishu-route-test', 'result.png');
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, Buffer.from('mock image bytes'));

  const originalFetch = globalThis.fetch;
  const feishuCalls: Array<{ url: string; method: string; body?: any }> = [];
  const updateBodies: any[] = [];

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const urlText = String(url);
    if (urlText.startsWith('http://127.0.0.1:')) {
      return originalFetch(url, init);
    }

    const method = String(init?.method || 'GET');
    let body: any = undefined;
    if (typeof init?.body === 'string') {
      body = JSON.parse(init.body);
    }
    feishuCalls.push({ url: urlText, method, body });

    if (urlText.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, tenant_access_token: 'tenant-mock-token', expire: 7200 });
    }
    if (urlText.includes('/fields')) {
      return jsonResponse({
        code: 0,
        data: {
          items: [
            { field_id: 'fldPrompt', field_name: 'Prompt', type: 1 },
            { field_id: 'fldAttach', field_name: 'T8附件', type: 17 },
          ],
          has_more: false,
        },
      });
    }
    if (urlText.includes('/records/search')) {
      const isSecondPage = urlText.includes('page_token=page-2');
      return jsonResponse({
        code: 0,
        data: {
          items: [
            {
              record_id: isSecondPage ? 'rec2' : 'rec1',
              fields: {
                Prompt: isSecondPage ? '第二条' : '第一条',
              },
            },
          ],
          has_more: !isSecondPage,
          page_token: isSecondPage ? '' : 'page-2',
        },
      });
    }
    if (urlText.endsWith('/open-apis/drive/v1/medias/upload_all')) {
      return jsonResponse({ code: 0, data: { file_token: 'boxcnUploaded' } });
    }
    if (urlText.includes('/records/rec1')) {
      updateBodies.push(body);
      return jsonResponse({
        code: 0,
        data: {
          record: {
            record_id: 'rec1',
            fields: body.fields,
          },
        },
      });
    }
    return jsonResponse({ code: 999, msg: `unhandled ${urlText}` }, 500);
  }) as typeof fetch;

  async function postJson(path: string, payload: any) {
    const resp = await originalFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await resp.json();
    assert.equal(resp.ok, true, JSON.stringify(json));
    return json;
  }

  try {
    await postJson('/settings', {
      apiBase: 'https://open.feishu.cn',
      appId: 'cli_mock_app',
      appSecret: 'mock_secret',
    });

    const fields = await postJson('/fields', {
      appToken: 'bascnDemoToken',
      tableId: 'tblDemo123',
    });
    assert.equal(fields.data.items.length, 2);

    const records = await postJson('/records/search', {
      appToken: 'bascnDemoToken',
      tableId: 'tblDemo123',
      pageSize: 1,
      limit: 2,
    });
    assert.deepEqual(records.data.items.map((item: any) => item.record_id), ['rec1', 'rec2']);

    const written = await postJson('/records/write', {
      appToken: 'bascnDemoToken',
      tableId: 'tblDemo123',
      mode: 'update',
      records: [
        {
          recordId: 'rec1',
          fields: {
            T8附件: [{ name: 'result.png', url: '/files/output/feishu-route-test/result.png' }],
            T8状态: 'success',
          },
        },
      ],
    });

    assert.equal(written.data.items[0].record_id, 'rec1');
    assert.deepEqual(updateBodies[0].fields.T8附件, [{ file_token: 'boxcnUploaded' }]);
    assert.equal(updateBodies[0].fields.T8状态, 'success');
    assert.ok(feishuCalls.some((call) => call.url.includes('/records/search?page_size=1&page_token=page-2')));
    assert.ok(feishuCalls.some((call) => call.url.endsWith('/open-apis/drive/v1/medias/upload_all')));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousPrivate) {
      writeFileSync(privateFile, previousPrivate);
    } else if (existsSync(privateFile)) {
      rmSync(privateFile);
    }
    rmSync(dirname(outputFile), { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('Feishu backend route treats string non-zero OpenAPI code as a failed call', async () => {
  const express = require('express');
  const route = require('../backend/src/routes/feishuBitable.js');
  const helpers = route.__test__;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/feishu-bitable', route);

  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/feishu-bitable`;

  const privateFile = helpers.PRIVATE_FILE as string;
  const previousPrivate = existsSync(privateFile) ? readFileSync(privateFile) : null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const urlText = String(url);
    if (urlText.startsWith('http://127.0.0.1:')) {
      return originalFetch(url, init);
    }
    if (urlText.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse({ code: 0, tenant_access_token: 'tenant-mock-token', expire: 7200 });
    }
    if (urlText.includes('/fields')) {
      return jsonResponse({ code: '1254001', msg: 'permission denied: missing bitable scope' });
    }
    return jsonResponse({ code: 0, data: {} });
  }) as typeof fetch;

  try {
    await originalFetch(`${base}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiBase: 'https://open.feishu.cn',
        appId: 'cli_mock_app',
        appSecret: 'mock_secret',
      }),
    });
    const resp = await originalFetch(`${base}/fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appToken: 'bascnDemoToken',
        tableId: 'tblDemo123',
      }),
    });
    const json = await resp.json();
    assert.equal(resp.ok, false);
    assert.equal(json.success, false);
    assert.match(json.error, /permission denied|bitable scope/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousPrivate) {
      writeFileSync(privateFile, previousPrivate);
    } else if (existsSync(privateFile)) {
      rmSync(privateFile);
    }
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('Feishu Bitable nodes are registered, runnable, typed and packaged with backend route', () => {
  assertProductionNodeSchema('feishu-bitable-input', {
    label: '飞书多维表格输入',
    category: 'input',
    inputs: [],
    outputs: ['text', 'image', 'video', 'audio', 'metadata'],
    executable: true,
  });
  assertProductionNodeSchema('feishu-bitable-output', {
    label: '飞书多维表格输出',
    category: 'input',
    inputs: ['text', 'image', 'video', 'audio', 'metadata', 'any'],
    outputs: ['text', 'metadata'],
    executable: true,
  });
  assert.match(read('src/types/canvas.ts'), /\| 'feishu-bitable-input'/);
  assert.match(read('src/types/canvas.ts'), /\| 'feishu-bitable-output'/);

  const canvas = read('src/components/Canvas.tsx');
  assert.match(canvas, /FeishuBitableInputNode/);
  assert.match(canvas, /FeishuBitableOutputNode/);
  assert.match(canvas, /'feishu-bitable-input': FeishuBitableInputNode/);
  assert.match(canvas, /'feishu-bitable-output': FeishuBitableOutputNode/);
  assert.match(canvas, /'feishu-bitable-input'/);
  assert.match(canvas, /'feishu-bitable-output'/);

  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /data-feishu-bitable-input-node/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /粘贴飞书多维表格链接/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /w-\[520px\]/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /max-h-36/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /加载字段/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /拉取记录/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /downloadFeishuBitableMedia/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /if \(!item\.fileToken\) continue/);
  assert.doesNotMatch(read('src/components/nodes/FeishuBitableInputNode.tsx'), /item\.url \|\| !item\.fileToken/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /不写入画布/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /添加为多维表格协作者/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /bitable:app/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /getFeishuBitableFields\(\{[\s\S]*appToken: resolvedLocation\.appToken[\s\S]*tableId: resolvedLocation\.tableId[\s\S]*apiBase[\s\S]*\}\)/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /飞书连接正常，表格可访问/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /飞书凭证正常，但当前表格不可访问/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /resolveFeishuBitableLocation/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /metadata:\s*\{[\s\S]*feishuBitable/);
  assert.match(read('src/components/nodes/FeishuBitableInputNode.tsx'), /feishuBitableRows/);
  const outputNodeSource = read('src/components/nodes/FeishuBitableOutputNode.tsx');
  assert.match(outputNodeSource, /data-feishu-bitable-output-node/);
  assert.match(outputNodeSource, /预检/);
  assert.match(outputNodeSource, /w-\[500px\]/);
  assert.match(outputNodeSource, /max-h-36/);
  assert.match(outputNodeSource, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(outputNodeSource, /字段映射/);
  assert.match(outputNodeSource, /写回飞书/);
  assert.match(outputNodeSource, /upload_all/);
  assert.match(outputNodeSource, /20MB/);
  assert.match(outputNodeSource, /collectFeishuBitableRowsFromNodeData/);
  assert.match(outputNodeSource, /resolveFeishuBitableLocation/);
  assert.match(outputNodeSource, /自动写回原记录/);
  assert.match(outputNodeSource, /继承上游表格/);
  assert.match(outputNodeSource, /添加为多维表格协作者/);
  assert.match(outputNodeSource, /App ID，只保存到本机后端/);
  assert.match(outputNodeSource, /App Secret，不写入画布/);
  assert.match(outputNodeSource, /getFeishuBitableFields\(\{ appToken: resolvedAppToken, tableId: resolvedTableId, apiBase \}\)/);
  assert.match(outputNodeSource, /飞书连接正常，表格可访问/);
  assert.match(outputNodeSource, /飞书凭证正常，但当前表格不可访问/);
  assert.match(outputNodeSource, /createFeishuBitableWriteRecords/);
  assert.match(outputNodeSource, /feishuWriteMode === 'create' \|\| d\.feishuWriteMode === 'update' \? d\.feishuWriteMode : 'auto'/);
  assert.match(outputNodeSource, /modeSetting === 'auto' && \(upstreamFeishuRows\.length > 0 \|\| recordId\)/);
  assert.match(outputNodeSource, /getFeishuBitableFields\(\{ appToken: resolvedAppToken, tableId: resolvedTableId, apiBase \}\)/);
  assert.match(outputNodeSource, /预检完成，将更新 \$\{drafts\.length\} 条原记录/);
  assert.match(outputNodeSource, /已更新 \$\{written\.length \|\| drafts\.length \|\| 1\} 条原记录/);
  assert.match(canvas, /feishuWriteMode: 'auto'/);

  assert.match(read('backend/src/server.js'), /feishuBitableRouter/);
  assert.match(read('backend/src/server.js'), /\/api\/feishu-bitable/);
  assert.match(read('backend/src/routes/feishuBitable.js'), /\/media\/download/);
  assert.match(read('backend/src/routes/feishuBitable.js'), /drive\/v1\/medias\/.*download/);
  assert.match(read('electron/_post_build.cjs'), /feishuBitable\.t8c/);
});
