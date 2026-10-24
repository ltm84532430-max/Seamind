// Adapted from LuanRT/googlevideo's MIT-licensed ShakaPlayerAdapter example.
import shaka from 'shaka-player/dist/shaka-player.compiled.js';

import {
  FormatKeyUtils,
  type CacheManager,
  type RequestMetadataManager,
} from 'googlevideo/utils';

import type { SabrFormat } from 'googlevideo/shared-types';

import {
  SabrUmpProcessor,
  type RequestFilter,
  type ResponseFilter,
  type SabrPlayerAdapter,
  type SabrRequestMetadata,
  type UmpProcessingResult,
} from 'googlevideo/sabr-streaming-adapter';

import { proxiedFetch } from './youtube-proxy';

function asMap<K, V>(object: Record<string, V>): Map<K, V> {
  const map = new Map<K, V>();
  for (const key of Object.keys(object)) map.set(key as K, object[key]);
  return map;
}

function createRecoverableError(message: string, info?: unknown) {
  return new shaka.util.Error(
    shaka.util.Error.Severity.RECOVERABLE,
    shaka.util.Error.Category.NETWORK,
    shaka.util.Error.Code.HTTP_ERROR,
    message,
    { info },
  );
}

function headersToGenericObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.trim()] = value;
  });
  return result;
}

function makeResponse(
  headers: Record<string, string>,
  data: BufferSource,
  status: number,
  uri: string,
  responseUrl: string,
  request: shaka.extern.Request,
  requestType: shaka.net.NetworkingEngine.RequestType,
): shaka.extern.Response & { originalRequest: shaka.extern.Request } {
  if (status >= 200 && status <= 299 && status !== 202) {
    return {
      uri: responseUrl || uri,
      originalUri: uri,
      data,
      status,
      headers,
      originalRequest: request,
      fromCache: Boolean(headers['x-shaka-from-cache']),
    };
  }

  let responseText: string | null = null;
  try {
    responseText = shaka.util.StringUtils.fromBytesAutoDetect(data);
  } catch {
    // The error response may not contain text.
  }
  const severity =
    status === 401 || status === 403
      ? shaka.util.Error.Severity.CRITICAL
      : shaka.util.Error.Severity.RECOVERABLE;
  throw new shaka.util.Error(
    severity,
    shaka.util.Error.Category.NETWORK,
    shaka.util.Error.Code.BAD_HTTP_STATUS,
    uri,
    status,
    responseText,
    headers,
    requestType,
    responseUrl || uri,
  );
}

interface ShakaResponseArgs {
  uri: string;
  request: shaka.extern.Request;
  requestType: shaka.net.NetworkingEngine.RequestType;
  response: Response;
  arrayBuffer?: Uint8Array | ArrayBuffer;
}

function isGoogleVideoURL(url: string): boolean {
  if (url.startsWith('sabr://')) {
    return true;
  }

  const urlParts = url.split('?');
  const urlPart = urlParts[0];
  const queryPart = urlParts[1] || '';

  if (urlPart.endsWith('/videoplayback')) {
    const params = new URLSearchParams(queryPart);
    if (
      params.get('source') === 'youtube' ||
      params.has('sabr') ||
      params.has('lsig') ||
      params.has('expire')
    ) {
      return true;
    }
  } else if (urlPart.includes('/videoplayback/')) {
    // For live, post-live, etc.
    const pathParts = urlPart.split('/');
    return ['videoplayback', 'sabr', 'lsig', 'expire'].some((part) =>
      pathParts.includes(part),
    );
  }

  return false;
}

export class ShakaPlayerAdapter implements SabrPlayerAdapter {
  protected player: shaka.Player | null = null;
  private readonly userAgent?: string;
  private readonly originalRequestUris = new WeakMap<
    shaka.extern.Request,
    string
  >();
  private requestMetadataManager?: RequestMetadataManager;
  private cacheManager?: CacheManager;
  private abortController?: AbortController;

  private requestFilter?: (
    type: shaka.net.NetworkingEngine.RequestType,
    request: shaka.extern.Request,
    context?: shaka.extern.RequestContext,
  ) => Promise<void>;
  private responseFilter?: (
    type: shaka.net.NetworkingEngine.RequestType,
    response: shaka.extern.Response,
    context?: shaka.extern.RequestContext,
  ) => Promise<void>;

