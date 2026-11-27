import type { AgentToolScopeMode } from '../terminal-types';

export type InspectorTabId = 'context' | 'runtime' | 'tools';

export interface AgentWorkbenchPrefs {
  inspectorOpen: boolean;
  inspectorWidth: number;
  inspectorTab: InspectorTabId;
  toolScopeMode: AgentToolScopeMode;
}

const PREFS_STORAGE_KEY = 'seamind:agent-workbench-prefs:v1';

export const INSPECTOR_MIN_WIDTH = 260;
export const INSPECTOR_MAX_WIDTH = 360;
export const INSPECTOR_DEFAULT_WIDTH = 284;

export function clampInspectorWidth(width: number): number {
  if (!Number.isFinite(width)) return INSPECTOR_DEFAULT_WIDTH;
  return Math.max(
    INSPECTOR_MIN_WIDTH,
    Math.min(INSPECTOR_MAX_WIDTH, Math.round(width)),
  );
}

export function loadAgentWorkbenchPrefs(): AgentWorkbenchPrefs {
  const defaults: AgentWorkbenchPrefs = {
    inspectorOpen: false,
    inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
    inspectorTab: 'runtime',
    toolScopeMode: 'focused',
  };
  if (typeof localStorage === 'undefined') return defaults;
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<AgentWorkbenchPrefs>;
    const tab: InspectorTabId =
      parsed.inspectorTab === 'context' ||
      parsed.inspectorTab === 'runtime' ||
      parsed.inspectorTab === 'tools'
        ? parsed.inspectorTab
        : defaults.inspectorTab;
    const toolScopeMode: AgentToolScopeMode =
      parsed.toolScopeMode === 'all' ? 'all' : 'focused';
    return {
      inspectorOpen:
        typeof parsed.inspectorOpen === 'boolean'
          ? parsed.inspectorOpen
          : defaults.inspectorOpen,
      inspectorWidth:
        typeof parsed.inspectorWidth === 'number'
          ? clampInspectorWidth(parsed.inspectorWidth)
          : defaults.inspectorWidth,
      inspectorTab: tab,
      toolScopeMode,
    };
  } catch {
    return defaults;
  }
}

export function saveAgentWorkbenchPrefs(prefs: AgentWorkbenchPrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        inspectorOpen: Boolean(prefs.inspectorOpen),
        inspectorWidth: clampInspectorWidth(prefs.inspectorWidth),
        inspectorTab: prefs.inspectorTab,
        toolScopeMode: prefs.toolScopeMode === 'all' ? 'all' : 'focused',
      }),
    );
  } catch {
    // ignore storage errors
  }
}
