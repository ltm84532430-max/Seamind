import { EditorView } from 'codemirror';

const maximumRowsPerPixel = 2;

export interface MarkdownMinimapController {
  update(): void;
  destroy(): void;
}

class MarkdownMinimapView implements MarkdownMinimapController {
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly viewport: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;
  private frame = 0;
  private pointerId: number | null = null;

  constructor(
    private readonly view: EditorView,
    host: HTMLElement,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'markdown-minimap';
    this.root.setAttribute('role', 'scrollbar');
    this.root.setAttribute('aria-label', 'Markdown 文本缩略导航');
    this.root.setAttribute('aria-orientation', 'vertical');
    this.root.setAttribute('aria-valuemin', '1');
    this.root.tabIndex = 0;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'markdown-minimap-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.viewport = document.createElement('div');
    this.viewport.className = 'markdown-minimap-viewport';
    this.viewport.setAttribute('aria-hidden', 'true');
    this.root.append(this.canvas, this.viewport);
    host.append(this.root);

    this.root.addEventListener('pointerdown', this.handlePointerDown);
    this.root.addEventListener('pointermove', this.handlePointerMove);
    this.root.addEventListener('pointerup', this.handlePointerEnd);
    this.root.addEventListener('pointercancel', this.handlePointerEnd);
    this.root.addEventListener('keydown', this.handleKeyDown);
    this.view.scrollDOM.addEventListener('scroll', this.scheduleDraw, {
      passive: true,
    });
    this.resizeObserver = new ResizeObserver(this.scheduleDraw);
    this.resizeObserver.observe(this.root);
    this.scheduleDraw();
  }

  update() {
    this.scheduleDraw();
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.view.scrollDOM.removeEventListener('scroll', this.scheduleDraw);
    this.root.removeEventListener('pointerdown', this.handlePointerDown);
    this.root.removeEventListener('pointermove', this.handlePointerMove);
    this.root.removeEventListener('pointerup', this.handlePointerEnd);
    this.root.removeEventListener('pointercancel', this.handlePointerEnd);
    this.root.removeEventListener('keydown', this.handleKeyDown);
    if (this.frame) window.cancelAnimationFrame(this.frame);
    this.root.remove();
  }

  private readonly scheduleDraw = () => {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  };

