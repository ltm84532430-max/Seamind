type NumericRange = [number, number];

export type MathVisualizationKind =
  | 'function-2d'
  | 'contour-2d'
  | 'vector-field-2d'
  | 'integral-1d'
  | 'surface-3d';

export interface MathVisualizationParameter {
  label?: string;
  value: number;
  min: number;
  max: number;
  step: number;
}

export interface MathVisualizationRangeControl {
  min: number;
  max: number;
  step: number;
}

export interface MathVisualizationControls {
  domain?: {
    x?: MathVisualizationRangeControl;
    y?: MathVisualizationRangeControl;
  };
  interval?: MathVisualizationRangeControl;
}

interface MathVisualizationBase {
  schemaVersion: 1;
  title?: string;
  parameters?: Record<string, MathVisualizationParameter>;
  controls?: MathVisualizationControls;
}

export interface Function2dVisualization extends MathVisualizationBase {
  kind: 'function-2d';
  expression: string;
  domain: { x: NumericRange };
  samples: number;
}

export interface Contour2dVisualization extends MathVisualizationBase {
  kind: 'contour-2d';
  expression: string;
  domain: { x: NumericRange; y: NumericRange };
  levels: number[];
  resolution: number;
}

export interface VectorField2dVisualization extends MathVisualizationBase {
  kind: 'vector-field-2d';
  vector: { u: string; v: string };
  domain: { x: NumericRange; y: NumericRange };
  resolution: number;
}

export interface Integral1dVisualization extends MathVisualizationBase {
  kind: 'integral-1d';
  expression: string;
  domain: { x: NumericRange };
  interval: NumericRange;
  samples: number;
}

export interface Surface3dVisualization extends MathVisualizationBase {
  kind: 'surface-3d';
  expression: string;
  domain: { x: NumericRange; y: NumericRange };
  resolution: number;
}

export type MathVisualizationSpec =
  | Function2dVisualization
  | Contour2dVisualization
  | VectorField2dVisualization
  | Integral1dVisualization
  | Surface3dVisualization;

export interface MathVisualizationSurface {
  xValues: number[];
  yValues: number[];
  zValues: Array<Array<number | null>>;
}

export interface MathVisualizationSeries {
  name: string;
  data: Array<[number, number | null]>;
  symbol?: string | string[];
  symbolSize?: number;
  lineStyle?: { width?: number; opacity?: number };
  areaStyle?: { opacity?: number };
  z?: number;
}

export interface MathVisualizationResult {
  series: MathVisualizationSeries[];
  surface?: MathVisualizationSurface;
  showLegend?: boolean;
  summary?: string;
}

export interface MathVisualizationWorkerRequest {
  id: number;
  spec: MathVisualizationSpec;
}

export interface MathVisualizationWorkerResponse {
  id: number;
  result?: MathVisualizationResult;
  error?: string;
}

type ExpressionNode =
  | { type: 'number'; value: number }
  | { type: 'symbol'; name: string }
  | { type: 'unary'; operator: '+' | '-'; operand: ExpressionNode }
  | {
      type: 'binary';
      operator: '+' | '-' | '*' | '/' | '^';
      left: ExpressionNode;
      right: ExpressionNode;
    }
  | { type: 'function'; name: string; argument: ExpressionNode };

type Token = { type: 'number' | 'identifier' | 'operator'; value: string };

const maxExpressionLength = 500;
const maxExpressionTokens = 256;
const maxExpressionDepth = 32;
const maxContourPaths = 300;

const mathFunctions: Record<string, (value: number) => number> = {
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  ceil: Math.ceil,
  cos: Math.cos,
  cosh: Math.cosh,
  exp: Math.exp,
  floor: Math.floor,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  round: Math.round,
  sin: Math.sin,
  sinh: Math.sinh,
  sqrt: Math.sqrt,
  tan: Math.tan,
  tanh: Math.tanh,
};

const contourCasePairs: Record<number, Array<[number, number]>> = {
  1: [[3, 0]],
  2: [[0, 1]],
  3: [[3, 1]],
  4: [[1, 2]],
  6: [[0, 2]],
  7: [[3, 2]],
  8: [[2, 3]],
  9: [[0, 2]],
  11: [[1, 2]],
  12: [[1, 3]],
  13: [[0, 1]],
  14: [[3, 0]],
};

class SafeExpressionParser {
  private readonly tokens: Token[];
  private readonly allowedVariables: Set<string>;
  private position = 0;
  private nodeCount = 0;

  constructor(source: string, allowedVariables: string[]) {
    if (source.length === 0 || source.length > maxExpressionLength)
      throw new Error(
        `表达式长度必须在 1 到 ${maxExpressionLength} 个字符之间。`,
      );
    this.allowedVariables = new Set(allowedVariables);
    this.tokens = this.tokenize(source);
  }

