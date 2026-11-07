//! Hidden WebView2 YouTube embed caption extractor.
//!
//! When a user's VPN/proxy exit triggers `HTTP 429` or `LOGIN_REQUIRED` on `reqwest` `/watch` and
//! mobile InnerTube requests, YouTube's official embed player inside Seamind's own Chromium
//! WebView2 (`youtube-nocookie.com/embed/<videoId>`) still loads normally and mints its own
//! `timedtext` PO tokens via `base.js`. This module runs that embed flow silently in a hidden
//! WebView2 window without reading any external browser cookies.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    webview::PageLoadEvent, AppHandle, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tokio::sync::{oneshot, watch, Mutex};
use uuid::Uuid;

use crate::player_store::is_video_id;
use crate::youtube_net::default_user_agent;
use crate::youtube_transcript::{
    reply, TranscriptFailure, TranscriptReply, TranscriptTrack, TranslationLanguage,
};

const HOST_URLS: [&str; 2] = [
    "https://www.youtube-nocookie.com/robots.txt",
    "https://www.youtube.com/robots.txt",
];
const PAGE_LOAD_TIMEOUT: Duration = Duration::from_secs(12);
const EMBED_CAPTURE_TIMEOUT: Duration = Duration::from_secs(16);
const WATCH_FALLBACK_TIMEOUT: Duration = Duration::from_secs(10);
const EVAL_TIMEOUT: Duration = Duration::from_secs(8);
const POLL_INTERVAL: Duration = Duration::from_millis(150);

