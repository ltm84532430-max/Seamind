import { describe, expect, it } from 'vitest';
import { buildYouTubeEmbedUrl } from '../src/youtube';
import {
  canOfferAlternativePlayback,
  youtubePlayerErrorMessage,
} from '../src/youtube-player';

describe('YouTube playback integration', () => {
  it('keeps the linked timestamp and enables IFrame API events', () => {
    const embedUrl = buildYouTubeEmbedUrl('aqz-KE-bpKQ', 125);
    expect(embedUrl).not.toBeNull();

    const url = new URL(embedUrl!);
    expect(url.pathname).toBe('/embed/aqz-KE-bpKQ');
    expect(url.searchParams.get('start')).toBe('125');
    expect(url.searchParams.get('enablejsapi')).toBe('1');
  });

  it('explains owner-disabled and missing videos', () => {
    expect(youtubePlayerErrorMessage(101)).toContain('禁止');
    expect(youtubePlayerErrorMessage(150)).toContain('禁止');
    expect(youtubePlayerErrorMessage(100)).toContain('不存在');
    expect(youtubePlayerErrorMessage(153)).toContain('来源标识');
  });

  it('offers another way to play once the embedded player has failed or settled', () => {
    // Owner-disabled embeds (101/150) are the cases the built-in player exists for.
    expect(canOfferAlternativePlayback('error')).toBe(true);
    expect(canOfferAlternativePlayback('timeout')).toBe(true);
    expect(canOfferAlternativePlayback('stalled')).toBe(true);
    expect(canOfferAlternativePlayback('ready')).toBe(true);
    expect(canOfferAlternativePlayback('external')).toBe(true);
  });

  it('does not offer alternatives while a player is still connecting', () => {
    expect(canOfferAlternativePlayback('loading')).toBe(false);
    expect(canOfferAlternativePlayback('resolving')).toBe(false);
    expect(canOfferAlternativePlayback('playing')).toBe(false);
  });
});
