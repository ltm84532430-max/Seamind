import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchCrossPushToLab,
  dispatchCrossSendToAgent,
  dispatchCrossSendToShell,
  dispatchOpenSplitPair,
  readCrossWorkspaceLastError,
  readCrossWorkspacePaneText,
  registerAgentRuntimeProvider,
  registerLabRuntimeProvider,
  registerShellRuntimeProvider,
  registerWorkspaceSplitCoordinator,
} from '../src/terminal/workspace-cross-bus';

describe('workspace cross-bus coordination', () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) {
      disposers.pop()?.();
    }
  });

  it('queues cross-workspace prompts until target provider mounts and triggers secondary split pane', () => {
    const openInSecondaryPane = vi.fn();
    const openSplitPair = vi.fn();
    disposers.push(
      registerWorkspaceSplitCoordinator({ openSplitPair, openInSecondaryPane }),
    );

    const queued = dispatchCrossSendToAgent('诊断 Python 报错');
    expect(queued).toBe(true);
    expect(openInSecondaryPane).toHaveBeenCalledWith('agent');

    const submitPrompt = vi.fn();
    disposers.push(
      registerAgentRuntimeProvider({
        submitPrompt,
        openModelModal: vi.fn(),
      }),
    );
    expect(submitPrompt).toHaveBeenCalledWith('诊断 Python 报错');

    dispatchOpenSplitPair('lab', 'agent');
    expect(openSplitPair).toHaveBeenCalledWith('lab', 'agent');
  });

  it('routes cross-workspace pane reads, errors, shell commands, and lab pushes cleanly', () => {
    const sendToShell = vi.fn();
    const pushToCodeLab = vi.fn();
    const openInSecondaryPane = vi.fn();

    disposers.push(
      registerWorkspaceSplitCoordinator({
        openSplitPair: vi.fn(),
        openInSecondaryPane,
      }),
    );
    disposers.push(
      registerShellRuntimeProvider({
        readPaneText: (n) => ({
          title: `PowerShell ${n}`,
          cwd: 'C:/proj',
          text: 'PS> pytest failed',
        }),
        readLastError: () => 'shell error trace',
        sendToShell,
      }),
    );
    disposers.push(
      registerLabRuntimeProvider({
        readPaneText: () => ({
          title: 'Python 实验本',
          cwd: 'C:/proj',
          text: 'df.head()',
        }),
        readLastError: () => 'KeyError: last_price',
        pushToCodeLab,
      }),
    );

    expect(readCrossWorkspacePaneText(1)?.title).toBe('PowerShell 1');
    expect(readCrossWorkspaceLastError()).toBe('KeyError: last_price');

    dispatchCrossSendToShell('pip list', true, 1);
    expect(openInSecondaryPane).toHaveBeenCalledWith('terminal');
    expect(sendToShell).toHaveBeenCalledWith('pip list', true, 1);

    dispatchCrossPushToLab('python', 'print(1)', true);
    expect(openInSecondaryPane).toHaveBeenCalledWith('lab');
    expect(pushToCodeLab).toHaveBeenCalledWith(
      'python',
      'print(1)',
      true,
      undefined,
    );
  });
});
