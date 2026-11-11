# S2：窗口、摘要与问答记录页

> 本文件是给**新会话**的执行说明。前提：S1 已完成并通过验收。只做本增量。

## 0. 一句话目标

给问答单元加上 04:00 学习日窗口与规则摘要，提供可浏览、可合并/拆分的“问答记录”页面。

完成后应能演示：跨 3 天的问答被正确归入 3 个日窗口；每个窗口有一份摘要；问答页能按时间/学科/状态筛选，并合并两个单元。

## 1. 开始前检查

- `node --test plugins/study/tests` 通过（含 S1 新增用例）。
- 表 `study_episode`、`study_episode_problem` 存在且有数据能力。
- 已读：
  - 设计 `§5.3`（摘要）、`§6.3`（窗口）、`§8.2`（三级分辨率）
  - 计划 `§4 M2`
  - S1 交付记录与 `learning.mjs`
- `plugins/study/client/pages/memory.js`、`client/lib/api.js`、`client/messages/memory.js` 作为页面写法参考。

## 2. 范围

1. 使用 S1 已建的 3 张表：`study_window`、`study_window_summary`、`study_topic_thread`。
2. 04:00 学习日窗口：创建、封口、摘要、补做。
3. 规则摘要（不调用模型）：结构化 JSON + 中文模板。
4. 主题线索：按 subject 聚合的滚动摘要（S2 只按 subject，不建主题词典）。
5. 合并 / 拆分问答单元（服务方法 + 页面按钮）。
6. “问答记录”页面与中英文案。
7. 事件触发：启动补做、每 10 分钟 tick、退出前封口。

## 3. 明确不做

- 不做画像、trait、注入（S3）。
- 不做弱主题、方法信号、周报（S4）。
- 不做 90 天保留清理（S4）。
- 不调用模型；摘要用模板。
- 不做周窗口（周报在 S4 直接聚合日摘要与单元）。
- 不改 S1 的切分算法与表结构；只使用 S1 已建的表。

## 4. 数据模型

这 3 张表已在 S1 的 `schema` 中建好（S1 只建不用）。本轮直接读写，**不要改 `schemaVersion`**，也不要在 `apply` 里重复建表。字段如下，仅作参考。

