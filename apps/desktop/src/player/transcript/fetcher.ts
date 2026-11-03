import { loadYouTubeLibrary } from '../../youtube-native';
import { proxiedFetch } from '../../youtube-proxy';
import {
  alignBilingualCues,
  extractCaptionTracksFromHtml,
  parseYouTubeJson3,
  parseYouTubeTimedTextList,
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

interface NormalizedTrack {
  id: string;
  baseUrl: string;
  languageCode: string;
  name: string;
  isTranslatable: boolean;
  isDefault: boolean;
}

function normalizeRawTrack(t: any, index: number): NormalizedTrack | null {
  const baseUrl = t.baseUrl || t.base_url;
  if (!baseUrl) return null;
  const langCode = t.languageCode || t.language_code || 'en';
  let nameText = langCode;
  if (typeof t.name === 'string') {
    nameText = t.name;
  } else if (t.name?.simpleText) {
    nameText = t.name.simpleText;
  } else if (Array.isArray(t.name?.runs) && t.name.runs.length > 0) {
    nameText = t.name.runs.map((r: any) => r.text || '').join('');
  } else if (t.name?.text) {
    nameText = t.name.text;
  }
  return {
    id: `track-${index}-${langCode}`,
    baseUrl,
    languageCode: langCode,
    name: nameText,
    isTranslatable: Boolean(t.isTranslatable ?? t.is_translatable ?? true),
    isDefault: index === 0,
  };
}

async function tryFetchCuesFromBaseUrl(
  baseUrl: string,
  preferredLang: string,
  isChinese: boolean,
  isTranslatable: boolean,
): Promise<TranscriptCue[]> {
  try {
    const json3Url = baseUrl.includes('fmt=')
      ? baseUrl
      : `${baseUrl}&fmt=json3`;
    const resp = await proxiedFetch(json3Url);
    if (!resp.ok) return [];

    const text = await resp.text();
    let cues: TranscriptCue[] = [];
    try {
      cues = parseYouTubeJson3(JSON.parse(text));
    } catch {
      cues = parseYouTubeXml(text);
    }

    if (cues.length === 0) return [];

    // If primary language is not Chinese, fetch auto-translated track to enable bilingual display
    if (!isChinese && isTranslatable) {
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
        // Translation is optional enhancement
      }
    }

    return cues;
  } catch (err) {
    console.warn('[Transcript] tryFetchCuesFromBaseUrl failed:', err);
    return [];
  }
}

