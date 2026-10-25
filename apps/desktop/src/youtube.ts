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
  startSeconds: number;
}

function parseYouTubeStartTime(value: string | null): number {
  if (!value) return 0;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) ? seconds : 0;
  }
  const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || !match.slice(1).some(Boolean)) return 0;
  const seconds =
    Number(match[1] || 0) * 3600 +
    Number(match[2] || 0) * 60 +
    Number(match[3] || 0);
  return Number.isSafeInteger(seconds) ? seconds : 0;
}

function parseYouTubeVideoUrl(
  value: string,
): { id: string; startSeconds: number } | null {
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
    if (!id || !videoIdPattern.test(id)) return null;
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    const startSeconds = parseYouTubeStartTime(
      url.searchParams.get('t') ||
        url.searchParams.get('start') ||
        hashParams.get('t'),
    );
    return { id, startSeconds };
  } catch {
    return null;
  }
}

export function parseYouTubeEmbedInput(
  value: string,
): { id: string; startSeconds: number } | null {
  const input = value.trim();
  if (!input) return null;

  let candidate = input;
  if (/<\s*iframe\b/i.test(input)) {
    const document = new DOMParser().parseFromString(input, 'text/html');
    const iframes = document.querySelectorAll('iframe');
    if (iframes.length !== 1) return null;
    const iframe = iframes[0];
    if (!iframe || iframe.hasAttribute('srcdoc')) return null;
    candidate = iframe.getAttribute('src')?.trim() || '';
  }

  return candidate ? parseYouTubeVideoUrl(candidate) : null;
}

function findYouTubeVideo(content: string): YouTubeVideo | null {
  const document = new DOMParser().parseFromString(content, 'text/html');
  const candidates = new Map<string, { title: string; startSeconds: number }>();

  document.body
    .querySelectorAll<HTMLAnchorElement>('a[href]')
    .forEach((anchor) => {
      const video = parseYouTubeVideoUrl(anchor.href);
      if (video)
        candidates.set(video.id, {
          title: anchor.textContent?.trim() || '',
          startSeconds: video.startSeconds,
        });
    });

  const visibleText = document.body.textContent ?? '';
  for (const candidate of visibleText.match(urlPattern) ?? []) {
    const video = parseYouTubeVideoUrl(candidate);
    if (video && !candidates.has(video.id))
      candidates.set(video.id, { title: '', startSeconds: video.startSeconds });
  }

  if (candidates.size !== 1) return null;
  const entry = candidates.entries().next().value;
  if (!entry) return null;
  const [id, candidate] = entry;
  const titleFromText = visibleText
    .replace(urlPattern, ' ')
    .replace(/[\s|·•—–-]+/g, ' ')
    .trim();
  const title = (titleFromText || candidate.title || 'YouTube 视频').slice(
    0,
    120,
  );
  return { id, title, startSeconds: candidate.startSeconds };
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
  return `<button type="button" class="seamind-youtube-card" data-seamind-youtube-card="true" data-seamind-youtube-id="${video.id}" data-seamind-youtube-title="${title}" data-seamind-youtube-start="${video.startSeconds}" aria-label="播放 YouTube 视频：${title}"><span class="seamind-youtube-thumbnail"><img class="seamind-youtube-thumbnail-image" data-seamind-youtube-thumbnail="true" data-seamind-youtube-id="${video.id}" data-seamind-youtube-quality="0" src="https://i.ytimg.com/vi/${video.id}/${initialThumbnail}.jpg" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="seamind-youtube-play-icon" aria-hidden="true">▶</span></span><span class="seamind-youtube-details"><strong title="${title}">${title}</strong><span>点击打开播放器</span></span></button>`;
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

export function buildYouTubeEmbedUrl(
  videoId: string,
  startSeconds = 0,
  options: { autoplay?: boolean } = {},
): string | null {
  if (!videoIdPattern.test(videoId)) return null;
  const url = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
  url.searchParams.set('playsinline', '1');
  url.searchParams.set('rel', '0');
  url.searchParams.set('enablejsapi', '1');
  url.searchParams.set('widget_referrer', 'https://www.youtube.com');
  if (
    typeof window !== 'undefined' &&
    window.location.origin &&
    window.location.origin !== 'null'
  ) {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    const isLocalTauri =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      protocol === 'tauri:' ||
      protocol === 'file:';
    if (!isLocalTauri) {
      url.searchParams.set('origin', window.location.origin);
    }
  }
  if (Number.isSafeInteger(startSeconds) && startSeconds > 0)
    url.searchParams.set('start', String(Math.floor(startSeconds)));
  if (options.autoplay) url.searchParams.set('autoplay', '1');
  return url.toString();
}