```sql
CREATE TABLE IF NOT EXISTS study_window (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- day
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL,           -- open|sealed|summarized|failed
  cursor_json TEXT,
  summary_id TEXT,
  closed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS study_window_range ON study_window (goal_id, start_at);

CREATE TABLE IF NOT EXISTS study_window_summary (
  id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL,
  level TEXT NOT NULL,            -- day
  text TEXT NOT NULL,
  data_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS study_summary_window ON study_window_summary (window_id, created_at);

CREATE TABLE IF NOT EXISTS study_topic_thread (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,         -- S2 用 subject 作为 topic_id
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 5. 接口

| 方法 | 读/写 | 说明 |
| --- | --- | --- |
| `windowStatus` | 读 | 当前窗口与最近窗口状态 |
| `sealWindow` | 写 | 封口一个日窗口 |
| `summarizeWindow` | 写 | 生成/重建摘要 |
| `summaries` | 读 | 按区间取日摘要 |
| `merge` | 写 | 合并 ≥2 个单元 |
| `split` | 写 | 从某回合拆开单元 |

`sealWindow` / `summarizeWindow` 由内部定时器调用，`requestId = window:<id>`，重复调用返回已有结果。

`merge` 入参 `{ episodeIds: string[] }`；`split` 入参 `{ episodeId, atTurnId }`。两者写 `change_log`。

## 6. 实现要点

### 6.1 学习日

```js
function studyDay(now) {
  const local = new Date(now);
  if (local.getHours() < 4) local.setDate(local.getDate() - 1);
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}
```

窗口 `start_at` = 当日 04:00，`end_at` = 次日 04:00（ISO 字符串，本地时区偏移按 `Date` 计算）。

### 6.2 创建与封口

- `capture` 成功写入学习回合后，调用 `ensureWindow(at)`：没有当日 `open` 窗口则创建。
- tick（`setInterval` 10 分钟，`ctx.effect` 清理）：
  - 找到 `end_at <= now` 且 `status='open'` 的窗口 → `seal`；
  - 对每个 `sealed` 窗口 → `summarize`；
  - 启动时先跑一次，补做最近 14 天；超过 14 天只处理最近 14 天，旧窗口标 `failed` 并在状态里说明。
- 退出前（`ctx.effect` 的 disposer）尝试封口当前窗口，失败只记日志。

### 6.3 规则摘要

聚合该窗口内 `study_episode.opened_at ∈ [start, end)` 且 `status != 'merged'` 的单元：

```json
{
  "counts": { "episodes": 3, "problems": 5, "resolved": 2, "unresolved": 1, "reasks": 1 },
  "subjects": [{ "subject": "数学", "episodes": 2, "problems": 3 }],
  "openProblems": [{ "problemId": "...", "text": "…", "episodeId": "..." }],
  "confusions": [{ "episodeId": "...", "subject": "数学", "text": "…" }]
}
```

`text` 用模板：

> 今天 3 次问答、5 道题，2 次闭环、1 次未闭环；重问 1 次。数学 2 次（3 道题）。未闭环：《…》。

- `evidence_json` = 窗口内 episode id 列表。
- `input_hash` = 上述 id 排序后 + 各单元 `updated_at` 的 sha256。
- 已存在同 `input_hash` 的摘要 → 直接复用；否则插入新行，旧行 `superseded_by` 指向新行。
- 摘要成功后窗口 `status='summarized'`、`summary_id` 写入。

### 6.4 主题线索

按 `subject` 聚合最近 30 天：单元数、题目数、重问数、最近一次。写入/更新 `study_topic_thread`（`topic_id = 'subject:' + subject`，`version += 1`）。S2 只用于展示，S3 可复用。

### 6.5 合并 / 拆分

合并：

- 校验同一 `goal_id`、都不是 `merged`、至少 2 个。
- 目标 = `opened_at` 最早的单元；其余 `merged_into = 目标`、`status='merged'`。
- 回合：更新 `study_turn.episode_id` 与 `study_episode_turn.episode_id`，重排 `position`。
- 题目：更新 `episode_id`，重排 `position`，`problem_count` 重算。
- 主题：并集。
- 目标 `updated_at` 更新。

拆分：

- 校验 `atTurnId` 属于该单元。
- 新单元复制 subject；`opened_at` = 该回合时间。
- 该回合及其后的回合移到新单元；题目按 `created_at >= 该回合 at` 移动；两边重算。
- 旧单元 `status='closed'`，新单元 `closed`。

### 6.6 问答记录页

- `client/pages/questions.js`，导出 `{ key: 'questions', order: 70, label: 'questions.panel', Page }`。
- `client/messages/questions.js` 提供全部文案。
- 列表：时间、学科、题目摘要、闭环状态、重问标记；筛选：近 7/30 天、学科、状态、关键词。
- 详情：题目、回合（原文）、信号；按钮“合并到…”“从这里拆开”。
- 所有请求走 `POST /api/study/learning/<method>`，写操作带 `requestId`（参考 `client/lib/api.js`）。
- 空态、错误态、加载态齐全；不引入新样式体系，复用现有页面组件。

## 7. 测试

- 窗口：固定时钟跨 3 天，capture 若干回合 → tick 后 3 个窗口、3 份摘要；重复 tick 不重复。
- 摘要：同一 `input_hash` 复用；修改单元后重建，旧摘要 `superseded_by`。
- 合并：2 个单元合并后回合/题目数正确，`merged_into` 正确。
- 拆分：从第 2 个回合拆开，题目归属正确。
- 页面：`node plugins/study/scripts/build-client.mjs` 成功，页面 key 出现在产物中。

## 8. 验收

- 上述测试通过，现有测试全绿。
- 3 天 fixture 的摘要文本与计数正确；空窗口不生成。
- 问答页可筛选、可合并/拆分，刷新后数据一致。
- 不调用模型；断网可用。
- 交付记录写明窗口边界、补做上限、已知问题。

## 9. 交付物

- `learning.mjs` 扩展（窗口、摘要、合并/拆分）
- `host/learning/window.mjs`、`host/learning/summary.mjs`
- `client/pages/questions.js`、`client/messages/questions.js`
- `tests/learning/window.test.mjs`、`tests/learning/merge.test.mjs`
- `DELIVERY.md` 的 S2 部分

## 10. 交接给 S3

- 日窗口、摘要、主题线索可用；
- `learning.merge/split` 可用；
- 问答页可用；
- **未提供**：画像、trait、注入、分析、周报、90 天清理。S3 不要假设 `trait` 表或契约存在。
