declare module 'markmap-lib' {
  export interface PureNode {
    content: string;
    payload?: { fold?: number };
    children: PureNode[];
  }

  export class Transformer {
    md: { set(options: { html?: boolean }): void };
    constructor(plugins?: unknown[]);
    transform(content: string): { root: PureNode };
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
