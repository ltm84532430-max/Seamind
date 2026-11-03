import type { TranscriptCue } from './types';

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
    if (typeof item.tStartMs !== 'number') continue;
    const start = item.tStartMs / 1000;
    const duration = (item.dDurationMs ?? 2000) / 1000;
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
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const textNodes = doc.querySelectorAll('text');
  const cues: TranscriptCue[] = [];
  let index = 0;

  textNodes.forEach((node) => {
    const startStr = node.getAttribute('start');
    const durStr = node.getAttribute('dur');
    if (!startStr) return;
    const start = parseFloat(startStr);
    const duration = durStr ? parseFloat(durStr) : 2.0;
    const end = start + duration;
    const text = cleanText(node.textContent || '');
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

  for (const line of lines) {
    const trimmed = line.trim();
    const timeMatch = timeRegex.exec(trimmed);

    if (timeMatch) {
      if (currentStart >= 0 && currentTextLines.length > 0) {
        const text = cleanText(currentTextLines.join(' '));
        if (text) {
          cues.push({
            id: `cue-${index++}`,
            start: Math.round(currentStart * 100) / 100,
            end: Math.round(currentEnd * 100) / 100,
            text,
          });
        }
      }
      currentStart = parseTimestampToSeconds(timeMatch[1]);
      currentEnd = parseTimestampToSeconds(timeMatch[2]);
      currentTextLines = [];
    } else if (trimmed && currentStart >= 0) {
      // Skip numeric cue identifiers in SRT
      if (/^\d+$/.test(trimmed) && currentTextLines.length === 0) continue;
      currentTextLines.push(trimmed);
    } else if (!trimmed && currentStart >= 0) {
      if (currentTextLines.length > 0) {
        const text = cleanText(currentTextLines.join(' '));
        if (text) {
          cues.push({
            id: `cue-${index++}`,
            start: Math.round(currentStart * 100) / 100,
            end: Math.round(currentEnd * 100) / 100,
            text,
          });
        }
        currentStart = -1;
        currentEnd = -1;
        currentTextLines = [];
      }
    }
  }

  if (currentStart >= 0 && currentTextLines.length > 0) {
    const text = cleanText(currentTextLines.join(' '));
    if (text) {
      cues.push({
        id: `cue-${index++}`,
        start: Math.round(currentStart * 100) / 100,
        end: Math.round(currentEnd * 100) / 100,
        text,
      });
    }
  }

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
