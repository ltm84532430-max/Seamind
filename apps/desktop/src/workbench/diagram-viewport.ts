export interface Viewport {
  /** Where the diagram's top-left corner sits in the frame, in pixels. */
  x: number;
  y: number;
  scale: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

const FIT_PADDING = 24;
/** A small diagram is shown a little larger than life when fitted, never blown up past this. */
const MAX_FIT_SCALE = 1.6;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Scales the diagram to fit the frame with some padding, centred. */
export function fitViewport(
  content: Size,
  frame: Size,
  options: { padding?: number; maxScale?: number } = {},
): Viewport {
  if (
    content.width <= 0 ||
    content.height <= 0 ||
    frame.width <= 0 ||
    frame.height <= 0
  )
    return { x: 0, y: 0, scale: 1 };
  const padding = options.padding ?? FIT_PADDING;
  const scale = clampScale(
    Math.min(
      Math.max(1, frame.width - padding * 2) / content.width,
      Math.max(1, frame.height - padding * 2) / content.height,
      options.maxScale ?? MAX_FIT_SCALE,
    ),
  );
  return {
    scale,
    x: (frame.width - content.width * scale) / 2,
    y: (frame.height - content.height * scale) / 2,
  };
}

/** Zooms by `factor` while the point under `anchor` (frame pixels) stays where it is. */
export function zoomAt(
  view: Viewport,
  factor: number,
  anchor: { x: number; y: number },
): Viewport {
  const scale = clampScale(view.scale * factor);
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}

export function panBy(view: Viewport, dx: number, dy: number): Viewport {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/**
 * Puts the CSS custom properties a diagram draws with onto its root `<svg>`, so a copy saved on
 * its own looks like the one on screen. Without them its colours fall back to Pele's defaults.
 */
export function inlineSvgVariables(
  svg: string,
  variables: Record<string, string>,
): string {
  const declarations = Object.entries(variables)
    .map(([name, value]) => [name, value.replace(/[;"<>\r\n]/g, '').trim()])
    .filter(([name, value]) => /^--[\w-]+$/.test(name) && value)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  if (!declarations || !svg.startsWith('<svg')) return svg;

  // The end of the root start tag, skipping over quoted attribute values.
  let quote = '';
  let end = -1;
  for (let index = 4; index < svg.length; index += 1) {
    const char = svg[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      end = index;
      break;
    }
  }
  if (end < 0) return svg;

  const rootTag = svg.slice(0, end);
  const styled = /\sstyle="/.test(rootTag)
    ? rootTag.replace(/(\sstyle=")/, `$1${declarations};`)
    : `${rootTag} style="${declarations}"`;
  return styled + svg.slice(end);
}
