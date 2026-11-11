# S1 交付记录

- 会话日期：2026-11-11
- 完成项：`learning` 命名空间与 11 张表；`agent/inbox/claimed` 捕获（只收 `source.kind === 'user'`）；规则分类；同会话问答单元切分；题目抽取、信号识别、重问检测；`capture/list/get/stats` 服务；`study_questions` 工具；13 个学习层测试与 8 回合切分 fixture。
- 未完成/偏差：见下文“偏差与解释”。
- 测试命令与结果：见下文“测试结果”。
- 新增/修改文件：见下文“文件”。
- 下一会话需要注意：见文末“交接给 S2”。

## 完成项

### 数据与模块

- `host/modules/learning.mjs`：`{ id, deps, schemaVersion: 1, schema, apply }`。`deps = ['tasks', 'tutoring']`（`subject` 只来自任务答疑链接）。
- 建表 11 张、索引 8 个，`module_schema` 记录 `learning = 1`（实测：19 条 DDL，11 张 `study_*` 表）。其中 `study_window`、`study_window_summary`、`study_topic_thread` 按计划只建不用。
- `host/registry.mjs` 的 `NAMESPACES` 追加 `learning`；`kernel.status()` 与 `study_status` 能看到该命名空间（已有 kernel 插件测试断言）。

### 捕获

- `ctx.on('agent/inbox/claimed')`，`message.source.kind !== 'user'` 直接返回，`study-tutoring` 等注入消息不入库。
- 取 `content` 中的 text 块拼正文；image/file 块记为 `attachments_json`。正文为空时不捕获（与说明中的钩子代码一致）。
- `sessionId = agent.id`，`messageId = message.id`；`requestId = capture:<messageId>`，`(session_id, message_id)` 唯一约束二次兜底。
- `goalId = resolveActiveGoal(db) ?? 'unassigned'`；`subject/task_id/material_ref` 由 `study_tutoring_link → study_task` 读取，无链接为 `null`。
- `(session_id, message_id)` 已存在时返回 `duplicate`；非学习回合照常写 `study_turn`（供意图统计），但不建单元。
- 失败不抛给对话：监听器把失败写 `study_capture_gap`（`reason` 例如 `invalid: text 不能超过 20000 字`）；写缺口失败只告警。已有测试覆盖。

### 分类与切分

- 分类规则按“反馈 > 问题 > 计划 > 情绪 > 闲聊”，记录 `classified_by='rule'`、`classifier_version='rule-v1'`。
- `is_learning = intent === 'question' || taskId !== null || 有 image/file 附件`。
- 切分按说明 §6.3 的权重，分数以“百分数整数”累加，阈值 0.30 / 0.50 不因浮点误差漂移：
  - 上一条学习回合不存在、间隔 > 30 分钟、或单元已有 8 个用户回合：直接新建。
  - 否则算边界分：`≥0.5` 新建；`0.3–0.5` 并入并标 `study_episode_turn.ambiguous = 1`；`<0.3` 并入。
  - 新建单元时关闭该会话所有 open 单元（`status='closed'`、写 `closed_at`）。
- `study_episode_turn.role`：单元首次 `ask`，含 “懂了/会了/清楚了/谢谢” 类回合为 `confirm`，其余 `clarify`。

### 题目、信号、重问

- 单元的第一道题取自该单元“第一个问句型学习回合”（`intent === 'question'` 或含新题号）；后续回合命中 `第[一二三四五1-5]题|另一道|顺便问|还有一道` 且未满 3 道时追加。题干截断 500 字，`norm` 去空白标点，`hash = sha256(norm)`，`sketch` 为去停用词后词频最高的 8 个 token。
- 信号规则：`understood / confused / self_solved / gave_up`，写 `study_signal`（`source='rule'`）。非学习回合（如没有任务链接时的“懂了”）也会把信号挂到该会话当前 open 单元，否则 `episode_id` 为 `null`。
- 单元结果：有 `understood/self_solved` → `understood`；否则最后一条信号是 `confused` → `unresolved`；否则 `unknown`。
- 重问：新建题目时在**同 goal、近 90 天、其他单元**里先查 `hash` 相同，再查同 subject 且 `sketch` Jaccard ≥ 0.8；命中后新题写 `reasked_from`，旧题 `reask_count += 1`、`status='reasked'`，当前单元写 `reask` 信号。

### 读接口与工具

- `list`：`{from,to,subject,status,query,limit}`，`limit` 默认 20、最大 50，返回 `items[]`（题目摘要）与 `total`。`query` 同时匹配题目正文和单元内回合正文（`LIKE` 已转义）。
- `get`：`{id}`，返回 `{episode, problems, turns, signals}`；`turns[].text` 可为空（S2 清理后）。
- `stats`：`{from,to}`，返回 `turns / learningTurns / episodes / problems / resolved / unresolved / reaskRate / bySubject`；`null` subject 归“未分类”。
- `study_questions`：`action: list|get|stats`，输出 JSON，`render` 为中文一行摘要（如“3 次问答｜4 道题｜2 次闭环｜重问率 0%”）。

