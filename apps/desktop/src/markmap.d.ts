declare module 'markmap-lib' {
  interface MarkdownItToken {
    info: string;
    content: string;
  }

  interface MarkdownItRenderer {
    renderToken(
      tokens: MarkdownItToken[],
      index: number,
      options: unknown,
    ): string;
  }

  type MarkdownFenceRenderer = (
    tokens: MarkdownItToken[],
    index: number,
    options: unknown,
    env: unknown,
    renderer: MarkdownItRenderer,
  ) => string;

  interface MarkdownItLike {
    set(options: { html?: boolean }): void;
    use(plugin: unknown, options?: unknown): MarkdownItLike;
    renderer: { rules: { fence?: MarkdownFenceRenderer } };
  }

  export interface PureNode {
    content: string;
    payload?: { fold?: number; [key: string]: unknown };
    children: PureNode[];
  }

  export class Transformer {
    md: MarkdownItLike;
    constructor(plugins?: unknown[]);
    transform(
      content: string,
      fallbackParserOptions?: object,
    ): {
      root: PureNode;
    };
  }
}

declare module 'markmap-view' {
  import type { PureNode } from 'markmap-lib';

  export interface IMarkmapOptions {
    autoFit?: boolean;
    duration?: number;
    spacingHorizontal?: number;
    spacingVertical?: number;
    direction?: 'right' | 'both' | 'down';
    linkShape?: 'curve' | 'orthogonal' | 'rounded-orthogonal';
    linkRadius?: number;
    linkAnchor?: (node: any) => 'bottom' | 'center';
    lineWidth?: (node: any) => number;
    color?: (node: any) => string;
    [key: string]: unknown;
  }

  export class Markmap {
    options: IMarkmapOptions;
    state?: {
      data?: any;
      id?: string;
      rect?: { x1: number; y1: number; x2: number; y2: number };
    };
    svg?: any;
    static create(svg: SVGElement, options?: Record<string, unknown>): Markmap;
    setData(
      data?: PureNode | null,
      options?: Record<string, unknown>,
    ): Promise<void>;
    setOptions(options?: Record<string, unknown>): void;
    renderData(originData?: any): Promise<void>;
    fit(): Promise<void>;
    rescale(scale: number): Promise<void>;
    centerNode(node: any, padding?: Record<string, number>): Promise<void>;
    getTransform(): { k: number; x: number; y: number };
    setTransform(k: number, x: number, y: number): void;
    setViewAnchorPath(path?: string): void;
    destroy(): void;
  }
}

declare module 'virtual:seamind-offline-viewer' {
  export const viewerScript: string;
  export const viewerCss: string;
  export const katexCss: string;
}
