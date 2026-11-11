import type { EpubExamQuestion, EpubExamQuestionType } from './epub-exams';

export type ExamChoiceLayout = 'stack' | 'pair' | 'row';

export interface ExamPaperItem {
  question: EpubExamQuestion;
  number: number;
  points: number;
  showPoints: boolean;
  choiceKeys: Array<string | null>;
  choiceLayout: ExamChoiceLayout;
  answerLines: number;
}

export interface ExamPaperSection {
  type: EpubExamQuestionType;
  ordinal: string;
  title: string;
  instruction: string;
  questionCount: number;
  totalPoints: number;
  items: ExamPaperItem[];
}

export interface ExamPaper {
  bookTitle: string;
  scopeLabel: string;
  questionCount: number;
  totalPoints: number;
  sections: ExamPaperSection[];
}

const SECTION_ORDER: EpubExamQuestionType[] = [
  'singleChoice',
  'multipleChoice',
  'trueFalse',
  'shortAnswer',
  'comprehensive',
  'engineering',
  'cProgramming',
];

const SECTION_TITLE: Record<EpubExamQuestionType, string> = {
  singleChoice: '单项选择题',
  multipleChoice: '多项选择题',
  trueFalse: '判断题',
  shortAnswer: '简答题',
  comprehensive: '综合题',
  engineering: '工程应用题',
  cProgramming: 'C 语言编程题',
};

const ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

export function pointsOf(question: EpubExamQuestion): number {
  if (question.points && question.points > 0) return question.points;
  if (question.type === 'engineering' || question.type === 'cProgramming') {
    return 12;
  }
  if (question.type === 'comprehensive' || question.type === 'shortAnswer') {
    return 8;
  }
  return 2;
}

export function choiceTexts(question: EpubExamQuestion): string[] {
  if (question.type === 'trueFalse') {
    return question.options?.length ? question.options : ['正确', '错误'];
  }
  return question.options ?? [];
}

export function choiceKeysFor(
  type: EpubExamQuestionType,
  count: number,
): Array<string | null> {
  if (type === 'trueFalse') return Array.from({ length: count }, () => null);
  return Array.from({ length: count }, (_, index) =>
    String.fromCharCode(65 + index),
  );
}

export function choiceLayoutFor(
  type: EpubExamQuestionType,
  options: readonly string[],
): ExamChoiceLayout {
  if (type === 'trueFalse') return 'pair';
  if (!options.length) return 'stack';
  const longest = options.reduce(
    (max, option) => Math.max(max, Array.from(option).length),
    0,
  );
  if (longest > 22) return 'stack';
  if (longest > 8 || options.length > 4) return 'pair';
  return 'row';
}

export function answerLineCount(type: EpubExamQuestionType): number {
  if (type === 'shortAnswer') return 4;
  if (type === 'comprehensive' || type === 'engineering') return 6;
  return 0;
}

function sectionInstruction(points: number[]): string {
  const total = points.reduce((sum, value) => sum + value, 0);
  const uniform = points.every((value) => value === points[0]);
  if (uniform) {
    return `本大题共 ${points.length} 小题，每小题 ${points[0]} 分，共 ${total} 分。`;
  }
  return `本大题共 ${points.length} 小题，共 ${total} 分。`;
}

export function composeExamPaper(
  questions: readonly EpubExamQuestion[],
  heading: { bookTitle: string; scopeLabel: string },
): ExamPaper {
  const grouped = new Map<EpubExamQuestionType, EpubExamQuestion[]>();
  for (const question of questions) {
    const bucket = grouped.get(question.type) ?? [];
    bucket.push(question);
    grouped.set(question.type, bucket);
  }
  const sections = SECTION_ORDER.flatMap((type) => {
    const bucket = grouped.get(type);
    if (!bucket?.length) return [];
    const pointList = bucket.map(pointsOf);
    const uniform = pointList.every((value) => value === pointList[0]);
    const items = bucket.map((question, index) => {
      const options = choiceTexts(question);
      return {
        question,
        number: index + 1,
        points: pointList[index],
        showPoints: !uniform,
        choiceKeys: choiceKeysFor(type, options.length),
        choiceLayout: choiceLayoutFor(type, options),
        answerLines: answerLineCount(type),
      };
    });
    return [
      {
        type,
        ordinal: ORDINALS[0] ?? String(1),
        title: SECTION_TITLE[type],
        instruction: sectionInstruction(pointList),
        questionCount: bucket.length,
        totalPoints: pointList.reduce((sum, value) => sum + value, 0),
        items,
      },
    ];
  }).map((section, index) => ({
    ...section,
    ordinal: ORDINALS[index] ?? String(index + 1),
  }));
  return {
    bookTitle: heading.bookTitle,
    scopeLabel: heading.scopeLabel,
    questionCount: questions.length,
    totalPoints: sections.reduce(
      (sum, section) => sum + section.totalPoints,
      0,
    ),
    sections,
  };
}
