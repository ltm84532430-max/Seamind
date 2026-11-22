import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import postcssNested from 'postcss-nested';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { createReadStream, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktopRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const OFFLINE_VIEWER_VIRTUAL_ID = 'virtual:seamind-offline-viewer';
const OFFLINE_VIEWER_RESOLVED_ID = `\0${OFFLINE_VIEWER_VIRTUAL_ID}`;

function keepOfflineSelector(selector: string): boolean {
  return /(?:^|[\s,>~+])(?::root|html|body|\.app-shell|\.markmap|\.seamind-|\.mm-code-lightbox|\.mm-offline-)/i.test(
    selector,
  );
}

function inlineKatexFontsCss(): string {
  const katexCssPath = require.resolve('katex/dist/katex.min.css');
  const katexDir = dirname(katexCssPath);
  const rawCss = readFileSync(katexCssPath, 'utf8');
  // Replace @font-face src lists with base64-inlined woff2 fonts so formulas render cleanly offline.
  return rawCss.replace(/@font-face\{[^}]+\}/g, (block) => {
    const woff2Match = block.match(/url\((fonts\/[^)]+\.woff2)\)/);
    if (!woff2Match) return '';
    const fontPath = join(katexDir, woff2Match[1]);
    try {
      const b64 = readFileSync(fontPath).toString('base64');
      return block.replace(
        /src:[^;}]+/,
        `src:url("data:font/woff2;base64,${b64}") format("woff2")`,
      );
    } catch {
      return '';
    }
  });
}