  parse(): ExpressionNode {
    const expression = this.parseAdditive(0);
    if (this.position !== this.tokens.length)
      throw new Error(
        `表达式中有无法识别的内容“${this.peek()?.value ?? ''}”。`,
      );
    return expression;
  }

  private tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    while (index < source.length) {
      if (/\s/.test(source[index] ?? '')) {
        index += 1;
        continue;
      }
      const remainder = source.slice(index);
      const number = remainder.match(
        /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/,
      );
      if (number) {
        const value = Number(number[0]);
        if (!Number.isFinite(value))
          throw new Error('表达式中的数字必须是有限值。');
        tokens.push({ type: 'number', value: number[0] });
        index += number[0].length;
      } else {
        const identifier = remainder.match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (identifier) {
          tokens.push({ type: 'identifier', value: identifier[0] });
          index += identifier[0].length;
        } else {
          const character = source[index] ?? '';
          if (!'+-*/^()'.includes(character))
            throw new Error(`表达式不支持“${character}”。`);
          tokens.push({ type: 'operator', value: character });
          index += 1;
        }
      }
      if (tokens.length > maxExpressionTokens)
        throw new Error(`表达式最多支持 ${maxExpressionTokens} 个组成项。`);
    }
    return tokens;
  }

  private parseAdditive(depth: number): ExpressionNode {
    let expression = this.parseMultiplicative(depth + 1);
    while (this.peek()?.value === '+' || this.peek()?.value === '-') {
      const operator = this.consume().value as '+' | '-';
      expression = this.node({
        type: 'binary',
        operator,
        left: expression,
        right: this.parseMultiplicative(depth + 1),
      });
    }
    return expression;
  }

  private parseMultiplicative(depth: number): ExpressionNode {
    let expression = this.parseUnary(depth + 1);
    while (this.peek()?.value === '*' || this.peek()?.value === '/') {
      const operator = this.consume().value as '*' | '/';
      expression = this.node({
        type: 'binary',
        operator,
        left: expression,
        right: this.parseUnary(depth + 1),
      });
    }
    return expression;
  }

  private parseUnary(depth: number): ExpressionNode {
    this.assertDepth(depth);
    if (this.peek()?.value === '+' || this.peek()?.value === '-') {
      const operator = this.consume().value as '+' | '-';
      return this.node({
        type: 'unary',
        operator,
        operand: this.parseUnary(depth + 1),
      });
    }
    return this.parsePower(depth + 1);
  }

  private parsePower(depth: number): ExpressionNode {
    let expression = this.parsePrimary(depth + 1);
    if (this.peek()?.value === '^') {
      this.consume();
      expression = this.node({
        type: 'binary',
        operator: '^',
        left: expression,
        right: this.parseUnary(depth + 1),
      });
    }
    return expression;
  }

  private parsePrimary(depth: number): ExpressionNode {
    this.assertDepth(depth);
    const token = this.peek();
    if (!token) throw new Error('表达式不完整。');
    if (token.type === 'number') {
      this.consume();
      return this.node({ type: 'number', value: Number(token.value) });
    }
    if (token.value === '(') {
      this.consume();
      const expression = this.parseAdditive(depth + 1);
      this.expect(')');
      return expression;
    }
    if (token.type === 'identifier') {
      this.consume();
      if (this.peek()?.value === '(') {
        if (!Object.prototype.hasOwnProperty.call(mathFunctions, token.value))
          throw new Error(`不支持函数“${token.value}”。`);
        this.consume();
        const argument = this.parseAdditive(depth + 1);
        this.expect(')');
        return this.node({ type: 'function', name: token.value, argument });
      }
      if (
        (token.value === 'x' || token.value === 'y') &&
        !this.allowedVariables.has(token.value)
      )
        throw new Error(token.value + ' 变量不适用于此图表类型。');
      if (
        !['x', 'y', 'pi', 'e'].includes(token.value) &&
        !this.allowedVariables.has(token.value)
      )
        throw new Error('变量“' + token.value + '”未在可视化参数中声明。');
      return this.node({
        type: 'symbol',
        name: token.value,
      });
    }
    throw new Error(`表达式在“${token.value}”附近不完整。`);
  }

  private node<T extends ExpressionNode>(node: T): T {
    this.nodeCount += 1;
    if (this.nodeCount > maxExpressionTokens)
      throw new Error('表达式结构过于复杂。');
    return node;
  }

  private assertDepth(depth: number): void {
    if (depth > maxExpressionDepth)
      throw new Error(`表达式最多支持 ${maxExpressionDepth} 层括号或嵌套。`);
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private consume(): Token {
    const token = this.peek();
    if (!token) throw new Error('表达式不完整。');
    this.position += 1;
    return token;
  }

  private expect(value: string): void {
    if (this.consume().value !== value)
      throw new Error(`表达式缺少“${value}”。`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`数学可视化配置不支持字段“${unexpected}”。`);
}

function parseRange(value: unknown, name: string): NumericRange {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((item) => typeof item === 'number' && Number.isFinite(item))
  )
    throw new Error(`${name} 必须是 [最小值, 最大值]。`);
  const [min, max] = value as NumericRange;
  if (min >= max || Math.abs(min) > 1_000_000 || Math.abs(max) > 1_000_000)
    throw new Error(
      `${name} 范围无效；两个边界需递增且绝对值不超过 1,000,000。`,
    );
  return [min, max];
}

