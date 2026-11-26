import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { playerApi } from '../player/player-api';
import {
  computeLearningPathLayout,
  type PositionedPathNode,
} from '../player/learning-path-layout';
import LearningPathStarMapView from '../player/LearningPathStarMapView';
import {
  computeWatchedContentDelta,
  type WatchProgressTick,
} from '../player/player-heatmap-model';
import { inputFromItem } from '../player/queue';
import type {
  LearningPathDetail,
  LearningPathSummary,
  VideoItem,
} from '../player/types';
import YouTubePlayerPanel, {
  type PlayerProgress,
} from '../player/YouTubePlayerPanel';
import { isWorthSaving, startSecondsFor } from '../player/watch-state';

interface WatchingVideo {
  video: VideoItem;
  startSeconds: number;
  token: number;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function CompactVideoPlayer({
  watching,
  active,
  onBack,
  onSaved,
}: {
  watching: WatchingVideo;
  active: boolean;
  onBack: () => void;
  onSaved: () => void;
}) {
  const progressRef = useRef<PlayerProgress | null>(null);
  const tickRef = useRef<WatchProgressTick | null>(null);
  const pendingSecondsRef = useRef(0);
  const savedAtRef = useRef(0);
  const videoId = watching.video.videoId;

  const save = useCallback(() => {
    const progress = progressRef.current;
    const watchedDelta = pendingSecondsRef.current;
    if (
      !progress ||
      (!isWorthSaving(progress.seconds, progress.duration) && watchedDelta < 1)
    )
      return;
    pendingSecondsRef.current = 0;
    tickRef.current = null;
    savedAtRef.current = Date.now();
    void playerApi
      .saveProgress(
        videoId,
        progress.seconds,
        progress.duration,
        watchedDelta >= 0.5 ? watchedDelta : null,
      )
      .then(onSaved)
      .catch(() => undefined);
  }, [videoId, onSaved]);

  useEffect(() => () => save(), [save]);

  const onProgress = (progress: PlayerProgress) => {
    const now = Date.now();
    pendingSecondsRef.current += computeWatchedContentDelta(
      tickRef.current,
      videoId,
      progress.seconds,
      now,
      progress.playing,
    );
    tickRef.current = progress.playing
      ? { videoId, seconds: progress.seconds, wallMs: now }
      : null;
    progressRef.current = progress;
    if (!progress.playing || now - savedAtRef.current >= 12_000) save();
  };

  return (
    <div className="codelab-learning-watch">
      <div className="codelab-learning-watch-head">
        <button type="button" onClick={onBack}>
          ← 返回星图
        </button>
        <span title={watching.video.title}>{watching.video.title}</span>
      </div>
      <div className="codelab-learning-watch-body">
        <YouTubePlayerPanel
          key={watching.token}
          selection={{
            id: videoId,
            title: watching.video.title,
            startSeconds: watching.startSeconds,
          }}
          variant="page"
          active={active}
          pauseWhenHidden
          onProgress={onProgress}
          onEnded={save}
        />
      </div>
    </div>
  );
}

export function CodeLabLearningPlayer({ active }: { active: boolean }) {
  const [paths, setPaths] = useState<LearningPathSummary[]>([]);
  const [pathId, setPathId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LearningPathDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layout = useMemo(
    () =>
      detail ? computeLearningPathLayout(detail, {}, 'radial', 'curve') : null,
    [detail],
  );
  const [watching, setWatching] = useState<WatchingVideo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestRef = useRef(0);
  const playTokenRef = useRef(0);

  const refreshPaths = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const overview = await playerApi.overview();
      setPaths(overview.learningPaths);
    } catch (cause) {
      setError(errorMessage(cause, '读取学习路径失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshPaths();
  }, [refreshPaths]);

  const loadPath = useCallback(async (nextPathId: string) => {
    const request = ++requestRef.current;
    playTokenRef.current++;
    setPathId(nextPathId);
    setDetail(null);
    setSelectedId(null);
    setWatching(null);
    setLoading(true);
    setError('');
    try {
      const loaded = await playerApi.learningPathGet(nextPathId);
      if (request !== requestRef.current) return;
      if (!loaded) throw new Error('学习路径已不存在');
      setDetail(loaded);
    } catch (cause) {
      if (request === requestRef.current)
        setError(errorMessage(cause, '读取星图失败'));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  const playNode = useCallback(async (node: PositionedPathNode) => {
    if (!node.video) return;
    const video = node.video;
    const token = ++playTokenRef.current;
    setError('');
    try {
      const state = await playerApi.watchState(video.videoId).catch(() => null);
      if (token !== playTokenRef.current) return;
      const startSeconds =
        startSecondsFor(state) ||
        (node.node.startSeconds && !video.progressSeconds
          ? node.node.startSeconds
          : 0);
      setWatching({ video, startSeconds, token });
      void playerApi
        .markPlayed(video.videoId)
        .catch(() =>
          playerApi
            .storeVideos([inputFromItem(video)])
            .then(() => playerApi.markPlayed(video.videoId)),
        )
        .catch(() => undefined);
    } catch (cause) {
      setError(errorMessage(cause, '打开视频失败'));
    }
  }, []);

  const leaveVideo = useCallback(() => {
    setWatching(null);
  }, []);

  const refreshDetail = useCallback(() => {
    const request = requestRef.current;
    if (pathId)
      void playerApi
        .learningPathGet(pathId)
        .then((loaded) => {
          if (loaded && request === requestRef.current) setDetail(loaded);
        })
        .catch(() => undefined);
  }, [pathId]);

  return (
    <section className="codelab-learning-player" aria-label="学习路径播放器">
      {!pathId ? (
        <>
          <div className="codelab-learning-header">
            <div>
              <span>LEARNING / PATHS</span>
              <strong>选择学习路径</strong>
            </div>
            <button type="button" onClick={() => void refreshPaths()}>
              ↻ 刷新
            </button>
          </div>
          {loading && (
            <p className="codelab-learning-message">正在读取学习路径…</p>
          )}
          {!loading && !paths.length && (
            <p className="codelab-learning-message">
              暂无学习路径。可先在播放器中创建。
            </p>
          )}
          <div className="codelab-learning-path-list">
            {paths.map((path, index) => (
              <button
                key={path.pathId}
                type="button"
                className="codelab-learning-path"
                onClick={() => void loadPath(path.pathId)}
              >
                <span className="codelab-learning-path-index">
                  [{String(index + 1).padStart(2, '0')}]
                </span>
                <span className="codelab-learning-path-title">
                  <strong>{path.title}</strong>
                  <small>
                    {path.finishedCount}/{path.videoCount} 视频 ·{' '}
                    {path.nodeCount} 星点
                  </small>
                </span>
                <span className="codelab-learning-path-arrow">↗</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          {!watching && (
            <div className="codelab-learning-breadcrumb">
              <button
                type="button"
                onClick={() => {
                  requestRef.current++;
                  playTokenRef.current++;
                  setPathId(null);
                  setDetail(null);
                  setSelectedId(null);
                  void refreshPaths();
                }}
              >
                ← 学习路径
              </button>
              <span>/</span>
              <strong>{detail?.summary.title ?? '载入星图'}</strong>
            </div>
          )}
          {watching ? (
            <CompactVideoPlayer
              key={watching.token}
              watching={watching}
              active={active}
              onBack={leaveVideo}
              onSaved={refreshDetail}
            />
          ) : detail && layout ? (
            <div className="codelab-learning-map">
              <LearningPathStarMapView
                key={detail.summary.pathId}
                embedded
                detail={detail}
                layout={layout}
                selectedNodeId={selectedId}
                onSelectNode={setSelectedId}
                onPlayNode={(node) => void playNode(node)}
              />
            </div>
          ) : loading ? (
            <p className="codelab-learning-message">正在绘制星图…</p>
          ) : null}
        </>
      )}
      {error && (
        <div className="codelab-learning-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
