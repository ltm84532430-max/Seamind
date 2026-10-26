import { describe, expect, it } from 'vitest';
import {
  ActiveDocumentController,
  isDirty,
} from '../src/workbench/active-document';
import type {
  Invoke,
  WorkbenchEnvironment,
} from '../src/workbench/active-document';
import type {
  LibrarySnapshot,
  MapDocument,
  SaveDocumentInput,
  TextDocument,
} from '../src/library';
import { NEW_FILE_TEMPLATES } from '../src/workbench/templates';

type Handler = (args: Record<string, unknown>) => unknown;

function harness(handlers: Record<string, Handler> = {}) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const log = {
    status: [] as string[],
    errors: [] as string[],
    refreshes: 0,
    questions: [] as string[],
  };
  let discardAnswer = false;
  let snapshot: LibrarySnapshot | null = {
    rootPath: '/library',
    documents: [],
    books: [],
    plantumlFiles: [],
    textDocuments: [],
    categories: [],
  };
  const invoke: Invoke = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    calls.push({ command, args });
    const handler = handlers[command];
    if (!handler) throw `unexpected command ${command}`;
    return (await handler(args)) as T;
  };
  const environment: WorkbenchEnvironment = {
    getSnapshot: () => snapshot,
    installSnapshot: (next) => {
      snapshot = next;
    },
    refreshList: () => {
      log.refreshes += 1;
    },
    setStatus: (message) => log.status.push(message),
    setError: (message) => log.errors.push(message),
    confirmDiscard: (message) => {
      log.questions.push(message);
      return discardAnswer;
    },
  };
  return {
    controller: new ActiveDocumentController(invoke, environment),
    calls,
    log,
    snapshot: () => snapshot,
    commandsCalled: (command: string) =>
      calls.filter((call) => call.command === command),
    answerDiscard: (answer: boolean) => {
      discardAnswer = answer;
    },
  };
}

const mapDocument = (overrides: Partial<MapDocument> = {}): MapDocument => ({
  id: 'doc-1',
  relativePath: '文档/说明.md',
  title: '说明',
  category: '文档',
  mapType: '文档',
  tags: ['a'],
  createdAt: 1,
  updatedAt: 2,
  kind: 'doc',
  ...overrides,
});

const textDocument = (overrides: Partial<TextDocument> = {}): TextDocument => ({
  id: 'diagram-1',
  relativePath: '图表/流程.mmd',
  title: '流程',
  category: '图表',
  kind: 'mermaid',
  fileSize: 10,
  updatedAt: 2,
  ...overrides,
});

