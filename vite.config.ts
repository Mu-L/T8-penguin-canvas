import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

const LOCAL_EXTENSIONS_MODULE = 'virtual:t8-local-extensions';
const LOCAL_EXTENSIONS_ENTRY = path.resolve(__dirname, 'local-private', 'extensions', 'frontend', 'index.tsx');
const LOCAL_RECHARGE_ENTRY = path.resolve(__dirname, 'local-private', 'recharge', 'frontend', 'RechargeModal.tsx');
const EMPTY_EXTENSIONS_ENTRY = path.resolve(__dirname, 'src', 'extensions', 'emptyLocalExtensions.tsx');
const APP_VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version;

function requireLocalPrivateFrontend() {
  if (process.env.T8_REQUIRE_LOCAL_PRIVATE !== '1') return;
  const missing = [LOCAL_EXTENSIONS_ENTRY, LOCAL_RECHARGE_ENTRY].filter((file) => !fs.existsSync(file));
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
export default defineConfig({
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
});