## 测试结果

命令与结果（本机 Windows，Node v26.13.0）：

```text
node --test --test-isolation=none plugins/study/tests/learning   # 13 pass / 0 fail
node --test --test-isolation=none plugins/study/tests/memory     # 15 pass / 0 fail
node --test --test-isolation=none plugins/study/tests            # 606 例，605 pass / 0 fail / 1 skip
```

- 最终全量绿灯；`outcomes query timing` 月查询中位 88.3ms（周 40.5ms、日 27.7ms）。
- 期间一次全量运行出现 `tests/outcomes/performance.test.mjs` 月查询中位 106.9ms 超 100ms。这是既有已知抖动（`docs/decisions/layout.md` §216 记录过 103–113ms），与本增量无关，复跑即通过；未放宽容差，以免掩盖真实预算。
- 1 个 skip 是既有的“启动后注册命名空间”用例（所有冻结命名空间都已被模块占用）。
- 说明中的原命令 `node --test plugins/study/tests[/memory]` 在本沙箱会因 Node 测试运行器 `spawn EPERM`（命名管道受限）失败；项目文档已约定沙箱内用 `--test-isolation=none`（`docs/creator.md` 第 120 行）。`tests/client/build.test.mjs` 需要宿主权限才能 spawn esbuild：受限沙箱内失败、宿主权限下 11/11 通过，属环境限制而非代码回归。
- 开始前检查：`git status` 显示本工作区**没有任何提交**（`master` 无 commit），全部文件为 untracked，因此无法用 diff 证明“只含自己的改动”；`plugins/study/host/modules/learning.mjs` 在开工前确实不存在；`memory` 15 项通过。

## 偏差与解释

1. **题目抽取只认问句回合**：说明写“单元第一个学习回合抽 1 道题”。但任务链接会让“懂了”“明天做第 3 题”这类回合也算学习回合，若照字面抽题会把反馈/计划存成题干。实现改为“单元内第一个问句型回合”抽第一题；后续回合仍按新题号规则追加。首轮 fixture 与 13 个用例不受影响。
2. **`is_learning` 让“懂了”入单元**：有任务链接时反馈回合也是学习回合，会并入当前单元；无链接时它只写 `study_turn` + 信号，不建单元。两处都符合说明的规则，但会让“任务会话里的闲聊”进入单元，S2 可用主题/召回纠正。
3. **8 回合上限是“下一条新开”而不是回溯切分**：说明的“在边界分最低处强制新建”需要回写历史回合，本增量按无回溯的简单版本实现；到第 9 个用户回合时直接新建，已建单元不受影响。
4. **空闲关闭是懒关闭**：没有定时器；单元只在同会话下一次捕获新建单元时关闭。`status` 只有 `open/closed`，`enriched/merged` 留给 S2/S3。
5. **图片/文件单独消息不捕获**：钩子按说明在 `text === ''` 时返回；只有附件的消息（如截图题）不会入库。这是 S1 的已知缺口。
6. **缺口记录的写法**：`study_capture_gap` 由监听器在业务事务回滚后直接写库（`kernel.database`），不经过 `ctx.study.call`；其他模块也有同类内部记账写法。业务写仍然全部走 `ctx.study`。
7. **时间边界按 UTC**：`from/to` 只给 `YYYY-MM-DD` 时按 UTC 整日展开；库内 `at` 全部是 `toISOString()`。S2 的 04:00 学习日需要另行换算。
8. **90 天清理未做**：本增量保留全文；`text_pruned_at`、`problem.text/norm` 的清理留给 S2。
9. **跨会话续问未做**：`continuation_of` 只建列，不写值。S1 的“切分”只覆盖同会话。

## 切分规则的实际表现（fixture 8/8）

fixture（`tests/learning/learning.test.mjs`“the fixture conversation…”）8 个回合，8 个期望全部命中：

| # | 回合 | 关键因子 | 结果 |
| --- | --- | --- | --- |
| 1 | 数学题 | 新会话首回合 | 新单元 |
| 2 | “那这一步为什么…” | 续问词 −30、相似度低 +20、同 subject −15 | 并入 |
| 3 | 切到英语后“另一个问题…” | subject 不同 +35、边界词 +15、低相似 +20、引用变化 +10 | 切分 |
| 4 | “那这个例句呢？” | 续问词、低相似、同 subject | 并入 |
| 5 | “再问一道：定语从句…” | 边界词 +15、低相似 +20 = 0.35 | 并入并标 ambiguous |
| 6 | 切到物理后新问题 | subject 不同 +35、低相似 +20 | 切分 |
| 7 | “为什么这里要用 g…” | 续问词 −30、低相似 +20、同 subject −15 | 并入 |
| 8 | “懂了，谢谢” | 有任务链接 → 学习回合；低相似 +20 | 并入，信号 understood，单元 resolved |