export async function fetchVideoTranscript(
  videoId: string,
  preferredLang = 'zh-Hans',
): Promise<TranscriptResult> {
  const cached = getCached(videoId);
  if (cached) return cached;

  let encounteredBotCheck = false;
  let lastError: Error | null = null;

  // ---------------------------------------------------------------------------
  // Strategy 1: Direct YouTube Watch Page HTML
  // Extracts captionTracks embedded in initial ytInitialPlayerResponse.
  // This bypasses InnerTube Player API bot detection checks completely!
  // ---------------------------------------------------------------------------
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&bpctr=9999999999&has_verified=1`;
    const pageResp = await proxiedFetch(watchUrl, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });

    if (pageResp.ok) {
      const html = await pageResp.text();
      if (
        html.includes('BotGuard') ||
        html.includes('botCheck') ||
        html.includes('before you continue')
      ) {
        encounteredBotCheck = true;
      }

      const extracted = extractCaptionTracksFromHtml(html);
      if (extracted.length > 0) {
        const tracks: TranscriptTrack[] = extracted.map((t, idx) => ({
          id: `html-track-${idx}-${t.languageCode}`,
          languageCode: t.languageCode,
          name: t.name,
          isTranslatable: t.isTranslatable,
          isDefault: idx === 0,
        }));

        let selIdx = extracted.findIndex((t) =>
          t.languageCode.toLowerCase().startsWith('zh'),
        );
        if (selIdx === -1) {
          selIdx = extracted.findIndex((t) =>
            t.languageCode.toLowerCase().startsWith('en'),
          );
        }
        if (selIdx === -1) selIdx = 0;

        const primary = extracted[selIdx];
        const isZh = primary.languageCode.toLowerCase().startsWith('zh');
        const cues = await tryFetchCuesFromBaseUrl(
          primary.baseUrl,
          preferredLang,
          isZh,
          primary.isTranslatable,
        );

        if (cues.length > 0) {
          const result: TranscriptResult = {
            videoId,
            tracks,
            activeTrackId: tracks[selIdx].id,
            cues,
          };
          setCache(videoId, result);
          return result;
        }
      }
    }
  } catch (err) {
    console.warn('[Transcript] Strategy 1 (watch page) failed:', err);
  }

  // ---------------------------------------------------------------------------
  // Strategy 2: Public TimedText List probe
  // Calls public https://www.youtube.com/api/timedtext?v=...&type=list
  // ---------------------------------------------------------------------------
  try {
    const listUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&type=list`;
    const listResp = await proxiedFetch(listUrl);
    if (listResp.ok) {
      const xml = await listResp.text();
      const timedTracks = parseYouTubeTimedTextList(xml);
      if (timedTracks.length > 0) {
        const tracks: TranscriptTrack[] = timedTracks.map((t) => ({
          id: t.id,
          languageCode: t.langCode,
          name: t.name,
          isTranslatable: true,
          isDefault: t.isDefault,
        }));

        let selIdx = timedTracks.findIndex((t) =>
          t.langCode.toLowerCase().startsWith('zh'),
        );
        if (selIdx === -1) {
          selIdx = timedTracks.findIndex((t) =>
            t.langCode.toLowerCase().startsWith('en'),
          );
        }
        if (selIdx === -1) selIdx = 0;

        const primary = timedTracks[selIdx];
        const baseUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(primary.langCode)}`;
        const isZh = primary.langCode.toLowerCase().startsWith('zh');
        const cues = await tryFetchCuesFromBaseUrl(
          baseUrl,
          preferredLang,
          isZh,
          true,
        );

        if (cues.length > 0) {
          const result: TranscriptResult = {
            videoId,
            tracks,
            activeTrackId: tracks[selIdx].id,
            cues,
          };
          setCache(videoId, result);
          return result;
        }
      }
    }
  } catch (err) {
    console.warn('[Transcript] Strategy 2 (timedtext list) failed:', err);
  }

  // ---------------------------------------------------------------------------
  // Strategy 3 & 4: InnerTube with Multi-Client (ANDROID -> WEB)
  // ANDROID client doesn't require Web BotGuard / PO Token challenges!
  // ---------------------------------------------------------------------------
  try {
    const library = await loadYouTubeLibrary();
    const clientsToTry: Array<'ANDROID' | 'WEB'> = ['ANDROID', 'WEB'];

    for (const clientType of clientsToTry) {
      try {
        const clientConfig = (library.Constants.CLIENTS as any)[clientType];
        const innertube = await library.Innertube.create({
          retrieve_innertube_config: false,
          fetch: proxiedFetch as unknown as typeof fetch,
          client_type: clientConfig?.NAME || clientType,
          user_agent: clientConfig?.USER_AGENT,
        });

        const info = await innertube.getInfo(videoId);
        const playability = (info as any)?.playability_status;
        if (
          playability?.status === 'LOGIN_REQUIRED' ||
          playability?.reason?.includes('bot')
        ) {
          encounteredBotCheck = true;
        }

        // Direct caption tracks on info.captions
        const rawTracksList = (info as any)?.captions?.caption_tracks ?? [];
        if (Array.isArray(rawTracksList) && rawTracksList.length > 0) {
          const normalized = rawTracksList
            .map((t: any, idx: number) => normalizeRawTrack(t, idx))
            .filter((t): t is NormalizedTrack => Boolean(t));

          if (normalized.length > 0) {
            const tracks: TranscriptTrack[] = normalized.map((t) => ({
              id: t.id,
              languageCode: t.languageCode,
              name: t.name,
              isTranslatable: t.isTranslatable,
              isDefault: t.isDefault,
            }));

            let selIdx = normalized.findIndex((t) =>
              t.languageCode.toLowerCase().startsWith('zh'),
            );
            if (selIdx === -1) {
              selIdx = normalized.findIndex((t) =>
                t.languageCode.toLowerCase().startsWith('en'),
              );
            }
            if (selIdx === -1) selIdx = 0;

            const primary = normalized[selIdx];
            const isZh = primary.languageCode.toLowerCase().startsWith('zh');
            const cues = await tryFetchCuesFromBaseUrl(
              primary.baseUrl,
              preferredLang,
              isZh,
              primary.isTranslatable,
            );

            if (cues.length > 0) {
              const result: TranscriptResult = {
                videoId,
                tracks,
                activeTrackId: tracks[selIdx].id,
                cues,
              };
              setCache(videoId, result);
              return result;
            }
          }
        }

        // Fallback: try info.getTranscript()
        try {
          const transcriptInfo = await (info as any).getTranscript?.();
          const segments =
            transcriptInfo?.transcript?.content?.body?.initial_segments ?? [];
          if (segments.length > 0) {
            const cues: TranscriptCue[] = segments.map(
              (seg: any, idx: number) => {
                const start = (parseFloat(seg.start_ms || '0') || 0) / 1000;
                const end =
                  (parseFloat(seg.end_ms || '0') || start + 2000) / 1000;
                return {
                  id: `cue-${idx}`,
                  start: Math.round(start * 100) / 100,
                  end: Math.round(end * 100) / 100,
                  text: seg.snippet?.text || '',
                };
              },
            );

            const result: TranscriptResult = {
              videoId,
              tracks: [{ id: 'auto', languageCode: 'auto', name: '自动生成' }],
              activeTrackId: 'auto',
              cues,
            };
            setCache(videoId, result);
            return result;
          }
        } catch {
          // getTranscript optional fallback
        }
      } catch (clientErr) {
        const msg =
          clientErr instanceof Error ? clientErr.message : String(clientErr);
        if (
          msg.includes('400') ||
          msg.includes('BotGuard') ||
          msg.includes('LOGIN_REQUIRED')
        ) {
          encounteredBotCheck = true;
        }
        lastError = clientErr instanceof Error ? clientErr : new Error(msg);
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
  }

  // ---------------------------------------------------------------------------
  // If all strategies failed, report explicit status rather than pretending empty
  // ---------------------------------------------------------------------------
  if (encounteredBotCheck) {
    throw new Error(
      '当前网络出口被 YouTube 风控限制 (BotGuard)，无法提取台词；建议切换网络节点后点击重新检测',
    );
  }

  if (lastError) {
    throw lastError;
  }

  // Reached YouTube cleanly and confirmed video has no caption tracks
  return {
    videoId,
    tracks: [],
    activeTrackId: null,
    cues: [],
  };
}
