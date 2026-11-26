import { fitViewport, panBy, zoomAt } from './diagram-viewport';
import type { Viewport } from './diagram-viewport';

const ZOOM_STEP = 1.2;

function toolbarButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  return button;
}

/** Opens an already sanitized Mermaid SVG without rendering a second copy of its IDs. */
export function attachMermaidFullscreen(
  panel: HTMLElement,
  output: HTMLElement,
  dispose: (callback: () => void) => void,
): void {
  const diagram = output.querySelector<SVGSVGElement>(
    ':scope > svg.seamind-diagram-svg',
  );
  const heading = panel.querySelector<HTMLElement>(
    '.seamind-code-panel-heading',
  );
  if (!diagram || !heading) return;

  const width = diagram.viewBox.baseVal.width;
  const height = diagram.viewBox.baseVal.height;
  if (!(width > 0 && height > 0)) return;

  const openButton = toolbarButton('全屏', '全屏查看 Mermaid 图');
  heading.append(openButton);

  const dialog = document.createElement('dialog');
  dialog.className = 'seamind-mermaid-fullscreen';
  dialog.setAttribute('aria-label', 'Mermaid 图表全屏视图');
  const toolbar = document.createElement('div');
  toolbar.className = 'seamind-mermaid-fullscreen-toolbar';
  const title = document.createElement('strong');
  title.textContent = '>_ MERMAID';
  const spacer = document.createElement('span');
  spacer.className = 'seamind-mermaid-fullscreen-spacer';
  const zoomOut = toolbarButton('−', '缩小图表');
  const zoomReset = toolbarButton('100%', '恢复图表至 100%');
  const zoomIn = toolbarButton('＋', '放大图表');
  const fitButton = toolbarButton('适配', '适配窗口');
  const closeButton = toolbarButton('退出全屏', '退出全屏（Esc）');
  toolbar.append(
    title,
    spacer,
    zoomOut,
    zoomReset,
    zoomIn,
    fitButton,
    closeButton,
  );
  const frame = document.createElement('div');
  frame.className = 'seamind-mermaid-fullscreen-frame';
  frame.setAttribute('aria-label', '可拖动缩放的 Mermaid 图');
  dialog.append(toolbar, frame);
  (panel.closest('.app-shell') ?? document.body).append(dialog);

  let view: Viewport = { x: 0, y: 0, scale: 1 };
  let pointer: { id: number; x: number; y: number } | null = null;
  let adjusted = false;
  let active = false;
  let originalDiagramStyle: string | null = null;
  let originalOutputStyle: string | null = null;

  const applyView = () => {
    diagram.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    zoomReset.textContent = `${Math.round(view.scale * 100)}%`;
  };
  const fit = () => {
    const rect = frame.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    view = fitViewport(
      { width, height },
      { width: rect.width, height: rect.height },
    );
    adjusted = false;
    applyView();
  };
  const zoom = (factor: number, x: number, y: number) => {
    view = zoomAt(view, factor, { x, y });
    adjusted = true;
    applyView();
  };
  const zoomAtCenter = (factor: number) => {
    const rect = frame.getBoundingClientRect();
    zoom(factor, rect.width / 2, rect.height / 2);
  };
  const restore = () => {
    if (!active) return;
    active = false;
    if (diagram.parentElement === frame) output.append(diagram);
    if (originalDiagramStyle === null) diagram.removeAttribute('style');
    else diagram.setAttribute('style', originalDiagramStyle);
    if (originalOutputStyle === null) output.removeAttribute('style');
    else output.setAttribute('style', originalOutputStyle);
    pointer = null;
    frame.classList.remove('is-dragging');
    if (openButton.isConnected) openButton.focus({ preventScroll: true });
  };
  const open = () => {
    if (dialog.open || diagram.parentElement !== output) return;
    try {
      dialog.showModal();
    } catch {
      return;
    }
    active = true;
    originalDiagramStyle = diagram.getAttribute('style');
    originalOutputStyle = output.getAttribute('style');
    output.style.height = `${output.getBoundingClientRect().height}px`;
    frame.append(diagram);
    diagram.style.width = `${width}px`;
    diagram.style.height = `${height}px`;
    diagram.style.minWidth = '0';
    diagram.style.maxWidth = 'none';
    fit();
    closeButton.focus();
  };
  const close = () => {
    if (dialog.open) dialog.close();
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const rect = frame.getBoundingClientRect();
    zoom(
      Math.exp(-event.deltaY * 0.0015),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    frame.setPointerCapture(event.pointerId);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    frame.classList.add('is-dragging');
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    view = panBy(view, event.clientX - pointer.x, event.clientY - pointer.y);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    adjusted = true;
    applyView();
  };
  const onPointerEnd = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    pointer = null;
    frame.classList.remove('is-dragging');
    if (frame.hasPointerCapture(event.pointerId))
      frame.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const observer = new ResizeObserver(() => {
    if (dialog.open && !adjusted) fit();
  });
  observer.observe(frame);

  openButton.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  zoomOut.addEventListener('click', () => zoomAtCenter(1 / ZOOM_STEP));
  zoomIn.addEventListener('click', () => zoomAtCenter(ZOOM_STEP));
  zoomReset.addEventListener('click', () => zoomAtCenter(1 / view.scale));
  fitButton.addEventListener('click', fit);
  frame.addEventListener('wheel', onWheel, { passive: false });
  frame.addEventListener('pointerdown', onPointerDown);
  frame.addEventListener('pointermove', onPointerMove);
  frame.addEventListener('pointerup', onPointerEnd);
  frame.addEventListener('pointercancel', onPointerEnd);
  dialog.addEventListener('keydown', onKeyDown);
  dialog.addEventListener('close', restore);

  dispose(() => {
    if (dialog.open) dialog.close();
    restore();
    observer.disconnect();
    openButton.removeEventListener('click', open);
    closeButton.removeEventListener('click', close);
    frame.removeEventListener('wheel', onWheel);
    frame.removeEventListener('pointerdown', onPointerDown);
    frame.removeEventListener('pointermove', onPointerMove);
    frame.removeEventListener('pointerup', onPointerEnd);
    frame.removeEventListener('pointercancel', onPointerEnd);
    dialog.removeEventListener('keydown', onKeyDown);
    dialog.removeEventListener('close', restore);
    dialog.remove();
    openButton.remove();
  });
}
