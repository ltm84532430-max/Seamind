import { literatureApi } from './literature-api';
import { readProviderSettings } from '../app/app-storage';
import {
  computePageContentHash,
  isShortTermSelection,
  type PaperParagraphBlock,
} from './paper-pdf-layout';
import {
  getCachedSelectionTranslation,
  getPaperPageTranslation,
  savePaperPageTranslation,
  setCachedSelectionTranslation,
  type DualPdfResult,
  type PaperPageTranslationRecord,
  type PaperSelectionTranslation,
  type Pdf2ZhStatus,
  type TranslatedPaperParagraph,
} from './paper-translation-store';

export interface TranslateSelectionOptions {
  pdfSha256: string;
  paperTitle: string;
  text: string;
  mode?: 'auto' | 'word' | 'passage';
  contextBefore?: string | null;
  contextAfter?: string | null;
  force?: boolean;
}

export interface TranslatePageOptions {
  paperTitle: string;
  pdfSha256: string;
  pageNumber: number;
  blocks: PaperParagraphBlock[];
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}

function getEffectiveProvider(): { baseUrl: string; model: string } {
  const settings = readProviderSettings();
  const baseUrl = settings.baseUrl.trim();
  const model = settings.model.trim();
  if (!baseUrl || !model) {
    throw new Error(
      '请先在设置中配置模型 API 地址与模型名称后再使用翻译功能。',
    );
  }
  return { baseUrl, model };
}

export async function translatePaperSelection(
  options: TranslateSelectionOptions,
): Promise<PaperSelectionTranslation> {
  const resolvedMode: 'word' | 'passage' =
    options.mode && options.mode !== 'auto'
      ? options.mode
      : isShortTermSelection(options.text)
        ? 'word'
        : 'passage';

  if (!options.force && options.pdfSha256) {
    const cached = getCachedSelectionTranslation(
      options.pdfSha256,
      resolvedMode,
      options.text,
    );
    if (cached) return cached;
  }

  const provider = getEffectiveProvider();
  const result = await literatureApi.translateSelection({
    baseUrl: provider.baseUrl,
    model: provider.model,
    paperTitle: options.paperTitle,
    text: options.text,
    mode: resolvedMode,
    contextBefore: options.contextBefore ?? null,
    contextAfter: options.contextAfter ?? null,
  });

  if (options.pdfSha256) {
    setCachedSelectionTranslation(
      options.pdfSha256,
      resolvedMode,
      options.text,
      result,
    );
  }
  return result;
}

export async function translatePaperPage(
  options: TranslatePageOptions,
): Promise<PaperPageTranslationRecord> {
  const {
    paperTitle,
    pdfSha256,
    pageNumber,
    blocks,
    force = false,
    onProgress,
    isCancelled,
  } = options;

  if (blocks.length === 0) {
    throw new Error(`第 ${pageNumber} 页未识别出可翻译的段落文本。`);
  }

  const pageContentHash = await computePageContentHash(blocks);
  if (!force && pdfSha256) {
    const existing = await getPaperPageTranslation(pdfSha256, pageNumber);
    if (
      existing &&
      existing.pageContentHash === pageContentHash &&
      existing.paragraphs.length > 0
    ) {
      onProgress?.(blocks.length, blocks.length);
      return existing;
    }
  }

  const provider = getEffectiveProvider();
  const total = blocks.length;
  const batchSize = 10;
  const allTranslations: TranslatedPaperParagraph[] = [];

  onProgress?.(0, total);

  for (let i = 0; i < total; i += batchSize) {
    if (isCancelled?.()) {
      throw new Error('已取消翻译。');
    }
    const batch = blocks.slice(i, i + batchSize).map((block) => ({
      id: block.id,
      text: block.text,
    }));

    let batchResult: TranslatedPaperParagraph[] = [];
    let attempt = 0;
    const maxAttempts = 2;

    while (attempt < maxAttempts) {
      try {
        batchResult = await literatureApi.translateParagraphs({
          baseUrl: provider.baseUrl,
          model: provider.model,
          paperTitle,
          pageNumber,
          paragraphs: batch,
        });
        break;
      } catch (err) {
        attempt += 1;
        if (attempt >= maxAttempts || isCancelled?.()) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    if (isCancelled?.()) {
      throw new Error('已取消翻译。');
    }

    allTranslations.push(...batchResult);
    onProgress?.(Math.min(i + batch.length, total), total);
  }

  return savePaperPageTranslation(
    pdfSha256,
    pageNumber,
    pageContentHash,
    provider.model,
    allTranslations,
  );
}

export async function checkPdf2ZhStatus(): Promise<Pdf2ZhStatus> {
  return literatureApi.pdf2zhStatus();
}

export async function generateBilingualPaperPdf(
  paperId: string,
  options?: { service?: string; force?: boolean },
): Promise<DualPdfResult> {
  let settings = { baseUrl: '', model: '' };
  try {
    settings = readProviderSettings();
  } catch {
    // Optional for non-OpenAI services like bing
  }
  return literatureApi.generateBilingualPdf({
    paperId,
    service: options?.service ?? null,
    baseUrl: settings.baseUrl || null,
    model: settings.model || null,
    force: options?.force ?? false,
  });
}
