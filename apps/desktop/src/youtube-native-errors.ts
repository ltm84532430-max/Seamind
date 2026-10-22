export type NativeFailureCode =
  | 'botCheck'
  | 'loginRequired'
  | 'ageRestricted'
  | 'privateVideo'
  | 'membersOnly'
  | 'regionBlocked'
  | 'unavailable'
  | 'notFound'
  | 'liveOffline'
  | 'noStreams'
  | 'network'
  | 'unknown';

export const nativeFailureMessages: Record<NativeFailureCode, string> = {
  botCheck:
    'YouTube 要求验证“你不是机器人”：当前网络出口对这个视频被风控。可以切换网络节点后重试；其他视频可能仍然可以播放。',
  loginRequired: 'YouTube 要求登录后才能观看这个视频。',
  ageRestricted:
    '这是年龄限制视频，需要登录已验证年龄的 Google 账号，内置播放器无法播放。',
  privateVideo: '这是私享视频，只有被授权的账号才能观看。',
  membersOnly: '这是频道会员专享视频，需要付费会员账号。',
  regionBlocked: '这个视频在你所在的地区不可用。',
  unavailable: '视频不可用：可能已被删除、设为私享，或不允许这种播放方式。',
  notFound: '找不到这个视频，可能已被删除。',
  liveOffline: '直播尚未开始，或已经结束。',
  noStreams:
    'YouTube 没有返回内置播放器能用的媒体流（可能该视频只提供 SABR 流）。',
  network: '无法连接 YouTube，请检查网络或代理设置。',
  unknown: 'YouTube 返回了无法识别的播放状态。',
};

export class NativePlaybackError extends Error {
  readonly code: NativeFailureCode;
  readonly detail?: string;

  constructor(code: NativeFailureCode, detail?: string) {
    super(nativeFailureMessages[code]);
    this.name = 'NativePlaybackError';
    this.code = code;
    this.detail = detail;
  }
}

export interface PlayabilityDescription {
  status?: string;
  reason?: string;
  subreason?: string;
  offerId?: string;
}

const botCheckPattern = /not a bot|confirm you.?re not|unusual traffic/i;
const agePattern = /\bage\b/i;
const privatePattern = /\bprivate\b/i;
const membersPattern = /\bmembers?(?:-only)?\b|\bjoin this channel\b/i;
const regionPattern = /\b(?:country|region)\b/i;

/** Maps a `playabilityStatus` to a failure code, or null when the video can be played. */
export function classifyPlayability(
  playability: PlayabilityDescription,
): NativeFailureCode | null {
  const status = playability.status ?? '';
  if (status === 'OK') return null;

  const text = `${playability.reason ?? ''} ${playability.subreason ?? ''}`;
  if (botCheckPattern.test(text)) return 'botCheck';

  // Whole words only: "age" must not match "page", nor "member" match "remember".
  switch (status) {
    case 'LOGIN_REQUIRED':
      if (agePattern.test(text)) return 'ageRestricted';
      if (privatePattern.test(text)) return 'privateVideo';
      if (membersPattern.test(text)) return 'membersOnly';
      return 'loginRequired';
    case 'AGE_CHECK_REQUIRED':
      return 'ageRestricted';
    case 'UNPLAYABLE':
      if (
        playability.offerId === 'sponsors_only_video' ||
        membersPattern.test(text)
      )
        return 'membersOnly';
      if (regionPattern.test(text)) return 'regionBlocked';
      if (privatePattern.test(text)) return 'privateVideo';
      if (agePattern.test(text)) return 'ageRestricted';
      return 'unavailable';
    case 'ERROR':
      return /unavailable|not available|removed|exist|terminated/i.test(text)
        ? 'notFound'
        : 'unknown';
    case 'LIVE_STREAM_OFFLINE':
      return 'liveOffline';
    case 'CONTENT_CHECK_REQUIRED':
      return 'unavailable';
    default:
      return 'unknown';
  }
}

/** Failures that every client would report the same way, so trying another one is pointless. */
export function isDefinitiveFailure(code: NativeFailureCode): boolean {
  return (
    code === 'privateVideo' ||
    code === 'membersOnly' ||
    code === 'ageRestricted' ||
    code === 'notFound' ||
    code === 'regionBlocked' ||
    code === 'liveOffline'
  );
}

const failurePriority: NativeFailureCode[] = [
  'privateVideo',
  'membersOnly',
  'ageRestricted',
  'notFound',
  'regionBlocked',
  'liveOffline',
  'botCheck',
  'loginRequired',
  'unavailable',
  'noStreams',
  'network',
  'unknown',
];

/** The most informative failure of several attempts. */
export function pickFailure(
  failures: readonly NativePlaybackError[],
): NativePlaybackError {
  if (failures.length === 0) return new NativePlaybackError('unknown');
  return [...failures].sort(
    (left, right) =>
      failurePriority.indexOf(left.code) - failurePriority.indexOf(right.code),
  )[0];
}

export type NativePlayerErrorKind =
  | 'expired'
  | 'network'
  | 'unsupported'
  | 'unknown';

/**
 * Shaka reports HTTP failures as BAD_HTTP_STATUS (1001) with the status in `data[1]`; a 403/404/410
 * on a media request usually means the signed address expired or YouTube saw another client.
 */
export function classifyShakaError(error: {
  code: number;
  category?: number;
  data?: unknown[];
}): { kind: NativePlayerErrorKind; message: string } {
  const status =
    error.code === 1001 && typeof error.data?.[1] === 'number'
      ? error.data[1]
      : null;
  if (status === 403 || status === 404 || status === 410) {
    return {
      kind: 'expired',
      message: `YouTube 拒绝了媒体请求（HTTP ${status}）：播放地址可能已过期，或解析与取流使用了不同的网络出口。`,
    };
  }
  if (status === 429) {
    return {
      kind: 'network',
      message: 'YouTube 限制了请求频率（HTTP 429），请稍后重试。',
    };
  }
  if (error.code === 1002 || error.code === 1003 || status !== null) {
    return {
      kind: 'network',
      message: '读取媒体数据时网络出错，请检查网络或代理设置。',
    };
  }
  // 4xxx: manifest problems or no playable variant; 3016/3002: the decoder rejected the stream.
  if (
    (error.code >= 4000 && error.code < 5000) ||
    error.code === 3016 ||
    error.code === 3002
  ) {
    return {
      kind: 'unsupported',
      message: '当前 WebView 无法解码这个视频的编码格式。',
    };
  }
  return { kind: 'unknown', message: `播放器出错（代码 ${error.code}）。` };
}
