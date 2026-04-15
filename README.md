# AI-WorkStation

`cc-connect` backend 服务的桌面管理客户端，正在演进为基于 Local AI Core 的单机版 Super AI App。

## 运行模式

- **桌面模式** — Electron 启动并管理本地 `cc-connect` 进程，通过 WebSocket 桥接实现实时聊天
- **Web 管理模式** — 通过 API Token + Server URL 连接远程 `cc-connect` 实例
- **Local AI Core 模式** — 通过本地 `127.0.0.1:9831` 的核心服务统一提供 runtime、chat 与事件流

## 技术栈

React 19 · Electron 35 · Vite · TypeScript · Tailwind CSS · Zustand · i18next · react-markdown

## 快速开始

```bash
pnpm install
pnpm dev          # 启动开发环境（Vite + Electron）
pnpm start:core   # 启动已构建的 Local AI Core
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 启动开发环境 |
| `pnpm dev:web` | 仅启动 Web 开发服务器 |
| `pnpm dev:core` | 构建并启动 Local AI Core |
| `pnpm build` | 完整生产构建 |
| `pnpm build:renderer` | 仅构建 React 前端 |
| `pnpm build:electron` | 仅构建 Electron 主进程 |
| `pnpm build:core` | 构建 Local AI Core 产物 |
| `pnpm start:core` | 运行已构建的 Local AI Core |
| `pnpm start:prod` | 运行已构建的 Electron 应用 |
| `pnpm e2e:smoke` | E2E 冒烟测试 |

## 环境变量

| 变量 | 说明 |
|---|---|
| `AI_WORKSTATION_USER_DATA_DIR` | 用户数据目录 |
| `AI_WORKSTATION_SMOKE_OUTPUT` | 冒烟测试输出路径 |
| `AI_WORKSTATION_SMOKE_SCENARIO` | 冒烟测试场景 |
| `AI_WORKSTATION_FORCE_RUNTIME_STATUS_ERROR` | 强制触发运行时状态错误，用于测试 |
| `AI_WORKSTATION_DEV_SERVER_URL` | Electron 开发模式连接的前端地址 |

## 项目结构

```
├── electron/        # Electron 主进程（IPC、服务管理、WebSocket 桥接）
├── apps/            # 未来的桌面/Web 前端壳目录
├── packages/        # contracts、core-sdk、adapters、knowledge-api
├── services/        # Local AI Core
├── src/             # React 渲染进程
│   ├── pages/       # 页面组件
│   ├── components/  # UI 组件库
│   ├── api/         # API 客户端
│   ├── store/       # Zustand 状态管理
│   └── types/       # 类型定义
├── shared/          # 跨进程共享类型
└── scripts/         # 构建/启动脚本
```
