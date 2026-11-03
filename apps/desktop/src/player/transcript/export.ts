import type { TranscriptCue, TranscriptViewMode } from './types';

export const DEFAULT_TRANSCRIPT_KNOWLEDGE_CATEGORY = '视频笔记';

export type TranscriptRefinementStatus =
  | { kind: 'none' }
  | {
      kind: 'in-progress';
      completedStages: number;
      totalStages: number;
      model: string;
    }
  | {
      kind: 'completed';
      refinedStages: number;
      totalStages: number;
      fallbackStages: number;
      model: string;
    }
  | {
      kind: 'partial';
      completedStages: number;
      totalStages: number;
      refinedStages: number;
      fallbackStages: number;
      model: string;
      reason?: string;
    }
  | {
      kind: 'failed';
      totalStages: number;
      model: string;
      reason?: string;
    }
  | {
      kind: 'cancelled';
      completedStages: number;
      totalStages: number;
      model: string;
    };

export interface TranscriptKnowledgeExportInput {
  videoId: string;
  videoTitle?: string | null;
  channelName?: string | null;
  cues: readonly TranscriptCue[];
  viewMode: TranscriptViewMode;
  trackLabel?: string | null;
  searchQuery?: string | null;
  exportedAt?: Date;
  refinement?: TranscriptRefinementStatus;
}

export interface MergedTranscriptSentence {
  start: number;
  end: number;
  text: string;
  translation?: string;
  cueCount: number;
}

export interface TranscriptParagraph {
  start: number;
  end: number;
  text: string;
  translation?: string;
  sentenceCount: number;
  cueCount: number;
}

export interface TranscriptStageChunk {
  index: number;
  start: number;
  end: number;
  heading: string;
  paragraphs: TranscriptParagraph[];
  cueCount: number;
}

export interface TranscriptKnowledgeExportPayload {
  title: string;
  category: string;
  tags: string[];
  markdown: string;
  cueCount: number;
  paragraphCount: number;
  stageCount: number;
  stages: TranscriptStageChunk[];
}

export interface TranscriptKnowledgeExportResult {
  id?: string;
  title: string;
  category: string;
  relativePath: string;
  open(): void;
  updateMarkdown?(markdown: string, statusLabel?: string): Promise<void>;
}

export interface RefinedTranscriptParagraphCandidate {
  anchorId: number;
  text: string;
  translation?: string | null;
}

export interface RefinedTranscriptStageCandidate {
  stageTitle?: string | null;
  paragraphs: readonly RefinedTranscriptParagraphCandidate[];
}

export interface MergeTranscriptSentencesOptions {
  primaryField?: 'text' | 'translation';
  maxPauseGapSeconds?: number;
  softMaxUnits?: number;
  hardMaxUnits?: number;
  splitInternalSentences?: boolean;
}

export interface GroupTranscriptParagraphsOptions {
  primaryField?: 'text' | 'translation';
  targetSentences?: number;
  maxSentences?: number;
  targetUnits?: number;
  maxUnits?: number;
  softPauseGapSeconds?: number;
  hardPauseGapSeconds?: number;
  maxDurationSeconds?: number;
}

export interface ChunkTranscriptStagesOptions {
  primaryField?: 'text' | 'translation';
  maxDurationSeconds?: number;
  maxUnits?: number;
  maxParagraphs?: number;
}

