# S4：学习分析与周报

> 本文件是给**新会话**的执行说明。前提：S1、S2、S3 已完成并通过验收。只做本增量。

## 0. 一句话目标

在已有问答单元与画像之上，做出可引用的弱主题排序、学习方法信号、周报，并把周报放到周页；同时完成 90 天正文保留与导出。

完成后应能演示：学生问“我哪里薄弱”，Agent 调 `study_insight` 得到带引用的弱主题；周页显示本周 3 条分析；90 天前的问题正文被清理，但统计与摘要仍在。

## 1. 开始前检查

- `node --test plugins/study/tests` 通过。
- `study_episode`、`study_window_summary`、`study_memory_item` 有数据能力。
- 已读：
  - 设计 `§8.3`（分析）、`§8.4`（周报）、`§8.2`（90 天）、`§9`（治理）
  - 计划 `§4 M4/M5`
  - `client/pages/outcomes.js`（周页结构）、`client/lib/api.js`
  - S1–S3 交付记录
- 备份 `.studybuddy` 数据目录。

## 2. 范围

1. 主题聚类：把同 `subject` 下 `sketch` 相似度 ≥0.5 的题目聚成主题，写 `study_topic`、`study_episode_topic`。
2. 弱主题排序（确定性公式 + 样本门槛 + 三态）。
3. 方法信号 3–4 条（同类反复、时段低效、集中突击、未闭环积压），每条带证据与反证。
4. `study_insight` 工具：`weak_topics` / `method_signals` / `review_build` / `review_save` / `profile`。
5. `review` 命名空间：`week` / `month` / `list` / `save`。
6. 周页（`outcomes` week 模式）新增“本周学习分析”卡。
7. 90 天正文清理任务。
8. 导出：问答单元 JSONL、画像 Markdown。
9. 测试。

## 3. 明确不做

- 不做模型叙述；报告用模板。
- 不做晚间复盘的迁移（用户后续自己拆 `followup`）。
- 不做新的独立页面；周报卡放在 `outcomes`。
- 不改 S1–S3 的切分、窗口、trait 算法。
- 不引入向量检索；聚类用 sketch Jaccard。

## 4. 主题聚类

- 候选：`study_episode_problem` 中最近 90 天、`sketch` 非空的题目。
- 同 `subject` 内贪心聚类：与已有簇的代表 sketch Jaccard ≥0.5 则加入，否则新建簇。
- 簇大小 ≥2 才建主题；`name` 取簇内词频最高 3 个 token 拼接（≤20 字）。
- 写 `study_topic`（`id = topic_<8hex>`），写 `study_episode_topic`（`confidence = 簇内平均相似度`，`source='rule'`）。
- 聚类可重跑：已有同 `name` 且同 subject 的主题复用，不重复建。

## 4.5 报告表

`review` 模块新建 `study_learning_review`（`schemaVersion: 1`）：

```sql
CREATE TABLE IF NOT EXISTS study_learning_review (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  period TEXT NOT NULL,
  kind TEXT NOT NULL,             -- week|month
  evidence_json TEXT NOT NULL,
  report_md TEXT NOT NULL,
  actions_json TEXT,
  created_at TEXT NOT NULL,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS study_review_period ON study_learning_review (goal_id, kind, period);
```

## 5. 弱主题

```
n = 该主题题目数
reaskRate = 有 reask 的题目 / n
unresolvedRate = 未闭环题目 / n
recency = min(1, 距上次成功天数 / 21)
selfDifficulty = 自评难度均值 / 5（无则 0.5）
sample = n / (n + 3)
weakness = sample × (0.4·reaskRate + 0.3·unresolvedRate + 0.2·recency + 0.1·selfDifficulty)
```

- `n < 3`：不排序，返回 `{ status: 'insufficient' }`。
- 三态：
  - 未接触：无题目、无练习；
  - 薄弱：`weakness ≥ 0.5` 且有失败信号；
  - 遗忘：曾闭环、近 30 天重问 ≥1。
- 每条返回：`topicId`、`name`、`score`、`n`、`state`、`evidence`（最近 3 个 problem id + 日期）、`suggestion`（模板句）。

## 6. 方法信号

每条返回 `{ kind, title, detail, evidence, counterEvidence, confidence }`：

1. **同类反复**：同主题 7 天内重问 ≥3 → “可能停在‘看懂’未‘会做’”；反证：也可能是复习安排。
2. **时段低效**：22:00–02:00 的重问率比日间高 ≥20 个百分点 → 建议调整时段；反证：样本少。
3. **集中突击**：单日 ≥5 个单元且随后 3 天为 0 → 建议分散；反证：可能是一次专题突破。
4. **未闭环积压**：未闭环题目 ≥5 且最早 >14 天 → 建议先清理旧账；反证：可能是刻意搁置。

