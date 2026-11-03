import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { EpubExamWorkspace } from '../src/EpubExamWorkspace';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((cmd: string) => {
    if (cmd === 'list_epub_exams') {
      return Promise.resolve([
        {
          id: 'exam-1',
          bookKey: 'book-1',
          bookTitle: 'C Primer Plus',
          sourceSectionLabel: '5.3.1 sizeof',
          createdAt: 1700000000000,
          questionCount: 5,
          status: 'submitted',
          sourceSectionIndex: 1,
          difficulty: 'medium',
          attemptsCount: 1,
          masteredCount: 4,
          partialCount: 1,
          reviewCount: 0,
        },
      ]);
    }
    if (cmd === 'get_epub_exam') {
      return Promise.resolve({
        schemaVersion: 1,
        id: 'exam-1',
        bookKey: 'book-1',
        bookTitle: 'C Primer Plus',
        sourceFileFingerprint: 'fp',
        sourceSectionIndex: 1,
        sourceSectionHref: 'ch5.html',
        sourceSectionLabel: '5.3.1 sizeof',
        createdAt: 1700000000000,
        questionCount: 5,
        difficulty: 'medium',
        status: 'submitted',
        submittedAt: 1700000005000,
        questions: [
          {
            id: 'q1',
            type: 'singleChoice',
            prompt: '关于sizeof下列正确的是',
            options: ['A', 'B', 'C', 'D'],
            answer: 'A',
            explanation: '解释',
          },
        ],
        answers: { q1: 'A' },
        selfReviews: { q1: 'mastered' },
        attempts: [],
      });
    }
    return Promise.resolve({});
  }),
}));