function seamindOfflineViewerPlugin(): Plugin {
  let cachedModuleCode: string | null = null;
  let devServer: ViteDevServer | null = null;
  const offlineStyleFiles = [
    join(desktopRoot, 'src/styles.css'),
    join(desktopRoot, 'src/themes-extended.css'),
    join(desktopRoot, 'src/mindmap/offline-viewer.css'),
  ];
  const watchedFiles = new Set<string>();
  const watchKey = (file: string) => resolve(file).toLowerCase();
  const updateWatchedFiles = (files: string[]) => {
    files.forEach((file) => watchedFiles.add(watchKey(file)));
    devServer?.watcher.add(files);
  };

  const compileOfflineViewerModule = async (): Promise<string> => {
    if (cachedModuleCode && process.env.VITEST) return cachedModuleCode;
    const viteDir = dirname(require.resolve('vite/package.json'));
    const esbuildPath = require.resolve('esbuild', { paths: [viteDir] });
    const postcssPath = require.resolve('postcss', { paths: [viteDir] });
    const esbuild = require(esbuildPath) as {
      build: (opts: Record<string, unknown>) => Promise<{
        outputFiles: Array<{ text: string }>;
        metafile: { inputs: Record<string, unknown> };
      }>;
      transform: (
        input: string,
        opts: Record<string, unknown>,
      ) => Promise<{ code: string }>;
    };
    type Postcss = (plugins?: unknown[]) => {
      process: (css: string, opts?: Record<string, unknown>) => { root: any };
    };
    const postcssRaw = require(postcssPath) as Postcss | { default: Postcss };
    const postcss =
      typeof postcssRaw === 'function' ? postcssRaw : postcssRaw.default;

    const entryPath = join(desktopRoot, 'src/mindmap/offline-viewer-entry.ts');
    const inlineCssPlugin = {
      name: 'seamind-css-inline',
      setup(build: {
        onResolve: (
          opts: { filter: RegExp },
          cb: (args: { path: string; resolveDir: string }) => unknown,
        ) => void;
        onLoad: (
          opts: { filter: RegExp; namespace?: string },
          cb: (args: { path: string }) => unknown,
        ) => void;
      }) {
        build.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
          path: join(args.resolveDir, args.path.replace(/\?inline$/, '')),
          namespace: 'seamind-css-inline',
        }));
        build.onLoad(
          { filter: /.*/, namespace: 'seamind-css-inline' },
          (args) => ({
            contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))};`,
            loader: 'js',
          }),
        );
      },
    };
    const bundled = await esbuild.build({
      entryPoints: [entryPath],
      absWorkingDir: repoRoot,
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome105', 'safari13'],
      minify: true,
      write: false,
      metafile: true,
      plugins: [inlineCssPlugin],
      nodePaths: [
        join(desktopRoot, 'node_modules'),
        join(repoRoot, 'packages/markmap-view/node_modules'),
        join(repoRoot, 'packages/markmap-common/node_modules'),
        join(repoRoot, 'node_modules'),
      ],
      alias: {
        'markmap-view': sourcePath('markmap-view'),
        'markmap-common': sourcePath('markmap-common'),
        'markmap-lib': sourcePath('markmap-lib'),
      },
      define: {
        '__define__.VIEW_VERSION': JSON.stringify('0.18.12'),
      },
    });
    const viewerScript = bundled.outputFiles[0]?.text ?? '';
    updateWatchedFiles([
      ...offlineStyleFiles,
      ...Object.keys(bundled.metafile.inputs)
        .filter((input) => !input.includes('node_modules'))
        .map((input) => resolve(repoRoot, input)),
    ]);

    const stylesCss = readFileSync(join(desktopRoot, 'src/styles.css'), 'utf8');
    const extendedCss = readFileSync(
      join(desktopRoot, 'src/themes-extended.css'),
      'utf8',
    );
    const viewerShellCss = readFileSync(
      join(desktopRoot, 'src/mindmap/offline-viewer.css'),
      'utf8',
    );

    const filterCssRoot = (rawCss: string): string => {
      const root = postcss([postcssNested()]).process(rawCss, {
        from: undefined,
      }).root;
      const filterNodes = (nodes: any[]): any[] => {
        const kept: any[] = [];
        for (const node of nodes) {
          if (node.type === 'rule') {
            const matchedSelectors = (node.selectors || []).filter(
              keepOfflineSelector,
            );
            if (matchedSelectors.length > 0) {
              node.selectors = matchedSelectors;
              kept.push(node);
            }
          } else if (node.type === 'atrule') {
            if (node.name === 'keyframes') {
              kept.push(node);
            } else if (node.nodes?.length) {
              node.nodes = filterNodes(node.nodes);
              if (node.nodes.length > 0) kept.push(node);
            }
          }
        }
        return kept;
      };
      root.nodes = filterNodes(root.nodes || []);
      return root.toString();
    };

    const rawCombinedCss = [
      filterCssRoot(stylesCss),
      filterCssRoot(extendedCss),
      viewerShellCss,
    ].join('\n');
    const minifiedCss = await esbuild.transform(rawCombinedCss, {
      loader: 'css',
      minify: true,
    });
    const katexCss = inlineKatexFontsCss();

    cachedModuleCode = [
      `export const viewerScript = ${JSON.stringify(viewerScript)};`,
      `export const viewerCss = ${JSON.stringify(minifiedCss.code)};`,
      `export const katexCss = ${JSON.stringify(katexCss)};`,
    ].join('\n');
    return cachedModuleCode;
  };

  return {
    name: 'seamind-offline-viewer',
    configureServer(server) {
      devServer = server;
      updateWatchedFiles([
        join(desktopRoot, 'src/mindmap/offline-viewer-entry.ts'),
        ...offlineStyleFiles,
      ]);
    },
    handleHotUpdate(ctx) {
      if (!watchedFiles.has(watchKey(ctx.file))) return;
      cachedModuleCode = null;
      const virtualModule = ctx.server.moduleGraph.getModuleById(
        OFFLINE_VIEWER_RESOLVED_ID,
      );
      if (!virtualModule) return;
      ctx.server.moduleGraph.invalidateModule(virtualModule);
      return [...new Set([...ctx.modules, virtualModule])];
    },
    resolveId(id) {
      if (id === OFFLINE_VIEWER_VIRTUAL_ID) return OFFLINE_VIEWER_RESOLVED_ID;
      return undefined;
    },
    async load(id) {
      if (id !== OFFLINE_VIEWER_RESOLVED_ID) return undefined;
      return compileOfflineViewerModule();
    },
  };
}
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
  plugins: [react(), pyodideAssetsPlugin(), seamindOfflineViewerPlugin()],
  clearScreen: false,
  server: {
    strictPort: true,
  },
  css: {
    postcss: {
      plugins: [postcssNested()],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  resolve: {
    alias: [
      {
        find: 'markmap-lib/plugins',
        replacement: fileURLToPath(
          new URL(
            '../../packages/markmap-lib/src/plugins/index.ts',
            import.meta.url,
          ),
        ),
      },
      { find: /^markmap-lib$/, replacement: sourcePath('markmap-lib') },
      { find: 'markmap-view', replacement: sourcePath('markmap-view') },
      { find: 'markmap-common', replacement: sourcePath('markmap-common') },
      {
        find: 'markmap-html-parser',
        replacement: sourcePath('markmap-html-parser'),
      },
      {
        find: '@pdfjs/pdf.min.mjs',
        replacement: fileURLToPath(
          new URL('./src/ebook/epub-only-reader-pdf.ts', import.meta.url),
        ),
      },
      {
        find: 'construct-style-sheets-polyfill',
        replacement: require.resolve('construct-style-sheets-polyfill'),
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
