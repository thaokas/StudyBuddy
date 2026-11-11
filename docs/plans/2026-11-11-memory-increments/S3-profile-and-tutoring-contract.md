# S3：学生画像与讲法

> 本文件是给**新会话**的执行说明。前提：S1、S2 已完成并通过验收。只做本增量。

## 0. 一句话目标

把 `memory.json` 的三类记忆迁到 SQLite 的七类记忆，加入可自动生效的讲解参数（trait），并把它们编译成每轮注入的“教学契约”。

完成后应能演示：同一类题连续重问 5 次后，`explain_detail` 上升一档，下一次讲解变细；学生在画像页改回默认后，下一轮立即恢复。

## 1. 开始前检查

- `node --test plugins/study/tests` 通过（含 S1/S2 用例）。
- `study_episode` 有真实或 fixture 数据；`learning.list` 可用。
- 已读：
  - 设计 `§5.4`（画像）、`§6.4`（推断与自动生效）、`§7`（注入）、`§8.1`（画像→讲法）
  - 计划 `§4 M3`
  - `plugins/study/host/modules/memory.mjs` 全文（现有三类记忆、墓碑、注入）
  - `docs/decisions/memory.md`（v1 决策与限制）
- 备份当前 `.studybuddy` 数据目录（至少 `memory.json` 与 `study.db`）。

## 2. 范围

1. 新增 3 张表：`study_memory_item`、`study_memory_evidence`、`study_memory_tombstone`。
2. `memory.json` → 表迁移，保留 id、时间、来源、墓碑；失败回滚。
3. 七类记忆：`preference` / `state` / `observation` / `trait` / `topic_state` / `strategy` / `episode`。
4. 三个可推断 trait：`explain_detail`、`hint_preference`、`pace`；其余三个用默认值。
5. Beta 置信度、阈值、±1 档/周、8 周半衰、自动生效。
6. `memory_profile` 工具：`get` / `explain` / `set`。
7. 教学契约编译与注入，替换现有 `renderSnapshot`。
8. 记忆页新增“画像”tab。
9. 迁移与 trait 的单测。

## 3. 明确不做

- 不做弱主题、方法信号、报告、周报（S4）。
- 不做 90 天保留、导出（S4）。
- 不做按主题的 `detail_override`（S4 有了 `topic_state` 再加）。
- 不调用模型；trait 只从规则信号与显式设置计算。
- 不改 S1/S2 的表与切分逻辑。

## 4. 数据模型

在 `memory.mjs` 的 `schema` 数组写入（`memory` 当前 `schema` 为空、未被 `module_schema` 记录，因此可直接加表，`schemaVersion: 1`）：

```sql
CREATE TABLE IF NOT EXISTS study_memory_item (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT,
  text TEXT NOT NULL,
  value_json TEXT,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  superseded_by TEXT,
  source_kind TEXT NOT NULL,
  source_actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS study_memory_kind ON study_memory_item (goal_id, kind, status);

CREATE TABLE IF NOT EXISTS study_memory_evidence (
  item_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  weight REAL NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (item_id, ref_kind, ref_id)
);

CREATE TABLE IF NOT EXISTS study_memory_tombstone (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  source_json TEXT NOT NULL
);
```

`trait` 的 `value_json` 形如 `{ "value": 0.62, "level": 4, "alpha": 3.1, "beta": 2.4 }`；`text` 是给学生看的一句行为描述，例如“首讲偏详细，先补前置再推导”。

## 5. 迁移

在 `apply` 里、注册方法前执行一次：

1. 若三张表为空且 `memory.json` 存在：
   - 复制为 `memory.v1.backup.json`（同目录）。
   - 逐条导入 items：`kind` 原样；`goalId` 缺失填当前目标；`source` 拆成 `source_kind`/`source_actor`；`expiresAt` 写入 `valid_until`；`status='active'`。
   - 导入 tombstones。
2. 校验：条数与 JSON 一致、抽样正文一致、墓碑抑制行为一致。
3. 任一步失败：不删 JSON、不写部分数据，`console.warn` 并继续用 **只读 v1 回退**（方法返回 `unavailable`，提示备份恢复）。
4. 成功后 `memory.json` 不再写，但保留为导出源；`study_memory_state` 保留一个版本不删。

`remember/recall/forget` 改为读写新表，签名与返回结构保持兼容（现有 15 个测试应通过或只做最小调整）。

## 6. Trait

### 6.1 键与默认

| key | 值域 | 默认档 | 推断来源 |
| --- | --- | --- | --- |
| `explain_detail` | 1–5 | 3 | 同主题 7 天内重问（负）；首次闭环且 7 天无重问（正） |
| `hint_preference` | 0–1 | 0.5 | 仅显式 `set` |
| `pace` | -1–1 | 0 | 仅显式 `set` |
| `example_first` | 0–1 | 0.5 | 默认 |
| `step_granularity` | 1–3 | 2 | 默认 |
| `check_frequency` | 0–2 | 1 | 默认 |