阈值写成常量并在测试中覆盖。

## 7. 报告

`review.week({ date })`：

1. 取该周 7 个日摘要 + 单元 + 弱主题 + 信号 + 画像变化。
2. 生成 Markdown：

```
## 我看到的
- 本周 12 次问答、18 道题，闭环 11 次，未闭环 3 次。
- 重问集中在「多元函数可微」（5 道题，重问 3 次）。
## 我的解释
- 你可能停在“看懂步骤”，还没有独立做一遍。（置信度中；也可能与本周练习量少有关）
## 建议你试的
1. 下周每次看完例题，合上答案独立做 1 道同类题，记录是否卡住。
## 需要你确认的
- 这个判断符合你的感受吗？
```

3. 数字必须来自 `stats` / `weakTopics` 的返回值；建议 1–3 条；不出现能力/心理诊断。
4. `kind='week'`，`period=2026-W46`，写 `study_learning_review`；同周重复生成用 `superseded_by`。
5. `month` 同理，聚合 4 周。

`review_build` 返回证据包（≤6k token）：画像参数、4 周统计、Top5 弱主题各 3 例、信号、最近 3 条摘要。`review_save` 存报告。

## 8. 周页卡片

- 在 `outcomes.js` 的 week 模式、现有表格下方加一张卡：
  - 标题“本周学习分析”；
  - 3 条要点（来自 `review.week` 的 `bullets`）；
  - “生成/刷新”按钮（写操作带 `requestId`）；
  - “展开”显示完整 Markdown。
- 只读，不改现有统计表；无报告时显示按钮，不自动请求模型。
- 文案进 `client/messages/outcomes.js`；不要硬编码。

## 9. 90 天保留

- `learning.prune({ now })`：`study_turn.at < now-90d` 且 `text_pruned_at IS NULL` → `text=NULL`、`text_pruned_at=now`；`study_episode_problem` 同理清 `text`/`norm`，保留 `hash`/`sketch`/状态。
- 启动时跑一次，之后每 24 小时一次（`setInterval` + `ctx.effect` 清理）。
- 不删除行、不写墓碑；这是保留策略不是删除。
- 问答页对已清理单元显示“正文已按 90 天策略清理，摘要与统计保留”。

## 10. 导出

- `learning.export({ from, to })` → `{ jsonl }`：每行一个单元（含题目、信号、摘要），默认不含回合原文。
- `memory.export()` → 返回 `memory.json` 兼容快照（从表生成）。
- 导出不写文件，由调用方决定；测试只校验内容结构。

## 11. 测试

- 聚类：3 道相似题 → 1 个主题；2 道不相似 → 不建。
- 弱主题：构造 4 道重问题 → 分数与三态正确；`n=2` → insufficient。
- 信号：阈值边界各 1 例；反证字段非空。
- 周报：固定 7 天 fixture → 数字与 `stats` 一致；重复生成只有 1 条 active，旧条 `superseded_by`。
- 保留：90 天前正文清空、统计不变、摘要仍可读。
- 导出：JSONL 行数 = 单元数；画像 Markdown 含 6 个 trait。
- 现有测试全绿。

## 12. 验收

- 对话中请求分析 → 工具返回弱主题与信号，报告每条结论有引用。
- 周页显示 3 条要点，展开可见完整报告；刷新不重复生成。
- 90 天清理后，弱主题/周报仍可算。
- 导出可读。
- 交付记录写明公式参数、信号阈值、已知误判。

## 13. 交付物

- `host/learning/topics.mjs`、`host/learning/analysis.mjs`、`host/learning/prune.mjs`
- `host/modules/review.mjs`（+ `registry.mjs` 加 `review`）
- `host/learning.mjs` 增加 `weakTopics/methodSignals/export/prune`
- `client/pages/outcomes.js` 周卡、`client/messages/outcomes.js`
- `tests/learning/analysis.test.mjs`、`tests/review/week.test.mjs`
- `DELIVERY.md` 的 S4 部分

## 14. 全部完成后的交接

四轮完成后，按计划 `§10` 的 DoD 逐项验收：

- 捕获率与对账；
- 切分准确率（人工抽查 20 个单元）；
- 画像自动生效与纠正；
- 报告引用；
- 周页展示；
- 90 天保留；
- 回归测试全绿。

审核通过后再考虑：模型摘要/叙述、按主题的 `detail_override`、晚间复盘迁入 `review`、跨设备导出。
