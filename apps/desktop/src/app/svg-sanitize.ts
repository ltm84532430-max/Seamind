export const MAX_SAFE_SVG_CHARS = 300_000;

export const katexSvgElements = new Set(['svg', 'path', 'line']);
export const katexSvgAttributes = new Set([
  'xmlns',
  'width',
  'height',
  'viewbox',
  'preserveaspectratio',
  'd',
  'x1',
  'y1',
  'x2',
  'y2',
  'stroke-width',
  'class',
  'style',
  'aria-hidden',
]);

export const safeSvgElements = new Set([
  'svg',
  'g',
  'path',
  'line',
  'circle',
  'rect',
  'ellipse',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'defs',
  'marker',
  'clippath',
  'mask',
  'pattern',
  'symbol',
  'use',
  'lineargradient',
  'radialgradient',
  'stop',
  'style',
  'foreignobject',
]);

export const safeSvgAttributes = new Set([
  'xmlns',
  'width',
  'height',
  'viewbox',
  'preserveaspectratio',
  'x',
  'y',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'x1',
  'y1',
  'x2',
  'y2',
  'd',
  'points',
  'pathlength',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'fill-rule',
  'clip-rule',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'stop-color',
  'stop-opacity',
  'offset',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'patternunits',
  'patterncontentunits',
  'patterntransform',
  'maskunits',
  'maskcontentunits',
  'clippathunits',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'text-decoration',
  'dx',
  'dy',
  'letter-spacing',
  'transform',
  'transform-origin',
  'class',
  'id',
  'style',
  'marker-start',
  'marker-mid',
  'marker-end',
  'markerwidth',
  'markerheight',
  'markerunits',
  'refx',
  'refy',
  'orient',
  'clip-path',
  'mask',
  'href',
  'xlink:href',
  'overflow',
  'visibility',
  'display',
  'role',
  'aria-label',
  'aria-hidden',
]);

const safeForeignObjectHtmlElements = new Set([
  'div',
  'p',
  'span',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'code',
  'pre',
  'sub',
  'sup',
  'ul',
  'ol',
  'li',
  'small',
]);

const katexLength = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|px|pt|%)?$/i;
const svgNumber =
  /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:px|%|em|rem|pt)?$/i;
const svgNonNegativeNumber =
  /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:px|%|em|rem|pt)?$/i;
const svgViewBox =
  /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:[\s,]+[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?){3}\s*$/i;
