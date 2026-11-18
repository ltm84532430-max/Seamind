import type { PureNode } from 'markmap-lib';
import type { MindmapMiniTreeNode } from '../mindmap/MindmapMiniTree';
import {
  normalizeMindmapText,
  type MarkdownNodeSource,
} from '../mindmap/commands';

export interface PreparedMindmapTree {
  root: PureNode;
  navigation: MindmapMiniTreeNode;
}

export function prepareMindmapTree(
  root: PureNode,
  sources: Map<string, MarkdownNodeSource>,
): PreparedMindmapTree {
  let nodeId = 0;
  const visit = (node: PureNode, parentPath = ''): PreparedMindmapTree => {
    nodeId += 1;
    const path = parentPath ? `${parentPath}.${nodeId}` : `${nodeId}`;
    const children = node.children.map((child) => visit(child, path));
    const payload = { ...node.payload, seamindSourcePath: path };
    return {
      root: {
        ...node,
        payload,
        children: children.map((child) => child.root),
      },
      navigation: {
        path,
        label:
          sources.get(path)?.label || normalizeMindmapText(node.content) || '',
        children: children.map((child) => child.navigation),
      },
    };
  };
  return visit(root);
}

export function findPureNodeBySourcePath(
  root: PureNode | null,
  path: string,
): PureNode | null {
  if (!root) return null;
  if (root.payload?.seamindSourcePath === path) return root;
  for (const child of root.children) {
    const match = findPureNodeBySourcePath(child, path);
    if (match) return match;
  }
  return null;
}

export function clonePureNode(node: PureNode): PureNode {
  return {
    ...node,
    payload: node.payload ? { ...node.payload } : undefined,
    children: node.children.map(clonePureNode),
  };
}

function isEmptyListWrapperNode(node: PureNode): boolean {
  const payload = node.payload as Record<string, unknown> | undefined;
  const tag = typeof payload?.tag === 'string' ? payload.tag : '';
  return !node.content.trim() && (tag === 'ul' || tag === 'ol');
}

/**
 * Unwraps empty `<ul>`/`<ol>` container nodes that `markmap-html-parser` retains when a
 * heading contains multiple distinct lists (e.g., `-` mixed with `1.` or `*`), preventing
 * phantom empty white boxes from appearing in the mind map.
 */
export function normalizeMindmapPureTree(node: PureNode): PureNode {
  const nextChildren = node.children.flatMap((child) => {
    const normalized = normalizeMindmapPureTree(child);
    return isEmptyListWrapperNode(normalized)
      ? normalized.children
      : [normalized];
  });
  return {
    ...node,
    children: nextChildren,
  };
}

export function findNavigationPath(
  root: MindmapMiniTreeNode | null,
  targetPath: string,
  ancestors: MindmapMiniTreeNode[] = [],
): MindmapMiniTreeNode[] {
  if (!root) return [];
  const next = [...ancestors, root];
  if (root.path === targetPath) return next;
  for (const child of root.children) {
    const match = findNavigationPath(child, targetPath, next);
    if (match.length) return match;
  }
  return [];
}