const CJK_CHAR_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const TRACK_PUNCTUATION_RE = /[.?!,;:，。！？；：、…]/;
const LEADING_ORPHAN_PUNCT_RE = /^([,.;:!?，。！？；：、…]+)\s*/;
const TERMINAL_PUNCT_TAIL_RE = /[.?!。？！…]["'”’）)\]】」』]*$/;
const CLAUSE_BOUNDARY_TAIL_RE = /[,;:，；：、—–]["'”’）)\]】」』]*$/;
const CLOSING_WRAPPER_CHARS = new Set([
  '"',
  "'",
  '”',
  '’',
  ')',
  ']',
  '）',
  '】',
  '」',
  '』',
  '》',
]);
const NO_SPACE_BEFORE_RE = /^[,.;:!?，。！？；：、…）》」』】\]）]/;
const NO_SPACE_AFTER_RE = /[（《「『【[(]$/;
const CJK_FULLWIDTH_PUNCT_TAIL_RE = /[，。！？；：、]$/;

const NON_TERMINAL_ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'fig',
  'no',
  'vol',
  'inc',
  'ltd',
  'co',
  'corp',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

/**
 * Formats a cue timestamp in seconds as `m:ss` (under 1 hour) or `h:mm:ss` (1 hour and above).
 */
export function formatCueTime(seconds: number): string {
  const safeSeconds = Math.max(
    0,
    Math.floor(Number.isFinite(seconds) ? seconds : 0),
  );
  const minutes = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Formats a timestamp in tabular zero-padded enterprise style: `MM:SS` or `HH:MM:SS`.
 */
export function formatPaddedCueTime(seconds: number): string {
  const safeSeconds = Math.max(
    0,
    Math.floor(Number.isFinite(seconds) ? seconds : 0),
  );
  const minutes = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Sanitizes a video title so it satisfies Seamind's library filename and 120-character rules.
 */
export function sanitizeTranscriptNoteTitle(
  rawTitle: string | null | undefined,
  videoId: string,
): string {
  const fallback = `YouTube 字幕 ${videoId.trim() || '未命名视频'}`;
  if (!rawTitle) return fallback;
  const cleaned = Array.from(rawTitle.trim())
    .slice(0, 100)
    .join('')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned || fallback;
}

function normalizeInlineCueText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes language-balanced reading units (CJK characters count as 2 units, other characters as 1).
 */
export function computeTranscriptTextUnits(text: string): number {
  if (!text) return 0;
  let units = 0;
  for (const ch of text) {
    units += CJK_CHAR_RE.test(ch) ? 2 : 1;
  }
  return units;
}

function isAbbreviationBeforeDot(text: string, dotIndex: number): boolean {
  let start = dotIndex - 1;
  while (start >= 0 && /[A-Za-z0-9.&/-]/.test(text[start])) {
    start -= 1;
  }
  const rawToken = text.slice(start + 1, dotIndex).replace(/^\.+|\.+$/g, '');
  if (!rawToken) return false;
  const token = rawToken.toLowerCase();
  if (NON_TERMINAL_ABBREVIATIONS.has(token)) return true;
  if (/^v\d+$/i.test(rawToken)) return true;
  if (/^[A-Z]$/.test(rawToken) && rawToken !== 'I') return true;
  return false;
}

export function endsWithSentenceBoundary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  let end = trimmed.length - 1;
  while (end >= 0 && CLOSING_WRAPPER_CHARS.has(trimmed[end])) {
    end -= 1;
  }
  if (end < 0) return false;
  const last = trimmed[end];
  if (
    last === '。' ||
    last === '？' ||
    last === '！' ||
    last === '?' ||
    last === '!' ||
    last === '…'
  ) {
    return true;
  }
  if (last === '.') {
    if (end >= 2 && trimmed[end - 1] === '.' && trimmed[end - 2] === '.') {
      return true;
    }
    return !isAbbreviationBeforeDot(trimmed, end);
  }
  return false;
}

export function splitTextIntoSentences(text: string): string[] {
  const normalized = normalizeInlineCueText(text);
  if (!normalized) return [];

  const result: string[] = [];
  let segStart = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    const isCjkTerm = ch === '。' || ch === '？' || ch === '！';
    const isLatinTerm = ch === '.' || ch === '?' || ch === '!' || ch === '…';
    if (!isCjkTerm && !isLatinTerm) continue;

    if (isCjkTerm) {
      let endIdx = i + 1;
      while (
        endIdx < normalized.length &&
        (normalized[endIdx] === '。' ||
          normalized[endIdx] === '？' ||
          normalized[endIdx] === '！' ||
          normalized[endIdx] === '…' ||
          CLOSING_WRAPPER_CHARS.has(normalized[endIdx]))
      ) {
        endIdx += 1;
      }
      const slice = normalized.slice(segStart, endIdx).trim();
      if (slice) result.push(slice);
      while (endIdx < normalized.length && /\s/.test(normalized[endIdx])) {
        endIdx += 1;
      }
      segStart = endIdx;
      i = segStart - 1;
      continue;
    }

    let punctEnd = i + 1;
    while (
      punctEnd < normalized.length &&
      (normalized[punctEnd] === '.' ||
        normalized[punctEnd] === '?' ||
        normalized[punctEnd] === '!' ||
        normalized[punctEnd] === '…')
    ) {
      punctEnd += 1;
    }

    if (ch === '.' && punctEnd === i + 1) {
      if (
        punctEnd < normalized.length &&
        /[A-Za-z0-9]/.test(normalized[punctEnd])
      ) {
        continue;
      }
      if (isAbbreviationBeforeDot(normalized, i)) {
        continue;
      }
    }

    let endIdx = punctEnd;
    while (
      endIdx < normalized.length &&
      CLOSING_WRAPPER_CHARS.has(normalized[endIdx])
    ) {
      endIdx += 1;
    }

    if (endIdx < normalized.length) {
      const nextChar = normalized[endIdx];
      const hasWhitespace = /\s/.test(nextChar);
      if (!hasWhitespace && !CJK_CHAR_RE.test(nextChar)) {
        i = punctEnd - 1;
        continue;
      }
      let nextTokenIdx = endIdx;
      while (
        nextTokenIdx < normalized.length &&
        /\s/.test(normalized[nextTokenIdx])
      ) {
        nextTokenIdx += 1;
      }
      if (
        nextTokenIdx < normalized.length &&
        /[a-z]/.test(normalized[nextTokenIdx])
      ) {
        i = punctEnd - 1;
        continue;
      }
    }

    const slice = normalized.slice(segStart, endIdx).trim();
    if (slice) result.push(slice);
    while (endIdx < normalized.length && /\s/.test(normalized[endIdx])) {
      endIdx += 1;
    }
    segStart = endIdx;
    i = segStart - 1;
  }

  if (segStart < normalized.length) {
    const tail = normalized.slice(segStart).trim();
    if (tail) result.push(tail);
  }

  return result;
}

function dedupeRollingOverlap(prevText: string, nextText: string): string {
  if (!prevText || !nextText) return nextText;
  if (prevText === nextText) return '';

  if (nextText.startsWith(prevText) && prevText.length >= 6) {
    const remainder = nextText.slice(prevText.length);
    if (
      !remainder ||
      /^\s/.test(remainder) ||
      CJK_CHAR_RE.test(prevText[prevText.length - 1]) ||
      CJK_CHAR_RE.test(remainder[0])
    ) {
      return remainder.trim();
    }
  }

  const maxOverlap = Math.min(prevText.length, nextText.length, 80);
  for (let len = maxOverlap; len >= 5; len -= 1) {
    const suffix = prevText.slice(prevText.length - len);
    if (!nextText.startsWith(suffix)) continue;
    const isCjkOverlap = CJK_CHAR_RE.test(suffix);
    if (!isCjkOverlap) {
      if (len < 10 || !suffix.includes(' ')) continue;
      const beforeIdx = prevText.length - len - 1;
      const afterIdx = len;
      const cleanStart = beforeIdx < 0 || /\s/.test(prevText[beforeIdx]);
      const cleanEnd =
        afterIdx >= nextText.length || /[\s,.;:!?]/.test(nextText[afterIdx]);
      if (!cleanStart || !cleanEnd) continue;
    }
    return nextText.slice(len).trim();
  }

  return nextText;
}

export function joinTranscriptFragments(
  left: string,
  right: string,
  options?: { unpunctuatedCjkSpace?: boolean },
): string {
  const cleanLeft = left.trim();
  const cleanRight = right.trim();
  if (!cleanLeft) return cleanRight;
  if (!cleanRight) return cleanLeft;

  if (
    NO_SPACE_BEFORE_RE.test(cleanRight) ||
    NO_SPACE_AFTER_RE.test(cleanLeft)
  ) {
    return `${cleanLeft}${cleanRight}`;
  }

  if (CJK_FULLWIDTH_PUNCT_TAIL_RE.test(cleanLeft)) {
    return `${cleanLeft}${cleanRight}`;
  }

  const leftLast = cleanLeft[cleanLeft.length - 1];
  const rightFirst = cleanRight[0];
  if (CJK_CHAR_RE.test(leftLast) && CJK_CHAR_RE.test(rightFirst)) {
    return options?.unpunctuatedCjkSpace
      ? `${cleanLeft} ${cleanRight}`
      : `${cleanLeft}${cleanRight}`;
  }

  return `${cleanLeft} ${cleanRight}`;
}

interface NormalizedCueAtom {
  start: number;
  end: number;
  text: string;
  translation: string;
  cueCount: number;
}

function adsorbLeadingPunctuation(
  prev: string,
  curr: string,
): { prev: string; curr: string } {
  const match = curr.match(LEADING_ORPHAN_PUNCT_RE);
  if (!match) return { prev, curr };
  const punct = match[1];
  const rest = curr.slice(match[0].length).trim();
  if (!prev) {
    return { prev, curr: rest };
  }
  const updatedPrev = TERMINAL_PUNCT_TAIL_RE.test(prev)
    ? prev
    : `${prev.replace(/\s+$/, '')}${punct}`;
  return { prev: updatedPrev, curr: rest };
}

function expandCueIntoSentenceAtoms(
  cue: NormalizedCueAtom,
  splitInternal: boolean,
): NormalizedCueAtom[] {
  if (!splitInternal) return [cue];

  if (cue.text && !cue.translation) {
    const parts = splitTextIntoSentences(cue.text);
    if (parts.length <= 1) return [cue];
    const totalChars = parts.reduce((sum, part) => sum + part.length, 0) || 1;
    const duration = Math.max(0, cue.end - cue.start);
    let offsetChars = 0;
    return parts.map((part, idx) => {
      const atomStart =
        idx === 0
          ? cue.start
          : cue.start + duration * (offsetChars / totalChars);
      offsetChars += part.length;
      const atomEnd =
        idx === parts.length - 1
          ? cue.end
          : cue.start + duration * (offsetChars / totalChars);
      return {
        start: atomStart,
        end: Math.max(atomStart, atomEnd),
        text: part,
        translation: '',
        cueCount: idx === 0 ? cue.cueCount : 0,
      };
    });
  }

  if (!cue.text && cue.translation) {
    const parts = splitTextIntoSentences(cue.translation);
    if (parts.length <= 1) return [cue];
    const totalChars = parts.reduce((sum, part) => sum + part.length, 0) || 1;
    const duration = Math.max(0, cue.end - cue.start);
    let offsetChars = 0;
    return parts.map((part, idx) => {
      const atomStart =
        idx === 0
          ? cue.start
          : cue.start + duration * (offsetChars / totalChars);
      offsetChars += part.length;
      const atomEnd =
        idx === parts.length - 1
          ? cue.end
          : cue.start + duration * (offsetChars / totalChars);
      return {
        start: atomStart,
        end: Math.max(atomStart, atomEnd),
        text: '',
        translation: part,
        cueCount: idx === 0 ? cue.cueCount : 0,
      };
    });
  }

  if (cue.text && cue.translation) {
    const textParts = splitTextIntoSentences(cue.text);
    const transParts = splitTextIntoSentences(cue.translation);
    if (textParts.length > 1 && textParts.length === transParts.length) {
      const totalChars =
        textParts.reduce((sum, part) => sum + part.length, 0) || 1;
      const duration = Math.max(0, cue.end - cue.start);
      let offsetChars = 0;
      return textParts.map((part, idx) => {
        const atomStart =
          idx === 0
            ? cue.start
            : cue.start + duration * (offsetChars / totalChars);
        offsetChars += part.length;
        const atomEnd =
          idx === textParts.length - 1
            ? cue.end
            : cue.start + duration * (offsetChars / totalChars);
        return {
          start: atomStart,
          end: Math.max(atomStart, atomEnd),
          text: part,
          translation: transParts[idx],
          cueCount: idx === 0 ? cue.cueCount : 0,
        };
      });
    }
  }

  return [cue];
}

/**
 * Reconstructs natural complete sentences from short 1-2s ASR/SRT/VTT cues while
 * adsorbing orphan leading punctuation, deduplicating rolling caption overlaps,
 * and preserving exact opening timestamps.
 */
export function mergeTranscriptSentences(
  cues: readonly TranscriptCue[],
  options?: MergeTranscriptSentencesOptions,
): MergedTranscriptSentence[] {
  const primaryField = options?.primaryField ?? 'text';
  const maxPauseGapSeconds = options?.maxPauseGapSeconds ?? 1.2;
  const softMaxUnits = options?.softMaxUnits ?? 96;
  const hardMaxUnits = options?.hardMaxUnits ?? 160;
  const splitInternal = options?.splitInternalSentences ?? true;

  const cleaned: NormalizedCueAtom[] = [];
  for (const cue of cues) {
    const start = Math.max(0, Number.isFinite(cue.start) ? cue.start : 0);
    const end = Math.max(start, Number.isFinite(cue.end) ? cue.end : start);
    let text = normalizeInlineCueText(cue.text);
    let translation = normalizeInlineCueText(cue.translation);
    if (!text && !translation) continue;

    const prev = cleaned[cleaned.length - 1];
    if (prev && start - prev.end <= 1.5) {
      if (text) text = dedupeRollingOverlap(prev.text, text);
      if (translation) {
        translation = dedupeRollingOverlap(prev.translation, translation);
      }
      if (!text && !translation) {
        prev.end = Math.max(prev.end, end);
        prev.cueCount += 1;
        continue;
      }
    }

    if (text) {
      const adsorbed = adsorbLeadingPunctuation(prev?.text ?? '', text);
      if (prev) prev.text = adsorbed.prev;
      text = adsorbed.curr;
    }
    if (translation) {
      const adsorbed = adsorbLeadingPunctuation(
        prev?.translation ?? '',
        translation,
      );
      if (prev) prev.translation = adsorbed.prev;
      translation = adsorbed.curr;
    }

    if (!text && !translation) {
      if (prev) {
        prev.end = Math.max(prev.end, end);
        prev.cueCount += 1;
      }
      continue;
    }

    cleaned.push({ start, end, text, translation, cueCount: 1 });
  }

  if (cleaned.length === 0) return [];

  const textPunctCount = cleaned.filter((item) =>
    TRACK_PUNCTUATION_RE.test(item.text),
  ).length;
  const transPunctCount = cleaned.filter((item) =>
    TRACK_PUNCTUATION_RE.test(item.translation),
  ).length;
  const hasTextPunctuation = textPunctCount / cleaned.length >= 0.15;
  const hasTransPunctuation = transPunctCount / cleaned.length >= 0.15;

  const atoms = cleaned.flatMap((item) =>
    expandCueIntoSentenceAtoms(item, splitInternal),
  );

  const sentences: MergedTranscriptSentence[] = [];
  let current: NormalizedCueAtom | null = null;

  const pickPrimary = (item: NormalizedCueAtom): string =>
    primaryField === 'translation'
      ? item.translation || item.text
      : item.text || item.translation;

  const flushCurrent = () => {
    if (!current) return;
    if (current.text || current.translation) {
      sentences.push({
        start: current.start,
        end: current.end,
        text: current.text,
        ...(current.translation ? { translation: current.translation } : {}),
        cueCount: Math.max(1, current.cueCount),
      });
    }
    current = null;
  };

  for (const atom of atoms) {
    if (!current) {
      current = { ...atom };
      if (endsWithSentenceBoundary(pickPrimary(current))) {
        flushCurrent();
      }
      continue;
    }

    const pauseGap = atom.start - current.end;
    const currentPrimary = pickPrimary(current);
    const currentUnits = computeTranscriptTextUnits(currentPrimary);

    const shouldSplitBefore =
      endsWithSentenceBoundary(currentPrimary) ||
      pauseGap >= maxPauseGapSeconds ||
      currentUnits >= hardMaxUnits ||
      (currentUnits >= softMaxUnits &&
        (pauseGap >= 0.35 || CLAUSE_BOUNDARY_TAIL_RE.test(currentPrimary)));

    if (shouldSplitBefore) {
      flushCurrent();
      current = { ...atom };
      if (endsWithSentenceBoundary(pickPrimary(current))) {
        flushCurrent();
      }
      continue;
    }

    current.text = joinTranscriptFragments(current.text, atom.text, {
      unpunctuatedCjkSpace: !hasTextPunctuation,
    });
    current.translation = joinTranscriptFragments(
      current.translation,
      atom.translation,
      { unpunctuatedCjkSpace: !hasTransPunctuation },
    );
    current.end = Math.max(current.end, atom.end);
    current.cueCount += atom.cueCount;

    if (endsWithSentenceBoundary(pickPrimary(current))) {
      flushCurrent();
    }
  }

  flushCurrent();
  return sentences;
}

/**
 * Groups complete sentences into readable, cohesive semantic paragraphs while keeping
 * each paragraph's opening timestamp accurate.
 */
export function groupSentencesIntoParagraphs(
  sentences: readonly MergedTranscriptSentence[],
  options?: GroupTranscriptParagraphsOptions,
): TranscriptParagraph[] {
  if (sentences.length === 0) return [];

  const primaryField = options?.primaryField ?? 'text';
  const targetSentences = options?.targetSentences ?? 3;
  const maxSentences = options?.maxSentences ?? 5;
  const targetUnits = options?.targetUnits ?? 220;
  const maxUnits = options?.maxUnits ?? 360;
  const softPauseGapSeconds = options?.softPauseGapSeconds ?? 2.0;
  const hardPauseGapSeconds = options?.hardPauseGapSeconds ?? 4.0;
  const maxDurationSeconds = options?.maxDurationSeconds ?? 45;

  const textPunctCount = sentences.filter((item) =>
    TRACK_PUNCTUATION_RE.test(item.text),
  ).length;
  const transPunctCount = sentences.filter((item) =>
    TRACK_PUNCTUATION_RE.test(item.translation ?? ''),
  ).length;
  const hasTextPunctuation = textPunctCount / sentences.length >= 0.15;
  const hasTransPunctuation = transPunctCount / sentences.length >= 0.15;

  const pickPrimary = (item: { text: string; translation?: string }): string =>
    primaryField === 'translation'
      ? item.translation || item.text
      : item.text || item.translation || '';

  const paragraphs: TranscriptParagraph[] = [];
  let current: TranscriptParagraph | null = null;

  for (const sentence of sentences) {
    if (!current) {
      current = {
        start: sentence.start,
        end: sentence.end,
        text: sentence.text,
        ...(sentence.translation ? { translation: sentence.translation } : {}),
        sentenceCount: 1,
        cueCount: sentence.cueCount,
      };
      continue;
    }

    const pauseGap = sentence.start - current.end;
    const currentUnits = computeTranscriptTextUnits(pickPrimary(current));
    const nextUnits = computeTranscriptTextUnits(pickPrimary(sentence));
    const spanSeconds = sentence.end - current.start;

    const shouldStartNewParagraph =
      pauseGap >= hardPauseGapSeconds ||
      (pauseGap >= softPauseGapSeconds &&
        (currentUnits >= 70 || current.sentenceCount >= 2)) ||
      current.sentenceCount >= maxSentences ||
      (current.sentenceCount >= targetSentences &&
        currentUnits >= targetUnits) ||
      currentUnits >= maxUnits ||
      (currentUnits >= 90 && currentUnits + nextUnits > maxUnits) ||
      spanSeconds > maxDurationSeconds;

    if (shouldStartNewParagraph) {
      paragraphs.push(current);
      current = {
        start: sentence.start,
        end: sentence.end,
        text: sentence.text,
        ...(sentence.translation ? { translation: sentence.translation } : {}),
        sentenceCount: 1,
        cueCount: sentence.cueCount,
      };
      continue;
    }

    const mergedText = joinTranscriptFragments(current.text, sentence.text, {
      unpunctuatedCjkSpace: !hasTextPunctuation,
    });
    const mergedTranslation = joinTranscriptFragments(
      current.translation ?? '',
      sentence.translation ?? '',
      { unpunctuatedCjkSpace: !hasTransPunctuation },
    );

    current = {
      start: current.start,
      end: Math.max(current.end, sentence.end),
      text: mergedText,
      ...(mergedTranslation ? { translation: mergedTranslation } : {}),
      sentenceCount: current.sentenceCount + 1,
      cueCount: current.cueCount + sentence.cueCount,
    };
  }

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs;
}

/**
 * Partitions paragraphs into bounded ~4-5 minute / ~2800-unit stage windows without
 * splitting mid-paragraph, powering both Knowledge Base outline sections and phased LLM refinement.
 */
export function chunkTranscriptForStages(
  paragraphs: readonly TranscriptParagraph[],
  options?: ChunkTranscriptStagesOptions,
): TranscriptStageChunk[] {
  if (paragraphs.length === 0) return [];

  const primaryField = options?.primaryField ?? 'text';
  const maxDurationSeconds = options?.maxDurationSeconds ?? 300;
  const maxUnits = options?.maxUnits ?? 2800;
  const maxParagraphs = options?.maxParagraphs ?? 50;

  const pickPrimary = (para: TranscriptParagraph): string =>
    primaryField === 'translation'
      ? para.translation || para.text
      : para.text || para.translation || '';

  const stages: TranscriptStageChunk[] = [];
  let bucket: TranscriptParagraph[] = [];
  let bucketUnits = 0;

  const flushBucket = () => {
    if (bucket.length === 0) return;
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    stages.push({
      index: stages.length,
      start: first.start,
      end: last.end,
      heading: `${formatPaddedCueTime(first.start)} - ${formatPaddedCueTime(last.end)}`,
      paragraphs: bucket,
      cueCount: bucket.reduce((sum, item) => sum + item.cueCount, 0),
    });
    bucket = [];
    bucketUnits = 0;
  };

  for (const para of paragraphs) {
    const paraUnits = computeTranscriptTextUnits(pickPrimary(para));
    if (bucket.length > 0) {
      const stageStart = bucket[0].start;
      const stageSpan = para.end - stageStart;
      if (
        stageSpan > maxDurationSeconds ||
        bucketUnits + paraUnits > maxUnits ||
        bucket.length >= maxParagraphs
      ) {
        flushBucket();
      }
    }
    bucket.push(para);
    bucketUnits += paraUnits;
  }

  flushBucket();
  return stages;
}

function formatExportTimestamp(date: Date): string {
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeViewMode(
  viewMode: TranscriptViewMode,
  hasTranslation: boolean,
): string {
  if (viewMode === 'original') return '仅原文';
  if (viewMode === 'translation') return '仅译文';
  return hasTranslation ? '双语对照' : '原文';
}

export function buildParagraphMarkdownBlock(
  videoId: string,
  paragraph: TranscriptParagraph,
  viewMode: TranscriptViewMode,
): string | null {
  const original = normalizeInlineCueText(paragraph.text);
  const translation = normalizeInlineCueText(paragraph.translation);

  const startSec = Math.max(
    0,
    Math.floor(Number.isFinite(paragraph.start) ? paragraph.start : 0),
  );
  const timeLabel = formatPaddedCueTime(paragraph.start);
  const timestampLink = `[${timeLabel}](https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${startSec}s)`;

  if (viewMode === 'original') {
    const primary = original || translation;
    return primary ? `${timestampLink} ${primary}` : null;
  }

  if (viewMode === 'translation') {
    const primary = translation || original;
    return primary ? `${timestampLink} ${primary}` : null;
  }

  if (!original && !translation) return null;
  if (!translation || translation === original) {
    return `${timestampLink} ${original || translation}`;
  }
  if (!original) {
    return `${timestampLink} ${translation}`;
  }
  return `${timestampLink} ${original}  \n${translation}`;
}

function sanitizeRefinedStageTitle(
  rawTitle: string | null | undefined,
): string {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/\r?\n+/g, ' ')
    .replace(/^#+\s*/, '')
    .replace(
      /^(?:\d{1,2}:\d{2}(?::\d{2})?\s*[-–~—]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[·•:\-—]?\s*)/,
      '',
    )
    .replace(/[\x5B\x5D`*_<>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

/**
 * Validates and applies an LLM stage refinement response onto a `TranscriptStageChunk`,
 * anchoring every refined paragraph to an authentic source paragraph timestamp (`anchorId`)
 * and falling back safely to the original stage if the LLM output is empty or truncated.
 */
export function applyRefinedStageOutput(
  stage: TranscriptStageChunk,
  candidate: RefinedTranscriptStageCandidate,
  viewMode: TranscriptViewMode,
): { stage: TranscriptStageChunk; usedFallback: boolean } {
  if (stage.paragraphs.length === 0 || candidate.paragraphs.length === 0) {
    return { stage, usedFallback: true };
  }

  const pickStagePrimary = (para: {
    text: string;
    translation?: string | null;
  }): string =>
    viewMode === 'translation'
      ? normalizeInlineCueText(para.translation) ||
        normalizeInlineCueText(para.text)
      : normalizeInlineCueText(para.text) ||
        normalizeInlineCueText(para.translation);

  const sourceUnits = stage.paragraphs.reduce(
    (sum, para) => sum + computeTranscriptTextUnits(pickStagePrimary(para)),
    0,
  );

  const maxIndex = stage.paragraphs.length - 1;
  let minAnchor = 0;
  const refinedParagraphs: TranscriptParagraph[] = [];

  for (
    let itemIndex = 0;
    itemIndex < candidate.paragraphs.length;
    itemIndex += 1
  ) {
    const item = candidate.paragraphs[itemIndex];
    const cleanText = normalizeInlineCueText(item.text);
    const cleanTranslation = normalizeInlineCueText(item.translation);

    let finalText = cleanText;
    let finalTranslation = cleanTranslation;

    if (viewMode === 'translation') {
      finalTranslation = cleanText || cleanTranslation;
      finalText = '';
    } else if (viewMode === 'original') {
      finalText = cleanText || cleanTranslation;
      finalTranslation = '';
    }

    if (!finalText && !finalTranslation) return { stage, usedFallback: true };

    const rawId = Number.isFinite(item.anchorId)
      ? Math.floor(item.anchorId)
      : Number.NaN;
    if (
      !Number.isFinite(rawId) ||
      rawId < minAnchor ||
      rawId > maxIndex ||
      (itemIndex === 0 && rawId !== 0) ||
      (viewMode === 'bilingual' && !cleanTranslation)
    ) {
      return { stage, usedFallback: true };
    }
    minAnchor = rawId;
    const anchor = stage.paragraphs[rawId];

    refinedParagraphs.push({
      start: anchor.start,
      end: anchor.end,
      text: finalText,
      ...(finalTranslation ? { translation: finalTranslation } : {}),
      sentenceCount: Math.max(
        1,
        splitTextIntoSentences(finalText || finalTranslation).length,
      ),
      cueCount: anchor.cueCount,
    });
  }

  if (refinedParagraphs.length === 0) {
    return { stage, usedFallback: true };
  }

  // Update each refined paragraph's `end` to span up to the next paragraph's start or stage end.
  for (let i = 0; i < refinedParagraphs.length; i += 1) {
    const nextStart =
      i + 1 < refinedParagraphs.length
        ? refinedParagraphs[i + 1].start
        : stage.end;
    refinedParagraphs[i].end = Math.max(refinedParagraphs[i].start, nextStart);
  }

  const refinedUnits = refinedParagraphs.reduce(
    (sum, para) => sum + computeTranscriptTextUnits(pickStagePrimary(para)),
    0,
  );
  if (sourceUnits >= 200 && refinedUnits < sourceUnits * 0.55) {
    return { stage, usedFallback: true };
  }

  const timeRange = `${formatPaddedCueTime(stage.start)} - ${formatPaddedCueTime(stage.end)}`;
  const cleanTitle = sanitizeRefinedStageTitle(candidate.stageTitle);
  const heading = cleanTitle ? `${timeRange} · ${cleanTitle}` : timeRange;

  return {
    stage: {
      index: stage.index,
      start: stage.start,
      end: stage.end,
      heading,
      paragraphs: refinedParagraphs,
      cueCount: stage.cueCount,
    },
    usedFallback: false,
  };
}

export function renderTranscriptStagesMarkdown(options: {
  videoId: string;
  videoTitle?: string | null;
  channelName?: string | null;
  trackLabel?: string | null;
  searchQuery?: string | null;
  viewMode: TranscriptViewMode;
  hasTranslation: boolean;
  exportedAt?: Date;
  stages: readonly TranscriptStageChunk[];
  rawCueCount: number;
  refinement?: TranscriptRefinementStatus;
}): { markdown: string; paragraphCount: number } {
  const cleanVideoId = options.videoId.trim();
  const safeTitle = sanitizeTranscriptNoteTitle(
    options.videoTitle,
    cleanVideoId,
  );
  const headingTitle = options.videoTitle?.trim() || safeTitle;
  const channelName = normalizeInlineCueText(options.channelName);
  const trackLabel = normalizeInlineCueText(options.trackLabel);
  const searchQuery = normalizeInlineCueText(options.searchQuery);
  const refinement = options.refinement ?? { kind: 'none' };
  const isAiRefinedOrRunning = refinement.kind !== 'none';

  const totalParagraphs = options.stages.reduce(
    (sum, stage) => sum + stage.paragraphs.length,
    0,
  );
  const useStageHeadings =
    !searchQuery &&
    ((options.stages.length > 1 && totalParagraphs > 4) ||
      (isAiRefinedOrRunning && options.stages.length >= 1));

  const bodyLines: string[] = [];
  let emittedParagraphs = 0;

  if (useStageHeadings) {
    for (const stage of options.stages) {
      const stageBlocks = stage.paragraphs
        .map((para) =>
          buildParagraphMarkdownBlock(cleanVideoId, para, options.viewMode),
        )
        .filter((block): block is string => Boolean(block));
      if (stageBlocks.length === 0) continue;
      if (bodyLines.length > 0) bodyLines.push('');
      bodyLines.push(`## ${stage.heading}`, '');
      stageBlocks.forEach((block, idx) => {
        if (idx > 0) bodyLines.push('');
        bodyLines.push(block);
      });
      emittedParagraphs += stageBlocks.length;
    }
  } else {
    const sectionTitle = searchQuery ? '## 筛选字幕摘录' : '## 内容实录';
    bodyLines.push(sectionTitle, '');
    const allParagraphs = options.stages.flatMap((stage) => stage.paragraphs);
    const blocks = allParagraphs
      .map((para) =>
        buildParagraphMarkdownBlock(cleanVideoId, para, options.viewMode),
      )
      .filter((block): block is string => Boolean(block));
    blocks.forEach((block, idx) => {
      if (idx > 0) bodyLines.push('');
      bodyLines.push(block);
    });
    emittedParagraphs = blocks.length;
  }

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(cleanVideoId)}`;
  const modeLabel = describeViewMode(options.viewMode, options.hasTranslation);
  const exportedAtLabel = formatExportTimestamp(
    options.exportedAt ?? new Date(),
  );

  const stageSuffix = useStageHeadings
    ? ` · ${options.stages.length} 个阶段`
    : '';
  const statsSummary =
    options.rawCueCount > emittedParagraphs
      ? `${options.rawCueCount} 条碎词合并为 ${emittedParagraphs} 段${stageSuffix}`
      : `共 ${emittedParagraphs} 段${stageSuffix}`;

  const metaLines: string[] = [
    '> [!NOTE] 视频信息',
    `> - **视频链接**：[${watchUrl}](${watchUrl})`,
  ];
  if (channelName) {
    metaLines.push(`> - **频道**：${channelName}`);
  }
  if (trackLabel) {
    metaLines.push(`> - **字幕轨道**：${trackLabel}`);
  }
  metaLines.push(`> - **字幕模式**：${modeLabel}（${statsSummary}）`);

  if (refinement.kind === 'in-progress') {
    metaLines.push(
      `> - **AI 精修状态**：正在分阶段精修（已完成 ${refinement.completedStages} / ${refinement.totalStages} 阶段 · 模型：\`${refinement.model}\`）`,
    );
  } else if (refinement.kind === 'completed') {
    const fallbackNote =
      refinement.fallbackStages > 0
        ? `，其中 ${refinement.fallbackStages} 个阶段保留智能分段`
        : '';
    metaLines.push(
      `> - **整理方式**：AI 分阶段语义精修（共 ${refinement.totalStages} 个阶段 · 模型：\`${refinement.model}\`${fallbackNote}）`,
    );
  } else if (refinement.kind === 'partial') {
    const reason = refinement.reason?.trim();
    const fallbackNote =
      refinement.fallbackStages > 0
        ? `，${refinement.fallbackStages} 个阶段保留智能分段`
        : '';
    const reasonNote = reason
      ? `；${reason.replace(/[\r\n`]/g, ' ').slice(0, 100)}`
      : '';
    metaLines.push(
      `> - **AI 精修状态**：部分完成（${refinement.completedStages} / ${refinement.totalStages} 阶段 · 模型：\`${refinement.model}\`${fallbackNote}${reasonNote}）`,
    );
  } else if (refinement.kind === 'failed') {
    const reason = refinement.reason?.trim();
    const reasonNote = reason
      ? `；${reason.replace(/[\r\n`]/g, ' ').slice(0, 100)}`
      : '';
    metaLines.push(
      `> - **AI 精修状态**：未能开始，已保留智能分段（模型：\`${refinement.model}\`${reasonNote}）`,
    );
  } else if (refinement.kind === 'cancelled') {
    metaLines.push(
      `> - **整理方式**：AI 分阶段精修已提前停止（已完成 ${refinement.completedStages} / ${refinement.totalStages} 阶段 · 模型：\`${refinement.model}\`）`,
    );
  }

  if (searchQuery) {
    metaLines.push(`> - **筛选关键词**：\`${searchQuery.replace(/`/g, "'")}\``);
  }
  metaLines.push(`> - **导出时间**：${exportedAtLabel}`);

  const markdown = [
    `# ${headingTitle}`,
    '',
    ...metaLines,
    '',
    ...bodyLines,
    '',
  ].join('\n');

  return { markdown, paragraphCount: emittedParagraphs };
}