  public constructor(userAgent?: string | null) {
    this.userAgent = userAgent || undefined;
  }

  public initialize(
    player: shaka.Player,
    requestMetadataManager: RequestMetadataManager,
    cacheManager: CacheManager,
  ): void {
    this.player = player;
    this.requestMetadataManager = requestMetadataManager;
    this.cacheManager = cacheManager;

    const networkingEngine = shaka.net.NetworkingEngine;
    const schemes = ['http', 'https'];

    if (!shaka.net.HttpFetchPlugin.isSupported())
      throw new Error('The Fetch API is not supported in this browser.');

    schemes.forEach((scheme) => {
      networkingEngine.registerScheme(
        scheme,
        this.parseRequest.bind(this),
        networkingEngine.PluginPriority.PREFERRED,
      );
    });
  }

  private parseRequest(
    uri: string,
    request: shaka.extern.Request,
    requestType: shaka.net.NetworkingEngine.RequestType,
    progressUpdated: shaka.extern.ProgressUpdated,
    headersReceived: shaka.extern.HeadersReceived,
    config: shaka.extern.SchemePluginConfig,
  ): shaka.extern.IAbortableOperation<shaka.extern.Response> {
    const headers = new Headers();
    asMap(request.headers).forEach((value, key) => {
      headers.append(key as string, value as string);
    });
    if (this.userAgent) headers.set('x-seamind-ua', this.userAgent);

    const controller = new AbortController();
    this.abortController = controller;

    const init: RequestInit = {
      body: (request.body as any) || undefined,
      headers,
      method: request.method,
      signal: this.abortController.signal,
      credentials: request.allowCrossSiteCredentials ? 'include' : undefined,
    };

    const abortStatus = { canceled: false, timedOut: false };

    const minBytes = config.minBytesForProgressEvents || 0;

    const pendingRequest = this.request(
      uri,
      request,
      requestType,
      init,
      controller,
      abortStatus,
      progressUpdated,
      headersReceived,
      minBytes,
    );

    const operation = new shaka.util.AbortableOperation(pendingRequest, () => {
      abortStatus.canceled = true;
      controller.abort();
      return Promise.resolve();
    });

    const timeoutMs = request.retryParameters.timeout;
    if (timeoutMs) {
      const timer = new shaka.util.Timer(() => {
        abortStatus.timedOut = true;
        controller.abort();
        console.warn(
          '[ShakaPlayerAdapter]',
          'Request aborted due to timeout:',
          uri,
          requestType,
        );
      });
      timer.tickAfter(timeoutMs / 1000);
      operation.finally(() => timer.stop());
    }

    return operation;
  }

  private async handleCachedRequest(
    requestMetadata: SabrRequestMetadata,
    uri: string,
    request: shaka.extern.Request,
    progressUpdated: shaka.extern.ProgressUpdated,
    headersReceived: shaka.extern.HeadersReceived,
    requestType: shaka.net.NetworkingEngine.RequestType,
  ): Promise<shaka.extern.Response | null> {
    if (!requestMetadata.byteRange || !this.cacheManager) {
      return null;
    }

    const segmentKey =
      FormatKeyUtils.createSegmentCacheKeyFromMetadata(requestMetadata);

    let arrayBuffer = (
      requestMetadata.isInit
        ? this.cacheManager.getInitSegment(segmentKey)
        : this.cacheManager.getSegment(segmentKey)
    )?.buffer as ArrayBuffer;

    if (!arrayBuffer) {
      return null;
    }

    if (requestMetadata.isInit) {
      arrayBuffer = arrayBuffer.slice(
        requestMetadata.byteRange.start,
        requestMetadata.byteRange.end + 1,
      );
    }

    const headers = {
      'content-type': requestMetadata.format?.mimeType?.split(';')[0] || '',
      'content-length': arrayBuffer.byteLength.toString(),
      'x-shaka-from-cache': 'true',
    };

    headersReceived(headers);
    progressUpdated(0, arrayBuffer.byteLength, 0);

    return makeResponse(
      headers,
      arrayBuffer,
      200,
      uri,
      uri,
      request,
      requestType,
    );
  }

