import { EditorState, Transaction } from '@codemirror/state';

/** 构造粘贴事务，并以 CodeMirror 实际解析后的长度设置光标。 */
export function createPasteTransaction(
  state: EditorState,
  from: number,
  to: number,
  text: string,
): Transaction {
  const start = Math.max(0, Math.min(from, state.doc.length));
  const end = Math.max(start, Math.min(to, state.doc.length));
  const insert = state.toText(text);
  return state.update({
    changes: { from: start, to: end, insert },
    selection: { anchor: start + insert.length },
    annotations: Transaction.userEvent.of('input.paste'),
  });
}
