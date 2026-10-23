import { useState } from 'react';
import { avatarHue, initialOf } from './format';

/** The only hosts the app's content security policy lets a channel picture come from. */
const PICTURE_HOSTS = new Set(['yt3.googleusercontent.com', 'yt3.ggpht.com']);

function usablePicture(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && PICTURE_HOSTS.has(parsed.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

/** A channel's picture, or a round badge with its first letter when it has none or it does not load. */
export default function Avatar({
  name,
  url,
  size = 28,
}: {
  name: string;
  url: string | null | undefined;
  size?: number;
}) {
  const picture = usablePicture(url);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showPicture = picture !== null && picture !== failedUrl;
  return (
    <span
      className="player-avatar"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.46),
        background: showPicture ? undefined : `hsl(${avatarHue(name)} 34% 42%)`,
      }}
      aria-hidden="true"
    >
      {showPicture ? (
        <img
          src={picture}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(picture)}
        />
      ) : (
        initialOf(name)
      )}
    </span>
  );
}