  private async handleUmpResponse(
    response: Response,
    requestMetadata: SabrRequestMetadata,
    uri: string,
    request: shaka.extern.Request,
    requestType: shaka.net.NetworkingEngine.RequestType,
    progressUpdated: shaka.extern.ProgressUpdated,
    abortController: AbortController,
    minBytes: number,
  ): Promise<shaka.extern.Response> {
    let lastTime = Date.now();

    const sabrUmpReader = new SabrUmpProcessor(
      requestMetadata,
      this.cacheManager,
    );

    const checkResultIntegrity = (result: UmpProcessingResult) => {
      if (
        !result.data &&
        (!!requestMetadata.error ||
          requestMetadata.streamInfo?.streamProtectionStatus?.status === 3) &&
        !requestMetadata.streamInfo?.sabrContextUpdate
      ) {
        throw createRecoverableError('Server streaming error', requestMetadata);
      }
    };

    const shouldReturnEmptyResponse = () => {
      return (
        requestMetadata.isSABR &&
        (requestMetadata.streamInfo?.redirect ||
          requestMetadata.streamInfo?.sabrContextUpdate)
      );
    };

    try {
      // Fetch returning a ReadableStream response body is not currently
      // supported by all browsers.
      // Browser compatibility:
      // https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
      // If it is not supported, returning the whole segment when
      // it's ready (as xhr)
      if (!response.body) {
        const arrayBuffer = await response.arrayBuffer();
        const currentTime = Date.now();

        progressUpdated(currentTime - lastTime, arrayBuffer.byteLength, 0);

        const result = await sabrUmpReader.processChunk(
          new Uint8Array(arrayBuffer),
        );

        if (result) {
          checkResultIntegrity(result);
          return this.createShakaResponse({
            uri,
            request,
            requestType,
            response,
            arrayBuffer: result.data,
          });
        }

        if (shouldReturnEmptyResponse()) {
          return this.createShakaResponse({
            uri,
            request,
            requestType,
            response,
            arrayBuffer: undefined,
          });
        }

        throw createRecoverableError(
          'Empty response with no redirect information',
          requestMetadata,
        );
      } else {
        const reader = response.body.getReader();

        let loaded = 0;
        let lastLoaded = 0;
        let contentLength: number | undefined;

        while (!abortController.signal.aborted) {
          let readObj;
          try {
            readObj = await reader.read();
          } catch {
            // If we abort the request while reading, we'll get an error here. Just ignore it.
            break;
          }

          const { value, done } = readObj;

          if (done) {
            // If we got here, we read the whole response but there was no segment data; it means we must follow a
            // redirect, or handle protocol updates.
            if (shouldReturnEmptyResponse()) {
              return this.createShakaResponse({
                uri,
                request,
                requestType,
                response,
                arrayBuffer: undefined,
              });
            }
            throw createRecoverableError(
              'Empty response with no redirect information',
              requestMetadata,
            );
          }

          const result = await sabrUmpReader.processChunk(value);

          const segmentInfo = sabrUmpReader.getSegmentInfo();

          if (segmentInfo) {
            if (!contentLength) {
              contentLength = Number(
                segmentInfo.mediaHeader.contentLength ?? 0,
              );
            }

            loaded += segmentInfo.lastChunkSize || 0;
            segmentInfo.lastChunkSize = 0;
          }

          const currentTime = Date.now();
          const chunkSize = loaded - lastLoaded;

          // If the time between last time and this time we got
          // progress event is long enough, or if a whole segment
          // is downloaded, call progressUpdated().
          if (
            (currentTime - lastTime > 100 && chunkSize >= minBytes) ||
            result
          ) {
            // If we have a result, check its integrity before attempting anything.
            if (result) checkResultIntegrity(result);
            if (contentLength) {
              const numBytesRemaining = result ? 0 : contentLength - loaded;
              try {
                progressUpdated(
                  currentTime - lastTime,
                  chunkSize,
                  numBytesRemaining,
                );
              } catch {
                /** no-op */
              } finally {
                lastLoaded = loaded;
                lastTime = currentTime;
              }
            }
          }

          if (result) {
            abortController.abort();
            return this.createShakaResponse({
              uri,
              request,
              requestType,
              response,
              arrayBuffer: result.data,
            });
          }
        }

        // Unreachable if the loop is aborted correctly.
        throw createRecoverableError(
          'UMP stream processing was aborted but did not produce a result.',
          requestMetadata,
        );
      }
    } finally {
      // This googlevideo version keeps no external resources on the processor.
    }
  }

