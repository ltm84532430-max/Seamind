import { describe, expect, it } from 'vitest';
import {
  parseCsv,
  parseSubscriptionFile,
  subscriptionsToNewPipeJson,
} from '../src/player/import-subscriptions';
import type { PlayerChannel } from '../src/player/types';

const A = 'UCYO_jab_esuFRV4b17AJtAw';
const B = 'UCcabW7890RKJzL968QWEykA';
const C = 'UCEBb1b_L6zDS3xTUrIALZOw';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, commas and line breaks inside cells', () => {
    expect(parseCsv('a,"b,c","say ""hi""","line\nbreak"\r\nx,y,z\n\n')).toEqual(
      [
        ['a', 'b,c', 'say "hi"', 'line\nbreak'],
        ['x', 'y', 'z'],
      ],
    );
  });

  it('keeps a last row without a final newline', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });
});

describe('parseSubscriptionFile', () => {
  it('reads the CSV of Google Takeout, with its header, a byte order mark and quoted titles', () => {
    const text = `\uFEFFChannel ID,Channel URL,Channel title\r\n${A},http://www.youtube.com/channel/${A},3Blue1Brown\r\n${B},http://www.youtube.com/channel/${B},"CS50, Harvard"\r\n`;
    const parsed = parseSubscriptionFile(text);
    expect(parsed?.format).toBe('takeout-csv');
    expect(parsed?.channels).toEqual([
      { channelId: A, name: '3Blue1Brown' },
      { channelId: B, name: 'CS50, Harvard' },
    ]);
  });

  it('reads a Takeout CSV whose header is in another language', () => {
    const parsed = parseSubscriptionFile(
      `频道 ID,频道网址,频道标题\n${A},http://x/${A},李永乐老师\n`,
    );
    expect(parsed?.channels).toEqual([{ channelId: A, name: '李永乐老师' }]);
  });

  it("reads NewPipe's export and leaves out other services and addresses without an id", () => {
    const text = JSON.stringify({
      app_version: '0.28.0',
      app_version_int: 1000,
      subscriptions: [
        {
          service_id: 0,
          url: `https://www.youtube.com/channel/${A}`,
          name: '3Blue1Brown',
        },
        {
          service_id: 0,
          url: `https://www.youtube.com/channel/${A}`,
          name: '重复',
        },
        {
          service_id: 3,
          url: 'https://media.ccc.de/c/foo',
          name: 'PeerTube 频道',
        },
        {
          service_id: 0,
          url: 'https://www.youtube.com/@handle',
          name: '只有句柄',
        },
        {
          service_id: 0,
          url: `https://www.youtube.com/channel/${B}`,
          name: '',
        },
      ],
    });
    const parsed = parseSubscriptionFile(text);
    expect(parsed?.format).toBe('newpipe');
    expect(parsed?.channels).toEqual([
      { channelId: A, name: '3Blue1Brown' },
      { channelId: B, name: B },
    ]);
    expect(parsed?.skipped).toBe(2);
  });

  it('reads the JSON of Google Takeout', () => {
    const text = JSON.stringify([
      {
        kind: 'youtube#subscription',
        snippet: {
          title: 'CS50',
          resourceId: { kind: 'youtube#channel', channelId: B },
        },
      },
      { snippet: { title: '坏的', resourceId: { channelId: 'nope' } } },
    ]);
    const parsed = parseSubscriptionFile(text);
    expect(parsed?.format).toBe('takeout-json');
    expect(parsed?.channels).toEqual([{ channelId: B, name: 'CS50' }]);
    expect(parsed?.skipped).toBe(1);
  });

  it('reads an OPML list of channel feeds', () => {
    const text = `<?xml version="1.0"?><opml version="1.1"><body><outline text="YouTube Subscriptions" title="YouTube Subscriptions">
      <outline text="MIT &amp; OCW" title="MIT &amp; OCW" type="rss" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=${C}" htmlUrl="https://www.youtube.com/channel/${C}"/>
      <outline text="plain" xmlUrl="https://example.com/rss"/>
    </outline></body></opml>`;
    const parsed = parseSubscriptionFile(text);
    expect(parsed?.format).toBe('opml');
    expect(parsed?.channels).toEqual([{ channelId: C, name: 'MIT & OCW' }]);
    expect(parsed?.skipped).toBe(1);
  });

  it('gives null for text that is none of these', () => {
    expect(parseSubscriptionFile('')).toBeNull();
    expect(parseSubscriptionFile('just some words')).toBeNull();
    expect(parseSubscriptionFile('{"hello": 1}')).toBeNull();
    expect(parseSubscriptionFile('{broken json')).toBeNull();
    expect(parseSubscriptionFile('a,b,c\n1,2,3')).toBeNull();
  });
});

describe('subscriptionsToNewPipeJson', () => {
  it('writes the file NewPipe reads, and Seamind reads it back', () => {
    const channels: PlayerChannel[] = [
      {
        channelId: A,
        name: '3Blue1Brown',
        handle: null,
        avatarUrl: null,
        description: null,
        subscribedAt: 1,
        lastCheckedAt: null,
        lastError: null,
      },
      {
        channelId: B,
        name: 'CS50',
        handle: null,
        avatarUrl: null,
        description: null,
        subscribedAt: 2,
        lastCheckedAt: null,
        lastError: null,
      },
    ];
    const text = subscriptionsToNewPipeJson(channels);
    const written = JSON.parse(text);
    expect(written.subscriptions).toEqual([
      {
        service_id: 0,
        url: `https://www.youtube.com/channel/${A}`,
        name: '3Blue1Brown',
      },
      {
        service_id: 0,
        url: `https://www.youtube.com/channel/${B}`,
        name: 'CS50',
      },
    ]);
    expect(parseSubscriptionFile(text)?.channels).toEqual([
      { channelId: A, name: '3Blue1Brown' },
      { channelId: B, name: 'CS50' },
    ]);
  });
});
