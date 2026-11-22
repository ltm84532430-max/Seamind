import { resolveDocumentMedia } from '../knowledge/document-media';
import { mediaIdFromSource } from '../knowledge/knowledge-paste';

export interface MindmapMediaHydrationOptions {
  signal: AbortSignal;
  /** Saved document that owns `seamind-media:` files. Empty means the map is unsaved. */
  documentRelativePath?: string;
  resolveMedia?: (mediaId: string) => Promise<string>;
  onZoomImage?: (dataUrl: string) => void;
  onStateChange?: () => void;
}

export function mindmapMediaResolver(
  options: Pick<
    MindmapMediaHydrationOptions,
    'resolveMedia' | 'documentRelativePath'
  >,
): ((mediaId: string) => Promise<string>) | undefined {
  if (options.resolveMedia) return options.resolveMedia;
  const documentRelativePath = options.documentRelativePath?.trim();
  if (!documentRelativePath) return undefined;
  return (mediaId: string) =>
    resolveDocumentMedia(documentRelativePath, mediaId);
}

const customMediaWidths = new Map<string, number>();

export function getMediaCardStateSnapshot(): Record<string, number> {
  return Object.fromEntries(customMediaWidths);
}

export function restoreMediaCardStateSnapshot(
  widths?: Record<string, number>,
): void {
  customMediaWidths.clear();
  if (!widths) return;
  Object.entries(widths).forEach(([key, value]) => {
    if (Number.isFinite(value)) {
      customMediaWidths.set(key, clampCustomMediaWidth(value));
    }
  });
}

export function clampCustomMediaWidth(width: number): number {
  if (!Number.isFinite(width)) return 360;
  return Math.round(Math.max(60, Math.min(1400, width)));
}

function createMediaIcon(paths: string, size = 12): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.45');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

const ICON_ZOOM =
  '<circle cx="7" cy="7" r="4.2" /><line x1="10.2" y1="10.2" x2="13.8" y2="13.8" /><line x1="7" y1="5" x2="7" y2="9" /><line x1="5" y1="7" x2="9" y2="7" />';
const ICON_RESET =
  '<path d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2L3 6.5" /><polyline points="3 3.2 3 6.5 6.3 6.5" />';

function isTinyUiSvg(svg: SVGSVGElement): boolean {
  const widthAttr = Number.parseFloat(svg.getAttribute('width') ?? '');
  const heightAttr = Number.parseFloat(svg.getAttribute('height') ?? '');
  if (
    Number.isFinite(widthAttr) &&
    Number.isFinite(heightAttr) &&
    widthAttr <= 24 &&
    heightAttr <= 24
  ) {
    return true;
  }
  const viewBox = svg
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    viewBox?.length === 4 &&
    viewBox.every(Number.isFinite) &&
    viewBox[2] <= 24 &&
    viewBox[3] <= 24 &&
    !svg.getAttribute('width')
  ) {
    return true;
  }
  return false;
}