function parseParameters(
  value: unknown,
): Record<string, MathVisualizationParameter> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('parameters 必须是对象。');
  const entries = Object.entries(value);
  if (entries.length > 8) throw new Error('最多支持 8 个可调参数。');
  const parameters: Record<string, MathVisualizationParameter> = {};
  const reserved = new Set([
    'x',
    'y',
    'pi',
    'e',
    ...Object.keys(mathFunctions),
  ]);
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(name) || reserved.has(name))
      throw new Error('参数名称必须是字母开头的标识符，且不能覆盖内置符号。');
    if (!isRecord(raw)) throw new Error('参数 ' + name + ' 必须是对象。');
    validateKeys(raw, ['label', 'value', 'min', 'max', 'step']);
    const { value, min, max, step, label } = raw;
    if (
      ![value, min, max, step].every(
        (item) => typeof item === 'number' && Number.isFinite(item),
      )
    )
      throw new Error('参数 ' + name + ' 的值、边界和步长必须是有限数。');
    const numericValue = value as number;
    const numericMin = min as number;
    const numericMax = max as number;
    const numericStep = step as number;
    if (
      numericMin >= numericMax ||
      Math.abs(numericMin) > 1_000_000 ||
      Math.abs(numericMax) > 1_000_000 ||
      numericValue < numericMin ||
      numericValue > numericMax ||
      numericStep <= 0 ||
      numericStep > numericMax - numericMin
    )
      throw new Error('参数 ' + name + ' 的范围或默认值无效。');
    if (label !== undefined && (typeof label !== 'string' || label.length > 32))
      throw new Error('参数 ' + name + ' 的 label 最多支持 32 个字符。');
    parameters[name] = {
      ...(typeof label === 'string' ? { label } : {}),
      value: numericValue,
      min: numericMin,
      max: numericMax,
      step: numericStep,
    };
  }
  return parameters;
}

function parseRangeControl(
  value: unknown,
  name: string,
  activeRange: NumericRange,
): MathVisualizationRangeControl {
  if (!isRecord(value)) throw new Error(name + ' 必须是范围控件对象。');
  validateKeys(value, ['min', 'max', 'step']);
  const { min, max, step } = value;
  if (
    ![min, max, step].every(
      (item) => typeof item === 'number' && Number.isFinite(item),
    )
  )
    throw new Error(name + ' 的边界和步长必须是有限数。');
  const controlMin = min as number;
  const controlMax = max as number;
  const controlStep = step as number;
  if (
    controlMin >= controlMax ||
    Math.abs(controlMin) > 1_000_000 ||
    Math.abs(controlMax) > 1_000_000 ||
    controlMin > activeRange[0] ||
    controlMax < activeRange[1] ||
    controlStep <= 0 ||
    controlStep > controlMax - controlMin ||
    controlStep > activeRange[1] - activeRange[0]
  )
    throw new Error(name + ' 必须覆盖当前范围，并提供有效步长。');
  return { min: controlMin, max: controlMax, step: controlStep };
}

function parseControls(
  value: unknown,
  domain: { x: NumericRange; y?: NumericRange },
  interval?: NumericRange,
): MathVisualizationControls | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('controls 必须是对象。');
  validateKeys(value, ['domain', 'interval']);
  const controls: MathVisualizationControls = {};
  if (value.domain !== undefined) {
    if (!isRecord(value.domain))
      throw new Error('controls.domain 必须是对象。');
    validateKeys(value.domain, ['x', 'y']);
    const domainControls: NonNullable<MathVisualizationControls['domain']> = {};
    if (value.domain.x !== undefined)
      domainControls.x = parseRangeControl(
        value.domain.x,
        'controls.domain.x',
        domain.x,
      );
    if (value.domain.y !== undefined) {
      if (!domain.y) throw new Error('当前图表类型不支持 y 范围控件。');
      domainControls.y = parseRangeControl(
        value.domain.y,
        'controls.domain.y',
        domain.y,
      );
    }
    controls.domain = domainControls;
  }
  if (value.interval !== undefined) {
    if (!interval) throw new Error('interval 控件只适用于积分图表。');
    const control = parseRangeControl(
      value.interval,
      'controls.interval',
      interval,
    );
    if (control.min < domain.x[0] || control.max > domain.x[1])
      throw new Error('积分区间控件必须位于 domain.x 范围内。');
    controls.interval = control;
  }
  return controls;
}

