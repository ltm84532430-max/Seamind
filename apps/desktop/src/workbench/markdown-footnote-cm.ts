import {
  MapMode,
  Range,
  RangeSet,
  RangeValue,
  StateField,
  Transaction,
  type Extension,
  type Text,
} from '@codemirror/state';
import { EditorView } from 'codemirror';
import {
  computeFootnoteEnterContinuation,
  extractMarkdownFootnoteSyntaxZones,
} from './markdown-footnotes';

type EditorDecorationSet = Exclude<
  Parameters<typeof EditorView.decorations.of>[0],
  (...args: never[]) => unknown
>;

class FootnoteLineRange extends RangeValue {
  readonly widget = null;
  readonly spec: { class: string; attributes?: Record<string, string> };

  constructor(className: string, badgeText?: string) {
    super();
    this.startSide = -2e8;
    this.endSide = -2e8;
    this.point = true;
    this.mapMode = MapMode.TrackBefore;
    this.spec = badgeText
      ? { class: className, attributes: { 'data-footnote-badge': badgeText } }
      : { class: className };
  }

  get heightRelevant(): boolean {
    return false;
  }

  hasHeight(): boolean {
    return false;
  }

  override eq(other: RangeValue): boolean {
    return (
      other instanceof FootnoteLineRange &&
      this.spec.class === other.spec.class &&
      this.spec.attributes?.['data-footnote-badge'] ===
        other.spec.attributes?.['data-footnote-badge']
    );
  }
}

class FootnoteMarkRange extends RangeValue {
  readonly widget = null;
  readonly tagName = 'span';
  readonly attrs: Record<string, string>;
  readonly spec: { class: string };

  constructor(className: string) {
    super();
    this.startSide = 5e8;
    this.endSide = -6e8;
    this.point = false;
    this.spec = { class: className };
    this.attrs = { class: className };
  }

  get heightRelevant(): boolean {
    return false;
  }

  hasHeight(): boolean {
    return false;
  }

  override eq(other: RangeValue): boolean {
    return (
      other instanceof FootnoteMarkRange && this.spec.class === other.spec.class
    );
  }
}

function buildFootnoteDecorations(doc: Text): EditorDecorationSet {
  const source = doc.toString();
  const zones = extractMarkdownFootnoteSyntaxZones(source);
  if (zones.definitions.length === 0 && zones.references.length === 0) {
    return RangeSet.empty as unknown as EditorDecorationSet;
  }

  const ranges: Range<RangeValue>[] = [];

  for (const def of zones.definitions) {
    if (def.startLine + 1 > doc.lines) continue;
    const clampedEnd = Math.min(doc.lines - 1, def.endLine);

    for (let lineIdx = def.startLine; lineIdx <= clampedEnd; lineIdx += 1) {
      const line = doc.line(lineIdx + 1);
      const isStart = lineIdx === def.startLine;
      const isEnd = lineIdx === clampedEnd;
      const classes = ['cm-footnote-def-line'];
      if (isStart) classes.push('cm-footnote-def-start');
      if (isEnd) classes.push('cm-footnote-def-end');

      const lineDeco = new FootnoteLineRange(
        classes.join(' '),
        isStart ? `脚注 [${def.index}]` : undefined,
      );
      ranges.push(lineDeco.range(line.from));

      if (isStart) {
        const markerEnd = Math.min(line.to, line.from + def.markerLength);
        if (markerEnd > line.from) {
          ranges.push(
            new FootnoteMarkRange('cm-footnote-def-marker').range(
              line.from,
              markerEnd,
            ),
          );
        }
      }
    }
  }

  for (const ref of zones.references) {
    if (ref.lineIndex + 1 > doc.lines) continue;
    const line = doc.line(ref.lineIndex + 1);
    const from = Math.min(line.to, line.from + ref.fromCol);
    const to = Math.min(line.to, line.from + ref.toCol);
    if (to > from) {
      ranges.push(
        new FootnoteMarkRange('cm-footnote-ref-token').range(from, to),
      );
    }
  }

  ranges.sort(
    (a, b) =>
      a.from - b.from || a.value.startSide - b.value.startSide || a.to - b.to,
  );

  return RangeSet.of(ranges, false) as unknown as EditorDecorationSet;
}

const footnoteDecorationField = StateField.define<EditorDecorationSet>({
  create(state) {
    return buildFootnoteDecorations(state.doc);
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return buildFootnoteDecorations(tr.state.doc);
  },
  provide(field) {
    return EditorView.decorations.from(field);
  },
});

const footnoteEnterHandler = EditorView.domEventHandlers({
  keydown(event, view) {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing ||
      view.state.readOnly
    ) {
      return false;
    }

    const selection = view.state.selection.main;
    if (!selection.empty) return false;

    const continuation = computeFootnoteEnterContinuation(
      view.state.doc.toString(),
      selection.from,
    );
    if (!continuation) return false;

    event.preventDefault();
    view.dispatch({
      changes: {
        from: continuation.from,
        to: continuation.to,
        insert: continuation.insert,
      },
      selection: { anchor: continuation.cursorOffset },
      scrollIntoView: true,
      annotations: Transaction.userEvent.of('input'),
    });
    return true;
  },
});

/** CodeMirror extension that highlights footnote definition zones and keeps Enter inside footnote blocks indented. */
export function createMarkdownFootnoteEditorExtension(): Extension {
  return [footnoteDecorationField, footnoteEnterHandler];
}
