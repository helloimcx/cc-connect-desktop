import type { AutomationMonitorCondition, AutomationMonitorSchedule } from '@cc/superai-contracts';
import { normalizeAutomationMonitorConditionOperator } from '@cc/superai-contracts';

export function parseMonitorCondition(value: string): AutomationMonitorCondition {
  const expression = String(value || '').trim();
  if (expression === 'always') {
    return {
      metric: 'always',
      operator: '==',
      value: true,
      expression: 'always',
    };
  }
  if (expression.includes('&&') || expression.includes('||')) {
    return {
      metric: 'expression',
      operator: '==',
      value: true,
      expression,
    };
  }
  const match = expression.match(/^([a-zA-Z0-9_.-]+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
  if (!match) {
    throw new Error('Monitor condition must look like "change_percent >= 3".');
  }
  const rawValue = String(match[3] || '').trim();
  const numeric = Number(rawValue);
  const cleanValue = rawValue.replace(/^["']|["']$/g, '');
  return {
    metric: String(match[1] || '').trim(),
    operator: normalizeAutomationMonitorConditionOperator(match[2]),
    value: Number.isFinite(numeric) && rawValue !== '' ? numeric : cleanValue,
  };
}

export function parseDurationMs(value: string) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) {
    throw new Error('Duration must be a number with optional ms, s, m, or h suffix.');
  }
  const amount = Number(match[1]);
  const unit = String(match[2] || 'ms').toLowerCase();
  const multiplier = unit === 'h' ? 60 * 60 * 1000 : unit === 'm' ? 60 * 1000 : unit === 's' ? 1000 : 1;
  return Math.round(amount * multiplier);
}

export function parseMonitorSchedule(cron: string, timezone: string | undefined): AutomationMonitorSchedule {
  const expression = String(cron || '').trim();
  if (!expression) {
    throw new Error('Monitor schedule cron expression must not be empty. Use "off" in monitor edit to clear it.');
  }
  return {
    cron: expression,
    timezone: String(timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
  };
}

export function parseRetroDelayHours(value: string): number {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    throw new Error('Retro delay must not be empty.');
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const hours = Number(trimmed);
    if (hours <= 0) throw new Error('Retro delay must be greater than 0 hours.');
    return hours;
  }
  const ms = parseDurationMs(trimmed);
  const hours = ms / (60 * 60 * 1000);
  if (hours <= 0) {
    throw new Error('Retro delay must be greater than 0 hours.');
  }
  return hours;
}


