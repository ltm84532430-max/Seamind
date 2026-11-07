import { useMemo, useState } from 'react';

export interface MindmapMiniTreeNode {
  path: string;
  label: string;
  children: MindmapMiniTreeNode[];
}

function findNode(
  node: MindmapMiniTreeNode | null,
  path: string,
): MindmapMiniTreeNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children) {
    const match = findNode(child, path);
    if (match) return match;
  }
  return null;
}

function findParent(
  node: MindmapMiniTreeNode | null,
  targetPath: string,
): MindmapMiniTreeNode | null {
  if (!node) return null;
  if (node.children.some((child) => child.path === targetPath)) return node;
  for (const child of node.children) {
    const match = findParent(child, targetPath);
    if (match) return match;
  }
  return null;
}

function TreeRows({
  nodes,
  selectedPath,
  expandedPath,
  depth,
  onSelect,
}: {
  nodes: MindmapMiniTreeNode[];
  selectedPath: string;
  expandedPath: string;
  depth: number;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className={`mindmap-mini-tree-list depth-${Math.min(depth, 2)}`}>
      {nodes.map((node) => (
        <li key={node.path}>
          <button
            type="button"
            className={`mindmap-mini-tree-node${node.path === selectedPath ? ' is-selected' : ''}`}
            aria-current={node.path === selectedPath ? 'true' : undefined}
            title={node.label}
            onClick={() => onSelect(node.path)}
          >
            <span className="mindmap-mini-tree-dot" aria-hidden="true" />
            <span className="mindmap-mini-tree-label">
              {node.label || '（无标题）'}
            </span>
          </button>
          {node.path === expandedPath && node.children.length > 0 && (
            <TreeRows
              nodes={node.children}
              selectedPath={selectedPath}
              expandedPath=""
              depth={depth + 1}
              onSelect={onSelect}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

export default function MindmapMiniTree({
  root,
  selectedPath,
  onSelect,
}: {
  root: MindmapMiniTreeNode | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const context = useMemo(() => {
    if (!root || !selectedPath) return null;
    const selected = findNode(root, selectedPath);
    if (!selected) return null;
    const parent = findParent(root, selectedPath);
    return {
      siblings: parent?.children ?? [root],
      expandedPath: selected.path,
      label: selected.label,
    };
  }, [root, selectedPath]);

  if (!context || !selectedPath) return null;

  return (
    <aside
      className={`mindmap-mini-tree${collapsed ? ' is-collapsed' : ''}`}
      aria-label="节点结构缩略图"
    >
      <header className="mindmap-mini-tree-heading">
        <span>节点结构</span>
        {!collapsed && (
          <span className="mindmap-mini-tree-current" title={context.label}>
            {context.label}
          </span>
        )}
        <button
          type="button"
          className="mindmap-mini-tree-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开节点结构' : '收起节点结构'}
          title={collapsed ? '展开节点结构' : '收起节点结构'}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? '+' : '−'}
        </button>
      </header>
      {!collapsed && (
        <div className="mindmap-mini-tree-scroll">
          <TreeRows
            nodes={context.siblings}
            selectedPath={selectedPath}
            expandedPath={context.expandedPath}
            depth={0}
            onSelect={onSelect}
          />
        </div>
      )}
    </aside>
  );
}
