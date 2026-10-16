import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { createReadStream, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pyodideDirectory = dirname(require.resolve('pyodide'));
const pyodideFiles = [
  'pyodide.mjs',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
];

function pyodideAssetsPlugin(): Plugin {
  const serveFiles = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use('/pyodide', (request, response, next) => {
      const fileName = basename(
        new URL(request.url ?? '/', 'http://localhost').pathname,
      );
      if (!pyodideFiles.includes(fileName)) return next();
      const filePath = join(pyodideDirectory, fileName);
      const contentTypes: Record<string, string> = {
        '.json': 'application/json',
        '.mjs': 'text/javascript; charset=utf-8',
        '.wasm': 'application/wasm',
        '.zip': 'application/zip',
      };
      response.statusCode = 200;
      response.setHeader(
        'Content-Type',
        contentTypes[extname(fileName)] ?? 'application/octet-stream',
      );
      createReadStream(filePath).pipe(response);
    });
  };

  return {
    name: 'seamind-pyodide-assets',
    configureServer: serveFiles,
    configurePreviewServer: serveFiles,
    generateBundle() {
      pyodideFiles.forEach((fileName) => {
        this.emitFile({
          type: 'asset',
          fileName: `pyodide/${fileName}`,
          source: readFileSync(join(pyodideDirectory, fileName)),
        });
      });
    },
  };
}

const sourcePath = (packageName: string) =>
  fileURLToPath(
    new URL(`../../packages/${packageName}/src/index.ts`, import.meta.url),
  );

export default defineConfig({
  plugins: [react(), pyodideAssetsPlugin()],
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
