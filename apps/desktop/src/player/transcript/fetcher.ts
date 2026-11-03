import { loadYouTubeLibrary } from '../../youtube-native';
import { proxiedFetch } from '../../youtube-proxy';
import {
  alignBilingualCues,
  parseYouTubeJson3,
  parseYouTubeXml,
} from './parser';
import type { TranscriptCue, TranscriptResult, TranscriptTrack } from './types';

const CACHE_PREFIX = 'seamind:transcript:v1:';

function getCached(videoId: string): TranscriptResult | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${videoId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TranscriptResult;
    if (parsed && Array.isArray(parsed.cues) && parsed.cues.length > 0) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function setCache(videoId: string, data: TranscriptResult): void {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${videoId}`, JSON.stringify(data));
  } catch {
    // ignore quota errors
  }
}

interface RawCaptionTrack {
  baseUrl?: string;
  base_url?: string;
  name?: { text?: string } | string;
  languageCode?: string;
  language_code?: string;
  kind?: string;
  isTranslatable?: boolean;
  is_translatable?: boolean;
}

export async function fetchVideoTranscript(
  videoId: string,
  preferredLang = 'zh-Hans',
): Promise<TranscriptResult> {
  const cached = getCached(videoId);
  if (cached) return cached;

  const library = await loadYouTubeLibrary();
  const innertube = await library.Innertube.create({
    retrieve_innertube_config: false,
    fetch: proxiedFetch as unknown as typeof fetch,
  });

  const info = await innertube.getInfo(videoId);
  const captions = (
    info as unknown as { captions?: { caption_tracks?: RawCaptionTrack[] } }
  )?.captions;
  const rawTracks = captions?.caption_tracks ?? [];

  const tracks: TranscriptTrack[] = rawTracks.map((t, index) => {
    const langCode = t.languageCode || t.language_code || 'en';
    const nameText =
      typeof t.name === 'string' ? t.name : t.name?.text || langCode;
    return {
      id: `track-${index}-${langCode}`,
      languageCode: langCode,
      name: nameText,
      isTranslatable: Boolean(t.isTranslatable ?? t.is_translatable),
      isDefault: index === 0,
    };
  });

  // Try method 1: fetch from caption track URL
  if (rawTracks.length > 0) {
    // Prefer user preferred language, or English, or first available track
    let selectedIndex = rawTracks.findIndex((t) => {
      const code = (t.languageCode || t.language_code || '').toLowerCase();
      return code.startsWith('zh') || code.includes('chinese');
    });

    if (selectedIndex === -1) {
      selectedIndex = rawTracks.findIndex((t) => {
        const code = (t.languageCode || t.language_code || '').toLowerCase();
        return code.startsWith('en');
      });
    }

    if (selectedIndex === -1) selectedIndex = 0;

    const primaryTrack = rawTracks[selectedIndex];
    const baseUrl = primaryTrack.baseUrl || primaryTrack.base_url;

    if (baseUrl) {
      try {
        const json3Url = baseUrl.includes('fmt=')
          ? baseUrl
          : `${baseUrl}&fmt=json3`;
        const resp = await proxiedFetch(json3Url);
        let cues: TranscriptCue[] = [];

        if (resp.ok) {
          const text = await resp.text();
          try {
            cues = parseYouTubeJson3(JSON.parse(text));
          } catch {
            cues = parseYouTubeXml(text);
          }
        }

        if (cues.length > 0) {
          const isChinese = (
            primaryTrack.languageCode ||
            primaryTrack.language_code ||
            ''
          )
            .toLowerCase()
            .startsWith('zh');

          // If primary is not Chinese, fetch auto-translated Chinese subtitles for bilingual display!
          if (
            !isChinese &&
            (primaryTrack.isTranslatable ??
              primaryTrack.is_translatable ??
              true)
          ) {
            try {
              const transUrl = `${baseUrl}&fmt=json3&tlang=${encodeURIComponent(preferredLang)}`;
              const transResp = await proxiedFetch(transUrl);
              if (transResp.ok) {
                const transText = await transResp.text();
                let transCues: TranscriptCue[] = [];
                try {
                  transCues = parseYouTubeJson3(JSON.parse(transText));
                } catch {
                  transCues = parseYouTubeXml(transText);
                }
                if (transCues.length > 0) {
                  cues = alignBilingualCues(cues, transCues);
                }
              }
            } catch {
              // translation optional
            }
          }

          const result: TranscriptResult = {
            videoId,
            tracks,
            activeTrackId: tracks[selectedIndex]?.id || tracks[0]?.id || null,
            cues,
          };
          setCache(videoId, result);
          return result;
        }
      } catch (err) {
        console.warn(
          'Timedtext fetch failed, trying getTranscript fallback',
          err,
        );
      }
    }
  }

  // Try method 2: innertube.getTranscript()
  try {
    const transcriptInfo = await (
      info as unknown as {
        getTranscript?: () => Promise<{
          transcript?: {
            content?: {
              body?: {
                initial_segments?: Array<{
                  start_ms?: string;
                  end_ms?: string;
                  snippet?: { text?: string };
                }>;
              };
            };
          };
        }>;
      }
    ).getTranscript?.();

    const segments =
      transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
    if (segments.length > 0) {
      const cues: TranscriptCue[] = segments.map((seg, idx) => {
        const start = (parseFloat(seg.start_ms || '0') || 0) / 1000;
        const end = (parseFloat(seg.end_ms || '0') || start + 2000) / 1000;
        return {
          id: `cue-${idx}`,
          start: Math.round(start * 100) / 100,
          end: Math.round(end * 100) / 100,
          text: seg.snippet?.text || '',
        };
      });

      const result: TranscriptResult = {
        videoId,
        tracks: tracks.length
          ? tracks
          : [{ id: 'auto', languageCode: 'auto', name: '自动生成' }],
        activeTrackId: tracks[0]?.id || 'auto',
        cues,
      };
      setCache(videoId, result);
      return result;
    }
  } catch (err) {
    console.warn('innertube.getTranscript failed', err);
  }

  return {
    videoId,
    tracks,
    activeTrackId: null,
    cues: [],
  };
}
