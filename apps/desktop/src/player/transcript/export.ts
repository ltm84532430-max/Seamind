import type { TranscriptCue, TranscriptViewMode } from './types';

export const DEFAULT_TRANSCRIPT_KNOWLEDGE_CATEGORY = '视频笔记';

export interface TranscriptKnowledgeExportInput {
  videoId: string;
  videoTitle?: string | null;
  channelName?: string | null;
  cues: readonly TranscriptCue[];
  viewMode: TranscriptViewMode;
  trackLabel?: string | null;
  searchQuery?: string | null;
  exportedAt?: Date;
}

export interface TranscriptKnowledgeExportPayload {
  title: string;
  category: string;
  tags: string[];
  markdown: string;
  cueCount: number;
}

export interface TranscriptKnowledgeExportResult {
  title: string;
  category: string;
  relativePath: string;
  open(): void;
}

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

function buildCueMarkdownLine(
  videoId: string,
  cue: TranscriptCue,
  viewMode: TranscriptViewMode,
): string | null {
  const original = normalizeInlineCueText(cue.text);
  const translation = normalizeInlineCueText(cue.translation);

  const startSec = Math.max(
    0,
    Math.floor(Number.isFinite(cue.start) ? cue.start : 0),
  );
  const timeLabel = formatCueTime(cue.start);
  const timestampLink = `**[▶ ${timeLabel}](https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${startSec}s)**`;

  if (viewMode === 'original') {
    const primary = original || translation;
    return primary ? `- ${timestampLink} ${primary}` : null;
  }

  if (viewMode === 'translation') {
    const primary = translation || original;
    return primary ? `- ${timestampLink} ${primary}` : null;
  }

  if (!original && !translation) return null;
  if (!translation || translation === original) {
    return `- ${timestampLink} ${original || translation}`;
  }
  if (!original) {
    return `- ${timestampLink} ${translation}`;
  }
  return `- ${timestampLink} ${original}  \n  ${translation}`;
}

/**
 * Builds a structured Knowledge Base (`kind: 'doc'`) Markdown payload from video transcript cues,
 * preserving clickable timestamps on every cue.
 */
export function buildTranscriptKnowledgeExport(
  input: TranscriptKnowledgeExportInput,
): TranscriptKnowledgeExportPayload {
  const cleanVideoId = input.videoId.trim();
  const title = sanitizeTranscriptNoteTitle(input.videoTitle, cleanVideoId);
  const headingTitle = input.videoTitle?.trim() || title;
  const channelName = normalizeInlineCueText(input.channelName);
  const trackLabel = normalizeInlineCueText(input.trackLabel);
  const searchQuery = normalizeInlineCueText(input.searchQuery);
  const hasTranslation = input.cues.some((cue) =>
    Boolean(normalizeInlineCueText(cue.translation)),
  );
  const cueLines = input.cues
    .map((cue) => buildCueMarkdownLine(cleanVideoId, cue, input.viewMode))
    .filter((line): line is string => Boolean(line));

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(cleanVideoId)}`;
  const modeLabel = describeViewMode(input.viewMode, hasTranslation);
  const exportedAtLabel = formatExportTimestamp(input.exportedAt ?? new Date());

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
  metaLines.push(`> - **字幕模式**：${modeLabel}（共 ${cueLines.length} 条）`);
  if (searchQuery) {
    metaLines.push(`> - **筛选关键词**：\`${searchQuery.replace(/`/g, "'")}\``);
  }
  metaLines.push(`> - **导出时间**：${exportedAtLabel}`);

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

  const markdown = [
    `# ${headingTitle}`,
    '',
    ...metaLines,
    '',
    '## 带时间戳字幕',
    '',
    ...cueLines,
    '',
  ].join('\n');

  return {
    title,
    category: DEFAULT_TRANSCRIPT_KNOWLEDGE_CATEGORY,
    tags,
    markdown,
    cueCount: cueLines.length,
  };
}
