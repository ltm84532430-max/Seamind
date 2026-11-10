import type { KnowledgeActionItem, TerminalShellType } from './terminal-types';
import type { ShellCatalogEntry } from './terminal-commands';

export const KNOWLEDGE_TARGET_LABEL: Record<
  KnowledgeActionItem['category'],
  string
> = {
  kb: '知识库',
  map: '导图',
  exam: '试卷',
  agent: '全应用',
};

export function knowledgeCommandForShell(
  item: Pick<KnowledgeActionItem, 'commandByShell'>,
  shell: TerminalShellType,
): string | undefined {
  const command = item.commandByShell?.[shell];
  return command || undefined;
}

export function knowledgeShells(
  item: Pick<KnowledgeActionItem, 'commandByShell'>,
  catalog: readonly ShellCatalogEntry[],
): Array<ShellCatalogEntry & { command: string }> {
  return catalog.flatMap((shell) => {
    const command = knowledgeCommandForShell(item, shell.id);
    return command ? [{ ...shell, command }] : [];
  });
}

export function filterKnowledgeActions<T extends KnowledgeActionItem>(
  items: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => {
    const haystack = [
      item.title,
      item.description,
      item.targetWorkspace,
      KNOWLEDGE_TARGET_LABEL[item.category],
      ...Object.values(item.commandByShell ?? {}),
    ];
    return haystack.some(
      (value) =>
        typeof value === 'string' && value.toLocaleLowerCase().includes(needle),
    );
  });
}

/** One line under the focused row. These snippets do not open a workspace. */
export function knowledgeActionNote(
  item: Pick<
    KnowledgeActionItem,
    'category' | 'description' | 'requiresConfirmation'
  >,
): string {
  const surface =
    item.category === 'agent'
      ? '知识库或导图'
      : KNOWLEDGE_TARGET_LABEL[item.category];
  if (item.requiresConfirmation) {
    return `${item.description} 示例命令，路径写在当前目录，运行前需要确认，不会打开${surface}。`;
  }
  return `${item.description} 示例命令，只在当前目录执行，不会打开${surface}。`;
}