/**
 * Builds a structured Knowledge Base (`kind: 'doc'`) Markdown payload from video transcript cues,
 * merging mechanical ASR fragments into natural paragraphs with enterprise timestamp badges.
 */
export function buildTranscriptKnowledgeExport(
  input: TranscriptKnowledgeExportInput,
): TranscriptKnowledgeExportPayload {
  const cleanVideoId = input.videoId.trim();
  const title = sanitizeTranscriptNoteTitle(input.videoTitle, cleanVideoId);
  const channelName = normalizeInlineCueText(input.channelName);
  const searchQuery = normalizeInlineCueText(input.searchQuery);
  const hasTranslation = input.cues.some((cue) =>
    Boolean(normalizeInlineCueText(cue.translation)),
  );
  const primaryField: 'text' | 'translation' =
    input.viewMode === 'translation' ? 'translation' : 'text';

  let paragraphs: TranscriptParagraph[];
  if (searchQuery) {
    // Preserve per-match timestamps when exporting keyword-filtered search hits.
    const sentences = mergeTranscriptSentences(input.cues, {
      primaryField,
      maxPauseGapSeconds: 0.8,
      splitInternalSentences: false,
    });
    paragraphs = sentences.map((sentence) => ({
      start: sentence.start,
      end: sentence.end,
      text: sentence.text,
      ...(sentence.translation ? { translation: sentence.translation } : {}),
      sentenceCount: 1,
      cueCount: sentence.cueCount,
    }));
  } else {
    const sentences = mergeTranscriptSentences(input.cues, { primaryField });
    paragraphs = groupSentencesIntoParagraphs(sentences, { primaryField });
  }

  const stages = chunkTranscriptForStages(paragraphs, { primaryField });
  const rawCueCount = paragraphs.reduce((sum, para) => sum + para.cueCount, 0);

  const { markdown, paragraphCount } = renderTranscriptStagesMarkdown({
    videoId: cleanVideoId,
    videoTitle: input.videoTitle,
    channelName: input.channelName,
    trackLabel: input.trackLabel,
    searchQuery: input.searchQuery,
    viewMode: input.viewMode,
    hasTranslation,
    exportedAt: input.exportedAt,
    stages,
    rawCueCount,
    refinement: input.refinement,
  });

  const tags = ['YouTube', '视频字幕'];
  if (channelName) {
    const cleanChannelTag = channelName
      .replace(/^[#@]+/, '')
      .replace(/[,，\s]+/g, '-')
      .slice(0, 24);
    if (cleanChannelTag && !tags.includes(cleanChannelTag)) {
      tags.push(cleanChannelTag);
    }
  }
  if (input.refinement && input.refinement.kind !== 'none') {
    tags.push('AI精修');
  }

  return {
    title,
    category: DEFAULT_TRANSCRIPT_KNOWLEDGE_CATEGORY,
    tags,
    markdown,
    cueCount: rawCueCount,
    paragraphCount,
    stageCount: stages.length,
    stages,
  };
}
