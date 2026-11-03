import type { EpubBookDocument, LibrarySnapshot } from './library';
import { resolveBookMindmapTarget as resolveBookMindmapTargetFromLibrary } from './book-mindmap-target';

export type ProviderSettings = { baseUrl: string; model: string };
export type Theme = 'light' | 'dark';
export type ActiveWorkspace = 'mindmap' | 'reader' | 'player' | 'knowledge';
export type MindmapStyle =
  | 'gray'
  | 'roots'
  | 'cards'
  | 'warm'
  | 'emerald'
  | 'cobalt';

export const ACTIVE_WORKSPACE_KEY = 'seamind:active-workspace:v1';
export const LAST_READER_BOOK_KEY = 'seamind:last-reader-book:v1';
export const RECOVERABLE_DRAFT_KEY = 'seamind:recoverable-mindmap-draft:v1';
export const TERMINAL_HEIGHT_KEY = 'seamind:terminal-height:v1';
export const settingsStorageKey = 'markmap.desktop.provider-settings.v1';
export const themeStorageKey = 'seamind.theme.v1';
export const mindmapStyleStorageKey = 'seamind.map-style.v1';
export const nodeSpacingStorageKey = 'seamind.node-spacing.v1';
export const aiCollapsedStorageKey = 'seamind.ai-collapsed.v1';

export interface NodeSpacing {
  horizontal: number;
  vertical: number;
}

export const defaultNodeSpacing: NodeSpacing = { horizontal: 56, vertical: 14 };

export interface ReaderSplitLayout {
  wideRatio: number;
  narrowRatio: number;
}

export const DEFAULT_READER_SPLIT_LAYOUT: ReaderSplitLayout = {
  wideRatio: 0.45,
  narrowRatio: 0.42,
};

export interface EditorDraft {
  id: string | null;
  relativePath: string | null;
  title: string;
  category: string;
  mapType: string;
  tags: string;
  markdown: string;
  dirty: boolean;
  revision: number;
}

export interface RecoverableDraft {
  rootPath: string;
  draft: EditorDraft;
}

export interface MindmapStyleDefinition {
  id: MindmapStyle;
  label: string;
  badge: string;
  summary: string;
  bestFor: string;
  direction: 'both' | 'down';
}

export const mindmapStyles: MindmapStyleDefinition[] = [
  {
    id: 'gray',
    label: '学术专著',
    badge: '经典发散',
    summary: '墨砚高对比实线 · 严谨出版级排印',
    bestFor: '论文答辩、研究综述、技术白皮书',
    direction: 'both',
  },
  {
    id: 'roots',
    label: '树根架构',
    badge: '向下扎根',
    summary: '主旨顶置 · 自顶向下垂直分叉 · 树根演进脉络',
    bestFor: '系统架构拆解、因果溯源 (5-Whys)、项目 WBS、版本路线图',
    direction: 'down',
  },
  {
    id: 'cards',
    label: '工程卡片',
    badge: '模块工整',
    summary: '板岩蓝卡片容器 · 高信息密度 · 清晰分组边界',
    bestFor: '系统组件全景、API 接口规范、需求清单、模块归属',
    direction: 'both',
  },
  {
    id: 'warm',
    label: '暖色聚类',
    badge: '思维发散',
    summary: '陶土茶色分支染色 · 柔和护眼 · 模块亲和聚类',
    bestFor: '头脑风暴、概念发散、多主线交叉思考',
    direction: 'both',
  },
];

export const defaultProviderSettings: ProviderSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};

export const starterMarkdown = `# AI 思维导图工作台

## 用 Markdown 描述结构
- 一级标题会成为中心主题
- 二级标题和列表项会形成分支
  - 支持继续嵌套
  - 编辑内容后预览自动更新

## 交互预览
- 拖动空白区域平移画布
- 滚轮缩放，点击分支连接处折叠分支
- 使用右上角按钮让整张图适应窗口

## AI 生成
- 输入主题，生成结构清楚的 Markdown
- 编辑内容会自动保存到本机文件库
`;

