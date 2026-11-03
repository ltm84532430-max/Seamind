import { useMemo } from 'react';
import type { TranscriptCue } from './types';

export interface SubtitleOverlayProps {
  cues: TranscriptCue[];
  currentTime: number;
  visible?: boolean;
}

export default function SubtitleOverlay({
  cues,
  currentTime,
  visible = true,
}: SubtitleOverlayProps) {
  const activeCue = useMemo(() => {
    if (!visible || !cues.length) return null;
    return (
      cues.find((c) => currentTime >= c.start && currentTime <= c.end + 0.3) ??
      null
    );
  }, [cues, currentTime, visible]);

  if (!visible || !activeCue) return null;

  return (
    <div className="player-subtitle-overlay" aria-live="polite">
      <div className="player-subtitle-overlay-card">
        <p className="subtitle-overlay-orig">{activeCue.text}</p>
        {activeCue.translation && (
          <p className="subtitle-overlay-trans">{activeCue.translation}</p>
        )}
      </div>
    </div>
  );
}
