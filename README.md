# AgentDock

基于 Local AI Core 的本地桌面 AI 工作台，内置原生 Feishu/Lark 网关与本地 ACP 会话运行时。

## 运行模式

- **桌面模式** — Electron 作为壳进程启动本地 Local AI Core，并加载桌面 UI
- **Local AI Core 模式** — 通过本地 `127.0.0.1:9831` 提供 runtime、chat、知识库与 Lark 网关能力

## 技术栈

React 19 · Electron 35 · Vite · TypeScript · Tailwind CSS · Zustand · i18next · react-markdown

## 系统架构

AgentDock 由 Electron 桌面壳、React/Web 渲染入口、Local AI Core、OpenSandbox 云端运行层和外部 Agent API 组成。Electron 只负责桌面生命周期、窗口和本地 core 启动；React/Web 通过 Core SDK 访问 Local AI Core；Local AI Core 统一管理 workspace、thread、run、ACP 流式事件、channel 网关、定时调度、sandbox 启动与外部系统映射。云端 sandbox 模式通过 OpenSandbox 创建隔离容器，容器内 agent runtime 通过 HTTP NDJSON ACP bridge 与 Local AI Core 通信。外部系统可通过 `/api/local/v1/external/*` 创建或复用项目、发起 agent run，并通过 per-run SSE 订阅过程。

<!-- project-setup:architecture-diagram:start -->
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/system-architecture.dark.png">
    <img alt="AgentDock 系统架构图" src="docs/architecture/system-architecture.light.png" width="100%">
  </picture>
</p>

> 💡 **交互式架构图**：可在浏览器中直接打开 [docs/architecture/system-architecture.html](docs/architecture/system-architecture.html)，体验深浅色切换、分步引导导览（01 桌面通信 / 02 会话与沙箱 / 03 调度与渠道）、节点高亮与路径追踪。
> 
> 架构事实与规范参见 [架构事实](docs/architecture.md) · [架构全景矩阵](docs/architecture/overview.md) · [架构变更历史](docs/architecture/changes/)。
<!-- project-setup:architecture-diagram:end -->

后台关键模块说明：

- [架构总览](docs/architecture/overview.md)
- [云端 Sandbox 与外部 Agent API](docs/architecture/cloud-sandbox-and-external-api.md)
- [Local AI Core Kernel 与插件装配](docs/architecture/local-core-kernel.md)
- [Workspace Router 路由层](docs/architecture/workspace-router.md)
- [ACP 会话运行时](docs/architecture/acp-protocol.md)
- [Channel Gateway 通道网关](docs/architecture/channel-gateways.md)
- [Scheduler 定时投递](docs/architecture/scheduled-delivery.md)
- [Conditional Automation 条件自动化](docs/architecture/conditional-automation.md)
- [Knowledge Runtime 知识库运行时](docs/architecture/knowledge-runtime.md)

## New

### 2026-09-06

- **事件触发型监控深度决策工作流（Issue #112）**：
  - **严格事实履约契约 (`[GROUNDED DATA CONTRACT]`)**：事件触发 Agent 研判时自动绑定行情快照与技术指标，强制多空分析引用真实快照数据，严格杜绝虚构价格与财务指标。
  - **单会话多空博弈辩论 (`deep-analysis`)**：在单 ACP 会话内引导 Agent 展开多头论据 (Bull Case)、空头质疑 (Bear Case) 与综合判定 (Final Adjudication)，输出规范化操作建议、置信度、核心逻辑与可证伪假设。
  - **工作区可证伪决策日志与定时闭环复盘**：自动将决策归档至 `<workspace>/.agentdock/decisions/<monitor-id>.md`；在 T+1（默认 24h，可配置 `--retro-delay`）自动发起定向轻量复盘，对比实际行情验证判定准确度，提炼反思心得并自动反哺后续触发分析。
  - **CLI、技能与 UI 统一支持**：`lac monitor add/edit` 支持 `--workflow direct|deep-analysis` 与 `--retro-delay <hours>`；新增 `lac monitor decisions <id>` 命令行查询；更新 `stock-monitor` 技能与前端自动化监控看板。

### 2026-09-05

- 开放式 Monitor 事件总线与 Inbound Webhook 触发器支持（Issue #102）：
  - **Inbound Webhook 接入网关**：在 Local AI Core 新增 `POST /api/local/v1/automation/hooks/:hookId` 端点，支持通过 HTTP 接收外部系统（CI/CD、GitHub、告警中心等）推送的离散事件，并支持 Bearer Token、`X-Hook-Token` 请求头与 Query 参数鉴权。
  - **离散事件语义与通用条件匹配**：支持 `always` 无条件触发与属性匹配表达式（如 `event == "deploy"` 或 `status == "failed"`）；对 Webhook 事件绕过传统轮询的上升沿去重，确保离散事件按需执行，同时完整保留 `cooldownMs` 防雪崩冷却保护。
  - **CLI 与 UI 完整支持**：`lac monitor add --source webhook` 支持自动生成加密安全的 Hook ID 与 Token 并输出直接可用的 curl 调用命令；桌面端自动化监控列表支持 Webhook 监控创建、编辑与一键复制触发命令。
