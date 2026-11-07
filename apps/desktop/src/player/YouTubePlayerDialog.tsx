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
  return (
    <YouTubePlayerPanel
      selection={selection}
      variant="dialog"
      onClose={onClose}
    />
  );
}
