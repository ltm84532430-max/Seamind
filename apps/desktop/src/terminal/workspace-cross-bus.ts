import type { ActiveWorkspace } from '../app/app-storage';
import type { CodeLabSourceOrigin } from './terminal-codelab-model';
import type { TerminalCodeLabLanguage } from './terminal-types';

export interface PaneTextSnapshot {
  title: string;
  cwd: string;
  text: string;
}

export interface ShellRuntimeProvider {
  readPaneText: (
    paneNumber: number,
    maxLines?: number,
  ) => PaneTextSnapshot | null;
  readLastError: () => string;
  sendToShell: (
    command: string,
    execute?: boolean,
    paneNumber?: number,
  ) => void;
}

export interface LabRuntimeProvider {
  readPaneText: (
    paneNumber: number,
    maxLines?: number,
  ) => PaneTextSnapshot | null;
  readLastError: () => string;
  pushToCodeLab: (
    language: TerminalCodeLabLanguage,
    code: string,
    autoRun?: boolean,
    origin?: CodeLabSourceOrigin,
  ) => void;
}

export interface AgentRuntimeProvider {
  submitPrompt: (prompt: string) => void;
  openModelModal: () => void;
}

export interface WorkspaceSplitCoordinator {
  openSplitPair: (primary: ActiveWorkspace, secondary: ActiveWorkspace) => void;
  openInSecondaryPane: (target: ActiveWorkspace) => void;
}

let shellProvider: ShellRuntimeProvider | null = null;
let labProvider: LabRuntimeProvider | null = null;
let agentProvider: AgentRuntimeProvider | null = null;
let splitCoordinator: WorkspaceSplitCoordinator | null = null;

const pendingAgentPrompts: string[] = [];
const pendingShellCommands: Array<{
  command: string;
  execute: boolean;
  paneNumber?: number;
}> = [];
const pendingLabPushes: Array<{
  language: TerminalCodeLabLanguage;
  code: string;
  autoRun: boolean;
  origin?: CodeLabSourceOrigin;
}> = [];

export function registerShellRuntimeProvider(
  provider: ShellRuntimeProvider,
): () => void {
  shellProvider = provider;
  if (pendingShellCommands.length > 0) {
    const queued = pendingShellCommands.splice(0, pendingShellCommands.length);
    for (const item of queued) {
      provider.sendToShell(item.command, item.execute, item.paneNumber);
    }
  }
  return () => {
    if (shellProvider === provider) shellProvider = null;
  };
}

export function registerLabRuntimeProvider(
  provider: LabRuntimeProvider,
): () => void {
  labProvider = provider;
  if (pendingLabPushes.length > 0) {
    const queued = pendingLabPushes.splice(0, pendingLabPushes.length);
    for (const item of queued) {
      provider.pushToCodeLab(
        item.language,
        item.code,
        item.autoRun,
        item.origin,
      );
    }
  }
  return () => {
    if (labProvider === provider) labProvider = null;
  };
}

export function registerAgentRuntimeProvider(
  provider: AgentRuntimeProvider,
): () => void {
  agentProvider = provider;
  if (pendingAgentPrompts.length > 0) {
    const queued = pendingAgentPrompts.splice(0, pendingAgentPrompts.length);
    for (const prompt of queued) {
      provider.submitPrompt(prompt);
    }
  }
  return () => {
    if (agentProvider === provider) agentProvider = null;
  };
}

export function registerWorkspaceSplitCoordinator(
  coordinator: WorkspaceSplitCoordinator,
): () => void {
  splitCoordinator = coordinator;
  return () => {
    if (splitCoordinator === coordinator) splitCoordinator = null;
  };
}

export function dispatchOpenSplitPair(
  primary: ActiveWorkspace,
  secondary: ActiveWorkspace,
): void {
  splitCoordinator?.openSplitPair(primary, secondary);
}

export function dispatchCrossSendToAgent(prompt: string): boolean {
  splitCoordinator?.openInSecondaryPane('agent');
  if (agentProvider) {
    agentProvider.submitPrompt(prompt);
    return true;
  }
  pendingAgentPrompts.push(prompt);
  return Boolean(splitCoordinator);
}

export function dispatchCrossSendToShell(
  command: string,
  execute = true,
  paneNumber?: number,
): boolean {
  splitCoordinator?.openInSecondaryPane('terminal');
  if (shellProvider) {
    shellProvider.sendToShell(command, execute, paneNumber);
    return true;
  }
  pendingShellCommands.push({ command, execute, paneNumber });
  return Boolean(splitCoordinator);
}

export function dispatchCrossPushToLab(
  language: TerminalCodeLabLanguage,
  code: string,
  autoRun = true,
  origin?: CodeLabSourceOrigin,
): boolean {
  splitCoordinator?.openInSecondaryPane('lab');
  if (labProvider) {
    labProvider.pushToCodeLab(language, code, autoRun, origin);
    return true;
  }
  pendingLabPushes.push({ language, code, autoRun, origin });
  return Boolean(splitCoordinator);
}

export function readCrossWorkspacePaneText(
  paneNumber: number,
  maxLines = 80,
): PaneTextSnapshot | null {
  return (
    shellProvider?.readPaneText(paneNumber, maxLines) ??
    labProvider?.readPaneText(paneNumber, maxLines) ??
    null
  );
}

export function readCrossWorkspaceLastError(): string {
  const labErr = labProvider?.readLastError();
  if (labErr) return labErr;
  return shellProvider?.readLastError() ?? '';
}
