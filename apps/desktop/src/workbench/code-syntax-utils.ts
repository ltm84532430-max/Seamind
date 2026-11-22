export type CodeTokenKind =
  'plain' | 'kw' | 'str' | 'num' | 'com' | 'fn' | 'type' | 'op';

export interface CodeSyntaxToken {
  kind: CodeTokenKind;
  text: string;
}

const DIAGRAM_LANGUAGES = new Set([
  'mermaid',
  'svg',
  'pele',
  'plantuml',
  'puml',
  'echarts',
  'echart',
  'seamind-math',
  'seamind-viz',
  'seamind-html-card',
]);

export function isDiagramCodeLanguage(language: string): boolean {
  return DIAGRAM_LANGUAGES.has(language.trim().toLowerCase());
}

export function normalizeCodeBlockLanguage(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (!clean) return 'text';
  if (clean === 'py' || clean === 'python3') return 'python';
  if (clean === 'c++' || clean === 'cxx' || clean === 'cc' || clean === 'hpp') {
    return 'cpp';
  }
  if (clean === 'h') return 'c';
  if (clean === 'js' || clean === 'mjs' || clean === 'cjs') return 'javascript';
  if (clean === 'jsx') return 'javascript';
  if (clean === 'ts' || clean === 'mts' || clean === 'cts') return 'typescript';
  if (clean === 'tsx') return 'typescript';
  if (clean === 'pwsh' || clean === 'ps1') return 'powershell';
  if (clean === 'sh' || clean === 'zsh' || clean === 'shell') return 'bash';
  if (clean === 'rs') return 'rust';
  if (clean === 'yml') return 'yaml';
  if (clean === 'md') return 'markdown';
  if (clean === 'plaintext' || clean === 'plain' || clean === 'txt') {
    return 'text';
  }
  return clean;
}

export function codeLanguageBadge(language: string): string {
  const norm = normalizeCodeBlockLanguage(language);
  switch (norm) {
    case 'python':
      return 'PY';
    case 'cpp':
      return 'C++';
    case 'c':
      return 'C';
    case 'typescript':
      return 'TS';
    case 'javascript':
      return 'JS';
    case 'rust':
      return 'RS';
    case 'go':
      return 'GO';
    case 'sql':
      return 'SQL';
    case 'json':
      return 'JSON';
    case 'yaml':
      return 'YAML';
    case 'bash':
      return 'SH';
    case 'powershell':
      return 'PWSH';
    case 'java':
      return 'JAVA';
    case 'html':
      return 'HTML';
    case 'css':
      return 'CSS';
    case 'markdown':
      return 'MD';
    case 'text':
      return 'CODE';
    default:
      return norm.slice(0, 6).toUpperCase();
  }
}

export function codeLanguageDisplayName(language: string): string {
  const norm = normalizeCodeBlockLanguage(language);
  switch (norm) {
    case 'python':
      return 'Python';
    case 'cpp':
      return 'C++';
    case 'c':
      return 'C';
    case 'typescript':
      return 'TypeScript';
    case 'javascript':
      return 'JavaScript';
    case 'rust':
      return 'Rust';
    case 'go':
      return 'Go';
    case 'sql':
      return 'SQL';
    case 'json':
      return 'JSON';
    case 'yaml':
      return 'YAML';
    case 'bash':
      return 'Shell';
    case 'powershell':
      return 'PowerShell';
    case 'java':
      return 'Java';
    case 'html':
      return 'HTML';
    case 'css':
      return 'CSS';
    case 'text':
      return 'Plain Code';
    default:
      return norm.toUpperCase();
  }
}

export function computeCodeBlockResultKey(
  language: string,
  source: string,
  sourceRange?: { lineIndex: number; endLineIndex: number },
): string {
  const norm = normalizeCodeBlockLanguage(language);
  const trimmed = source.trim();
  let hash = 2166136261;
  for (let i = 0; i < trimmed.length; i += 1) {
    hash ^= trimmed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const rangePart = sourceRange
    ? `${sourceRange.lineIndex}-${sourceRange.endLineIndex}`
    : 'any';
  return `${norm}:${rangePart}:${(hash >>> 0).toString(36)}`;
}

const PY_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

const C_KEYWORDS = new Set([
  'auto',
  'bool',
  'break',
  'case',
  'char',
  'class',
  'const',
  'constexpr',
  'continue',
  'default',
  'delete',
  'do',
  'double',
  'else',
  'enum',
  'extern',
  'false',
  'float',
  'for',
  'if',
  'inline',
  'int',
  'long',
  'namespace',
  'new',
  'nullptr',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'struct',
  'switch',
  'template',
  'this',
  'true',
  'typedef',
  'typename',
  'unsigned',
  'using',
  'virtual',
  'void',
  'while',
  'std',
  'vector',
  'string',
]);

const JS_KEYWORDS = new Set([
  'async',
  'await',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'number',
  'of',
  'private',
  'public',
  'readonly',
  'return',
  'static',
  'string',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
]);

const SQL_KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'INSERT',
  'INTO',
  'VALUES',
  'UPDATE',
  'SET',
  'DELETE',
  'CREATE',
  'TABLE',
  'IF',
  'NOT',
  'EXISTS',
  'PRIMARY',
  'KEY',
  'FOREIGN',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'ON',
  'GROUP',
  'BY',
  'ORDER',
  'ASC',
  'DESC',
  'LIMIT',
  'OFFSET',
  'AS',
  'AND',
  'OR',
  'IN',
  'IS',
  'NULL',
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
  'REPLACE',
  'WITH',
  'HAVING',
  'DISTINCT',
]);