- **下线向量数据库引擎模块并简化系统架构**：
  - **剥离外部向量数据库服务依赖**：彻底移除对外部 `ai_vector` (Qdrant) 服务的网络适配层与分块检索逻辑，删除 500+ 行非核心代码，系统设置中不再要求配置外部向量服务连接。
  - **Local Core 架构自治降维**：知识库插件与运行时收敛为内置轻量 Noop 兜底，系统能力快照明确声明 `knowledge: false`，通过动态能力守卫自然隐藏知识库交互入口，系统架构全景图与拓扑移除独立向量数据库节点。

### 2026-09-03

- 发布 AgentDock 0.1.81：定时任务与渠道会话 LLM Provider 动态继承与会话指纹隔离：
  - **Workspace + Channel Provider 层次继承模型**：定时任务与渠道消息严格跟随当前工作区与渠道绑定的 Provider 配置；支持渠道级独立覆写（`preferred_provider_id`），未单独覆写时严格继承工作区默认配置，确保提供商切换实时生效。
  - **Session 强指纹防污染**：ACP 会话管理器建立模型提供商启动指纹（`buildSessionProviderKey`）；当提供商凭证、Base URL 或 Model 变更时，自动失效并拒绝载入旧 Session，避免跨提供商旧端点残留导致的 401 认证异常。
  - **渠道交互式 `/provider` 指令**：支持在飞书/微信等渠道直接使用 `/provider current`、`/provider list`、`/provider use <id>` 与 `/provider reset` 进行渠道级 Provider 查询、切换与重置。

### 2026-09-01

- 确定性技能路由层与外部工具可用性索引（Issue #122）：
  - **确定性技能路由引擎（Skill Router）**：在 Local AI Core 内置高性能规则意图打分引擎，支持在工作区级集中规则中配置正则模式（`patterns`）、关键词（`keywords`）、否定排他规则（`negativePatterns`）、连词组约束（`requiredGroups`）与优先级（`priority`），杜绝全量提示词膨胀与模型玄学猜测。第三方 Skill frontmatter 元数据（triggers/domains/keywords 等）仅按字面量参与匹配，不作为正则编译，避免提示词注入与 ReDoS 风险。
  - **宿主机外部工具可用性探测（Tool-Index）**：在技能执行前自动探测宿主机 PATH 中的可执行依赖（`requires-tools`），检测结果带缓存与平台兼容；若工具缺失则标记状态并输出指引，防止 Agent 产生幻觉调用。
  - **消息装配策略解耦与全量 CI 回归守护**：重构 `agent-message-policy`，支持命中的多技能动态装配，兼容既有行为（否定式查询不再注入股票技能内容）；配套 19 个典型问答场景（中英文、否定式、复合任务、工具依赖等）的回归测试套件进入持续集成门禁。
  - **REST API 与 UI 路由调试器**：新增 `/skills/route` API 与 Core SDK `skills.route()` 支持；在 Skills 页面新增「路由调试」可视化弹窗，支持实时输入提示词测试技能命中、规则匹配得分与外部工具就绪状态。

### 2026-08-30

- **支持 Agent 产物表面（Artifact Surface）与安全沙箱预览（Issue #114）**：
  - **产物自动发现与登记**：ACP Run 执行收尾时自动扫描工作区 `.agentdock/artifacts/<runId>` 目录，自动识别工件类型（HTML / Markdown / Image / Diff / Code）并持久化至任务的 `artifacts_json`。
  - **安全读取与服务 API**：新增 `/api/local/v1/tasks/:taskId/artifacts` 及 `/api/local/v1/tasks/:taskId/artifacts/:artifactId/content` 端点，读取严格限定在工作区与用户数据目录的 `.agentdock/artifacts` 根内（realpath 解析防符号链接穿越），并带 10MB 大小上限与 403/404/413 语义化错误。
  - **多模态沙箱预览与界面联动**：新增 `ArtifactViewerDrawer` 与 `ArtifactViewer` 组件，提供具有安全隔离能力（`sandbox="allow-scripts"` 禁 same-origin，注入 CSP 禁外联）的自包含 HTML 架构图预览、富文本 Markdown、语法高亮 Diff、图片与代码查看器，并在 ThreadChat 会话顶部状态栏与 Run Trace 轨迹图中无缝联动展示。

### 2026-08-28

- 事件监控支持 cron 时间窗（Issue #115 Phase 1）：
  - **定时评估窗口**：`lac monitor add/edit` 新增 `--cron "<expr>"` 与 `--timezone <tz>`（默认 `Asia/Shanghai`），监控仅在匹配的时间窗内轮询评估（如每交易日 11 点检查、`edit --cron off` 清除窗口），窗口外不再空转轮询，降低行情源限流风险。
  - **向后兼容**：未配置时间窗的监控保持 24×7 轮询行为不变；`monitor info` 输出新增 Schedule 行；交易日历门控留待后续阶段。

### 2026-08-27

- 发布 AgentDock 0.1.80：内置股票与量化盯盘 Skill (`stock-monitor`)：
  - **内置专业盯盘技能**：在 `electron/managed-skills/stock-monitor/` 内置标准化技能定义，支持 A股、港股、美股行情标准化解析，提供周线布林带（`boll_lower`/`boll_upper`/`boll_percent_b`）、动态股息率（`dividend_yield`）、股债利差（`erp_spread`）等量化指标字典与策略模板。
  - **语义识别与动态注入**：在 `agent-message-policy` 中集成智能意图识别（`isStockMonitorRequest`），当用户询问盯盘能力或配置行情监控时自动注入该 Skill，提供流畅的交互引导与一键创建命令。

