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

  it('does not offer a playback workaround for owner-disabled embeds', () => {
    expect(youtubePlayerErrorMessage(101)).toContain('禁止');
    expect(youtubePlayerErrorMessage(150)).toContain('禁止');
    expect(youtubePlayerErrorMessage(100)).toContain('不存在');
    expect(canOfferAlternativePlayback('error', 101)).toBe(false);
    expect(canOfferAlternativePlayback('error', 150)).toBe(false);
    expect(canOfferAlternativePlayback('error', 100)).toBe(false);
  });

  it('offers optional playback only after recoverable embed failures', () => {
    expect(canOfferAlternativePlayback('error', 5)).toBe(true);
    expect(canOfferAlternativePlayback('timeout', null)).toBe(true);
    expect(canOfferAlternativePlayback('ready', null)).toBe(false);
  });
});
