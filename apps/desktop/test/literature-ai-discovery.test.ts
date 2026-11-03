import { describe, expect, it, vi, beforeEach } from 'vitest';
import { literatureApi } from '../src/literature/literature-api';
import type { LiteratureSearchResult } from '../src/literature/types';

const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('Literature AI Discovery API & Workflows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('invokes literature_ai_discover with prompt and provider settings', async () => {
    const mockResults: LiteratureSearchResult[] = [
      {
        paper: {
          title: 'Attention Is All You Need',
          authors: ['Ashish Vaswani', 'Noam Shazeer'],
          year: 2017,
          venue: 'NeurIPS',
          arxivId: '1706.03762',
          abstractText: 'The dominant sequence transduction models...',
          doi: null,
          url: 'https://arxiv.org/abs/1706.03762',
        },
        source: 'arXiv',
        pdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf',
        existingPaperId: null,
        aiRecommendation: '提出经典的 Transformer 自注意力机制架构。',
      },
    ];

    mockInvoke.mockResolvedValueOnce(mockResults);

    const results = await literatureApi.aiDiscover('Transformer 经典论文');

    expect(results).toHaveLength(1);
    expect(results[0].paper.title).toBe('Attention Is All You Need');
    expect(results[0].aiRecommendation).toBe(
      '提出经典的 Transformer 自注意力机制架构。',
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      'literature_ai_discover',
      expect.objectContaining({
        prompt: 'Transformer 经典论文',
      }),
    );
  });

  it('correctly maps existingPaperId and handles batch saving', async () => {
    const item1: LiteratureSearchResult = {
      paper: {
        title: 'Paper 1',
        authors: ['Author A'],
        year: 2024,
      },
      source: 'arXiv',
      pdfUrl: null,
      existingPaperId: null,
    };

    const item2: LiteratureSearchResult = {
      paper: {
        title: 'Paper 2',
        authors: ['Author B'],
        year: 2023,
      },
      source: 'Crossref',
      pdfUrl: null,
      existingPaperId: 'existing-id-123',
    };

    mockInvoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'literature_save') {
        return {
          id: `saved-${args.paper.title}`,
          ...args.paper,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      return null;
    });

    // Test saving item 1
    const saved = await literatureApi.save(item1.paper);
    expect(saved.id).toBe('saved-Paper 1');
    expect(mockInvoke).toHaveBeenCalledWith('literature_save', {
      paper: item1.paper,
    });

    // Item 2 already exists
    expect(item2.existingPaperId).toBe('existing-id-123');
  });
});
