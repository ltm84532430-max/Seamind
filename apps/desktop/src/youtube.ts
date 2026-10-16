import type { PureNode } from 'markmap-lib';

const videoIdPattern = /^[\w-]{11}$/;
const youtubeHosts = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]);
const urlPattern = /https?:\/\/[^\s<>"']+/gi;
const trailingUrlPunctuation = /[),.;!?，。！？）】》]+$/u;
const thumbnailQualities = ['maxresdefault', 'sddefault', 'hqdefault'] as const;

interface YouTubeVideo {
  id: string;
  title: string;
}

function parseYouTubeVideoUrl(value: string): string | null {
  let candidate = value.trim();
  while (trailingUrlPunctuation.test(candidate))
    candidate = candidate.slice(0, -1);

  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || !youtubeHosts.has(host))
      return null;

    let id: string | null = null;
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      id = url.pathname.split('/').filter(Boolean)[0] ?? null;
    } else if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
      id = match?.[1] ?? null;
    }
    return id && videoIdPattern.test(id) ? id : null;
  } catch {
    return null;
  }
}

function findYouTubeVideo(content: string): YouTubeVideo | null {
  const document = new DOMParser().parseFromString(content, 'text/html');
  const candidates = new Map<string, string>();

  document.body
    .querySelectorAll<HTMLAnchorElement>('a[href]')
    .forEach((anchor) => {
      const id = parseYouTubeVideoUrl(anchor.href);
      if (id) candidates.set(id, anchor.textContent?.trim() || '');
    });

  const visibleText = document.body.textContent ?? '';
  for (const candidate of visibleText.match(urlPattern) ?? []) {
    const id = parseYouTubeVideoUrl(candidate);
    if (id && !candidates.has(id)) candidates.set(id, '');
  }

  if (candidates.size !== 1) return null;
  const entry = candidates.entries().next().value;
  if (!entry) return null;
  const [id, linkTitle] = entry;
  const titleFromText = visibleText
    .replace(urlPattern, ' ')
    .replace(/[\s|·•—–-]+/g, ' ')
    .trim();
  const title = (titleFromText || linkTitle || 'YouTube 视频').slice(0, 120);
  return { id, title };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function videoCardMarkup(video: YouTubeVideo): string {
  const title = escapeHtml(video.title);
  const initialThumbnail = thumbnailQualities[0];
  return `<button type="button" class="seamind-youtube-card" data-seamind-youtube-card="true" data-seamind-youtube-id="${video.id}" data-seamind-youtube-title="${title}" aria-label="播放 YouTube 视频：${title}"><span class="seamind-youtube-thumbnail"><img class="seamind-youtube-thumbnail-image" data-seamind-youtube-thumbnail="true" data-seamind-youtube-id="${video.id}" data-seamind-youtube-quality="0" src="https://i.ytimg.com/vi/${video.id}/${initialThumbnail}.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="seamind-youtube-play-icon" aria-hidden="true">▶</span></span><span class="seamind-youtube-details"><strong title="${title}">${title}</strong><span>点击打开播放器</span></span></button>`;
}

export function prepareYouTubeCards(node: PureNode): PureNode {
  const video = findYouTubeVideo(node.content);
  return {
    ...node,
    content: video ? videoCardMarkup(video) : node.content,
    payload: video
      ? {
          ...node.payload,
          seamindCard: 'youtube',
          seamindVideoId: video.id,
          seamindVideoTitle: video.title,
        }
      : node.payload,
    children: node.children.map(prepareYouTubeCards),
  };
}

export function nextYouTubeThumbnail(
  videoId: string,
  currentQuality: number,
): { src: string; quality: number } | null {
  if (!videoIdPattern.test(videoId)) return null;
  const quality = currentQuality + 1;
  const name = thumbnailQualities[quality];
  if (!name) return null;
  return {
    src: `https://i.ytimg.com/vi/${videoId}/${name}.jpg`,
    quality,
  };
}

export function buildYouTubeEmbedUrl(videoId: string): string | null {
  if (!videoIdPattern.test(videoId)) return null;
  const url = new URL(`https://www.youtube.com/embed/${videoId}`);
  url.searchParams.set('playsinline', '1');
  url.searchParams.set('rel', '0');
  return url.toString();
}