### 6.2 计算

```
w = 1.0（负）/ 0.5（正），按 0.5^(age_days/56) 衰减
value = (α + Σw_pos) / (α + β + Σw_pos + Σw_neg)，α=β=1
confidence = 1 - sqrt(value(1-value) / (α+β+Σw+1))
```

- `confidence ≥ 0.70`：`active`，生效。
- `0.50–0.70`：`explain_detail` / `pace` 用默认；`example_first` / `step_granularity` 可生效。
- `< 0.50`：默认。
- 档位映射：`explain_detail = clamp(1 + round(value×4), 1, 5)`；`pace = round(value×2 − 1)`（-1/0/1）；其余按值域线性映射。
- 每 7 天每个 trait 最多变 1 档；变更写 `change_log`（entity=`memory`）。
- 敏感 trait（`explain_detail`、`pace`）首次生效需 ≥3 个独立单元且 ≥14 天数据。
- 读取时按证据时间衰减；8 周无新证据回落到默认，`status='retired'` 仅在 explicitly retired 时使用。

### 6.3 触发

- 每次单元关闭/题目新增后，重算受影响 trait。
- `traitCorrect`（用户改）立即生效，`confidence=1`，旧值 `superseded_by` 指向新条目。
- 单元被删除/合并时，级联删证据并重算。

## 7. 教学契约

`systemPrompt.context`（order 500）渲染：

```
【讲解契约】
详细度 4/5；解题先给提示再给答案；推进速度偏慢。
这是讲解假设，不是评价；不要复述本段，也不要据此降低任务要求。

【相关记忆】
- 偏好：上午先学数学
- 观察（待确认）：换元后常忘记改上下限
```

- 只写参数，不写证据、置信度、“为什么”。
- 无 trait 时回退到 v1 快照（偏好/短期/观察，最多 8 条）。
- 契约文本变化才更新快照；同一会话内不重复注入。
- 详细度映射：
  - 1：结论 + 1 步；2：结论 + 关键推导；3：结论 + 推导 + 1 例；
  - 4：补前置 + 推导 + 例子；5：前置确认 + 定义 + 动机 + 推导 + 例子 + 易错点。

## 8. 工具与界面

- `memory_profile`：`get`（当前生效参数）、`explain`（某 trait 的证据 id 与时间，不作为对话内容）、`set`（用户显式改档，写 `traitCorrect`）。
- 记忆页 `memory.js` 增加 tab：“记忆” / “画像”。
  - 画像：每行一个 trait，显示行为描述、当前档位、`依据 N 次问答`、调整按钮、恢复默认。
  - 不做“为什么这次讲得细”的对话提示。
- 所有写走 `POST /api/study/memory/<method>`，带 `requestId`。

## 9. 测试

- 迁移：v1 JSON 含 3 类条目 + 墓碑 → 表；`remember/recall/forget` 行为不变；墓碑抑制仍有效。
  - 现有 `tests/memory/memory.test.mjs` 中直接检查 `study_memory_state` JSON 的断言，改为检查 `study_memory_item` 表；`tool-smoke.mjs` 同步改为读表。其余行为断言不得放宽。
- trait：5 次重问 → `explain_detail` 升 1 档；再 5 次升第 2 档；7 天内不超 1 档；14 天无证据回落。
- 自动生效：confidence 0.69 不生效、0.71 生效。
- 纠正：`set` 后下一轮契约文本变化；旧值 `superseded_by`。
- 注入：契约不含证据 id/置信度；空态回退 v1。
- 现有测试全绿。

## 10. 验收

- 迁移幂等；失败可回滚；备份文件存在。
- 同一类题连续重问后讲法变细，学生改回后立即恢复。
- 契约注入 ≤300 token，无“为什么”。
- 画像页可看、可改、可恢复默认。
- 交付记录写明迁移结果、阈值表现、已知偏差。

## 11. 交付物

- `memory.mjs` 改造（store、迁移、trait、契约）
- `host/memory/store.mjs`、`host/memory/traits.mjs`、`host/memory/migrate-v1.mjs`
- `client/pages/memory.js` 画像 tab、`client/messages/memory.js` 新文案
- `tests/memory/migration.test.mjs`、`tests/memory/traits.test.mjs`
- `DELIVERY.md` 的 S3 部分

## 12. 交接给 S4

- 七类记忆、trait、契约注入、画像页可用；
- **未提供**：`topic_state` 的写入与覆盖、弱主题、方法信号、周报、保留、导出。
- S4 新增 `topic_state` 时，直接写 `study_memory_item`（`kind='topic_state'`），复用本轮的证据与置信度工具。
