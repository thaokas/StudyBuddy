# 学习记忆系统设计 v2：问答单元、学生画像与学习分析

日期：2026-11-11
状态：关键决策已确认（见 §0），待实施评审；本文不含实现代码。
范围：`plugins/study` 内 `memory` 模块扩展，新增 `learning`、`review` 模块。
前置阅读：`2026-11-08-studybuddy-redesign-design.md` 第 7 节、`docs/decisions/memory.md`。

## 0. 已确认决策

| 项 | 决策 | 影响 |
| --- | --- | --- |
| 学习日边界 | **04:00**（本地时间） | 日窗口、周窗口、摘要归属、日统计口径 |
| 问题保留 | 完整正文 **90 天**；之后只留摘要与结构 | 清理任务、导出、重问检测的降级方案 |
| 画像生效 | 超过阈值**自动生效**，不弹确认 | 去掉审批 UI；改用阈值、变更幅度上限与可纠正性兜底 |
| “为什么这次讲得细” | **不展示** | 注入只带结论；证据仅内部审计与记忆面板可查 |
| 周报位置 | **周页**（`outcomes` 的 week 模式） | 复用现有页面与周期切换，新增一张分析卡 |
| 复盘拆分 | 后续把 `followup` 拆成“提醒”和“总结复盘”；周报/月报/晚间复盘都归后者 | 本次新建 `review` 命名空间只承载报告，晚间复盘暂留 `followup` |
| 记忆单元 | 不是“每条消息”，而是**问答单元**：一次问答可含 1–3 道关联题目 | 新增 `study_episode` 与 `study_episode_problem`，会话需重新组织 |

## 1. 需求与验收

| 编号 | 需求 | 验收标准 |
| --- | --- | --- |
| R1 | 画像逐渐形成，并据此调整讲法 | 同一题两次讲解的详细度差异可由画像参数解释；学生可查看/纠正画像 |
| R2 | 90 天内完整记录问答；窗口之间总结提炼 | 学习类回合捕获率 ≥99%；每个回合属于唯一问答单元或明确标为非学习；摘要结论可回溯 |
| R3 | 分析学习方法、薄弱点并帮助改善 | 报告数字全部来自工具；结论 100% 带引用；不出现能力/心理诊断 |
| R4 | 周报在周页 | 周页可看到本周分析卡；无模型时显示规则版 |

**失败模式与对策**（沿用 v1，新增两条）：

| 失败 | 对策 |
| --- | --- |
| 把“一条消息”当“一次提问”，记忆碎片化 | 问答单元切分 + 用户可合并/拆分 |
| 两个无关问题被塞进一个单元 | 主题/材料/时间/边界词打分；模糊边界在窗口关闭时复核 |
| 标签固化、自我实现 | 主题级覆盖、置信度门槛、半衰、低详细度探针 |
| 摘要漂移 | 严格 JSON + 数字校验 + 可从 L0 重建 + 证据引用 |
| 假完整 | 会话消息数对账 + 缺口报告 |
| 分析越界 | 样本门槛 + 三态区分（未接触/薄弱/遗忘）+ 反证 |

## 2. 与既有设计的关系

**继承**：业务事实以 `study` 为权威；记忆带来源与时间；删除留墓碑；写操作经 `ctx.study`（`requestId` + revision + `change_log`）；首版不引向量库/图数据库/第二个记忆插件。

**修订**（确认后落一条新 ADR）：

| 既有结论 | 修订 |
| --- | --- |
| 不建知识掌握度评估系统 | 不建题库与分数体系；建**带置信度的主题状态**，只用于讲法与分析 |
| 不从提问次数推断掌握度 | 次数不能单独作为结论；重问率、未闭环率、自我修正、练习结果共同构成弱信号，且需样本门槛 |
| 记忆三类、200 条、`memory.json` | 扩展为七类；权威存储迁到 SQLite；`memory.json` 降为导出格式 |
| 记忆按消息提取 | 改为按**问答单元**提取与统计 |

## 3. 借鉴：拿什么、怎么拿