const EMBED_CAPTURE_SCRIPT: &str = r#"
(() => {
  const { protocol, hostname, pathname } = window.location;
  const isYoutubeLike =
    protocol === 'https:' &&
    (hostname === 'youtube.com' ||
      hostname.endsWith('.youtube.com') ||
      hostname === 'youtube-nocookie.com' ||
      hostname.endsWith('.youtube-nocookie.com') ||
      hostname === 'google.com' ||
      hostname.endsWith('.google.com'));
  if (!isYoutubeLike) return;

  function isTrustedOrigin(origin) {
    try {
      const u = new URL(origin);
      const h = u.hostname;
      return (
        u.protocol === 'https:' &&
        (h === 'youtube.com' ||
          h.endsWith('.youtube.com') ||
          h === 'youtube-nocookie.com' ||
          h.endsWith('.youtube-nocookie.com') ||
          h === 'google.com' ||
          h.endsWith('.google.com'))
      );
    } catch {
      return false;
    }
  }

  // Top-level host page (/robots.txt) orchestrates the hidden embed iframe and collects postMessage results.
  if (window.self === window.top && pathname === '/robots.txt') {
    let activeRequestId = null;
    window.__seamindEmbedResult = null;

    window.addEventListener('message', (event) => {
      if (!isTrustedOrigin(event.origin)) return;
      const data = event.data;
      if (!data || data.__seamindEmbedCaption !== true) return;
      if (!activeRequestId || data.requestId !== activeRequestId) return;
      window.__seamindEmbedResult = data.result;
    });

    window.__seamindStartEmbedCapture = (req) => {
      activeRequestId = req.requestId;
      window.__seamindEmbedResult = null;

      let head = document.head;
      if (!head) {
        head = document.createElement('head');
        document.documentElement.prepend(head);
      }
      let meta = head.querySelector('meta[name="referrer"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'referrer');
        head.appendChild(meta);
      }
      meta.setAttribute('content', 'origin');

      let body = document.body;
      if (!body) {
        body = document.createElement('body');
        document.documentElement.appendChild(body);
      }
      body.replaceChildren();

      const preferredBase = String(req.preferredLang || 'en').split(/[-_]/)[0] || 'en';
      const iframe = document.createElement('iframe');
      iframe.name = JSON.stringify({ __seamindEmbedReq: req });
      iframe.allow =
        'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share';
      iframe.referrerPolicy = 'origin';
      iframe.style.cssText =
        'width:1280px;height:720px;border:0;opacity:0;pointer-events:none;position:fixed;left:0;top:0;';
      const embedHost =
        hostname === 'youtube-nocookie.com' || hostname.endsWith('.youtube-nocookie.com')
          ? 'https://www.youtube-nocookie.com'
          : 'https://www.youtube.com';
      const embedUrl = new URL(`${embedHost}/embed/${encodeURIComponent(req.videoId)}`);
      embedUrl.searchParams.set('playsinline', '1');
      embedUrl.searchParams.set('rel', '0');
      embedUrl.searchParams.set('enablejsapi', '1');
      embedUrl.searchParams.set('autoplay', '1');
      embedUrl.searchParams.set('mute', '1');
      embedUrl.searchParams.set('cc_load_policy', '1');
      embedUrl.searchParams.set('cc_lang_pref', preferredBase);
      embedUrl.searchParams.set('hl', 'en');
      embedUrl.searchParams.set('widget_referrer', 'https://www.youtube.com');
      iframe.src = embedUrl.toString();
      body.appendChild(iframe);
      return { started: true };
    };

    window.__seamindStartWatchFallback = (req) => {
      activeRequestId = req.requestId;
      window.__seamindEmbedResult = null;
      window.name = JSON.stringify({ __seamindEmbedReq: req });
      window.location.replace(
        `https://www.youtube.com/watch?v=${encodeURIComponent(req.videoId)}&hl=en`,
      );
      return { started: true };
    };
    return;
  }

  // Parse request context passed via window.name (for both child embed iframe and top-level /watch fallback).
  let req = null;
  try {
    if (typeof window.name === 'string' && window.name.includes('__seamindEmbedReq')) {
      const parsed = JSON.parse(window.name);
      if (parsed && parsed.__seamindEmbedReq && parsed.__seamindEmbedReq.requestId) {
        req = parsed.__seamindEmbedReq;
      }
    }
  } catch {}
  if (!req || !req.videoId || !req.requestId) return;

  let settled = false;
  function publish(result) {
    if (settled) return;
    settled = true;
    try {
      document.querySelectorAll('video, audio').forEach((media) => {
        try {
          media.muted = true;
          media.volume = 0;
          media.pause();
        } catch {}
      });
      const player = document.getElementById('movie_player');
      if (player && typeof player.pauseVideo === 'function') {
        player.pauseVideo();
      }
    } catch {}

    const payload = { requestId: req.requestId, ...result };
    if (window.self === window.top) {
      window.__seamindEmbedResult = payload;
    } else {
      try {
        window.top.postMessage(
          {
            __seamindEmbedCaption: true,
            requestId: req.requestId,
            result: payload,
          },
          '*',
        );
      } catch {}
    }
  }

  // Detect Google bot-check redirect immediately.
  if (
    (hostname === 'google.com' || hostname.endsWith('.google.com')) &&
    pathname.startsWith('/sorry')
  ) {
    publish({
      ok: false,
      code: 'requestBlocked',
      message: 'YouTube 要求验证当前字幕请求。',
    });
    return;
  }

  // Strict silence guard so hidden playback never emits sound.
  const silenceMedia = (target) => {
    if (target && typeof target === 'object' && 'muted' in target) {
      try {
        target.muted = true;
        target.defaultMuted = true;
        target.volume = 0;
      } catch {}
    }
  };
  if (typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.prototype) {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      silenceMedia(this);
      return origPlay.apply(this, args);
    };
  }
  for (const evt of ['play', 'playing', 'loadedmetadata', 'volumechange']) {
    document.addEventListener(
      evt,
      (event) => {
        silenceMedia(event.target);
      },
      true,
    );
  }

  const origFetch = window.fetch.bind(window);
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  function normalizeLang(value) {
    return String(value || '')
      .replace(/_/g, '-')
      .toLowerCase();
  }

  function sameLanguage(left, right) {
    const a = normalizeLang(left);
    const b = normalizeLang(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const baseA = a.split('-')[0];
    const baseB = b.split('-')[0];
    if (baseA !== baseB) return false;
    if (baseA === 'zh') {
      const tradA = a.includes('hant') || a.includes('tw') || a.includes('hk');
      const tradB = b.includes('hant') || b.includes('tw') || b.includes('hk');
      return tradA === tradB;
    }
    return true;
  }

  function languageRank(code, preferred) {
    const normCode = normalizeLang(code);
    const normPref = normalizeLang(preferred);
    if (normCode === normPref) return 0;
    if (sameLanguage(normCode, normPref)) return 1;
    if (normCode.split('-')[0] === 'en') return 2;
    return 3;
  }

  function nameOf(value, fallback) {
    if (value && typeof value.simpleText === 'string' && value.simpleText) {
      return value.simpleText;
    }
    if (value && Array.isArray(value.runs)) {
      const joined = value.runs
        .map((r) => (r && typeof r.text === 'string' ? r.text : ''))
        .join('');
      if (joined) return joined;
    }
    return fallback;
  }

  function hasValidCaptionPayload(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        return (
          Array.isArray(parsed.events) &&
          parsed.events.some(
            (ev) =>
              ev &&
              Array.isArray(ev.segs) &&
              ev.segs.some((s) => typeof s?.utf8 === 'string' && s.utf8.trim().length > 0),
          )
        );
      } catch {
        return false;
      }
    }
    if (/^WEBVTT(?:\s|$)/i.test(trimmed)) {
      return trimmed.includes('-->');
    }
    if (
      trimmed.startsWith('<') &&
      !/^<!doctype\s+html/i.test(trimmed) &&
      !/^<html/i.test(trimmed)
    ) {
      return trimmed.includes('<text') || trimmed.includes('<p');
    }
    return false;
  }

  function requiresPoToken(baseUrl) {
    try {
      const u = new URL(baseUrl, window.location.origin);
      return u.searchParams.get('exp') === 'xpe';
    } catch {
      return false;
    }
  }

  function classifyPlayabilityFailure(playability) {
    if (!playability || typeof playability !== 'object') return null;
    const status = String(playability.status || '');
    if (!status || status === 'OK') return null;
    const reason = String(playability.reason || '');
    const lower = reason.toLowerCase();
    if (
      status === 'AGE_CHECK_REQUIRED' ||
      status === 'CONTENT_CHECK_REQUIRED' ||
      lower.includes('confirm your age') ||
      lower.includes('age-restricted') ||
      lower.includes('inappropriate for some users') ||
      reason.includes('年龄')
    ) {
      return { code: 'ageRestricted', message: '年龄限制视频需要已验证的登录会话。' };
    }
    if (
      lower.includes('other websites') ||
      lower.includes('playback on other') ||
      lower.includes('embed') ||
      reason.includes('其他网站')
    ) {
      return {
        code: 'embedDisabled',
        message: reason || '视频作者禁用了内嵌播放。',
      };
    }
    if (
      status === 'LOGIN_REQUIRED' &&
      (lower.includes('private') ||
        lower.includes('members-only') ||
        lower.includes('members only') ||
        reason.includes('私享') ||
        reason.includes('私人') ||
        reason.includes('会员'))
    ) {
      return { code: 'videoUnavailable', message: '视频当前不可访问，无法取得字幕轨道。' };
    }
    if (
      status === 'LOGIN_REQUIRED' ||
      lower.includes('not a bot') ||
      lower.includes('unusual traffic') ||
      lower.includes('sign in to confirm') ||
      reason.includes('不是机器人') ||
      reason.includes('异常流量')
    ) {
      return {
        code: 'requestBlocked',
        message: 'YouTube 要求先完成真人验证，当前无法取得字幕轨道。',
      };
    }
    return { code: 'videoUnavailable', message: '视频当前不可访问，无法取得字幕轨道。' };
  }

  let catalog = null;
  let observedPot = null;
  let observedPotc = null;
  let observedSignedUrl = null;
  const observedBodies = [];
  let noTracksObservedAt = 0;
  let firstTimedtextObservedAt = 0;
  let targetLangHint = req.preferredLang || 'zh-Hans';
  let extracting = false;
  let pendingRetry = false;
  const startedAt = Date.now();

  function chooseTrack(tracks, preferredLang, requestedTrackId) {
    if (requestedTrackId) {
      const exact = tracks.find((item) => item.public.id === requestedTrackId);
      if (exact) return exact;
      const parts = String(requestedTrackId).split(':');
      if (parts.length >= 3) {
        const reqLang = parts[1];
        const reqGen = parts[2] === 'auto';
        const matched = tracks.find(
          (item) =>
            sameLanguage(item.public.languageCode, reqLang) &&
            item.public.isGenerated === reqGen,
        );
        if (matched) return matched;
      }
    }
    return [...tracks].sort((a, b) => {
      const rankDiff =
        languageRank(a.public.languageCode, preferredLang) -
        languageRank(b.public.languageCode, preferredLang);
      if (rankDiff !== 0) return rankDiff;
      if (a.public.isGenerated !== b.public.isGenerated) {
        return a.public.isGenerated ? 1 : -1;
      }
      if (a.public.isDefault !== b.public.isDefault) {
        return a.public.isDefault ? -1 : 1;
      }
      return 0;
    })[0];
  }

  async function fetchTimedtext(rawBaseUrl, params) {
    const candidates = [];
    try {
      const parsed = new URL(rawBaseUrl, window.location.origin);
      if (params.fmt) parsed.searchParams.set('fmt', params.fmt);
      if (params.pot) parsed.searchParams.set('pot', params.pot);
      if (params.potc) parsed.searchParams.set('potc', params.potc);
      if (params.tlang) parsed.searchParams.set('tlang', params.tlang);
      else parsed.searchParams.delete('tlang');

      const sameOrigin = new URL(parsed.pathname + parsed.search, window.location.origin);
      candidates.push(sameOrigin.toString());
      if (parsed.toString() !== sameOrigin.toString()) {
        candidates.push(parsed.toString());
      }
    } catch {
      return null;
    }

    for (const candidate of candidates) {
      try {
        const res = await origFetch(candidate, { credentials: 'include' });
        if (!res.ok) continue;
        const text = await res.text();
        if (hasValidCaptionPayload(text)) {
          return {
            body: text,
            contentType: res.headers.get('content-type') || 'application/json',
          };
        }
      } catch {}
    }
    return null;
  }

  async function attemptExtraction() {
    if (settled) return;
    if (extracting) {
      pendingRetry = true;
      return;
    }
    extracting = true;
    try {
      const preferredLang = req.preferredLang || 'zh-Hans';
      const desiredTrans = req.translationLang || preferredLang;

      if (catalog && catalog.tracks.length > 0) {
        const chosen = chooseTrack(catalog.tracks, preferredLang, req.trackId);
        if (chosen) {
          targetLangHint = chosen.public.languageCode;
          let primary = null;
          const cached = observedBodies.find(
            (item) =>
              sameLanguage(item.lang, chosen.public.languageCode) &&
              item.isGenerated === chosen.public.isGenerated &&
              !item.tlang,
          );
          if (cached) {
            primary = { body: cached.body, contentType: 'application/json' };
          } else if (!requiresPoToken(chosen.baseUrl) || observedPot) {
            primary = await fetchTimedtext(chosen.baseUrl, {
              fmt: 'json3',
              pot: observedPot,
              potc: observedPotc,
            });
          }

          if (primary) {
            let translationBody;
            let translationLanguage;
            const availTrans =
              catalog.translationLanguages.find(
                (item) => normalizeLang(item.languageCode) === normalizeLang(desiredTrans),
              ) ||
              catalog.translationLanguages.find((item) =>
                sameLanguage(item.languageCode, desiredTrans),
              );
            if (
              desiredTrans &&
              chosen.public.isTranslatable &&
              availTrans &&
              !sameLanguage(chosen.public.languageCode, availTrans.languageCode)
            ) {
              const translated = await fetchTimedtext(chosen.baseUrl, {
                fmt: 'json3',
                pot: observedPot,
                potc: observedPotc,
                tlang: availTrans.languageCode,
              });
              if (translated) {
                translationBody = translated.body;
                translationLanguage = availTrans.languageCode;
              }
            }

            publish({
              ok: true,
              data: {
                videoId: req.videoId,
                tracks: catalog.tracks.map((item) => item.public),
                translationLanguages: catalog.translationLanguages,
                activeTrackId: chosen.public.id,
                body: primary.body,
                contentType: primary.contentType,
                ...(translationBody ? { translationBody, translationLanguage } : {}),
              },
            });
            return;
          }
        }
      } else if (
        observedBodies.length > 0 &&
        firstTimedtextObservedAt > 0 &&
        Date.now() - firstTimedtextObservedAt >= 1200
      ) {
        const observed = observedBodies[0];
        const kind = observed.isGenerated ? 'auto' : 'manual';
        const trackId = `embed:${observed.lang}:${kind}:0`;
        let translationBody;
        let translationLanguage;
        if (
          desiredTrans &&
          observedSignedUrl &&
          !sameLanguage(observed.lang, desiredTrans)
        ) {
          const translated = await fetchTimedtext(observedSignedUrl, {
            fmt: 'json3',
            tlang: desiredTrans,
          });
          if (translated) {
            translationBody = translated.body;
            translationLanguage = desiredTrans;
          }
        }
        publish({
          ok: true,
          data: {
            videoId: req.videoId,
            tracks: [
              {
                id: trackId,
                languageCode: observed.lang,
                name: observed.lang,
                isGenerated: observed.isGenerated,
                isTranslatable: Boolean(translationBody),
                isDefault: true,
              },
            ],
            translationLanguages: [],
            activeTrackId: trackId,
            body: observed.body,
            contentType: 'application/json',
            ...(translationBody ? { translationBody, translationLanguage } : {}),
          },
        });
        return;
      }
    } finally {
      extracting = false;
      if (pendingRetry && !settled) {
        pendingRetry = false;
        void attemptExtraction();
      }
    }
  }

  function handlePlayerResponse(data) {
    if (settled || !data || typeof data !== 'object') return;
    const vid = data?.videoDetails?.videoId;
    if (typeof vid === 'string' && vid && vid !== req.videoId) return;

    const renderer = data?.captions?.playerCaptionsTracklistRenderer;
    const rawTracks = renderer?.captionTracks;
    if (Array.isArray(rawTracks) && rawTracks.length > 0) {
      const tracks = rawTracks
        .map((raw, index) => {
          if (!raw || typeof raw.baseUrl !== 'string' || !raw.baseUrl) return null;
          const languageCode = String(raw.languageCode || 'und');
          const isGenerated = raw.kind === 'asr';
          const kind = isGenerated ? 'auto' : 'manual';
          return {
            public: {
              id: `embed:${languageCode}:${kind}:${index}`,
              languageCode,
              name: nameOf(raw.name, languageCode),
              isGenerated,
              isTranslatable: Boolean(raw.isTranslatable),
              isDefault: Boolean(raw.isDefault),
            },
            baseUrl: raw.baseUrl,
          };
        })
        .filter(Boolean);
      const translationLanguages = Array.isArray(renderer?.translationLanguages)
        ? renderer.translationLanguages
            .map((item) => {
              const code = item?.languageCode;
              if (typeof code !== 'string' || !code) return null;
              return {
                languageCode: code,
                name: nameOf(item.languageName, code),
              };
            })
            .filter(Boolean)
        : [];
      if (tracks.length > 0) {
        catalog = { tracks, translationLanguages };
        noTracksObservedAt = 0;
        void attemptExtraction();
        return;
      }
    }

    const playabilityFailure = classifyPlayabilityFailure(
      data.playabilityStatus || data.previewPlayabilityStatus,
    );
    if (playabilityFailure) {
      publish({ ok: false, ...playabilityFailure });
      return;
    }

    if (
      data?.playabilityStatus?.status === 'OK' &&
      (data?.streamingData || data?.videoDetails) &&
      !catalog &&
      noTracksObservedAt === 0
    ) {
      noTracksObservedAt = Date.now();
    }
  }

  function handleTimedtextObserved(rawUrl, status, bodyText) {
    if (settled) return;
    try {
      const u = new URL(rawUrl, window.location.origin);
      const vid = u.searchParams.get('v');
      if (vid && vid !== req.videoId) return;
      const pot = u.searchParams.get('pot');
      const potc = u.searchParams.get('potc');
      if (pot) {
        observedPot = pot;
        if (potc) observedPotc = potc;
      }
      observedSignedUrl = u.toString();
      if (status >= 200 && status < 300 && hasValidCaptionPayload(bodyText)) {
        if (firstTimedtextObservedAt === 0) firstTimedtextObservedAt = Date.now();
        observedBodies.push({
          lang: u.searchParams.get('lang') || 'und',
          isGenerated: u.searchParams.get('kind') === 'asr',
          tlang: u.searchParams.get('tlang') || '',
          body: bodyText,
        });
      }
      void attemptExtraction();
    } catch {}
  }

  window.fetch = async function (input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input && typeof input.url === 'string'
            ? input.url
            : '';
    const response = await origFetch(input, init);
    try {
      if (url.includes('/youtubei/v1/player')) {
        response
          .clone()
          .json()
          .then(handlePlayerResponse)
          .catch(() => {});
      } else if (url.includes('/api/timedtext')) {
        response
          .clone()
          .text()
          .then((text) => handleTimedtextObserved(url, response.status, text))
          .catch(() => {});
      }
    } catch {}
    return response;
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__seamindUrl = typeof url === 'string' ? url : String(url ?? '');
    } catch {}
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const rawUrl = this.__seamindUrl || '';
      if (rawUrl.includes('/youtubei/v1/player') || rawUrl.includes('/api/timedtext')) {
        this.addEventListener('load', () => {
          try {
            const fullUrl = this.responseURL || rawUrl;
            const text =
              this.responseType === '' || this.responseType === 'text'
                ? this.responseText
                : this.responseType === 'json' && this.response
                  ? JSON.stringify(this.response)
                  : '';
            if (fullUrl.includes('/youtubei/v1/player') && text) {
              handlePlayerResponse(JSON.parse(text));
            } else if (fullUrl.includes('/api/timedtext')) {
              handleTimedtextObserved(fullUrl, this.status, text);
            }
          } catch {}
        });
      }
    } catch {}
    return origSend.call(this, body);
  };

  let lastTrackSetAt = 0;
  let ccButtonClicked = false;
  const driver = window.setInterval(() => {
    if (settled) {
      window.clearInterval(driver);
      return;
    }
    try {
      document.querySelectorAll('video, audio').forEach(silenceMedia);
      if (window.ytInitialPlayerResponse) {
        handlePlayerResponse(window.ytInitialPlayerResponse);
      }
      const embeddedResp = window.ytcfg?.get?.('PLAYER_VARS')?.embedded_player_response;
      if (typeof embeddedResp === 'string' && embeddedResp && !catalog) {
        try {
          const parsedEmbedded = JSON.parse(embeddedResp);
          const previewFailure = classifyPlayabilityFailure(
            parsedEmbedded?.previewPlayabilityStatus || parsedEmbedded?.playabilityStatus,
          );
          if (previewFailure) {
            publish({ ok: false, ...previewFailure });
            return;
          }
        } catch {}
      }

      const player = document.getElementById('movie_player');
      if (player) {
        if (typeof player.mute === 'function') player.mute();
        if (typeof player.getPlayerResponse === 'function') {
          const pr = player.getPlayerResponse();
          if (pr) handlePlayerResponse(pr);
        }
        if (typeof player.playVideo === 'function') {
          const state =
            typeof player.getPlayerState === 'function' ? player.getPlayerState() : -1;
          if (state !== 1 && state !== 3) player.playVideo();
        }
        if (typeof player.loadModule === 'function') {
          player.loadModule('captions');
        }
        if (
          typeof player.getOption === 'function' &&
          typeof player.setOption === 'function' &&
          Date.now() - startedAt >= 500 &&
          Date.now() - lastTrackSetAt >= 2000 &&
          !observedPot &&
          observedBodies.length === 0
        ) {
          const tracklist = player.getOption('captions', 'tracklist');
          if (Array.isArray(tracklist) && tracklist.length > 0) {
            const picked =
              tracklist.find((t) => sameLanguage(t?.languageCode, targetLangHint)) ||
              tracklist.find((t) => normalizeLang(t?.languageCode).startsWith('en')) ||
              tracklist[0];
            if (picked) {
              lastTrackSetAt = Date.now();
              player.setOption('captions', 'track', picked);
            }
          }
        }
      }

      if (
        !ccButtonClicked &&
        !observedPot &&
        observedBodies.length === 0 &&
        Date.now() - startedAt >= 1000
      ) {
        const ccBtn = document.querySelector('.ytp-subtitles-button[aria-pressed="false"]');
        if (ccBtn && typeof ccBtn.click === 'function') {
          ccButtonClicked = true;
          ccBtn.click();
        }
      }

      if (
        noTracksObservedAt > 0 &&
        !catalog &&
        observedBodies.length === 0 &&
        Date.now() - noTracksObservedAt >= 3000
      ) {
        const playerTracklist =
          player && typeof player.getOption === 'function'
            ? player.getOption('captions', 'tracklist')
            : null;
        if (!Array.isArray(playerTracklist) || playerTracklist.length === 0) {
          publish({
            ok: false,
            code: 'transcriptsDisabled',
            message: 'YouTube 没有返回这个视频的字幕轨道。',
          });
          return;
        }
      }

      if (observedBodies.length > 0 && !catalog) {
        void attemptExtraction();
      }
    } catch {}
  }, 200);
})();
"#;