  private readonly handlePointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    this.pointerId = event.pointerId;
    this.root.setPointerCapture(event.pointerId);
    this.navigateTo(event.clientY);
    event.preventDefault();
  };

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (this.pointerId !== event.pointerId) return;
    this.navigateTo(event.clientY);
  };

  private readonly handlePointerEnd = (event: PointerEvent) => {
    if (this.pointerId !== event.pointerId) return;
    if (this.root.hasPointerCapture(event.pointerId))
      this.root.releasePointerCapture(event.pointerId);
    this.pointerId = null;
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    const currentLine = this.view.state.doc.lineAt(
      this.view.state.selection.main.head,
    ).number;
    const step = Math.max(1, Math.ceil(this.view.state.doc.lines / 20));
    const targetLine =
      event.key === 'ArrowUp'
        ? currentLine - step
        : event.key === 'ArrowDown'
          ? currentLine + step
          : event.key === 'PageUp'
            ? currentLine - Math.max(step, 10)
            : event.key === 'PageDown'
              ? currentLine + Math.max(step, 10)
              : event.key === 'Home'
                ? 1
                : event.key === 'End'
                  ? this.view.state.doc.lines
                  : 0;
    if (!targetLine) return;
    event.preventDefault();
    const line = Math.max(1, Math.min(this.view.state.doc.lines, targetLine));
    this.view.dispatch({
      effects: EditorView.scrollIntoView(this.view.state.doc.line(line).from, {
        y: 'center',
      }),
    });
  };

  private navigateTo(clientY: number) {
    const bounds = this.canvas.getBoundingClientRect();
    if (bounds.height <= 0) return;
    const ratio = Math.max(
      0,
      Math.min(1, (clientY - bounds.top) / bounds.height),
    );
    const lineNumber = Math.max(
      1,
      Math.min(
        this.view.state.doc.lines,
        Math.floor(ratio * this.view.state.doc.lines) + 1,
      ),
    );
    this.view.dispatch({
      effects: EditorView.scrollIntoView(
        this.view.state.doc.line(lineNumber).from,
        { y: 'center' },
      ),
    });
  }

  private draw() {
    const bounds = this.canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.ceil(bounds.width * pixelRatio);
    this.canvas.height = Math.ceil(bounds.height * pixelRatio);
    const context = this.canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);

    const style = window.getComputedStyle(this.root);
    const lineColor = style.getPropertyValue('--minimap-line').trim();
    const headingColor = style.getPropertyValue('--minimap-heading').trim();
    const codeColor = style.getPropertyValue('--minimap-code').trim();
    const accentColor = style.getPropertyValue('--minimap-active').trim();
    const lineCount = this.view.state.doc.lines;
    const rowCount = Math.min(
      lineCount,
      Math.max(1, Math.floor(bounds.height * maximumRowsPerPixel)),
    );
    const rowHeight = bounds.height / rowCount;
    const xInset = 5;
    const availableWidth = Math.max(1, bounds.width - xInset * 2);
    const activeLine =
      this.view.state.doc.lineAt(this.view.state.selection.main.head).number -
      1;
    const activeRow = Math.min(
      rowCount - 1,
      Math.floor((activeLine * rowCount) / lineCount),
    );

    // Keep the cursor indicator behind the miniature text so it never hides
    // the source content represented by the minimap.
    context.globalAlpha = 0.16;
    context.fillStyle = accentColor || '#d9573b';
    context.fillRect(
      0,
      activeRow * rowHeight,
      bounds.width,
      Math.max(2, rowHeight),
    );
    context.globalAlpha = 1;

    const fontSize = Math.max(0.8, Math.min(3.2, rowHeight * 0.88));
    context.font = `${fontSize}px ui-monospace, SFMono-Regular, Consolas, monospace`;
    context.textBaseline = 'middle';

    for (let row = 0; row < rowCount; row += 1) {
      const lineNumber = Math.min(
        lineCount,
        Math.floor((row * lineCount) / rowCount) + 1,
      );
      const content = this.view.state.doc.line(lineNumber).text;
      const trimmed = content.trim();
      if (!trimmed) continue;

      const leadingWhitespace = content.match(/^\s*/)?.[0].length || 0;
      const indent = Math.min(10, leadingWhitespace * 1.25);
      const maxWidth = Math.max(1, availableWidth - indent);
      const color =
        lineNumber - 1 === activeLine
          ? accentColor
          : /^#{1,6}\s/.test(trimmed)
            ? headingColor
            : /^(?:```|~~~)/.test(trimmed)
              ? codeColor
              : lineColor;
      context.fillStyle = color || '#8c9aa5';
      context.fillText(
        trimmed,
        xInset + indent,
        row * rowHeight + rowHeight / 2,
        maxWidth,
      );
    }

    this.root.setAttribute('aria-valuemax', String(lineCount));
    this.root.setAttribute('aria-valuenow', String(activeLine + 1));

    const scroll = this.view.scrollDOM;
    const scrollHeight = Math.max(scroll.scrollHeight, scroll.clientHeight);
    const viewportHeight = Math.min(
      bounds.height,
      Math.max(18, (scroll.clientHeight / scrollHeight) * bounds.height),
    );
    const scrollRange = Math.max(0, scrollHeight - scroll.clientHeight);
    const top = scrollRange
      ? (scroll.scrollTop / scrollRange) * (bounds.height - viewportHeight)
      : 0;
    this.viewport.style.height = `${viewportHeight}px`;
    this.viewport.style.transform = `translateY(${top}px)`;
  }
}

export function createMarkdownMinimap(
  view: EditorView,
  host: HTMLElement,
): MarkdownMinimapController {
  return new MarkdownMinimapView(view, host);
}
