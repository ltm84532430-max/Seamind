import { describe, expect, it } from 'vitest';
import { classifyBookDrop } from '../src/app/app-storage';

describe('book file drop routing', () => {
  it('sends EPUB and PDF files on the ebook workspace to the book shelf', () => {
    expect(classifyBookDrop(['C:\\Books\\Guide.PDF'], true)).toBe('books');
    expect(classifyBookDrop(['C:\\Books\\Guide.epub'], true)).toBe('books');
    expect(
      classifyBookDrop(['C:\\Books\\Guide.epub', 'C:\\Books\\Guide.PDF'], true),
    ).toBe('books');
    expect(classifyBookDrop(['C:\\Books\\Guide.PDF'], false)).toBeNull();
  });

  it('keeps EPUB outline drops available', () => {
    expect(classifyBookDrop(['C:\\Books\\Guide.epub'], false)).toBe('epub');
  });
});