### 2026-08-23

- 模型提供商多模型配置与工作区模型级联下拉支持：
  - **服务商多模型管理**：在全局「AI 服务商」配置中支持为每个提供商添加并配置多个具体模型（模型 ID、可选别名、Token 输入/输出单价），并可设置任意模型为默认模型；预设模版（OpenAI、DeepSeek、Anthropic、OpenRouter、Minimax、Ollama）自带常用模型清单与实时单价预设。
  - **工作区级联下拉选择**：在项目配置的「AI 服务商」选择面板中，根据所选服务商自动联动展示模型下拉菜单（包含默认模型、已配置模型列表及自定义模型输入），切换服务商即时刷新候选模型，并保留自定义模型覆盖能力。
- 技能供应链安全扫描闸门（Issue #93）：
  - **T01-T09 全规则静态安全扫描引擎**：在 Local AI Core 内置高性能规则引擎，零外部重型依赖，覆盖指令劫持（T01）、记忆投毒（T02）、远程载荷下载执行（T03）、内嵌恶意代码与反弹 Shell（T04）、提权与敏感凭据窃取（T05）、系统持久化注入（T06）、工具链劫持（T07）、不安全依赖（T08）以及不安全编码与明文凭证（T09）共 9 大类风险。
  - **Fail-Closed 安装与更新闸门**：在 `lac skill add`、UI 技能安装与更新时，在 Staging 暂存目录自动执行全量静态分析；命中高危/严重风险默认拦截并输出违规证据，支持 `--force` 显式确认放行。
  - **CLI 与 API 审计支持**：新增 `lac skill scan [<name>] [--all] [--json]` 命令与 `/skills/scan` REST API 接口，支持对单个或全量已安装技能执行安全审计。
  - **技能中心安全状态与体检 UI**：在 Skills 页面新增「安全体检 (Security Scan)」全局扫描操作，在技能卡片与详情弹窗中直观展示安全合规徽标（Clean / Warning / Danger）及详细违规报告。

### 2026-08-22

- 工作区级 MCP Server 注册表（Issue #98，Phase 1）：在工作区设置的「MCP」标签页统一配置 MCP servers（stdio `command`/`args` 或 http/sse `url`，支持启用开关），Local AI Core 会在 ACP `session/new` / `session/load` 时通过协议原生的 `mcpServers` 字段下发给本工作区的所有 agent 会话——一次配置全局生效，无需再为每个 agent CLI 单独维护 MCP 配置。修改 MCP 列表会自动重建 ACP 会话以应用新配置；未配置时行为与此前完全一致。

### 2026-08-21

- 统一技能分发层与生态目录互操作（Issue #91）：
  - **统一 CLI 技能分发**：提供 `lac skill add <owner/repo>[@ref] [--scope user|workspace]`、`list`、`update <name|all> [--force]`、`remove <name>`、`verify` 命令，支持单技能与 monorepo 多技能包安装。
  - **.agents/ 根目录与生态互操作**：原生支持项目根目录 `.agents/` 与 `.agents/skills/` 技能扫描与加载，遵循 `.agentdock/skills/` > `.agents/skills/` > `.agents/` > `~/.agentdock/skills/` > `builtin` 的优先级继承与同名覆盖链条。
  - **来源追踪与自演进指纹保护**：在 SQLite 中内置 `skill_sources` 表追踪来源仓库与 commit/ref，安装时生成全量内容 SHA-256 指纹；在更新或验证时检测本地修改状态（`locally-modified`），默认保护本地自演进（#64）成果不被意外覆盖（支持 `--force` 强制覆盖）。
  - **技能中心发现与推荐 UI**：在 Skills 页面新增「发现与推荐 (Browse)」标签页，内置 Matt Pocock、Superpowers、Anthropic、Obsidian 等高星精选技能包的一键安装；在已安装列表中展示来源徽标与本地修改/丢失状态，并支持一键指纹校验与更新。
- 支持 Token 成本跟踪与预算硬阻断治理（Issue #66）：
  - **用量与费用多维度归集**：在 Local AI Core 内置 `cost_events` 实时流水与价格计算引擎，按模型/渠道/Agent/触发源（手动、Cron、Monitor、External 等）精确核算 Token 花费，支持主流模型预设费率与服务商自定义单价。
  - **预算硬约束与 Preflight 拦截**：支持日/周/月周期及全局/工作区/Agent/自动化作用域预算策略；在触发源执行前进行预算预检（Preflight Check），超额自动阻断无监督任务（`alert_and_skip`）或强杀运行（`alert_and_kill`），并广播 `budget.limit.exceeded` 领域事件。
  - **成本看板与 Trace 关联**：新增 `/costs` 成本治理大盘，展示今日/本周/本月费用、多维度开销占比、策略健康度与 Top 昂贵运行列表，支持从高花费记录一键跳转到 Trace Gantt 甘特图下钻诊断。

### 2026-08-20

