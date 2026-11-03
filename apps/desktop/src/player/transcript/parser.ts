import type { TranscriptCue } from './types';

export class TranscriptParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptParseError';
  }
}

function cleanText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n+/g, ' ')
    .trim();
}

/** Parses YouTube JSON3 format. */
export function parseYouTubeJson3(json: unknown): TranscriptCue[] {
  if (!json || typeof json !== 'object') return [];
  const events = (json as { events?: unknown[] }).events;
  if (!Array.isArray(events)) return [];

  const cues: TranscriptCue[] = [];
  let index = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const item = event as {
      tStartMs?: number;
      dDurationMs?: number;
      segs?: Array<{ utf8?: string }>;
    };
    if (typeof item.tStartMs !== 'number' || !Number.isFinite(item.tStartMs))
      continue;
    const start = item.tStartMs / 1000;
    const duration = (item.dDurationMs ?? 2000) / 1000;
    if (!Number.isFinite(duration) || duration < 0) continue;
    const end = start + duration;

    let text = '';
    if (Array.isArray(item.segs)) {
      text = item.segs.map((s) => s.utf8 || '').join('');
    }
    text = cleanText(text);
    if (!text) continue;

    cues.push({
      id: `cue-${index++}`,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      text,
    });
  }

  return cues;
}

/** Parses YouTube XML format (timedtext). */
export function parseYouTubeXml(xmlText: string): TranscriptCue[] {
  if (typeof DOMParser === 'undefined')
    throw new TranscriptParseError(
      'XML parsing is unavailable in this runtime.',
    );

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror'))
    throw new TranscriptParseError('YouTube returned malformed XML captions.');

  // Classic timedtext uses <text start="..." dur="...">. The srv3 variant
  // uses <p t="..." d="..."><s>...</s></p>, with time values in ms.
  const textNodes = doc.querySelectorAll('text, p');
  const cues: TranscriptCue[] = [];
  let index = 0;

  textNodes.forEach((node) => {
    const isSrv3 = node.tagName.toLowerCase() === 'p';
    const startStr = node.getAttribute(isSrv3 ? 't' : 'start');
    const durStr = node.getAttribute(isSrv3 ? 'd' : 'dur');
    if (startStr === null) return;
    const rawStart = Number.parseFloat(startStr);
    const rawDuration = durStr === null ? 2 : Number.parseFloat(durStr);
    const start = isSrv3 ? rawStart / 1000 : rawStart;
    const duration =
      isSrv3 && durStr !== null ? rawDuration / 1000 : rawDuration;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(duration) ||
      start < 0 ||
      duration < 0
    )
      return;
    const end = start + duration;
    const segments = node.querySelectorAll('s');
    const rawText = segments.length
      ? Array.from(segments, (segment) => segment.textContent || '').join('')
      : node.textContent || '';
    const text = cleanText(rawText);
    if (!text) return;

    cues.push({
      id: `cue-${index++}`,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      text,
    });
  });

  return cues;
}

/** Parses the response body returned by a YouTube caption track URL. */
export function parseYouTubeCaptionResponse(content: string): TranscriptCue[] {
  const trimmed = content.trim();
  if (!trimmed)
    throw new TranscriptParseError(
      'YouTube returned an empty caption response.',
    );

  let cues: TranscriptCue[];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new TranscriptParseError('YouTube returned invalid JSON captions.');
    }
    cues = parseYouTubeJson3(parsed);
    if (!Array.isArray((parsed as { events?: unknown[] })?.events))
      throw new TranscriptParseError(
        'The JSON response is not a JSON3 caption track.',
      );
  } else if (/^WEBVTT(?:\s|$)/i.test(trimmed)) {
    cues = parseVttOrSrt(trimmed);
  } else if (trimmed.startsWith('<')) {
    cues = parseYouTubeXml(trimmed);
    if (!trimmed.includes('<text') && !trimmed.includes('<p'))
      throw new TranscriptParseError(
        'The XML response does not contain a supported caption format.',
      );
  } else {
    throw new TranscriptParseError(
      'YouTube returned an unknown caption format.',
    );
  }

  if (cues.length === 0)
    throw new TranscriptParseError(
      'The caption response contained no readable cues.',
    );

  return cues.sort((left, right) => left.start - right.start);
}

export interface TimedTextTrackInfo {
  id: string;
  langCode: string;
  name: string;
  isDefault?: boolean;
}

/** Parses YouTube timedtext track list XML (<transcript_list>). */
export function parseYouTubeTimedTextList(
  xmlText: string,
): TimedTextTrackInfo[] {
  const tracks: TimedTextTrackInfo[] = [];
  try {
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      const nodes = doc.querySelectorAll('track');
      nodes.forEach((node, idx) => {
        const langCode = node.getAttribute('lang_code');
        if (!langCode) return;
        const name =
          node.getAttribute('lang_original') ||
          node.getAttribute('lang_translated') ||
          langCode;
        const isDefault = node.getAttribute('lang_default') === 'true';
        tracks.push({
          id: `tt-${idx}-${langCode}`,
          langCode,
          name,
          isDefault,
        });
      });
      if (tracks.length > 0) return tracks;
    }
  } catch {
    // fallback regex below
  }

  const matches = xmlText.matchAll(/<track\s+([^>]+)>/g);
  let idx = 0;
  for (const match of matches) {
    const attrs = match[1];
    const langCodeMatch = attrs.match(/lang_code="([^"]+)"/);
    if (!langCodeMatch) continue;
    const langCode = langCodeMatch[1];
    const nameMatch =
      attrs.match(/lang_original="([^"]+)"/) ||
      attrs.match(/lang_translated="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : langCode;
    tracks.push({
      id: `tt-${idx++}-${langCode}`,
      langCode,
      name,
      isDefault: attrs.includes('lang_default="true"'),
    });
  }
  return tracks;
}

