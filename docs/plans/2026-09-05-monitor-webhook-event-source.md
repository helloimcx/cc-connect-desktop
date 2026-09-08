# Implementation Plan: Monitor Inbound Webhook Event Source (#102 Phase 1)

## Architecture & Visual Promise
- **方案架构对比图**：[docs/architecture/changes/2026-09-05-monitor-webhook-event-source.html](file:///Users/momo/code/agentdock/docs/architecture/changes/2026-09-05-monitor-webhook-event-source.html)
- **架构影响**：`Architecture Impact: Required`（新增 Inbound Webhook 外部通信端点与事件源 Provider 契约）。

## Step-by-Step Implementation Steps

### Phase 1: 契约拓展与 Webhook Provider 实现 (TDD Red -> Green)
1. **[MODIFY] `packages/plugin-sdk/src/automation.ts`**:
   - 在 `MonitorCapability` 和 `MonitorProviderRuntime` 的 modes 联合类型中增加 `'webhook'`（即 `Array<'poll' | 'subscribe' | 'webhook'>`）。
2. **[NEW] `services/local-ai-core/src/automation/webhook-provider.ts`**:
   - 实现 `WebhookMonitorProvider`，注册 `sourceType: 'webhook'`。
   - `validateConfig`: 校验 `hookId` 与 `token` 为有效字符串。
3. **[NEW] `services/local-ai-core/src/plugins/builtin/monitor-webhook-plugin.ts`**:
   - 定义 `createBuiltinWebhookMonitorPlugin(): MonitorPlugin`，声明 provides: `['monitor.source.webhook']`。
4. **[MODIFY] `services/local-ai-core/src/plugins/builtin/catalog.ts`**:
   - 在 `createRuntimeMonitorPlugins()` 中加入 `createBuiltinWebhookMonitorPlugin()`。
5. **[MODIFY] `services/local-ai-core/src/automation/automation-monitor-service.ts`**:
   - 增强 Monitor 创建逻辑：当 `sourceType === 'webhook'` 时，若 `sourceConfig.hookId` 或 `sourceConfig.token` 为空，自动生成唯一的 `hookId`（`wh_<random>`）与安全随机 `token`（`whsec_<random>`）。
   - 新增方法 `triggerWebhook(hookId: string, payload: unknown, token?: string): Promise<{ monitor: AutomationMonitor; run: AutomationMonitorRun; decision: string }>`：
     - 通过 `hookId` 定位到对应 monitor。
     - 校验 `monitor.enabled`。
     - 校验 `token` 与 `monitor.sourceConfig.token` 相符（支持 Bearer / X-Hook-Token / query param）。
     - 构建 `AutomationMonitorEventSnapshot`，调用 `evaluateEvent` 执行规则判断与动作触发。
     - 返回执行结果与裁决决策。
6. **[MODIFY] `services/local-ai-core/src/automation/condition-evaluator.ts`**:
   - 支持 `always` 简写：当 `expression === 'always'` 或 `condition.metric === 'always'` 时，无条件匹配成功。
   - 支持 payload 多层级属性路径（如 `event`, `action`, `status`）提取与比较。

### Phase 2: HTTP 路由与 Server 端点集成 (TDD Red -> Green)
1. **[MODIFY] `services/local-ai-core/src/runtime/server-routes.ts`**:
   - 在 `LocalAiCoreRoute` 中新增 `{ name: 'automation.hooks.trigger', hookId: string }`。
   - 在 `parseAutomationMonitorsRoute` 或 `parseAutomationHooksRoute` 解析 `POST /api/local/v1/automation/hooks/:hookId`。
2. **[MODIFY] `services/local-ai-core/src/runtime/handlers/automation-handler.ts`**:
   - 注册 `automation.hooks.trigger` 路由处理器：
     - 提取 Header `Authorization` (Bearer)、Header `X-Hook-Token` 或 Query `token`。
     - 读取 JSON Body。
     - 调用 `automationMonitors.triggerWebhook(hookId, body, token)`。
     - 依据返回结果响应 200，并在鉴权失败时响应 401，未找到时响应 404。

### Phase 3: CLI 工具扩展 (`lac`) (TDD Red -> Green)
1. **[MODIFY] `services/local-ai-core/src/cli/lac.ts`**:
   - 在 `buildSourceConfig` 中支持 `sourceType === 'webhook'`，读取 `--hook-id` 与 `--token` 选项。
   - 在 `handleMonitorAdd` 中，当创建 Webhook Monitor 时，格式化输出 Webhook URL、Token 及示例 curl 命令。
   - 在 `handleMonitorInfo` 中展示 Webhook 详情。
   - 更新 `printUsage` 帮助文案。

### Phase 4: 前端桌面 UI 适配 (`MonitorList.tsx`)
1. **[MODIFY] `src/pages/Automation/MonitorList.tsx`**:
   - 在 `sourceDefinitions` 中加入 `webhook` 配置定义。
   - 弹窗表单支持切换事件源（Stock quote / Webhook）。
   - Webhook 模式下展示 Hook ID 与 Token 字段，提供随机生成默认值。
   - 列表展示 Webhook 地址一键复制按钮与鉴权秘钥预览。

### Phase 5: 测试、架构与文档门禁
1. **自动化测试**：
   - 编写 `tests/electron/webhook-monitor.test.ts`（测试 Webhook Monitor 端到端流程：创建、有效 token 触发、无效 token 拒绝、cooldown 跳过、condition 匹配/不匹配过滤）。
   - 编写 CLI 单元测试（测试 `lac monitor add --source webhook` 参数解析与输出）。
2. **架构规范与门禁**：
   - 更新 `docs/architecture/system-architecture.json`。
   - 执行 `node scripts/lint-architecture.mjs`，通过全部 Archify 门禁。
   - 记录 `docs/architecture/changes/2026-09-05-monitor-webhook-event-source.md` 语义变更。
   - 同步更新 `docs/architecture/overview.md` 与 `README.md`。
3. **全量质检门禁**：
   - `pnpm test`
   - `pnpm typecheck`
   - `pnpm lint:gates`
