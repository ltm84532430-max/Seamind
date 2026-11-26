import type { MapDocument } from '../library/library';
import { findWikilinkTarget } from '../knowledge/knowledge-markdown';
import { readCodeBlockMeta } from '../knowledge/code-block-meta';
import { parseMarkdownFootnotes } from './markdown-footnotes';
import { renderCodeLinesInto } from './code-syntax-utils';
import { libraryApi } from '../library/library-api';

interface CodeRange {
  lineIndex: number;
  endLineIndex: number;
}

interface ReadableCodeWorkspaceOptions {
  panel: HTMLElement;
  pre: HTMLElement;
  source: string;
  language: string;
  info: string;
  markdownSource?: string;
  documentRelativePath?: string;
  documents?: readonly MapDocument[];
  sourceRange?: CodeRange;
  onOpenWikilink?: (target: string, options?: { split?: boolean }) => void;
  onEditFootnote?: (id: string) => void;
  onAddCodeFootnote?: (sourceRange: CodeRange, lineNumber: number) => void;
  dispose: (callback: () => void) => void;
}

function makeButton(label: string, title?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (title) button.title = title;
  return button;
}

export function attachReadableCodeWorkspace({
  panel,
  pre,
  source,
  language,
  info,
  markdownSource,
  documentRelativePath,
  documents = [],
  sourceRange,
  onOpenWikilink,
  onEditFootnote,
  onAddCodeFootnote,
  dispose,
}: ReadableCodeWorkspaceOptions): void {
  const code = pre.querySelector<HTMLElement>('code');
  if (!code) return;
  const meta = readCodeBlockMeta(info);
  if (meta.id) panel.id = `code-${meta.id}`;
  const footnotes =
    meta.id && markdownSource
      ? parseMarkdownFootnotes(markdownSource).footnotes.flatMap((note) => {
          const match = new RegExp(`^code-${meta.id}-l(\\d+)-\\d+$`, 'i').exec(
            note.id,
          );
          return match ? [{ ...note, codeLine: Number(match[1]) }] : [];
        })
      : [];

  const gutter = document.createElement('div');
  gutter.className = 'seamind-text-code-gutter';
  gutter.setAttribute('aria-label', '代码行号');
  pre.classList.add('seamind-text-code-pre');
  renderCodeLinesInto(code, gutter, source, language);
  for (const note of footnotes) {
    const marker = gutter.children.item(note.codeLine - 1);
    if (marker instanceof HTMLElement) {
      marker.classList.add('has-code-footnote');
      marker.title = `第 ${note.codeLine} 行：${note.plainText}`;
    }
  }
  const body = document.createElement('div');
  body.className = 'seamind-text-code-body seamind-fn-hover-scroll';
  body.append(gutter, pre);
  panel.append(body);
  let closeDialog = () => {};

  const bindLineActions = (scope: HTMLElement) => {
    if (!sourceRange || !onAddCodeFootnote) return () => {};
    const lineGutter = scope.querySelector<HTMLElement>(
      '.seamind-text-code-gutter',
    );
    if (!lineGutter) return () => {};
    const spans = Array.from(lineGutter.children);
    for (const item of spans) {
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      if (!item.getAttribute('title'))
        item.setAttribute('title', `为第 ${item.textContent} 行添加脚注`);
    }
    const activate = (target: EventTarget | null, addAnother = false) => {
      if (
        !(target instanceof HTMLElement) ||
        target.parentElement !== lineGutter
      )
        return;
      const line = Number(target.textContent);
      if (!Number.isFinite(line)) return;
      const existing = footnotes.find((note) => note.codeLine === line);
      if (existing && !addAnother && onEditFootnote) {
        closeDialog();
        onEditFootnote(existing.id);
      } else {
        closeDialog();
        onAddCodeFootnote(sourceRange, line);
      }
    };
    const click = (event: MouseEvent) => activate(event.target, event.altKey);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate(event.target, event.altKey);
      }
    };
    lineGutter.addEventListener('click', click);
    lineGutter.addEventListener('keydown', keydown);
    return () => {
      lineGutter.removeEventListener('click', click);
      lineGutter.removeEventListener('keydown', keydown);
    };
  };
  const unbindInline = bindLineActions(body);

  const renderAnnotations = (container: HTMLElement, full: boolean) => {
    const fileSection = document.createElement('section');
    fileSection.className = 'seamind-code-annotation-section';
    const fileTitle = document.createElement('strong');
    fileTitle.textContent = '文件位置';
    fileSection.append(fileTitle);
    const file = document.createElement('code');
    file.textContent = meta.sourceFile || documentRelativePath || '未设置';
    file.title = file.textContent;
    fileSection.append(file);
    if (meta.sourceFile) {
      const copyPath = makeButton('复制路径');
      copyPath.addEventListener('click', () => {
        void navigator.clipboard.writeText(meta.sourceFile).catch(() => {
          copyPath.textContent = '复制失败';
        });
      });
      fileSection.append(copyPath);
    }
    container.append(fileSection);

    const links = document.createElement('section');
    links.className = 'seamind-code-annotation-section';
    const linkTitle = document.createElement('strong');
    linkTitle.textContent = `关联文档 ${meta.links.length}`;
    links.append(linkTitle);
    if (!meta.links.length) {
      const empty = document.createElement('span');
      empty.textContent = full
        ? '在「编辑代码块」中添加笔记标题或文件路径'
        : '暂无';
      links.append(empty);
    }
    for (const target of meta.links) {
      const resolved = findWikilinkTarget(target, documents);
      const link = makeButton(
        resolved?.title || target,
        resolved?.relativePath || target,
      );
      link.className = 'seamind-code-doc-link';
      link.addEventListener('click', () => {
        if (full) closeDialog();
        onOpenWikilink?.(target, { split: true });
      });
      links.append(link);
      if (full && resolved) {
        const path = document.createElement('small');
        path.textContent = resolved.relativePath;
        links.append(path);
      }
    }
    container.append(links);

    const notes = document.createElement('section');
    notes.className = 'seamind-code-annotation-section';
    const noteTitle = document.createElement('strong');
    noteTitle.textContent = `代码脚注 ${footnotes.length}`;
    notes.append(noteTitle);
    if (!footnotes.length) {
      const empty = document.createElement('span');
      empty.textContent = full
        ? '点击代码行号添加；Alt+点击可在同一行继续添加'
        : '点击行号添加';
      notes.append(empty);
    }
    for (const note of footnotes) {
      const item = makeButton(
        `L${note.codeLine} · ${note.plainText || note.content}`,
      );
      item.className = 'seamind-code-footnote-link';
      item.title = note.content;
      item.addEventListener('click', () => {
        if (full) closeDialog();
        onEditFootnote?.(note.id);
      });
      notes.append(item);
    }
    container.append(notes);
  };

  const footer = document.createElement('div');
  footer.className = 'seamind-code-annotations-inline';
  renderAnnotations(footer, false);
  panel.append(footer);

  const heading = panel.querySelector<HTMLElement>(
    '.seamind-code-panel-heading',
  );
  const expand = makeButton('全屏', '全屏查看代码与技术笔记');
  heading?.append(expand);
  let activeDialog: HTMLDialogElement | null = null;
  let unbindDialog = () => {};
  closeDialog = () => {
    unbindDialog();
    unbindDialog = () => {};
    if (activeDialog?.open) activeDialog.close();
    activeDialog?.remove();
    activeDialog = null;
  };
  const loadBacklinks = async (
    rail: HTMLElement,
    dialog: HTMLDialogElement,
  ) => {
    const current = documents.find(
      (item) => item.relativePath === documentRelativePath,
    );
    if (!current) return;
    const section = document.createElement('section');
    section.className = 'seamind-code-annotation-section';
    const title = document.createElement('strong');
    title.textContent = '反向链接 · 搜索中';
    section.append(title);
    rail.append(section);
    const candidates = documents.filter(
      (item) =>
        item.kind === 'doc' && item.relativePath !== current.relativePath,
    );
    let count = 0;
    for (let index = 0; index < candidates.length; index += 4) {
      if (activeDialog !== dialog) return;
      const group = candidates.slice(index, index + 4);
      const opened = await Promise.allSettled(
        group.map((item) =>
          libraryApi.openDocument({ relativePath: item.relativePath }),
        ),
      );
      if (activeDialog !== dialog) return;
      opened.forEach((result, offset) => {
        if (result.status !== 'fulfilled') return;
        const item = group[offset];
        let inFence = false;
        const lines = result.value.markdown.split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];
          const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
          const targets =
            fence && !inFence
              ? readCodeBlockMeta(fence[2]).links
              : !inFence
                ? Array.from(
                    line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g),
                    (match) => match[1],
                  )
                : [];
          if (fence) inFence = !inFence;
          const hit = targets.find(
            (target) =>
              findWikilinkTarget(target, documents)?.relativePath ===
              current.relativePath,
          );
          if (!hit) continue;
          count += 1;
          const button = makeButton(`${item.title} · L${lineIndex + 1}`);
          button.className = 'seamind-code-doc-link';
          button.title = item.relativePath;
          button.addEventListener('click', () => {
            closeDialog();
            onOpenWikilink?.(item.title, { split: true });
          });
          const path = document.createElement('small');
          path.textContent = `${item.relativePath}${meta.id && hit.includes(`#code-${meta.id}`) ? ' · 指向此代码块' : ''}`;
          section.append(button, path);
          break;
        }
      });
      title.textContent = `反向链接 ${count} · ${Math.min(index + 4, candidates.length)}/${candidates.length}`;
    }
    title.textContent = `反向链接 ${count}`;
    if (!count) {
      const empty = document.createElement('span');
      empty.textContent = '暂无其他笔记引用本文档';
      section.append(empty);
    }
  };
  expand.addEventListener('click', () => {
    if (activeDialog) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'seamind-code-fullscreen';
    dialog.setAttribute('aria-label', `代码全屏：${language || 'text'}`);
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = `CODE / ${language || 'text'}`;
    const close = makeButton('退出全屏', '退出代码全屏');
    close.addEventListener('click', closeDialog);
    header.append(title, close);
    const layout = document.createElement('div');
    layout.className = 'seamind-code-fullscreen-layout';
    const codeViewport = body.cloneNode(true) as HTMLElement;
    codeViewport.classList.add('seamind-code-fullscreen-viewport');
    unbindDialog = bindLineActions(codeViewport);
    const rail = document.createElement('aside');
    rail.className = 'seamind-code-fullscreen-rail';
    renderAnnotations(rail, true);
    layout.append(codeViewport, rail);
    dialog.append(header, layout);
    dialog.addEventListener('close', closeDialog, { once: true });
    (document.querySelector('.app-shell') ?? document.body).append(dialog);
    activeDialog = dialog;
    dialog.showModal();
    void loadBacklinks(rail, dialog);
  });
  dispose(() => {
    closeDialog();
    unbindInline();
    expand.remove();
    code.textContent = source;
    pre.classList.remove('seamind-text-code-pre');
  });
}
