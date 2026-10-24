import { defineConfig } from 'vite';

const configEs = defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['d3', 'markmap-common'],
    },
  },
});

const configJs = defineConfig({
  build: {
    emptyOutDir: false,
    outDir: 'dist/browser',
    minify: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['iife'],
      fileName: () => 'index.js',
      name: 'markmap',
    },
    rollupOptions: {
      external: ['d3'],
      output: {
        extend: true,
        globals: {
          d3: 'd3',
        }
      }
    }
  },
});

// The target is chosen with `vite build --mode`, which works in every shell (see build:js).
export default ({ mode }: { mode: string }) =>
  mode === 'es' ? configEs : configJs;