#[derive(Default)]
pub struct YouTubeEmbedTranscriptState {
    lock: Mutex<()>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedTranscriptPayload {
    pub video_id: String,
    pub tracks: Vec<TranscriptTrack>,
    pub translation_languages: Vec<TranslationLanguage>,
    pub active_track_id: String,
    pub body: String,
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation_language: Option<String>,
}

struct WindowGuard(Option<WebviewWindow>);

impl WindowGuard {
    fn window(&self) -> Option<&WebviewWindow> {
        self.0.as_ref()
    }
}

impl Drop for WindowGuard {
    fn drop(&mut self) {
        if let Some(window) = self.0.take() {
            let _ = window.destroy();
        }
    }
}

fn is_allowed_host(host: &str) -> bool {
    host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "youtube-nocookie.com"
        || host.ends_with(".youtube-nocookie.com")
        || host == "google.com"
        || host.ends_with(".google.com")
}

fn classify_js_error_code(code: Option<&str>) -> &'static str {
    match code {
        Some("transcriptsDisabled") => "transcriptsDisabled",
        Some("ageRestricted") => "ageRestricted",
        Some("videoUnavailable") => "videoUnavailable",
        Some("rateLimited") => "rateLimited",
        Some("poTokenRequired") => "poTokenRequired",
        _ => "requestBlocked",
    }
}