function parseSamples(value: unknown, fallback = 320): number {
  const samples = value ?? fallback;
  if (
    typeof samples !== 'number' ||
    !Number.isInteger(samples) ||
    samples < 50 ||
    samples > 2_000
  )
    throw new Error('samples 必须是 50 到 2,000 之间的整数。');
  return samples;
}

function parseResolution(
  value: unknown,
  min: number,
  max: number,
  fallback = 12,
): number {
  const resolution = value ?? fallback;
  if (
    typeof resolution !== 'number' ||
    !Number.isInteger(resolution) ||
    resolution < min ||
    resolution > max
  )
    throw new Error(
      'resolution 必须是 ' + min + ' 到 ' + max + ' 之间的整数。',
    );
  return resolution;
}

export function parseMathVisualizationSpec(
  source: string,
): MathVisualizationSpec {
  if (source.length > 20_000) throw new Error('数学可视化配置不能超过 20 KB。');
  let candidate: unknown;
  try {
    candidate = JSON.parse(source);
  } catch {
    throw new Error('数学可视化代码块必须是有效 JSON。');
  }
  if (!isRecord(candidate)) throw new Error('数学可视化配置必须是 JSON 对象。');
  if (candidate.schemaVersion !== 1)
    throw new Error('目前只支持 schemaVersion: 1。');
  if (
    candidate.title !== undefined &&
    (typeof candidate.title !== 'string' || candidate.title.length > 80)
  )
    throw new Error('title 最多支持 80 个字符。');

  const title =
    typeof candidate.title === 'string' && candidate.title
      ? { title: candidate.title }
      : {};
  const parameters = parseParameters(candidate.parameters);
  const shared = {
    schemaVersion: 1 as const,
    ...title,
    ...(parameters ? { parameters } : {}),
  };
  const domain = candidate.domain;
  if (!isRecord(domain)) throw new Error('domain 必须是对象。');

  if (candidate.kind === 'function-2d') {
    validateKeys(candidate, [
      'schemaVersion',
      'kind',
      'title',
      'expression',
      'domain',
      'samples',
      'parameters',
      'controls',
    ]);
    validateKeys(domain, ['x']);
    if (typeof candidate.expression !== 'string')
      throw new Error('function-2d 需要 expression 字符串。');
    const x = parseRange(domain.x, 'domain.x');
    const controls = parseControls(candidate.controls, { x });
    return {
      ...shared,
      kind: 'function-2d',
      expression: candidate.expression,
      domain: { x },
      samples: parseSamples(candidate.samples),
      ...(controls ? { controls } : {}),
    };
  }

  if (candidate.kind === 'contour-2d') {
    validateKeys(candidate, [
      'schemaVersion',
      'kind',
      'title',
      'expression',
      'domain',
      'levels',
      'resolution',
      'parameters',
      'controls',
    ]);
    validateKeys(domain, ['x', 'y']);
    if (typeof candidate.expression !== 'string')
      throw new Error('contour-2d 需要 expression 字符串。');
    const x = parseRange(domain.x, 'domain.x');
    const y = parseRange(domain.y, 'domain.y');
    const levels = candidate.levels;
    if (
      !Array.isArray(levels) ||
      levels.length < 1 ||
      levels.length > 10 ||
      !levels.every(
        (level) => typeof level === 'number' && Number.isFinite(level),
      )
    )
      throw new Error('levels 需要 1 到 10 个有限数值。');
    if (new Set(levels).size !== levels.length)
      throw new Error('levels 不能包含重复值。');
    const controls = parseControls(candidate.controls, { x, y });
    return {
      ...shared,
      kind: 'contour-2d',
      expression: candidate.expression,
      domain: { x, y },
      levels: [...levels] as number[],
      resolution: parseResolution(candidate.resolution, 20, 100, 80),
      ...(controls ? { controls } : {}),
    };
  }

  if (candidate.kind === 'surface-3d') {
    validateKeys(candidate, [
      'schemaVersion',
      'kind',
      'title',
      'expression',
      'domain',
      'resolution',
      'parameters',
      'controls',
    ]);
    validateKeys(domain, ['x', 'y']);
    if (typeof candidate.expression !== 'string')
      throw new Error('surface-3d 需要 expression 字符串。');
    const x = parseRange(domain.x, 'domain.x');
    const y = parseRange(domain.y, 'domain.y');
    const controls = parseControls(candidate.controls, { x, y });
    return {
      ...shared,
      kind: 'surface-3d',
      expression: candidate.expression,
      domain: { x, y },
      resolution: parseResolution(candidate.resolution, 8, 50, 32),
      ...(controls ? { controls } : {}),
    };
  }

  if (candidate.kind === 'vector-field-2d') {
    validateKeys(candidate, [
      'schemaVersion',
      'kind',
      'title',
      'vector',
      'domain',
      'resolution',
      'parameters',
      'controls',
    ]);
    validateKeys(domain, ['x', 'y']);
    if (!isRecord(candidate.vector))
      throw new Error('vector-field-2d 需要 vector 对象。');
    validateKeys(candidate.vector, ['u', 'v']);
    if (
      typeof candidate.vector.u !== 'string' ||
      typeof candidate.vector.v !== 'string'
    )
      throw new Error('vector.u 和 vector.v 必须是公式字符串。');
    const x = parseRange(domain.x, 'domain.x');
    const y = parseRange(domain.y, 'domain.y');
    const controls = parseControls(candidate.controls, { x, y });
    return {
      ...shared,
      kind: 'vector-field-2d',
      vector: { u: candidate.vector.u, v: candidate.vector.v },
      domain: { x, y },
      resolution: parseResolution(candidate.resolution, 5, 20),
      ...(controls ? { controls } : {}),
    };
  }

  if (candidate.kind === 'integral-1d') {
    validateKeys(candidate, [
      'schemaVersion',
      'kind',
      'title',
      'expression',
      'domain',
      'interval',
      'samples',
      'parameters',
      'controls',
    ]);
    validateKeys(domain, ['x']);
    if (typeof candidate.expression !== 'string')
      throw new Error('integral-1d 需要 expression 字符串。');
    const x = parseRange(domain.x, 'domain.x');
    const interval = parseRange(candidate.interval, 'interval');
    if (interval[0] < x[0] || interval[1] > x[1])
      throw new Error('积分区间必须位于 domain.x 范围内。');
    const controls = parseControls(candidate.controls, { x }, interval);
    return {
      ...shared,
      kind: 'integral-1d',
      expression: candidate.expression,
      domain: { x },
      interval,
      samples: parseSamples(candidate.samples),
      ...(controls ? { controls } : {}),
    };
  }

  throw new Error(
    'kind 支持 function-2d、contour-2d、vector-field-2d、integral-1d 和 surface-3d。',
  );
}