- 修复权限卡片「始终允许」不生效的问题：Local AI Core 现按线程（thread）记住用户选择的 "allow all"，即使 ACP agent 会话因空闲超时、按轮次隔离或配置变更而重建，后续 `session/request_permission` 也会自动放行、不再重复弹确认卡。该记忆覆盖本线程的全部工具（线程生命周期内有效，重启 Local AI Core 后失效）；回复 `deny` / `拒绝` / `撤销` 即可撤销（授权时会收到提示），删除线程也会一并清理。对所有渠道（飞书/微信/Desktop/Web）与所有 ACP agent 生效。

### 2026-08-17

- 扩展股票行情监控插件（`stock.quote`）：原生支持**周线布林线（Weekly Bollinger Bands）**与**动态股息率/股债利差（Dividend Yield & ERP Spread）**监控，提供中轨 (`boll_middle`)、上轨 (`boll_upper`)、下轨 (`boll_lower`)、相对位置百分比 (`boll_percent_b`)、买卖信号 (`boll_signal`)、股息率 (`dividend_yield`)、每股分红 (`annual_dividend`) 与股债利差 (`erp_spread`)；条件引擎支持指标动态比对与双重共振策略（如 `latestPrice <= boll_lower && dividend_yield >= 4.0` 周线下轨+高股息共振买点），并在 Monitor UI 中内置红利与周线交易策略预设。

### 2026-08-15

- CI 建立完整质量门禁链：`.github/workflows/ci.yml` 拆分为 lint / test / coverage 三个 job，五个 lint 指标（circular / duplicate / dead-code / file-size / function-length）从"仅报告"升级为可失败门禁（`pnpm lint:gates`），ESLint 以 `--max-warnings 108` 基线把关新增告警，覆盖率以 `.c8rc.json` 的 `check-coverage` 阈值（lines/statements 68、functions 72、branches 66）把关。配套新增 `knip.json`（声明入口提升死代码检测准确性）、拆分 `automation-service.ts` 尾部工具函数到 `automation-event-utils.ts`（文件降至 1000 行内）、提取 security-store 列表查询与 Knowledge 通知横幅的重复代码。

### 2026-08-14

- 配置存储彻底迁移到 SQLite：移除 config.toml 及全部文件兼容层（legacy 导入、settings configPath、内嵌 provider 迁移、registry 备份/合并舞步），`runtime_config` 表成为工作区配置的唯一事实来源，`workspace_registry` 降级为派生镜像。
- 修复定时任务绑定旧 agent runtime 的问题：side-thread 定时任务（Automation/Monitor）复用时校验线程 agent 类型与工作区当前 agent 是否一致，不一致时自动在新 agent 下重建会话线程，任务随工作区 agent 切换自愈。
- 技能中心页面新增「安装 Obsidian 技能包」按钮：一键从 `kepano/obsidian-skills` 克隆并导入 5 个官方维护的 Obsidian 技能（obsidian-markdown、obsidian-bases、json-canvas、obsidian-cli、defuddle）到用户级目录，并通过既有的 skill-mounter 自动挂载到 Claude Code / Codex / opencode / Hermes / Pi 的原生 skills 目录（Issue #72 首批切片）。
- 修复飞书扫码新增机器人后 App ID/Secret 为空的问题：扫码前不再向配置落库空凭据实例（QR 注册接口支持临时实例，凭据确认后才写入配置），轮询改为弹窗关闭后后台继续、出错自动退避重试而非静默停止，并为 QR 注册/轮询全过程补充网关日志便于回溯。
- 修复 Local AI Core 因 `database is locked` 崩溃导致服务不可用的问题：所有 SQLite 存储启用 WAL + `busy_timeout`（写冲突等待而非立即抛错），ACP 传输层对单条事件处理错误做隔离（不再整进程退出），`agentdock serve` 监督 Core 子进程、意外退出时交由 systemd 自动拉起。

### 2026-08-13

- 发布 AgentDock 0.1.74：支持 per-run ACP Trace 轨迹与 Gantt 时间线视图（Issue #63），持久化 `run_spans` 节点树（thought, plan, tool_call, model_call）与 Token 用量，通过 `AcpTraceProjector` 实时投影 ACP 流式事件，并在对话 Header 与 Automations 运行记录中提供全新的 `RunTimelineDrawer` 轨迹甘特图与 JSON 载荷查看器。

### 2026-08-11

- 发布 AgentDock 0.1.73：正式支持 open Agent Skills (SKILL.md) 开放标准与多源技能目录（Builtin、User 全局、Workspace 项目级），在主侧边栏新增独立的技能中心页面 (`/skills`)，支持在线管理、编辑 SKILL.md 与 Git/URL 仓库一键安装，并在 ACP 进程启动时自动挂载/软链激活 Skill 到 Agent 原生 skills 目录。

### 2026-08-08

- 发布 AgentDock 0.1.72：通过独立 `HERMES_HOME` 目录 (`<baseDir>/hermes-homes/<workspaceId>/config.yaml`) 将工作区配置的模型 Provider (base_url, api_key, model) 注入 Hermes ACP 子进程，彻底解决修改工作区服务商对 Hermes 无效的问题。
- 发布 AgentDock 0.1.71：修复工作区 Provider 配置保存后由于 `runtime_config` 缺失 `projects` 导致重新加载恢复旧版 `config.toml` 的问题；扩展 Hermes ACP agent 启动配置，自动注入对应的模型 Provider 环境变量 (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `HERMES_MODEL` 等)。


### 2026-08-16

