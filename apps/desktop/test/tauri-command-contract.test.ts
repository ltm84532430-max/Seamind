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
});