  private async request(
    uri: string,
    request: shaka.extern.Request,
    requestType: shaka.net.NetworkingEngine.RequestType,
    init: RequestInit,
    abortController: AbortController,
    abortStatus: { canceled: boolean; timedOut: boolean },
    progressUpdated: shaka.extern.ProgressUpdated,
    headersReceived: shaka.extern.HeadersReceived,
    minBytes: number,
  ): Promise<shaka.extern.Response> {
    try {
      const requestMetadata =
        this.requestMetadataManager?.getRequestMetadata(uri);

      // Check the cache first.
      if (requestMetadata) {
        const cachedResponse = await this.handleCachedRequest(
          requestMetadata,
          uri,
          request,
          progressUpdated,
          headersReceived,
          requestType,
        );
        if (cachedResponse) {
          return cachedResponse;
        }
      }

      // We only make one InnerTube request through the player, and it needs to be proxied properly.
      const response = await proxiedFetch(uri, init);
      headersReceived(headersToGenericObject(response.headers));

      const responseMimeType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase();
      if (
        requestMetadata &&
        init.method !== 'HEAD' &&
        responseMimeType === 'application/vnd.yt-ump'
      ) {
        return this.handleUmpResponse(
          response,
          requestMetadata,
          uri,
          request,
          requestType,
          progressUpdated,
          abortController,
          minBytes,
        );
      }

      // Handle other requests normally.
      const lastTime = Date.now();

      const arrayBuffer = await response.arrayBuffer();
      const currentTime = Date.now();

      progressUpdated(currentTime - lastTime, arrayBuffer.byteLength, 0);

      return this.createShakaResponse({
        uri,
        request,
        requestType,
        response,
        arrayBuffer,
      });
    } catch (error) {
      if (abortStatus.canceled) {
        throw new shaka.util.Error(
          shaka.util.Error.Severity.RECOVERABLE,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.OPERATION_ABORTED,
          uri,
          requestType,
        );
      } else if (abortStatus.timedOut) {
        throw new shaka.util.Error(
          shaka.util.Error.Severity.RECOVERABLE,
          shaka.util.Error.Category.NETWORK,
          shaka.util.Error.Code.TIMEOUT,
          uri,
          requestType,
        );
      }
      if (error instanceof shaka.util.Error) throw error;
      throw new shaka.util.Error(
        shaka.util.Error.Severity.RECOVERABLE,
        shaka.util.Error.Category.NETWORK,
        shaka.util.Error.Code.HTTP_ERROR,
        uri,
        error,
        requestType,
      );
    }
  }

  public checkPlayerStatus(): asserts this is { player: shaka.Player } & this {
    if (!this.player) {
      throw new Error('Player not initialized');
    }
  }

  public getPlayerTime() {
    this.checkPlayerStatus();
    return this.player.getMediaElement()?.currentTime || 0;
  }

  public getPlaybackRate() {
    this.checkPlayerStatus();
    return this.player.getPlaybackRate();
  }

  public getBandwidthEstimate() {
    this.checkPlayerStatus();
    return this.player.getStats().estimatedBandwidth;
  }

  public getActiveTrackFormats(
    activeFormat: SabrFormat,
    sabrFormats: SabrFormat[],
  ): {
    videoFormat?: SabrFormat;
    audioFormat?: SabrFormat;
  } {
    this.checkPlayerStatus();

    const activeVariant = this.player
      .getVariantTracks()
      .find(
        (track) =>
          FormatKeyUtils.getUniqueFormatId(activeFormat) ===
          (activeFormat.width ? track.originalVideoId : track.originalAudioId),
      );

    if (!activeVariant) {
      return { videoFormat: undefined, audioFormat: undefined };
    }

    const formatMap = new Map(
      sabrFormats.map((format) => [
        FormatKeyUtils.getUniqueFormatId(format),
        format,
      ]),
    );

    return {
      videoFormat: activeVariant.originalVideoId
        ? formatMap.get(activeVariant.originalVideoId)
        : undefined,
      audioFormat: activeVariant.originalAudioId
        ? formatMap.get(activeVariant.originalAudioId)
        : undefined,
    };
  }