async fn open_capture_window(app: &AppHandle, label: &str) -> Result<WindowGuard, TranscriptFailure> {
    let mut last_error = None;
    for (attempt, raw_url) in HOST_URLS.iter().enumerate() {
        let attempt_label = format!("{label}-{attempt}");
        let url = raw_url.parse().map_err(|_| {
            TranscriptFailure::new("unknown", "embed", "内嵌字幕提取器初始化地址无效。")
        })?;
        let (ready_tx, mut ready_rx) = watch::channel(false);
        let built = WebviewWindowBuilder::new(app, &attempt_label, WebviewUrl::External(url))
            .title("Seamind Caption Helper")
            .inner_size(1280.0, 720.0)
            .resizable(false)
            .decorations(false)
            .focusable(false)
            .skip_taskbar(true)
            .visible(false)
            .user_agent(default_user_agent())
            .initialization_script_for_all_frames(EMBED_CAPTURE_SCRIPT)
            .on_navigation(|url| {
                url.scheme() == "about"
                    || (url.scheme() == "https" && url.host_str().is_some_and(is_allowed_host))
            })
            .on_page_load(move |_, payload| {
                if payload.event() == PageLoadEvent::Finished
                    && payload.url().scheme() == "https"
                    && payload.url().host_str().is_some_and(is_allowed_host)
                {
                    ready_tx.send_replace(true);
                }
            })
            .build();

        let window = match built {
            Ok(window) => WindowGuard(Some(window)),
            Err(error) => {
                last_error = Some(TranscriptFailure::new(
                    "network",
                    "embed",
                    format!("无法创建内嵌字幕提取窗口：{error}"),
                ));
                continue;
            }
        };

        let loaded = tokio::time::timeout(PAGE_LOAD_TIMEOUT, async {
            loop {
                if *ready_rx.borrow() {
                    return Ok(());
                }
                ready_rx.changed().await.map_err(|_| {
                    TranscriptFailure::new("network", "embed", "内嵌字幕窗口在加载完成前关闭。")
                })?;
            }
        })
        .await;

        match loaded {
            Ok(Ok(())) => return Ok(window),
            Ok(Err(error)) => last_error = Some(error),
            Err(_) => {
                last_error = Some(TranscriptFailure::new(
                    "timeout",
                    "embed",
                    "加载 YouTube 内嵌字幕环境超时。",
                ));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        TranscriptFailure::new("network", "embed", "无法加载 YouTube 内嵌字幕环境。")
    }))
}

