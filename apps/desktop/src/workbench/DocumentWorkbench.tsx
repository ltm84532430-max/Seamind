import type { ActiveDocument } from './active-document';
import MarkdownDocWorkbench from './MarkdownDocWorkbench';
import MermaidWorkbench from './MermaidWorkbench';
import type { MapDocument } from '../library';

export interface DocumentWorkbenchProps {
  document: ActiveDocument;
  dirty: boolean;
  statusText: string;
  theme: 'light' | 'dark';
  documents?: readonly MapDocument[];
  categories?: readonly string[];
  renderMarkdownPreview(markdown: string): { html: string; source: string };
  onSourceChange(source: string): void;
  onSave(): void;
  onRename(title: string): Promise<boolean>;
  onChangeCategory?(category: string): Promise<boolean>;
  onChangeTags?(tags: string[]): Promise<boolean>;
  onOpenWikilink?(target: string): void;
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
  onChangeCategory,
  onChangeTags,
  onOpenWikilink,
  theme,
  documents,
  categories,
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
      documents={documents}
      categories={categories}
      theme={theme}
      renderPreview={renderMarkdownPreview}
      onChangeCategory={onChangeCategory}
      onChangeTags={onChangeTags}
      onOpenWikilink={onOpenWikilink}
      onOpenAsMindmap={onOpenAsMindmap}
      onConvertToMindmap={onConvertToMindmap}
      {...shared}
    />
  );
}