/** Lets a handler decide when its command finishes. */
function gate() {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

const openedDoc = (document = mapDocument(), markdown = '# 说明\n') => ({
  document,
  markdown,
});

describe('opening a document', () => {
  it('loads a Markdown document that is not dirty', async () => {
    const { controller, calls } = harness({
      open_document: () => openedDoc(),
    });
    expect(await controller.openMarkdown(mapDocument())).toBe(true);
    const state = controller.getState();
    expect(state).toMatchObject({
      kind: 'doc',
      id: 'doc-1',
      relativePath: '文档/说明.md',
      source: '# 说明\n',
      tags: ['a'],
    });
    expect(isDirty(state)).toBe(false);
    expect(calls.map((call) => call.command)).toEqual(['open_document']);
  });

  it('loads a diagram with its source', async () => {
    const { controller } = harness({
      open_text_document: () => ({
        document: textDocument(),
        source: 'flowchart LR\n',
      }),
    });
    await controller.openDiagram(textDocument());
    expect(controller.getState()).toMatchObject({
      kind: 'mermaid',
      title: '流程',
      source: 'flowchart LR\n',
    });
  });

  it('does nothing when the file is already open', async () => {
    const { controller, commandsCalled } = harness({
      open_document: () => openedDoc(),
    });
    await controller.openMarkdown(mapDocument());
    const session = controller.getState()?.session;
    expect(await controller.openMarkdown(mapDocument())).toBe(true);
    expect(commandsCalled('open_document')).toHaveLength(1);
    expect(controller.getState()?.session).toBe(session);
  });

  it('keeps the current document and says why when the file cannot be read', async () => {
    const { controller, log } = harness({
      open_document: () => openedDoc(),
      open_text_document: () => {
        throw '无法读取图表文件';
      },
    });
    await controller.openMarkdown(mapDocument());
    expect(await controller.openDiagram(textDocument())).toBe(false);
    expect(controller.getState()?.kind).toBe('doc');
    expect(log.errors.at(-1)).toBe('无法读取图表文件');
  });

  it('lets the newer of two overlapping opens win', async () => {
    const slow = gate();
    const { controller } = harness({
      open_document: async () => {
        await slow.opened;
        return openedDoc(mapDocument({ id: 'slow' }), 'slow');
      },
      open_text_document: () => ({
        document: textDocument({ id: 'fast' }),
        source: 'fast',
      }),
    });
    const first = controller.openMarkdown(mapDocument());
    await Promise.resolve();
    const second = controller.openDiagram(textDocument());
    expect(await second).toBe(true);
    slow.release();
    expect(await first).toBe(false);
    expect(controller.getState()?.id).toBe('fast');
  });
});

describe('saving', () => {
  it('writes a Markdown document with its metadata and clears the dirty mark', async () => {
    const saved = mapDocument({ updatedAt: 9 });
    const { controller, commandsCalled, snapshot, log } = harness({
      open_document: () => openedDoc(),
      save_document: () => saved,
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('# 说明\n\n新内容\n');
    expect(isDirty(controller.getState())).toBe(true);

    expect(await controller.save({ manual: true })).toBe(true);
    expect(isDirty(controller.getState())).toBe(false);
    const input = commandsCalled('save_document')[0].args
      .input as SaveDocumentInput;
    expect(input).toMatchObject({
      id: 'doc-1',
      relativePath: '文档/说明.md',
      title: '说明',
      mapType: '文档',
      tags: ['a'],
      markdown: '# 说明\n\n新内容\n',
      historySource: 'manual',
      kind: 'doc',
    });
    expect(snapshot()?.documents).toEqual([saved]);
    expect(snapshot()?.categories).toEqual(['文档']);
    expect(log.status.at(-1)).toBe('已保存到本机');
  });

  it('writes a diagram without a title, so the file keeps its name', async () => {
    const { controller, commandsCalled, snapshot } = harness({
      open_text_document: () => ({
        document: textDocument(),
        source: 'flowchart LR\n',
      }),
      save_text_document: () => textDocument({ updatedAt: 9 }),
    });
    await controller.openDiagram(textDocument());
    controller.edit('flowchart TD\n');
    expect(await controller.save()).toBe(true);
    expect(commandsCalled('save_text_document')[0].args).toEqual({
      relativePath: '图表/流程.mmd',
      source: 'flowchart TD\n',
    });
    expect(snapshot()?.textDocuments).toEqual([textDocument({ updatedAt: 9 })]);
    expect(isDirty(controller.getState())).toBe(false);
  });

  it('does not call the backend when nothing changed', async () => {
    const { controller, commandsCalled } = harness({
      open_document: () => openedDoc(),
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('# 说明\n');
    expect(await controller.save()).toBe(true);
    expect(commandsCalled('save_document')).toHaveLength(0);
  });

  it('keeps edits made during a save unsaved and writes them next', async () => {
    const firstWrite = gate();
    let writes = 0;
    const { controller, commandsCalled } = harness({
      open_document: () => openedDoc(),
      save_document: async () => {
        writes += 1;
        if (writes === 1) await firstWrite.opened;
        return mapDocument();
      },
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('one');
    const saving = controller.save();
    await Promise.resolve();
    controller.edit('one two');
    firstWrite.release();
    expect(await saving).toBe(true);
    expect(commandsCalled('save_document')).toHaveLength(2);
    expect(
      (commandsCalled('save_document')[1].args.input as SaveDocumentInput)
        .markdown,
    ).toBe('one two');
    expect(isDirty(controller.getState())).toBe(false);
  });

  it('stays dirty and reports the error when the backend refuses', async () => {
    const { controller, log } = harness({
      open_document: () => openedDoc(),
      save_document: () => {
        throw '内容不能为空，无法保存。';
      },
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('');
    expect(await controller.save()).toBe(false);
    expect(isDirty(controller.getState())).toBe(true);
    expect(log.status.at(-1)).toBe('内容不能为空，无法保存。');
  });

  it('lets a save that finishes after the document was closed leave the next one alone', async () => {
    const write = gate();
    const { controller } = harness({
      open_document: () => openedDoc(),
      open_text_document: () => ({
        document: textDocument(),
        source: 'flowchart LR\n',
      }),
      save_document: async () => {
        await write.opened;
        return mapDocument({ relativePath: '文档/改名后.md' });
      },
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('changed');
    const saving = controller.save();
    await Promise.resolve();
    controller.close();
    // Opening waits for the save that is still running before it swaps documents.
    const opening = controller.openDiagram(textDocument());
    write.release();
    await saving;
    await opening;
    expect(controller.getState()).toMatchObject({
      kind: 'mermaid',
      relativePath: '图表/流程.mmd',
    });
  });
});

describe('leaving a document', () => {
  it('saves before opening another one', async () => {
    const order: string[] = [];
    const { controller } = harness({
      open_document: () => openedDoc(),
      save_document: () => {
        order.push('save');
        return mapDocument();
      },
      open_text_document: () => {
        order.push('open');
        return { document: textDocument(), source: 'x' };
      },
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('changed');
    await controller.openDiagram(textDocument());
    expect(order).toEqual(['save', 'open']);
  });

  it('stays on the document when it cannot be saved', async () => {
    const { controller, commandsCalled } = harness({
      open_document: () => openedDoc(),
      save_document: () => {
        throw '磁盘已满';
      },
      open_text_document: () => ({ document: textDocument(), source: 'x' }),
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('changed');
    expect(await controller.openDiagram(textDocument())).toBe(false);
    expect(await controller.leave()).toBe(false);
    expect(controller.getState()?.kind).toBe('doc');
    expect(commandsCalled('open_text_document')).toHaveLength(0);
  });

  it('asks before giving up edits that cannot be saved, and gives them up on a yes', async () => {
    const { controller, commandsCalled, log, answerDiscard } = harness({
      open_document: () => openedDoc(),
      save_document: () => {
        throw '内容不能为空，无法保存。';
      },
      open_text_document: () => ({ document: textDocument(), source: 'x' }),
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('');

    expect(await controller.openDiagram(textDocument())).toBe(false);
    expect(log.questions).toHaveLength(1);
    expect(log.questions[0]).toContain('内容不能为空，无法保存。');
    expect(controller.getState()?.kind).toBe('doc');

    answerDiscard(true);
    expect(await controller.openDiagram(textDocument())).toBe(true);
    expect(controller.getState()?.kind).toBe('mermaid');
    expect(commandsCalled('open_text_document')).toHaveLength(1);
  });

  it('leaves without asking when the save works', async () => {
    const { controller, log } = harness({
      open_document: () => openedDoc(),
      save_document: () => mapDocument(),
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('changed');
    expect(await controller.leave()).toBe(true);
    expect(log.questions).toEqual([]);
  });

  it('closes after saving', async () => {
    const { controller, commandsCalled } = harness({
      open_document: () => openedDoc(),
      save_document: () => mapDocument(),
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('changed');
    expect(await controller.leave()).toBe(true);
    expect(controller.getState()).toBeNull();
    expect(commandsCalled('save_document')).toHaveLength(1);
  });

  it('discard waits for a save that is running and then closes without another', async () => {
    const write = gate();
    const { controller, commandsCalled } = harness({
      open_document: () => openedDoc(),
      save_document: async () => {
        await write.opened;
        return mapDocument();
      },
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('changed');
    const saving = controller.save();
    await Promise.resolve();
    let closed = false;
    const discarding = controller.discard().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    write.release();
    await Promise.all([saving, discarding]);
    expect(controller.getState()).toBeNull();
    expect(commandsCalled('save_document')).toHaveLength(1);
  });
});

describe('creating a document', () => {
  it('makes a diagram from the template in the chosen folder', async () => {
    const { controller, commandsCalled, snapshot } = harness({
      create_text_document: (args) => ({
        document: textDocument({
          relativePath: `${args.category}/新建 Pele 图表.mmd`,
          title: String(args.title),
          category: String(args.category),
        }),
        source: String(args.source),
      }),
    });
    expect(await controller.createDocument('mermaid', '学习/图')).toBe(true);
    expect(commandsCalled('create_text_document')[0].args).toEqual({
      kind: 'mermaid',
      category: '学习/图',
      title: NEW_FILE_TEMPLATES.mermaid.title,
      source: NEW_FILE_TEMPLATES.mermaid.source,
    });
    expect(controller.getState()).toMatchObject({
      kind: 'mermaid',
      source: NEW_FILE_TEMPLATES.mermaid.source,
    });
    expect(isDirty(controller.getState())).toBe(false);
    expect(snapshot()?.textDocuments).toHaveLength(1);
    expect(snapshot()?.categories).toEqual(['学习', '学习/图']);
  });

  it('makes a document with the document kind and a template', async () => {
    const { controller, commandsCalled, snapshot } = harness({
      save_document: (args) => {
        const input = args.input as SaveDocumentInput;
        return mapDocument({
          relativePath: '未分类/新建文档.md',
          title: input.title,
          category: input.category,
        });
      },
    });
    expect(await controller.createDocument('doc', '未分类')).toBe(true);
    const input = commandsCalled('save_document')[0].args
      .input as SaveDocumentInput;
    expect(input).toMatchObject({
      id: null,
      relativePath: null,
      title: NEW_FILE_TEMPLATES.doc.title,
      markdown: NEW_FILE_TEMPLATES.doc.source,
      kind: 'doc',
    });
    expect(controller.getState()?.source).toBe(NEW_FILE_TEMPLATES.doc.source);
    expect(snapshot()?.documents).toHaveLength(1);
  });
});

describe('renaming', () => {
  it('renames a document by saving it under the new title', async () => {
    const { controller, commandsCalled } = harness({
      open_document: () => openedDoc(),
      save_document: (args) => {
        const input = args.input as SaveDocumentInput;
        return mapDocument({
          title: input.title,
          relativePath: `文档/${input.title}.md`,
        });
      },
    });
    await controller.openMarkdown(mapDocument());
    expect(await controller.rename('  新标题 ')).toBe(true);
    expect(controller.getState()).toMatchObject({
      title: '新标题',
      relativePath: '文档/新标题.md',
    });
    expect(isDirty(controller.getState())).toBe(false);
    expect(
      (commandsCalled('save_document')[0].args.input as SaveDocumentInput)
        .title,
    ).toBe('新标题');
  });

  it('drops a title the backend refused and keeps the edits', async () => {
    const { controller, log } = harness({
      open_document: () => openedDoc(),
      save_document: (args) => {
        const input = args.input as SaveDocumentInput;
        if (input.title === '已占用')
          throw '目标分类中已存在同名文件，请修改标题或分类。';
        return mapDocument();
      },
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('# 说明\n\n更多\n');
    expect(await controller.rename('已占用')).toBe(false);
    expect(controller.getState()?.title).toBe('说明');
    expect(controller.getState()?.source).toBe('# 说明\n\n更多\n');
    expect(isDirty(controller.getState())).toBe(true);
    expect(log.status.at(-1)).toContain('同名文件');
  });

  it('renames a diagram through the save command and moves its list entry', async () => {
    const { controller, commandsCalled, snapshot } = harness({
      open_text_document: () => ({
        document: textDocument(),
        source: 'flowchart LR\n',
      }),
      save_text_document: (args) =>
        textDocument({
          title: String(args.title ?? '流程'),
          relativePath: args.title ? `图表/${args.title}.mmd` : '图表/流程.mmd',
        }),
    });
    await controller.openDiagram(textDocument());
    controller.edit('flowchart TD\n');
    expect(await controller.rename('订单流')).toBe(true);
    const saves = commandsCalled('save_text_document');
    expect(saves).toHaveLength(2);
    expect(saves[0].args).not.toHaveProperty('title');
    expect(saves[1].args).toEqual({
      relativePath: '图表/流程.mmd',
      source: 'flowchart TD\n',
      title: '订单流',
    });
    expect(controller.getState()).toMatchObject({
      title: '订单流',
      relativePath: '图表/订单流.mmd',
    });
    expect(isDirty(controller.getState())).toBe(false);
    expect(snapshot()?.textDocuments.map((file) => file.relativePath)).toEqual([
      '图表/订单流.mmd',
    ]);
  });

  it('ignores a blank title and an unchanged one', async () => {
    const { controller, calls } = harness({
      open_document: () => openedDoc(),
    });
    await controller.openMarkdown(mapDocument());
    expect(await controller.rename('   ')).toBe(true);
    expect(await controller.rename('说明')).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('converting to a mind map', () => {
  it('saves the document as a mind map and closes the workbench', async () => {
    const { controller, commandsCalled, snapshot } = harness({
      open_document: () => openedDoc(),
      save_document: (args) =>
        mapDocument({
          kind: (args.input as SaveDocumentInput).kind ?? 'mindmap',
        }),
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('# 说明\n\n- 要点\n');
    const converted = await controller.convertToMindmap();
    expect(converted?.kind).toBe('mindmap');
    expect(controller.getState()).toBeNull();
    const input = commandsCalled('save_document')[0].args
      .input as SaveDocumentInput;
    expect(input).toMatchObject({
      kind: 'mindmap',
      mapType: '通用',
      markdown: '# 说明\n\n- 要点\n',
      historySource: 'manual',
    });
    expect(snapshot()?.documents[0].kind).toBe('mindmap');
  });

  it('keeps the document open when the conversion fails', async () => {
    const { controller } = harness({
      open_document: () => openedDoc(),
      save_document: () => {
        throw '磁盘已满';
      },
    });
    await controller.openMarkdown(mapDocument());
    expect(await controller.convertToMindmap()).toBeNull();
    expect(controller.getState()?.kind).toBe('doc');
  });

  it('does nothing for a diagram', async () => {
    const { controller, calls } = harness({
      open_text_document: () => ({ document: textDocument(), source: 'x' }),
    });
    await controller.openDiagram(textDocument());
    expect(await controller.convertToMindmap()).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('following a renamed folder', () => {
  it('moves the path and the category of the open document', async () => {
    const { controller } = harness({ open_document: () => openedDoc() });
    await controller.openMarkdown(mapDocument());
    controller.remapPaths((path) =>
      path === null ? null : path.replace(/^文档/, '资料'),
    );
    expect(controller.getState()).toMatchObject({
      relativePath: '资料/说明.md',
      category: '资料',
    });
    expect(isDirty(controller.getState())).toBe(false);
  });
});

describe('subscribing', () => {
  it('tells listeners about each change until they unsubscribe', async () => {
    const { controller } = harness({ open_document: () => openedDoc() });
    let notified = 0;
    const unsubscribe = controller.subscribe(() => {
      notified += 1;
    });
    await controller.openMarkdown(mapDocument());
    controller.edit('x');
    expect(notified).toBe(2);
    unsubscribe();
    controller.edit('y');
    expect(notified).toBe(2);
  });
});

describe('custom templates, category switching, and tag editing', () => {
  it('creates a custom note with template source and tags', async () => {
    const { controller, commandsCalled } = harness({
      save_document: (args) => {
        const input = args.input as SaveDocumentInput;
        return mapDocument({
          relativePath: `${input.category}/${input.title}.md`,
          title: input.title,
          category: input.category,
          tags: input.tags,
        });
      },
    });
    expect(
      await controller.createCustomDocument({
        category: '数学',
        title: '概念笔记',
        source: '# 概念笔记\n\n$$a+b$$\n',
        tags: ['公式'],
      }),
    ).toBe(true);
    const input = commandsCalled('save_document')[0].args
      .input as SaveDocumentInput;
    expect(input).toMatchObject({
      category: '数学',
      title: '概念笔记',
      tags: ['公式'],
      kind: 'doc',
    });
    expect(controller.getState()).toMatchObject({
      category: '数学',
      title: '概念笔记',
      tags: ['公式'],
    });
  });

  it('moves category and updates deduplicated tags on an open document', async () => {
    const { controller, commandsCalled } = harness({
      open_document: () => openedDoc(),
      save_document: (args) => {
        const input = args.input as SaveDocumentInput;
        return mapDocument({
          category: input.category,
          relativePath: `${input.category}/${input.title}.md`,
          tags: input.tags,
        });
      },
    });
    await controller.openMarkdown(mapDocument());

    expect(await controller.setCategory('研究/论文')).toBe(true);
    expect(controller.getState()).toMatchObject({
      category: '研究/论文',
      relativePath: '研究/论文/说明.md',
    });

    expect(await controller.setTags(['#AI', '论文', 'AI'])).toBe(true);
    expect(controller.getState()?.tags).toEqual(['AI', '论文']);
    expect(commandsCalled('save_document')).toHaveLength(2);
  });
});
