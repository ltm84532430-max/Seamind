import type { ActiveDocument } from './active-document';
import MarkdownDocWorkbench from './MarkdownDocWorkbench';
import MermaidWorkbench from './MermaidWorkbench';

export interface DocumentWorkbenchProps {
  document: ActiveDocument;
  dirty: boolean;
  statusText: string;
  theme: 'light' | 'dark';
  renderMarkdownPreview(markdown: string): { html: string; source: string };
  onSourceChange(source: string): void;
  onSave(): void;
  onRename(title: string): Promise<boolean>;
  onOpenAsMindmap(): void;
  onConvertToMindmap(): void;
}

/**
 * The workspace for the files that are not mind maps. It picks the panes that fit the open
 * document's kind; a new kind is another branch here.
 */
export default function DocumentWorkbench({
  document,
  renderMarkdownPreview,
  onOpenAsMindmap,
  onConvertToMindmap,
  theme,
  ...shared
}: DocumentWorkbenchProps) {
  // Another file gets fresh panes, a rename of this one keeps them.
  if (document.kind === 'mermaid')
    return (
      <MermaidWorkbench
        key={document.session}
        document={document}
        {...shared}
      />
    );
  return (
    <MarkdownDocWorkbench
      key={document.session}
      document={document}
      theme={theme}
      renderPreview={renderMarkdownPreview}
      onOpenAsMindmap={onOpenAsMindmap}
      onConvertToMindmap={onConvertToMindmap}
      {...shared}
    />
  );
}
