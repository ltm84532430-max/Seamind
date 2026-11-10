import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { FeedArticle } from './types';
import {
  extractFeedBlockTexts,
  hashFeedBlocks,
} from './feed-translation-blocks';
import {
  clearFeedTranslationNodes,
  paintFeedTranslations,
} from './feed-translation-dom';
import {
  deleteFeedArticleTranslation,
  FeedTranslationCancelled,
  feedTranslationErrorMessage,
  getFeedArticleTranslation,
  saveFeedArticleTranslation,
  translateFeedBlocks,
  type FeedArticleTranslationRecord,
  type FeedProviderSettings,
} from './feed-translation-api';

const VISIBILITY_KEY = 'seamind:feed:bilingual-visible';

export type FeedArticleTranslationPhase =
  | 'none'
  | 'empty'
  | 'ready'
  | 'stale'
  | 'unplaced';

function readBilingualVisible(): boolean {
  try {
    return localStorage.getItem(VISIBILITY_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeBilingualVisible(visible: boolean) {
  try {
    localStorage.setItem(VISIBILITY_KEY, String(visible));
  } catch {
    // The translation boxes still follow the in-memory toggle.
  }
}

export function useFeedArticleTranslation(options: {
  article: FeedArticle | null;
  provider: FeedProviderSettings;
  wrapRef: RefObject<HTMLElement | null>;
  translationEpoch: number;
  channelBusy: boolean;
  onTranslated: (articleId: string) => void;
  onCleared: (articleId: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const {
    article,
    provider,
    wrapRef,
    translationEpoch,
    channelBusy,
    onTranslated,
    onCleared,
    onBusyChange,
  } = options;
  const [phase, setPhase] = useState<FeedArticleTranslationPhase>('none');
  const [notice, setNotice] = useState('');
  const [translating, setTranslating] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [bilingual, setBilingual] = useState(readBilingualVisible);
  const recordRef = useRef<FeedArticleTranslationRecord | null>(null);
  const textsRef = useRef<string[]>([]);
  const hashRef = useRef('');
  const cancelRef = useRef(false);
  const runRef = useRef(0);
  const articleRef = useRef(article);
  const onTranslatedRef = useRef(onTranslated);
  articleRef.current = article;
  onTranslatedRef.current = onTranslated;

  const paint = useCallback(
    (
      root: HTMLElement,
      texts: string[],
      record: FeedArticleTranslationRecord,
    ) => {
      const visible = readBilingualVisible();
      setBilingual(visible);
      const placed = paintFeedTranslations(
        root,
        texts,
        record.paragraphs,
        visible,
      );
      if (!placed) {
        setPhase('unplaced');
        setNotice('译文已保存，这次没能挂到段落旁边。');
        return false;
      }
      setPhase('ready');
      return true;
    },
    [],
  );

  useEffect(() => {
    const current = article;
    const root = wrapRef.current;
    if (!current || !root) return;
    let cancelled = false;
    setNotice('');
    void (async () => {
      try {
        clearFeedTranslationNodes(root);
        root.classList.remove('seamind-bilingual-hidden');
        const texts = extractFeedBlockTexts({
          title: current.title,
          contentHtml: current.content,
          summary: current.summary,
        });
        textsRef.current = texts;
        if (texts.length === 0) {
          if (!cancelled) setPhase('empty');
          return;
        }
        const hash = await hashFeedBlocks(texts);
        if (cancelled) return;
        hashRef.current = hash;
        const saved = await getFeedArticleTranslation(current.id);
        if (cancelled || articleRef.current?.id !== current.id) return;
        recordRef.current = saved;
        if (
          saved &&
          saved.contentHash === hash &&
          saved.paragraphs.length > 0
        ) {
          if (paint(root, texts, saved)) setNotice('已加载已保存的译文。');
          onTranslatedRef.current(current.id);
          return;
        }
        if (saved) {
          setPhase('stale');
          setNotice('原文已更新，需要重新翻译。');
          return;
        }
        setPhase('none');
      } catch (error) {
        if (!cancelled) {
          setNotice(`读取译文失败：${feedTranslationErrorMessage(error)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    article?.id,
    article?.content,
    article?.title,
    article?.summary,
    translationEpoch,
    paint,
    wrapRef,
  ]);

  const translate = useCallback(
    async (force = false) => {
      const current = articleRef.current;
      const root = wrapRef.current;
      if (!current || !root || translating || channelBusy) return;
      if (!provider.baseUrl.trim() || !provider.model.trim()) {
        setNotice('请先在模型设置中填写 API 地址和模型名称。');
        return;
      }
      const myRun = runRef.current + 1;
      runRef.current = myRun;
      cancelRef.current = false;
      setTranslating(true);
      onBusyChange(true);
      try {
        const texts = extractFeedBlockTexts({
          title: current.title,
          contentHtml: current.content,
          summary: current.summary,
        });
        textsRef.current = texts;
        if (texts.length === 0) {
          setPhase('empty');
          setNotice('没有可翻译的正文。');
          return;
        }
        const hash = await hashFeedBlocks(texts);
        hashRef.current = hash;
        if (cancelRef.current || runRef.current !== myRun) return;
        if (!force) {
          const saved = await getFeedArticleTranslation(current.id);
          if (
            saved &&
            saved.contentHash === hash &&
            saved.paragraphs.length > 0 &&
            runRef.current === myRun
          ) {
            recordRef.current = saved;
            if (paint(root, texts, saved)) setNotice('已加载已保存的译文。');
            onTranslated(current.id);
            return;
          }
        }
        setProgress({ done: 0, total: texts.length });
        setNotice(`开始逐段翻译（共 ${texts.length} 段）…`);
        const paragraphs = await translateFeedBlocks({
          channelTitle: current.channelTitle,
          articleTitle: current.title,
          texts,
          provider,
          shouldCancel: () => cancelRef.current || runRef.current !== myRun,
          onProgress: (done, total) => {
            if (runRef.current === myRun) setProgress({ done, total });
          },
        });
        if (cancelRef.current || runRef.current !== myRun) {
          setNotice('已取消翻译。');
          return;
        }
        const saved = await saveFeedArticleTranslation({
          articleId: current.id,
          channelId: current.channelId,
          title: current.title,
          contentHash: hash,
          model: provider.model,
          paragraphs,
        });
        if (runRef.current !== myRun || articleRef.current?.id !== current.id) {
          return;
        }
        recordRef.current = saved;
        onTranslated(current.id);
        if (paint(root, texts, saved)) {
          setNotice(`翻译完成并已保存（共 ${paragraphs.length} 段）。`);
        }
      } catch (error) {
        if (runRef.current !== myRun) return;
        if (error instanceof FeedTranslationCancelled) {
          setNotice('已取消翻译。已完成的段落没有写入这篇文章。');
          return;
        }
        setNotice(`翻译失败：${feedTranslationErrorMessage(error)}`);
      } finally {
        if (runRef.current === myRun) {
          setTranslating(false);
          onBusyChange(false);
        }
      }
    },
    [
      channelBusy,
      onBusyChange,
      onTranslated,
      paint,
      provider,
      translating,
      wrapRef,
    ],
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const toggleBilingual = useCallback(() => {
    const root = wrapRef.current;
    const next = !bilingual;
    setBilingual(next);
    writeBilingualVisible(next);
    root?.classList.toggle('seamind-bilingual-hidden', !next);
  }, [bilingual, wrapRef]);

  const copyTranslation = useCallback(async () => {
    const text = (recordRef.current?.paragraphs ?? [])
      .map((item) => item.translation.trim())
      .filter(Boolean)
      .join('\n\n');
    if (!text) {
      setNotice('当前文章暂无译文可复制。');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice('译文已复制。');
    } catch {
      setNotice('复制失败，请重试。');
    }
  }, []);

  const clearTranslation = useCallback(async () => {
    const current = articleRef.current;
    const root = wrapRef.current;
    if (!current) return;
    try {
      await deleteFeedArticleTranslation(current.id);
      recordRef.current = null;
      if (root) {
        clearFeedTranslationNodes(root);
        root.classList.remove('seamind-bilingual-hidden');
      }
      setPhase('none');
      setNotice('译文已清除。');
      onCleared(current.id);
    } catch (error) {
      setNotice(`清除译文失败：${feedTranslationErrorMessage(error)}`);
    }
  }, [onCleared, wrapRef]);

  return {
    phase,
    notice,
    translating,
    progress,
    bilingual,
    translate,
    cancel,
    toggleBilingual,
    copyTranslation,
    clearTranslation,
  };
}