const RUST_GO_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'chan',
  'const',
  'continue',
  'defer',
  'else',
  'enum',
  'false',
  'fn',
  'for',
  'func',
  'go',
  'if',
  'impl',
  'import',
  'in',
  'interface',
  'let',
  'loop',
  'map',
  'match',
  'mod',
  'mut',
  'nil',
  'package',
  'pub',
  'range',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'trait',
  'true',
  'type',
  'use',
  'var',
  'where',
  'while',
]);

const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'in',
  'do',
  'done',
  'while',
  'case',
  'esac',
  'function',
  'export',
  'local',
  'return',
  'echo',
  'cd',
  'sudo',
  'param',
  'foreach',
  'try',
  'catch',
]);

export function tokenizeUniversalCodeLine(
  line: string,
  language: string,
): CodeSyntaxToken[] {
  if (!line) return [{ kind: 'plain', text: ' ' }];
  const norm = normalizeCodeBlockLanguage(language);
  const tokens: CodeSyntaxToken[] = [];
  const hashComment =
    norm === 'python' ||
    norm === 'bash' ||
    norm === 'powershell' ||
    norm === 'yaml';
  const dashComment = norm === 'sql';
  const slashComment =
    norm === 'c' ||
    norm === 'cpp' ||
    norm === 'javascript' ||
    norm === 'typescript' ||
    norm === 'rust' ||
    norm === 'go' ||
    norm === 'java' ||
    norm === 'css';
  const kwSet =
    norm === 'python'
      ? PY_KEYWORDS
      : norm === 'c' || norm === 'cpp' || norm === 'java'
        ? C_KEYWORDS
        : norm === 'javascript' || norm === 'typescript'
          ? JS_KEYWORDS
          : norm === 'sql'
            ? SQL_KEYWORDS
            : norm === 'rust' || norm === 'go'
              ? RUST_GO_KEYWORDS
              : norm === 'bash' || norm === 'powershell'
                ? SHELL_KEYWORDS
                : null;

  const isPreproc = (norm === 'c' || norm === 'cpp') && /^\s*#/.test(line);
  if (isPreproc) {
    return [{ kind: 'kw', text: line }];
  }

  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (hashComment && ch === '#') {
      tokens.push({ kind: 'com', text: line.slice(i) });
      break;
    }
    if (dashComment && ch === '-' && line[i + 1] === '-') {
      tokens.push({ kind: 'com', text: line.slice(i) });
      break;
    }
    if (slashComment && ch === '/' && line[i + 1] === '/') {
      tokens.push({ kind: 'com', text: line.slice(i) });
      break;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      tokens.push({ kind: 'str', text: line.slice(i, j) });
      i = j;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxX._]/.test(line[j])) j += 1;
      tokens.push({ kind: 'num', text: line.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(line[j])) j += 1;
      const word = line.slice(i, j);
      const isKeyword =
        kwSet !== null &&
        (norm === 'sql' ? kwSet.has(word.toUpperCase()) : kwSet.has(word));
      if (isKeyword) {
        tokens.push({ kind: 'kw', text: word });
      } else if (line[j] === '(') {
        tokens.push({ kind: 'fn', text: word });
      } else if (
        norm !== 'sql' &&
        norm !== 'json' &&
        /^[A-Z][A-Za-z0-9_]+$/.test(word) &&
        !/^[A-Z0-9_]+$/.test(word)
      ) {
        tokens.push({ kind: 'type', text: word });
      } else {
        tokens.push({ kind: 'plain', text: word });
      }
      i = j;
      continue;
    }
    let j = i + 1;
    while (
      j < n &&
      !/[A-Za-z0-9_$"'`#/-]/.test(line[j]) &&
      line[j] !== line[i]
    ) {
      j += 1;
    }
    tokens.push({ kind: 'plain', text: line.slice(i, j) });
    i = j;
  }
  return tokens;
}

export function renderCodeLinesInto(
  codeEl: HTMLElement,
  gutterEl: HTMLElement,
  source: string,
  language: string,
): number {
  const normalized = source.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const lines = normalized.split('\n');
  const gutterFrag = document.createDocumentFragment();
  const codeFrag = document.createDocumentFragment();

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNo = document.createElement('span');
    lineNo.textContent = String(idx + 1);
    gutterFrag.append(lineNo);

    const row = document.createElement('div');
    row.className = 'seamind-mm-code-line';
    const tokens = tokenizeUniversalCodeLine(lines[idx] ?? '', language);
    for (const tok of tokens) {
      if (tok.kind === 'plain') {
        row.append(document.createTextNode(tok.text));
      } else {
        const span = document.createElement('span');
        span.className = `cl-tok-${tok.kind}`;
        span.textContent = tok.text;
        row.append(span);
      }
    }
    codeFrag.append(row);
  }

  gutterEl.replaceChildren(gutterFrag);
  codeEl.replaceChildren(codeFrag);
  return lines.length;
}
