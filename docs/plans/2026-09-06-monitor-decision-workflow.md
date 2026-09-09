# Plan: 监控触发决策工作流与事后复盘闭环实施计划

## 1. 架构方案图 (Workflow Diagram)

本方案的可视化架构与流转时序已由 Archify 生成并通过 Showcase 校验：
- **方案交互式 HTML 画布**：[`docs/architecture/changes/2026-09-06-monitor-decision-workflow.html`](../architecture/changes/2026-09-06-monitor-decision-workflow.html)
- **DSL 规范定义**：`docs/architecture/changes/2026-09-06-monitor-decision-workflow.workflow.json`

包含四阶段生命周期与三向泳道：
1. **事件接入与数据接地 (Ingress)**：事件触发 → 抽取 Verified Snapshot 数据快照，注入接地断言禁令；
2. **牛熊自辩论与综合裁决 (Agent Debate)**：多头论证 → 空头论证 → 格式化裁决输出（Action、Confidence、Key Assumptions）；
3. **决策日志留痕 (Decision Log)**：提取决策追加至 `.agentdock/decisions/<monitor-id>.md`，并保存结构化记录；
4. **延时复盘与反思回流 (Retrospective Loop)**：调度器注册 T+1/T+5 `once` 任务，到期重新拉取行情检验对错，反思教训回流注入后续分析。

---

## 2. 详细实施步骤 (TDD 顺序)

### 阶段一：契约层与决策数据模型扩展
1. **`packages/contracts/src/automation.ts` & `automations.ts`**
   - 增加 `workflowTemplate?: 'direct' | 'deep-analysis'` 与 `retrospectiveDelayHours?: number` 到 `AutomationAction`、`AutomationMonitor` 等契约；
   - 导出 `AutomationDecisionAction`、`AutomationDecisionRecord` 契约定义。
2. **`services/local-ai-core/src/automation/legacy-automation-mappers.ts`**
   - 适配 `monitorToAutomationInput` 与 `automationToMonitor` 中的属性双向映射，保证 100% 向后兼容。

### 阶段二：决策工作流引擎与数据接地契约实现 (TDD: `decision-workflow.test.ts`)
1. **编写单测**：验证数据接地 Prompt 生成、牛熊辩论模板装配、JSON 决策提取与 Markdown 日志追加格式。
2. **`services/local-ai-core/src/automation/decision-workflow.ts`**
   - `formatGroundedDataContract(payload)`: 将事件快照格式化为数据契约约束块；
   - `composeDeepAnalysisPrompt(basePrompt, payload, priorLessons)`: 装配牛熊辩论与裁决输出格式；
   - `extractDecisionRecord(replyText)`: 鲁棒提取结构化决策信息，包含 Fallback 降级解析；
   - `renderDecisionLogMarkdown(record)`: 渲染追加到工作区决策日志文件的 Markdown 段落；
   - `extractRetrospectiveLessons(logContent)`: 解析历史复盘中的核心教训列表。
3. **`services/local-ai-core/src/automation/decision-log-service.ts`**
   - 管理工作区 `.agentdock/decisions/<monitor-id>.md` 的文件读取、追加与内存/SQLite 状态同步。

### 阶段三：集成 ActionExecutor 与延时复盘调度 (TDD: `decision-action-executor.test.ts`)
1. **`services/local-ai-core/src/automation/automation-action-executor.ts`**
   - 在执行前检查 `workflowTemplate`：若是 `'deep-analysis'`，读取前序复盘教训并注入接地契约；
   - 执行后解析决策记录，调用 `DecisionLogService` 追加日志；
   - 若 `retrospectiveDelayHours > 0`，调用 `AutomationService.create` 挂载 `activation: { kind: 'once', runAt: delayDate }` 的单次复盘任务；
   - 当复盘任务触发时，拉取最新标的行情并对比历史假设，生成复盘报告并更新决策日志。

### 阶段四：REST API、Core SDK 与 CLI (`lac monitor`)
1. **`services/local-ai-core/src/runtime/server-routes.ts` & `handlers/automation-handler.ts`**
   - 增加 `GET /api/local/v1/automation/monitors/:monitorId/decisions` 端点；
2. **`packages/core-sdk/src/automation.ts`**
   - 导出 `listAutomationMonitorDecisions(monitorId)` 方法。
3. **`services/local-ai-core/src/cli/lac.ts`**
   - `lac monitor add` 增加 `--workflow <direct|deep-analysis>` 与 `--retro-delay <hours>`；
   - `lac monitor edit` 支持更新工作流模板与复盘延迟；
   - 新增 `lac monitor decisions <id>` 子命令输出历史决策记录与复盘反思。

### 阶段五：Managed Skill (`stock-monitor` & `decision-workflow`) 与前端界面增强
1. **`electron/managed-skills/stock-monitor/SKILL.md`**
   - 更新股票盯盘技能文档：补充 `--workflow deep-analysis` 深度研判与复盘能力、牛熊辩论规范以及相关 CLI 命令示例与引导 SOP。
2. **`electron/managed-skills/decision-workflow/SKILL.md`**
   - 沉淀面向 Agent 的决策工作流技能文档；
3. **`src/pages/Automation/MonitorList.tsx` & `MonitorModal.tsx`**
   - 表单中增加 `Workflow Template` 下拉选择器与复盘延时设置；
   - 监控卡片上展示决策模式 Badge 与最近决策状态。

---

## 3. 测试与质量门禁策略

1. **单元测试**：
   - `decision-workflow.test.ts`：数据接地约束、牛熊论点解析、异常格式容错；
   - `decision-log-service.test.ts`：Markdown 日志读写、历史教训提取。
2. **集成测试**：
   - `automation-decision-integration.test.ts`：端到端模拟监控触发 → 深度研判 → 决策日志写入 → 挂载延时复盘任务。
3. **回归门禁**：
   - `pnpm typecheck` (0 Errors)
   - `pnpm lint:gates` (无循环依赖、无重复代码违规、函数长度与复杂度符合基线)
   - `pnpm lint:arch` (5/5 架构规范全部通过 Showcase 校验)
   - `pnpm test` (全量测试套件全部通过)
