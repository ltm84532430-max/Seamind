import { invoke } from '@tauri-apps/api/core';

export interface PlantUmlRenderResult {
  svg: string;
  diagnostics: string[];
}

export const plantUmlApi = {
  render: (args: {
    source: string;
    dark: boolean;
    authorizedIncludeDirectory: string | null;
    cacheKey: string | null;
  }) => invoke<PlantUmlRenderResult>('render_plantuml', args),
};
