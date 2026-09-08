import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutomationMonitor as Monitor, AutomationMonitorCreateInput as MonitorCreateInput } from '@cc/superai-contracts';
import { Button, Input, Modal, Select, Textarea } from '@/components/ui';

export type MonitorFormState = {
  workspaceId: string;
  title: string;
  sourceType: 'stock.quote' | 'webhook';
  symbol: string;
  hookId: string;
  token: string;
  condition: string;
  promptTemplate: string;
  workflowTemplate: 'direct' | 'deep-analysis';
  retrospectiveDelayHours: string;
  cooldownMinutes: string;
  executionMode: 'same-thread' | 'side-thread';
  enabled: boolean;
};

export const DEFAULT_FORM: MonitorFormState = {
  workspaceId: '',
  title: '',
  sourceType: 'stock.quote',
  symbol: '',
  hookId: '',
  token: '',
  condition: 'abs_change_percent >= 3',
  promptTemplate: '',
  workflowTemplate: 'direct',
  retrospectiveDelayHours: '24',
  cooldownMinutes: '15',
  executionMode: 'side-thread',
  enabled: true,
};

export const sourceDefinitions = {
  'stock.quote': {
    label: 'Stock quote',
    buildConfig: (form: MonitorFormState) => ({ symbol: form.symbol.toUpperCase() }),
    renderSummary: (monitor: Monitor) => String(monitor.sourceConfig.symbol || ''),
  },
  webhook: {
    label: 'Inbound Webhook',
    buildConfig: (form: MonitorFormState) => {
      const config: Record<string, unknown> = {};
      if (form.hookId?.trim()) config.hookId = form.hookId.trim();
      if (form.token?.trim()) config.token = form.token.trim();
      return config;
    },
    renderSummary: (monitor: Monitor) => {
      const hookId = String(monitor.sourceConfig.hookId || '');
      return hookId ? `Hook ID: ${hookId}` : 'Webhook';
    },
  },
} as const;