| 来源 | 机制 | 用法 | 需求 |
| --- | --- | --- | --- |
| ReMe | Remember / Refine 两阶段 | L0 原样记录，L1/L2 离线提炼 | R2 |
| dsh-meow-memory（MIT） | 七层记忆、BM25、窗口 dream、压缩后重注入、首轮快照 | **代码级移植**：BM25/中文分词、SQLite 模式、摘要提示词、注入策略 | R1/R2 |
| dsh-memento（Apache-2.0） | 服务内预算、结构化超限错误、审计、冻结快照 | **模式借鉴**：预算不可绕过、写满报错不截断 | 全局 |
| memtrace（专有） | 双时态 | 只借概念：`valid_from/valid_until/superseded_by` | R1/R3 |
| graph-memory | 三元组、上下文压缩 | 轻量“主题—前置—易混”，不做图库 | R3 |
| dsh-mnemon（MIT） | 运行时记忆/文档/记忆空间三分、回合记忆条 | 只作信息架构参考，不引框架 | R1 |
| deja-vu | 复用磁盘会话历史 | 启动补录、只存引用 | R2 |
| EverOS / memsearch | local-first、Markdown 可读 | 导出格式与可移植性 | 全局 |
| engramory | 记忆策展协议、上限钩子 | 类型配额、写入白名单 | 全局 |

**不采用**：MemOS/EverOS 平台、mem0 服务、Milvus、图数据库、MCP 外部记忆、`dsh-memory-evolve`（功能过宽）、`dsh-mnemon`（多包框架过重）、memtrace（专有 EULA）。

## 4. 总体结构

```
┌──────────────────────────────────────────────────────────────┐
│ L3 行为层   教学契约（编译产物，每轮注入 ≤300 token）           │
├──────────────────────────────────────────────────────────────┤
│ L2 画像层   trait · topic_state · strategy · preference …     │
│             推断、带证据、带置信度、双时态、自动生效、可纠正     │
├──────────────────────────────────────────────────────────────┤
│ L1 摘要层   日/周摘要 · 主题线索                                │
├──────────────────────────────────────────────────────────────┤
│ L0.5 单元层 问答单元（episode）＋ 题目（problem）               │
├──────────────────────────────────────────────────────────────┤
│ L0 证据层   turn · signal · window                             │
└──────────────────────────────────────────────────────────────┘
      ↑ 原始对话正文仍在 DSH session；这里只存引用与学习摘录
```

新增的 **L0.5** 是本次设计的核心：会话不是记忆单元，消息也不是；**一次问答**才是。它承担三件事：

1. 把多轮澄清合并成一条完整记忆，避免“问一句记一条”。
2. 把一次会话里的多个无关问题拆开，避免主题污染。
3. 给 R3 提供可统计的原子：问过多少次、重问几次、是否闭环。

## 5. 数据模型

### 5.1 L0：回合

```sql
CREATE TABLE study_turn (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  turn_no       INTEGER,
  at            TEXT NOT NULL,
  intent        TEXT NOT NULL,      -- question|planning|feedback|emotion|chitchat|other
  is_learning   INTEGER NOT NULL,
  subject       TEXT,
  text          TEXT,               -- 学习类全文；非学习类只存摘要
  text_hash     TEXT NOT NULL,
  text_pruned_at TEXT,              -- 90 天清理标记
  attachments_json TEXT,
  task_id       TEXT,
  material_ref  TEXT,
  episode_id    TEXT,
  classified_by TEXT NOT NULL,      -- rule|model|user
  classifier_version TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(session_id, message_id)
);
```

### 5.2 L0.5：问答单元与题目