function evaluateExpression(
  expression: ExpressionNode,
  variables: Record<string, number>,
): number {
  switch (expression.type) {
    case 'number':
      return expression.value;
    case 'symbol':
      if (expression.name === 'pi') return Math.PI;
      if (expression.name === 'e') return Math.E;
      return variables[expression.name] ?? Number.NaN;
    case 'unary': {
      const value = evaluateExpression(expression.operand, variables);
      return expression.operator === '-' ? -value : value;
    }
    case 'function':
      return mathFunctions[expression.name](
        evaluateExpression(expression.argument, variables),
      );
    case 'binary': {
      const left = evaluateExpression(expression.left, variables);
      const right = evaluateExpression(expression.right, variables);
      switch (expression.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return left / right;
        case '^':
          return left ** right;
      }
    }
  }
}

function createVariableContext(
  spec: MathVisualizationSpec,
  x: number,
  y = 0,
): Record<string, number> {
  const variables: Record<string, number> = { x, y };
  Object.entries(spec.parameters ?? {}).forEach(([name, parameter]) => {
    variables[name] = parameter.value;
  });
  return variables;
}

function parseFormula(
  source: string,
  spec: MathVisualizationSpec,
  axes: Array<'x' | 'y'>,
): ExpressionNode {
  return new SafeExpressionParser(source, [
    ...axes,
    ...Object.keys(spec.parameters ?? {}),
  ]).parse();
}

function evaluateFunction2d(
  spec: Function2dVisualization,
): MathVisualizationResult {
  const expression = parseFormula(spec.expression, spec, ['x']);
  const [min, max] = spec.domain.x;
  const data: Array<[number, number | null]> = [];
  for (let index = 0; index <= spec.samples; index += 1) {
    const x = min + ((max - min) * index) / spec.samples;
    const y = evaluateExpression(expression, createVariableContext(spec, x));
    data.push([x, Number.isFinite(y) ? y : null]);
  }
  return { series: [{ name: spec.expression, data }] };
}