- 发布 AgentDock 0.1.71：将定时任务（Scheduler / Automation）的归属升级为 Workspace + Channel 联合作用域；支持在 IM 渠道对话内自动按当前群聊隔离任务查询；CLI `lac scheduler add / list` 支持显式 `--platform`、`--channel` 与 `--all-channels`；桌面端 UI 新增渠道选择与多渠道标签过滤。

### 2026-08-05

- 发布 AgentDock 0.1.70：把模型 Provider (服务商) 的全局配置与工作区配置彻底解耦，新增独立的 AI 服务商管理页面 (`/providers`) 与侧边栏导航，简化工作区项目设置中的服务商绑定关联。

### 2026-07-29

- 发布 AgentDock 0.1.69：支持股票行情 Monitor Provider (`stock.quote`) 真实线上行情数据拉取，原生支持美股、A股、港股股票代码标准化解析与双通道行情 API 抓取（支持 GBK/UTF-8 字符解码）；集成显式 Mock 模式与网络异常降级防护。

### 2026-07-28

- 发布 AgentDock 0.1.68：彻底消除 ACP Store 与 Agent Registry 间的循环依赖；完成全项目圈复杂度 (Cyclomatic Complexity) 专项重构，优化 Top 10 高复杂度函数（最高复杂度从 76 降至 39）；降低重复代码率至 4.77%；建立强制 Pre-Commit 全套质量校验流程。

### 2026-07-19

- 发布 AgentDock 0.1.67：统一 Scheduler、Automation 与 Monitor 的后台 Agent 执行超时为 1 小时；超时后会中断对应 ACP run，并避免误取消同一会话中已开始的新任务。

### 2026-07-17

- 发布 AgentDock 0.1.66；当时的发布说明将 Automation 超时标记为已延长至 1 小时，但执行代码仍保留 15 分钟默认值，实际修复见 2026-07-19。

### 2026-07-15

- 定时任务（cron）现在使用服务器本地时区解释表达式——`0 1 * * *` 会在本地凌晨 1 点触发，而不是 UTC。支持任意 IANA 时区（如 `Asia/Shanghai`、`America/New_York`），并正确处理 DST 夏令时跳变。

### 2026-07-13

- 条件自动化现已统一 Scheduler 与 Monitor 的 Activation、Condition、Action 和 Delivery 边界，并提供逐项 macOS/Linux Sandbox 部署诊断、Linux 镜像依赖及 Ubuntu 24.04+ 专用 AppArmor 安全配置指引；Windows 脚本执行保持 fail-closed。

### 2026-07-12

- Approved automation scripts now use a strict JSON condition protocol with environment-only secret injection, bounded streaming output, and fail-closed approval/interpreter checks.
- Agents can now author condition-trigger Automations through managed LAC commands and a staged, two-approval sandbox workflow.

### 2026-07-08

- Automation script packages are staged immutably with manifest-declared permissions, limits, and package-hash validation before approval workflows use them.

### 2026-07-10

- Approved automation scripts now run through a fail-closed macOS/Linux Sandbox Runtime adapter with Windows capability diagnostics and temp-only filesystem policy.

### 2026-06-21

- 桌面端统一通过 Core SDK 访问 Local AI Core，移除旧登录、项目、会话和 renderer API 双轨实现。
- Workspace Registry 成为项目配置权威数据源，并使用不随显示名称变化的稳定 workspace ID。
- Local AI Core HTTP API 增加统一请求校验与 400 错误语义；Agent 工具策略和知识库上下文统一由 Core 注入。
- 简化插件 capability/runtime 装配，拆分 bridge event stream 与知识库 domain contracts，并将类型检查纳入测试门禁。

### 2026-06-20

- 发布 AgentDock 0.1.56。
- 将 ACP `session/prompt` 超时从 15 分钟提高到 180 分钟，避免长任务（如凌晨定时归档）在 Agent 仍在流式输出时被硬切断。
- 修复 LocalCoreError 日志泄漏 `[object Object]` 的问题：`LocalCoreError` 构造器、`toLocalCoreErrorInfo`、`formatLogError` 三处入口都对 message 做了字符串化兜底，后续报错能记录到真实文本。

### 2026-06-19

- Lark/Feishu 与微信 channel 共用流式 inbound 附件存储接口，统一执行安全命名、大小限制、临时文件清理和原子落盘；微信文件下载改为流式 AES 解密，图片同时保留 Agent 可访问的落盘 URI（如适用）与多模态 Base64 数据。
- 发布 AgentDock 0.1.55。
- Lark/Feishu 收到的普通文件改为流式下载到工作区 `.agentdock/channel-uploads/lark/<instanceId>/`，并以本地路径传给 Agent，避免整文件读入内存并转换为 Base64；可通过平台选项 `downloads_dir` 覆盖目录。

### 2026-06-15

- Local AI Core 项目配置迁移到 `runtime/local-core.db` 的 SQLite 持久化存储；旧 TOML 仅在迁移期被导入一次，后续不再回写。自 2026-08-14 起 config.toml 及其导入逻辑已彻底移除，SQLite 为唯一配置来源。

### 2026-06-14

