import { describe, expect, it, vi } from 'vitest';
import { executeAgentTool } from '../src/agent/capabilities';
import type { AgentCapabilities } from '../src/agent/capabilities';

function capabilities(
  overrides: Partial<AgentCapabilities>,
): AgentCapabilities {
  return overrides as AgentCapabilities;
}

describe('EPUB agent tools', () => {
  it('returns every character through offset paging and preserves the live selection anchor', async () => {
    const text = '章节正文'.repeat(3500);
    const readCurrentEpubChapter = vi.fn(async () => ({
      bookKey: 'book-1',
      bookTitle: '示例书',
      sectionIndex: 4,
      sectionHref: 'chapter-5.xhtml',
      sectionLabel: '第五章',
      text,
      selection: { cfi: 'epubcfi(/6/10!/4/2)', text: '章节正文' },
    }));
    const api = capabilities({ readCurrentEpubChapter });
    const parts: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const response = await executeAgentTool(
        'epub_get_current_chapter',
        JSON.stringify({ offset }),
        api,
      );
      expect(response.result.totalChars).toBe(text.length);
      expect(response.result.selection).toEqual({
        cfi: 'epubcfi(/6/10!/4/2)',
        text: '章节正文',
      });
      parts.push(response.result.content as string);
      offset = response.result.nextOffset as number | null;
    }
    expect(parts.join('')).toBe(text);
    expect(readCurrentEpubChapter).toHaveBeenCalledTimes(parts.length);
  });

  it('requires a bounded anchored proposal and reports confirmation only after save', async () => {
    const proposeEpubFootnote = vi.fn(async () => ({
      annotationId: 'note-42',
    }));
    const api = capabilities({ proposeEpubFootnote });
    const response = await executeAgentTool(
      'epub_propose_footnote',
      JSON.stringify({
        selectionCfi: 'epubcfi(/6/10!/4/2)',
        text: '这里解释章节中的定义。',
      }),
      api,
    );
    expect(proposeEpubFootnote).toHaveBeenCalledWith({
      selectionCfi: 'epubcfi(/6/10!/4/2)',
      text: '这里解释章节中的定义。',
    });
    expect(response.permission).toBe('user_approval');
    expect(response.result).toEqual({ annotationId: 'note-42', saved: true });
    await expect(
      executeAgentTool(
        'epub_propose_footnote',
        JSON.stringify({
          selectionCfi: 'anchor',
          text: 'x'.repeat(801),
        }),
        api,
      ),
    ).rejects.toThrow();
  });
});
