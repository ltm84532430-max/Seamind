import type { CodeLabCell, CodeLabCellKind } from './terminal-codelab-model';
import type { TerminalCodeLabLanguage } from './terminal-types';

export interface CodeLabCellSnapshot {
  cellId: string;
  index: number;
  kind: CodeLabCellKind;
  language: TerminalCodeLabLanguage;
  status: CodeLabCell['status'];
  executionCount: number | null;
  groupId?: string;
  groupTitle?: string;
  sqlConnectionId?: string;
  sqlResultVar?: string;
  source: string;
  outputs: string[];
}

export interface CodeLabLiveNotebookSnapshot {
  source: 'live' | 'draft' | 'saved';
  tabId?: string;
  fileId: string | null;
  title: string;
  folder: string;
  language: TerminalCodeLabLanguage;
  cells: CodeLabCellSnapshot[];
}

export interface CodeLabNotebookSelector {
  fileId?: string;
  title?: string;
}

export interface CodeLabPushCellRequest extends CodeLabNotebookSelector {
  kind: CodeLabCellKind;
  language: TerminalCodeLabLanguage;
  source: string;
  autoRun?: boolean;
  sqlConnectionId?: string;
  sqlResultVar?: string;
  groupId?: string;
  groupTitle?: string;
  afterCellId?: string;
}

export interface CodeLabUpdateCellRequest extends CodeLabNotebookSelector {
  cellId?: string;
  cellIndex?: number;
  groupId?: string;
  matchLanguage?: TerminalCodeLabLanguage | 'markdown';
  source?: string;
  kind?: CodeLabCellKind;
  language?: TerminalCodeLabLanguage;
  sqlConnectionId?: string;
  sqlResultVar?: string;
  newGroupId?: string;
  newGroupTitle?: string;
  autoRun?: boolean;
}

export interface CodeLabRunCellRequest extends CodeLabNotebookSelector {
  cellId?: string;
  cellIndex?: number;
  groupId?: string;
  runAll?: boolean;
}

export interface CodeLabDeleteCellRequest extends CodeLabNotebookSelector {
  cellId?: string;
  cellIndex?: number;
  groupId?: string;
}

export interface CodeLabCellExecutionRecord {
  cellId: string;
  index: number;
  language: TerminalCodeLabLanguage;
  groupId?: string;
  status: CodeLabCell['status'];
  executionCount: number | null;
  outputs: string[];
}

export interface CodeLabMutationResult {
  ok: boolean;
  notebookTitle: string;
  fileId: string | null;
  tabId?: string;
  cellId?: string;
  cellIndex?: number;
  groupId?: string;
  groupTitle?: string;
  deletedCount?: number;
  executedCells?: CodeLabCellExecutionRecord[];
  message: string;
  error?: string;
}

export interface CodeLabLiveBridgeController {
  readNotebook: (
    selector?: CodeLabNotebookSelector,
  ) => Promise<CodeLabLiveNotebookSnapshot | null>;
  pushCell: (request: CodeLabPushCellRequest) => Promise<CodeLabMutationResult>;
  updateCell: (
    request: CodeLabUpdateCellRequest,
  ) => Promise<CodeLabMutationResult>;
  runCell: (request: CodeLabRunCellRequest) => Promise<CodeLabMutationResult>;
  deleteCell: (
    request: CodeLabDeleteCellRequest,
  ) => Promise<CodeLabMutationResult>;
}

let activeLiveBridgeController: CodeLabLiveBridgeController | null = null;

/**
 * Registers the live Code Lab workspace controller so Agent & MCP tools can
 * directly inspect, edit, execute, and delete cells in the visible notebook
 * pane without brittle fire-and-forget DOM events.
 */
export function registerCodeLabLiveBridge(
  controller: CodeLabLiveBridgeController,
): () => void {
  activeLiveBridgeController = controller;
  return () => {
    if (activeLiveBridgeController === controller) {
      activeLiveBridgeController = null;
    }
  };
}

export function getCodeLabLiveBridge(): CodeLabLiveBridgeController | null {
  return activeLiveBridgeController;
}
