import { describe, expect, it } from 'vitest';
import {
  buildTranscriptKnowledgeExport,
  DEFAULT_TRANSCRIPT_KNOWLEDGE_CATEGORY,
  formatCueTime,
  sanitizeTranscriptNoteTitle,
} from '../src/player/transcript/export';
import type { TranscriptCue } from '../src/player/transcript/types';
import { parseYouTubeEmbedInput } from '../src/youtube';

const SAMPLE_CUES: TranscriptCue[] = [
  {
    id: 'c1',
    start: 9.4,
    end: 14.2,
    text: 'Each day, an average of 11 homes\nare effectively stolen in Mexico City.',
    translation: '每天平均有 11 栋房屋在墨西哥城被变相偷走。',
  },
  {
    id: 'c2',
    start: 3725.8,
    end: 3730.1,
    text: 'Investigators traced the forged deeds.',
    translation: '调查人员追踪到了伪造的地契。',
  },
];

describe('transcript export to Knowledge Base', () => {
  it('formats cue timestamps under and over an hour safely', () => {
    expect(formatCueTime(0)).toBe('0:00');
    expect(formatCueTime(9.8)).toBe('0:09');
    expect(formatCueTime(531)).toBe('8:51');
    expect(formatCueTime(3725)).toBe('1:02:05');
    expect(formatCueTime(-5)).toBe('0:00');
    expect(formatCueTime(Number.NaN)).toBe('0:00');
  });

  it('sanitizes note titles for Windows paths and library length limits', () => {
    expect(
      sanitizeTranscriptNoteTitle(
        'How Criminal Gangs: Stealing? "Homes" / Mexico | Part 1...',
        'abc12345678',
      ),
    ).toBe('How Criminal Gangs Stealing Homes Mexico Part 1');

    expect(sanitizeTranscriptNoteTitle('   ', 'abc12345678')).toBe(
      'YouTube 字幕 abc12345678',
    );

    const longTitle = 'A'.repeat(160);
    expect(
      sanitizeTranscriptNoteTitle(longTitle, 'abc12345678').length,
    ).toBeLessThanOrEqual(100);
  });

  it('exports bilingual cues with clickable YouTube timestamp links', () => {
    const exportedAt = new Date(2026, 10, 2, 22, 10);
    const payload = buildTranscriptKnowledgeExport({
      videoId: 'dQw4w9WgXcQ',
      videoTitle: 'How Criminal Gangs Are Stealing Homes in Mexico City',
      channelName: 'Bloomberg Originals',
      cues: SAMPLE_CUES,
      viewMode: 'bilingual',
      trackLabel: 'English · en · 自动生成',
      exportedAt,
    });

    expect(payload.category).toBe(DEFAULT_TRANSCRIPT_KNOWLEDGE_CATEGORY);
    expect(payload.title).toBe(
      'How Criminal Gangs Are Stealing Homes in Mexico City',
    );
    expect(payload.cueCount).toBe(2);
    expect(payload.tags).toEqual([
      'YouTube',
      '视频字幕',
      'Bloomberg-Originals',
    ]);

    expect(payload.markdown).toContain(
      '# How Criminal Gangs Are Stealing Homes in Mexico City',
    );
    expect(payload.markdown).toContain('> [!NOTE] 视频信息');
    expect(payload.markdown).toContain('**频道**：Bloomberg Originals');
    expect(payload.markdown).toContain('**字幕轨道**：English · en · 自动生成');
    expect(payload.markdown).toContain('**字幕模式**：双语对照（共 2 条）');
    expect(payload.markdown).toContain('**导出时间**：2026-11-02 22:10');

    expect(payload.markdown).toContain(
      '- **[▶ 0:09](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9s)** Each day, an average of 11 homes are effectively stolen in Mexico City.  \n  每天平均有 11 栋房屋在墨西哥城被变相偷走。',
    );
    expect(payload.markdown).toContain(
      '- **[▶ 1:02:05](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3725s)** Investigators traced the forged deeds.  \n  调查人员追踪到了伪造的地契。',
    );

    const parsedFirst = parseYouTubeEmbedInput(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9s',
    );
    const parsedSecond = parseYouTubeEmbedInput(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3725s',
    );
    expect(parsedFirst).toEqual({ id: 'dQw4w9WgXcQ', startSeconds: 9 });
    expect(parsedSecond).toEqual({ id: 'dQw4w9WgXcQ', startSeconds: 3725 });
  });

  it('respects original-only, translation-only, and search filter metadata', () => {
    const originalPayload = buildTranscriptKnowledgeExport({
      videoId: 'dQw4w9WgXcQ',
      videoTitle: 'Demo Video',
      cues: SAMPLE_CUES,
      viewMode: 'original',
    });
    expect(originalPayload.markdown).toContain(
      '**字幕模式**：仅原文（共 2 条）',
    );
    expect(originalPayload.markdown).not.toContain('每天平均有 11 栋房屋');

    const translationPayload = buildTranscriptKnowledgeExport({
      videoId: 'dQw4w9WgXcQ',
      videoTitle: 'Demo Video',
      cues: [SAMPLE_CUES[0]],
      viewMode: 'translation',
      searchQuery: 'Mexico',
    });
    expect(translationPayload.markdown).toContain(
      '**字幕模式**：仅译文（共 1 条）',
    );
    expect(translationPayload.markdown).toContain('**筛选关键词**：`Mexico`');
    expect(translationPayload.markdown).toContain(
      '- **[▶ 0:09](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9s)** 每天平均有 11 栋房屋在墨西哥城被变相偷走。',
    );
    expect(translationPayload.markdown).not.toContain(
      'Each day, an average of 11 homes',
    );
  });
});
