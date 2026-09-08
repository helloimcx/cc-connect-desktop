import type { AutomationMonitorCondition, AutomationMonitorEventSnapshot } from '@cc/superai-contracts';

export function evaluateMonitorCondition(condition: AutomationMonitorCondition, event: AutomationMonitorEventSnapshot) {
  if (condition.metric === 'always' || condition.expression?.trim() === 'always') {
    return true;
  }
  if (condition.expression) {
    return evaluateExpression(condition.expression, event);
  }
  const actual = readMetric(event, condition.metric);
  let expected: unknown = condition.value;
  if (typeof expected === 'string' && Number.isNaN(Number(expected))) {
    const metricVal = readMetric(event, expected);
    if (metricVal !== undefined) {
      expected = metricVal;
    }
  }
  return evaluateOperatorComparison(condition.operator, actual, expected);
}

export function evaluateOperatorComparison(
  operator: AutomationMonitorCondition['operator'],
  actual: unknown,
  expected: unknown,
): boolean {
  switch (operator) {
    case '>':
      return Number(actual) > Number(expected);
    case '>=':
      return Number(actual) >= Number(expected);
    case '<':
      return Number(actual) < Number(expected);
    case '<=':
      return Number(actual) <= Number(expected);
    case '==':
      return String(actual) === String(expected);
    case '!=':
      return String(actual) !== String(expected);
    default:
      return false;
  }
}

export function evaluateExpression(expression: string, event: AutomationMonitorEventSnapshot): boolean {
  if (String(expression || '').trim() === 'always') return true;
  return evaluateRestrictedExpression(expression, (metric) => readMetric(event, metric));
}

export function evaluateRestrictedExpression(
  expression: string,
  contextOrResolver: Record<string, unknown> | ((metric: string) => unknown),
): boolean {
  if (String(expression || '').trim() === 'always') return true;
  const compiled = compileRestrictedExpression(expression);
  const resolveMetric = typeof contextOrResolver === 'function'
    ? contextOrResolver
    : (metric: string) => readContextMetric(contextOrResolver, metric);
  return compiled.some((orPart) =>
    orPart.every((comparison) => evaluateRestrictedComparison(comparison, resolveMetric))
  );
}

export type RestrictedExpressionComparison = {
  metric: string;
  operator: AutomationMonitorCondition['operator'];
  rawValue: string;
};

export type CompiledRestrictedExpression = RestrictedExpressionComparison[][];

export function validateRestrictedExpression(expression: string): void {
  compileRestrictedExpression(expression);
}

export function compileRestrictedExpression(expression: string): CompiledRestrictedExpression {
  const source = String(expression || '').trim();
  if (source === 'always') {
    return [[{ metric: 'always', operator: '==', rawValue: 'true' }]];
  }
  if (!source) throw new Error(`Unsupported monitor condition expression: ${expression}`);
  return source.split('||').map((orPart) => {
    if (!orPart.trim()) throw new Error(`Unsupported monitor condition expression: ${expression}`);
    return orPart.split('&&').map((andPart) => compileRestrictedComparison(andPart.trim(), expression));
  });
}

function compileRestrictedComparison(expression: string, original: string): RestrictedExpressionComparison {
  if (expression.trim() === 'always') {
    return { metric: 'always', operator: '==', rawValue: 'true' };
  }
  const match = expression.match(/^([a-zA-Z0-9_.-]+)\s*(>=|<=|==|!=|>|<)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&|<>=!]+)$/);
  if (!match) throw new Error(`Unsupported monitor condition expression: ${original}`);
  return {
    metric: String(match[1]),
    operator: match[2] as AutomationMonitorCondition['operator'],
    rawValue: String(match[3]),
  };
}

function evaluateRestrictedComparison(
  comparison: RestrictedExpressionComparison,
  resolveMetric: (metric: string) => unknown,
) {
  if (comparison.metric === 'always') return true;
  const rawValue = comparison.rawValue.replace(/^["']|["']$/g, '');
  const numeric = Number(rawValue);
  const actual = resolveMetric(comparison.metric);
  let expected: unknown;
  if (Number.isFinite(numeric) && rawValue !== '') {
    expected = numeric;
  } else {
    const resolvedMetric = resolveMetric(rawValue);
    expected = resolvedMetric !== undefined ? resolvedMetric : rawValue;
  }
  return evaluateOperatorComparison(comparison.operator, actual, expected);
}

export function readMetric(event: AutomationMonitorEventSnapshot, metric: string): unknown {
  const key = String(metric || '').trim();
  if (!key) {
    return undefined;
  }
  if (key === 'subject') return event.subject;
  if (key === 'sourceType') return event.sourceType;
  const payload = event.payload || {};
  return readContextMetric(payload, key);
}

function readContextMetric(context: Record<string, unknown>, metric: string): unknown {
  const key = String(metric || '').trim();
  if (!key) return undefined;
  if (key === 'abs_change_percent') {
    return Math.abs(Number(context.change_percent ?? context.changePercent ?? 0));
  }
  if (key === 'price' && context.latestPrice !== undefined) {
    return context.latestPrice;
  }
  const normalizedKey = key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
  if (Object.prototype.hasOwnProperty.call(context, key)) return context[key];
  if (Object.prototype.hasOwnProperty.call(context, normalizedKey)) return context[normalizedKey];
  return key.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, context);
}
