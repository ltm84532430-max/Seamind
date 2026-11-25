import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAgentTool } from '../src/agent/tools/registry';
import { createFallbackTerminalCapabilities } from '../src/agent/tools/terminal-bridge';
import {
  getCodeLabLiveBridge,
  registerCodeLabLiveBridge,
  type CodeLabLiveBridgeController,
} from '../src/terminal/codelab-live-bridge';

describe('CodeLab live bridge & DataLab CRUD tools', () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('registers and disposes the live bridge controller cleanly', () => {
    expect(getCodeLabLiveBridge()).toBeNull();
    const mockController: CodeLabLiveBridgeController = {
      readNotebook: vi.fn().mockResolvedValue(null),
      pushCell: vi.fn(),
      updateCell: vi.fn(),
      runCell: vi.fn(),
      deleteCell: vi.fn(),
    };
    dispose = registerCodeLabLiveBridge(mockController);
    expect(getCodeLabLiveBridge()).toBe(mockController);
    dispose();
    dispose = null;
    expect(getCodeLabLiveBridge()).toBeNull();
  });

  it('reads, updates, pushes, runs, and deletes cells through the live bridge', async () => {
    const mockController: CodeLabLiveBridgeController = {
      readNotebook: vi.fn().mockResolvedValue({
        source: 'live',
        tabId: 'tab-lab-2',
        fileId: 'nb-1',
        title: 'Python 交互实验本.ipynb',
        folder: '书籍伴读验证',
        language: 'python',
        cells: [
          {
            cellId: 'cell-sql-1',
            index: 1,
            kind: 'code',
            language: 'sql',
            status: 'idle',
            executionCount: null,
            groupId: 'grp-1',
            groupTitle: '复合分析区块 #1',
            source: 'SELECT * FROM stock LIMIT 10;',
            outputs: [],
          },
          {
            cellId: 'cell-py-2',
            index: 2,
            kind: 'code',
            language: 'python',
            status: 'idle',
            executionCount: null,
            groupId: 'grp-1',
            groupTitle: '复合分析区块 #1',
            source: 'df = sm_load("stage_data")',
            outputs: [],
          },
        ],
      }),
      updateCell: vi.fn().mockResolvedValue({
        ok: true,
        notebookTitle: 'Python 交互实验本.ipynb',
        fileId: 'nb-1',
        tabId: 'tab-lab-2',
        cellId: 'cell-py-2',
        cellIndex: 2,
        groupId: 'grp-1',
        groupTitle: '复合分析区块 #1',
        message: '已原地更新「Python 交互实验本.ipynb」第 #2 格（PYTHON）',
      }),
      pushCell: vi.fn().mockResolvedValue({
        ok: true,
        notebookTitle: 'Python 交互实验本.ipynb',
        fileId: 'nb-1',
        tabId: 'tab-lab-2',
        cellId: 'cell-md-3',
        cellIndex: 3,
        groupId: 'grp-1',
        groupTitle: '复合分析区块 #1',
        message: '已向「Python 交互实验本.ipynb」插入第 #3 格',
      }),
      runCell: vi.fn().mockResolvedValue({
        ok: true,
        notebookTitle: 'Python 交互实验本.ipynb',
        fileId: 'nb-1',
        tabId: 'tab-lab-2',
        groupId: 'grp-1',
        groupTitle: '复合分析区块 #1',
        executedCells: [
          {
            cellId: 'cell-py-2',
            index: 2,
            language: 'python',
            groupId: 'grp-1',
            status: 'success',
            executionCount: 1,
            outputs: ['[stdout] plotted stock timeline'],
          },
        ],
        message: '已完成「Python 交互实验本.ipynb」中 1 个代码块执行',
      }),
      deleteCell: vi.fn().mockResolvedValue({
        ok: true,
        notebookTitle: 'Python 交互实验本.ipynb',
        fileId: 'nb-1',
        tabId: 'tab-lab-2',
        deletedCount: 1,
        message: '已从「Python 交互实验本.ipynb」删除 1 个单元格',
      }),
    };

    dispose = registerCodeLabLiveBridge(mockController);
    const caps = createFallbackTerminalCapabilities();

    const readRes = await executeAgentTool(
      'datalab_read_notebook',
      JSON.stringify({}),
      caps,
    );
    expect(readRes.summary).toContain('当前实时窗口');
    expect(
      (readRes.result.notebook as { cells: unknown[] }).cells,
    ).toHaveLength(2);

    const updateRes = await executeAgentTool(
      'datalab_update_cell',
      JSON.stringify({
        groupId: 'grp-1',
        matchLanguage: 'python',
        source: '# 绘制股票时间序列图\nimport matplotlib.pyplot as plt\n',
        autoRun: true,
      }),
      caps,
    );
    expect(updateRes.result.ok).toBe(true);
    expect(updateRes.result.cellId).toBe('cell-py-2');
    expect(mockController.updateCell).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 'grp-1',
        matchLanguage: 'python',
        autoRun: true,
      }),
    );

    const pushRes = await executeAgentTool(
      'datalab_push_cell',
      JSON.stringify({
        language: 'markdown',
        source: '### 股票走势结论',
        groupId: 'grp-1',
      }),
      caps,
    );
    expect(pushRes.result.cellId).toBe('cell-md-3');

    const runRes = await executeAgentTool(
      'datalab_run_cell',
      JSON.stringify({ groupId: 'grp-1' }),
      caps,
    );
    expect(runRes.result.ok).toBe(true);
    expect(
      (runRes.result.executedCells as Array<{ status: string }>)[0].status,
    ).toBe('success');

    const delRes = await executeAgentTool(
      'datalab_delete_cell',
      JSON.stringify({ cellId: 'cell-md-3' }),
      caps,
    );
    expect(delRes.result.deletedCount).toBe(1);
  });
});
