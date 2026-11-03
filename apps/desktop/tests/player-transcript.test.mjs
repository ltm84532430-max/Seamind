import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseYouTubeJson3,
  parseYouTubeXml,
  parseVttOrSrt,
  alignBilingualCues,
  parseYouTubeTimedTextList,
  extractCaptionTracksFromHtml,
} from '../src/player/transcript/parser.ts';

test('parseYouTubeJson3 parses events correctly', () => {
  const json3 = {
    events: [
      {
        tStartMs: 1200,
        dDurationMs: 3400,
        segs: [{ utf8: 'Hello ' }, { utf8: 'world!' }],
      },
      {
        tStartMs: 5000,
        dDurationMs: 2500,
        segs: [{ utf8: 'Welcome to this video tutorial.' }],
      },
    ],
  };

  const cues = parseYouTubeJson3(json3);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1.2);
  assert.equal(cues[0].end, 4.6);
  assert.equal(cues[0].text, 'Hello world!');
  assert.equal(cues[1].start, 5);
  assert.equal(cues[1].end, 7.5);
  assert.equal(cues[1].text, 'Welcome to this video tutorial.');
});

test('parseVttOrSrt handles both VTT and SRT cue blocks', () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
First subtitle line

00:00:05.500 --> 00:00:08.200
Second subtitle line
`;

  const cues = parseVttOrSrt(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 4);
  assert.equal(cues[0].text, 'First subtitle line');
  assert.equal(cues[1].start, 5.5);
  assert.equal(cues[1].end, 8.2);
  assert.equal(cues[1].text, 'Second subtitle line');
});

test('alignBilingualCues accurately pairs original and translated lines', () => {
  const originals = [
    { id: '1', start: 0, end: 3, text: 'Hello, welcome everyone.' },
    { id: '2', start: 3.5, end: 6, text: 'Today we talk about algorithms.' },
  ];
  const translations = [
    { id: 't1', start: 0.1, end: 2.9, text: '大家好，欢迎大家。' },
    { id: 't2', start: 3.6, end: 6.2, text: '今天我们将讨论算法。' },
  ];

  const aligned = alignBilingualCues(originals, translations);
  assert.equal(aligned.length, 2);
  assert.equal(aligned[0].translation, '大家好，欢迎大家。');
  assert.equal(aligned[1].translation, '今天我们将讨论算法。');
});

test('parseYouTubeTimedTextList extracts available tracks from XML', () => {
  const xml = `<?xml version="1.0" encoding="utf-8" ?>
<transcript_list docid="123456">
  <track id="0" name="" lang_code="en" lang_original="English" lang_translated="English" lang_default="true" />
  <track id="1" name="" lang_code="zh-Hans" lang_original="中文（简体）" lang_translated="Chinese (Simplified)" />
</transcript_list>`;

  const tracks = parseYouTubeTimedTextList(xml);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].langCode, 'en');
  assert.equal(tracks[0].name, 'English');
  assert.equal(tracks[0].isDefault, true);
  assert.equal(tracks[1].langCode, 'zh-Hans');
  assert.equal(tracks[1].name, '中文（简体）');
  assert.equal(tracks[1].isDefault, false);
});

test('extractCaptionTracksFromHtml extracts tracks from watch page HTML', () => {
  const html = `<!DOCTYPE html><html><body>
<script>
  var ytInitialPlayerResponse = {
    "captions": {
      "playerCaptionsTracklistRenderer": {
        "captionTracks": [
          {
            "baseUrl": "https://www.youtube.com/api/timedtext?v=test&lang=en",
            "name": { "simpleText": "English" },
            "vssId": ".en",
            "languageCode": "en",
            "isTranslatable": true
          }
        ]
      }
    }
  };
</script>
</body></html>`;

  const tracks = extractCaptionTracksFromHtml(html);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].languageCode, 'en');
  assert.equal(tracks[0].name, 'English');
  assert.equal(tracks[0].isTranslatable, true);
  assert.ok(tracks[0].baseUrl.includes('api/timedtext'));
});

