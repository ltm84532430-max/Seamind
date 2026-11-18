import type { ActiveDocument } from './active-document';
import MarkdownDocWorkbench, { type DocViewMode } from './MarkdownDocWorkbench';
import type { PreviewFootnoteJumpRequest } from './MarkdownPreview';
import MermaidWorkbench from './MermaidWorkbench';
import type { MapDocument } from '../library/library';
import type { CodeBlockHandlers } from './code-blocks';
import type { Theme } from '../app/app-storage';

export interface DocumentWorkbenchProps {
  document: ActiveDocument;
  dirty: boolean;
  statusText: string;
  theme: Theme;
  documents?: readonly MapDocument[];
  categories?: readonly string[];
  scrollToFootnoteRequest?: PreviewFootnoteJumpRequest | null;
  paneKey?: string;
  compactSplit?: boolean;
  controlledViewMode?: DocViewMode;
  onViewModeChange?(mode: DocViewMode): void;
  renderMarkdownPreview(markdown: string): { html: string; source: string };
  onSourceChange(source: string): void;
  onSave(): void;
  onRename(title: string): Promise<boolean>;
  onChangeCategory?(category: string): Promise<boolean>;
  onChangeTags?(tags: string[]): Promise<boolean>;
  onOpenWikilink?(target: string, options?: { split?: boolean }): void;
  onOpenYouTubeLink?(
    videoId: string,
    startSeconds: number,
    fallbackTitle?: string,
  ): void;
  onRunInTerminal?: CodeBlockHandlers['onRunInTerminal'];
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
  scrollToFootnoteRequest,
  paneKey,
  compactSplit,
  controlledViewMode,
  onViewModeChange,
  onOpenAsMindmap,
  onConvertToMindmap,
  onChangeCategory,
  onChangeTags,
  onOpenWikilink,
  onOpenYouTubeLink,
  onRunInTerminal,
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
      key={paneKey ? `${paneKey}-${document.session}` : document.session}
      document={document}
      documents={documents}
      categories={categories}
      theme={theme}
      scrollToFootnoteRequest={scrollToFootnoteRequest}
      paneKey={paneKey}
      compactSplit={compactSplit}
      controlledViewMode={controlledViewMode}
      onViewModeChange={onViewModeChange}
      renderPreview={renderMarkdownPreview}
      onChangeCategory={onChangeCategory}
      onChangeTags={onChangeTags}
      onOpenWikilink={onOpenWikilink}
      onOpenYouTubeLink={onOpenYouTubeLink}
      onRunInTerminal={onRunInTerminal}
      onOpenAsMindmap={onOpenAsMindmap}
      onConvertToMindmap={onConvertToMindmap}
      {...shared}
    />
  );
}
