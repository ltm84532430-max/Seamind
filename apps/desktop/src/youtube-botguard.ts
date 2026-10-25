import { getChallenge } from 'bgutils-js/botguard';
import { GOOG_API_KEY, buildURL, parseLooseJSON } from 'bgutils-js/utils';
import { createColdStartToken } from 'bgutils-js/webpo';
import { invoke } from '@tauri-apps/api/core';
import { proxiedFetch } from './youtube-proxy';

const WAA_REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const TOKEN_CACHE_MS = 4 * 60_000;
const interpreterCache = new Map<string, string>();

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface YouTubeAttestationContext {
  context: Record<string, any>;
  initialAttestationData: Record<string, any>;
  ytConfig: Record<string, any>;
}

async function fetchPageBotGuardChallenge(
  attestation: YouTubeAttestationContext,
): Promise<Record<string, any> | undefined> {
  const client = attestation.context.client;
  const response = await proxiedFetch(
    'https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false&alt=json',
    {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'x-goog-visitor-id': client.visitorData,
        'x-youtube-client-name': '1',
        'x-youtube-client-version': client.clientVersion,
        ...(client.userAgent ? { 'user-agent': client.userAgent } : {}),
      },
      body: JSON.stringify({
        engagementType: 'ENGAGEMENT_TYPE_UNBOUND',
        eacrToken: attestation.initialAttestationData.T,
        context: attestation.context,
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `InnerTube attestation request failed (${response.status}).`,
    );
  const result = (await response.json()) as Record<string, any>;
  return result.bgChallenge;
}

/** Reads the same page-bound BotGuard inputs the YouTube web player receives. */
export async function loadYouTubeAttestationContext(
  videoId: string,
  signal?: AbortSignal,
): Promise<YouTubeAttestationContext> {
  const pages = [
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&bpctr=9999999999&has_verified=1`,
    'https://www.youtube.com/',
  ];
  const failures: string[] = [];

  for (const page of pages) {
    try {
      const response = await proxiedFetch(page, {
        signal,
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US',
          ...(typeof navigator !== 'undefined'
            ? { 'user-agent': navigator.userAgent }
            : {}),
        },
      });
      if (!response.ok)
        throw new Error(`YouTube page request failed (${response.status}).`);

      const html = await response.text();
      const configMatches = html.matchAll(
        /ytcfg\.set\s*\(\s*(\{[\s\S]*?\})\s*\)/g,
      );
      const ytConfig: Record<string, any> = {};
      for (const match of configMatches) {
        try {
          Object.assign(ytConfig, JSON.parse(match[1]));
        } catch {
          try {
            Object.assign(ytConfig, parseLooseJSON(match[1]));
          } catch {
            // ignore malformed fragment
          }
        }
      }

      const attestationMatch = html.match(
        /(?:window\.)?ytAtN\s*\(\s*(\{[\s\S]*?\})\s*\)/,
      );
      const attestationText = attestationMatch?.[1];

      let initialAttestationData: Record<string, any> = {};
      if (attestationText) {
        try {
          initialAttestationData = parseLooseJSON(attestationText);
        } catch {
          try {
            initialAttestationData = JSON.parse(attestationText);
          } catch {
            // ignore
          }
        }
      }

      if (typeof initialAttestationData.R === 'string') {
        try {
          initialAttestationData.R = JSON.parse(initialAttestationData.R);
        } catch {
          try {
            initialAttestationData.R = parseLooseJSON(initialAttestationData.R);
          } catch {
            // ignore
          }
        }
      }

      const context = ytConfig.INNERTUBE_CONTEXT;
      if (!context?.client)
        throw new Error('YouTube page did not include INNERTUBE_CONTEXT.');

      return { context, initialAttestationData, ytConfig };
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(
    `Could not load YouTube attestation data: ${failures.join('; ')}`,
  );
}

/** Creates playback PO tokens in the WebView runtime used by the SABR client. */
class YouTubeBotGuard {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<string>>();
  private queue: Promise<void> = Promise.resolve();

  async playbackToken(
    contentBinding: string,
    waitForToken: boolean,
    attestation?: YouTubeAttestationContext,
  ) {
    const cached = this.tokens.get(contentBinding);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const coldStart = createColdStartToken(contentBinding);
    const mint = this.mint(contentBinding, attestation)
      .then((token) => {
        this.tokens.set(contentBinding, {
          token,
          expiresAt: Date.now() + TOKEN_CACHE_MS,
        });
        return token;
      })
      .catch((error: unknown) => {
        console.warn('[YouTube PO token] Unable to mint a full token:', error);
        if (waitForToken) throw error;
        return coldStart;
      });

    if (waitForToken) return mint;
    void mint;
    return coldStart;
  }

  private async mint(
    contentBinding: string,
    attestation?: YouTubeAttestationContext,
  ) {
    const pending = this.pending.get(contentBinding);
    if (pending) return pending;

    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = previous
      .then(() => this.mintUncached(contentBinding, attestation))
      .finally(() => {
        this.pending.delete(contentBinding);
        release();
      });
    this.pending.set(contentBinding, task);
    return task;
  }

  private async mintUncached(
    contentBinding: string,
    attestation?: YouTubeAttestationContext,
  ) {
    let rData = attestation?.initialAttestationData?.R;
    if (typeof rData === 'string') {
      try {
        rData = JSON.parse(rData);
      } catch {
        try {
          rData = parseLooseJSON(rData);
        } catch {
          // ignore
        }
      }
    }
    let pageChallenge =
      rData?.bgChallenge ??
      attestation?.initialAttestationData?.bgChallenge ??
      (rData?.globalName && rData?.program ? rData : undefined);

    if (!pageChallenge && attestation) {
      try {
        pageChallenge = await fetchPageBotGuardChallenge(attestation);
      } catch (error) {
        console.warn(
          '[YouTube PO token] InnerTube attestation challenge failed:',
          error,
        );
      }
    }
    const challenge =
      pageChallenge ??
      (await getChallenge({
        requestKey: WAA_REQUEST_KEY,
        fetchFunction: proxiedFetch,
        useYouTubeAPI: true,
      }));
    if (!challenge.globalName || !challenge.program)
      throw new Error('YouTube returned an incomplete BotGuard challenge.');

    let interpreter =
      typeof challenge.interpreterJavascript === 'string'
        ? challenge.interpreterJavascript
        : challenge.interpreterJavascript
            ?.privateDoNotAccessOrElseSafeScriptWrappedValue;

    if (!interpreter) {
      let rawUrl: string | undefined;
      if (typeof challenge.interpreterUrl === 'string') {
        rawUrl = challenge.interpreterUrl;
      } else if (
        challenge.interpreterUrl &&
        typeof challenge.interpreterUrl === 'object'
      ) {
        rawUrl =
          challenge.interpreterUrl
            .privateDoNotAccessOrElseTrustedResourceUrlWrappedValue ??
          challenge.interpreterUrl.url ??
          challenge.interpreterUrl.src;
      }
      if (!rawUrl)
        throw new Error('YouTube did not return a BotGuard interpreter.');

      const url =
        rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
          ? rawUrl
          : `https:${rawUrl.startsWith('//') ? '' : '//'}${rawUrl}`;

      const cached = interpreterCache.get(url);
      if (cached) {
        interpreter = cached;
      } else {
        const response = await proxiedFetch(url);
        if (!response.ok) {
          let reason = response.statusText;
          try {
            const body: unknown = await response.clone().json();
            if (
              body &&
              typeof body === 'object' &&
              'error' in body &&
              typeof body.error === 'string'
            )
              reason = body.error;
          } catch {
            // Upstream error pages may be HTML; keep the diagnostic limited to safe metadata.
          }
          const safeReason = reason
            .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
            .replace(/[\r\n\t]+/g, ' ')
            .slice(0, 140);
          throw new Error(
            `BotGuard interpreter request failed (${response.status}) at ${new URL(url).hostname}: ${safeReason}`,
          );
        }
        interpreter = await response.text();
        interpreterCache.set(url, interpreter);
      }
    }

    const requestId = crypto.randomUUID();
    const challengeForRuntime = {
      globalName: challenge.globalName,
      program: challenge.program,
      interpreterHash: challenge.interpreterHash,
    };
    try {
      const botguardResponse = await invoke<unknown>(
        'youtube_botguard_snapshot',
        {
          requestId,
          contentBinding,
          challenge: challengeForRuntime,
          interpreterJavascript: interpreter,
          ytConfig: attestation?.ytConfig ?? null,
          userAgent: navigator.userAgent,
        },
      );
      let integrityResponse = await proxiedFetch(buildURL('GenerateIT', true), {
        method: 'POST',
        headers: {
          'content-type': 'application/json+protobuf',
          'x-goog-api-key': GOOG_API_KEY,
          'x-user-agent': 'grpc-web-javascript/0.1',
        },
        body: JSON.stringify([WAA_REQUEST_KEY, botguardResponse]),
      });
      if (!integrityResponse.ok) {
        integrityResponse = await proxiedFetch(buildURL('GenerateIT', false), {
          method: 'POST',
          headers: {
            'content-type': 'application/json+protobuf',
            'x-goog-api-key': GOOG_API_KEY,
            'x-user-agent': 'grpc-web-javascript/0.1',
          },
          body: JSON.stringify([WAA_REQUEST_KEY, botguardResponse]),
        });
      }
      if (!integrityResponse.ok)
        throw new Error(
          `BotGuard token request failed (${integrityResponse.status}).`,
        );

      const integrityPayload = (await integrityResponse.json()) as unknown[];
      const integrityToken = integrityPayload[0];
      if (typeof integrityToken !== 'string' || !integrityToken)
        throw new Error('YouTube returned an empty BotGuard integrity token.');

      return await invoke<string>('youtube_botguard_mint', {
        requestId,
        contentBinding,
        integrityToken,
      });
    } catch (error) {
      await invoke('youtube_botguard_discard', { requestId }).catch(
        () => undefined,
      );
      throw error;
    }
  }
}

const botGuard = new YouTubeBotGuard();

export function getPlaybackPoToken(
  contentBinding: string,
  waitForToken: boolean,
  attestation?: YouTubeAttestationContext,
) {
  return botGuard.playbackToken(contentBinding, waitForToken, attestation);
}