“两个会话、5 个用户回合 → 3 个单元、4 道题”的演示形态另有独立用例覆盖（`demo shape`）。

## 已知误判

- **同 subject 的两个无关问题会并在一起**：没有主题词典时，subject 相同就只能靠边界词（+0.15）和低相似（+0.20）累计到 0.35，落在“模糊并入”区。学生说“另一个问题：…”但仍是数学时，通常不会切开；这也意味着第二题不会建题目，除非带“第 2 题/还有一道”。
- **“那”过宽**：`那` 作为续问词会命中“那么”“那里”“那些”，可能压制本应发生的切分。
- **情绪词单字过宽**：`累/困/烦` 会命中“积累/困难/麻烦”；只影响 intent 统计，不影响是否学习（学习性由问句/任务/附件决定），但会让情绪统计偏高。
- **任务链接让一切变成学习回合**：任务会话里的计划、安抚、闲聊都会被并入单元或生成信号；S1 没有“会话内先解绑再闲聊”的识别。
- **弱题干**：首批题目直接取整段用户消息（截断 500 字），多段提问时题干包含客套话；`norm/hash` 对“同一题换标点/空白”有效，对改写无效，只能靠 `sketch` ≥ 0.8 兜底。
- **截断后哈希**：题干按 500 字截断后再哈希，两段不同的长提问若前 500 字相同会被判为重问。

## 下一轮建议（S2 及以后）

1. S2 做窗口时优先消费 `study_episode_turn.ambiguous = 1` 的单元；有了主题线索后再回头修正切分，并把低置信度边界批量复核写回 `boundary_source`。
2. 给分类补一个小主题/学科词典（可从 `study_task.title/subject` 与材料标题生成），替代“subject 不同”这一唯一主题信号；至少让“另一个问题/再问一道”在低相似时直接切分。
3. 明确 `is_learning` 与反馈回合的关系：建议引入 `role`/`kind` 二段式（问句 vs 确认），或在单元内允许“非学习但相关的确认回合”，避免任务会话把闲聊当学习。
4. 图片/文件单独消息：S2 若做富媒体题干，需要把附件名/类型也作为“弱题目”，或在 `text === ''` 时以附件生成占位回合。
5. 真实数据校准：用两三天真实会话人工标注边界，统计切分准确率；当前只有规则级 fixture，没有真实语料准确率。
6. 90 天清理与重问降级（`sketch` ≥ 0.5 判“相似题”而不是同一题）按设计 §8.2 在 S2 落地。
7. 若需要“单元关闭”的实时性，可在 S2 的窗口/空闲心跳里补一个 close 扫描。

## 新增/修改文件

新增：

- `plugins/study/host/modules/learning.mjs`
- `plugins/study/host/learning/text.mjs`
- `plugins/study/host/learning/classify.mjs`
- `plugins/study/host/learning/segment.mjs`
- `plugins/study/host/learning/repo.mjs`
- `plugins/study/tests/learning/learning.test.mjs`
- `docs/superpowers/plans/2026-11-11-memory-increments/S1-delivery.md`（本文件）

修改：

- `plugins/study/host/registry.mjs`：`NAMESPACES` 追加 `learning`。
- `plugins/study/tests/kernel/registry.test.mjs`：冻结命名空间断言加入 `learning`。
- `plugins/study/tests/kernel/plugin.test.mjs`：`kernel.status()` 断言 `learning` 命名空间可见。

未改：`source/deepseek-harness`、`memory.json` / `memory.mjs` 行为、客户端与界面、DSH 源码。

## 交接给 S2

可直接使用：

- 表：`study_turn`、`study_episode`、`study_episode_problem`、`study_episode_turn`、`study_signal`、`study_capture_gap`（以及已建空的 `study_window`、`study_window_summary`、`study_topic`、`study_episode_topic`、`study_topic_thread`）。
- 服务：`learning.capture / list / get / stats`（`capture` 是唯一写方法，缺 `requestId` 会被 kernel 拒绝）。
- 工具：`study_questions`（list / get / stats）。
- 增量所依赖的既有服务：`tasks`、`tutoring`（仅读链接）。

S2 需要自己补：

- 窗口状态机、摘要、主题线索、90 天清理、合并/拆分、问答记录页；
- `ambiguous` 复核与 `boundary_source` 回写；
- 若给 `learning` 增加写方法，记得同步 `writes` 列表与命名空间测试；
- `study_episode.status` 目前只写 `open/closed`；S2 写 `enriched/merged` 时不要改 `schemaVersion`（列已存在）。
