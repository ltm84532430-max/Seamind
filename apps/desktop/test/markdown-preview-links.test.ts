import { describe, expect, it } from 'vitest';
import {
  clampLightboxZoom,
  classifyPreviewLinkHref,
  isPreviewImageHref,
} from '../src/workbench/markdown-preview-links';

describe('markdown preview image & link classification', () => {
  it('detects direct image URLs including CDN query format parameters', () => {
    expect(isPreviewImageHref('https://cdn.example.com/switch.jpg')).toBe(true);
    expect(
      isPreviewImageHref(
        'https://pbs.twimg.com/media/abc?format=webp&name=large',
      ),
    ).toBe(true);
    expect(isPreviewImageHref('asset://localhost/media/demo.png')).toBe(true);
    expect(isPreviewImageHref('https://example.com/article/arp')).toBe(false);
  });

  it('classifies hash, image, external, and relative links safely without in-app navigation', () => {
    expect(classifyPreviewLinkHref('#section-2')).toEqual({
      kind: 'hash',
      id: 'section-2',
    });
    expect(
      classifyPreviewLinkHref('https://example.com/images/switch.png'),
    ).toEqual({
      kind: 'image',
      url: 'https://example.com/images/switch.png',
    });
    expect(
      classifyPreviewLinkHref('https://example.com/networking/arp'),
    ).toEqual({
      kind: 'external',
      url: 'https://example.com/networking/arp',
    });
    expect(classifyPreviewLinkHref('/local/path.html')).toEqual({
      kind: 'block',
    });
    expect(classifyPreviewLinkHref('javascript:alert(1)')).toEqual({
      kind: 'block',
    });
  });

  it('clamps lightbox zoom within supported bounds', () => {
    expect(clampLightboxZoom(0.1)).toBe(0.5);
    expect(clampLightboxZoom(1.25)).toBe(1.25);
    expect(clampLightboxZoom(10)).toBe(4);
  });
});
