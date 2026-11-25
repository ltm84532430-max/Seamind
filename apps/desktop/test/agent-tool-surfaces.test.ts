import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  agentToolCatalog,
  agentToolCatalogForWorkspace,
  agentToolDefinitionsFor,
  agentToolSurfaces,
  mcpToolSpecs,
} from '../src/agent/capabilities';

const MAX_MCP_TOOLS = 64;
const MAX_AGENT_TOOLS = 64;
const MAX_AGENT_TOOLS_BYTES = 180_000;

function toolNames(
  tools: Array<{ name?: string; function?: { name: string } }>,
) {
  return tools.map((tool) => tool.name ?? tool.function?.name ?? '');
}

describe('agent tool surfaces', () => {
  it('assigns every catalog tool to one surface', () => {
    const seen = new Map<string, string>();
    for (const surface of agentToolSurfaces) {
      for (const name of toolNames(agentToolDefinitionsFor(surface))) {
        expect(seen.get(name)).toBeUndefined();
        seen.set(name, surface);
      }
    }
    expect([...seen.keys()].sort()).toEqual(
      agentToolCatalog.map((tool) => tool.name).sort(),
    );
  });

  it('exposes only the current workspace tools, and leaves unrelated workspaces unchanged', () => {
    expect(toolNames(agentToolCatalogForWorkspace('mindmap') ?? [])).toEqual(
      toolNames(agentToolDefinitionsFor('mindmap')),
    );
    expect(toolNames(agentToolCatalogForWorkspace('knowledge') ?? [])).toEqual(
      toolNames(agentToolDefinitionsFor('mindmap')),
    );
    expect(toolNames(agentToolCatalogForWorkspace('reader') ?? [])).toEqual(
      toolNames(agentToolDefinitionsFor('reader')),
    );
    expect(toolNames(agentToolCatalogForWorkspace('feed') ?? [])).toEqual(
      toolNames(agentToolDefinitionsFor('feed')),
    );
    expect(toolNames(agentToolCatalogForWorkspace('player') ?? [])).toEqual([
      ...toolNames(agentToolDefinitionsFor('learning-path')),
      ...toolNames(agentToolDefinitionsFor('favorites')),
    ]);
    expect(toolNames(agentToolCatalogForWorkspace('exams') ?? [])).toEqual([
      'exam_list_papers',
      'exam_get_paper',
      'code_run_c',
      'code_run_python',
    ]);
    expect(toolNames(agentToolCatalogForWorkspace('literature') ?? [])).toEqual(
      ['literature_list_papers'],
    );
    expect(toolNames(agentToolCatalogForWorkspace('lab') ?? [])).toEqual(
      toolNames(agentToolCatalog),
    );
    expect(toolNames(agentToolCatalogForWorkspace('agent') ?? [])).toEqual(
      toolNames(agentToolCatalog),
    );
    expect(toolNames(agentToolCatalogForWorkspace('terminal') ?? [])).toEqual(
      toolNames(agentToolCatalog),
    );
    expect(agentToolCatalogForWorkspace('tasks')).toBeNull();
  });

  it('keeps each registered batch inside the Rust tool limits', () => {
    const batches = [
      ...agentToolSurfaces.map((surface) => agentToolDefinitionsFor(surface)),
      agentToolCatalogForWorkspace('player')?.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })) ?? [],
    ];
    for (const tools of batches) {
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.length).toBeLessThanOrEqual(MAX_MCP_TOOLS);
      expect(tools.length).toBeLessThanOrEqual(MAX_AGENT_TOOLS);
      expect(
        new TextEncoder().encode(JSON.stringify(tools)).byteLength,
      ).toBeLessThanOrEqual(MAX_AGENT_TOOLS_BYTES);
    }
  });

  it('marks note writes and chapter jumps as confirmation, not read-only', () => {
    const reader = agentToolCatalogForWorkspace('reader') ?? [];
    const specs = mcpToolSpecs(reader);
    for (const name of [
      'knowledge_update_book_note',
      'knowledge_append_excerpt',
      'knowledge_sync_reader_chapter',
    ]) {
      const spec = specs.find((tool) => tool.name === name);
      expect(spec?.annotations.readOnlyHint).toBe(false);
      expect(spec?._meta['seamind/permission']).toBe('user_approval');
      expect(spec?._meta['anthropic/requiresUserInteraction']).toBe(true);
    }
    const read = specs.find((tool) => tool.name === 'knowledge_get_book_note');
    expect(read?.annotations.readOnlyHint).toBe(true);
  });

  it('matches the Rust completion allowlist to the tool catalog', () => {
    const rustPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../src-tauri/src/lib.rs',
    );
    const source = readFileSync(rustPath, 'utf8');
    const block = source.match(/let allowed_tools = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const allowed = [...(block?.[1].matchAll(/"([^"]+)"/g) ?? [])].map(
      (match) => match[1],
    );
    expect(allowed.sort()).toEqual(
      agentToolCatalog.map((tool) => tool.name).sort(),
    );
  });
});
