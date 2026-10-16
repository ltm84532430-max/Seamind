import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const sourcePath = (packageName: string) =>
  fileURLToPath(
    new URL(`../../packages/${packageName}/src/index.ts`, import.meta.url),
  );

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: true,
  },
  css: {
    postcss: {
      plugins: [],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  resolve: {
    alias: [
      { find: 'markmap-lib', replacement: sourcePath('markmap-lib') },
      { find: 'markmap-view', replacement: sourcePath('markmap-view') },
      { find: 'markmap-common', replacement: sourcePath('markmap-common') },
      {
        find: 'markmap-html-parser',
        replacement: sourcePath('markmap-html-parser'),
      },
    ],
  },
  define: {
    '__define__.LIB_VERSION': JSON.stringify('0.18.12'),
    '__define__.VIEW_VERSION': JSON.stringify('0.18.12'),
    '__define__.PRISM_VERSION': JSON.stringify('1.29.0'),
    '__define__.HLJS_VERSION': JSON.stringify('11.8.0'),
    '__define__.KATEX_VERSION': JSON.stringify('0.16.8'),
    '__define__.KATEX_RESOURCES': JSON.stringify([]),
    '__define__.WEBFONTLOADER_VERSION': JSON.stringify('1.6.28'),
    '__define__.NO_PLUGINS': 'true',
  },
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