```sql
CREATE TABLE study_episode (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  subject       TEXT,
  opened_at     TEXT NOT NULL,
  closed_at     TEXT,
  status        TEXT NOT NULL,      -- open|closed|enriched|merged
  problem_count INTEGER NOT NULL DEFAULT 0,
  stuck_json    TEXT,               -- 卡点：概念缺失/步骤跳跃/计算失误/题意误解
  method_json   TEXT,               -- 有效讲法：例子/反例/画图/换元/回退前置
  resolution    TEXT,               -- understood|unresolved|verified|unknown
  confidence    REAL,
  summary       TEXT,               -- ≤200 字，enriched 时写入
  boundary_source TEXT NOT NULL,    -- rule|model|user
  continuation_of TEXT,             -- 跨会话续问的上一个 episode
  merged_into   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE study_episode_problem (
  id            TEXT PRIMARY KEY,
  episode_id    TEXT NOT NULL,
  position      INTEGER NOT NULL,
  text          TEXT,               -- 题目原文，90 天后清理
  norm          TEXT,               -- 归一化题干，用于查重
  hash          TEXT NOT NULL,
  sketch        TEXT NOT NULL,      -- 8 个关键词，清理后仍可用于相似判断
  status        TEXT NOT NULL,      -- open|resolved|reasked|abandoned
  resolution    TEXT,
  reasked_from  TEXT,               -- 同一题上次出现的 problem id
  reask_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE study_episode_turn (
  episode_id    TEXT NOT NULL,
  turn_id       TEXT NOT NULL UNIQUE,
  position      INTEGER NOT NULL,
  role          TEXT NOT NULL,      -- ask|clarify|confirm|other
  PRIMARY KEY (episode_id, position)
);

CREATE TABLE study_signal (
  id            TEXT PRIMARY KEY,
  episode_id    TEXT,
  problem_id    TEXT,
  turn_id       TEXT,
  kind          TEXT NOT NULL,      -- reask|understood|confused|corrected|self_solved|gave_up|skipped
  at            TEXT NOT NULL,
  value_json    TEXT,
  source        TEXT NOT NULL       -- rule|agent|user
);

CREATE TABLE study_topic (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, name TEXT NOT NULL,
  aliases_json TEXT, parent_id TEXT, material_ref TEXT, created_at TEXT NOT NULL
);

CREATE TABLE study_episode_topic (
  episode_id TEXT NOT NULL, topic_id TEXT NOT NULL, confidence REAL NOT NULL,
  source TEXT NOT NULL, PRIMARY KEY (episode_id, topic_id)
);

CREATE TABLE study_window (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, kind TEXT NOT NULL,
  start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  status TEXT NOT NULL,             -- open|sealed|summarized|failed
  cursor_json TEXT, summary_id TEXT, closed_at TEXT, attempts INTEGER NOT NULL DEFAULT 0
);
```

**约束**：

- 每个 `study_turn` 最多属于一个 `episode`；`study_episode_turn.turn_id` 唯一。
- 非学习回合不建 episode，但仍保留 `study_turn`（意图统计用）。
- `problem_count` 1–3；超过 3 道题的回合在切分时拆成多个 episode（见 6.2）。
- 90 天清理只清 `text` / `problem.text` / `norm`，保留 `hash`、`sketch`、结构、摘要。

### 5.3 L1：摘要

```sql
CREATE TABLE study_window_summary (
  id TEXT PRIMARY KEY, window_id TEXT NOT NULL, level TEXT NOT NULL, -- day|week|gap
  text TEXT NOT NULL, data_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
  input_hash TEXT NOT NULL, model TEXT, prompt_version TEXT,
  superseded_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE study_topic_thread (
  id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, version INTEGER NOT NULL,
  text TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

### 5.4 L2：画像

```sql
CREATE TABLE study_memory_item (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL,
  kind TEXT NOT NULL,        -- preference|state|observation|trait|topic_state|strategy|episode
  key TEXT, text TEXT NOT NULL, value_json TEXT,
  confidence REAL NOT NULL, status TEXT NOT NULL,   -- proposed|active|rejected|retired
  valid_from TEXT NOT NULL, valid_until TEXT, superseded_by TEXT,
  source_kind TEXT NOT NULL, source_actor TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_confirmed_at TEXT
);

CREATE TABLE study_memory_evidence (
  item_id TEXT NOT NULL, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL,
  weight REAL NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (item_id, ref_kind, ref_id)
);

