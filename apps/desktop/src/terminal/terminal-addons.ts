import { FitAddon } from '@xterm/addon-fit';
import {
  SearchAddon,
  type ISearchResultChangeEvent,
} from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

export interface AttachedXtermAddons {
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  getWebglAddon: () => WebglAddon | null;
  dispose: () => void;
}

export function attachStandardXtermAddons(
  terminal: Terminal,
  options: {
    webglEnabled: boolean;
    onSearchResults?: (res: ISearchResultChangeEvent) => void;
    onWebglStateChange?: (active: boolean) => void;
  },
): AttachedXtermAddons {
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const unicodeAddon = new Unicode11Addon();
  terminal.loadAddon(unicodeAddon);
  terminal.unicode.activeVersion = '11';

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);
  const searchDisp = searchAddon.onDidChangeResults((res) => {
    options.onSearchResults?.(res);
  });

  const webLinksAddon = new WebLinksAddon((_ev, uri) => {
    window.open(uri, '_blank', 'noopener,noreferrer');
  });
  terminal.loadAddon(webLinksAddon);

  let webglAddon: WebglAddon | null = null;
  if (options.webglEnabled) {
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        try {
          webglAddon?.dispose();
        } catch {
          // noop
        }
        webglAddon = null;
        options.onWebglStateChange?.(false);
      });
      terminal.loadAddon(webglAddon);
      options.onWebglStateChange?.(true);
    } catch {
      webglAddon = null;
      options.onWebglStateChange?.(false);
    }
  } else {
    options.onWebglStateChange?.(false);
  }

  return {
    fitAddon,
    searchAddon,
    getWebglAddon: () => webglAddon,
    dispose: () => {
      searchDisp.dispose();
      try {
        webglAddon?.dispose();
      } catch {
        // noop
      }
      webglAddon = null;
      searchAddon.dispose();
    },
  };
}
