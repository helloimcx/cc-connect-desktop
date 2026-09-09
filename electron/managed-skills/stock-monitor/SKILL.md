---
name: stock-monitor
description: 股票行情与量化盯盘自动化技能。支持 A 股、港股、美股实时行情与技术/基本面指标监控（如周线布林带、动态股息率、股债利差 ERP、涨跌幅预警），并提供支持多空博弈辩论、事实履约契约与定时闭环复盘的深度决策工作流。
allowed-tools: Bash(lac monitor:*)
triggers:
  - 股票监控
  - 盯盘
  - 股票提醒
  - 行情预警
  - 布林带
  - 股息率
  - 股债利差
  - stock.quote
  - 多空博弈
  - 深度分析
  - 决策复盘
  - deep-analysis
---

# Stock Monitor (股票行情与量化盯盘技能)

用于为用户配置基于真实行情的股票自动化盯盘、量化指标预警与深度决策分析任务。

## 1. 支持的市场与代码格式

- **美股 (US)**: 标准 Ticker 代码，如 `AAPL`, `NVDA`, `TSLA`, `MSFT`, `BABA`
- **港股 (HK)**: 5 位标准代码，如 `00700` (腾讯控股), `09988` (阿里巴巴), `03690` (美团)
- **A 股 (CN)**: 6 位数字代码或附带交易所前缀，如 `600519` (贵州茅台), `000001` (平安银行), `sh600519`, `sz000001`

---

## 2. 监控指标字典 (Metrics)

### 基础价格与波动指标
- `latestPrice`: 最新成交价格
- `change_percent`: 当日涨跌幅百分比（如 `3.5` 代表 +3.5%，`-2.0` 代表 -2%）
- `abs_change_percent`: 当日涨跌幅绝对值百分比（如 `5.0`）

### 周线布林线指标 (Weekly Bollinger Bands)
基于 20 周均线与 2 倍标准差计算，适合中长线估值与周期波段判断：
- `boll_lower`: 周线布林下轨价格（超跌支撑位）
- `boll_middle`: 周线布林中轨价格（20 周均线）
- `boll_upper`: 周线布林上轨价格（超买压力位）
- `boll_percent_b`: %b 相对位置指标（`0.0` 为触及下轨，`1.0` 为触及上轨，`< 0` 超跌跌破下轨，`> 1` 超买突破上轨）
- `boll_distance_to_lower`: 距周线下轨的百分比距离
- `boll_distance_to_upper`: 距周线上轨的百分比距离
- `boll_signal`: 布林带信号状态（`buy` / `sell` / `hold`）

### 价值与红利估值指标 (Dividend Yield & ERP)
- `dividend_yield`: 动态年化股息率（%）
- `annual_dividend`: 过去 12 个月每股累计分红金额
- `erp_spread`: 股债利差（%）= 股息率 - 10 年期国债收益率（衡量权益资产相对无风险利率的吸引力）
- `dividend_signal`: 股息估值信号（`undervalued` / `fair` / `overvalued`）

---

## 3. 经典量化策略与条件表达式 (Conditions)

| 策略类型 | 条件表达式 (`--condition`) | 策略逻辑说明 |
| :--- | :--- | :--- |
| **周线下轨超跌买点** | `latestPrice <= boll_lower` 或 `boll_percent_b <= 0.05` | 股价回落至周线布林下轨，中长期性价比凸显 |
| **周线上轨止盈卖点** | `latestPrice >= boll_upper` 或 `boll_percent_b >= 0.95` | 股价冲高至周线布林上轨，阶段性超买防范回调 |
| **高红利配置买点** | `dividend_yield >= 5.0` 或 `erp_spread >= 2.5` | 股息率达标或股债利差处于历史高位，适合防御配置 |
| **双重共振策略** | `latestPrice <= boll_lower && dividend_yield >= 4.0` | **技术面（周线下轨）与基本面（高股息）**共振高胜率买点 |
| **大幅异动预警** | `abs_change_percent >= 5.0` | 日内行情波动超过 5% 时触发即时分析 |

---

## 4. 深度决策分析与复盘工作流 (`--workflow deep-analysis`)

当用户需要严谨的投资研判、多空博弈论证与闭环复盘追踪时，指定 `--workflow deep-analysis`。

