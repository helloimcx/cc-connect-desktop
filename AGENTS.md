# Repository Guidelines

## Project Overview & Monorepo Architecture

AgentDock is a pnpm monorepo consisting of an Electron desktop shell, a React renderer, and a dedicated **Local AI Core** backend runtime.

### Directory Layout

- `packages/`: Shared workspace packages
  - `contracts` (`@cc/superai-contracts`): Shared API and cross-process data contracts
  - `core-sdk` (`@cc/core-sdk`): Client SDK for Local AI Core REST, WebSocket, and SSE APIs (used by renderer and external clients)
  - `knowledge-api` (`@cc/knowledge-api`): Knowledge base SQLite store, indexing, and vector search abstractions
  - `plugin-sdk` (`@cc/plugin-sdk`): Plugin contracts, agent runtime, channel, scheduler, and sandbox interfaces
- `services/`: Core backend services
  - `local-ai-core/`: The Node.js backend daemon (HTTP server, WebSocket event bus, ACP session orchestration, scheduler, channels)
- `apps/`: Target application shell stubs (`shell-desktop`, `shell-web`)
- `electron/`: Electron desktop shell (main process, window lifecycle, managed skill definitions)
- `src/`: React 19 web/desktop renderer (pages, shared components, Zustand state, i18n)
- `shared/`: Cross-process shared types (`shared/desktop.ts`)
- `tests/`: Cross-layer tests (`tests/electron/`, `tests/contracts/`, `tests/integration/`, and `tests/bdd/`)
- `public/`: Static assets
- Build outputs: `dist/renderer/` (Vite output) and `dist-electron/` (compiled TypeScript output); do not edit them directly

### Runtime Modes & Process Boundaries

1. **Desktop Mode**: Electron launches Local AI Core as a child process (`ELECTRON_RUN_AS_NODE=1`), verifies health at `http://127.0.0.1:9831/api/local/v1/health`, then opens the renderer window. `electron/preload.ts` is intentionally empty — there is no Electron IPC bridge. All renderer-to-backend communication uses HTTP/WebSocket via `@cc/core-sdk`.
2. **Web Admin Mode**: Connects directly to a remote or standalone Local AI Core instance via API token + server URL.

The `desktopManaged` flag and `managedBy` state in `src/store/auth.ts` control the active mode, routing, and available desktop-specific features.

### Two Separate TypeScript Compilations

1. **Renderer** (`src/`): Compiled by Vite with ESM/react-jsx, outputs to `dist/renderer/`.
2. **Backend & Electron** (`electron/`, `services/`, `packages/`): Compiled by `tsc -p tsconfig.electron.json` with CommonJS and alias resolution via `tsc-alias`, outputs to `dist-electron/`.

Both compilation pipelines share contracts from `shared/` and `packages/contracts/`.

### Local AI Core Subsystems (`services/local-ai-core/`)

- **ACP** (`src/acp/`): Agent Client Protocol orchestration — session coordinator, transport, turn management, permissions, and streaming
- **Kernel** (`src/kernel/`): Process bootstrap, event bus, SQLite database migrations, configuration management, plugin registry, and capability registry
- **Router** (`src/router/`): Workspace routing, model provider routing, and channel bindings
- **Runtime** (`src/runtime/`): HTTP REST API (`/api/local/v1/*`), WebSocket events (`/api/local/v1/events`), and external agent API (`/api/local/v1/external/*` with per-run SSE streaming)
- **Channel** (`src/channel/`): Native enterprise messaging gateways (Lark/Feishu, WeChat Work) for inbound webhooks/long-polling and outbound interactive cards
- **Scheduler** (`src/scheduler/`): Cron-based task scheduling, due polling, and automated delivery to threads and channels
- **Automation** (`src/automation/`): Automation triggers, script approvals, and execution monitors
- **Sandbox** (`src/sandbox/`): Docker and OpenSandbox container management for isolated agent runs
- **Security** (`src/security/`): Permissions lifecycle, credential encryption, and execution boundaries
- **Skills** (`src/skills/`): Deterministic skill routing, tool indexing, and skill discovery
- **Cost** (`src/cost/`): Token usage tracking, budget constraints, and cost analytics
- **Agents** (`src/agents/`): Agent runtime adapters and protocol translations (Claude Code, Codex, Pi, OpenCode)
- **Thread** (`src/thread/`): Workspace thread ID management and thread knowledge bindings
- **Plugins** (`src/plugins/builtin/`): Built-in plugins with lowercase dotted IDs (e.g. `channel.lark`, `scheduler.cron`, `knowledge.ai-vector`)
- **CLI** (`src/cli/`): Command-line entry points

