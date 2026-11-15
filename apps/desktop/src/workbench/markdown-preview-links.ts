const PREVIEW_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:$|[?#])/i;
const PREVIEW_IMAGE_PARAM_RE = /^(?:png|jpe?g|gif|webp|avif)$/i;

/** Returns true when a URL points directly to a raster or SVG image resource. */
export function isPreviewImageHref(href: string): boolean {
  const value = href.trim();
  if (!value) return false;
  if (/^data:image\//i.test(value)) return true;
  if (/^asset:/i.test(value) && PREVIEW_IMAGE_EXT_RE.test(value)) return true;
  try {
    const parsed = new URL(value, 'https://seamind.local');
    if (PREVIEW_IMAGE_EXT_RE.test(parsed.pathname)) return true;
    const formatParam =
      parsed.searchParams.get('format') ||
      parsed.searchParams.get('fm') ||
      parsed.searchParams.get('ext') ||
      '';
    return PREVIEW_IMAGE_PARAM_RE.test(formatParam);
  } catch {
    return PREVIEW_IMAGE_EXT_RE.test(value);
  }
}

export function clampLightboxZoom(next: number): number {
  const rounded = Math.round(next * 100) / 100;
  return Math.min(4, Math.max(0.5, rounded));
}

export type PreviewLinkAction =
  | { kind: 'hash'; id: string }
  | { kind: 'image'; url: string }
  | { kind: 'external'; url: string }
  | { kind: 'block' };

/**
 * Classifies non-footnote, non-wikilink, non-YouTube `<a href>` clicks inside
 * `MarkdownPreview` so Tauri's main WebView never navigates away from the app.
 */
export function classifyPreviewLinkHref(rawHref: string): PreviewLinkAction {
  const href = rawHref.trim();
  if (!href) return { kind: 'block' };
  if (href.startsWith('#')) {
    return { kind: 'hash', id: href.slice(1) };
  }
  if (isPreviewImageHref(href)) {
    return { kind: 'image', url: href };
  }
  try {
    const parsed = new URL(href);
    if (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'mailto:' ||
      parsed.protocol === 'tel:'
    ) {
      return { kind: 'external', url: href };
    }
  } catch {
    // Disallow relative in-frame navigation inside the desktop SPA window.
  }
  return { kind: 'block' };
}
