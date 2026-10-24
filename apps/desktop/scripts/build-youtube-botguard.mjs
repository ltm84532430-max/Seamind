import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const outDir = process.env.SEAMIND_BOTGUARD_OUT_DIR;

if (!outDir) throw new Error('SEAMIND_BOTGUARD_OUT_DIR is required.');

await build({
  configFile: false,
  root: desktopDir,
  logLevel: 'error',
  build: {
    outDir,
    emptyOutDir: false,
    minify: true,
    lib: {
      entry: path.join(desktopDir, 'src/youtube-botguard-runtime.ts'),
      name: 'SeamindYouTubeBotGuard',
      formats: ['iife'],
      fileName: () => 'youtube_botguard_runtime.js',
    },
  },
});
