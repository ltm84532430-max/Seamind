const collapsedNoteKeys = new Set<string>();
const expandedFullNoteKeys = new Set<string>();

export function getNoteCardStateSnapshot(): {
  collapsedNotes: string[];
  expandedNotes: string[];
} {
  return {
    collapsedNotes: [...collapsedNoteKeys],
    expandedNotes: [...expandedFullNoteKeys],
  };
}

export function restoreNoteCardStateSnapshot(state: {
  collapsedNotes?: ReadonlyArray<string>;
  expandedNotes?: ReadonlyArray<string>;
}): void {
  collapsedNoteKeys.clear();
  expandedFullNoteKeys.clear();
  state.collapsedNotes?.forEach((key) => collapsedNoteKeys.add(key));
  state.expandedNotes?.forEach((key) => expandedFullNoteKeys.add(key));
}

function createNoteSvgIcon(paths: string, size = 11): SVGSVGElement {
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

const ICON_CHEVRON_DOWN = '<polyline points="4 6 8 10 12 6" />';
const ICON_CHEVRON_RIGHT = '<polyline points="6 4 10 8 6 12" />';
const ICON_EDIT =
  '<path d="M11.5 2.5a1.5 1.5 0 0 1 2.1 2.1L6 12.2l-3.2.8.8-3.2Z" />';

export interface HydrateMindmapNotesOptions {
  onEditNote?: (nodePath: string) => void;
  onStateChange?: () => void;
  dispose: (callback: () => void) => void;
}

export function hydrateMindmapNoteCards(
  container: ParentNode,
  options: HydrateMindmapNotesOptions,
): void {
  const notes = Array.from(
    container.querySelectorAll<HTMLElement>('.seamind-node-note'),
  );

  for (const noteCard of notes) {
    if (noteCard.dataset.seamindNoteHydrated === 'true') continue;
    const content = noteCard.querySelector<HTMLElement>(
      '.seamind-node-note-content',
    );
    if (!content) continue;

    noteCard.dataset.seamindNoteHydrated = 'true';
    noteCard.setAttribute('data-seamind-code-interactive', 'true');
    content.setAttribute('data-seamind-code-scroll', 'true');

    const nodeGroup = noteCard.closest<SVGGElement>('g.markmap-node');
    const nodePath = nodeGroup?.getAttribute('data-path') ?? '';
    const noteId = noteCard.dataset.seamindNoteId?.trim() || '';
    const noteKey =
      noteId || nodePath || (content.textContent ?? '').slice(0, 64);

    if (collapsedNoteKeys.has(noteKey)) {
      noteCard.classList.add('is-collapsed');
    }
    if (expandedFullNoteKeys.has(noteKey)) {
      noteCard.classList.add('is-expanded');
    }

    const bar = document.createElement('div');
    bar.className = 'seamind-node-note-bar';

    const left = document.createElement('div');
    left.className = 'seamind-node-note-bar-left';

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'seamind-node-note-btn is-icon';

    const badge = document.createElement('span');
    badge.className = 'seamind-node-note-badge';
    badge.textContent = '备注';

    const collapsedHint = document.createElement('span');
    collapsedHint.className = 'seamind-node-note-collapsed-hint';
    const rawPreview = (content.textContent ?? '').replace(/\s+/g, ' ').trim();
    collapsedHint.textContent = rawPreview
      ? rawPreview.slice(0, 28) + (rawPreview.length > 28 ? '…' : '')
      : '已折叠';

    left.append(collapseBtn, badge, collapsedHint);

    const actions = document.createElement('div');
    actions.className = 'seamind-node-note-actions';

    const expandFullBtn = document.createElement('button');
    expandFullBtn.type = 'button';
    expandFullBtn.className = 'seamind-node-note-btn';
    expandFullBtn.style.display = 'none';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'seamind-node-note-btn';
    editBtn.title = '编辑节点备注';
    editBtn.setAttribute('aria-label', '编辑节点备注');
    const editLabel = document.createElement('span');
    editLabel.textContent = '编辑';
    editBtn.append(createNoteSvgIcon(ICON_EDIT, 10), editLabel);

    const syncUi = () => {
      const collapsed = noteCard.classList.contains('is-collapsed');
      const expandedFull = noteCard.classList.contains('is-expanded');
      collapseBtn.replaceChildren(
        createNoteSvgIcon(
          collapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN,
          11,
        ),
      );
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
      collapseBtn.title = collapsed ? '展开备注' : '收起备注';
      collapseBtn.setAttribute('aria-label', collapseBtn.title);

      expandFullBtn.textContent = expandedFull ? '限高滚动' : '展开全文';
      expandFullBtn.title = expandedFull
        ? '恢复固定最大高度并用滚轮浏览'
        : '在画布中完整展开全部备注内容';
      if (collapsed) {
        expandFullBtn.style.display = 'none';
      } else {
        const needsOverflowControl =
          expandedFull || content.scrollHeight > content.clientHeight + 4;
        expandFullBtn.style.display = needsOverflowControl ? '' : 'none';
      }
    };

    const onCollapseClick = (event: MouseEvent) => {
      event.stopPropagation();
      const collapsed = noteCard.classList.toggle('is-collapsed');
      if (collapsed) collapsedNoteKeys.add(noteKey);
      else collapsedNoteKeys.delete(noteKey);
      syncUi();
      if (!collapsed) window.requestAnimationFrame(syncUi);
      options.onStateChange?.();
    };

    const onExpandFullClick = (event: MouseEvent) => {
      event.stopPropagation();
      const expanded = noteCard.classList.toggle('is-expanded');
      if (expanded) expandedFullNoteKeys.add(noteKey);
      else expandedFullNoteKeys.delete(noteKey);
      syncUi();
      options.onStateChange?.();
    };

    const onEditClick = (event: MouseEvent) => {
      event.stopPropagation();
      if (nodePath && options.onEditNote) {
        options.onEditNote(nodePath);
      }
    };

    // Allow selecting & copying text inside notes without panning Markmap,
    // and let wheel events scroll tall notes without zooming the canvas.
    const stopCanvasDrag = (event: Event) => {
      event.stopPropagation();
    };
    const stopCanvasWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      if (content.scrollHeight > content.clientHeight + 1) {
        event.stopPropagation();
      }
    };

    collapseBtn.addEventListener('click', onCollapseClick);
    expandFullBtn.addEventListener('click', onExpandFullClick);
    editBtn.addEventListener('click', onEditClick);
    noteCard.addEventListener('mousedown', stopCanvasDrag);
    noteCard.addEventListener('pointerdown', stopCanvasDrag);
    content.addEventListener('wheel', stopCanvasWheel, { passive: true });

    actions.append(expandFullBtn);
    if (nodePath && options.onEditNote) {
      actions.append(editBtn);
    }
    bar.append(left, actions);
    noteCard.prepend(bar);

    syncUi();
    const rafId = window.requestAnimationFrame(syncUi);

    options.dispose(() => {
      window.cancelAnimationFrame(rafId);
      collapseBtn.removeEventListener('click', onCollapseClick);
      expandFullBtn.removeEventListener('click', onExpandFullClick);
      editBtn.removeEventListener('click', onEditClick);
      noteCard.removeEventListener('mousedown', stopCanvasDrag);
      noteCard.removeEventListener('pointerdown', stopCanvasDrag);
      content.removeEventListener('wheel', stopCanvasWheel);
    });
  }
}
