export interface InlineMathPart {
  kind: 'text' | 'math';
  value: string;
}

interface MathScan {
  parts: InlineMathPart[];
  error: string | null;
}

/** A backslash escapes the next character. `$$`, an empty formula, or an unclosed `$` is rejected. */
function scanInlineMath(text: string): MathScan {
  const parts: InlineMathPart[] = [];
  let textValue = '';
  let formula = '';
  let open = false;
  const chars = Array.from(text);

  const pushText = () => {
    if (!textValue) return;
    parts.push({ kind: 'text', value: textValue });
    textValue = '';
  };

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === '\\') {
      const next = chars[index + 1];
      if (next === undefined) {
        if (open) formula += '\\';
        else textValue += '\\';
        break;
      }
      index += 1;
      if (open) formula += `\\${next}`;
      else textValue += next;
      continue;
    }
    if (char === '$') {
      if (open) {
        if (formula.trim() === '') return { parts, error: '公式不能为空。' };
        pushText();
        parts.push({ kind: 'math', value: formula });
        formula = '';
        open = false;
      } else {
        open = true;
        formula = '';
      }
      continue;
    }
    if (open) formula += char;
    else textValue += char;
  }

  if (open) return { parts, error: '公式的 $ 没有成对闭合。' };
  pushText();
  return { parts, error: null };
}

export function inlineMathError(text: string): string | null {
  if (text.includes('$$')) return '公式不能使用 $$。';
  return scanInlineMath(text).error;
}

export function splitInlineMath(text: string): InlineMathPart[] {
  if (text.includes('$$')) return [{ kind: 'text', value: text }];
  const scanned = scanInlineMath(text);
  if (scanned.error) return [{ kind: 'text', value: text }];
  return scanned.parts;
}
