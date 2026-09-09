# Spec: 监控触发决策工作流与事后复盘闭环 (Monitor Decision Workflow)

## 1. 目标与背景

当前 AgentDock 已经具备成熟的监控触发管线（股票技术/基本面指标监控、Inbound Webhook 触发、条件引擎与通道交付），但事件触发后的分析是一次性、自由发挥的单次 Prompt 注入：
- **缺乏数据接地约束**：模型可能幻觉编造价格、比率或指标数值；
- **缺乏对抗性分析结构**：容易陷入单视角确认偏误（Confirmation Bias）；
- **缺乏决策留痕与可追责性**：结果推送到 IM 后随即消失，无法追踪历史决策逻辑；
- **缺乏事后复盘闭环**：无法检验当时判断的对错，更无法把经验教训注入后续同标的的分析中。

本规范（对应 Issue #112）旨在建立**监控触发的决策工作流（Deep Analysis Decision Workflow）**：
1. **数据接地契约 (Grounded Data Contract)**：严格约束模型必须引用已验证的事件快照指标，严禁捏造数据；
2. **牛熊对抗自辩论 (Bull / Bear Debate)**：同一 Agent 在单线程 ACP 会话内进行多头与空头对抗性推演，最终输出包含动作、置信度与假设的结构化裁决；
3. **工作区决策日志 (Decision Log)**：自动将决策归档至 `<workspace>/.agentdock/decisions/<monitor-id>.md` 及 Core 存储；
4. **延时自动复盘 (Scheduled Retrospective Follow-up)**：利用调度器的 `once` 任务挂载 T+1/T+5 延时复盘，到期重拉指标检验对错，反思教训自动回流至下一次监控分析。

## 2. 需求范围 (Scope)

- **公共契约扩展 (`packages/contracts`)**：
  - `AutomationAction`、`AutomationMonitor`、`AutomationMonitorCreateInput`、`AutomationMonitorUpdateInput` 增加可选属性：
    - `workflowTemplate?: 'direct' | 'deep-analysis'`（默认 `'direct'`）；
    - `retrospectiveDelayHours?: number`（启用复盘时的延迟小时数，默认为 24 即 T+1，设为 0 则不复盘）。
  - 新增 `AutomationDecisionRecord` 契约类型，定义结构化决策与事后复盘反思字段。
- **决策工作流核心 (`services/local-ai-core/src/automation/`)**：
  - 新增 `decision-workflow.ts` 与 `decision-log-service.ts`：
    - 数据接地 Prompt 包装器与 Verified Snapshot 格式化；
    - 牛熊辩论与结构化裁决输出 Rubric；
    - 结构化决策提取器（从 Agent 回复中解析 Action、Confidence、Thesis、Bull/Bear 论点与假设）；
    - Markdown 决策日志持久化管理（追加到工作区 `.agentdock/decisions/<monitor-id>.md`）；
    - 历史复盘教训检索与 Prompt 注入机制。
  - 改造 `AutomationActionExecutor`：
    - 感知 `workflowTemplate === 'deep-analysis'`，自动装配接地契约、辩论结构与历史教训；
    - 执行完毕后自动提取决策记录并写入决策日志；
    - 若配置了 `retrospectiveDelayHours > 0`，自动挂载一次性复盘自动化任务。
- **调度器与复盘执行器**：
  - 复盘触发时，拉取最新指标对比历史决策，生成事后反思评估并更新决策日志状态。
- **REST 路由与 SDK (`core-sdk`)**：
  - 提供 `GET /api/local/v1/automation/monitors/:monitorId/decisions` 查询接口；
  - `core-sdk` 暴露 `listAutomationMonitorDecisions(monitorId)`。
- **CLI (`lac monitor`) 与 Managed Skill (`stock-monitor`) 更新**：
  - `lac monitor add` 与 `lac monitor edit` 支持 `--workflow direct|deep-analysis` 与 `--retro-delay <hours>`；
  - 新增 `lac monitor decisions <id>` 子命令，支持在终端直接查看监控任务的历史决策与复盘日志；
  - 更新 `electron/managed-skills/stock-monitor/SKILL.md`，增加深度研判决策工作流说明、参数用法以及 Agent 引导 SOP。
- **UI 界面增强 (`src/pages/Automation/`)**：
  - Monitor 创建/编辑弹窗提供工作流模板选择（`标准直发 (Direct)` vs `深度研判与复盘 (Deep Analysis)`）；
  - 监控详情中展示最近决策与复盘状态徽标。

## 3. 非目标 (Non-Goals)

- 不引入复杂的多 Agent 编排（保持与单 Agent-per-thread 模型完全兼容，在单会话内完成多阶段辩论）；
- 不做真实自动交易与资金出入金（严格保持为分析辅助与人在环中）；
- 不推翻现有条件引擎与触发判定机制（完全在 Action 执行阶段增强）。

## 4. 核心接口与数据模型

```typescript
export type AutomationDecisionAction = 'BUY' | 'SELL' | 'HOLD' | 'WATCH' | 'ALERT' | 'REDUCE' | 'IGNORE';

export interface AutomationDecisionRecord {
  id: string;
  monitorId: string;
  workspaceId: string;
  runId?: string;
  threadId?: string;
  action: AutomationDecisionAction;
  confidence: number; // 0 - 100
  thesis: string;
  bullPoints: string[];
  bearPoints: string[];
  keyAssumptions: string[];
  invalidationTriggers?: string[];
  dataSnapshot: Record<string, unknown>;
  createdAt: string;
  retrospectiveStatus: 'pending' | 'completed' | 'skipped';
  retrospectiveScheduledAt?: string;
  retrospectiveEvaluatedAt?: string;
  retrospectiveOutcome?: {
    accuracy: 'correct' | 'incorrect' | 'neutral';
    realizedOutcome: string;
    reflection: string;
    lessons: string[];
  };
}
```

## 5. 验收标准 (Acceptance Criteria)

1. **向后兼容**：未指定 `workflowTemplate` 的现有监控任务维持 `'direct'` 行为，无任何回归。
2. **接地与辩论**：配置 `workflowTemplate: 'deep-analysis'` 的监控触发时，发送给 Agent 的 Prompt 包含：
   - `[GROUNDED DATA CONTRACT]` 严禁捏造数据并展示验证快照；
   - `[STRUCTURED WORKFLOW: DEEP ANALYSIS & ADJUDICATION]` 牛熊辩论与裁决指令；
   - 若存在历史复盘教训，自动包含 `[PREVIOUS RETROSPECTIVE LESSONS]`。
3. **决策持久化**：Agent 回复后，成功解析并在工作区 `.agentdock/decisions/<monitor-id>.md` 追加结构化 Markdown 记录，并通过 REST 接口可查。
4. **延时复盘**：配置 `retrospectiveDelayHours > 0` 时，系统自动创建 `once` 类型的延时复盘任务；触发时更新决策日志中的复盘反思结果。
5. **架构与门禁**：通过 `pnpm typecheck`、`pnpm lint:gates`、`pnpm lint:arch` 与全部单元/集成测试。
