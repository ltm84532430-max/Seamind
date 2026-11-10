import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_ACTION_ITEMS } from '../src/terminal/terminal-cheatsheet';
import {
  filterKnowledgeActions,
  knowledgeActionNote,
  knowledgeCommandForShell,
  knowledgeShells,
} from '../src/terminal/terminal-knowledge';

const catalog = [
  { id: 'powershell' as const, name: 'PowerShell', available: true },
  { id: 'wsl' as const, name: 'WSL Linux', available: true },
  { id: 'bash' as const, name: 'Git Bash', available: true },
  { id: 'cmd' as const, name: 'Command Prompt', available: true },
];

describe('knowledge action list', () => {
  it('keeps the agent command on PowerShell only', () => {
    const agent = KNOWLEDGE_ACTION_ITEMS.find(
      (item) => item.id === 'act-agent-review',
    );
    expect(agent).toBeDefined();
    if (!agent) return;
    expect(knowledgeCommandForShell(agent, 'powershell')).toContain('agy');
    expect(knowledgeCommandForShell(agent, 'bash')).toBeUndefined();
    expect(knowledgeShells(agent, catalog).map((shell) => shell.id)).toEqual([
      'powershell',
    ]);
    expect(
      filterKnowledgeActions(KNOWLEDGE_ACTION_ITEMS, 'agy').map(
        (item) => item.id,
      ),
    ).toEqual(['act-agent-review']);
  });

  it('finds an example path inside the command text', () => {
    expect(
      filterKnowledgeActions(KNOWLEDGE_ACTION_ITEMS, '计算机网络复习').map(
        (item) => item.id,
      ),
    ).toEqual(['act-kb-append']);
    expect(filterKnowledgeActions(KNOWLEDGE_ACTION_ITEMS, '')).toHaveLength(
      KNOWLEDGE_ACTION_ITEMS.length,
    );
  });

  it('says the snippet stays in the current directory', () => {
    const append = KNOWLEDGE_ACTION_ITEMS.find(
      (item) => item.id === 'act-kb-append',
    );
    const list = KNOWLEDGE_ACTION_ITEMS.find(
      (item) => item.id === 'act-kb-list',
    );
    const agent = KNOWLEDGE_ACTION_ITEMS.find(
      (item) => item.id === 'act-agent-review',
    );
    expect(append && knowledgeActionNote(append)).toContain('运行前需要确认');
    expect(append && knowledgeActionNote(append)).toContain('不会打开知识库');
    expect(list && knowledgeActionNote(list)).not.toContain('运行前需要确认');
    expect(list && knowledgeActionNote(list)).toContain('不会打开知识库');
    expect(agent && knowledgeActionNote(agent)).toContain(
      '不会打开知识库或导图',
    );
  });
});