function evaluateContour2d(
  spec: Contour2dVisualization,
): MathVisualizationResult {
  const expression = parseFormula(spec.expression, spec, ['x', 'y']);
  const [xMin, xMax] = spec.domain.x;
  const [yMin, yMax] = spec.domain.y;
  const resolution = spec.resolution;
  const stepX = (xMax - xMin) / resolution;
  const stepY = (yMax - yMin) / resolution;
  const values = Array.from({ length: resolution + 1 }, (_, row) =>
    Array.from({ length: resolution + 1 }, (_, column) =>
      evaluateExpression(expression, {
        ...createVariableContext(
          spec,
          xMin + column * stepX,
          yMin + row * stepY,
        ),
      }),
    ),
  );
  const series: MathVisualizationSeries[] = [];
  for (const level of spec.levels) {
    const segments: Array<[[number, number], [number, number]]> = [];
    for (let row = 0; row < resolution; row += 1) {
      for (let column = 0; column < resolution; column += 1) {
        const x0 = xMin + column * stepX;
        const x1 = x0 + stepX;
        const y0 = yMin + row * stepY;
        const y1 = y0 + stepY;
        const cornerValues = [
          values[row]?.[column],
          values[row]?.[column + 1],
          values[row + 1]?.[column + 1],
          values[row + 1]?.[column],
        ];
        if (!cornerValues.every((value) => Number.isFinite(value))) continue;
        const v = cornerValues as number[];
        const points: Array<[number, number]> = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ];
        const edgePairs: Array<[number, number]> = [];
        const edgeVertices: Array<[number, number]> = [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 0],
        ];
        const crossings: number[] = [];
        edgeVertices.forEach(([a, b], edge) => {
          if (v[a]! >= level !== v[b]! >= level) crossings.push(edge);
        });
        const caseIndex =
          Number(v[0]! >= level) |
          (Number(v[1]! >= level) << 1) |
          (Number(v[2]! >= level) << 2) |
          (Number(v[3]! >= level) << 3);
        if (caseIndex === 5 || caseIndex === 10) {
          const centerAbove = (v[0]! + v[1]! + v[2]! + v[3]!) / 4 >= level;
          const useEdges01And23 =
            (caseIndex === 5 && centerAbove) ||
            (caseIndex === 10 && !centerAbove);
          if (useEdges01And23) edgePairs.push([0, 1], [2, 3]);
          else edgePairs.push([3, 0], [1, 2]);
        } else {
          edgePairs.push(...(contourCasePairs[caseIndex] ?? []));
        }
        const intersections = new Map<number, [number, number]>();
        crossings.forEach((edge) => {
          const [a, b] = edgeVertices[edge]!;
          const ratio = (level - v[a]!) / (v[b]! - v[a]!);
          intersections.set(edge, [
            points[a]![0] + (points[b]![0] - points[a]![0]) * ratio,
            points[a]![1] + (points[b]![1] - points[a]![1]) * ratio,
          ]);
        });
        edgePairs.forEach(([a, b]) => {
          const start = intersections.get(a);
          const end = intersections.get(b);
          if (start && end) segments.push([start, end]);
        });
      }
    }
    const paths = stitchContourSegments(segments, Math.min(stepX, stepY));
    if (series.length + paths.length > maxContourPaths)
      throw new Error(
        '生成的等高线数量过多，请降低 resolution 或减少 levels。',
      );
    paths.forEach((path, index) => {
      series.push({
        name: 'f = ' + level + (paths.length > 1 ? ' · ' + (index + 1) : ''),
        data: path,
      });
    });
  }
  if (series.length === 0)
    throw new Error('当前范围内没有找到等高线；请调整表达式、范围或 levels。');
  return { series };
}

function evaluateSurface3d(
  spec: Surface3dVisualization,
): MathVisualizationResult {
  const expression = parseFormula(spec.expression, spec, ['x', 'y']);
  const [xMin, xMax] = spec.domain.x;
  const [yMin, yMax] = spec.domain.y;
  const stepX = (xMax - xMin) / spec.resolution;
  const stepY = (yMax - yMin) / spec.resolution;
  const xValues = Array.from(
    { length: spec.resolution + 1 },
    (_, index) => xMin + index * stepX,
  );
  const yValues = Array.from(
    { length: spec.resolution + 1 },
    (_, index) => yMin + index * stepY,
  );
  let validSamples = 0;
  const zValues = yValues.map((y) =>
    xValues.map((x) => {
      const z = evaluateExpression(
        expression,
        createVariableContext(spec, x, y),
      );
      if (!Number.isFinite(z)) return null;
      validSamples += 1;
      return z;
    }),
  );
  if (validSamples === 0)
    throw new Error('当前范围内没有有限的曲面取值；请调整公式或范围。');
  return {
    series: [],
    surface: { xValues, yValues, zValues },
    summary: 'z = ' + spec.expression,
  };
}