  public registerRequestInterceptor(interceptor: RequestFilter): void {
    this.checkPlayerStatus();

    const networkingEngine = this.player.getNetworkingEngine();
    if (!networkingEngine) return;

    this.requestFilter = async (type, request, context) => {
      if (type !== shaka.net.NetworkingEngine.RequestType.SEGMENT) return;
      // Shaka reuses this request object for retries after filters have already rewritten its URL.
      // Keep the first URI so SABR retries still arrive as sabr:// and rebuild their ABR body.
      const requestUrl =
        this.originalRequestUris.get(request) ?? request.uris[0] ?? '';
      if (!requestUrl || !isGoogleVideoURL(requestUrl)) return;
      this.originalRequestUris.set(request, requestUrl);

      const modifiedRequest = await interceptor({
        headers: request.headers,
        url: requestUrl,
        method: request.method,
        segment: {
          getStartTime: () => context?.segment?.getStartTime() ?? null,
          isInit: () => !context?.segment,
        },
        body: request.body,
      });

      if (modifiedRequest) {
        request.uris = modifiedRequest.url
          ? [modifiedRequest.url]
          : request.uris;
        request.method = modifiedRequest.method || request.method;
        request.headers = modifiedRequest.headers || request.headers;
        request.body = modifiedRequest.body || request.body;
      }
    };

    networkingEngine.registerRequestFilter(this.requestFilter);
  }

  public registerResponseInterceptor(interceptor: ResponseFilter): void {
    this.checkPlayerStatus();
    const networkingEngine = this.player.getNetworkingEngine();
    if (!networkingEngine) return;

    this.responseFilter = async (type, response, context) => {
      const requestUri = response.originalRequest.uris[0];
      if (
        type !== shaka.net.NetworkingEngine.RequestType.SEGMENT ||
        !isGoogleVideoURL(requestUri)
      )
        return;

      const modifiedResponse = await interceptor({
        url: requestUri,
        method: response.originalRequest.method,
        headers: response.headers,
        data: response.data,
        makeRequest: async (url: string, headers: Record<string, string>) => {
          const retryParameters =
            this.player!.getConfiguration().streaming.retryParameters;
          const redirectRequest = shaka.net.NetworkingEngine.makeRequest(
            [url],
            retryParameters,
          );
          Object.assign(redirectRequest.headers, headers);

          const requestOperation = networkingEngine.request(
            type,
            redirectRequest,
            context,
          );
          const redirectResponse = await requestOperation.promise;

          return {
            url: redirectResponse.uri,
            method: redirectResponse.originalRequest.method,
            headers: redirectResponse.headers,
            data: redirectResponse.data,
          };
        },
      });

      if (modifiedResponse) {
        response.data = modifiedResponse.data ?? response.data;
        Object.assign(response.headers, modifiedResponse.headers);
      }
    };

    networkingEngine.registerResponseFilter(this.responseFilter);
  }

  public createShakaResponse(args: ShakaResponseArgs): shaka.extern.Response {
    return makeResponse(
      headersToGenericObject(args.response.headers),
      (args.arrayBuffer as any) || new ArrayBuffer(0),
      args.response.status,
      args.uri,
      args.response.url,
      args.request,
      args.requestType,
    );
  }

  public dispose(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }

    if (this.player) {
      const networkingEngine = this.player.getNetworkingEngine();

      if (networkingEngine && this.requestFilter && this.responseFilter) {
        networkingEngine.unregisterRequestFilter(this.requestFilter);
        networkingEngine.unregisterResponseFilter(this.responseFilter);
      }

      shaka.net.NetworkingEngine.unregisterScheme('http');
      shaka.net.NetworkingEngine.unregisterScheme('https');

      this.player = null;
    }
  }
}