export function parseCondition(value: string) {
  const expression = value.trim();
  if (expression.toLowerCase() === 'always') {
    return {
      metric: 'always',
      operator: '==' as const,
      value: true,
      expression: 'always',
    };
  }
  if (expression.includes('&&') || expression.includes('||')) {
    return {
      metric: 'expression',
      operator: '==' as const,
      value: true,
      expression,
    };
  }
  const match = expression.match(/^([a-zA-Z0-9_.-]+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
  if (!match) return null;
  const rawValue = String(match[3] || '').trim();
  const numeric = Number(rawValue);
  const cleanValue = rawValue.replace(/^["']|["']$/g, '');
  return {
    metric: String(match[1] || '').trim(),
    operator: match[2] as MonitorCreateInput['condition']['operator'],
    value: Number.isFinite(numeric) && rawValue !== '' ? numeric : cleanValue,
  };
}

export function conditionToText(monitor: Monitor) {
  if (monitor.condition.expression) return monitor.condition.expression;
  if (monitor.condition.metric === 'always') return 'always';
  return `${monitor.condition.metric} ${monitor.condition.operator} ${monitor.condition.value}`;
}

export function toForm(monitor?: Monitor | null): MonitorFormState {
  if (!monitor) return DEFAULT_FORM;
  const sourceType = (monitor.sourceType === 'webhook' ? 'webhook' : 'stock.quote') as MonitorFormState['sourceType'];
  return {
    workspaceId: monitor.workspaceId,
    title: monitor.title,
    sourceType,
    symbol: String(monitor.sourceConfig.symbol || ''),
    hookId: String(monitor.sourceConfig.hookId || ''),
    token: String(monitor.sourceConfig.token || ''),
    condition: conditionToText(monitor),
    promptTemplate: monitor.promptTemplate,
    workflowTemplate: monitor.workflowTemplate || 'direct',
    retrospectiveDelayHours: String(monitor.retrospectiveDelayHours ?? 24),
    cooldownMinutes: String(Math.round(monitor.cooldownMs / 60000)),
    executionMode: monitor.executionMode as MonitorFormState['executionMode'],
    enabled: monitor.enabled,
  };
}

export function toPayload(form: MonitorFormState): MonitorCreateInput {
  const condition = parseCondition(form.condition);
  if (!condition) throw new Error('Invalid condition');
  const sourceDef = sourceDefinitions[form.sourceType];
  const retroHours = Number(form.retrospectiveDelayHours);
  return {
    workspaceId: form.workspaceId,
    title: form.title,
    sourceType: form.sourceType,
    sourceConfig: sourceDef.buildConfig(form),
    condition,
    promptTemplate: form.promptTemplate,
    workflowTemplate: form.workflowTemplate,
    retrospectiveDelayHours:
      form.workflowTemplate === 'deep-analysis'
        ? Number.isFinite(retroHours) && retroHours >= 1
          ? Math.floor(retroHours)
          : 24
        : undefined,
    executionMode: form.executionMode,
    cooldownMs: Math.max(0, Number(form.cooldownMinutes || '0') * 60000),
    enabled: form.enabled,
  };
}

const STOCK_CONDITION_PRESETS = [
  ['latestPrice <= boll_lower', '周线下轨买入 (<= Lower)'],
  ['latestPrice >= boll_upper', '周线上轨卖出 (>= Upper)'],
  ['boll_percent_b <= 0.05', '贴近周线下轨 (%B <= 0.05)'],
  ['boll_percent_b >= 0.95', '贴近周线上轨 (%B >= 0.95)'],
  ['dividend_yield >= 5.0', '高股息买入 (>= 5%)'],
  ['erp_spread >= 2.5', '股债利差优势 (ERP >= 2.5%)'],
  ['latestPrice <= boll_lower && dividend_yield >= 4.0', '周线下轨 + 高股息共振买点'],
  ['abs_change_percent >= 3', '+/- 3%'],
  ['price >= 500', 'Price >= 500'],
];

const WEBHOOK_CONDITION_PRESETS = [
  ['always', '触发即执行 (Always)'],
  ['event == "deploy"', '事件匹配 deploy'],
  ['status == "failed"', '状态为 failed'],
  ['severity == "error"', '严重级别 error'],
];

function SourceConfigInputs({
  form,
  setForm,
}: {
  form: MonitorFormState;
  setForm: (f: MonitorFormState) => void;
}) {
  if (form.sourceType === 'stock.quote') {
    return <Input label="Symbol" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="AAPL" />;
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <Input label="Hook ID" value={form.hookId} onChange={(e) => setForm({ ...form, hookId: e.target.value })} placeholder="留空自动生成" />
      <Input label="Token" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="留空自动生成" />
    </div>
  );
}

function nextFormForSourceType(form: MonitorFormState, nextSource: MonitorFormState['sourceType']): MonitorFormState {
  let condition = form.condition;
  if (nextSource === 'webhook' && form.condition.includes('change_percent')) {
    condition = 'always';
  } else if (nextSource === 'stock.quote' && form.condition === 'always') {
    condition = 'abs_change_percent >= 3';
  }
  return { ...form, sourceType: nextSource, condition };
}

function ConditionPresetSelector({
  presets,
  active,
  onSelect,
}: {
  presets: string[][];
  active: string;
  onSelect: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {presets.map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onSelect(value)}
          className={`app-segment text-xs ${active === value ? 'app-segment-active' : 'app-segment-idle'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

type Props = {
  open: boolean;
  editingMonitor: Monitor | null;
  workspaces: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (payload: MonitorCreateInput) => Promise<void>;
};

export default function MonitorModal({ open, editingMonitor, workspaces, onClose, onSave }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<MonitorFormState>(() => toForm(editingMonitor));
  const [submitting, setSubmitting] = useState(false);

  const selectedWorkspaceOptions = useMemo(
    () => workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>),
    [workspaces],
  );

  const handleSave = async () => {
    if (!form.workspaceId || !form.title.trim() || !form.promptTemplate.trim() || !parseCondition(form.condition)) {
      return;
    }
    if (form.sourceType === 'stock.quote' && !form.symbol.trim()) {
      return;
    }
    setSubmitting(true);
    try {
      await onSave(toPayload(form));
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const presets = form.sourceType === 'webhook' ? WEBHOOK_CONDITION_PRESETS : STOCK_CONDITION_PRESETS;

  return (
    <Modal open={open} title={editingMonitor ? t('monitors.edit') : t('monitors.add')} onClose={onClose}>
      <div className="space-y-4">
        <Select label="Workspace" value={form.workspaceId} onChange={(e) => setForm({ ...form, workspaceId: e.target.value })}>
          {selectedWorkspaceOptions}
        </Select>
        <Input label={t('monitors.monitorTitle')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <Select label="Source" value={form.sourceType} onChange={(e) => setForm(nextFormForSourceType(form, e.target.value as MonitorFormState['sourceType']))}>
          {Object.entries(sourceDefinitions).map(([key, def]) => (
            <option key={key} value={key}>{def.label}</option>
          ))}
        </Select>
        <SourceConfigInputs form={form} setForm={setForm} />
        <Input
          label={t('monitors.condition')}
          value={form.condition}
          onChange={(e) => setForm({ ...form, condition: e.target.value })}
          placeholder={form.sourceType === 'webhook' ? 'always' : 'abs_change_percent >= 3'}
        />
        <ConditionPresetSelector presets={presets} active={form.condition} onSelect={(v) => setForm({ ...form, condition: v })} />
        {!parseCondition(form.condition) ? (
          <p className="text-xs text-amber-700 dark:text-amber-200">
            Condition should look like &apos;always&apos;, metric &gt;= value, or a boolean expression.
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Workflow"
            value={form.workflowTemplate}
            onChange={(e) => setForm({ ...form, workflowTemplate: e.target.value as MonitorFormState['workflowTemplate'] })}
          >
            <option value="direct">Direct (Standard alert)</option>
            <option value="deep-analysis">Deep Analysis (Bull/Bear debate)</option>
          </Select>
          {form.workflowTemplate === 'deep-analysis' ? (
            <Input
              label="Retro delay (hours)"
              type="number"
              min="1"
              value={form.retrospectiveDelayHours}
              onChange={(e) => setForm({ ...form, retrospectiveDelayHours: e.target.value })}
            />
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label={t('monitors.cooldown')} value={form.cooldownMinutes} onChange={(e) => setForm({ ...form, cooldownMinutes: e.target.value })} />
          <Select label="Execution" value={form.executionMode} onChange={(e) => setForm({ ...form, executionMode: e.target.value as MonitorFormState['executionMode'] })}>
            <option value="side-thread">side-thread</option>
            <option value="same-thread">same-thread</option>
          </Select>
        </div>
        <Textarea label={t('monitors.prompt')} rows={6} value={form.promptTemplate} onChange={(e) => setForm({ ...form, promptTemplate: e.target.value })} />
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          {t('monitors.enabled')}
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={handleSave} disabled={submitting}>{t('common.save')}</Button>
        </div>
      </div>
    </Modal>
  );
}