function evaluateVectorField2d(
  spec: VectorField2dVisualization,
): MathVisualizationResult {
  const expressionU = parseFormula(spec.vector.u, spec, ['x', 'y']);
  const expressionV = parseFormula(spec.vector.v, spec, ['x', 'y']);
  const [xMin, xMax] = spec.domain.x;
  const [yMin, yMax] = spec.domain.y;
  const stepX = (xMax - xMin) / spec.resolution;
  const stepY = (yMax - yMin) / spec.resolution;
  const vectors: Array<{ x: number; y: number; u: number; v: number }> = [];
  let maxMagnitude = 0;
  for (let row = 0; row <= spec.resolution; row += 1) {
    for (let column = 0; column <= spec.resolution; column += 1) {
      const x = xMin + column * stepX;
      const y = yMin + row * stepY;
      const variables = createVariableContext(spec, x, y);
      const u = evaluateExpression(expressionU, variables);
      const v = evaluateExpression(expressionV, variables);
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      maxMagnitude = Math.max(maxMagnitude, Math.hypot(u, v));
      vectors.push({ x, y, u, v });
    }
  }
  if (maxMagnitude === 0)
    return { series: [], showLegend: false, summary: '当前范围内是零向量场。' };
  const arrowLength = Math.min(stepX, stepY) * 0.38;
  return {
    showLegend: false,
    series: vectors.map((vector, index) => ({
      name: '向量 ' + (index + 1),
      data: [
        [vector.x, vector.y],
        [
          vector.x + (vector.u / maxMagnitude) * arrowLength,
          vector.y + (vector.v / maxMagnitude) * arrowLength,
        ],
      ],
      symbol: ['none', 'arrow'],
      symbolSize: 6,
      lineStyle: { width: 1, opacity: 0.7 },
    })),
  };
}

function evaluateIntegral1d(
  spec: Integral1dVisualization,
): MathVisualizationResult {
  const expression = parseFormula(spec.expression, spec, ['x']);
  const [domainMin, domainMax] = spec.domain.x;
  const [a, b] = spec.interval;
  const evaluateAt = (x: number) =>
    evaluateExpression(expression, createVariableContext(spec, x));
  const curve: Array<[number, number | null]> = [];
  for (let index = 0; index <= spec.samples; index += 1) {
    const x = domainMin + ((domainMax - domainMin) * index) / spec.samples;
    const y = evaluateAt(x);
    curve.push([x, Number.isFinite(y) ? y : null]);
  }

  const intervalSamples = Math.max(
    50,
    Math.ceil((spec.samples * (b - a)) / (domainMax - domainMin)),
  );
  const area: Array<[number, number]> = [];
  let integral = 0;
  let previousX = a;
  let previousY = evaluateAt(a);
  if (!Number.isFinite(previousY))
    throw new Error('积分区间包含未定义的函数值。');
  area.push([previousX, previousY]);
  for (let index = 1; index <= intervalSamples; index += 1) {
    const x = a + ((b - a) * index) / intervalSamples;
    const y = evaluateAt(x);
    if (!Number.isFinite(y)) throw new Error('积分区间包含未定义的函数值。');
    integral += ((previousY + y) * (x - previousX)) / 2;
    area.push([x, y]);
    previousX = x;
    previousY = y;
  }
  const formattedIntegral = Number.isFinite(integral)
    ? String(Number(integral.toPrecision(6)))
    : '无法计算';
  return {
    showLegend: false,
    summary: '∫[' + a + ', ' + b + '] f(x) dx ≈ ' + formattedIntegral,
    series: [
      { name: spec.expression, data: curve, z: 2 },
      {
        name: '积分区域',
        data: area,
        symbol: 'none',
        lineStyle: { opacity: 0 },
        areaStyle: { opacity: 0.22 },
        z: 1,
      },
    ],
  };
}

type MathVisualizationRenderer = (
  spec: MathVisualizationSpec,
) => MathVisualizationResult;

const mathVisualizationRenderers: Record<
  MathVisualizationKind,
  MathVisualizationRenderer
> = {
  'function-2d': (spec) => {
    if (spec.kind !== 'function-2d') throw new Error('函数图表类型不匹配。');
    return evaluateFunction2d(spec);
  },
  'contour-2d': (spec) => {
    if (spec.kind !== 'contour-2d') throw new Error('等高线图类型不匹配。');
    return evaluateContour2d(spec);
  },
  'surface-3d': (spec) => {
    if (spec.kind !== 'surface-3d') throw new Error('三维曲面类型不匹配。');
    return evaluateSurface3d(spec);
  },
  'vector-field-2d': (spec) => {
    if (spec.kind !== 'vector-field-2d')
      throw new Error('向量场图表类型不匹配。');
    return evaluateVectorField2d(spec);
  },
  'integral-1d': (spec) => {
    if (spec.kind !== 'integral-1d') throw new Error('积分图表类型不匹配。');
    return evaluateIntegral1d(spec);
  },
};

