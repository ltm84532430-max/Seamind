import { describe, expect, it } from 'vitest';
import {
  buildTranscriptKnowledgeExport,
  chunkTranscriptForStages,
  DEFAULT_TRANSCRIPT_KNOWLEDGE_CATEGORY,
  endsWithSentenceBoundary,
  formatCueTime,
  formatPaddedCueTime,
  groupSentencesIntoParagraphs,
  mergeTranscriptSentences,
  sanitizeTranscriptNoteTitle,
  splitTextIntoSentences,
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

const WORKBUDDY_ASR_CUES: TranscriptCue[] = [
  {
    id: 'w1',
    start: 0,
    end: 2,
    text: "The Workbody tutorial is here. I'll walk",
  },
  {
    id: 'w2',
    start: 2,
    end: 3.5,
    text: 'you through this AI productivity tool',
  },
  { id: 'w3', start: 3.5, end: 5, text: "that's perfect for beginners. We'll" },
  {
    id: 'w4',
    start: 5,
    end: 6.5,
    text: 'cover everything from basics to advanced',
  },
  {
    id: 'w5',
    start: 6.5,
    end: 8,
    text: "features, so even if you've never used",
  },
  {
    id: 'w6',
    start: 8,
    end: 10,
    text: 'an AI agent, you can get started quickly',
  },
  {
    id: 'w7',
    start: 10,
    end: 12,
    text: '. Why has Workbody suddenly gone viral?',
  },
  {
    id: 'w8',
    start: 12,
    end: 14,
    text: "In a nutshell, it's an AI workstation",
  },
  {
    id: 'w9',
    start: 14,
    end: 16,
    text: 'that actually gets work done, not just a',
  },
  {
    id: 'w10',
    start: 16,
    end: 18,
    text: 'chatbot for Q&A. It can read files,',
  },
  {
    id: 'w11',
    start: 18,
    end: 19.5,
    text: 'create spreadsheets, and write documents',
  },
  {
    id: 'w12',
    start: 19.5,
    end: 21,
    text: 'directly on your computer, handing you a',
  },
  {
    id: 'w13',
    start: 21,
    end: 23,
    text: 'finished result you can use right away.',
  },
  {
    id: 'w14',
    start: 23,
    end: 25,
    text: 'Compared to foreign AI agents like',
  },
  {
    id: 'w15',
    start: 25,
    end: 26.5,
    text: 'Claude, Workbody has a much lower',
  },
  {
    id: 'w16',
    start: 26.5,
    end: 28.5,
    text: 'barrier to entry for installation and setup.',
  },
];

describe('transcript export to Knowledge Base (Step 1 & Step 2)', () => {
  it('formats standard and zero-padded enterprise cue timestamps safely', () => {
    expect(formatCueTime(0)).toBe('0:00');
    expect(formatCueTime(9.8)).toBe('0:09');
    expect(formatCueTime(531)).toBe('8:51');
    expect(formatCueTime(3725)).toBe('1:02:05');

    expect(formatPaddedCueTime(0)).toBe('00:00');
    expect(formatPaddedCueTime(9.8)).toBe('00:09');
    expect(formatPaddedCueTime(531)).toBe('08:51');
    expect(formatPaddedCueTime(3725)).toBe('01:02:05');
    expect(formatPaddedCueTime(-5)).toBe('00:00');
    expect(formatPaddedCueTime(Number.NaN)).toBe('00:00');
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

  it('avoids false sentence splits on abbreviations and decimals', () => {
    expect(endsWithSentenceBoundary('Talk to Dr.')).toBe(false);
    expect(endsWithSentenceBoundary('Compare v1.')).toBe(false);
    expect(endsWithSentenceBoundary('Use tools e.g.')).toBe(false);
    expect(endsWithSentenceBoundary('Version 2.0.')).toBe(true);

    expect(
      splitTextIntoSentences(
        'Dr. Smith tested Node.js v1.2 in the U.S. It ran 3.5x faster! Right?',
      ),
    ).toEqual([
      'Dr. Smith tested Node.js v1.2 in the U.S.',
      'It ran 3.5x faster!',
      'Right?',
    ]);
  });

  it('reconstructs fractured YouTube ASR cues and adsorbs orphan leading punctuation', () => {
    const sentences = mergeTranscriptSentences(WORKBUDDY_ASR_CUES);
    expect(sentences.map((s) => s.text)).toEqual([
      'The Workbody tutorial is here.',
      "I'll walk you through this AI productivity tool that's perfect for beginners.",
      "We'll cover everything from basics to advanced features, so even if you've never used an AI agent, you can get started quickly.",
      'Why has Workbody suddenly gone viral?',
      "In a nutshell, it's an AI workstation that actually gets work done, not just a chatbot for Q&A.",
      'It can read files, create spreadsheets, and write documents directly on your computer, handing you a finished result you can use right away.',
      'Compared to foreign AI agents like Claude, Workbody has a much lower barrier to entry for installation and setup.',
    ]);

    const paragraphs = groupSentencesIntoParagraphs(sentences);
    expect(paragraphs).toHaveLength(3);
    expect(Math.floor(paragraphs[0].start)).toBe(0);
    expect(paragraphs[0].text).toBe(
      "The Workbody tutorial is here. I'll walk you through this AI productivity tool that's perfect for beginners. We'll cover everything from basics to advanced features, so even if you've never used an AI agent, you can get started quickly.",
    );

    expect(Math.floor(paragraphs[1].start)).toBe(10);
    expect(paragraphs[1].text).toBe(
      "Why has Workbody suddenly gone viral? In a nutshell, it's an AI workstation that actually gets work done, not just a chatbot for Q&A. It can read files, create spreadsheets, and write documents directly on your computer, handing you a finished result you can use right away.",
    );

    expect(Math.floor(paragraphs[2].start)).toBe(23);
    expect(paragraphs[2].text).toBe(
      'Compared to foreign AI agents like Claude, Workbody has a much lower barrier to entry for installation and setup.',
    );

    const payload = buildTranscriptKnowledgeExport({
      videoId: 'XwUSlqrMjuo',
      videoTitle: '小白速通 WorkBuddy 保姆级教程合集：从小白到高手',
      channelName: '林粒粒呀',
      cues: WORKBUDDY_ASR_CUES,
      viewMode: 'original',
    });

    expect(payload.cueCount).toBe(16);
    expect(payload.paragraphCount).toBe(3);
    expect(payload.markdown).not.toContain('▶');
    expect(payload.markdown).not.toContain('\n- [00:');
    expect(payload.markdown).toContain('16 条碎词合并为 3 段');
    expect(payload.markdown).toContain(
      "[00:00](https://www.youtube.com/watch?v=XwUSlqrMjuo&t=0s) The Workbody tutorial is here. I'll walk you through this AI productivity tool",
    );
    expect(payload.markdown).toContain(
      '[00:10](https://www.youtube.com/watch?v=XwUSlqrMjuo&t=10s) Why has Workbody suddenly gone viral?',
    );
  });

  it('handles CJK punctuated fragments, unpunctuated CJK ASR, and rolling VTT overlaps', () => {
    const punctuatedCjk: TranscriptCue[] = [
      { id: 'z1', start: 0, end: 1.8, text: '每天平均有 11 栋房屋' },
      { id: 'z2', start: 1.8, end: 3.4, text: '在墨西哥城被变相偷走' },
      { id: 'z3', start: 3.4, end: 5.2, text: '。调查人员随后追踪到了地契。' },
    ];
    const mergedPunctuated = mergeTranscriptSentences(punctuatedCjk);
    expect(mergedPunctuated.map((s) => s.text)).toEqual([
      '每天平均有 11 栋房屋在墨西哥城被变相偷走。',
      '调查人员随后追踪到了地契。',
    ]);

    const unpunctuatedCjk: TranscriptCue[] = [
      { id: 'u1', start: 0, end: 1.6, text: '大家好欢迎来到本期视频' },
      { id: 'u2', start: 1.6, end: 3.2, text: '今天带大家快速上手这个工具' },
    ];
    const mergedUnpunctuated = mergeTranscriptSentences(unpunctuatedCjk);
    expect(mergedUnpunctuated[0].text).toBe(
      '大家好欢迎来到本期视频 今天带大家快速上手这个工具',
    );

    const rollingCues: TranscriptCue[] = [
      { id: 'r1', start: 0, end: 1.5, text: 'walk you through this tool' },
      {
        id: 'r2',
        start: 1.5,
        end: 3.2,
        text: 'walk you through this tool right now.',
      },
    ];
    const mergedRolling = mergeTranscriptSentences(rollingCues);
    expect(mergedRolling).toHaveLength(1);
    expect(mergedRolling[0].text).toBe('walk you through this tool right now.');
  });

  it('chunks long transcripts into ~5-minute stage sections for Knowledge Base outline and phased AI', () => {
    const longCues: TranscriptCue[] = Array.from({ length: 24 }, (_, idx) => ({
      id: `l${idx}`,
      start: idx * 32,
      end: idx * 32 + 26,
      text: `Section item ${idx + 1} explains an architectural step in detail so each paragraph carries real substance.`,
    }));

    const sentences = mergeTranscriptSentences(longCues);
    const paragraphs = groupSentencesIntoParagraphs(sentences);
    const stages = chunkTranscriptForStages(paragraphs, {
      maxDurationSeconds: 300,
    });
    expect(stages.length).toBeGreaterThanOrEqual(3);

    const payload = buildTranscriptKnowledgeExport({
      videoId: 'XwUSlqrMjuo',
      videoTitle: 'Long Architecture Deep Dive',
      cues: longCues,
      viewMode: 'original',
    });

    expect(payload.stageCount).toBe(stages.length);
    expect(payload.markdown).toContain(`## ${stages[0].heading}`);
    expect(payload.markdown).toContain(`## ${stages[1].heading}`);
    expect(payload.markdown).toContain(`${stages.length} 个阶段`);
  });

  it('exports bilingual paragraphs with clean enterprise timestamp links and jumpable URLs', () => {
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
    expect(payload.paragraphCount).toBe(2);
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
    expect(payload.markdown).toContain('**字幕模式**：双语对照（共 2 段）');
    expect(payload.markdown).toContain('**导出时间**：2026-11-02 22:10');

    expect(payload.markdown).toContain(
      '[00:09](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9s) Each day, an average of 11 homes are effectively stolen in Mexico City.  \n每天平均有 11 栋房屋在墨西哥城被变相偷走。',
    );
    expect(payload.markdown).toContain(
      '[01:02:05](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3725s) Investigators traced the forged deeds.  \n调查人员追踪到了伪造的地契。',
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
      '**字幕模式**：仅原文（共 2 段）',
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
      '**字幕模式**：仅译文（共 1 段）',
    );
    expect(translationPayload.markdown).toContain('**筛选关键词**：`Mexico`');
    expect(translationPayload.markdown).toContain('## 筛选字幕摘录');
    expect(translationPayload.markdown).toContain(
      '[00:09](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=9s) 每天平均有 11 栋房屋在墨西哥城被变相偷走。',
    );
    expect(translationPayload.markdown).not.toContain(
      'Each day, an average of 11 homes',
    );
  });
});
