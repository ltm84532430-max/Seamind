import postcss from 'postcss';

const MAX_MERMAID_CSS_CHARS = 100_000;

const paint =
  /^(?:none|currentcolor|transparent|#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s/+-]+\)|hsla?\([\d.,%\s/+-]+\))$/i;
const cssVariable =
  /^var\(\s*--[\w-]{1,80}\s*(?:,\s*(?:#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s/+-]+\)|hsla?\([\d.,%\s/+-]+\))\s*)?\)$/i;
const localPaint = /^url\(\s*['"]?#[\w-]{1,120}['"]?\s*\)$/i;
const length = /^(?:\d+(?:\.\d*)?|\.\d+)(?:px|em|rem|pt|%)?$/i;
const signedLength = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:px|em|rem|pt|%)?$/i;
const numberList = /^[-+\d.eE,\s]+$/;

function safeValue(property: string, raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > 500) return false;
  if (['fill', 'stroke'].includes(property)) {
    return (
      paint.test(value) || cssVariable.test(value) || localPaint.test(value)
    );
  }
  if (
    ['color', 'background', 'background-color', 'stop-color'].includes(property)
  ) {
    return paint.test(value) || cssVariable.test(value);
  }
  if (property === 'font-family') {
    return /^[\w\s,'".-]{1,120}$/.test(value) || cssVariable.test(value);
  }
  if (property === 'font-weight') {
    return /^(?:normal|bold|bolder|lighter|[1-9]00)$/i.test(value);
  }
  if (property === 'font-style')
    return /^(?:normal|italic|oblique)$/i.test(value);
  if (
    [
      'font-size',
      'stroke-width',
      'letter-spacing',
      'line-height',
      'max-width',
      'min-width',
      'rx',
      'ry',
    ].includes(property)
  ) {
    return (property === 'letter-spacing' ? signedLength : length).test(value);
  }
  if (
    ['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity'].includes(
      property,
    )
  ) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 1;
  }
  if (property === 'stroke-dasharray')
    return value === 'none' || numberList.test(value);
  if (property === 'stroke-linecap')
    return /^(?:butt|round|square)$/.test(value);
  if (property === 'stroke-linejoin')
    return /^(?:miter|round|bevel)$/.test(value);
  if (property === 'text-anchor') return /^(?:start|middle|end)$/.test(value);
  if (property === 'text-align')
    return /^(?:start|end|left|right|center)$/.test(value);
  if (property === 'white-space')
    return /^(?:normal|nowrap|pre|pre-wrap|pre-line)$/.test(value);
  if (property === 'display') return /^(?:none|inline|block)$/.test(value);
  if (property === 'visibility')
    return /^(?:visible|hidden|collapse)$/.test(value);
  if (property === 'pointer-events')
    return /^(?:none|auto|visiblePainted)$/.test(value);
  return false;
}

function safeDeclarations(source: string): string[] {
  try {
    const root = postcss.parse(`x{${source}}`);
    const rule = root.first;
    if (!rule || rule.type !== 'rule') return [];
    const declarations: string[] = [];
    for (const node of rule.nodes ?? []) {
      if (node.type !== 'decl') continue;
      const property = node.prop.toLowerCase();
      if (!safeValue(property, node.value)) continue;
      declarations.push(
        `${property}:${node.value.trim()}${node.important ? '!important' : ''}`,
      );
    }
    return declarations;
  } catch {
    return [];
  }
}

/** Keep Mermaid's visual rules while preventing SVG CSS from styling the app. */
export function sanitizeScopedMermaidCss(
  source: string,
  svgId: string,
): string {
  if (source.length > MAX_MERMAID_CSS_CHARS || !/^[\w-]{1,120}$/.test(svgId)) {
    return '';
  }
  try {
    const root = postcss.parse(source);
    const rules: string[] = [];
    for (const node of root.nodes) {
      if (node.type !== 'rule') continue;
      const selectors = postcss.list.comma(node.selector);
      if (
        !selectors.length ||
        selectors.some((selector) => {
          if (!selector.startsWith(`#${svgId}`)) return true;
          const next = selector[svgId.length + 1];
          return (
            (next !== undefined && !/[\s.:>[#]/.test(next)) ||
            /[+~@{};\\]/.test(selector) ||
            !/^[\w\s#.,:>\]="'()*/-]+$/.test(selector)
          );
        })
      ) {
        continue;
      }
      const declarations = safeDeclarations(
        (node.nodes ?? []).map((child) => child.toString()).join(';'),
      );
      if (declarations.length) {
        rules.push(`${selectors.join(',')}{${declarations.join(';')}}`);
      }
    }
    return rules.join('\n');
  } catch {
    return '';
  }
}

export function sanitizeMermaidInlineCss(source: string): string {
  if (source.length > MAX_MERMAID_CSS_CHARS) return '';
  return safeDeclarations(source).join(';');
}