const svgPathData = /^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-\s]+$/;
const svgPoints = /^[-+\d.eE,\s]+$/;
const safeSvgPaint =
  /^(?:none|currentcolor|transparent|#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s/+-]+\)|hsla?\([\d.,%\s/+-]+\))$/i;
const safeCssVariable =
  /^var\(\s*--[\w-]{1,40}\s*(?:,\s*(?:#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s/+-]+\)|hsla?\([\d.,%\s/+-]+\))\s*)?\)$/i;
const safeLocalUrlRef = /^url\(\s*(?:['"]?#[\w-]{1,120}['"]?)\s*\)$/i;
const safeFragmentHref = /^#[\w-]{1,120}$/;

export function isSafeSvgStyle(value: string): boolean {
  if (value.length > 100_000) return false;
  if (
    /(?:@import|@font-face|@charset|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding)/i.test(
      value,
    )
  ) {
    return false;
  }
  const urlMatches = value.matchAll(/url\(([^)]*)\)/gi);
  for (const match of urlMatches) {
    if (!/^\s*(?:['"]?#[\w-]{1,120}['"]?)\s*$/.test(match[1])) {
      return false;
    }
  }
  return /^[\w\s#.,:;{}()%[\]"'+/*>-]+$/.test(value);
}

function isSafeForeignObjectStyle(value: string): boolean {
  if (!isSafeSvgStyle(value)) return false;
  if (/url\s*\(/i.test(value)) return false;
  if (/position\s*:\s*(?:fixed|sticky)/i.test(value)) return false;
  return true;
}

export function isSafeKatexSvgAttribute(name: string, value: string): boolean {
  const normalizedValue = value.trim();
  if (name === 'xmlns') return normalizedValue === 'http://www.w3.org/2000/svg';
  if (name === 'viewbox')
    return /^[-+\d.]+(?:\s+[-+\d.]+){3}$/.test(normalizedValue);
  if (name === 'preserveaspectratio')
    return /^(?:xMin|xMid|xMax)(?:YMin|YMid|YMax)(?:\s+(?:meet|slice))?$/i.test(
      normalizedValue,
    );
  if (name === 'd')
    return /^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-\s]+$/.test(normalizedValue);
  if (
    name === 'width' ||
    name === 'height' ||
    name === 'stroke-width' ||
    /^x[12]$|^y[12]$/.test(name)
  ) {
    return katexLength.test(normalizedValue);
  }
  if (name === 'aria-hidden')
    return normalizedValue === 'true' || normalizedValue === 'false';
  if (name === 'class') return /^[\w\s-]*$/.test(normalizedValue);
  return name === 'style';
}

function boundedSvgNumber(value: string, allowNegative: boolean): boolean {
  const matcher = allowNegative ? svgNumber : svgNonNegativeNumber;
  if (!matcher.test(value)) return false;
  const num = Number(value.replace(/(?:px|%|em|rem|pt)$/i, ''));
  return Number.isFinite(num) && Math.abs(num) <= 1_000_000;
}

function isSafeSvgAttribute(
  elementName: string,
  name: string,
  value: string,
): boolean {
  const normalizedValue = value.trim();
  if (name === 'xmlns') return normalizedValue === 'http://www.w3.org/2000/svg';
  if (name === 'viewbox') {
    if (!svgViewBox.test(normalizedValue)) return false;
    const values = normalizedValue
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    return (
      values.length === 4 &&
      values.every(
        (number) => Number.isFinite(number) && Math.abs(number) <= 1_000_000,
      ) &&
      values[2] > 0 &&
      values[3] > 0
    );
  }
  if (name === 'preserveaspectratio') {
    return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/i.test(
      normalizedValue,
    );
  }
  if (name === 'd') {
    return (
      normalizedValue.length <= 200_000 && svgPathData.test(normalizedValue)
    );
  }
  if (name === 'points') {
    return normalizedValue.length <= 100_000 && svgPoints.test(normalizedValue);
  }
  if (name === 'href' || name === 'xlink:href') {
    return elementName === 'use' && safeFragmentHref.test(normalizedValue);
  }
  if (
    [
      'width',
      'height',
      'r',
      'rx',
      'ry',
      'fr',
      'stroke-width',
      'stroke-miterlimit',
      'markerwidth',
      'markerheight',
      'pathlength',
      'font-size',
    ].includes(name)
  ) {
    return boundedSvgNumber(normalizedValue, false);
  }
  if (
    [
      'x',
      'y',
      'cx',
      'cy',
      'fx',
      'fy',
      'x1',
      'y1',
      'x2',
      'y2',
      'dx',
      'dy',
      'refx',
      'refy',
      'stroke-dashoffset',
      'letter-spacing',
      'offset',
    ].includes(name)
  ) {
    return (
      boundedSvgNumber(normalizedValue, true) ||
      (name === 'refx' && /^(?:left|center|right)$/i.test(normalizedValue)) ||
      (name === 'refy' && /^(?:top|center|bottom)$/i.test(normalizedValue))
    );
  }
  if (name === 'id') return /^[\w-]{1,120}$/.test(normalizedValue);
  if (name === 'class') return /^[\w\s-]{0,300}$/.test(normalizedValue);
  if (name === 'style') return isSafeSvgStyle(normalizedValue);
  if (
    ['marker-start', 'marker-mid', 'marker-end', 'clip-path', 'mask'].includes(
      name,
    )
  ) {
    return normalizedValue === 'none' || safeLocalUrlRef.test(normalizedValue);
  }
  if (name === 'fill' || name === 'stroke' || name === 'stop-color') {
    return (
      safeSvgPaint.test(normalizedValue) ||
      safeCssVariable.test(normalizedValue) ||
      (name !== 'stop-color' && safeLocalUrlRef.test(normalizedValue))
    );
  }
  if (name === 'font-weight') {
    return (
      /^(?:normal|bold|bolder|lighter|[1-9]00)$/i.test(normalizedValue) ||
      safeCssVariable.test(normalizedValue)
    );
  }
  if (name === 'font-style') {
    return /^(?:normal|italic|oblique)$/i.test(normalizedValue);
  }
  if (name === 'font-family') {
    return /^[\w\s,'".-]{1,120}$/.test(normalizedValue);
  }
  if (name === 'text-anchor')
    return ['start', 'middle', 'end'].includes(normalizedValue);
  if (name === 'dominant-baseline' || name === 'alignment-baseline') {
    return [
      'auto',
      'middle',
      'central',
      'hanging',
      'baseline',
      'alphabetic',
      'mathematical',
      'ideographic',
      'text-before-edge',
      'text-after-edge',
    ].includes(normalizedValue);
  }
  if (name === 'text-decoration') {
    return /^(?:none|underline|overline|line-through)$/i.test(normalizedValue);
  }
  if (name === 'stroke-linecap')
    return ['butt', 'round', 'square'].includes(normalizedValue);
  if (name === 'stroke-linejoin')
    return ['miter', 'round', 'bevel'].includes(normalizedValue);
  if (name === 'stroke-dasharray')
    return /^(?:none|[-+\d.eE,\s]+)$/i.test(normalizedValue);
  if (name === 'fill-rule' || name === 'clip-rule')
    return ['nonzero', 'evenodd'].includes(normalizedValue);
  if (
    ['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity'].includes(name)
  ) {
    const number = Number(normalizedValue);
    return Number.isFinite(number) && number >= 0 && number <= 1;
  }
  if (name === 'transform') {
    return /^(?:(?:matrix|translate|translateX|translateY|scale|rotate|skewX|skewY)\([-+\d.eE,\s]+\)\s*)+$/i.test(
      normalizedValue,
    );
  }
  if (name === 'transform-origin') {
    return /^[\w\s.%+-]{1,40}$/.test(normalizedValue);
  }
  if (name === 'orient')
    return /^(?:auto|auto-start-reverse|[-+\d.eE]+)$/i.test(normalizedValue);
  if (
    [
      'markerunits',
      'gradientunits',
      'patternunits',
      'patterncontentunits',
      'maskunits',
      'maskcontentunits',
      'clippathunits',
    ].includes(name)
  ) {
    return /^(?:strokewidth|userspaceonuse|objectboundingbox)$/i.test(
      normalizedValue,
    );
  }
  if (name === 'gradienttransform' || name === 'patterntransform') {
    return /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([-+\d.eE,\s]+\)\s*)+$/i.test(
      normalizedValue,
    );
  }
  if (name === 'spreadmethod') {
    return ['pad', 'reflect', 'repeat'].includes(normalizedValue.toLowerCase());
  }
  if (name === 'overflow')
    return ['visible', 'hidden'].includes(normalizedValue);
  if (name === 'visibility')
    return ['visible', 'hidden', 'collapse'].includes(normalizedValue);
  if (name === 'display')
    return ['inline', 'block', 'none'].includes(normalizedValue);
  if (name === 'role') return ['img', 'presentation'].includes(normalizedValue);
  if (name === 'aria-hidden')
    return normalizedValue === 'true' || normalizedValue === 'false';
  if (name === 'aria-label') return normalizedValue.length <= 240;
  return false;
}

function sanitizeForeignObjectSubtree(foreignObject: Element): void {
  const descendants = Array.from(foreignObject.querySelectorAll('*'));
  for (const child of descendants) {
    const tag = child.localName.toLowerCase();
    if (!safeForeignObjectHtmlElements.has(tag)) {
      child.remove();
      continue;
    }
    for (const attribute of Array.from(child.attributes)) {
      const name = attribute.name.toLowerCase();
      const val = attribute.value.trim();
      const allowed =
        (name === 'xmlns' && val === 'http://www.w3.org/1999/xhtml') ||
        (name === 'class' && /^[\w\s-]{0,300}$/.test(val)) ||
        (name === 'style' && isSafeForeignObjectStyle(val));
      if (!allowed) {
        child.removeAttribute(attribute.name);
      }
    }
  }
}

function stripDisallowedSvgAttributes(
  element: Element,
  isKatex: boolean,
): void {
  const elementName = element.localName.toLowerCase();
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const isAllowed = isKatex
      ? katexSvgAttributes.has(name) &&
        isSafeKatexSvgAttribute(name, attribute.value)
      : safeSvgAttributes.has(name) &&
        isSafeSvgAttribute(elementName, name, attribute.value);
    if (!isAllowed) {
      element.removeAttribute(attribute.name);
    }
  }
  if (
    !isKatex &&
    elementName === 'use' &&
    !element.getAttribute('href') &&
    !element.getAttribute('xlink:href')
  ) {
    element.remove();
  }
}

function isInsideForeignObject(element: Element, root: Element): boolean {
  let cursor = element.parentElement;
  while (cursor && cursor !== root) {
    if (cursor.localName.toLowerCase() === 'foreignobject') return true;
    cursor = cursor.parentElement;
  }
  return false;
}

export function sanitizeSvgTree(root: Element, isKatex = false): void {
  const allowedElements = isKatex ? katexSvgElements : safeSvgElements;
  const elements = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const element of elements) {
    if (element !== root && !root.contains(element)) continue;
    if (!isKatex && element !== root && isInsideForeignObject(element, root)) {
      continue;
    }
    const name = element.localName.toLowerCase();
    if (!allowedElements.has(name)) {
      element.remove();
      continue;
    }
    if (name === 'style') {
      if (!isSafeSvgStyle(element.textContent ?? '')) {
        element.remove();
      }
      continue;
    }
    stripDisallowedSvgAttributes(element, isKatex);
    if (!isKatex && name === 'foreignobject' && root.contains(element)) {
      sanitizeForeignObjectSubtree(element);
    }
  }
}

function prepareSvgXmlSource(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/^<\?xml[^>]*\?>\s*/i, '');
  if (!/^<svg\b[^>]*>/i.test(cleaned)) return cleaned;
  return cleaned.replace(/^<svg\b([^>]*)>/i, (full, attrs: string) =>
    /\bxmlns\s*=/i.test(attrs)
      ? full
      : `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>`,
  );
}

export function parseSafeSvgElement(source: string): SVGSVGElement | null {
  if (
    source.length > MAX_SAFE_SVG_CHARS ||
    /<!doctype|<!entity/i.test(source)
  ) {
    return null;
  }
  const normalized = prepareSvgXmlSource(source);
  const parsed = new DOMParser().parseFromString(normalized, 'image/svg+xml');
  const root = parsed.documentElement;
  if (
    parsed.querySelector('parsererror') ||
    root.localName.toLowerCase() !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg'
  ) {
    return null;
  }
  sanitizeSvgTree(root, false);
  return root as unknown as SVGSVGElement;
}

export function sanitizeSvgMarkup(source: string): string | null {
  const root = parseSafeSvgElement(source);
  if (!root) return null;
  return new XMLSerializer().serializeToString(root);
}

const SAFE_SVG_CONTENT_SELECTOR =
  'path,line,circle,rect,ellipse,polyline,polygon,text,tspan,foreignObject,foreignobject,use';

/** 将剪贴板中的 SVG 收敛为可编辑、可离线渲染的安全图形源码。 */
export function preparePastedSvg(source: string): string {
  if (source.length > MAX_SAFE_SVG_CHARS) {
    throw new Error('SVG 图形超过 300 KB。');
  }
  if (/<!doctype|<!entity/i.test(source)) {
    throw new Error('剪贴板中的 SVG 格式无效。');
  }
  const normalized = prepareSvgXmlSource(source);
  const parsed = new DOMParser().parseFromString(normalized, 'image/svg+xml');
  const root = parsed.documentElement;
  if (
    parsed.querySelector('parsererror') ||
    root.localName.toLowerCase() !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg'
  ) {
    throw new Error('剪贴板中的 SVG 格式无效。');
  }
  if (
    parsed.querySelector('image, script, iframe, object, embed, video, audio')
  ) {
    throw new Error(
      'SVG 含有外部图像或脚本内容，无法完整安全导入；请复制图形截图。',
    );
  }
  const hasExternalUse = Array.from(parsed.querySelectorAll('use')).some(
    (node) => {
      const href =
        node.getAttribute('href')?.trim() ||
        node.getAttribute('xlink:href')?.trim() ||
        '';
      return Boolean(href && !safeFragmentHref.test(href));
    },
  );
  if (hasExternalUse) {
    throw new Error('SVG 含有外部引用资源，无法完整安全导入；请复制图形截图。');
  }

  sanitizeSvgTree(root, false);
  if (!root.querySelector(SAFE_SVG_CONTENT_SELECTOR)) {
    throw new Error('SVG 没有可保留的图形元素；请复制图形截图。');
  }
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(root);
}
