import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { FeedOpmlDialog } from '../src/feed/FeedOpmlDialog';

describe('FeedOpmlDialog render test', () => {
  it('renders FeedOpmlDialog with isOpen=true mode=import without crashing', () => {
    const html = renderToString(
      React.createElement(FeedOpmlDialog, {
        isOpen: true,
        mode: 'import',
        existingUrls: [],
        onClose: () => {},
        onFeedAdded: async () => {},
      }),
    );
    expect(html).toContain('导入 OPML 订阅文件');
  });

  it('renders FeedOpmlDialog with undefined existingUrls', () => {
    const html = renderToString(
      React.createElement(FeedOpmlDialog, {
        isOpen: true,
        mode: 'import',
        existingUrls: undefined as unknown as string[],
        onClose: () => {},
        onFeedAdded: async () => {},
      }),
    );
    expect(html).toContain('导入 OPML 订阅文件');
  });
});
