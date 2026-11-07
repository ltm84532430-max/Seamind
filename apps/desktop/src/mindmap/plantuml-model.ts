export type PlantUmlDiagramType =
  | 'sequence'
  | 'class'
  | 'activity'
  | 'usecase'
  | 'component'
  | 'deployment'
  | 'state'
  | 'er'
  | 'unsupported';

export interface PlantUmlElement {
  id: string;
  kind: string;
  label: string;
  lineIndex: number;
  sourceStart: number;
  sourceEnd: number;
  prefix: string;
  suffix: string;
  members: string[];
}

export interface PlantUmlRelationship {
  id: string;
  from: string;
  to: string;
  arrow: string;
  label: string;
  lineIndex: number;
  prefix: string;
  suffix: string;
}

export interface PlantUmlRawPart {
  lineIndex: number;
  source: string;
  reason: string;
}

export interface PlantUmlFlowBlock {
  lineIndex: number;
  kind: string;
  label: string;
  source: string;
}

export interface PlantUmlDocument {
  source: string;
  lines: string[];
  diagramType: PlantUmlDiagramType;
  elements: PlantUmlElement[];
  relationships: PlantUmlRelationship[];
  flowBlocks: PlantUmlFlowBlock[];
  rawParts: PlantUmlRawPart[];
  diagnostics: string[];
  startLine: number;
  endLine: number;
  supportsGui: boolean;
}

const declarationPattern =
  /^\s*(abstract\s+class|participant|actor|boundary|control|entity|database|collections|queue|class|interface|enum|annotation|object|component|node|artifact|cloud|folder|frame|package|rectangle|usecase|state)\s+(.+?)\s*$/i;

const arrowTokens = [
  '-->>',
  '<<--',
  '->>',
  '<<-',
  '||--o{',
  '}o--||',
  '||--||',
  '}|--|{',
  'o|--||',
  '||--|{',
  '<|..',
  '..|>',
  '<|--',
  '--|>',
  '*--',
  '--*',
  'o--',
  '--o',
  '<..',
  '..>',
  '<--',
  '-->',
  '<->',
  '->',
  '<-',
  '=>',
  '<=',
  '--',
  '..',
];

const flowLinePattern =
  /^\s*(alt|opt|loop|par|critical|break|group|else|end|activate|deactivate|start|stop|kill|detach|if\b|elseif\b|while\b|repeat\b|fork\b|partition\b|split\b|switch\b|case\b|endswitch\b|endwhile\b|endif\b|end\b)\b(.*)$/i;

