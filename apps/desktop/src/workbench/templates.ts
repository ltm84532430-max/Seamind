/** The kinds of file the library's "新建" menu can create. */
export type NewFileKind = 'doc' | 'mermaid' | 'plantuml';

export interface NewFileTemplate {
  /** Also the file name of the new file, which the library numbers when it is taken. */
  title: string;
  source: string;
}

export const NEW_FILE_TEMPLATES: Record<NewFileKind, NewFileTemplate> = {
  doc: {
    title: '新建文档',
    source: '# 新建文档\n\n在这里开始写作。\n\n## 小节\n\n- 要点一\n- 要点二\n',
  },
  mermaid: {
    title: '新建 Pele 图表',
    source:
      'flowchart TD\n  A[开始] --> B{条件}\n  B -- 是 --> C[处理]\n  B -- 否 --> D[结束]\n  C --> D\n',
  },
  plantuml: {
    title: '新建 PlantUML 图表',
    source: '@startuml\nAlice -> Bob: 你好\nBob --> Alice: 收到\n@enduml\n',
  },
};
