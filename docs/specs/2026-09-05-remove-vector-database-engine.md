# Spec: 去掉向量数据库引擎模块，简化代码架构

- **Task Slug**: `remove-vector-database-engine`
- **Date**: `2026-09-05`
- **Status**: Approved

## 1. Goal
彻底剥离 AgentDock 中强依赖外部 Qdrant 服务的 `ai_vector` 向量数据库引擎适配代码（`ai-vector-provider.ts`）与核心插件，将系统架构全景图中的独立“向量知识库引擎”节点与连线移除，收敛 Local AI Core 内核为纯本地自治架构，并通过内置 Capability Snapshot 驱动前端自然隐退知识库交互入口，保障全量 CI 门禁与契约测试 100% 绿色通过。

## 2. Scope
1. **物理删除外部向量服务适配**：
   - 删除 `packages/knowledge-api/src/ai-vector-provider.ts`（507 行外部 HTTP/Qdrant 通信逻辑）。
   - 删除 `packages/knowledge-api/test/ai-vector-provider.test.ts`。
   - 删除 `services/local-ai-core/src/plugins/builtin/knowledge-ai-vector-plugin.ts`。
2. **Local AI Core 插件收敛**：
   - 简化 `services/local-ai-core/src/plugins/builtin/catalog.ts`：移除向量插件，统一返回内置 `createBuiltinNoopKnowledgePlugin()`。
   - 调整 `services/local-ai-core/src/kernel/bootstrap.ts`：快照输出 `adapters.knowledge: false` 与 `adapters.knowledgeProviders: []`。
3. **共享 Package 保持规范导出**：
   - 更新 `packages/knowledge-api/src/index.ts`：移除 `AiVectorKnowledgeProvider` 与 `createAiVectorKnowledgePlugin`，保留 `NoopKnowledgeProvider`、`createNoopKnowledgePlugin` 及 `defaultKnowledgeConfig`。
   - 新增 `packages/knowledge-api/test/noop-provider.test.ts`，确保 `package.json` 测试脚本匹配路径正常且快速通过。
4. **前端配置与交互精简**：
   - `src/pages/System/Config.tsx` 移除已失效的 "Knowledge base URL" 配置项。
   - `src/pages/Threads/ThreadChatComposer.tsx` 在 `knowledgeModule` 为禁用时不展示知识库选择按钮。
5. **架构资产与文档同步**：
   - `docs/architecture/system-architecture.json` 移除 `knowledge` 节点、`kernel-to-knowledge` 连线、边界引用与卡片描述。
   - 重新交付 `docs/architecture/system-architecture.html` 并通过 `pnpm lint:arch` 验证。
   - 同步更新 `docs/architecture/knowledge-runtime.md` 与 `docs/architecture/overview.md`。
6. **内核测试适配**：
   - `tests/electron/plugin-kernel.test.ts` 断言更新为禁用状态。

## 3. Non-goals
1. 不自研或引入任何替代性的本地向量数据库（如 LanceDB、Chroma 或 sqlite-vec）或自研本地分词检索。
2. 不破坏性删除公共契约包（`@cc/superai-contracts`、`@cc/core-sdk`、`@cc/plugin-sdk`）中的 domain 导出，避免违反现有 `tests/contracts/architecture-docs.test.ts`。
3. 不破坏 Thread / Workspace / Run / ACP 会话等核心数据模型。

## 4. Behavior & Interfaces
- `GET /api/local/v1/capabilities` 暴露的 `adapters.knowledge` 恒定为 `false`，`adapters.knowledgeProviders` 为 `[]`。
- 前端通过 `useRuntimeFeatureSupport()` 读取 `features.knowledgeModule = false`，自然隐藏 `/knowledge` 路由与侧边栏导航。
- 系统设置页面不再提供外部向量服务的 Base URL 录入。

## 5. Constraints & Compatibility
- 必须通过 `pnpm lint:arch`（Showcase 9 项检查全部通过）。
- 必须满足 CI 六大门禁（`pnpm lint:gates`）：0 循环依赖、0 复制率超标、死代码 <= 171、函数与文件行数合规、复杂度 <= 108。
- 必须满足 `pnpm typecheck` 与 `pnpm test` 100% 通过。

## 6. Acceptance Criteria
- [ ] `packages/knowledge-api/src/ai-vector-provider.ts` 与 `knowledge-ai-vector-plugin.ts` 物理文件已删除。
- [ ] `packages/knowledge-api/src/index.ts` 干净导出 Noop 实现，`noop-provider.test.ts` 单元测试通过。
- [ ] `docs/architecture/system-architecture.json` 移除 `knowledge` 节点及连线，`pnpm lint:arch` 校验通过。
- [ ] `docs/architecture/system-architecture.html` 重新生成并呈现简化后拓扑。
- [ ] 系统设置界面无 "Knowledge base URL" 配置卡片。
- [ ] `tests/electron/plugin-kernel.test.ts` 测试通过并匹配禁用能力快照。
- [ ] `pnpm typecheck`、`pnpm lint:gates` 与 `pnpm test` 全量绿灯。
