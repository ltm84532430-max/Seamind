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

  export class Markmap {
    static create(svg: SVGElement, options?: Record<string, unknown>): Markmap;
    setData(data: PureNode): Promise<void>;
    fit(): Promise<void>;
    rescale(scale: number): Promise<void>;
    destroy(): void;
  }
}