- 聊天输入框下方新增权限模式选择器，可在请求批准和完全访问之间切换，并随当前线程保存。
- 在 channel（Lark/Feishu/WeChat）里执行 `/agent use` 切换 Agent 时，选择会持久化到频道级偏好；后续 `/new` 创建新会话或重启后，新线程会自动继承该偏好。
- 修复定时任务（side-thread 模式）在创建调度线程时忽略频道级 Agent 偏好、总是回退到 workspace 默认 Agent 的问题；现在调度线程也按频道偏好选择 Agent，未设置时仍回退到 workspace 默认。
- 修复 `lac scheduler edit <id> --cron "..."` 只改 cron 时会清空定时任务 message/description 的问题。

### 2026-05-24

- 重构 Local AI Core 控制器：提取 ChannelService 与 ExternalService 为独立领域服务，Controller 缩至约 20 个方法，只保留生命周期、配置和事件编排。
- 拆分 Server 路由：102 路 switch 替换为 Map-based handler 调度，按 domain 提取为 14 个独立 handler 模块（runtime、runtimes、thread、workspace、security、task、scheduler、automation、knowledge、capabilities、provider、channel、external、openai），server.ts 从 1518 行缩减至 396 行。
- 修复 lac-cli 与 knowledge-skill-script 测试在沙箱环境下的兼容性：用全局 fetch mock 替代 TCP server.listen，EPERM 时优雅跳过。

### 2026-05-16

- 优化桌面与 Web 聊天界面视觉层级：统一会话列表、消息气泡、工具结果卡片和输入区样式，降低装饰噪音，提升长对话可读性。
- 统一工作区、概览、知识库、自动化、系统诊断、项目与会话列表页面的轻量面板、列表行、状态摘要和操作按钮样式。

### 2026-05-15

- 删除旧的 sandbox WebSocket proxy 兼容路径，云端 sandbox ACP 通信统一走 HTTP NDJSON bridge。
- 云端模式默认按 thread 复用 sandbox/ACP session，并增加 idle TTL 与阶段耗时日志，降低连续对话的首 token 延迟。
- 新增外部系统 API，可按 `user_id` 创建/复用项目、发起 agent run，并通过 per-run SSE 订阅回答过程；compose 模式下外部 workspace 默认持久化到 `AGENTDOCK_EXTERNAL_WORKSPACE_ROOT`。
- 新增 OpenAI Chat Completions 兼容入口 `/api/local/v1/openai/chat/completions`，通过 `metadata.user_id/project_id/thread_id` 映射外部身份，统一在 sandbox + yolo 模式下运行，并以 OpenAI chunk + `agentdock` 扩展字段流式返回思考、规划和工具进度。

### 2026-05-14

- Docker Compose 支持一键启动 AgentDock Web、Local AI Core 和 OpenSandbox，Core 容器默认通过 compose 内网访问 OpenSandbox。
- 工作区“云端模式”改为选择 Deployment Profile，项目只保存 Sandbox Provider / Runtime Image 引用、state scope 和资源覆盖项。
- Sandbox 模式下工作区路径作为 OpenSandbox host mount 使用，Core 启动代理不再要求该路径在 Core 容器内可见。
- 新增部署诊断接口与 `pnpm e2e:compose`，用于检查 Web/Core/OpenSandbox/Docker socket/工作区挂载和 sandbox 镜像注册。
- Docker Compose 云端模式支持通过 `AGENTDOCK_SANDBOX_STATE_HOST_ROOT` 将 agent state 持久化到 OpenSandbox 可挂载的宿主机路径。
- Sandbox 镜像改为通用 HTTP NDJSON ACP bridge：容器 HTTP 接口只转发标准 ACP JSON-RPC，和具体 agent runtime 解耦。
- 云端模式新增 execution 元数据、user/project/thread/run state scope、配置迁移和 Pi provider 规范化，便于多用户云端部署与运行排障。
- Provider 从工作区配置中独立为共享模块，工作区现在选择 provider，并支持旧项目内嵌 provider 自动迁移。

### 2026-05-12

- 新增 OpenSandbox 沙箱运行基础：提供 `docker-compose.yaml` 手动启动 OpenSandbox server，项目可开启 sandbox 模式后通过一次性容器运行 agent ACP server，并为 Pi sandbox 预留按用户/项目/Agent 持久化的 runtime state 挂载。
- 发布 AgentDock 0.1.44。
- 本地线程与 Lark/微信通道支持 `/help` 查看命令清单，支持 `/stop` 停止当前正在运行的任务。
- Local AI Core 新增结构化错误模型，ACP runtime 与微信通道会把启动失败、会话过期等问题回写为可诊断状态，并提供 diagnostics 错误摘要与 doctor 自检接口。
- 拆分超大测试文件，按 Local Core 路由、ACP 进度、Lark/Weixin channel gateway 等边界组织集成测试。

### 2026-05-11

- 发布 AgentDock 0.1.43。
- Lark channel 支持群聊 @ 机器人触发，默认忽略未 @ 的群消息，并在转发给 Agent 前清理机器人 mention、保留其他被 @ 用户名。
- 新增事件监控任务框架与 `lac monitor` 子命令，支持通过对话创建股票价格监控，触发后在 side-thread 分析并把过程回传到 channel。
- Lark、微信和桌面会话新增 `/new`、`/list`、`/switch`、`/history`、`/name`、`/search`、`/del` 会话命令；Lark 可通过会话卡片按钮切换和删除。
- 会话命令执行路径改为 effects 模型，并抽出 channel 共享 runtime；桌面 `/new`、`/switch` 现在会跟随激活目标会话。
- 发布 AgentDock 0.1.42。
- 线程级 `/mode` 与 `/agent` 命令处理抽取为独立 command service，ACP backend 只负责消息落库、bridge 回复和运行时调度，后续扩展 `/model`、`/knowledge` 等命令更容易复用。

