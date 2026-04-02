# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

cc-connect-desktop is an Electron + React app that manages a `cc-connect` backend service. It runs in two modes:
- **Desktop mode**: Electron app spawns/manages a local `cc-connect` binary, with real-time chat via WebSocket bridge
- **Web admin mode**: Connects to a remote `cc-connect` instance via API token + server URL

The `desktopManaged` flag in the auth store controls which mode is active, affecting routing and available features.

## Build & Dev Commands

All commands use `pnpm`.

| Command | Purpose |
|---|---|
| `pnpm dev` | Start Vite renderer + tsc watch + Electron (via `scripts/dev.mjs`) |
| `pnpm build` | Full production build (renderer + Electron) |
| `pnpm build:renderer` | Build only the React frontend to `dist/renderer/` |
| `pnpm build:electron` | Build only Electron main process to `dist-electron/` |
| `pnpm start:prod` | Run the built Electron app |
| `pnpm e2e:smoke` | Build + run E2E smoke test |

No unit test framework is configured. `pnpm e2e:smoke` is the only automated test.

## Architecture

### Two Separate TypeScript Compilations
1. **Renderer** (`src/`): Compiled by Vite with ESM/react-jsx, outputs to `dist/renderer/`
2. **Electron main** (`electron/`): Compiled by `tsc` directly with CommonJS, outputs to `dist-electron/`

Both share types from `shared/` — this is the single source of truth for interfaces crossing the IPC boundary.

### Electron IPC Flow
```
Renderer (React) ←→ window.desktop API ←→ preload.ts (contextBridge) ←→ main.ts (IPC handlers)
```
- `electron/preload.ts` exposes `window.desktop` via `contextBridge`
- `src/api/desktop.ts` provides typed wrappers for IPC methods
- `src/types/window.d.ts` declares the TypeScript interface for `window.desktop`

### Key Electron Classes
- **ServiceManager** (`electron/service-manager.ts`): Manages cc-connect child process lifecycle, TOML config, port allocation
- **BridgeAdapter** (`electron/bridge-adapter.ts`): WebSocket client for real-time bridge communication (chat, typing, buttons, cards)

### Renderer Structure
- **Pages**: `src/pages/` — organized by feature (Projects, Sessions, Desktop, Bridge, Cron, System)
- **UI components**: `src/components/ui/` — custom component library (Button, Card, Badge, Modal, Input, Select, Textarea, EmptyState)
- **API clients**: `src/api/` — `client.ts` has the base `ApiClient` class; feature modules wrap specific endpoints
- **State**: Zustand stores in `src/store/` (`auth.ts`, `theme.ts`)
- **Routing**: `HashRouter` in desktop mode, `BrowserRouter` in web mode (decided in `src/main.tsx`)

### Tech Stack
React 19, Electron 35, Vite 6.3, TypeScript (strict), Tailwind CSS 3.4, Zustand 5, react-router-dom 7.5, i18next (5 languages), react-markdown + highlight.js

## Conventions

- 2-space indentation, semicolons in renderer code
- `@/` path alias maps to `src/`
- `PascalCase` for components and page folders, `camelCase` for functions/helpers, lowercase filenames for stores and API modules
- Accent color `#42ff9c` (bright green) throughout the UI
- Tailwind class-based dark mode with `@tailwindcss/typography`
- Keep shared desktop contracts in `shared/` so renderer and Electron stay type-aligned
- Environment variables: `CC_CONNECT_DESKTOP_USER_DATA_DIR`, `CC_CONNECT_DESKTOP_SMOKE_OUTPUT`

## Large Files

These single-file components are intentionally large and contain substantial logic:
- `src/pages/Desktop/Workspace.tsx` (~72KB) — desktop workspace management
- `src/pages/Desktop/Chat.tsx` (~55KB) — desktop chat interface
- `electron/main.ts` (~48KB) — Electron main process with all IPC handlers
