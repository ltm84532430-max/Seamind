import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createPasteTransaction } from '../src/workbench/markdown-editor-paste';

describe('Markdown editor paste transaction', () => {
  it('places the cursor after multi-line Windows clipboard text', () => {
    const state = EditorState.create({ doc: '前后' });
    const pasted = Array.from(
      { length: 120 },
      (_, index) => `第 ${index + 1} 行`,
    ).join('\r\n');
    const transaction = createPasteTransaction(state, 1, 1, pasted);
    const inserted = pasted.replace(/\r\n/g, '\n');

    expect(transaction.newDoc.toString()).toBe(`前${inserted}后`);
    expect(transaction.state.selection.main.head).toBe(1 + inserted.length);
  });
});
