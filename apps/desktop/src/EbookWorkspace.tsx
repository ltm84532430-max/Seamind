import type { EpubBookDocument, LibrarySnapshot } from './library';

export default function EbookWorkspace({
  snapshot,
  busy,
  onImport,
  onRefresh,
  onChooseRoot,
  onOpenBook,
}: {
  snapshot: LibrarySnapshot | null;
  busy: boolean;
  onImport: () => void;
  onRefresh: () => void;
  onChooseRoot: () => void;
  onOpenBook: (book: EpubBookDocument) => void;
}) {
  const books = snapshot?.books ?? [];

  return (
    <main className="ebook-shelf" aria-label="电子书书架">
      <header className="ebook-shelf-header">
        <div>
          <span className="ebook-shelf-kicker">LOCAL LIBRARY · BOOKSHELF</span>
          <h1>电子书</h1>
          <p>
            {books.length
              ? `书架中有 ${books.length} 本 EPUB，阅读位置会自动保存。`
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
        <section className="ebook-shelf-grid" aria-label="已导入的电子书">
          {books.map((book, index) => (
            <button
              type="button"
              className="ebook-book-card"
              key={book.relativePath}
              onClick={() => onOpenBook(book)}
              title={`继续阅读 ${book.title}`}
            >
              <span
                className={`ebook-book-cover cover-${index % 6}`}
                aria-hidden="true"
              >
                <span className="ebook-book-cover-mark">S</span>
                <span className="ebook-book-cover-rule" />
                <strong>{book.title}</strong>
                <small>EPUB · SEAMIND</small>
              </span>
              <span className="ebook-book-title">{book.title}</span>
              <span className="ebook-book-meta">
                {formatBookSize(book.fileSize)} ·{' '}
                {formatBookDate(book.updatedAt)}
              </span>
            </button>
          ))}
        </section>
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
