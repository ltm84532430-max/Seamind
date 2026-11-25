import { describe, expect, it } from 'vitest';
import { agentToolCatalog } from '../src/agent/capabilities';
import { selectTerminalAgentToolNames } from '../src/agent/tools/terminal-bridge';
import {
  applyAutocompleteCandidate,
  buildSmartFooterHints,
  detectTriggerAutocomplete,
  DOT_MATRIX_BOOK_SPLASH,
  hasTerminalErrorSignal,
  METALLIC_BOOK_PALETTE,
  METALLIC_BOOK_PIXEL_GRID,
  parseTerminalAgentInput,
  TERMINAL_SLASH_COMMANDS,
  tokenizePromptEntities,
  WORKSPACE_LAYOUT_PRESETS,
} from '../src/terminal/terminal-agent-protocol';
import {
  assembleFullScriptSource,
  createDefaultCodeLabCollection,
  groupCodeLabFilesByFolder,
} from '../src/terminal/terminal-codelab-model';

describe('terminal agent /## protocol', () => {
  it('parses slash command and #resource mentions uniformly', () => {
    const parsed = parseTerminalAgentInput(
      '/book 总结 #chapter 的信号采样公式，并对照 #kb:通信原理 #pane:2 #last-error',
    );
    expect(parsed.slashCommand).toBe('/book');
    expect(parsed.mentions.map((m) => [m.tag, m.arg ?? null])).toEqual([
      ['#chapter', null],
      ['#kb', '通信原理'],
      ['#pane', '2'],
      ['#last-error', null],
    ]);
  });

  it('triggers / autocomplete only at command start and # anywhere at token start', () => {
    const slashMatch = detectTriggerAutocomplete('/ex', 3);
    expect(slashMatch?.kind).toBe('slash');
    expect(slashMatch?.candidates.slice(0, 2).map((c) => c.title)).toEqual([
      '/exam',
      '/exec',
    ]);

    const midTextSlash = detectTriggerAutocomplete('a / b', 3);
    expect(midTextSlash).toBeNull();

    const mentionMatch = detectTriggerAutocomplete('diagnose #last', 14, {
      books: [{ title: '深入理解计算机系统' }],
      documents: [{ title: 'OS笔记' }],
    });
    expect(mentionMatch?.kind).toBe('mention');
    expect(
      mentionMatch?.candidates.some((c) => c.title === '#last-error'),
    ).toBe(true);

    const dynBookMatch = detectTriggerAutocomplete('/book #计算机', 10, {
      books: [{ title: '深入理解计算机系统' }, { title: '算法导论' }],
    });
    expect(
      dynBookMatch?.candidates.some((c) =>
        c.title.includes('深入理解计算机系统'),
      ),
    ).toBe(true);
  });

  it('replaces active trigger token cleanly and advances caret', () => {
    const text = 'explain #la wrong';
    const match = detectTriggerAutocomplete(text, 11);
    expect(match).not.toBeNull();
    const lastErr = match!.candidates.find((c) => c.title === '#last-error');
    expect(lastErr).toBeDefined();
    const applied = applyAutocompleteCandidate(text, match!, lastErr!);
    expect(applied.nextValue).toBe('explain #last-error  wrong');
    expect(applied.nextCaret).toBe('explain #last-error '.length);
  });

  it('routes slash intents and exposes full tool catalog in default mode within the Rust ceiling', () => {
    const known = new Set(agentToolCatalog.map((t) => t.name));
    for (const cmd of TERMINAL_SLASH_COMMANDS) {
      const selected = selectTerminalAgentToolNames(cmd.command, 'test');
      expect(selected.length).toBeLessThanOrEqual(64);
      for (const name of selected) {
        expect(known.has(name)).toBe(true);
      }
    }
    const general = selectTerminalAgentToolNames(null, '帮我填写左侧代码块');
    expect(general.length).toBe(agentToolCatalog.length);
    expect(general).toContain('datalab_update_cell');
    expect(general).toContain('datalab_run_cell');
    expect(general).toContain('datalab_delete_cell');
    expect(general).toContain('mindmap_propose_node_branch');
    expect(general).toContain('knowledge_update_book_note');
    expect(general).toContain('learning_path_propose');

    const ytGeneral = selectTerminalAgentToolNames(
      null,
      'YouTube 视频学习路径',
    );
    expect(ytGeneral[0]).toBe('player_search_youtube');
    expect(ytGeneral.length).toBe(agentToolCatalog.length);
  });

  it('keeps symmetrical widths on the dot-matrix book splash art', () => {
    const lines = DOT_MATRIX_BOOK_SPLASH.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(10);
    const width = lines[0].length;
    for (const line of lines) {
      expect(line.length).toBe(width);
    }
  });

  it('tokenizes leading /command and inline #resource mentions cleanly', () => {
    const tokens = tokenizePromptEntities(
      '/book 对照 #chapter 与 #pane:2 以及 math#tag',
    );
    expect(tokens).toEqual([
      { kind: 'slash', value: '/book' },
      { kind: 'text', value: ' 对照 ' },
      { kind: 'mention', value: '#chapter' },
      { kind: 'text', value: ' 与 ' },
      { kind: 'mention', value: '#pane:2' },
      { kind: 'text', value: ' 以及 math#tag' },
    ]);
  });

  it('defines consistent multi-pane workspace presets matching slot counts', () => {
    const ids = new Set<string>();
    const expectedSlots: Record<string, number> = {
      vertical: 2,
      tri: 3,
      quad: 4,
    };
    for (const preset of WORKSPACE_LAYOUT_PRESETS) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);
      expect(preset.title.trim().length).toBeGreaterThan(0);
      expect(preset.description.trim().length).toBeGreaterThan(0);
      expect(preset.slots.length).toBe(expectedSlots[preset.splitMode]);
    }
  });

  it('detects terminal errors and builds mode-aware smart footer hints', () => {
    expect(hasTerminalErrorSignal('Traceback (most recent call last):')).toBe(
      true,
    );
    expect(hasTerminalErrorSignal('error: undefined reference to `main`')).toBe(
      true,
    );
    expect(hasTerminalErrorSignal('PS C:\\Users\\demo> dir')).toBe(false);

    const agentHints = buildSmartFooterHints('agent', false);
    expect(agentHints.some((h) => h.keys === 'Ctrl+M')).toBe(true);
    expect(agentHints.find((h) => h.keys === 'Ctrl+Shift+M')?.label).toBe(
      '放大窗格',
    );

    const zoomedLabHints = buildSmartFooterHints('lab', true);
    expect(zoomedLabHints.some((h) => h.keys === 'Shift+↵')).toBe(true);
    expect(zoomedLabHints.find((h) => h.keys === 'Ctrl+Shift+M')?.label).toBe(
      '还原分屏',
    );
  });

  it('defines a strict 22x15 integer pixel grid for the metallic open-book CLI emblem', () => {
    expect(METALLIC_BOOK_PIXEL_GRID).toHaveLength(15);
    for (const row of METALLIC_BOOK_PIXEL_GRID) {
      expect(row).toHaveLength(22);
      for (const ch of row) {
        if (ch !== '.') {
          expect(METALLIC_BOOK_PALETTE[ch]).toMatch(/^#[0-9A-F]{6}$/i);
        }
      }
    }
  });

  it('groups collected Code Lab files by folder and assembles full script source', () => {
    const files = createDefaultCodeLabCollection();
    expect(files.length).toBeGreaterThanOrEqual(3);

    const pyOnly = groupCodeLabFilesByFolder(files, '', 'python');
    const pyItems = pyOnly.flatMap((g) => g.items);
    expect(pyItems.length).toBe(1);
    expect(pyItems[0].language).toBe('python');

    const bySearch = groupCodeLabFilesByFolder(files, 'CSAPP', 'all');
    expect(bySearch.flatMap((g) => g.items)).toHaveLength(1);

    const pyScript = assembleFullScriptSource(files[0].cells, 'python');
    expect(pyScript).toContain('import math');
    expect(pyScript).toContain('# --- [代码格 #1] ---');

    const cScript = assembleFullScriptSource(
      files[1].cells,
      'c',
      files[1].prologueSource,
    );
    expect(cScript).toContain('#include <stdio.h>');
    expect(cScript).toContain('int main(void)');
  });
});