### Renderer Structure (`src/`)

- **Pages** (`src/pages/`): Feature views — `Automation/`, `Cost/`, `Cron/`, `Dashboard.tsx`, `Desktop/` (Workspaces), `Knowledge/`, `Providers/`, `Skills/`, `System/`, `Threads/` (ThreadChat, permission decisions)
- **UI Components** (`src/components/`): Reusable UI built on Radix UI primitives (`src/components/ui/`), artifact visualizers (`src/components/artifacts/`), and execution timelines (`src/components/traces/`)
- **API Client**: Consumes `@cc/core-sdk` (`packages/core-sdk`) rather than internal ad-hoc fetchers
- **State** (`src/store/`): Zustand stores — `auth.ts` (auth, server connection, runtime mode), `theme.ts`
- **App Registry** (`src/app/`): Dynamic UI contribution registry for nav items and views controlled by runtime capability detection
- **i18n** (`src/i18n/`): Multi-language support (en, zh, zh-TW, ja, es)

---

## Build, Test, and Development Commands

Use `pnpm` for all local work.

| Command | Purpose |
|---|---|
| `pnpm dev` | Starts Vite renderer + Electron app through `scripts/dev.mjs` |
| `pnpm dev:web` | Starts standalone Vite renderer at `127.0.0.1:5173` |
| `pnpm dev:core` | Builds Electron/Core and launches Local AI Core standalone via `scripts/launch-core.mjs` |
| `pnpm build` | Full production build (`build:web` + `build:electron`) |
| `pnpm build:renderer` | Builds web renderer into `dist/renderer/` |
| `pnpm build:electron` | Compiles Electron, services, and packages into `dist-electron/` |
| `pnpm start:prod` | Launches packaged app from current `dist-electron/` build |
| `pnpm typecheck` | Runs TypeScript typechecks (`tsconfig.json` and `tests/bdd/tsconfig.json`) |
| `pnpm test` | Runs typecheck, builds renderer + Electron, runs Node.js test runner, then executes BDD suite |
| `pnpm test:bdd` | Runs Cucumber BDD feature tests (`tests/bdd/features/`) via `tsx` loader |
| `pnpm coverage` | Measures test coverage using `c8` against `.c8rc.json` thresholds |
| `pnpm verify` / `pnpm qa` | Runs all static gates, architecture lint, tests, and coverage checks |
| `pnpm e2e:smoke` | Runs the bundled smoke test against a fresh production build |
| `pnpm dist:mac` | Builds and packages macOS DMG and ZIP (`arm64`) |
| `pnpm dist:win` | Builds and packages Windows NSIS installer and ZIP (`x64`) |

---

## Quality Metrics

- `pnpm lint:complexity`: reports cyclomatic complexity per function across TS source via ESLint `complexity` rule (default max threshold 15). CI gate: `pnpm lint:complexity:gate` (ESLint `--max-warnings 108` baseline).
- `pnpm lint:circular`: reports circular import dependencies across source roots using `madge`. CI gate: `--fail` (zero-tolerance, baseline 0).
- `pnpm lint:duplicate`: reports copy/paste duplicate code rate using `jscpd`. CI gate: `--fail` with `JSCPD_MIN_LINES=10`/`JSCPD_MIN_TOKENS=60`; lark/weixin gateway files are ignored (deliberately parallel implementations).
- `pnpm lint:dead-code`: reports unused exports, unused types, and duplicate exports using `knip` (entry points declared in `knip.json`). CI gate: `--fail --max-count 171` (incremental over baseline).
- `pnpm lint:function-length`: reports functions whose line count exceeds threshold (default 100). CI gate: `--fail --max-count 45` (incremental over baseline).
- `pnpm lint:file-size`: reports source files whose line count exceeds threshold (default 1000). CI gate: `--fail` (zero-tolerance).
- `pnpm coverage`: measures test coverage using `c8`. CI gate: `check-coverage` thresholds in `.c8rc.json` (lines/statements 68, functions 72, branches 66).
- `pnpm lint:arch`: validates all architecture and workflow specifications in `docs/architecture/` via Archify showcase checks.
- All gates aggregate in `pnpm lint:gates`; CI runs it plus `typecheck`/`test`/`coverage` in `.github/workflows/ci.yml`.