export function readTerminalHeight(): number {
  try {
    const stored = Number(localStorage.getItem(TERMINAL_HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= 160 && stored <= 900
      ? stored
      : 280;
  } catch {
    return 280;
  }
}

export function readActiveWorkspace(): ActiveWorkspace {
  try {
    const stored = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    return stored === 'reader' || stored === 'player' || stored === 'knowledge'
      ? stored
      : 'mindmap';
  } catch {
    return 'mindmap';
  }
}

export function readerSplitLayoutKey(progressKey: string): string {
  return `seamind:reader-split:v1:${progressKey}`;
}

export function readReaderSplitLayout(progressKey: string): ReaderSplitLayout {
  try {
    const value = JSON.parse(
      localStorage.getItem(readerSplitLayoutKey(progressKey)) || 'null',
    ) as Partial<ReaderSplitLayout> | null;
    return {
      wideRatio:
        typeof value?.wideRatio === 'number' &&
        value.wideRatio >= 0.32 &&
        value.wideRatio <= 0.65
          ? value.wideRatio
          : DEFAULT_READER_SPLIT_LAYOUT.wideRatio,
      narrowRatio:
        typeof value?.narrowRatio === 'number' &&
        value.narrowRatio >= 0.25 &&
        value.narrowRatio <= 0.65
          ? value.narrowRatio
          : DEFAULT_READER_SPLIT_LAYOUT.narrowRatio,
    };
  } catch {
    return DEFAULT_READER_SPLIT_LAYOUT;
  }
}

export function readRecoverableDraft(): RecoverableDraft | null {
  try {
    const value = localStorage.getItem(RECOVERABLE_DRAFT_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as RecoverableDraft;
    if (
      typeof parsed.rootPath === 'string' &&
      typeof parsed.draft?.title === 'string' &&
      typeof parsed.draft?.markdown === 'string' &&
      typeof parsed.draft?.category === 'string'
    )
      return parsed;
  } catch {
    // Recovery remains available in memory when browser storage is unavailable.
  }
  return null;
}

export function isEpubPath(path: string): boolean {
  return path.trim().toLowerCase().endsWith('.epub');
}

export function normalizeLibraryPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export function epubMindmapStorageKey(
  rootPath: string,
  epubRelativePath: string,
): string {
  return `seamind:epub-mindmap:v1:${encodeURIComponent(normalizeLibraryPath(rootPath))}:${encodeURIComponent(normalizeLibraryPath(epubRelativePath))}`;
}

export function loadEpubMindmapPath(
  rootPath: string,
  epubRelativePath: string,
): string | null {
  try {
    return localStorage.getItem(
      epubMindmapStorageKey(rootPath, epubRelativePath),
    );
  } catch {
    return null;
  }
}

export function saveEpubMindmapPath(
  rootPath: string,
  epubRelativePath: string,
  mindmapRelativePath: string,
): void {
  try {
    localStorage.setItem(
      epubMindmapStorageKey(rootPath, epubRelativePath),
      mindmapRelativePath,
    );
  } catch {
    // The map stays available in the current library when browser storage is full.
  }
}

export function resolveBookMindmapTarget(
  snapshot: LibrarySnapshot,
  book: Pick<EpubBookDocument, 'relativePath' | 'title'>,
) {
  return resolveBookMindmapTargetFromLibrary(
    snapshot,
    book,
    (epubRelativePath) =>
      snapshot.rootPath
        ? loadEpubMindmapPath(snapshot.rootPath, epubRelativePath)
        : null,
  );
}

export function createDraft(overrides: Partial<EditorDraft> = {}): EditorDraft {
  return {
    id: null,
    relativePath: null,
    title: 'AI 思维导图工作台',
    category: '未分类',
    mapType: '通用',
    tags: '',
    markdown: starterMarkdown,
    dirty: false,
    revision: 0,
    ...overrides,
  };
}

export function readProviderSettings(): ProviderSettings {
  try {
    const saved = localStorage.getItem(settingsStorageKey);
    if (!saved) return defaultProviderSettings;
    const parsed = JSON.parse(saved) as Partial<ProviderSettings>;
    return {
      baseUrl:
        typeof parsed.baseUrl === 'string'
          ? parsed.baseUrl
          : defaultProviderSettings.baseUrl,
      model:
        typeof parsed.model === 'string'
          ? parsed.model
          : defaultProviderSettings.model,
    };
  } catch {
    return defaultProviderSettings;
  }
}

export function readTheme(): Theme {
  try {
    return localStorage.getItem(themeStorageKey) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function readMindmapStyle(): MindmapStyle {
  try {
    const saved = localStorage.getItem(mindmapStyleStorageKey);
    return mindmapStyles.some((style) => style.id === saved)
      ? (saved as MindmapStyle)
      : 'gray';
  } catch {
    return 'gray';
  }
}

export function normalizeNodeSpacingValue(
  value: unknown,
  axis: keyof NodeSpacing,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return defaultNodeSpacing[axis];

  const min = axis === 'horizontal' ? 28 : 7;
  const max = axis === 'horizontal' ? 112 : 28;
  const step = axis === 'horizontal' ? 4 : 1;
  const clamped = Math.min(max, Math.max(min, value));
  return Math.min(max, min + Math.round((clamped - min) / step) * step);
}

export function readNodeSpacing(): NodeSpacing {
  try {
    const saved = localStorage.getItem(nodeSpacingStorageKey);
    if (saved === null) return defaultNodeSpacing;

    const parsed: unknown = JSON.parse(saved);
    if (typeof parsed === 'number' && parsed >= 50 && parsed <= 200) {
      const scale = parsed / 100;
      return {
        horizontal: normalizeNodeSpacingValue(
          defaultNodeSpacing.horizontal * scale,
          'horizontal',
        ),
        vertical: normalizeNodeSpacingValue(
          defaultNodeSpacing.vertical * scale,
          'vertical',
        ),
      };
    }

    if (parsed && typeof parsed === 'object') {
      const values = parsed as Partial<NodeSpacing>;
      return {
        horizontal: normalizeNodeSpacingValue(values.horizontal, 'horizontal'),
        vertical: normalizeNodeSpacingValue(values.vertical, 'vertical'),
      };
    }
  } catch {
    // Use the current map spacing when local storage is unavailable.
  }
  return defaultNodeSpacing;
}

export function readAiCollapsed(): boolean {
  try {
    return localStorage.getItem(aiCollapsedStorageKey) === 'true';
  } catch {
    return false;
  }
}