CREATE TABLE study_memory_tombstone (
  id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, goal_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL, source_json TEXT NOT NULL
);
```

七类记忆：`preference`（明确偏好）、`state`（短期状态）、`observation`（待确认观察）、`trait`（讲解参数）、`topic_state`（主题状态）、`strategy`（学习习惯）、`episode`（**值得长期记住的关键问答**，如“第一次独立解出某类题”）。

`episode` 类记忆与 `study_episode` 表不是一回事：后者是全部问答的索引，前者是从中挑出的少量里程碑，避免把每个单元都复制进画像层。

`trait` 固定键与默认值：

| key | 值域 | 默认 | 敏感 |
| --- | --- | --- | --- |
| `explain_detail` | 1–5 | 3 | 是 |
| `example_first` | 0–1 | 0.5 | 否 |
| `step_granularity` | 1–3 | 2 | 否 |
| `check_frequency` | 0–2 | 1 | 否 |
| `hint_preference` | 0–1 | 0.5 | 否 |
| `pace` | -1–1 | 0 | 是 |
| `session_tolerance` | 15–120 分钟 | 45 | 否 |

### 5.5 分析产物

```sql
CREATE TABLE study_learning_review (
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL,
  period TEXT NOT NULL,          -- 2026-W46 | 2026-11
  kind TEXT NOT NULL,            -- week|month|evening
  evidence_json TEXT NOT NULL, report_md TEXT NOT NULL,
  actions_json TEXT, created_at TEXT NOT NULL, superseded_by TEXT
);
```

## 6. 写入路径

### 6.1 捕获（确定性）

**入口**：DSH `agent/inbox/claimed`（`{ agent, message, turn }`），`message.id` 作幂等键。

1. 过滤插件注入（`message.source.kind` 属于 `study-*` 等生产者）。
2. 提取文本块、附件引用；`session_id = agent.id`。
3. 规则判 `intent` / `is_learning`（问句标记、任务关联、附件、学科词典）。
4. 写 `study_turn`（`requestId = capture:<messageId>`），失败记缺口，不阻塞对话。
5. 追加到当前 episode（见 6.2）。

**补录**：会话首次打开时按 DSH 历史补齐缺失 `message_id`；单会话上限 2000 条。

**对账**：窗口关闭时对比 DSH 用户消息数与 `study_turn` 数，缺口写入 `study_capture_gap` 并在面板显示。

### 6.2 会话 → 问答单元

这是 R2 的核心。会话里的连续用户回合按“是否同一件事”切分。

**回合特征**：主题集合（主题词典命中）、字符 bigram 集合、材料/任务引用、问句类型（求解/概念/对答案/追问/闲聊）、边界词与续问词、时间间隔、是否含新题号。

**边界分**（相邻两个学习回合）：

```
+0.35 主题不相交
+0.20 文本相似度 < 0.15
+0.15 显式边界词（“再问一道”“另一个问题”“这题我会了”）
+0.10 材料或任务引用变化
+0.10 时间间隔 > 30 分钟
-0.30 续问词（“那”“这一步”“为什么这里”“还是不懂”“再讲”）
-0.20 文本相似度 > 0.45
-0.15 同主题且问句类型为追问
```

- `≥0.5`：切分。
- `0.3–0.5`：标 `ambiguous`，窗口关闭时由摘要模型批量复核（一次调用处理整窗）。
- `<0.3`：并入当前单元。

**补充规则**：

- 单元内用户回合上限 8；超过时在边界分最低处强制切分。
- 单回合含 3 个以上独立题目时，按句拆成多个单元（同一 `turn` 只保留在主单元，其余记 `split_from`）。
- 跨会话续问：新会话首回合含续问词、且 7 天内存在同主题单元 → `continuation_of` 指向旧单元，不新建。
- 会话结束、空闲 30 分钟、窗口关闭 → 关闭单元（`status=closed`），等待窗口关闭时 enrichment。

**Enrichment（窗口关闭时批量）**：一次模型调用处理该窗口的新单元，输出每题题干、卡点、有效讲法、结果、主题；失败降级为规则版（首句题干 + 信号推断结果）。成功后写 `problem`、`summary`、`status=enriched`。

**用户纠正**：合并两个单元、按回合拆分、改主题/结果；写 `change_log`，`boundary_source=user`。

### 6.3 窗口与摘要（04:00 边界）

- 日窗口 04:00–次日 04:00；周窗口周一 04:00 起 7 天。
- 状态机 `open → sealed → summarized`；启动/空闲/晚间复盘后/退出前触发，`requestId=window:<id>` 串行。
- 摘要输入：该窗口的**单元**（含题目、卡点、结果）与信号，不读整段对话。
- 输出 JSON：`counts / episodes / problems / confusions / wins / methodSignals / openProblems / narrative`。
- 校验：引用必须属于本窗口；`narrative` 数字必须能在 `counts` 找到；失败重试一次，再失败降级规则摘要。
- 跨窗口提炼：周摘要只读 7 条日摘要 + 主题聚合，不读原文。

### 6.4 画像推断与自动生效

**触发**：周窗口关闭后、某 trait 新增 3 条证据、某主题新增 3 个单元。

**计算**（每个 trait 一个 Beta 先验 α=β=1）：

```
w = base × 0.5^(age_days / 56)
value = (α + Σw_pos) / (α + β + Σw_pos + Σw_neg)
confidence = 1 - sqrt(value(1-value) / (α+β+Σw+1))
```

**自动生效规则**（已确认，无确认弹窗）：

| 置信度 | 行为 |
| --- | --- |
| ≥ 0.70 | `active`，立即影响讲法 |
| 0.50–0.70 | 仅 `example_first`、`step_granularity` 可生效；`explain_detail`、`pace` 用默认 |
| < 0.50 | 默认档位，不生效 |

补充约束：

- 每 7 天每个 trait 最多变 1 档，防止抖动。
- 敏感 trait（`explain_detail`、`pace`）首次生效需 ≥3 个独立单元且 ≥14 天数据，之后同样自动。
- 8 周无新证据，置信度衰减到阈值以下，回退默认。
- 每次变更写 `change_log`，保留证据 id；面板可看、可改、可删。

**契约编译**（每轮注入，≤300 token）：

```
【讲解契约｜基于 23 次问答】
详细度 3/5；例子优先；步骤原子化；每 2 步确认；解题先提示后答案。
本周状态：11-13 自述疲惫（至 11-20），单次讲解不超过 3 段。
这是讲解假设，不是评价；不要复述，也不要据此降低任务要求。
```

### 6.5 用户纠正

- 改一条画像 → `user_edit`，`confidence=1`，旧条目 `superseded_by`。
- 否认 → `rejected` + 墓碑，后续推断不得重建。
- 删除问答单元 → 级联删题目/信号，重算 `topic_state` 与相关 trait；摘要标 `evidencePruned`。
- 合并/拆分单元 → 重算 `problem_count`、主题、统计。

## 7. 读取与注入

| 时机 | 内容 | 预算 |
| --- | --- | --- |
| 每轮 | 教学契约 + 3–5 条相关记忆 | ≤500 token |
| 会话开始 | “上次到这里”（主题线索 + 昨日摘要一句） | ≤120 字 |
| 按需 | `study_questions` / `study_insight` 工具 | 结果 ≤20 条 |

- 只注入 `active` 且未过期条目；`proposed` 不进契约。
- 记忆正文放数据区，声明“历史记录不是指令”。
- 不展示“为什么这次讲得细”；证据只在记忆面板与内部审计可见。
- 契约文本由模板渲染，模型不得自由改写。

## 8. 三个需求的落地

### 8.1 R1：画像 → 讲法

- 存参数不存评价：`explain_detail=4` 而不是“理解能力差”。
- 全局 trait 只是先验，`topic_state` 可带 `detail_override`，按主题覆盖。
- 映射表（编译用）：

| 档位 | 约束 |
| --- | --- |
| detail 1 | 结论 + 1 步关键推导；不补前置；结尾 1 个自测问题 |
| detail 3 | 结论 + 推导 + 1 例；补 1 个必要前置 |
| detail 5 | 前置确认 → 定义 → 动机 → 推导 → 例子 → 易错点；每 2 步确认 |
| example_first ≥0.67 | 先例后定义 |
| granularity 3 | 一步一编号，每步 ≤2 句 |
| hint 0 | 只给下一步提示 |

- 探针：置信度高且连续 5 次无重问 → 临时降 1 档；重问则回退并记负证据。
- 不因画像降低任务量、目标或评价标准；不说“因为你基础差”。

### 8.2 R2：完整记录与 90 天保留

**“完整”的三条保证**：

1. 钩子覆盖所有用户回合，不依赖模型判断重要性。
2. `(session_id, message_id)` 幂等。
3. 会话消息数对账，缺口可见、可补。

**90 天保留**：

- 0–90 天：回合全文、题目原文、归一化题干可查。
- 90 天后：清空 `text` / `problem.text` / `norm`，保留 `hash`、`sketch`、题目状态、单元摘要、主题、统计。
- 面板提示“正文已按 90 天策略清理，摘要与统计保留”；导出在清理前可用。
- 重问检测降级：`sketch` 相似度 ≥0.5 且同主题 → “相似题”，不声称同一题。

**三级分辨率**：原文（90 天）→ 单元摘要（永久，≤200 字）→ 日/周摘要（永久，200–400 字）。

### 8.3 R3：学习分析

**入口**：对话中请求分析 → `study_insight(review_build)`；周页按需生成周报。

**弱主题**（确定性）：

```
n = 主题下题目数；sample = n/(n+3)
weakness = sample × (0.4·重问率 + 0.3·未闭环率 + 0.2·最近无成功天数/21 + 0.1·自评难度/5)
```

- `n<3` 不排序，标“证据不足”。
- 三态：未接触 / 薄弱 / 遗忘，建议分别为“开始学 / 换练法 / 安排复习”。

**方法信号**（规则 + 反证）：只问不练、同类反复、时段低效、长时低产、计划回避、碎片化。每条给证据、反证、置信度。

**报告契约**：

```
我看到的（数据 + 引用）
我的解释（推断 + 置信度 + 替代解释）
建议试的 1–3 件事（做什么、多久、怎么判断有效）
需要你确认的
```

- 不出现能力/智商/基础差；不诊断心理状态。
- 建议默认一周后回看；学生接受后才经 `study` 建任务。

### 8.4 周报与周页

- 新命名空间 `review`：`week({date})`、`month({date})`、`list`；晚间复盘后续迁入。
- 周报内容：本周问答数/题目数、闭环率、重问 Top3、方法信号 1–2 条、下周 1 个实验。
- 展示：`outcomes` 周模式下方新增“本周学习分析”卡；无报告时显示“生成”按钮；无模型时显示规则版。
- 生成时机：周窗口摘要完成后预生成；打开周页时若缺失则懒生成（幂等）。
- 画像变化：周报末尾一行“本周对你的了解更新了 N 处”，不展开、不解释“为什么这次讲得细”。

## 9. 治理、安全与成本

| 主题 | 规则 |
| --- | --- |
| 证据链 | `active` 必须有证据；面板可查原句与时间 |
| 双时态 | 修改不覆盖，`valid_until` + `superseded_by` |
| 自动生效的兜底 | 阈值、±1 档/周、敏感项冷启动、可改可删、墓碑 |
| 删除 | 内容哈希墓碑；证据级联；旧对话不能重建 |
| 提示注入 | 记忆正文包裹为数据；模型生成的记忆不得含工具指令 |
| 隐私 | 全本地；分析只发证据包；导出默认不含原始对话 |
| 成本 | 日摘要 1 次、周摘要 1 次、画像每周 ≤1 次、分析按需；无 Key 规则降级 |
| 可移植 | JSONL + Markdown 导出；保留来源与时间 |

## 10. 接口

**`learning`**（新增）：`capture`(写)、`classify`(写)、`search`、`stats`、`weakTopics`、`methodSignals`、`sealWindow`/`summarizeWindow`(写)、`reconcile`、`reviewBuild`/`reviewSave`。

**`review`**（新增）：`week`、`month`、`list`、`save`。

**`memory`**（扩展）：`traitList`、`traitExplain`、`traitCorrect`、`profileSnapshot`；现有 `remember/recall/forget` 不变。

**工具**：`study_questions`（检索/统计）、`study_insight`（weak_topics/method_signals/review_build/review_save/profile）；保留 `memory_*`。

**模块**：`plugins/study/host/modules/learning.mjs`、`review.mjs`；`memory.mjs` 扩展；`registry.mjs` 的 `NAMESPACES` 增加 `learning`、`review`。

## 11. 阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1 | 捕获、问答单元、题目表、对账 | 3 天真实使用捕获率 ≥99%；单元切分人工抽查 ≥85% 正确 |
| P2 | 窗口摘要、90 天清理、主题线索 | 摘要可重建、引用率 100%、清理后统计不塌 |
| P3 | 画像 v2、自动生效、契约注入 | 讲法差异可解释；纠正后立即生效；无抖动 |
| P4 | 分析工具、弱主题、方法信号 | 数字来自 SQL；每条结论带引用 |
| P5 | 周报、周页、导出 | 周页可见；无模型有规则版；导出可读 |

## 12. 风险与待定

| 风险 | 缓解 |
| --- | --- |
| 切分不准 | 模糊边界批量复核；用户合并/拆分；阈值可配 |
| 摘要模型不稳定 | JSON 校验 + 规则降级 + 版本化 |
| 自动生效过头 | 阈值 + 变更上限 + 探针 + 可删 |
| 迁移丢数据 | 迁移前备份 `memory.json`；只读校验；失败回滚 |
| 成本 | 批处理、空窗口跳过、用量可见 |

**待定**：周报生成是否需要模型（默认需要，无 Key 降级）；90 天清理是否保留题干首 20 字（默认不保留，只留 sketch）。