### 2026-05-09

- 发布 AgentDock 0.1.41。
- 支持在线程内使用 `/agent` 命令查看、切换或重置当前 Agent；Lark、微信、桌面会话走同一条线程级配置路径。
- Lark channel 的 Markdown 表格回复改用 schema 2.0 卡片渲染，避免 Post `md` 消息吞掉表格行；超过飞书卡片表格上限时会自动降级为可见列表文本。
- Lark 文本消息发送新增独立渲染层，统一记录 `msgType`、渲染原因和表格数量，便于排查不同飞书消息格式的显示差异。
- 发布 AgentDock 0.1.40。
- Lark channel 的 Post 消息改用 `md` 元素承载 Markdown，避免工具参数代码块显示为灰底富文本块。
- 发布 AgentDock 0.1.39。
- Lark channel 的普通消息改用富文本 Post 发送，Markdown 与工具参数代码块现在会正常渲染。
- 发布 AgentDock 0.1.38。
- Lark channel 的工具调用和最终回答改为发送普通消息，工具参数直接放在 Markdown 代码块中，避免卡片 Markdown 渲染问题。

### 2026-05-08

- 发布 AgentDock 0.1.37。
- 定时任务的 Lark/微信投递现在会回传执行过程、工具进度和最终回答，并记录 delivery 状态便于排查。
- Lark/微信定时任务开始时会先发送任务标题，方便在 channel 中识别当前正在执行的任务。

### 2026-05-07

- 发布 AgentDock 0.1.36。
- 修复 Lark/微信定时任务在 Local AI Core 启动期提前捕获未初始化 workspace router，导致任务触发后无法发送到会话的问题。
- 发布 AgentDock 0.1.35。
- 发布 AgentDock 0.1.33。
- README 新增系统架构简要介绍与 Mermaid 架构图。
- 新增后台关键模块架构文档索引，并补充 kernel、router、channel gateway、knowledge runtime 与 ACP 流程图。
- Local AI Core 日志统一写入 `~/.agentdock/logs`，按 `sys/info/warn/error/debug` 分级文件记录并按文件大小轮动。

### 2026-05-06

- 新增 Hermes 原生 ACP runtime，可通过 `agent.type = "hermes"` 使用 `hermes acp` 对接本地会话运行时。
- Hermes runtime 默认以 YOLO 权限模式启动，先绕开 Hermes ACP 审批回调兼容问题，避免危险命令审批被提前拒绝。
- LAC 定时任务不再固化线程路由，改为按项目和 channel 投递目标动态解析当前线程，避免切换线程后 same-thread 任务失败。
- 收紧公开仓库前的 CI/CD 安全边界：Release 改为 tag-only，部署目标改由 GitHub Secrets 提供，Actions 依赖固定到 commit SHA。
- 项目采用 PolyForm Noncommercial License 1.0.0；商业使用需单独授权。
### 2026-05-04

- LAC 定时任务创建改由 Local Core 根据当前线程绑定解析 Lark/微信路由，agent 仍可直接使用 `lac scheduler add`，避免飞书创建的任务误落到 local route。
- LAC 定时任务运行默认使用 yolo 权限，自动执行工具调用，避免后台任务卡在权限确认上。

### 2026-05-03

- Lark 回传拆分为独立卡片：思考过程按阶段汇总发送，工具调用只发送一次，最终回答使用本轮独立卡片，避免覆盖旧消息。
- 新增内置 Pi Agent runtime，可通过 `agent.type = "pi"` 使用 bundled Pi coding agent 与 ACP adapter，无需额外安装 Claude Code、Codex 或 opencode。
- 新增 Lark 机器人扫码新建/绑定入口，基于官方 Device Flow 自动创建应用，扫码确认后自动感知、写回 App ID/App Secret，并立即激活到可发送消息状态。
- 支持同一个 workspace 绑定多个 Lark/微信 channel 实例，实例级隔离运行时、扫码绑定和消息路由。
- Lark 扫码创建机器人改用官方 OpenClaw 一键配置入口，默认带上 `card.action.trigger` 卡片回传交互回调，并自动启用卡片按钮处理。
- 优化 channel 工具与权限交互：Lark 工具结果默认隐藏详细输出，权限按钮点击完成后移除可重复点击按钮。
- 新增通用 channel outbound 文件回传能力，支持通过当前或指定 Lark/微信会话发送本地文件。
- LAC 定时任务 ID 改为短 ID 展示与操作，`list/info/edit/del/run` 可直接使用列表中的短 ID。
- 调整 Local AI Core channel 目录结构，将 Lark、微信实现隔离到独立模块，并保留公共文件处理能力。
- app、web、Lark/微信 channel 支持线程级 `/mode` 命令，`/mode yolo` 可长期切换为跳过工具权限申请，直到 `/mode default` 恢复。

### 2026-05-02

- 新增通用 channel 图片消息到 ACP 多模态传递。
- 新增 Codex Agent ACP 支持，并接入 runtime 检测与交互权限流程。

## 快速开始

