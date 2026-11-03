import { useEffect, useMemo, useState } from 'react';
import { usePlayerHost } from './host';
import { playerApi, errorText } from './player-api';
import { firstUnfinished, withOverlay } from './queue';
import { FAVORITES_ID, WATCH_LATER_ID } from './types';
import type { VideoItem } from './types';
import { useLoad } from './use-load';
import VideoList, { StateMessage, ViewHeader } from './VideoList';
import { describeDataError, fetchPlaylist } from './youtube-data';

export type Collection =
  | { kind: 'favorites' }
  | { kind: 'watch-later' }
  | { kind: 'history' }
  | { kind: 'course'; playlistId: string };

const HISTORY_LIMIT = 300;

const copy = {
  favorites: {
    title: '收藏',
    empty: '还没有收藏的视频',
    hint: '点击视频旁边的星标，把它收藏到这里。',
  },
  'watch-later': {
    title: '稍后看',
    empty: '稍后看是空的',
    hint: '点击视频旁边的钟表，把它留到以后再看。',
  },
  history: {
    title: '观看历史',
    empty: '还没有观看记录',
    hint: '播放过的视频会按时间记在这里。',
  },
} as const;

function loadCollection(collection: Collection): Promise<VideoItem[]> {
  switch (collection.kind) {
    case 'favorites':
      return playerApi.playlistItems(FAVORITES_ID);
    case 'watch-later':
      return playerApi.playlistItems(WATCH_LATER_ID);
    case 'history':
      return playerApi.history(HISTORY_LIMIT);
    case 'course':
      return playerApi.playlistItems(collection.playlistId);
  }
}

const COURSE_INTRO_STORAGE_PREFIX = 'seamind:course-intro:v1:';

function CourseIntroBanner({
  courseKey,
  courseTitle,
}: {
  courseKey: string;
  courseTitle: string;
}) {
  const storageKey = `${COURSE_INTRO_STORAGE_PREFIX}${courseKey}`;
  const [intro, setIntro] = useState<string>(() => {
    try {
      return window.localStorage.getItem(storageKey) || '';
    } catch {
      return '';
    }
  });
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(intro);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey) || '';
      setIntro(saved);
      setDraft(saved);
      setIsEditing(false);
    } catch {
      setIntro('');
      setDraft('');
      setIsEditing(false);
    }
  }, [storageKey]);

  const handleSave = () => {
    const trimmed = draft.trim();
    try {
      if (trimmed) {
        window.localStorage.setItem(storageKey, trimmed);
      } else {
        window.localStorage.removeItem(storageKey);
      }
      setIntro(trimmed);
      setIsEditing(false);
    } catch {
      // ignore
    }
  };

  const handleCancel = () => {
    setDraft(intro);
    setIsEditing(false);
  };

  const handleClear = () => {
    if (window.confirm(`清空课程“${courseTitle}”的手动介绍？`)) {
      try {
        window.localStorage.removeItem(storageKey);
        setIntro('');
        setDraft('');
        setIsEditing(false);
      } catch {
        // ignore
      }
    }
  };

  if (isEditing) {
    return (
      <div className="player-course-intro is-editing">
        <div className="player-course-intro-head">
          <span className="player-course-intro-tag">编辑课程介绍</span>
          <span className="player-course-intro-hint">
            支持换行与重点大纲，Ctrl + Enter 快速保存
          </span>
        </div>
        <textarea
          className="player-course-intro-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="在此输入课程背景介绍、先修知识、核心章节大纲或学习备忘…"
          rows={4}
          autoFocus
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              handleSave();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              handleCancel();
            }
          }}
        />
        <div className="player-course-intro-actions">
          <button
            type="button"
            className="player-button is-primary"
            onClick={handleSave}
          >
            保存介绍
          </button>
          <button
            type="button"
            className="player-button"
            onClick={handleCancel}
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  if (!intro) {
    return (
      <div
        className="player-course-intro is-empty"
        onClick={() => {
          setDraft('');
          setIsEditing(true);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsEditing(true);
          }
        }}
        title="点击为此课程添加手动介绍与备忘"
      >
        <span className="player-course-intro-empty-label">
          + 添加课程介绍 / 学习目标与大纲备忘…
        </span>
      </div>
    );
  }

  return (
    <div className="player-course-intro is-saved">
      <div className="player-course-intro-head">
        <span className="player-course-intro-tag">课程简介与备忘</span>
        <div className="player-course-intro-tools">
          <button
            type="button"
            className="player-course-intro-tool-btn"
            onClick={() => {
              setDraft(intro);
              setIsEditing(true);
            }}
          >
            编辑介绍
          </button>
          <button
            type="button"
            className="player-course-intro-tool-btn is-danger"
            onClick={handleClear}
          >
            清空
          </button>
        </div>
      </div>
      <div className="player-course-intro-content">{intro}</div>
    </div>
  );
}