describe('EpubExamWorkspace SSR Render', () => {
  it('renders initial loading state without crashing', () => {
    const html = renderToString(
      React.createElement(EpubExamWorkspace, {
        examId: 'exam-1',
        bookKey: 'book-1',
        onBack: () => {},
      }),
    );
    expect(html).toContain('epub-exam-workspace-shell');
  });

  it('renders loaded state without crashing when exam is populated', () => {
    const sampleExam = {
      schemaVersion: 1,
      id: 'exam-1',
      bookKey: 'book-1',
      bookTitle: 'C Primer Plus',
      sourceFileFingerprint: 'fp',
      sourceSectionIndex: 1,
      sourceSectionHref: 'ch5.html',
      sourceSectionLabel: '5.3.1 sizeof',
      createdAt: 1700000000000,
      questionCount: 5,
      difficulty: 'medium' as const,
      status: 'submitted' as const,
      submittedAt: 1700000005000,
      questions: [
        {
          id: 'q1',
          type: 'singleChoice' as const,
          prompt: '关于sizeof下列正确的是',
          options: ['A', 'B', 'C', 'D'],
          answer: 'A',
          explanation: '解释',
        },
      ],
      answers: { q1: 'A' },
      selfReviews: { q1: 'mastered' as const },
      attempts: [],
    };

    const html = renderToString(
      React.createElement(EpubExamWorkspace, {
        examId: 'exam-1',
        bookKey: 'book-1',
        onBack: () => {},
        initialExam: sampleExam,
      }),
    );
    expect(html).toContain('5.3.1 sizeof');
  });

  it('handles inProgress exams and missing optional fields gracefully', () => {
    const inProgressExam: any = {
      schemaVersion: 1,
      id: 'exam-2',
      bookKey: 'book-1',
      sourceFileFingerprint: 'fp',
      sourceSectionIndex: 2,
      sourceSectionHref: 'ch6.html',
      sourceSectionLabel: '',
      createdAt: 1700000000000,
      questionCount: 2,
      status: 'inProgress',
      submittedAt: null,
      questions: [
        {
          id: 'q1',
          type: 'shortAnswer',
          prompt: '请简述循环',
          explanation: '解析',
        },
        {
          id: 'q2',
          type: 'multipleChoice',
          prompt: '请选择',
          options: ['X', 'Y'],
          explanation: '解析',
        },
      ],
      // attempts, answers, selfReviews are omitted
    };

    const html = renderToString(
      React.createElement(EpubExamWorkspace, {
        examId: 'exam-2',
        bookKey: 'book-1',
        onBack: () => {},
        initialExam: inProgressExam,
      }),
    );
    expect(html).toContain('epub-exam-workspace-shell');
    expect(html).toContain('未交卷');
  });

  it('handles completely malformed exam data gracefully', () => {
    const corruptExam: any = {
      id: 'exam-corrupt',
      bookKey: 'book-1',
      // no questions, no attempts, no metadata
    };

    const html = renderToString(
      React.createElement(EpubExamWorkspace, {
        examId: 'exam-corrupt',
        bookKey: 'book-1',
        onBack: () => {},
        initialExam: corruptExam,
      }),
    );
    expect(html).toContain('epub-exam-workspace-shell');
  });

  it('renders v2 exam with C programming codeSpec and rubric in spread and workspace modes', () => {
    const v2Exam: any = {
      schemaVersion: 2,
      id: 'exam-v2',
      bookKey: 'book-c',
      bookTitle: 'C Primer Plus',
      sourceFileFingerprint: 'fp-c',
      sourceSectionIndex: 5,
      sourceSectionHref: 'ch6.html',
      sourceSectionLabel: '第6章 C控制语句：循环',
      scope: { kind: 'chapter', label: '第6章', href: 'ch6.html' },
      createdAt: 1700000000000,
      questionCount: 2,
      difficulty: 'medium',
      status: 'submitted',
      submittedAt: 1700000005000,
      questions: [
        {
          id: 'q-c1',
          type: 'cProgramming',
          prompt: '编写一个函数计算累加和',
          answer: '#include <stdio.h>\nint main(void){return 0;}',
          explanation: '使用 while 循环累计',
          points: 12,
          rubric: [
            { criterion: '正确读取输入', points: 4 },
            { criterion: '正确循环求和', points: 8 },
          ],
          codeSpec: {
            starterCode: '#include <stdio.h>\nint main(void){\n  return 0;\n}',
            cases: [
              { stdin: '5\n', expectedStdout: '15\n', hidden: false },
              { stdin: '10\n', expectedStdout: '55\n', hidden: true },
            ],
          },
        },
        {
          id: 'q-comp1',
          type: 'comprehensive',
          prompt: '请分析 while 与 for 循环的汇编结构差异与适用场景',
          answer: '分析要点：入口检测、迭代步长、寄存器复用',
          explanation: '教材第 6 章核心要点',
          points: 8,
          rubric: [
            { criterion: '汇编结构说明', points: 4 },
            { criterion: '适用场景对比', points: 4 },
          ],
        },
      ],
      answers: {
        'q-c1':
          '#include <stdio.h>\nint main(void){\n  int n; scanf("%d",&n); ...\n}',
        'q-comp1': '我的详细分析答案',
      },
      selfReviews: {
        'q-c1': 'mastered',
        'q-comp1': 'partial',
      },
      grades: {
        'q-c1': {
          earned: 12,
          maximum: 12,
          feedback: '通过 2/2 个测试。',
          passedCases: 2,
          totalCases: 2,
        },
        'q-comp1': {
          earned: 7,
          maximum: 8,
          feedback: '分析到位，汇编指令解释准确。',
          provisional: true,
        },
      },
      attempts: [],
    };

    const html = renderToString(
      React.createElement(EpubExamWorkspace, {
        examId: 'exam-v2',
        bookKey: 'book-c',
        onBack: () => {},
        initialExam: v2Exam,
      }),
    );

    // Verify layout buttons and mode controls
    expect(html).toContain('左右翻页');
    expect(html).toContain('题目 / 工作区');
    expect(html).toContain('第6章 C控制语句：循环');
    expect(html).toContain('C 编程题');
    expect(html).toContain('编写一个函数计算累加和');
    expect(html).toContain('公开样例');
    expect(html).toContain('评分细则');
  });
});