function serializeSvgToDataUrl(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  const markup = new XMLSerializer().serializeToString(clone);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

function buildMediaKey(
  mediaEl: HTMLImageElement | SVGSVGElement,
  index: number,
): string {
  const nodePath =
    mediaEl.closest<SVGGElement>('g.markmap-node')?.getAttribute('data-path') ??
    '';
  if (mediaEl instanceof HTMLImageElement) {
    const rawSrc =
      mediaEl.dataset.seamindMediaId ?? mediaEl.getAttribute('src') ?? '';
    return `img::${nodePath}::${rawSrc.slice(0, 120)}::${index}`;
  }
  const title =
    mediaEl.getAttribute('aria-label') ??
    mediaEl.querySelector('title')?.textContent ??
    '';
  const vb = mediaEl.getAttribute('viewBox') ?? '';
  return `svg::${nodePath}::${vb}::${title.slice(0, 60)}::${index}`;
}

export function hydrateMindmapMedia(
  container: ParentNode,
  dispose: (callback: () => void) => void,
  options: MindmapMediaHydrationOptions,
): void {
  const { signal, onZoomImage, onStateChange } = options;
  const resolveMedia = mindmapMediaResolver(options);

  const images = Array.from(
    container.querySelectorAll<HTMLImageElement>('img'),
  ).filter(
    (img) =>
      img.dataset.seamindMediaHydrated !== 'true' &&
      !img.closest(
        '.seamind-youtube-card, .seamind-code-panel, .seamind-mm-table-card, .seamind-mm-media-card, .seamind-node-note',
      ) &&
      img.dataset.seamindYoutubeThumbnail !== 'true',
  );

  const svgs = Array.from(
    container.querySelectorAll<SVGSVGElement>('.markmap-foreign svg'),
  ).filter(
    (svg) =>
      svg.dataset.seamindMediaHydrated !== 'true' &&
      !svg.closest(
        '.katex, .seamind-code-panel, .seamind-mm-table-card, .seamind-mm-media-card, .seamind-youtube-card, .seamind-node-note, .markmap-node-add-sibling',
      ) &&
      !svg.parentElement?.closest('svg') &&
      !isTinyUiSvg(svg),
  );

  const items: Array<HTMLImageElement | SVGSVGElement> = [...images, ...svgs];

  items.forEach((mediaEl, index) => {
    if (signal.aborted) return;
    const parent = mediaEl.parentElement;
    if (!parent) return;

    const isImg = mediaEl instanceof HTMLImageElement;
    if (isImg) {
      const rawSrc = mediaEl.getAttribute('src') ?? '';
      const mediaId = mediaIdFromSource(rawSrc);
      if (mediaId) {
        mediaEl.dataset.seamindMediaId = mediaId;
      }
    }

    mediaEl.dataset.seamindMediaHydrated = 'true';
    const cardKey = buildMediaKey(mediaEl, index);

    const card = document.createElement('div');
    card.className = 'seamind-mm-media-card';
    card.setAttribute('data-seamind-code-interactive', 'true');

    const head = document.createElement('div');
    head.className = 'seamind-mm-media-head';

    const headLeft = document.createElement('div');
    headLeft.className = 'seamind-mm-media-head-left';

    const badge = document.createElement('span');
    badge.className = 'seamind-mm-media-badge';
    badge.textContent = isImg ? 'IMG' : 'SVG';

    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'seamind-mm-media-size';

    headLeft.append(badge, sizeLabel);

    const actions = document.createElement('div');
    actions.className = 'seamind-mm-media-actions';

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'seamind-mm-media-btn';
    resetBtn.title = '恢复跟随全局图片大小范围';
    resetBtn.setAttribute('aria-label', '恢复跟随全局图片大小范围');
    const resetSpan = document.createElement('span');
    resetSpan.textContent = '重置';
    resetBtn.append(createMediaIcon(ICON_RESET, 11), resetSpan);

    const zoomBtn = document.createElement('button');
    zoomBtn.type = 'button';
    zoomBtn.className = 'seamind-mm-media-btn';
    zoomBtn.title = '点击放大预览图片';
    zoomBtn.setAttribute('aria-label', '点击放大预览图片');
    const zoomSpan = document.createElement('span');
    zoomSpan.textContent = '放大';
    zoomBtn.append(createMediaIcon(ICON_ZOOM, 11), zoomSpan);

    const syncCustomSizeUi = () => {
      const customWidth = customMediaWidths.get(cardKey);
      if (customWidth !== undefined) {
        card.classList.add('is-custom-sized');
        card.style.setProperty('--seamind-media-custom-w', `${customWidth}px`);
        sizeLabel.textContent = `${customWidth}px`;
        resetBtn.hidden = false;
      } else {
        card.classList.remove('is-custom-sized');
        card.style.removeProperty('--seamind-media-custom-w');
        sizeLabel.textContent = '范围自适应';
        resetBtn.hidden = true;
      }
    };
    syncCustomSizeUi();

    const onResetClick = (event: MouseEvent) => {
      event.stopPropagation();
      customMediaWidths.delete(cardKey);
      syncCustomSizeUi();
      onStateChange?.();
    };
    resetBtn.addEventListener('click', onResetClick);
    dispose(() => resetBtn.removeEventListener('click', onResetClick));

    const openZoom = (event?: MouseEvent) => {
      event?.stopPropagation();
      if (!onZoomImage) return;
      if (mediaEl instanceof HTMLImageElement) {
        const src = mediaEl.currentSrc || mediaEl.src;
        if (src) onZoomImage(src);
      } else {
        onZoomImage(serializeSvgToDataUrl(mediaEl));
      }
    };
    zoomBtn.addEventListener('click', openZoom);
    dispose(() => zoomBtn.removeEventListener('click', openZoom));

    actions.append(resetBtn, zoomBtn);
    head.append(headLeft, actions);

    const stage = document.createElement('div');
    stage.className = 'seamind-mm-media-stage';

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'seamind-mm-media-resize';
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-label', '拖拽自由调整图片大小');
    resizeHandle.title = '拖拽右下角自由调整此图片大小';

    let dragging: {
      pointerId: number;
      startX: number;
      startWidth: number;
    } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      resizeHandle.setPointerCapture(event.pointerId);
      const currentRect = stage.getBoundingClientRect();
      dragging = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: Math.max(80, Math.round(currentRect.width)),
      };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      const nextWidth = clampCustomMediaWidth(
        dragging.startWidth + (event.clientX - dragging.startX),
      );
      customMediaWidths.set(cardKey, nextWidth);
      syncCustomSizeUi();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      dragging = null;
      if (resizeHandle.hasPointerCapture(event.pointerId)) {
        resizeHandle.releasePointerCapture(event.pointerId);
      }
      onStateChange?.();
    };
    resizeHandle.addEventListener('pointerdown', onPointerDown);
    resizeHandle.addEventListener('pointermove', onPointerMove);
    resizeHandle.addEventListener('pointerup', onPointerUp);
    resizeHandle.addEventListener('pointercancel', onPointerUp);
    dispose(() => {
      resizeHandle.removeEventListener('pointerdown', onPointerDown);
      resizeHandle.removeEventListener('pointermove', onPointerMove);
      resizeHandle.removeEventListener('pointerup', onPointerUp);
      resizeHandle.removeEventListener('pointercancel', onPointerUp);
    });

    parent.insertBefore(card, mediaEl);
    stage.append(mediaEl);
    card.append(head, stage, resizeHandle);

    if (mediaEl instanceof HTMLImageElement) {
      mediaEl.classList.add('seamind-mm-media-img');
      const onImgClick = (event: MouseEvent) => {
        if (dragging) return;
        openZoom(event);
      };
      mediaEl.addEventListener('click', onImgClick);
      dispose(() => mediaEl.removeEventListener('click', onImgClick));

      const mediaId = mediaEl.dataset.seamindMediaId;
      if (mediaId) {
        const showFailure = (detail: string) => {
          if (signal.aborted || !mediaEl.isConnected) return;
          const fallback = document.createElement('span');
          fallback.className = 'seamind-media-failed';
          fallback.textContent = `图片不可用：${mediaEl.alt || mediaId.slice(0, 8)}`;
          fallback.title = detail;
          mediaEl.replaceWith(fallback);
          zoomBtn.disabled = true;
        };
        if (!resolveMedia) {
          showFailure('文档未保存，无法解析本地导入图片。');
        } else {
          mediaEl.removeAttribute('src');
          const onImgError = () => showFailure('本地图片无法解码或读取。');
          mediaEl.addEventListener('error', onImgError, { once: true });
          dispose(() => mediaEl.removeEventListener('error', onImgError));
          void resolveMedia(mediaId)
            .then((url) => {
              if (!signal.aborted && mediaEl.isConnected) {
                mediaEl.src = url;
              }
            })
            .catch((error) => {
              showFailure(
                error instanceof Error ? error.message : String(error),
              );
            });
        }
      }
    } else {
      mediaEl.classList.add('seamind-mm-media-svg');
    }
  });
}
