import { INode } from 'markmap-common';

export interface IMarkmapState {
  id: string;
  data?: INode;
  highlight?: INode;
  rect: {
    x1: number;
    x2: number;
    y1: number;
    y2: number;
  };
}

/**
 * Portable options that can be derived into `IMarkmapOptions`.
 */
export interface IMarkmapJSONOptions {
  autoFit: boolean;
  color: string[];
  colorFreezeLevel: number;
  duration: number;
  extraCss: string[];
  extraJs: string[];
  fitRatio: number;
  initialExpandLevel: number;
  maxInitialScale: number;
  maxWidth: number;
  nodeMinHeight: number;
  paddingX: number;
  pan: boolean;
  spacingHorizontal: number;
  spacingVertical: number;
  zoom: boolean;
  lineWidth: number | number[];
}

export interface IMarkmapOptions {
  autoFit: boolean;
  duration: number;
  embedGlobalCSS: boolean;
  fitRatio: number;
  id?: string;
  initialExpandLevel: number;
  maxInitialScale: number;
  pan: boolean;
  scrollForPan: boolean;
  style?: (id: string) => string;
  toggleRecursively: boolean;
  zoom: boolean;

  /** Layout direction: 'right' (default), 'both' (both sides), or 'down' (top-down tree). */
  direction?: 'right' | 'both' | 'down';
  /** Connector geometry. Defaults to the existing curved links. */
  linkShape?: 'curve' | 'orthogonal' | 'rounded-orthogonal';
  /** Radius for rounded orthogonal connectors. Defaults to 8. */
  linkRadius?: number;
  /**
   * Vertical attachment point for connectors. Defaults to the node's bottom edge.
   */
  linkAnchor?: (node: INode) => 'bottom' | 'center';

  // Theme options
  color: (node: INode) => string;
  lineWidth: (node: INode) => number;
  maxWidth: number;
  nodeMinHeight: number;
  paddingX: number;
  spacingHorizontal: number;
  spacingVertical: number;
}

export interface IPadding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type ID3SVGElement = d3.Selection<SVGElement, INode, HTMLElement, INode>;