---

## Coding Style & Naming Conventions

- TypeScript with `strict` mode enabled across all packages.
- Path aliases: `@/` maps to `src/`, `@cc/*` maps to workspace packages in `packages/*`.
- Formatting: 2-space indentation, semicolons in renderer code, and clear ESM imports.
- Naming: `PascalCase` for React components and page folders (`src/pages/Desktop/Workspace.tsx`, `src/pages/Threads/ThreadChat.tsx`), `camelCase` for functions and helpers, and lowercase filenames for stores and SDK modules (`src/store/auth.ts`, `packages/core-sdk/src/client.ts`).
- UI styling: Tailwind CSS with class-based dark mode, `@tailwindcss/typography`, and the project accent color `#42ff9c` (bright green).
- Keep shared desktop and API contracts in `shared/` and `packages/contracts/` so renderer, Electron, and Local AI Core stay aligned.

---

## Architecture Boundaries

Keep the directory structure intentional, with clear ownership and single-purpose modules:
- Page components orchestrate UI and data flow; shared components stay presentation-focused; stores own state transitions; API communication is isolated in `@cc/core-sdk`.
- Electron and Local AI Core internals must never leak into renderer code except through shared contracts and SDK APIs.
- Strict one-way inward dependencies: low-level modules (shared contracts, SDKs, kernel interfaces) must never depend on higher-level modules (UI pages, components, specific plugins, or desktop shell code).
- Prefer small, cohesive files over broad utility modules, and move reusable behavior to the nearest appropriate shared layer only after a real second use appears.
- When a code file exceeds 1000 lines, consider splitting it.
- Keep agent runtime quirks in `services/local-ai-core/src/agents/<agent-id>/` first, and only move behavior into shared ACP/router/storage/renderer layers when the invariant truly applies across agents.
- When changing chat UI styles, consider all chat surfaces together: desktop app, web, mobile H5, and the different channel/session entry points.

<!-- project-setup:architecture-maintenance:start -->
## Architecture maintenance

Before implementation, classify Architecture Impact as `Required` or `None`.
Use `Required` when a change alters module or service responsibilities,
dependency direction or public protocols, data ownership or flow,
trust, deployment, process, or network boundaries, external integrations,
synchronous/asynchronous communication, or adds, removes, splits, or merges
an architectural component.

When `Required`, read and follow `docs/architecture/maintenance.md` before
implementation. Completion requires the current architecture facts, one
change record, provider artifacts and validation, and the README diagram to agree.
<!-- project-setup:architecture-maintenance:end -->

### Architecture Specifications & Diagrams

Architecture and flow diagrams live under `docs/architecture/` as typed Archify JSON specs:
- **L1 System Architecture**: `system-architecture.json`
- **L2 Scheduled Delivery Workflow**: `scheduled-delivery-workflow.json`
- **L2 ACP Session Flow Sequence**: `acp-session-flow.sequence.json`
- **L2 Skill Router Workflow**: `skill-router.workflow.json`
- **L3 Agent Run Lifecycle**: `agent-run.lifecycle.json`

Update corresponding diagram specs alongside architectural or core workflow changes, validate via `pnpm lint:arch`, deliver showcase HTML/PNG artifacts, and keep `README.md` and `docs/architecture/overview.md` linked.

### Multi-Entity Identifiers

When designing or connecting multi-entity models (such as `AutomationRun` wrapping an underlying `acpRunId`, or channel sessions wrapping threads), maintain clear semantic separation between the outer wrapper ID and the inner execution ID. Avoid treating all identifiers as generic strings. Downstream APIs and UI components must explicitly document and consume the precise target ID domain, and backend lookup methods should implement defensive alias resolution where cross-entity lookups are plausible.

---

## Plugin Development

