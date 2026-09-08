# Architecture Change Record: 2026-09-05 Monitor Webhook Event Source

## Metadata

- **Date**: 2026-09-05
- **Revision / State**: Issue #102 Inbound Webhook Event Source
- **Architecture Impact**: `Required` (External event bus ingress, route expansion, condition engine push semantics)
- **Active Provider**: Archify (showcase profile, validated via `pnpm lint:arch`)
- **Comparison Artifact**: `docs/architecture/changes/2026-09-05-monitor-webhook-event-source.html`
- **Status**: Verified

## Context & Rationale

Prior to this change, the `AutomationMonitorService` and plugin SDK only supported polling-based event sources (such as `stock.quote`). The evaluation logic enforced stateful rising-edge suppression (`previous === true -> not_rising`), which prevents consecutive poll cycles with unchanged values from repeatedly re-triggering actions.

However, external systems (such as GitHub Actions, CI/CD pipelines, Prometheus/Alertmanager, and custom services) emit discrete push events. To support Inbound Webhooks:
1. An open external ingress HTTP route was needed: `POST /api/local/v1/automation/hooks/:hookId`.
2. Push events require discrete event semantics: each incoming webhook should be evaluated independently (bypass rising-edge suppression) while strictly honoring `cooldownMs` and concurrency locks.
3. Universal condition evaluation must support `always` (trigger on every valid webhook) as well as payload property comparisons (e.g. `event == "deploy"` or `status == "failed"`).
4. Automated token generation, validation (`Bearer`, `X-Hook-Token`, `?token=...`), CLI tooling, and Desktop UI integration are required.

## Implemented Architecture Facts

### 1. Plugin SDK & Provider Runtime Boundary
- Updated `packages/plugin-sdk/src/automation.ts`:
  - Added `'webhook'` to `MonitorCapability['modes']` and `MonitorProviderRuntime['modes']`.
- Created `services/local-ai-core/src/automation/webhook-provider.ts` implementing `WebhookMonitorProvider`:
  - Manages registered webhook monitors in-memory.
  - Implements `emitEvent(hookId, payload)` feeding directly into `AutomationService` event bus.
- Created `services/local-ai-core/src/plugins/builtin/monitor-webhook-plugin.ts` (`builtin.monitor-webhook`) and registered it in `createRuntimeMonitorPlugins()`.

### 2. Inbound HTTP Route & Authentication
- In `services/local-ai-core/src/runtime/server-routes.ts`:
  - Added route definition `{ name: 'automation.hooks.trigger', hookId: string }`.
  - Parsed `POST /api/local/v1/automation/hooks/:hookId` and `POST /automation/hooks/:hookId`.
- In `services/local-ai-core/src/runtime/handlers/automation-handler.ts`:
  - Handled token extraction from `Authorization: Bearer <token>`, `X-Hook-Token: <token>`, or `?token=<token>`.
  - Returns standard REST status codes: `200` (success with execution detail), `401` (unauthorized), `404` (not found), `400` (disabled monitor), `500` (internal error).

### 3. Discrete Event & Condition Engine Semantics
- In `services/local-ai-core/src/automation/condition-evaluator.ts` and `legacy-automation-mappers.ts`:
  - Added first-class support for `always` condition expression and metric.
- In `services/local-ai-core/src/automation/automation-service.ts`:
  - When `sourceType === 'webhook'`, `previous` snapshot is passed as `undefined` to bypass rising-edge `not_rising` suppression, allowing consecutive matching events to trigger agent analysis while honoring `cooldownMs`.

### 4. CLI & Desktop UI Integration
- CLI `lac monitor add --source webhook [--hook-id <id>] [--token <token>]`:
  - Automatically generates cryptographically secure `hookId` (`wh_<hex>`) and `token` (`whsec_<hex>`) if omitted.
  - Outputs full Hook URL and ready-to-use `curl` example command.
- Desktop UI (`src/pages/Automation/MonitorList.tsx` and `MonitorModal.tsx`):
  - Form support for `stock.quote` and `webhook` source types.
  - Quick condition presets (`always`, `event == "deploy"`, `status == "failed"`, `severity == "error"`).
  - Displays endpoint and token in monitor card with one-click `Copy curl` button.

## Evidence & Validation

- `pnpm typecheck`: Exit code 0 (zero TypeScript errors).
- `pnpm lint:gates`: Exit code 0 (zero circular dependencies, duplicates, dead code, file size, or function length violations; cyclomatic complexity <= 108 warnings).
- `pnpm lint:arch`: Exit code 0 (all 5 architecture specifications passed 9 showcase checks).
- `archify compare architecture`: Produced `docs/architecture/changes/2026-09-05-monitor-webhook-event-source.html` (28/28 checks passed).
- `archify deliver`: Delivered `docs/architecture/system-architecture.html` (9/9 artifact checks passed).
- `pnpm test`: Exit code 0 (741 unit/integration/contract tests passed, 80/80 BDD scenarios passed).
- Dedicated test coverage in `tests/electron/webhook-monitor.test.ts` (6 end-to-end integration test scenarios covering route parsing, auth, trigger, condition evaluation, disabled monitor, and cooldown suppression).