function sanitizeLabel(label: string): string {
  return label
    .replace(/[\r\n\0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function escapeQuoted(label: string): string {
  return sanitizeLabel(label).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function identifier(value: string): string {
  const normalized = value.replace(/[^\p{L}\p{N}_$.-]/gu, '_');
  return /^[\p{L}_$]/u.test(normalized) ? normalized : `N_${normalized}`;
}

function inferDiagramType(source: string): PlantUmlDiagramType {
  const lines = source.split(/\r?\n/).map((line) => line.trim().toLowerCase());
  const joined = lines.join('\n');
  if (
    /^\s*@start(?:gantt|mindmap|wbs|json|yaml|regex|ditaa|dot|salt|chronology|nwdiag|nwdiag|wire|bytefield|board|git|timeline|creole|math|latex|ebnf|regex|teoz|jcckit|umlet|smetana|preproc|mindmap|work)?\b/m.test(
      joined,
    )
  )
    return 'unsupported';
  if (
    /^\s*@startchen\b/m.test(joined) ||
    (/\bentity\b/.test(joined) &&
      (/(?:\|\||\|\{|\}\|)/.test(joined) ||
        /^\s*entity\s+[^\n{]+\{/m.test(joined)))
  )
    return 'er';
  if (
    /^\s*(usecase\b|actor\b|left to right direction\b)/m.test(joined) &&
    /\b(usecase|actor)\b/.test(joined)
  )
    return 'usecase';
  if (/^\s*state\s+|\[\*\]\s*[-.]|\bstate\s+diagram\b/m.test(joined))
    return 'state';
  if (/^\s*(node|artifact|cloud|database|frame)\b/m.test(joined))
    return 'deployment';
  if (
    /^\s*(start|stop|kill|detach|if\s*\(|while\s*\(|repeat\b|fork\b|split\b|partition\b|:[^;]+;)/m.test(
      joined,
    )
  )
    return 'activity';
  if (
    /^\s*(class|abstract\s+class|enum|annotation|object)\b/m.test(joined) ||
    /(?:<\|--|--\|>|\*--|o--)/.test(joined)
  )
    return 'class';
  if (/^\s*(component|port|folder|rectangle)\b/m.test(joined))
    return 'component';
  if (/^\s*interface\b/m.test(joined)) return 'class';
  if (/^\s*package\b/m.test(joined))
    return /\bclass\b/m.test(joined) ? 'class' : 'component';
  if (
    /^\s*(participant|boundary|control|collections|queue|activate|deactivate|alt\b|opt\b|loop\b|par\b|critical\b|group\b)/m.test(
      joined,
    ) ||
    /^\s*[^'!@#\s].*(?:->|<-|=>|<=)\s*[^\s]/m.test(joined)
  )
    return 'sequence';
  return 'unsupported';
}

function parseDeclaration(
  line: string,
  lineIndex: number,
): PlantUmlElement | null {
  const match = declarationPattern.exec(line);
  if (!match) return null;
  const kind = match[1]!.toLowerCase().replace(/\s+/g, ' ');
  const value = match[2]!.trim();
  if (/^(?:as|is|on|off|left|right)\b/i.test(value)) return null;
  const keywordEnd = line.indexOf(match[1]!) + match[1]!.length;
  const prefix = line.slice(0, keywordEnd) + ' ';
  let id = '';
  let label = '';
  let consumed = '';
  let declaration =
    /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s+as\s+([\w.$-]+)/i.exec(value);
  if (declaration) {
    label = declaration[1]!.slice(1, -1).replace(/\\"/g, '"');
    id = declaration[2]!;
    consumed = declaration[0];
  } else {
    declaration =
      /^([\w.$-]+)\s+as\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/i.exec(value);
    if (declaration) {
      id = declaration[1]!;
      label = declaration[2]!.slice(1, -1).replace(/\\"/g, '"');
      consumed = declaration[0];
    } else {
      declaration = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(value);
      if (declaration) {
        label = declaration[1]!.slice(1, -1).replace(/\\"/g, '"');
        id = identifier(label);
        consumed = declaration[0];
      } else {
        declaration = /^([\w.$-]+)/.exec(value);
        if (!declaration) return null;
        id = declaration[1]!;
        label = id;
        consumed = declaration[0];
      }
    }
  }
  const valueStart =
    line.indexOf(match[2]!) + (match[2]!.length - value.length);
  return {
    id,
    kind,
    label: sanitizeLabel(label),
    lineIndex,
    sourceStart: lineIndex,
    sourceEnd: lineIndex,
    prefix,
    suffix: line.slice(valueStart + consumed.length),
    members: [],
  };
}

function parseRelationship(
  line: string,
  lineIndex: number,
): PlantUmlRelationship | null {
  for (const arrow of arrowTokens) {
    const arrowIndex = line.indexOf(arrow);
    if (arrowIndex < 0) continue;
    const leftText = line.slice(0, arrowIndex).trim();
    const tail = line.slice(arrowIndex + arrow.length).trim();
    const colonIndex = tail.indexOf(':');
    const rightText = (
      colonIndex < 0 ? tail : tail.slice(0, colonIndex)
    ).trim();
    const label = colonIndex < 0 ? '' : tail.slice(colonIndex + 1).trim();
    const normalizeEndpoint = (endpoint: string) =>
      endpoint.replace(/^['"]|['"]$/g, '').trim();
    const from = normalizeEndpoint(leftText);
    const to = normalizeEndpoint(rightText);
    if (!from || !to || from.length > 120 || to.length > 120) continue;
    if (/^(?:left|right|top|bottom|up|down)\b/i.test(from)) continue;
    if (/^\s*(?:!|@|skinparam|hide|show|title|legend)\b/i.test(line)) continue;
    const linePrefix = line.slice(0, arrowIndex);
    return {
      id: `relation-${lineIndex}`,
      from,
      to,
      arrow,
      label: sanitizeLabel(label),
      lineIndex,
      prefix: linePrefix.trimEnd(),
      suffix: '',
    };
  }
  return null;
}

export function parsePlantUmlDocument(source: string): PlantUmlDocument {
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const starts = lines.flatMap((line, index) =>
    /^\s*@start[a-z0-9_-]*\b/i.test(line) ? [index] : [],
  );
  const ends = lines.flatMap((line, index) =>
    /^\s*@end[a-z0-9_-]*\b/i.test(line) ? [index] : [],
  );
  const diagnostics: string[] = [];
  if (starts.length !== 1 || ends.length !== 1 || starts[0]! >= ends[0]!) {
    diagnostics.push(
      'GUI 编辑需要一个完整的 @startuml…@enduml 图表；源码和预览仍可使用。',
    );
  }

  const diagramType = inferDiagramType(normalized);
  if (diagramType === 'unsupported')
    diagnostics.push(
      '此图表语法暂不提供结构化 GUI 控件，可继续编辑 PUML 源码并预览。',
    );

  const elements: PlantUmlElement[] = [];
  const relationships: PlantUmlRelationship[] = [];
  const flowBlocks: PlantUmlFlowBlock[] = [];
  const rawParts: PlantUmlRawPart[] = [];
  const recognized = new Set<number>();
  const elementById = new Map<string, PlantUmlElement>();
  const duplicateIds = new Set<string>();

  lines.forEach((line, lineIndex) => {
    if (lineIndex === starts[0] || lineIndex === ends[0]) {
      recognized.add(lineIndex);
      return;
    }
    const trimmed = line.trim();
    if (!trimmed || /^['#]/.test(trimmed)) {
      if (trimmed)
        rawParts.push({ lineIndex, source: line, reason: 'comment' });
      return;
    }
    if (/^\s*!/.test(line)) {
      rawParts.push({ lineIndex, source: line, reason: 'preprocessor' });
      return;
    }
    if (
      /^\s*(?:note\b|title\b|legend\b|caption\b|header\b|footer\b|skinparam\b|hide\b|show\b|autonumber\b|box\b|end\s+box\b)/i.test(
        line,
      )
    ) {
      rawParts.push({ lineIndex, source: line, reason: 'raw directive' });
      return;
    }

    const declaration = parseDeclaration(line, lineIndex);
    if (declaration) {
      const existing = elementById.get(declaration.id);
      if (existing) {
        duplicateIds.add(declaration.id);
        rawParts.push({
          lineIndex,
          source: line,
          reason: 'duplicate declaration',
        });
      } else {
        elements.push(declaration);
        elementById.set(declaration.id, declaration);
      }
      recognized.add(lineIndex);
      return;
    }

    if (diagramType === 'activity' && /^\s*:[^;]+;\s*$/.test(line)) {
      const label = sanitizeLabel(
        line.trim().replace(/^:/, '').replace(/;$/, ''),
      );
      const element: PlantUmlElement = {
        id: `activity-${lineIndex}`,
        kind: 'activity',
        label,
        lineIndex,
        sourceStart: lineIndex,
        sourceEnd: lineIndex,
        prefix: line.slice(0, line.indexOf(':')) + ':',
        suffix: ';',
        members: [],
      };
      elements.push(element);
      elementById.set(element.id, element);
      recognized.add(lineIndex);
      return;
    }

    const relation = parseRelationship(line, lineIndex);
    if (relation) {
      relationships.push(relation);
      recognized.add(lineIndex);
      [relation.from, relation.to].forEach((endpoint) => {
        if (endpoint === '*' || endpoint === '[*]' || elementById.has(endpoint))
          return;
        const implicit: PlantUmlElement = {
          id: endpoint,
          kind: 'implicit',
          label: endpoint,
          lineIndex: -1,
          sourceStart: -1,
          sourceEnd: -1,
          prefix: '',
          suffix: '',
          members: [],
        };
        elementById.set(endpoint, implicit);
        elements.push(implicit);
      });
      return;
    }

    const block = flowLinePattern.exec(line);
    if (block) {
      flowBlocks.push({
        lineIndex,
        kind: block[1]!.toLowerCase(),
        label: sanitizeLabel(block[2] ?? ''),
        source: line,
      });
      recognized.add(lineIndex);
      return;
    }

    if (/^\s*(?:@start|@end)/i.test(line)) {
      recognized.add(lineIndex);
      return;
    }
    rawParts.push({ lineIndex, source: line, reason: 'unrecognized syntax' });
  });

  let openClass: PlantUmlElement | null = null;
  lines.forEach((line, lineIndex) => {
    if (openClass && lineIndex > openClass.lineIndex && /^\s*\}/.test(line)) {
      openClass.sourceEnd = lineIndex;
      openClass = null;
      return;
    }
    if (!openClass) {
      const element = elements.find(
        (candidate) =>
          candidate.lineIndex === lineIndex &&
          /^(?:abstract\s+class|class|interface|enum|entity)\b/i.test(
            candidate.kind,
          ),
      );
      if (element && line.includes('{')) openClass = element;
    } else if (line.trim() && !/^\s*\}/.test(line)) {
      openClass.members.push(line.trim());
    }
  });

  if (duplicateIds.size)
    diagnostics.push(
      `有重复别名（${Array.from(duplicateIds).join('、')}），这些声明保持原文，不参与 GUI 编辑。`,
    );
  lines.forEach((line, lineIndex) => {
    if (recognized.has(lineIndex) || !line.trim()) return;
    if (rawParts.some((part) => part.lineIndex === lineIndex)) return;
    rawParts.push({ lineIndex, source: line, reason: 'unrecognized syntax' });
  });
  rawParts.sort((left, right) => left.lineIndex - right.lineIndex);

  return {
    source: normalized,
    lines,
    diagramType,
    elements,
    relationships,
    flowBlocks,
    rawParts,
    diagnostics,
    startLine: starts[0] ?? -1,
    endLine: ends[0] ?? -1,
    supportsGui:
      starts.length === 1 &&
      ends.length === 1 &&
      starts[0]! < ends[0]! &&
      diagramType !== 'unsupported' &&
      duplicateIds.size === 0,
  };
}

function insertBeforeEnd(document: PlantUmlDocument, snippet: string): string {
  if (document.endLine < 0)
    return `${document.source.replace(/\s*$/, '')}\n${snippet}`;
  const lines = [...document.lines];
  lines.splice(document.endLine, 0, ...snippet.split('\n'));
  return lines.join('\n');
}

export function addPlantUmlElement(
  document: PlantUmlDocument,
  label: string,
  elementKind = '',
): string {
  const safeLabel = sanitizeLabel(label);
  if (!safeLabel) return document.source;
  let aliasIndex = document.elements.length + 1;
  while (document.elements.some((element) => element.id === `S${aliasIndex}`))
    aliasIndex += 1;
  const alias = `S${aliasIndex}`;
  const kind =
    elementKind ||
    (document.diagramType === 'sequence'
      ? 'participant'
      : document.diagramType === 'class'
        ? 'class'
        : document.diagramType === 'usecase'
          ? 'usecase'
          : document.diagramType === 'deployment'
            ? 'node'
            : document.diagramType === 'component'
              ? 'component'
              : document.diagramType === 'state'
                ? 'state'
                : document.diagramType === 'er'
                  ? 'entity'
                  : 'activity');
  if (kind === 'activity') return insertBeforeEnd(document, `:${safeLabel};`);
  return insertBeforeEnd(
    document,
    `${kind} "${escapeQuoted(safeLabel)}" as ${alias}`,
  );
}
export function setPlantUmlDirection(
  document: PlantUmlDocument,
  direction:
    | 'left to right'
    | 'right to left'
    | 'top to bottom'
    | 'bottom to top',
): string {
  const lines = [...document.lines];
  const directive = `${direction} direction`;
  const existingLine = lines.findIndex((line) =>
    /^\s*(?:left|right|top|bottom) to (?:left|right|top|bottom) direction\s*$/i.test(
      line,
    ),
  );
  if (existingLine >= 0) {
    lines[existingLine] = directive;
    return lines.join('\n');
  }
  const insertAt = document.startLine >= 0 ? document.startLine + 1 : 0;
  lines.splice(insertAt, 0, directive);
  return lines.join('\n');
}

export function addPlantUmlRelationship(
  document: PlantUmlDocument,
  from: string,
  to: string,
  label = '',
  arrow = '',
): string {
  if (!from || !to) return document.source;
  const defaultArrow =
    document.diagramType === 'er'
      ? '||--o{'
      : document.diagramType === 'class'
        ? '-->'
        : document.diagramType === 'sequence'
          ? '->'
          : '-->';
  const safeLabel = sanitizeLabel(label);
  return insertBeforeEnd(
    document,
    `${from} ${arrow || defaultArrow} ${to}${safeLabel ? ` : ${safeLabel}` : ''}`,
  );
}

export function addPlantUmlFlowBlock(
  document: PlantUmlDocument,
  kind:
    | 'alt'
    | 'opt'
    | 'loop'
    | 'activate'
    | 'deactivate'
    | 'decision'
    | 'partition',
  label: string,
  target = '',
): string {
  const safeLabel = sanitizeLabel(label);
  if (kind === 'activate' || kind === 'deactivate')
    return target
      ? insertBeforeEnd(document, `${kind} ${target}`)
      : document.source;
  if (
    document.diagramType === 'sequence' &&
    ['alt', 'opt', 'loop'].includes(kind)
  )
    return insertBeforeEnd(document, `${kind} ${safeLabel || '条件'}\nend`);
  if (document.diagramType === 'activity' && kind === 'decision')
    return insertBeforeEnd(
      document,
      `if (${safeLabel || '条件'}) then (是)\n  :分支一;\nelse (否)\n  :分支二;\nendif`,
    );
  if (document.diagramType === 'activity' && kind === 'partition')
    return insertBeforeEnd(
      document,
      `partition "${escapeQuoted(safeLabel || '泳道')}" {\n  :活动;\n}`,
    );
  return document.source;
}

export function addPlantUmlNote(
  document: PlantUmlDocument,
  target: string,
  note: string,
): string {
  const safeNote = sanitizeLabel(note);
  if (!target || !safeNote) return document.source;
  const existing = document.elements.find((element) => element.id === target);
  const targetName = existing?.id ?? target;
  return insertBeforeEnd(document, `note right of ${targetName} : ${safeNote}`);
}

export function addPlantUmlGroup(
  document: PlantUmlDocument,
  name: string,
  elementId = '',
): string {
  const safeName = sanitizeLabel(name);
  if (!safeName) return document.source;
  const selectedElement = document.elements.find(
    (element) => element.id === elementId && element.lineIndex >= 0,
  );
  if (selectedElement && document.diagramType !== 'sequence') {
    const lines = [...document.lines];
    const endLine = Math.max(
      selectedElement.lineIndex,
      selectedElement.sourceEnd,
    );
    const wrapper =
      document.diagramType === 'activity'
        ? `partition "${escapeQuoted(safeName)}" {`
        : document.diagramType === 'usecase'
          ? `rectangle "${escapeQuoted(safeName)}" {`
          : document.diagramType === 'state'
            ? `state "${escapeQuoted(safeName)}" {`
            : `package "${escapeQuoted(safeName)}" {`;
    lines.splice(endLine + 1, 0, '}');
    lines.splice(selectedElement.lineIndex, 0, wrapper);
    return lines.join('\n');
  }
  if (document.diagramType === 'sequence')
    return insertBeforeEnd(
      document,
      [`group ${safeName}`, '  ...', 'end'].join('\n'),
    );
  if (document.diagramType === 'activity')
    return insertBeforeEnd(
      document,
      [`partition "${escapeQuoted(safeName)}" {`, '  :活动;', '}'].join('\n'),
    );
  if (document.diagramType === 'state')
    return insertBeforeEnd(
      document,
      [`state "${escapeQuoted(safeName)}" {`, '}'].join('\n'),
    );
  if (document.diagramType === 'usecase')
    return insertBeforeEnd(
      document,
      [`rectangle "${escapeQuoted(safeName)}" {`, '}'].join('\n'),
    );
  if (
    document.diagramType === 'component' ||
    document.diagramType === 'deployment' ||
    document.diagramType === 'class'
  )
    return insertBeforeEnd(
      document,
      [`package "${escapeQuoted(safeName)}" {`, '}'].join('\n'),
    );
  return document.source;
}
export function addPlantUmlMember(
  document: PlantUmlDocument,
  elementId: string,
  member: string,
  visibility = '+',
): string {
  const element = document.elements.find(
    (candidate) => candidate.id === elementId,
  );
  const safeMember = sanitizeLabel(member);
  if (
    !element ||
    element.lineIndex < 0 ||
    !safeMember ||
    !/^(?:abstract\s+class|class|interface|enum|entity)\b/i.test(element.kind)
  )
    return document.source;
  const lines = [...document.lines];
  if (element.sourceEnd > element.lineIndex) {
    lines.splice(element.sourceEnd, 0, `  ${visibility} ${safeMember}`);
  } else {
    const original = lines[element.lineIndex] ?? '';
    if (original.includes('{')) {
      lines[element.lineIndex] =
        `${original}\n  ${visibility} ${safeMember}\n}`;
    } else {
      lines[element.lineIndex] =
        `${original} {\n  ${visibility} ${safeMember}\n}`;
    }
  }
  return lines.join('\n');
}

export function updatePlantUmlElementLabel(
  document: PlantUmlDocument,
  elementId: string,
  label: string,
): string {
  const element = document.elements.find(
    (candidate) => candidate.id === elementId,
  );
  const safeLabel = sanitizeLabel(label);
  if (!element || element.lineIndex < 0 || !safeLabel) return document.source;
  const lines = [...document.lines];
  if (element.kind === 'activity') {
    lines[element.lineIndex] = `${element.prefix}${safeLabel}${element.suffix}`;
  } else {
    lines[element.lineIndex] =
      `${element.prefix}"${escapeQuoted(safeLabel)}" as ${element.id}${element.suffix}`;
  }
  return lines.join('\n');
}

export function updatePlantUmlRelationship(
  document: PlantUmlDocument,
  relationId: string,
  label: string,
  arrow: string,
): string {
  const relation = document.relationships.find(
    (candidate) => candidate.id === relationId,
  );
  if (!relation) return document.source;
  const lines = [...document.lines];
  const prefix = relation.prefix;
  const safeLabel = sanitizeLabel(label);
  const colon = safeLabel ? ` : ${safeLabel}` : '';
  lines[relation.lineIndex] =
    `${prefix} ${arrow || relation.arrow} ${relation.to}${colon}${relation.suffix}`;
  return lines.join('\n');
}

export function deletePlantUmlElement(
  document: PlantUmlDocument,
  elementId: string,
): string {
  const element = document.elements.find(
    (candidate) => candidate.id === elementId,
  );
  if (!element || element.lineIndex < 0) return document.source;
  const lines = [...document.lines];
  const remove = new Set<number>();
  for (let line = element.sourceStart; line <= element.sourceEnd; line += 1)
    remove.add(line);
  document.relationships.forEach((relation) => {
    if (relation.from === element.id || relation.to === element.id)
      remove.add(relation.lineIndex);
  });
  return lines.filter((_, index) => !remove.has(index)).join('\n');
}

export function deletePlantUmlRelationship(
  document: PlantUmlDocument,
  relationId: string,
): string {
  const relation = document.relationships.find(
    (candidate) => candidate.id === relationId,
  );
  if (!relation) return document.source;
  return document.lines
    .filter((_, index) => index !== relation.lineIndex)
    .join('\n');
}

export function diagramTypeLabel(type: PlantUmlDiagramType): string {
  const labels: Record<PlantUmlDiagramType, string> = {
    sequence: '时序图',
    class: '类图',
    activity: '活动图',
    usecase: '用例图',
    component: '组件图',
    deployment: '部署图',
    state: '状态图',
    er: 'ER 图',
    unsupported: '源码模式',
  };
  return labels[type];
}
