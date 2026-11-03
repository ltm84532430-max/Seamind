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
});
