import { useMemo } from 'react';
import katex from 'katex';
import { sanitizeNode } from '../app/app-style-utils';
import { inlineMathError, splitInlineMath } from './exam-math';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderExamRichText(text: string): string {
  if (inlineMathError(text) || typeof DOMParser === 'undefined') {
    return escapeHtml(text);
  }
  const html = splitInlineMath(text)
    .map((part) => {
      if (part.kind === 'text') return escapeHtml(part.value);
      try {
        return katex.renderToString(part.value, {
          throwOnError: false,
          displayMode: false,
          strict: 'ignore',
        });
      } catch {
        return escapeHtml(`$${part.value}$`);
      }
    })
    .join('');
  return sanitizeNode({ content: html, children: [] }).content;
}

export function ExamRichText({ text }: { text: string }) {
  const html = useMemo(() => renderExamRichText(text), [text]);
  return (
    <span
      className="exam-rich-text"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
