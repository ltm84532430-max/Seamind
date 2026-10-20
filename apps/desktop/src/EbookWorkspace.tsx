import { useMemo, useState } from 'react';
import type { EpubBookDocument, LibrarySnapshot } from './library';
import {
  clearEpubReaderData,
  epubProgressKey,
  loadEpubBookMetadata,
} from './ebook-storage';

type ShelfSort = 'recent' | 'title' | 'added';

export default function EbookWorkspace({
  snapshot,
  busy,
  onImport,
  onRefresh,
  onChooseRoot,
  onOpenBook,
  onDeleteBook,
}: {
  snapshot: LibrarySnapshot | null;
  busy: boolean;
  onImport: () => void;
  onRefresh: () => void;
  onChooseRoot: () => void;
  onOpenBook: (book: EpubBookDocument) => void;
  onDeleteBook: (book: EpubBookDocument) => Promise<void>;
}) {
  const books = snapshot?.books ?? [];
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<ShelfSort>('recent');
  const [deleteTarget, setDeleteTarget] = useState<EpubBookDocument | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState('');
  const [deletingPath, setDeletingPath] = useState('');

  const visibleBooks = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const rows = books
      .map((book) => ({
        book,
        metadata: loadEpubBookMetadata(epubProgressKey(book)),
      }))
      .filter(({ book, metadata }) => {
        if (!search) return true;
        return [
          book.title,
          metadata?.title,
          metadata?.author,
          book.relativePath,
          book.category,
        ]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase().includes(search));
      });

    if (sortBy === 'title') {
      return rows.sort((a, b) =>
        (a.metadata?.title || a.book.title).localeCompare(
          b.metadata?.title || b.book.title,
          'zh-CN',
        ),
      );
    }
    if (sortBy === 'added') {
      return rows.sort((a, b) => b.book.updatedAt - a.book.updatedAt);
    }
    return rows.sort(
      (a, b) =>
        (b.metadata?.lastReadAt ?? 0) - (a.metadata?.lastReadAt ?? 0) ||
        b.book.updatedAt - a.book.updatedAt,
    );
  }, [books, query, sortBy]);

  const confirmDelete = async () => {
    if (!deleteTarget || deletingPath) return;
    setDeletingPath(deleteTarget.relativePath);
    setDeleteError('');
    try {
      await onDeleteBook(deleteTarget);
      clearEpubReaderData(epubProgressKey(deleteTarget));
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingPath('');
    }
  };

  return (
    <main className="ebook-shelf" aria-label="电子书书架">
      <header className="ebook-shelf-header">
        <div>
          <span className="ebook-shelf-kicker">LOCAL LIBRARY · BOOKSHELF</span>
          <h1>电子书</h1>
          <p>
            {books.length
              ? `书架中有 ${books.length} 本 EPUB，阅读位置和书签会自动保存。`
              : '导入 EPUB 后会保存在当前文件库，下次打开仍可继续阅读。'}
          </p>
        </div>
        <div className="ebook-shelf-actions">
          <button type="button" onClick={onRefresh} disabled={busy}>
            刷新书架
          </button>
          <button
            type="button"
            className="ebook-shelf-import"
            onClick={onImport}
            disabled={busy || !snapshot?.rootPath}
            title={
              snapshot?.rootPath
                ? '导入 EPUB 并保存到文件库'
                : '请先选择文件库位置'
            }
          >
            {busy ? '正在导入…' : '导入 EPUB'}
          </button>
        </div>
      </header>

      {!snapshot?.rootPath ? (
        <section className="ebook-shelf-empty">
          <div className="ebook-shelf-empty-icon" aria-hidden="true">
            ▤
          </div>
          <h2>先选择书架存储位置</h2>
          <p>电子书会复制到该文件库的 books 文件夹中。</p>
          <button type="button" onClick={onChooseRoot}>
            选择文件库位置
          </button>
        </section>
      ) : books.length ? (
        <>
          <div className="ebook-shelf-toolbar">
            <label className="ebook-shelf-search">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索书名、作者或文件夹"
                aria-label="搜索电子书"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="清除搜索"
                >
                  ×
                </button>
              )}
            </label>
            <label className="ebook-shelf-sort">
              <span>排序</span>
              <select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as ShelfSort)}
              >
                <option value="recent">最近阅读</option>
                <option value="added">最近加入</option>
                <option value="title">书名</option>
              </select>
            </label>
          </div>

          {visibleBooks.length ? (
            <section className="ebook-shelf-grid" aria-label="已导入的电子书">
              {visibleBooks.map(({ book, metadata }, index) => {
                const title = metadata?.title || book.title;
                const progress = metadata?.progress ?? 0;
                return (
                  <article className="ebook-book-card" key={book.relativePath}>
                    <button
                      type="button"
                      className="ebook-book-open"
                      onClick={() => onOpenBook(book)}
                      title={`继续阅读 ${title}`}
                    >
                      <span
                        className={`ebook-book-cover cover-${index % 6}`}
                        aria-hidden="true"
                      >
                        {metadata?.coverDataUrl ? (
                          <img src={metadata.coverDataUrl} alt="" />
                        ) : (
                          <>
                            <span className="ebook-book-cover-mark">S</span>
                            <span className="ebook-book-cover-rule" />
                            <strong>{title}</strong>
                            <small>EPUB · SEAMIND</small>
                          </>
                        )}
                      </span>
                      <span className="ebook-book-title">{title}</span>
                      <span className="ebook-book-meta">
                        {metadata?.author ||
                          book.category ||
                          formatBookSize(book.fileSize)}
                      </span>
                      <span
                        className="ebook-book-progress"
                        aria-label={`阅读进度 ${Math.round(progress * 100)}%`}
                      >
                        <i
                          style={{ width: `${Math.round(progress * 100)}%` }}
                        />
                      </span>
                      <span className="ebook-book-date">
                        {metadata?.lastReadAt
                          ? `读至 ${Math.round(progress * 100)}%`
                          : `${formatBookSize(book.fileSize)} · ${formatBookDate(book.updatedAt)}`}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ebook-book-delete"
                      aria-label={`从书架删除 ${title}`}
                      title="删除此电子书"
                      onClick={() => {
                        setDeleteError('');
                        setDeleteTarget(book);
                      }}
                    >
                      ×
                    </button>
                  </article>
                );
              })}
            </section>
          ) : (
            <section className="ebook-shelf-empty ebook-shelf-no-results">
              <h2>没有找到匹配的电子书</h2>
              <p>试试书名、作者或文件夹名称。</p>
              <button type="button" onClick={() => setQuery('')}>
                清除搜索
              </button>
            </section>
          )}
        </>
      ) : (
        <section className="ebook-shelf-empty">
          <div className="ebook-shelf-empty-icon" aria-hidden="true">
            ＋
          </div>
          <h2>书架还是空的</h2>
          <p>选择 EPUB 文件后会复制到当前文件库，并显示在这里。</p>
          <button type="button" onClick={onImport} disabled={busy}>
            导入第一本电子书
          </button>
        </section>
      )}

      {deleteTarget && (
        <div
          className="ebook-delete-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deletingPath) {
              setDeleteTarget(null);
            }
          }}
        >
          <section
            className="ebook-delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ebook-delete-title"
          >
            <h2 id="ebook-delete-title">删除这本电子书？</h2>
            <p>
              “{deleteTarget.title}
              ”会从当前文件库中移除，已保存的阅读位置和书签也会清除。
            </p>
            {deleteError && (
              <p className="ebook-delete-error" role="alert">
                {deleteError}
              </p>
            )}
            <div>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={Boolean(deletingPath)}
              >
                取消
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => void confirmDelete()}
                disabled={Boolean(deletingPath)}
              >
                {deletingPath ? '正在删除…' : '确认删除'}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function formatBookSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatBookDate(timestamp: number) {
  if (!timestamp) return '已加入书架';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp * 1000));
}
