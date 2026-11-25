import { convertFileSrc } from '@tauri-apps/api/core';
import { libraryApi } from '../library/library-api';
import type { PdfBookDocument } from '../library/library';

const DB_NAME = 'seamind_pdf_book_covers';
const STORE_NAME = 'covers';
const COVER_VERSION = 1;
const MAX_ACTIVE_RENDERS = 2;
const MAX_SESSION_COVERS = 64;

interface CoverRecord {
  key: string;
  signature: string;
  dataUrl: string;
}

let databasePromise: Promise<IDBDatabase> | null = null;
let activeRenders = 0;
const renderQueue: Array<() => void> = [];
const inFlight = new Map<string, Promise<string | null>>();
const sessionCovers = new Map<string, string>();

function bookKey(rootPath: string, relativePath: string) {
  return `${rootPath}\u0000${relativePath}`;
}

function bookSignature(book: PdfBookDocument) {
  return `${COVER_VERSION}:${book.fileSize}:${book.updatedAt}`;
}

function rememberCover(key: string, dataUrl: string) {
  sessionCovers.delete(key);
  sessionCovers.set(key, dataUrl);
  if (sessionCovers.size > MAX_SESSION_COVERS) {
    sessionCovers.delete(sessionCovers.keys().next().value!);
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, COVER_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function readCachedCover(key: string, signature: string) {
  try {
    const database = await openDatabase();
    return await new Promise<string | null>((resolve) => {
      const request = database
        .transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .get(key);
      request.onsuccess = () => {
        const record = request.result as CoverRecord | undefined;
        resolve(
          record?.signature === signature &&
            record.dataUrl.startsWith('data:image/jpeg;base64,')
            ? record.dataUrl
            : null,
        );
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeCachedCover(record: CoverRecord) {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve) => {
      const request = database
        .transaction(STORE_NAME, 'readwrite')
        .objectStore(STORE_NAME)
        .put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  } catch {
    // A disabled cache must not hide a successfully rendered cover.
  }
}

function scheduleRender<T>(render: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = () => {
      activeRenders += 1;
      void render()
        .then(resolve, reject)
        .finally(() => {
          activeRenders -= 1;
          renderQueue.shift()?.();
        });
    };
    if (activeRenders < MAX_ACTIVE_RENDERS) start();
    else renderQueue.push(start);
  });
}

async function renderFirstPage(relativePath: string): Promise<string> {
  const [{ GlobalWorkerOptions, getDocument }, { default: workerUrl }] =
    await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
  GlobalWorkerOptions.workerSrc = workerUrl;
  const opened = await libraryApi.openPdfBook({ relativePath });
  const task = getDocument({ url: convertFileSrc(opened.path) });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const naturalSize = page.getViewport({ scale: 1 });
    const scale = Math.min(320 / naturalSize.width, 460 / naturalSize.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('无法创建 PDF 封面画布');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    await task.destroy();
  }
}

/** Generate covers for existing and newly imported PDF books on demand. */
export function loadPdfBookCover(rootPath: string, book: PdfBookDocument) {
  const key = bookKey(rootPath, book.relativePath);
  const signature = bookSignature(book);
  const requestKey = `${key}\u0000${signature}`;
  const sessionCover = sessionCovers.get(requestKey);
  if (sessionCover) return Promise.resolve(sessionCover);
  const pending = inFlight.get(requestKey);
  if (pending) return pending;
  const request = (async () => {
    const cached = await readCachedCover(key, signature);
    if (cached) {
      rememberCover(requestKey, cached);
      return cached;
    }
    try {
      const dataUrl = await scheduleRender(() =>
        renderFirstPage(book.relativePath),
      );
      rememberCover(requestKey, dataUrl);
      await writeCachedCover({ key, signature, dataUrl });
      return dataUrl;
    } catch {
      // A damaged, encrypted, or unreadable PDF keeps the text fallback.
      return null;
    }
  })().finally(() => inFlight.delete(requestKey));
  inFlight.set(requestKey, request);
  return request;
}

export async function clearPdfBookCover(
  rootPath: string,
  relativePath: string,
) {
  const key = bookKey(rootPath, relativePath);
  for (const requestKey of sessionCovers.keys()) {
    if (requestKey.startsWith(`${key}\u0000`)) sessionCovers.delete(requestKey);
  }
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve) => {
      const request = database
        .transaction(STORE_NAME, 'readwrite')
        .objectStore(STORE_NAME)
        .delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  } catch {
    // Removing a book should still succeed if thumbnail storage is unavailable.
  }
}
