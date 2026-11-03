import type { EpubExamQuestion } from './epub-exams';
import type { ExamSourceSegment } from './epub-exam-source';

export type ExamMix = {
  objective: number;
  comprehensive: number;
  engineering: number;
  cProgramming: number;
};
export interface ExamBatch {
  sources: ExamSourceSegment[];
  mix: ExamMix;
}

export function defaultExamMix(count: number, cRelevant: boolean): ExamMix {
  const cProgramming = cRelevant ? Math.max(1, Math.round(count * 0.1)) : 0;
  const engineering = Math.round(count * 0.2);
  const comprehensive = Math.round(count * 0.3);
  return {
    objective: count - cProgramming - engineering - comprehensive,
    comprehensive,
    engineering,
    cProgramming,
  };
}

export function examMixTotal(mix: ExamMix): number {
  return mix.objective + mix.comprehensive + mix.engineering + mix.cProgramming;
}

function splitSegment(
  segment: ExamSourceSegment,
  limit = 7_000,
): ExamSourceSegment[] {
  if (segment.text.length <= limit) return [segment];
  const result: ExamSourceSegment[] = [];
  let offset = 0;
  while (offset < segment.text.length) {
    let end = Math.min(segment.text.length, offset + limit);
    if (end < segment.text.length) {
      const boundary = segment.text.lastIndexOf('\n', end);
      if (boundary > offset + limit / 2) end = boundary + 1;
    }
    result.push({ ...segment, text: segment.text.slice(offset, end) });
    offset = end;
  }
  return result;
}

export function makeExamBatches(
  segments: ExamSourceSegment[],
  mix: ExamMix,
): ExamBatch[] {
  const count = examMixTotal(mix);
  if (
    !count ||
    count > 50 ||
    Object.values(mix).some((value) => !Number.isInteger(value) || value < 0)
  ) {
    throw new Error('试卷题型数量无效。');
  }
  const chunks = segments.flatMap((segment) => splitSegment(segment));
  if (!chunks.length) throw new Error('当前范围没有可用于出题的正文。');
  const batchCount = Math.max(
    Math.ceil(count / 8),
    Math.ceil(chunks.length / 6),
  );
  if (batchCount > count)
    throw new Error(
      '正文过长，当前题数不足以覆盖全部片段。请增加题数或缩小范围。',
    );
  const remaining = { ...mix };
  let chunkOffset = 0;
  const keys = Object.keys(remaining) as Array<keyof ExamMix>;
  const batches: ExamBatch[] = [];
  for (let i = 0; i < batchCount; i++) {
    const slots = Math.min(
      8,
      Math.ceil(examMixTotal(remaining) / (batchCount - i)),
    );
    const batchMix: ExamMix = {
      objective: 0,
      comprehensive: 0,
      engineering: 0,
      cProgramming: 0,
    };
    for (let j = 0; j < slots; j++) {
      const key = [...keys].sort((a, b) => remaining[b] - remaining[a])[0];
      batchMix[key]++;
      remaining[key]--;
    }
    const batchesLeft = batchCount - i - 1;
    const chunksLeft = chunks.length - chunkOffset;
    const sourceCount = Math.min(
      6,
      slots,
      Math.max(1, chunksLeft - batchesLeft),
    );
    const sources =
      chunksLeft > 0
        ? chunks.slice(chunkOffset, chunkOffset + sourceCount)
        : [chunks[chunks.length - 1]];
    batches.push({
      sources,
      mix: batchMix,
    });
    chunkOffset += chunksLeft > 0 ? sources.length : 0;
  }
  if (chunkOffset !== chunks.length)
    throw new Error('正文分批未覆盖全部章节。');
  return batches;
}

export function validateGeneratedExam(
  questions: EpubExamQuestion[],
  mix: ExamMix,
  segments: ExamSourceSegment[],
) {
  if (questions.length !== examMixTotal(mix))
    throw new Error('生成的题数与设置不一致。');
  const actual: ExamMix = {
    objective: 0,
    comprehensive: 0,
    engineering: 0,
    cProgramming: 0,
  };
  const seen = new Set<string>();
  const covered = new Set<string>();
  for (const question of questions) {
    const key = question.prompt
      .normalize('NFKC')
      .replace(/\s+/g, '')
      .toLowerCase();
    if (seen.has(key))
      throw new Error('生成的试卷存在重复题目，请重试失败批次。');
    seen.add(key);
    if (question.type === 'comprehensive') actual.comprehensive++;
    else if (question.type === 'engineering') actual.engineering++;
    else if (question.type === 'cProgramming') actual.cProgramming++;
    else actual.objective++;
    question.sourceRefs?.forEach((ref) => covered.add(ref.href));
  }
  if (
    (Object.keys(mix) as Array<keyof ExamMix>).some(
      (key) => actual[key] !== mix[key],
    )
  ) {
    throw new Error('生成的题型配比与设置不一致。');
  }
  const missing = segments.find((segment) => !covered.has(segment.href));
  if (missing) throw new Error(`试卷未覆盖「${missing.label}」；请重试。`);
}
