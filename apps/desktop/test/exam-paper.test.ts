import { describe, expect, it } from 'vitest';
import type { EpubExamQuestion } from '../src/exams/epub-exams';
import {
  choiceKeysFor,
  choiceLayoutFor,
  composeExamPaper,
} from '../src/exams/exam-paper';

function question(
  partial: Pick<EpubExamQuestion, 'type' | 'prompt'> &
    Partial<EpubExamQuestion>,
): EpubExamQuestion {
  return {
    id: partial.prompt,
    answer: partial.answer ?? '甲',
    explanation: partial.explanation ?? '依据正文。',
    ...partial,
  };
}

describe('exam paper composition', () => {
  it('groups questions into standard sections and restarts numbering', () => {
    const paper = composeExamPaper(
      [
        question({
          type: 'trueFalse',
          prompt: '判断',
          options: ['正确', '错误'],
          answer: '正确',
        }),
        question({
          type: 'singleChoice',
          prompt: '选择甲',
          options: ['甲', '乙', '丙', '丁'],
        }),
        question({
          type: 'singleChoice',
          prompt: '选择乙',
          options: ['甲', '乙'],
        }),
        question({
          type: 'comprehensive',
          prompt: '综合',
          answer: '分析',
          points: 8,
        }),
      ],
      { bookTitle: '结构力学', scopeLabel: '第三章' },
    );
    expect(paper.bookTitle).toBe('结构力学');
    expect(paper.scopeLabel).toBe('第三章');
    expect(paper.questionCount).toBe(4);
    expect(paper.totalPoints).toBe(2 + 2 + 2 + 8);
    expect(paper.sections.map((section) => section.title)).toEqual([
      '单项选择题',
      '判断题',
      '综合题',
    ]);
    expect(paper.sections.map((section) => section.ordinal)).toEqual([
      '一',
      '二',
      '三',
    ]);
    expect(paper.sections[0].items.map((item) => item.number)).toEqual([1, 2]);
    expect(paper.sections[0].instruction).toBe(
      '本大题共 2 小题，每小题 2 分，共 4 分。',
    );
    expect(paper.sections[0].items.every((item) => !item.showPoints)).toBe(
      true,
    );
  });

  it('states only the section total when item points differ', () => {
    const paper = composeExamPaper(
      [
        question({
          type: 'shortAnswer',
          prompt: '简答一',
          answer: '甲',
          points: 6,
        }),
        question({
          type: 'shortAnswer',
          prompt: '简答二',
          answer: '乙',
          points: 10,
        }),
      ],
      { bookTitle: '材料力学', scopeLabel: '第二章' },
    );
    expect(paper.sections[0].instruction).toBe('本大题共 2 小题，共 16 分。');
    expect(paper.sections[0].items.map((item) => item.showPoints)).toEqual([
      true,
      true,
    ]);
    expect(paper.sections[0].items.map((item) => item.answerLines)).toEqual([
      4, 4,
    ]);
  });

  it('lays out short, medium, long, and true-false choices differently', () => {
    expect(choiceLayoutFor('singleChoice', ['甲', '乙', '丙', '丁'])).toBe(
      'row',
    );
    expect(choiceKeysFor('singleChoice', 4)).toEqual(['A', 'B', 'C', 'D']);
    expect(
      choiceLayoutFor('multipleChoice', [
        '考虑截面的轴向压力',
        '考虑截面的轴向拉力',
        '考虑截面的弯矩作用',
        '考虑截面的扭矩作用',
      ]),
    ).toBe('pair');
    expect(
      choiceLayoutFor('singleChoice', [
        '这是一个超过二十二个字的长选项，应当独占一行。',
        '另一个同样很长的选项，避免和邻项挤在同一行。',
      ]),
    ).toBe('stack');
    expect(choiceLayoutFor('trueFalse', ['正确', '错误'])).toBe('pair');
    expect(choiceKeysFor('trueFalse', 2)).toEqual([null, null]);

    const paper = composeExamPaper(
      [
        question({
          type: 'trueFalse',
          prompt: '判断',
          answer: '正确',
        }),
        question({
          type: 'engineering',
          prompt: '工程',
          answer: '方案',
        }),
        question({
          type: 'cProgramming',
          prompt: '编程',
          answer: 'int main(void){return 0;}',
        }),
      ],
      { bookTitle: 'C 程序设计', scopeLabel: '第一章' },
    );
    expect(paper.sections[0].items[0]).toMatchObject({
      choiceLayout: 'pair',
      choiceKeys: [null, null],
      answerLines: 0,
      points: 2,
    });
    expect(paper.sections[1].items[0].answerLines).toBe(6);
    expect(paper.sections[1].items[0].points).toBe(12);
    expect(paper.sections[2].items[0]).toMatchObject({
      answerLines: 0,
      points: 12,
      choiceKeys: [],
    });
    expect(paper.totalPoints).toBe(26);
  });
});