- Plugin contracts and runtime types belong in `packages/plugin-sdk/`; keep cross-process data shapes in shared contracts instead of duplicating them in plugins.
- Built-in Local AI Core plugins live under `services/local-ai-core/src/plugins/builtin/`, with one focused file or folder per plugin and lowercase dotted IDs such as `channel.lark`, `scheduler.cron`, or `knowledge.ai-vector`.
- Register plugins through the local core registry and declare dependencies in the manifest rather than relying on implicit load order.
- Put reusable kernel behavior in `services/local-ai-core/src/kernel/`, not inside individual plugins, and avoid adding dynamic plugin loading until the static registration path is stable.

---

## Testing Guidelines

- The primary verification suite is `pnpm test`, which runs `typecheck`, builds renderer and Electron outputs, executes the Node.js test runner across compiled tests (`dist-electron/tests/electron/*.test.js`, `dist-electron/tests/contracts/*.test.js`, `dist-electron/tests/integration/*.test.js`, `dist-electron/packages/knowledge-api/test/*.test.js`, `dist-electron/src/pages/Threads/thread-chat-permission.test.js`), and runs Cucumber BDD tests (`pnpm test:bdd`).
- BDD feature specifications live under `tests/bdd/features/` with step definitions in `tests/bdd/step-definitions/`. They execute against TypeScript source using the `tsx` loader. Reach for a `.feature` when a behavior reads naturally as Given/When/Then scenarios.
- Use `pnpm e2e:smoke` for packaged app smoke coverage.
- Keep single-module renderer tests near the feature they cover, put cross-layer tests under `tests/electron/`, `tests/contracts/`, or `tests/integration/`, and keep package-private tests under `packages/<name>/test/`.
- Always use realistic, production-aligned ID formats in tests (e.g. `run:agentdock::<uuid>:<timestamp>`, `automation-run:<uuid>`, `thread:<workspace>::<uuid>`) instead of neutral placeholders like `'run-1'` or `'test-id'`.
- Use TDD selectively where it prevents repeated regressions: start by writing the smallest failing test that reproduces the bug, then fix the underlying invariant.

---

## Agent Workflow

- Before writing any code, describe the intended approach and wait for approval. If requirements are ambiguous, ask clarifying questions before writing code.
- If a user request for code is not aligned with best practices, briefly explain the concern and suggest a better approach.
- When investigating issues, reason from first principles about the data model, event flow, and ownership boundaries; first locate whether the faulty state is in agent session storage, Local AI Core logs, SQLite thread records, bridge events, or live UI state, then decide whether the model or workflow needs improvement before applying localized patches.
- When bridging data across layers (e.g. from Automation lists to Run Trace drawers), trace the identifier from its origin table through SDK endpoints to backend SQL queries; never assume an outer entity's `.id` matches an inner execution runtime's `.id` without verification.
- When fixing a bug, start by writing a test that reproduces it, then fix the bug until the test passes.
- When adding a new feature, update the `README.md` `New` section with a concise user-visible note.
- After writing code, list relevant edge cases and suggest test cases to cover them.
- When updating project progress, status notes, changelogs, or date-sensitive logs, verify the current date first and use concrete dates instead of stale relative dates.
- Every time the user corrects the agent, reflect on what went wrong and provide a plan to avoid repeating the same mistake.

---

## Commit & Pull Request Guidelines

Before committing or pushing code, run the same gates CI runs: `pnpm verify` (or `pnpm typecheck`, `pnpm lint:gates`, `pnpm lint:arch`, `pnpm test`, and `pnpm coverage`), to ensure zero TS errors, zero circular dependencies, no new duplicate code blocks, no new dead symbols or long functions, no new ESLint warnings, and 100% test pass rate. Use short, imperative commit subjects such as `Add bridge runtime retry` or `Fix smoke test startup timing`. Keep pull requests focused, describe user-visible changes, list validation commands you ran, and include screenshots for UI updates.

---

## Configuration Notes

Development scripts honor Electron runtime overrides such as `AI_WORKSTATION_USER_DATA_DIR`, `AI_WORKSTATION_SMOKE_OUTPUT`, and `AI_WORKSTATION_DEV_SERVER_URL`. Avoid committing machine-specific paths, secrets, or generated output.
