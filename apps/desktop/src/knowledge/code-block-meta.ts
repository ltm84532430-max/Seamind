export interface CodeBlockMeta {
  id: string;
  sourceFile: string;
  links: string[];
}

const META_PREFIXES = ['seamind-id=', 'seamind-file=', 'seamind-links='];

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

export function readCodeBlockMeta(info: string): CodeBlockMeta {
  const tokens = info.trim().split(/\s+/);
  const idToken = tokens.find((part) => part.startsWith(META_PREFIXES[0]));
  const fileToken = tokens.find((part) => part.startsWith(META_PREFIXES[1]));
  const linksToken = tokens.find((part) => part.startsWith(META_PREFIXES[2]));
  const id = idToken?.slice(META_PREFIXES[0].length) ?? '';
  const sourceFile = decode(fileToken?.slice(META_PREFIXES[1].length) ?? '');
  let links: string[] = [];
  if (linksToken) {
    try {
      const parsed: unknown = JSON.parse(
        decode(linksToken.slice(META_PREFIXES[2].length)),
      );
      if (Array.isArray(parsed)) {
        links = parsed
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 20);
      }
    } catch {
      // An invalid annotation never prevents its code fence from rendering.
    }
  }
  return {
    id: /^[a-z0-9-]{1,40}$/i.test(id) ? id : '',
    sourceFile: sourceFile.slice(0, 1000),
    links,
  };
}

export function writeCodeBlockInfo(
  language: string,
  previousInfo: string,
  meta: CodeBlockMeta,
): string {
  const other = previousInfo
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter((part) => !META_PREFIXES.some((prefix) => part.startsWith(prefix)));
  const info = [language.trim().toLowerCase() || 'text', ...other];
  if (meta.id) info.push(`${META_PREFIXES[0]}${meta.id}`);
  if (meta.sourceFile)
    info.push(`${META_PREFIXES[1]}${encodeURIComponent(meta.sourceFile)}`);
  if (meta.links.length)
    info.push(
      `${META_PREFIXES[2]}${encodeURIComponent(JSON.stringify(meta.links))}`,
    );
  return info.join(' ');
}

export function newCodeBlockId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
