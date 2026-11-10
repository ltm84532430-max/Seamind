import { describe, expect, it } from 'vitest';
import { mergeCaptionCue, type FeedAsrCaption } from '../src/feed/feed-asr-api';

function cue(start: number, text: string): FeedAsrCaption {
  return {
    sessionId: 's',
    start,
    end: start + 1,
    text,
    isFinal: true,
    error: null,
  };
}

describe('mergeCaptionCue', () => {
  it('keeps a replayed sentence from a restarted session', () => {
    const current = [cue(12.2, '昨天是星期三')];
    expect(mergeCaptionCue(current, cue(12.4, '昨天是星期三'))).toBe(current);
  });

  it('appends a new sentence and keeps the latest forty', () => {
    const current = Array.from({ length: 40 }, (_, index) =>
      cue(index, `句子${index}`),
    );
    const next = mergeCaptionCue(current, cue(80, '新的一句'));
    expect(next).toHaveLength(40);
    expect(next[0]?.text).toBe('句子1');
    expect(next.at(-1)?.text).toBe('新的一句');
  });
});