export interface ExtractedHtmlCaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  isTranslatable: boolean;
}

/** Extracts captionTracks array from YouTube watch page HTML. */
export function extractCaptionTracksFromHtml(
  html: string,
): ExtractedHtmlCaptionTrack[] {
  const tracks: ExtractedHtmlCaptionTrack[] = [];
  let rawTracks: any[] | null = null;

  // 1. Try ytInitialPlayerResponse match
  const match = html.match(
    /ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:\s*var\s+|\s*<\/script>|\s*window\.)/s,
  );
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      const list =
        parsed?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(list) && list.length > 0) {
        rawTracks = list;
      }
    } catch {
      // ignore
    }
  }

  // 2. Direct regex match for "captionTracks": [ ... ]
  if (!rawTracks) {
    const directMatch = html.match(
      /"captionTracks":\s*(\[\s*\{[\s\S]*?\}\s*\])/,
    );
    if (directMatch) {
      try {
        const list = JSON.parse(directMatch[1]);
        if (Array.isArray(list) && list.length > 0) {
          rawTracks = list;
        }
      } catch {
        // ignore
      }
    }
  }

  if (Array.isArray(rawTracks)) {
    for (const t of rawTracks) {
      const baseUrl = t.baseUrl || t.base_url;
      if (!baseUrl) continue;
      const languageCode = t.languageCode || t.language_code || 'en';
      let name = languageCode;
      if (typeof t.name === 'string') {
        name = t.name;
      } else if (t.name?.simpleText) {
        name = t.name.simpleText;
      } else if (Array.isArray(t.name?.runs) && t.name.runs.length > 0) {
        name = t.name.runs.map((r: any) => r.text || '').join('');
      } else if (t.name?.text) {
        name = t.name.text;
      }
      tracks.push({
        baseUrl,
        languageCode,
        name,
        isTranslatable: Boolean(t.isTranslatable ?? t.is_translatable ?? true),
      });
    }
  }

  return tracks;
}

function parseTimestampToSeconds(ts: string): number {
  const parts = ts.trim().replace(',', '.').split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const minutes = parseFloat(parts[1]) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  if (parts.length === 2) {
    const minutes = parseFloat(parts[0]) || 0;
    const seconds = parseFloat(parts[1]) || 0;
    return minutes * 60 + seconds;
  }
  return parseFloat(parts[0]) || 0;
}

/** Parses VTT or SRT subtitle files. */
export function parseVttOrSrt(content: string): TranscriptCue[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const cues: TranscriptCue[] = [];
  let index = 0;
  let currentStart = -1;
  let currentEnd = -1;
  let currentTextLines: string[] = [];

  const timeRegex =
    /((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{2,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[,.]\d{2,3})/;

  const pushCueBlock = () => {
    if (currentStart < 0 || currentTextLines.length === 0) return;
    let linesToJoin = currentTextLines;
    const prev = cues[cues.length - 1];
    if (
      prev &&
      linesToJoin.length >= 2 &&
      cleanText(linesToJoin[0]) === prev.text
    ) {
      linesToJoin = linesToJoin.slice(1);
    }
    const text = cleanText(linesToJoin.join(' '));
    if (!text) return;
    const roundedStart = Math.round(currentStart * 100) / 100;
    const roundedEnd = Math.round(currentEnd * 100) / 100;
    if (
      prev &&
      prev.text === text &&
      (currentEnd - currentStart <= 0.025 || currentStart <= prev.end + 0.025)
    ) {
      prev.end = Math.max(prev.end, roundedEnd);
      return;
    }
    cues.push({
      id: `cue-${index++}`,
      start: roundedStart,
      end: roundedEnd,
      text,
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const timeMatch = timeRegex.exec(trimmed);

    if (timeMatch) {
      pushCueBlock();
      currentStart = parseTimestampToSeconds(timeMatch[1]);
      currentEnd = parseTimestampToSeconds(timeMatch[2]);
      currentTextLines = [];
    } else if (trimmed && currentStart >= 0) {
      // Skip numeric cue identifiers in SRT
      if (/^\d+$/.test(trimmed) && currentTextLines.length === 0) continue;
      currentTextLines.push(trimmed);
    } else if (!trimmed && currentStart >= 0) {
      if (currentTextLines.length > 0) {
        pushCueBlock();
        currentStart = -1;
        currentEnd = -1;
        currentTextLines = [];
      }
    }
  }

  pushCueBlock();

  return cues;
}

/** Merges an original cue list with a translated cue list based on timestamp proximity. */
export function alignBilingualCues(
  original: TranscriptCue[],
  translation: TranscriptCue[],
): TranscriptCue[] {
  if (!translation.length) return original;

  return original.map((orig) => {
    // Find translated cues that overlap with this cue's time range
    const matching = translation.filter((trans) => {
      const overlapStart = Math.max(orig.start, trans.start);
      const overlapEnd = Math.min(orig.end, trans.end);
      return (
        overlapEnd - overlapStart > 0.1 ||
        Math.abs(orig.start - trans.start) < 0.8
      );
    });

    if (matching.length > 0) {
      const combinedTranslation = matching.map((m) => m.text).join(' ');
      return {
        ...orig,
        translation: combinedTranslation,
      };
    }
    return orig;
  });
}
