# Spec: Monitor Inbound Webhook Event Source (#102 Phase 1)

## Goal
开放 AgentDock 的自动化 Monitor 事件总线，引入首个推送型事件源——**Inbound Webhook**。使外部系统（如 CI/CD 流水线、GitHub Webhook、Grafana/Prometheus 告警、自建服务等）能够通过安全鉴权的 HTTP POST 端点直接向 AgentDock 推送事件，唤起对应的 Monitor 规则评估，驱动底层 Agent 会话深入诊断或执行动作，并将结果流式或主动回传到绑定渠道（Lark / 企业微信 / 桌面）。

## Scope
1. **Plugin-SDK 契约拓展**：
   - 丰富 `MonitorCapability` 和 `MonitorProviderRuntime` 的运行模式，显式支持 `'webhook'` 模式。
   - 保持与现有 `'poll'` / `'subscribe'` 模式平滑兼容。
2. **内置 Webhook Monitor Provider**：
   - 在 `services/local-ai-core/src/automation/webhook-provider.ts` 实现 `WebhookMonitorProvider`，注册 `sourceType: 'webhook'`。
   - 在 `services/local-ai-core/src/plugins/builtin/` 封装 `createBuiltinWebhookMonitorPlugin()` 并在 `catalog.ts` 中注册到核心运行时。
   - 提供 `sourceConfig` 校验与默认值逻辑（自动生成 `hookId` 与安全 `token`）。
3. **HTTP Inbound Webhook 端点**：
   - 在 `LocalAiCoreServer` 注册 `POST /api/local/v1/automation/hooks/:hookId`。
   - 鉴权支持：`Authorization: Bearer <token>`、Header `X-Hook-Token: <token>` 以及 Query 参数 `?token=<token>`。
   - 请求体解析为 JSON payload（非 JSON 自动包装为 `{ raw: text }`），封装为标准 `AutomationMonitorEventSnapshot`。
   - 复用现有 Monitor 的生命周期与防护策略：检查 Monitor 启用状态（`enabled`），执行条件评估、并发跳过与 `cooldownMs` 冷却防抖。
4. **条件引擎增强**：
   - 优化 `condition-evaluator.ts`，原生支持 `--condition "always"`（或无条件触发），以及支持基于 Webhook payload 属性表达式的过滤（如 `action == "opened"`, `status == "failed"`）。
5. **CLI 工具扩展 (`lac`)**：
   - `lac monitor add --source webhook --title "<title>" --message "<prompt>" [--condition "<expr>"] [--hook-id <id>] [--token <tok>] [--cooldown <time>]`：创建后回显生成的 Webhook URL、Token 及示例 `curl` 调用命令。
   - `lac monitor info <id>`：对 webhook 类型 monitor 格式化展示 Hook 访问地址与鉴权状态。
6. **桌面端 UI (MonitorList)**：
   - Monitor 创建/编辑弹窗提供「事件源类型」选择（Stock quote / Webhook）。
   - 选择 Webhook 时，展示/配置 Hook ID 与 Token（支持一键复制 Webhook URL 与 Token 轮换/重置）。
   - 列表行展示 Webhook 标签与关键触发状态。

## Non-goals
- Phase 1 暂不实现 RSS 轮询解析器与本地文件变动监听器（`file-watch`），留待 Phase 2。
- 暂不实现外部 Webhook 的公网穿透/反向代理（如 ngrok/frp 内嵌），外部系统可通过局域网、Tailscale/P2P 隧道（#119）或反向代理直连 Local AI Core 端口。

## Behavior / Interface

### 1. Webhook 触发端点
- **路径**：`POST /api/local/v1/automation/hooks/:hookId`
- **鉴权**：
  - `Authorization: Bearer <token>` 或
  - `X-Hook-Token: <token>` 或
  - URL Query 参数 `?token=<token>`
- **请求体**：
  `application/json`，任意 JSON 对象，例如：
  ```json
  {
    "event": "build_failed",
    "service": "billing-api",
    "commit": "a1b2c3d",
    "log_url": "https://ci.company.internal/build/123"
  }
  ```
- **响应格式**：
  - `200 OK`:
    ```json
    {
      "success": true,
      "monitorId": "mon_xxx",
      "runId": "run_xxx",
      "status": "queued" | "running" | "succeeded" | "skipped",
      "decision": "triggered" | "skipped_cooldown" | "skipped_concurrent" | "not_matched"
    }
    ```
  - `401 Unauthorized`:
    ```json
    { "error": "Invalid or missing webhook token" }
    ```
  - `404 Not Found`:
    ```json
    { "error": "Webhook monitor not found or disabled: :hookId" }
    ```
  - `400 Bad Request`:
    ```json
    { "error": "Invalid request payload or monitor disabled" }
    ```

### 2. Monitor 数据模型约定
```typescript
interface AutomationMonitor {
  sourceType: 'webhook';
  sourceConfig: {
    hookId: string;       // 路由标识，如 "ci-deploy-alert" 或 "wh_a1b2c3d4"
    token: string;        // 鉴权秘钥，如 "whsec_..."
  };
  condition: AutomationMonitorCondition; // 如 { metric: 'always', operator: '==', value: true } 或自定义表达式
  promptTemplate: string; // 提示词模板，支持注入 payload 变量
  ...
}
```

## Constraints / Compatibility
- **兼容性**：现有的 `stock.quote` 监控源保持 100% 行为一致与 API 向后兼容；历史 Monitor 数据无需迁移。
- **边界与依赖方向**：遵循 `AGENTS.md` 架构准则，SDK 位于 `packages/plugin-sdk/`，内置插件位于 `services/local-ai-core/src/plugins/builtin/`，HTTP 端点位于 `services/local-ai-core/src/runtime/`。
- **并发与防抖**：复用 Monitor 既有的 `cooldownMs`（冷却期）与 `skip-if-running`（并发防护）策略，防止外部 Webhook 风暴导致 Agent 频繁无效派发。

## Acceptance Criteria
1. `WebhookMonitorProvider` 与 `createBuiltinWebhookMonitorPlugin` 正确注册，`sourceType: 'webhook'` 纳入 Monitor 运行时。
2. 调用 `POST /api/local/v1/automation/hooks/:hookId` 并提供有效 token 时：
   - 匹配对应 webhook monitor 并成功执行条件判断。
   - 条件匹配且不在冷却期内时，状态转为 `triggered`，成功触发 Agent 运行。
   - 在冷却期内再次请求时，返回状态记录为 `skipped_cooldown`，不重复派发 Agent。
3. 缺少或提供错误 token 时，端点返回 `401 Unauthorized`；不存在对应 hookId 或 monitor 禁用时返回 `404 Not Found`。
4. 条件引擎支持 `--condition "always"` 以及基于 Webhook payload 字段（如 `event == "alert"`）的条件匹配。
5. CLI 命令 `lac monitor add --source webhook ...` 能正确创建 Webhook Monitor，并友好输出接入 URL 与 Token。
6. UI 页面 `MonitorList.tsx` 支持选择 Webhook 源、自动/手动填写 Hook 配置并展示 Webhook 详情卡片。
7. 运行 `pnpm test`、`pnpm typecheck`、`pnpm lint:gates` 与 `pnpm lint:arch` 门禁全部无错误通过。
