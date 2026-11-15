import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('Tauri command names', () => {
  it('registers every literal frontend invoke in the Rust command handler', () => {
    const rust = readFileSync(
      join(desktopRoot, 'src-tauri/src/lib.rs'),
      'utf8',
    );
    const handler = rust.match(/tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1];
    expect(handler).toBeDefined();
    const registered = new Set(
      Array.from(handler!.matchAll(/^\s*([A-Za-z_][\w:]*)\s*,/gm), (match) =>
        match[1].split('::').at(-1),
      ),
    );
    const missing: string[] = [];
    for (const path of sourceFiles(join(desktopRoot, 'src'))) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'invoke' &&
          node.arguments.length > 0 &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const command = node.arguments[0].text;
          if (!registered.has(command)) {
            missing.push(`${path.replace(desktopRoot, '')}: ${command}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(missing).toEqual([]);
  });

  it('keeps the Tauri transport out of view components', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(join(desktopRoot, 'src')).filter((item) =>
      item.endsWith('.tsx'),
    )) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      for (const statement of source.statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text === '@tauri-apps/api/core' &&
          statement.importClause?.namedBindings &&
          ts.isNamedImports(statement.importClause.namedBindings) &&
          statement.importClause.namedBindings.elements.some(
            (element) =>
              (element.propertyName ?? element.name).text === 'invoke',
          )
        ) {
          violations.push(path.replace(desktopRoot, ''));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('matches invoke arguments and return types to the Rust commands', () => {
    const commands = rustCommands(join(desktopRoot, 'src-tauri/src'));
    const mismatches: string[] = [];
    for (const path of sourceFiles(join(desktopRoot, 'src'))) {
      const text = readFileSync(path, 'utf8');
      const source = ts.createSourceFile(
        path,
        text,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'invoke' &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const commandName = node.arguments[0].text;
          const command = commands.get(commandName);
          const where = `${path.replace(desktopRoot, '')}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
          if (!command) {
            mismatches.push(
              `${where} ${commandName}: command signature was not found`,
            );
          } else {
            const argument = node.arguments[1];
            if (argument && ts.isObjectLiteralExpression(argument)) {
              const keys = objectKeys(argument);
              if (keys) {
                for (const key of keys) {
                  if (!command.params.some((param) => param.name === key)) {
                    mismatches.push(
                      `${where} ${commandName}: frontend sends "${key}", Rust accepts ${command.params.map((param) => param.name).join(', ') || 'no fields'}`,
                    );
                  }
                }
                for (const param of command.params) {
                  if (!param.optional && !keys.includes(param.name)) {
                    mismatches.push(
                      `${where} ${commandName}: missing required "${param.name}"`,
                    );
                  }
                }
              }
            } else if (!argument) {
              for (const param of command.params) {
                if (!param.optional) {
                  mismatches.push(
                    `${where} ${commandName}: missing required "${param.name}"`,
                  );
                }
              }
            }
            const returned = returnShape(
              node.typeArguments?.[0]?.getText(source) ?? '',
            );
            if (returned.raw && !sameShape(returned, command.returns)) {
              mismatches.push(
                `${where} ${commandName}: frontend returns ${returned.raw}, Rust returns ${command.returns.raw}`,
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(mismatches).toEqual([]);
  });
});

interface CommandParam {
  name: string;
  optional: boolean;
}

interface CommandSignature {
  params: CommandParam[];
  returns: TypeShape;
}

interface TypeShape {
  raw: string;
  name: string;
  array: boolean;
  nullable: boolean;
}

function rustCommands(directory: string): Map<string, CommandSignature> {
  const commands = new Map<string, CommandSignature>();
  for (const path of rustFiles(directory)) {
    const source = readFileSync(path, 'utf8');
    const marker = /#\[tauri::command(?:\([^)]*\))?\]/g;
    for (const match of source.matchAll(marker)) {
      const start = (match.index ?? 0) + match[0].length;
      const fnMatch =
        /^\s*(?:#\[[^\]]+\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/s.exec(
          source.slice(start),
        );
      if (!fnMatch) continue;
      const name = fnMatch[1];
      const paramsAt = start + fnMatch.index + fnMatch[0].length;
      const paramsEnd = matchingParen(source, paramsAt - 1);
      if (paramsEnd < 0) continue;
      const returnsAt = /^\s*(?:->\s*([\s\S]*?))?\s*\{/s.exec(
        source.slice(paramsEnd + 1),
      );
      commands.set(name, {
        params: rustParams(source.slice(paramsAt, paramsEnd)),
        returns: returnShape(normalizeRustReturn(returnsAt?.[1] ?? '()')),
      });
    }
  }
  return commands;
}

function rustFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === 'target' ? [] : rustFiles(path);
    return entry.name.endsWith('.rs') ? [path] : [];
  });
}

function matchingParen(source: string, open: number): number {
  let depth = 0;
  let angle = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    } else if (char === '<') angle += 1;
    else if (char === '>') angle = Math.max(0, angle - 1);
  }
  return -1;
}

function rustParams(list: string): CommandParam[] {
  const params: CommandParam[] = [];
  let depth = 0;
  let angle = 0;
  let current = '';
  const flush = () => {
    const part = current.trim();
    current = '';
    const typed = /^(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(
      part,
    );
    if (!typed) return;
    const rustType = typed[2].replace(/\s+/g, ' ').trim();
    if (
      /State</.test(rustType) ||
      /\b(?:AppHandle|Window|WebviewWindow)\b/.test(rustType)
    ) {
      return;
    }
    params.push({
      name: typed[1].replace(/_([a-zA-Z0-9])/g, (_, char: string) =>
        char.toUpperCase(),
      ),
      optional: /^Option</.test(rustType),
    });
  };
  for (const char of list) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === '<') angle += 1;
    else if (char === '>') angle = Math.max(0, angle - 1);
    if (char === ',' && depth === 0 && angle === 0) flush();
    else current += char;
  }
  flush();
  return params;
}

