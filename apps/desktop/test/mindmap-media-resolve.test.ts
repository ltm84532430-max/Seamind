import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDocumentMedia } from '../src/knowledge/document-media';
import { mindmapMediaResolver } from '../src/workbench/mindmap-media-card';

vi.mock('../src/knowledge/document-media', () => ({
  resolveDocumentMedia: vi.fn(
    async (documentRelativePath: string, mediaId: string) =>
      `asset://localhost/${documentRelativePath}/${mediaId}`,
  ),
}));

const mediaId = 'ab'.repeat(32);

describe('mindmap local image resolver', () => {
  beforeEach(() => {
    vi.mocked(resolveDocumentMedia).mockClear();
  });

  it('resolves a saved document through the document media store', async () => {
    const resolve = mindmapMediaResolver({
      documentRelativePath: 'notes/demo.md',
    });

    await expect(resolve?.(mediaId)).resolves.toBe(
      `asset://localhost/notes/demo.md/${mediaId}`,
    );
    expect(resolveDocumentMedia).toHaveBeenCalledWith('notes/demo.md', mediaId);
  });

  it('leaves an unsaved document unresolved', () => {
    expect(mindmapMediaResolver({})).toBeUndefined();
    expect(
      mindmapMediaResolver({ documentRelativePath: '   ' }),
    ).toBeUndefined();
    expect(resolveDocumentMedia).not.toHaveBeenCalled();
  });

  it('prefers an explicit resolver over the document path', async () => {
    const resolveMedia = vi.fn(async () => 'custom://image');
    const resolve = mindmapMediaResolver({
      documentRelativePath: 'notes/demo.md',
      resolveMedia,
    });

    await expect(resolve?.(mediaId)).resolves.toBe('custom://image');
    expect(resolveMedia).toHaveBeenCalledWith(mediaId);
    expect(resolveDocumentMedia).not.toHaveBeenCalled();
  });
});