### 深度工作流核心机制：
1. **数据履约契约 (`[GROUNDED DATA CONTRACT]`)**:
   - 自动绑定触发瞬间的真实行情快照与指标。
   - Agent 必须在多空分析中显式引用真实快照数据，严格禁止虚构、猜测财务数字或现价。
2. **多空博弈辩论 (Bull / Bear Adversarial Debate)**:
   - **Bull Case**: 论述看多催化剂、估值安全边际与业绩驱动。
   - **Bear Case**: 针锋相对地指出多头假设盲区、潜在下行风险与估值泡沫。
   - **Final Adjudication**: 综合裁决，给出明确操作建议（`BUY` / `SELL` / `HOLD` / `WATCH` / `ALERT` / `REDUCE` / `IGNORE`）、置信度百分比、核心论点及关键可证伪假设。
3. **工作区决策日志 (Decision Log)**:
   - 自动持久化至工作区 `.agentdock/decisions/<monitor-id>.md`，形成可审计的历史决策轨迹。
4. **闭环定时复盘 (Scheduled Retrospective Loop)**:
   - 自动于指定延迟时间后（默认 `--retro-delay 24h`）在侧边线程自动触发定向复盘。
   - 对比最新行情与当时判定，评估准确度（`correct` / `incorrect` / `neutral`），提炼经验教训并自动注入后续触发分析。

---

## 5. CLI 命令操作规范 (使用 Bash 工具)

### 创建股票监控任务
```bash
# 基础即时提醒监控
lac monitor add \
  --title "<任务简短标题>" \
  --source stock.quote \
  --symbol "<标的代码>" \
  --condition "<条件表达式>" \
  --message "<触发时发给 Agent 执行的 Prompt>" \
  --cooldown 15m \
  --execution-mode side-thread

# 深度决策分析监控（多空博弈 + 决策归档 + 24小时自动复盘）
lac monitor add \
  --title "<标的> 多空深度决策盯盘" \
  --source stock.quote \
  --symbol "<标的代码>" \
  --condition "<条件表达式>" \
  --message "请结合当前触发指标，对该标的进行深度多空分析并给出建议" \
  --workflow deep-analysis \
  --retro-delay 24h \
  --cooldown 30m \
  --execution-mode side-thread
```
> **最佳实践**：
> - 推荐使用 `--execution-mode side-thread`，触发分析时在后台侧边线程执行，不打扰主对话。
> - 涉及重要买卖点研判时，优先推荐 `--workflow deep-analysis`。
> - 推荐指定 `--cooldown 15m`（或 `30m`、`1h`），避免同一天内行情在临界点反复震荡造成消息风暴。

### 查看与管理监控任务
```bash
# 列出当前所有监控任务
lac monitor list

# 查看单条监控详情（包含工作流模式与复盘周期）
lac monitor info <monitor-id>

# 查看历史决策日志与复盘结果
lac monitor decisions <monitor-id>
lac monitor decisions <monitor-id> --json

# 手动立即试运行一次
lac monitor run <monitor-id>

# 编辑监控条件、工作流或 Prompt
lac monitor edit <monitor-id> [--title "<新标题>"] [--condition "<新条件>"] [--workflow deep-analysis] [--retro-delay 48h]

# 删除监控任务
lac monitor del <monitor-id>
```

---

## 6. Agent 交互引导 SOP

当用户提出股票盯盘相关需求时，请按以下步骤主动引导：
1. **明确标的**：若用户未指定完整代码（如“帮我盯腾讯”），主动确认代码为 `00700`。
2. **推荐适配策略**：根据标的属性（科技成长股推荐“周线布林超跌买点/上轨止盈”，红利高股息股推荐“股息率/双重共振”），主动给出 2~3 个精选条件表达式供用户选择。
3. **推荐深度决策工作流**：若用户意图偏向“买卖决策”、“仓位调整”或“深度研判”，主动建议启用 `--workflow deep-analysis` 及 `--retro-delay 24h`，获得多空博弈报告及次日闭环复盘。
4. **一键自动化创建**：用户确认后，直接调用 `lac monitor add` 创建监控，并向用户展示创建结果（Monitor ID、监控标的、触发条件、工作流模式及冷却时间）。
5. **决策查询与回顾**：当用户询问某标的历史表现或复盘时，使用 `lac monitor decisions <id>` 调取历史决策与复盘心得。