```bash
pnpm install
pnpm dev          # 启动开发环境（Vite + Electron）
pnpm start:core   # 启动已构建的 Local AI Core
```

## Docker Compose

```bash
docker compose up --build
```

默认会启动 AgentDock Web、Local AI Core 和 OpenSandbox：

| 服务 | 地址 |
|---|---|
| AgentDock Web | `http://127.0.0.1:14173` |
| Local AI Core | `http://127.0.0.1:9831/api/local/v1` |
| OpenSandbox | `http://127.0.0.1:8080` |

Compose 模式下 Core 容器通过 `http://opensandbox-server:8080` 访问 OpenSandbox；桌面本地模式仍默认使用 `http://127.0.0.1:8080`。Core 数据默认保存在 Docker volume `agentdock-core-data`。

## macOS 打开应用

如果安装后提示应用无法打开，可先清除隔离属性再启动：

```bash
xattr -cr /Applications/AgentDock.app
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
| `pnpm test` | 运行完整测试套件（单测 + 契约 + 集成 + BDD） |
| `pnpm test:bdd` | 运行 Gherkin 行为测试（`tests/bdd/`） |
| `pnpm lint:complexity` | 圈复杂度报告（信息性，不阻断 CI） |
| `pnpm lint:circular` | 循环依赖报告（强连通分量，信息性，不阻断 CI） |
| `pnpm lint:duplicate` | 重复代码率报告（copy/paste，信息性，不阻断 CI） |

## 环境变量

| 变量 | 说明 |
|---|---|
| `AI_WORKSTATION_USER_DATA_DIR` | 用户数据目录 |
| `AI_WORKSTATION_SMOKE_OUTPUT` | 冒烟测试输出路径 |
| `AI_WORKSTATION_SMOKE_SCENARIO` | 冒烟测试场景 |
| `AI_WORKSTATION_FORCE_RUNTIME_STATUS_ERROR` | 强制触发运行时状态错误，用于测试 |
| `AI_WORKSTATION_DEV_SERVER_URL` | Electron 开发模式连接的前端地址 |
| `OPEN_SANDBOX_API_KEY` | OpenSandbox API key，compose 默认 `agentdock-local` |
| `AGENTDOCK_OPENSANDBOX_SERVER_URL` | OpenSandbox server 地址，容器内默认可设为 `http://opensandbox-server:8080` |
| `AGENTDOCK_LOG_DIR` | 日志目录，默认 `~/.agentdock/logs` |
| `AGENTDOCK_LOG_MAX_BYTES` | 单个日志文件轮动大小，默认 10MB |
| `AGENTDOCK_LOG_MAX_FILES` | 单个日志保留的轮动文件数，默认 5 |

## 项目结构

```
├── electron/        # Electron 主进程壳
├── apps/            # 未来的桌面/Web 前端壳目录
├── packages/        # contracts、core-sdk、knowledge-api
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

## 运维排查

### 日志位置

服务日志统一在 `~/.agentdock/logs/`（可通过 `AGENTDOCK_LOG_DIR` 覆盖），按级别分文件，单文件 10MB 轮动，保留 5 份：

| 文件 | 内容 | 排查时用途 |
|---|---|---|
| `sys.log` | ACP session 生命周期、run 启停、bridge 事件 | 追踪任务执行时间线、确认 run 是否完成 |
| `info.log` | 业务逻辑日志、插件注册、inbound message | 查看 cron 触发、任务投递过程 |
| `error.log` | 错误和异常 | **排查定时任务失败时首先看这里** |
| `warn.log` | 警告（工具调用失败、API 重试等） | 查看非致命性问题 |

轮动后的历史文件按 `.1`、`.2` … 编号，`.1` 是最近的。跨天排查时注意同时检查当前文件和轮转文件。

### 数据库

运行时数据在 `/var/lib/agentdock/runtime/local-core.db`（SQLite）。关键表：

| 表 | 用途 |
|---|---|
| `scheduled_jobs` | cron 定时任务配置（cron 表达式、prompt、启用状态） |
| `scheduled_job_runs` | 定时任务执行记录（触发时间、完成时间、状态） |
| `automations` | 自动化任务配置（含从 scheduled_jobs 迁移过来的） |
| `automation_runs` | 自动化任务执行记录（含超时错误信息） |

> 注意：同一张 cron 任务可能同时存在于 `scheduled_jobs` 和 `automations` 两张表中。7.14 之后的执行走 automation 路径，报错前缀为 `automation action failed`；之前走 scheduler 路径，报错前缀为 `scheduler job failed`。

### 排查定时任务失败的推荐步骤

1. `grep 'scheduler job failed\|automation action failed' ~/.agentdock/logs/error.log` — 确认失败时间和错误类型
2. `grep '<run_id>' ~/.agentdock/logs/sys.log` — 追踪该次执行的完整时间线（prompt sent → completed）
3. `sqlite3 /var/lib/agentdock/runtime/local-core.db "SELECT * FROM automation_runs WHERE id='...'"` — 查看具体错误信息
4. 如果错误含 `Timed out`：任务实际可能仍在运行并最终完成，检查 `sys.log` 中是否有后续的 `prompt completed`

## License

AgentDock is source-available under the [PolyForm Noncommercial License 1.0.0](./LICENSE.md). Commercial use requires a separate commercial license.