export function evaluateMathVisualization(
  spec: MathVisualizationSpec,
): MathVisualizationResult {
  return mathVisualizationRenderers[spec.kind](spec);
}

function stitchContourSegments(
  segments: Array<[[number, number], [number, number]]>,
  gridStep: number,
): Array<Array<[number, number]>> {
  const tolerance = Math.max(gridStep * 1e-5, 1e-10);
  const endpointKey = ([x, y]: [number, number]) =>
    `${Math.round(x / tolerance)}:${Math.round(y / tolerance)}`;
  const adjacency = new Map<string, Array<[number, 0 | 1]>>();
  segments.forEach(([start, end], index) => {
    const startKey = endpointKey(start);
    const endKey = endpointKey(end);
    adjacency.set(startKey, [...(adjacency.get(startKey) ?? []), [index, 0]]);
    adjacency.set(endKey, [...(adjacency.get(endKey) ?? []), [index, 1]]);
  });
  const visited = new Uint8Array(segments.length);
  const paths: Array<Array<[number, number]>> = [];

  const extend = (path: Array<[number, number]>, atStart: boolean): void => {
    for (;;) {
      const endpoint = atStart ? path[0]! : path[path.length - 1]!;
      const candidates = adjacency.get(endpointKey(endpoint)) ?? [];
      const next = candidates.find(([index]) => !visited[index]);
      if (!next) return;
      const [index, endpointIndex] = next;
      visited[index] = 1;
      const segment = segments[index]!;
      const point = endpointIndex === 0 ? segment[1] : segment[0];
      if (atStart) path.unshift(point);
      else path.push(point);
    }
  };

  for (let index = 0; index < segments.length; index += 1) {
    if (visited[index]) continue;
    visited[index] = 1;
    const [start, end] = segments[index]!;
    const path: Array<[number, number]> = [start, end];
    extend(path, false);
    extend(path, true);
    paths.push(path);
    if (paths.length > maxContourPaths)
      throw new Error('等高线过于复杂，请降低 resolution 或减少 levels。');
  }
  return paths;
}

export function createMathVisualizationOption(
  spec: MathVisualizationSpec,
  result: MathVisualizationResult,
): Record<string, unknown> {
  if (spec.kind === 'surface-3d')
    throw new Error('三维曲面由 Canvas 曲面渲染器负责。');
  const xRange = spec.domain.x;
  const yRange =
    spec.kind === 'contour-2d' || spec.kind === 'vector-field-2d'
      ? spec.domain.y
      : undefined;
  const names = [...new Set(result.series.map((series) => series.name))];
  const title =
    spec.title ||
    (spec.kind === 'vector-field-2d' ? '向量场' : spec.expression);
  return {
    animation: false,
    title: {
      text: title,
      ...(result.summary ? { subtext: result.summary } : {}),
      left: 'center',
      top: 4,
      textStyle: { fontSize: 14, fontWeight: 600 },
      subtextStyle: { fontSize: 11 },
    },
    tooltip: {
      trigger: spec.kind === 'vector-field-2d' ? 'item' : 'axis',
    },
    legend:
      result.showLegend === false || names.length < 2
        ? undefined
        : { data: names, bottom: 0 },
    grid: {
      left: 52,
      right: 24,
      top: result.summary ? 62 : 44,
      bottom: result.showLegend !== false && names.length > 1 ? 44 : 32,
    },
    xAxis: { type: 'value', min: xRange[0], max: xRange[1], name: 'x' },
    yAxis: {
      type: 'value',
      ...(yRange ? { min: yRange[0], max: yRange[1] } : {}),
      name:
        spec.kind === 'contour-2d' || spec.kind === 'vector-field-2d'
          ? 'y'
          : 'f(x)',
    },
    series: result.series.map((series) => ({
      name: series.name,
      type: 'line',
      data: series.data,
      ...(series.symbol ? { symbol: series.symbol } : {}),
      ...(series.symbolSize ? { symbolSize: series.symbolSize } : {}),
      showSymbol: Boolean(series.symbol && series.symbol !== 'none'),
      connectNulls: false,
      lineStyle: { width: 1.8, ...series.lineStyle },
      ...(series.areaStyle ? { areaStyle: series.areaStyle } : {}),
      ...(series.z ? { z: series.z } : {}),
      emphasis: { focus: 'series' },
    })),
  };
}
