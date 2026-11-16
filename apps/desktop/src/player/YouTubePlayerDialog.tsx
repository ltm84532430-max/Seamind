import { useGlobalMediaOptional } from '../media/global-media-store';
import YouTubePlayerPanel from './YouTubePlayerPanel';
import type { YouTubePreviewSelection } from './YouTubePlayerPanel';

export type { YouTubePreviewSelection };

/**
 * The modal player opened from a mind map card. The player itself, with its three ways of playing
 * and their fallbacks, is `YouTubePlayerPanel`, which the player page uses as well.
 */
export default function YouTubePlayerDialog({
  selection,
  onClose,
}: {
  selection: YouTubePreviewSelection;
  onClose: () => void;
}) {
  const media = useGlobalMediaOptional();
  return (
    <YouTubePlayerPanel
      selection={selection}
      variant="dialog"
      onStatusChange={(status) => {
        if (status === 'playing') {
          media?.pauseActiveMedia();
        }
      }}
      onClose={onClose}
    />
  );
}