/** Favorites, watch later, the history and a course: lists the app keeps for the user. */
export default function CollectionView({
  collection,
}: {
  collection: Collection;
}) {
  const host = usePlayerHost();
  const list = useLoad(() => loadCollection(collection));
  const [busy, setBusy] = useState(false);
  const items = list.data ?? [];
  const course =
    collection.kind === 'course'
      ? host.playlists.find(
          (playlist) => playlist.playlistId === collection.playlistId,
        )
      : undefined;
  const title =
    collection.kind === 'course'
      ? (course?.name ?? '课程')
      : copy[collection.kind].title;

  const shown = useMemo(
    () => withOverlay(items, host.overlay),
    [items, host.overlay],
  );
  const finished = shown.filter((item) => item.finished).length;
  const resume = collection.kind === 'course' ? firstUnfinished(shown) : null;

  let subtitle = `${items.length} 个视频`;
  if (collection.kind === 'course') {
    subtitle = `已看完 ${finished}/${items.length}`;
    if (course?.channelName) subtitle += ` · ${course.channelName}`;
  }

  const removeFromHistory = (item: VideoItem) => {
    list.setData((current) =>
      current
        ? current.filter((entry) => entry.videoId !== item.videoId)
        : current,
    );
    playerApi.removeFromHistory(item.videoId).catch((error: unknown) => {
      host.notify(errorText(error, '无法移除这条记录'), 'error');
      list.reload();
    });
  };

  const clearHistory = async () => {
    if (!window.confirm('清空全部观看历史？观看进度会保留。')) return;
    try {
      await playerApi.clearHistory();
      list.setData(() => []);
    } catch (error) {
      host.notify(errorText(error, '无法清空历史'), 'error');
    }
  };

  const syncCourse = async () => {
    if (collection.kind !== 'course' || !course?.remoteId || busy) return;
    setBusy(true);
    try {
      const listing = await fetchPlaylist(course.remoteId);
      await playerApi.saveCourse(
        course.remoteId,
        listing.title,
        listing.channelName,
        listing.videos,
      );
      await host.reloadOverview();
      list.reload();
      host.notify(
        listing.truncated
          ? `已同步，列表很长，只保留了前 ${listing.videos.length} 个视频。`
          : `已同步，共 ${listing.videos.length} 个视频。`,
      );
    } catch (error) {
      host.notify(describeDataError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const deleteCourse = async () => {
    if (collection.kind !== 'course' || !course) return;
    if (
      !window.confirm(
        `删除课程“${course.name}”？观看进度和历史会保留，只是不再列在课程里。`,
      )
    )
      return;
    try {
      await playerApi.deletePlaylist(course.playlistId);
      await host.reloadOverview();
      host.go({ kind: 'feed' });
    } catch (error) {
      host.notify(errorText(error, '无法删除课程'), 'error');
    }
  };

  const open = (item: VideoItem) => host.openVideo(item, { title, items });

  return (
    <section className="player-view" aria-label={title}>
      <ViewHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {collection.kind === 'course' && resume && (
              <button
                type="button"
                className="player-button is-primary"
                onClick={() => open(resume)}
                title={resume.title}
              >
                {finished > 0 ? '继续学习' : '开始学习'}
              </button>
            )}
            {collection.kind === 'course' && course?.remoteId && (
              <button
                type="button"
                className="player-button"
                disabled={busy}
                onClick={() => void syncCourse()}
                title="重新读取这个 YouTube 播放列表，加入新增的视频"
              >
                {busy ? '正在同步…' : '同步列表'}
              </button>
            )}
            {collection.kind === 'course' && course && (
              <button
                type="button"
                className="player-button is-danger"
                onClick={() => void deleteCourse()}
              >
                删除课程
              </button>
            )}
            {collection.kind === 'history' && items.length > 0 && (
              <button
                type="button"
                className="player-button is-danger"
                onClick={() => void clearHistory()}
              >
                清空历史
              </button>
            )}
          </>
        }
      />
      <div className="player-view-body">
        {collection.kind === 'course' && (
          <CourseIntroBanner
            courseKey={
              course?.remoteId || course?.playlistId || collection.playlistId
            }
            courseTitle={title}
          />
        )}
        {list.error && (
          <StateMessage
            kind="error"
            title="无法读取列表"
            action={
              <button
                type="button"
                className="player-button"
                onClick={list.reload}
              >
                重试
              </button>
            }
          >
            {list.error}
          </StateMessage>
        )}
        {!list.error && list.data === null && (
          <StateMessage kind="loading" title="正在读取…" />
        )}
        {!list.error && list.data !== null && items.length === 0 && (
          <StateMessage
            kind="empty"
            title={
              collection.kind === 'course'
                ? '课程里没有视频'
                : copy[collection.kind].empty
            }
          >
            {collection.kind === 'course'
              ? '可以点“同步列表”重新读取这个播放列表。'
              : copy[collection.kind].hint}
          </StateMessage>
        )}
        {items.length > 0 && (
          <VideoList
            items={items}
            queueTitle={title}
            onRemove={
              collection.kind === 'history'
                ? { label: '移除', run: removeFromHistory }
                : undefined
            }
          />
        )}
      </div>
    </section>
  );
}