function normalizeRustReturn(type: string): string {
  const text = type.replace(/\s+/g, '');
  const result = /^Result<([\s\S]*),String>$/.exec(text);
  if (result) return normalizeRustReturn(result[1]);
  if (text === '()') return 'void';
  if (text === 'String') return 'string';
  if (text === 'bool') return 'boolean';
  if (
    /^(?:i|u)(?:8|16|32|64|size)$/.test(text) ||
    text === 'f32' ||
    text === 'f64'
  ) {
    return 'number';
  }
  if (text.startsWith('Option<') && text.endsWith('>')) {
    return `${normalizeRustReturn(text.slice('Option<'.length, -1))}|null`;
  }
  if (text.startsWith('Vec<') && text.endsWith('>')) {
    return `${normalizeRustReturn(text.slice('Vec<'.length, -1))}[]`;
  }
  const map = /^(?:HashMap|BTreeMap)<String,([\s\S]*)>$/.exec(text);
  if (map) return `Record<string,${normalizeRustReturn(map[1])}>`;
  return text;
}

function returnShape(type: string): TypeShape {
  const raw = type.replace(/\s+/g, '');
  const nullable = raw.includes('|null') || raw.includes('|undefined');
  const array = raw.endsWith('[]');
  const body = raw.replace(/\|null$|\|undefined$/g, '').replace(/\[\]$/g, '');
  if (
    body.startsWith('{') ||
    body.startsWith('Record<') ||
    body.includes('&{') ||
    body === 'object'
  ) {
    return { raw, name: 'object', array, nullable };
  }
  const leaf = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(body)?.[1] ?? body;
  return { raw, name: leaf, array, nullable };
}

function sameShape(frontend: TypeShape, backend: TypeShape): boolean {
  if (!frontend.raw) return backend.name === 'void';
  if (backend.name === 'void' || frontend.name === 'void') {
    return frontend.name === backend.name;
  }
  if (frontend.array !== backend.array) return false;
  if (
    frontend.name === 'object' ||
    frontend.name === 'unknown' ||
    backend.name === 'Value'
  ) {
    return true;
  }
  const primitives = new Set(['string', 'boolean', 'number']);
  if (primitives.has(frontend.name) || primitives.has(backend.name)) {
    return (
      frontend.name === backend.name && frontend.nullable === backend.nullable
    );
  }
  return true;
}

function objectKeys(object: ts.ObjectLiteralExpression): string[] | null {
  const keys: string[] = [];
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) return null;
    if (
      ts.isShorthandPropertyAssignment(property) ||
      ts.isPropertyAssignment(property)
    ) {
      keys.push(property.name.getText().replace(/^['"]|['"]$/g, ''));
    }
  }
  return keys;
}
