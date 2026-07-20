import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';

const LOCAL_EXTENSIONS_MODULE = 'virtual:t8-local-extensions';
const LOCAL_EXTENSIONS_ENTRY = path.resolve(__dirname, 'local-private', 'extensions', 'frontend', 'index.tsx');
const LOCAL_REQUIRED_FRONTEND_ENTRY = path.resolve(
  __dirname,
  'local-private',
  ['re', 'charge'].join(''),
  'frontend',
  ['Re', 'charge', 'Modal.tsx'].join(''),
);
const EMPTY_EXTENSIONS_ENTRY = path.resolve(__dirname, 'src', 'extensions', 'emptyLocalExtensions.tsx');
const APP_VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version;
const MANAGEMENT_AUTHORITY_FILE = path.resolve(__dirname, '.t8-collaboration-management-authority.json');
const MANAGEMENT_AUTHORITY_SCHEMA = 't8-collaboration-management-authority-v1';
const MANAGEMENT_AUTHORITY_HEADER = 'x-t8-collaboration-management-token';
const MANAGEMENT_AUTHORITY_CREATE_WAIT = new Int32Array(new SharedArrayBuffer(4));

function normalizedManagementAuthorityToken(value: unknown): string {
  const token = String(value || '').trim();
  return /^[A-Za-z0-9_-]{43,128}$/.test(token) ? token : '';
}

function readManagementAuthority(): string {
  let record: { schema?: string; token?: string };
  try {
    record = JSON.parse(fs.readFileSync(MANAGEMENT_AUTHORITY_FILE, 'utf8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return '';
    throw new Error('Vite 无法读取本地协作管理 authority 文件');
  }
  const token = record?.schema === MANAGEMENT_AUTHORITY_SCHEMA
    ? normalizedManagementAuthorityToken(record.token)
    : '';
  if (!token) throw new Error('Vite 本地协作管理 authority 文件格式无效');
  return token;
}

function readManagementAuthorityAfterConcurrentCreate(): string {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const token = readManagementAuthority();
      if (token) return token;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 19) Atomics.wait(MANAGEMENT_AUTHORITY_CREATE_WAIT, 0, 0, 10);
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('Vite 本地协作管理 authority 文件并发创建未完成');
}

function ensureManagementAuthority(): string {
  const existing = readManagementAuthority();
  if (existing) return existing;
  const token = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(MANAGEMENT_AUTHORITY_FILE, `${JSON.stringify({
      schema: MANAGEMENT_AUTHORITY_SCHEMA,
      version: 1,
      token,
    }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try { fs.chmodSync(MANAGEMENT_AUTHORITY_FILE, 0o600); } catch (_) {}
    return token;
  } catch (error: any) {
    if (error?.code === 'EEXIST') return readManagementAuthorityAfterConcurrentCreate();
    throw new Error('Vite 无法安全创建本地协作管理 authority 文件');
  }
}

function collaborationManagementProxy(token: string): ProxyOptions {
  return {
    target: 'http://127.0.0.1:18766',
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (proxyRequest, request) => {
        const pathname = new URL(String(request.url || '/'), 'http://127.0.0.1').pathname;
        if (pathname === '/api/collaboration' || pathname.startsWith('/api/collaboration/')) {
          proxyRequest.setHeader(MANAGEMENT_AUTHORITY_HEADER, token);
        }
      });
    },
  };
}

function requireLocalPrivateFrontend() {
  if (process.env.T8_REQUIRE_LOCAL_PRIVATE !== '1') return;
  const missing = [LOCAL_EXTENSIONS_ENTRY, LOCAL_REQUIRED_FRONTEND_ENTRY].filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`[t8-local-extensions] formal release requires local private frontend: ${missing.join(', ')}`);
  }
}

function localExtensionsPlugin() {
  requireLocalPrivateFrontend();
  return {
    name: 't8-local-extensions',
    resolveId(id: string) {
      if (id !== LOCAL_EXTENSIONS_MODULE) return null;
      const disabled = process.env.T8_ENABLE_LOCAL_PRIVATE === '0'
        || process.env.T8_DISABLE_LOCAL_EXTENSIONS === '1';
      if (process.env.T8_REQUIRE_LOCAL_PRIVATE === '1' && disabled) {
        throw new Error('[t8-local-extensions] formal release cannot disable local private extensions');
      }
      const enabled = !disabled;
      return enabled && fs.existsSync(LOCAL_EXTENSIONS_ENTRY)
        ? LOCAL_EXTENSIONS_ENTRY
        : EMPTY_EXTENSIONS_ENTRY;
    },
  };
}

// T8-penguin-canvas Vite 配置
// 端口策略:前端 11422 / 后端 18766(避开主项目 5176/18765 与常见 51xx 占用)
export default defineConfig(({ command }) => {
  const managementToken = command === 'serve' ? ensureManagementAuthority() : '';
  return {
  plugins: [react(), localExtensionsPlugin()],
  assetsInclude: ['**/*.mid'],
  optimizeDeps: {
    include: [
      '@xyflow/react',
      'lucide-react',
      'react',
      'react-dom',
      'react-dom/client',
      'zustand',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 11422,
    strictPort: true,
    host: '127.0.0.1',
    warmup: {
      clientFiles: [
        './src/main.tsx',
        './src/App.tsx',
        './src/components/Canvas.tsx',
        './src/components/nodes/ImageNode.tsx',
        './src/components/nodes/UploadNode.tsx',
        './src/components/nodes/OutputNode.tsx',
      ],
    },
    proxy: {
      ...(managementToken ? {
        '/api/collaboration': collaborationManagementProxy(managementToken),
      } : {}),
      // 后端 API 代理
      '/api': {
        target: 'http://127.0.0.1:18766',
        changeOrigin: true,
      },
      // 静态文件服务代理
      '/files': {
        target: 'http://127.0.0.1:18766',
        changeOrigin: true,
      },
      '/output': {
        target: 'http://127.0.0.1:18766',
        changeOrigin: true,
      },
      '/input': {
        target: 'http://127.0.0.1:18766',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'xyflow': ['@xyflow/react'],
        },
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_NAME__: JSON.stringify('T8-penguin-canvas'),
  },
  };
});