async fn evaluate_json(window: &WebviewWindow, script: String) -> Result<Value, TranscriptFailure> {
    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(StdMutex::new(Some(sender)));
    let callback_sender = Arc::clone(&sender);
    window
        .eval_with_callback(script, move |result| {
            if let Ok(mut guard) = callback_sender.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(result);
                }
            }
        })
        .map_err(|error| {
            TranscriptFailure::new("network", "embed", format!("无法执行内嵌字幕脚本：{error}"))
        })?;
    let raw = tokio::time::timeout(EVAL_TIMEOUT, receiver)
        .await
        .map_err(|_| TranscriptFailure::new("timeout", "embed", "读取内嵌字幕状态超时。"))?
        .map_err(|_| TranscriptFailure::new("network", "embed", "内嵌字幕窗口已提前关闭。"))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" || trimmed == "undefined" {
        return Ok(Value::Null);
    }
    serde_json::from_str(trimmed).map_err(|error| {
        TranscriptFailure::new(
            "unexpectedResponse",
            "embed",
            format!("内嵌字幕状态解析失败：{error}"),
        )
    })
}

async fn poll_for_embed_result(
    window: &WebviewWindow,
    request_id: &str,
    timeout: Duration,
) -> Result<Value, TranscriptFailure> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(result) = evaluate_json(
            window,
            "(() => window.__seamindEmbedResult ?? null)()".to_string(),
        )
        .await
        {
            if result
                .get("requestId")
                .and_then(Value::as_str)
                .is_some_and(|id| id == request_id)
            {
                return Ok(result);
            }
        }
        if Instant::now() >= deadline {
            return Err(TranscriptFailure::new(
                "requestBlocked",
                "embed",
                "YouTube 内嵌播放器未在时限内返回字幕数据。",
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn parse_result_value(result: Value) -> Result<EmbedTranscriptPayload, TranscriptFailure> {
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        let data = result.get("data").cloned().unwrap_or(Value::Null);
        let payload: EmbedTranscriptPayload = serde_json::from_value(data).map_err(|error| {
            TranscriptFailure::new(
                "unexpectedResponse",
                "embed",
                format!("无法读取内嵌字幕结果：{error}"),
            )
        })?;
        if payload.body.trim().is_empty() || payload.tracks.is_empty() {
            return Err(TranscriptFailure::new(
                "emptyResponse",
                "embed",
                "YouTube 内嵌播放器返回了空字幕内容。",
            ));
        }
        return Ok(payload);
    }

    let raw_code = result.get("code").and_then(Value::as_str);
    let message = result
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("YouTube 要求验证当前字幕请求。");
    Err(TranscriptFailure::new(
        classify_js_error_code(raw_code),
        "embed",
        message,
    ))
}

async fn run_embed_capture(
    app: &AppHandle,
    video_id: &str,
    preferred_lang: Option<&str>,
    track_id: Option<&str>,
    translation_lang: Option<&str>,
) -> Result<EmbedTranscriptPayload, TranscriptFailure> {
    if !is_video_id(video_id) {
        return Err(TranscriptFailure::new(
            "videoUnavailable",
            "validate",
            "视频 ID 无效，无法请求字幕。",
        ));
    }

    let request_id = Uuid::new_v4().simple().to_string();
    let label = format!("youtube-embed-transcript-{request_id}");
    let guard = open_capture_window(app, &label).await?;
    let window = guard
        .window()
        .ok_or_else(|| TranscriptFailure::new("network", "embed", "内嵌字幕窗口不可用。"))?;

    let req_json = serde_json::to_string(&json!({
        "requestId": request_id,
        "videoId": video_id,
        "preferredLang": preferred_lang.unwrap_or("zh-Hans"),
        "trackId": track_id,
        "translationLang": translation_lang.or(preferred_lang).unwrap_or("zh-Hans"),
    }))
    .map_err(|error| TranscriptFailure::new("unknown", "embed", error.to_string()))?;

    let start_script = format!(
        "(() => {{ try {{ if (typeof window.__seamindStartEmbedCapture !== 'function') return {{ error: 'Embed capture host did not initialize.' }}; return window.__seamindStartEmbedCapture({req_json}); }} catch (e) {{ return {{ error: String(e) }}; }} }})()"
    );
    let ack = evaluate_json(window, start_script).await?;
    if let Some(error) = ack.get("error").and_then(Value::as_str) {
        return Err(TranscriptFailure::new("network", "embed", error));
    }

    let first_result = poll_for_embed_result(window, &request_id, EMBED_CAPTURE_TIMEOUT).await?;
    if first_result.get("ok").and_then(Value::as_bool) != Some(true)
        && first_result.get("code").and_then(Value::as_str) == Some("embedDisabled")
    {
        let fallback_id = Uuid::new_v4().simple().to_string();
        let watch_req_json = serde_json::to_string(&json!({
            "requestId": fallback_id,
            "videoId": video_id,
            "preferredLang": preferred_lang.unwrap_or("zh-Hans"),
            "trackId": track_id,
            "translationLang": translation_lang.or(preferred_lang).unwrap_or("zh-Hans"),
        }))
        .map_err(|error| TranscriptFailure::new("unknown", "embed", error.to_string()))?;
        let watch_script = format!(
            "(() => {{ try {{ if (typeof window.__seamindStartWatchFallback !== 'function') return {{ error: 'Watch fallback unavailable.' }}; return window.__seamindStartWatchFallback({watch_req_json}); }} catch (e) {{ return {{ error: String(e) }}; }} }})()"
        );
        if evaluate_json(window, watch_script).await.is_ok() {
            if let Ok(watch_result) =
                poll_for_embed_result(window, &fallback_id, WATCH_FALLBACK_TIMEOUT).await
            {
                return parse_result_value(watch_result);
            }
        }
    }

    parse_result_value(first_result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn youtube_transcript_embed_fetch(
    app: AppHandle,
    state: State<'_, YouTubeEmbedTranscriptState>,
    video_id: String,
    preferred_lang: Option<String>,
    track_id: Option<String>,
    translation_lang: Option<String>,
) -> Result<TranscriptReply<EmbedTranscriptPayload>, String> {
    let trace_id = Uuid::new_v4().simple().to_string();
    let _guard = state.lock.lock().await;
    let result = run_embed_capture(
        &app,
        &video_id,
        preferred_lang.as_deref(),
        track_id.as_deref(),
        translation_lang.as_deref(),
    )
    .await;
    Ok(reply(result, trace_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_allowlist_covers_youtube_embed_and_sorry_domains() {
        assert!(is_allowed_host("www.youtube-nocookie.com"));
        assert!(is_allowed_host("youtube-nocookie.com"));
        assert!(is_allowed_host("www.youtube.com"));
        assert!(is_allowed_host("www.google.com"));
        assert!(!is_allowed_host("evil-youtube.com"));
        assert!(!is_allowed_host("youtube.com.attacker.example"));
    }

    #[test]
    fn parses_valid_embed_payload_and_maps_embed_disabled_to_request_blocked() {
        let ok_json = json!({
            "requestId": "abc",
            "ok": true,
            "data": {
                "videoId": "dQw4w9WgXcQ",
                "tracks": [{
                    "id": "embed:en:auto:0",
                    "languageCode": "en",
                    "name": "English (auto-generated)",
                    "isGenerated": true,
                    "isTranslatable": true,
                    "isDefault": true
                }],
                "translationLanguages": [{
                    "languageCode": "zh-Hans",
                    "name": "Chinese (Simplified)"
                }],
                "activeTrackId": "embed:en:auto:0",
                "body": "{\"events\":[{\"tStartMs\":0,\"dDurationMs\":1000,\"segs\":[{\"utf8\":\"Hello\"}]}]}",
                "contentType": "application/json",
                "translationBody": "{\"events\":[{\"tStartMs\":0,\"dDurationMs\":1000,\"segs\":[{\"utf8\":\"你好\"}]}]}",
                "translationLanguage": "zh-Hans"
            }
        });
        let parsed = parse_result_value(ok_json).expect("valid embed payload");
        assert_eq!(parsed.active_track_id, "embed:en:auto:0");
        assert_eq!(parsed.translation_language.as_deref(), Some("zh-Hans"));

        let embed_disabled = json!({
            "requestId": "abc",
            "ok": false,
            "code": "embedDisabled",
            "message": "Playback on other websites has been disabled by the video owner"
        });
        let err = parse_result_value(embed_disabled).unwrap_err();
        // Embed-disabled must map to requestBlocked rather than videoUnavailable so yt-dlp/browser
        // fallbacks can still fetch captions for videos that only disallow third-party embeds.
        assert_eq!(classify_js_error_code(Some("embedDisabled")), "requestBlocked");
        let _ = err;
    }
}
