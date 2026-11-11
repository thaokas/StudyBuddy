# 记忆系统 S1–S4 交付记录（合册）

四轮增量（S1 证据层 → S2 窗口与问答页 → S3 画像与讲法 → S4 分析与周报）全部完成，2026-11-11。执行说明见同目录 `Sx-*.md`，总计划见 [`../2026-11-11-memory-system-plan.md`](../2026-11-11-memory-system-plan.md)。

| 增量 | 完成项摘要 |
| --- | --- |
| S1 | `learning` 命名空间与 11 张表；捕获、分类、问答单元切分；`study_questions` 工具 |
| S2 | 04:00 学习日窗口与补做、规则摘要、主题线索、合并/拆分、问答记录页 |
| S3 | `memory.json` → SQLite 七类记忆迁移、六项讲解参数、教学契约注入、`memory_profile` 工具 |
| S4 | 主题聚类、弱主题与方法信号、`study_insight` 工具、周/月报、90 天正文保留、导出 |

以下为四份原始交付记录的合册，按 S1 → S4 顺序，保留各自原始小节结构。

## S1 交付记录

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
- `docs/plans/2026-11-11-memory-increments/S1-delivery.md`（本文件）

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

---

## S2 交付记录

- 会话日期：2026-11-11
- 完成项：04:00 学习日窗口、窗口状态机与补做、规则摘要、主题线索、合并/拆分、问答记录页与中英文案；S1 的切分算法、表结构与 `schemaVersion` 未改。
- 未完成/偏差：见下文“偏差与解释”与“已知问题”。
- 测试命令与结果：见下文“测试结果”。
- 新增/修改文件：见下文“文件”。
- 下一会话需要注意：见文末“交接给 S3”。

## 完成项

### 数据与写入

- 直接使用 S1 已建的 `study_window`、`study_window_summary`、`study_topic_thread`，**未改 schema、未 bump `schemaVersion`**，`apply` 里没有重复建表。
- 新增服务方法（`learning` 命名空间）：
  - `windowStatus`（读）：当前窗口、最近 7 个窗口、补做上限、待封口/待摘要/失败计数。
  - `sealWindow`（写）：封口一个窗口；已封口/已摘要/失败时返回当前状态，可安全重放。
  - `summarizeWindow`（写）：生成/重建日摘要；同一 `input_hash` 复用，旧行 `superseded_by` 指向新行。
  - `summaries`（读）：按 `study_window.start_at` 区间取当前日摘要（`superseded_by IS NULL`），并返回每个主题的最新 `study_topic_thread`。
  - `merge`（写）：`{ episodeIds }`，合并 ≥2 个同目标、都未合并的单元。
  - `split`（写）：`{ episodeId, atTurnId }`，从某回合拆开。
- `WRITE_METHODS` 变为 `capture / sealWindow / summarizeWindow / merge / split`；`study_questions` 工具保持只读（list/get/stats）。
- `learning.list` 新增可选 `resolution` 过滤（`understood|unresolved|unknown`），向后兼容；其余 S1 过滤不变。

### 04:00 学习日窗口

- `studyDay(now)`：本地时间 04:00 前算前一天；`windowBounds(day)` 给出本地 04:00 到次日 04:00，库内仍存 ISO-8601 UTC。
- `capture` 写入学习回合后调用 `ensureWindow`：没有当日 `open` 窗口就创建；同目标同一天只保留一个窗口。
- 若当日窗口已被退出封口为 `sealed/summarized`，再次捕获会把它**改回 `open`**（保留 `summary_id`），避免同一天出现两个范围相同的窗口。
- tick：`setInterval` 10 分钟，`unref()`，`ctx.effect` 清理；启动时立即跑一次。
  - 先封口所有 `end_at <= now` 且 `open` 的窗口；
  - 再对 `end_at <= now` 且 `sealed` 的窗口生成摘要（只看已结束的封口窗口，避免退出封口后在当天中途生成摘要）；
  - 超过 14 天的窗口不再补做：`open` 的封口时标 `failed`，`sealed` 的摘要时标 `failed`，`attempts += 1`，`cursor_json.failure='backfill_limit'`。
- 退出前：`ctx.effect` 的 disposer 先同步读当日 open 窗口（绕过服务读），再发一次 `sealWindow` 写；失败只打日志。这样它在 kernel 关闭 disposer 之前入队，`kernel.close()` 会等待这次写完成。
- `windowStatus.note` 只返回机器码（`backfill_limit` / `overdue` / `empty` / `retrying`），由页面本地化，不在数据里塞中文。

### 规则摘要（不调用模型）

- 输入：窗口 `[start_at, end_at)` 内 `opened_at` 命中且 `status != 'merged'` 的单元；题目取这些单元的全部题目。
- `data_json` 结构：
  - `counts`：`episodes / problems / resolved / unresolved / reasks`；
  - `subjects`：按学科（`null` 归“未分类”）的单元数、题目数；
  - `openProblems`：未闭环单元下的题目（最多 5 条，正文截 80 字）；
  - `confusions`：未闭环单元的最后一条有正文回合（没有则首题，截 80 字）。
- `text` 模板（中文）：`<日期/今天> N 次问答、M 道题，X 次闭环、Y 次未闭环；重问 Z 次。数学 2 次（3 道题）。未闭环：《…》。`
  - 只有窗口日等于当前学习日时才用“今天”，补做旧窗口用“11 月 9 日”，避免补做摘要谎称今天。
  - 未闭环列表最多 3 条、每条截 40 字，控制日摘要长度。
- `evidence_json` = 窗口内单元 id 列表；`input_hash` = 单元 id 排序后与各自 `updated_at` 拼接的 sha256；`model = NULL`，`prompt_version = 'rule-v1'`。
- 空窗口：`status='summarized'`、`summary_id=NULL`，**不插入摘要行**；`windowStatus.note='empty'`。
- 重建：同 hash 直接复用；不同 hash 插新行并把本窗口所有当前行 `superseded_by` 指向新行，窗口 `summary_id` 更新。
- 摘要失效：`merge` / `split` 会把包含受影响单元的、已摘要的窗口改回 `sealed` 并 `cursor_json.stale += 1`；`capture` 向一个“窗口已摘要但单元仍 open”的旧单元追加回合时同样失效。下一次 tick 用新的 requestId 真正重建，而不是重放旧结果。

### 主题线索

- 按 `subject` 聚合最近 30 天（`status != 'merged'`）：单元数、题目数、重问数、最近一次。
- `topic_id = 'subject:' + subject`；每次摘要写入一行新版本（`version = max+1`），不覆盖历史。
- `summaries` 返回每个 `topic_id` 的最新版本；S2 只在问答页展示，S3 可直接复用。

### 合并 / 拆分

- 合并：
  - 校验 ≥2、同一 `goal_id`、都不是 `merged`/`merged_into` 非空；
  - 目标 = `opened_at` 最早（同刻按 id）；
  - 回合按 `at` 重排到目标，`study_turn.episode_id` 同步；题目按 `created_at` 重排到目标；
  - 信号全部移到目标，重算目标 `resolution`；
  - 主题并集写入 `study_episode_topic`（`subject:<学科>`），目标的 `subject` 列保持原值（单列放不下并集）；
  - 源单元 `status='merged'`、`merged_into=目标`、`problem_count=0`；目标 `updated_at` 更新；
  - 写 `change_log`：每个源单元一条 `merge`，目标一条 `merge_target`。
- 拆分：
  - 校验 `atTurnId` 属于该单元；**不允许从第 1 个回合拆**（原单元会变空）；
  - 新单元复制 `goal_id/session_id/subject`、`opened_at = 该回合 at`、`boundary_source='user'`、`status='closed'`；
  - 该回合及之后的回合移到新单元，题目按 `created_at >= 该回合 at` 移动，信号按回合/题目移动；
  - 两边重排位置、重算 `problem_count` 与 `resolution`（无信号写回 `NULL`，与 S1 初始态一致）；
  - 旧单元与新单元都 `status='closed'`；写一条 `split` 变更记录。

### 问答记录页

- `client/pages/questions.js`：`{ key: 'questions', order: 70, label: 'questions.panel', Page }`。
- `client/messages/questions.js`：全部中英文案，页面文件无内联中文（`client copy` 用例通过）。
- 顶部：当前学习日窗口、待封口/待摘要、最近 3 条日摘要、主题线索。
- 筛选：近 7 / 30 天、学科（已知学科并集）、闭环状态（服务端 `resolution`）、关键词（服务端 `query`）。
- 列表：时间、学科、题目摘要、闭环状态、重问标记；已合并单元带“已合并”徽标（S1 `list` 仍返回全部状态）。
- 详情：题目、回合原文与角色、信号；“从这里拆开”按回合出现（首个回合不出现）。
- 合并：行首复选框 + “合并所选”，≥2 个才可点；成功后选中目标单元并刷新列表/摘要。
- 全部请求走 `POST /api/study/learning/<method>`；`client/lib/api.js` 的 `WRITE_METHODS` 加了 `learning: ['merge','split']`，由 `createWriteCall` 注入 `requestId` 并在网络失败重试时复用。
- 加载、空、错误、操作结果提示齐全；复用现有页面的内联样式，不引入新样式体系。
- `client/client.js` 与 `client/.build/entry.js` 由 `node plugins/study/scripts/build-client.mjs` 重新生成，产物含 `questions` 页面与 `learning` 写方法。

## 偏差与解释

1. **requestId 带代次后缀，不是字面 `window:<id>`**。kernel 的幂等指纹包含方法名，且同一窗口可能“封口 → 重新打开 → 再封口”或“摘要 → 失效 → 重建”；若一直用 `window:<id>`，重放会跳过第二次真实状态迁移。实现为 `window:seal:<id>:<seals+1>`、`window:summary:<id>:<seals>.<stale>`；同一状态重复调用仍返回同一结果。
2. **重新打开而不是新建同一天窗口**。退出封口后当天继续提问时，`ensureWindow` 把原窗口改回 `open`，保证“一天一个窗口”；摘要仍保留，下一次封口后按新 hash 重建并 `superseded_by`。若按字面“没有 open 就建”，同一天会出现两个范围相同的窗口，摘要会重复计数。
3. **旧窗口日期用“11 月 9 日”而不是“今天”**。模板原文统一写“今天”，补做 3 天前的窗口时那样会误导；仅当窗口日等于当前学习日时保留“今天”。
4. **空窗口 `status='summarized'`、`summary_id=NULL`**。满足“空窗口不生成”摘要行，同时让状态机前进、tick 不会反复重试；`windowStatus.note='empty'` 说明。
5. **14 天按精确时刻**（`now - 14d`）而不是学习日对齐；超过就 `failed`，不做摘要。`attempts` 目前只在“超过补做上限”时 +1；普通内部错误靠下一次 tick 重试，没有次数上限。
6. **合并目标保持自己的 `subject` 与状态**。`subject` 是单列，并集落在 `study_episode_topic`；目标原来是 `open` 也不会被强制关闭，但它已跨会话，后续不会自动接新回合（除非同会话仍在 open 列表里，S1 的懒关闭逻辑不变）。
7. **拆分禁止从第 1 个回合拆**（否则旧单元为空）；两边都 `closed`，主题行复制到新单元，`resolution` 按移动后的信号重算。
8. **合并/拆分/旧单元续写会让日摘要失效**：窗口改回 `sealed` 并 `stale+1`，下一次 tick 重建。计划没有明说这一条，但否则页面会一直展示旧计数。
9. **`learning.list` 增加 `resolution`**：页面“闭环状态”筛选需要服务端过滤和准确 `total`；S1 的工具与旧调用不受影响。
10. **退出封口是 best-effort**：disposer 先同步查库拿当日窗口，再发一次 `sealWindow`。但 Cordis 在同一轮 dispose 里会注销本模块的命名空间，排队中的服务调用在解析命名空间时通常已拿不到 `learning`，因此真实退出时这条路径多返回 `not_found/unavailable`，只打日志。可靠封口由 10 分钟 tick 与下次启动补做保证；这条符合计划“失败只记日志”，但不应当当作退出时一定封口成功。
11. **页面合并交互**是“勾选 + 合并所选”，不是详情里的“合并到…”选择器；拆分是每个回合旁的“从这里拆开”。功能与验收一致，交互更简单。
12. **日摘要正文是中文模板**（计划要求），页面在英文 locale 下仍显示该正文；结构化 `data` 已随摘要返回，后续要做英文摘要可直接渲染。主题线索在页面用 `data` 本地化，不显示宿主中文。
13. 计划列出的 `windowStatus / summaries` 之外没有新增服务方法；tick 是模块内部 orchestrator，不是服务接口。

## 测试结果

本机 Windows，Node v26.13.0。按项目约定在沙箱内用 `--test-isolation=none`（`docs/creator.md` 第 120 行），需要 esbuild 子进程的客户端构建用例在宿主权限下运行。

```text
node --test --test-isolation=none plugins/study/tests/learning
## 23 pass / 0 fail（S1 13 条 + S2 10 条：窗口 7、合并 2、拆分 1）

node --test --test-isolation=none plugins/study/tests/client
## 75 pass / 0 fail（含 buildClient 产物比对与 questions 页 7 条）

node --test --test-isolation=none plugins/study/tests
## 631 例，629 pass / 1 fail / 1 skip（最终全量；失败为下述既有性能抖动）
```

- S2 新增用例覆盖：
  - 固定时钟跨 3 天捕获 → tick 后 3 个窗口、3 份摘要，文本与计数正确；重复 tick 不新增；
  - 同 `input_hash` 复用；改单元后重建、旧摘要 `superseded_by`；
  - 空窗口不生成摘要行；04:00 前归前一天；超过 14 天标 `failed`；
  - 合并两个单元的回合/题目/主题/变更记录；合并后日摘要失效并重建；
  - 从第 2 个回合拆开，回合/题目/信号归属与两边计数正确；
  - open 窗口拒绝摘要；旧单元跨 04:00 续写后摘要重建；
  - 页面纯渲染：定义契约、加载/空/错误/就绪、合并按钮门槛、拆分按钮只在非首回合出现。
- `outcomes/performance.test.mjs` 的月查询中位在最终全量为 106.4ms（预算 100ms），前一次全量 106.5ms，此前还出现过 111.7ms / 117.3ms；同一代码另一次全量为 89.96ms。单独复跑该用例：1 pass，月 81.3ms、周 38.9ms、日 26.7ms。这是 S1 交付记录已记载的既有抖动（`docs/decisions/layout.md` §216 记录过 103–113ms），与本增量无关；未放宽容差。631 例全量中的唯一失败就是这一条，其余 629 例通过（另 1 例为既有的启动后注册命名空间 skip）。
- 构建：`node plugins/study/scripts/build-client.mjs` 成功，产物含 `questions` 页与 `questions.panel` 文案；沙箱内 esbuild `spawn EPERM`，宿主权限下通过。
- 本工作区无 git 提交，无法用 diff 证明“只含自己的改动”。运行期间共享工作区里的 `client/pages/workbench.js` 于 4:49 被并行修改（`restHeading`，配套 `workbench.otherTasks` 文案齐全）；最终 bundle 已按当前源码重新生成，因此产物包含该处无关改动。

## 文件

新增：

- `plugins/study/host/learning/window.mjs`（学习日、建窗、封口、tick、失效、窗口视图）
- `plugins/study/host/learning/summary.mjs`（规则摘要、hash、主题线索、摘要读取）
- `plugins/study/client/pages/questions.js`
- `plugins/study/client/messages/questions.js`
- `plugins/study/tests/learning/helpers.mjs`
- `plugins/study/tests/learning/window.test.mjs`
- `plugins/study/tests/learning/merge.test.mjs`
- `plugins/study/tests/client/questions.test.mjs`
- `docs/plans/2026-11-11-memory-increments/S2-delivery.md`（本文件）

修改：

- `plugins/study/host/modules/learning.mjs`：窗口/摘要/合并/拆分方法，capture 建窗与失效，tick 与退出封口。
- `plugins/study/host/learning/repo.mjs`：合并/拆分 SQL、信号/主题移动、`resolution` 过滤。
- `plugins/study/client/lib/api.js`：`learning: ['merge','split']` 写方法登记。
- `plugins/study/tests/client/build.test.mjs`：产物断言加入 `questions` 页。
- `plugins/study/client/client.js`、`plugins/study/client/.build/entry.js`：构建产物。

未改：表结构与 `schemaVersion`、S1 切分算法、`memory.json`/`memory.mjs`、`source/deepseek-harness`、`registry.mjs` 命名空间列表。

## 窗口边界、补做上限

- 学习日：本地 04:00 – 次日 04:00；`start_at`/`end_at` 存 UTC ISO；单元归属按 `opened_at ∈ [start_at, end_at)`。
- 03:59 的提问属于前一天；04:00 之后属于新一天。
- 补做上限：启动与每次 tick 只处理最近 14 天（`now - 14d` 起）的未完成窗口；更早的 `open/sealed` 窗口标 `failed`，`attempts += 1`，`windowStatus` 返回 `note='backfill_limit'`。
- 空窗口仍然记录一行窗口、`status='summarized'`，但不产生摘要行。

## 已知问题

- **窗口归属只看 `opened_at`**：03:50 打开、04:10 继续追问的单元仍归前一天；跨 04:00 的续写会触发旧窗口摘要失效重建（已测），但它不会把新回合算进新一天。
- **窗口封口不关闭仍 open 的单元**：S1 的懒关闭不变；窗口 `summarized` 后单元仍可被同会话追加，靠“失效 + 重建”保持一致。真正的 enrichment/关闭留 S3。
- **退出封口通常不生效**：见“偏差与解释”第 10 条。窗口会在下一次 tick 或下次启动时补封口，最多延迟 10 分钟；不会丢数据。
- **摘要失败没有尝试上限**：只有“超过 14 天”会记 `failed`；普通异常每 10 分钟重试，`attempts` 不变。
- **摘要正文仅中文**：英文页面显示中文正文；结构化 `data` 可用，但没有英文模板。
- **主题线索行只增不减**：每次摘要写一个新版本，暂无压缩/清理；S4 可清理旧版本。
- **`windowStatus` 只看当前 active goal**：其他目标的窗口由 tick 处理，但状态页不展示。
- **合并/拆分不做二次确认**：页面直接写；校验失败会显示宿主错误。没有撤销按钮（可再拆/再合并，但不会自动回滚）。
- **未做 90 天清理、导出、周窗口、画像/注入**：分别属于 S4/S3。
- **页面只做 Node 纯渲染测试**：没有浏览器级合并/拆分回归；`ui-smoke` 仍只覆盖 today 页。构建与字典校验通过。

## 交接给 S3

可直接使用：

- `learning.windowStatus / sealWindow / summarizeWindow / summaries`；
- `learning.merge / split`（写方法，UI/Agent 调用都要带 `requestId`）；
- 日窗口、日摘要、`study_topic_thread` 最新版本；
- `study_episode_topic` 里的 `subject:<学科>` 行（合并并集）；
- 问答页（按时间/学科/闭环状态/关键词筛选，详情、合并、拆分）。

S3 需要注意：

- 不要假设 `study_topic` 有数据：S2 只写 `study_episode_topic` 与 `study_topic_thread`，没有建主题词典。
- `study_episode.status` 新增了 `merged`（S1 只有 `open/closed`）；查询默认结果可能包含已合并单元，需要时自行过滤。
- `study_episode.resolution` 可能为 `NULL`（无信号）或 `unknown`（有非结论信号），S3 的画像推断不要把 `NULL` 当未闭环。
- 若给 `learning` 增加写方法，记得同步 `WRITE_METHODS`、`client/lib/api.js` 的 `WRITE_METHODS`（只有页面会写的方法才需要）与冻结命名空间测试。
- 不要改 `schemaVersion`；S2 没有新增表。S3 如需 `study_memory_*`，按计划在 `memory` 模块加（`memory` 当前 schema 为空、未被记录）。
- 摘要重建是幂等写：同 `input_hash` 复用；跨窗口聚合只读 `study_window_summary`，不要重算原文。

---

## S3 交付记录

- 会话日期：2026-11-11
- 完成项：memory.json → SQLite 七类记忆迁移；六项讲解参数与 Beta 推断；教学契约替换快照注入；`memory_profile` 工具；记忆页“画像”tab；迁移/trait/页面测试。
- 未完成/偏差：见下文“偏差与解释”与“已知问题”。
- 测试命令与结果：见下文“测试结果”。
- 新增/修改文件：见下文“文件”。
- 下一会话需要注意：见文末“交接给 S4”。

## 完成项

### 数据与迁移

- `memory` 模块的 `schema` 从空数组改为三张表（`study_memory_item`、`study_memory_evidence`、`study_memory_tombstone`），`schemaVersion: 1`；首次打开旧库时 `applyModuleSchemas` 建表并记录 `module_schema.memory = 1`，没有 bump 其他模块。
- 启动顺序：
  1. 建/读旧的 `study_memory_state`（保留这一个 v1 版本，不删）；
  2. 若新表为空且有来源，执行迁移；
  3. 迁移成功后所有读写只走新表；`memory.json` 不再写，保留为导出源。
- 迁移来源：优先 `study_memory_state`（v1 后续写都落在这里），没有该行时读 `memory.json`。两种来源都做完整 v1 校验。
- 备份：只要 `memory.json` 存在，先逐字复制为同目录 `memory.v1.backup.json`；只有 state 行时把 state 序列化写入同一备份文件。已有备份不覆盖。
- 导入：保留 id、`createdAt/updatedAt`、`expiresAt → valid_until`、`source.actor → source_actor`、kind、goalId（缺失填当前目标）；`source_kind='explicit'`、`status='active'`、`confidence=1`。墓碑写 `content_hash`、`goal_id`、`deleted_at`、`source_json`。
- 校验与回滚：导入与校验在同一个 `database.transaction` 内；条数、每条正文、每个墓碑 hash 任一不一致即抛错，事务回滚，新表保持为空。
- 失败回退：迁移抛错时 `console.warn`，模块进入只读 v1 回退——`remember/recall/forget/profile*` 返回 `unavailable`，消息带 `memory.v1.backup.json` 与根因；契约注入改用旧 state/文件内容渲染 v1 快照（正文也坏时返回“学习记忆暂时无法读取”）。`memory.json` 不删、不改。
- `remember/recall/forget` 的载荷、返回字段（`item.source.actor`、`expiresAt`、`expired`、`kindLabel` 等）与 v1 保持一致；墓碑抑制、只有 `actor='ui'` 才能 `revokeTombstone` 的规则不变。

### 七类记忆

- `study_memory_item.kind` 支持 `preference / state / observation / trait / topic_state / strategy / episode`，索引 `(goal_id, kind, status)`。
- 本轮有写入者的是前三类（v1 API）与 `trait`；`topic_state / strategy / episode` 只建表、无写入，留给 S4。
- 版本模型：superseded 行保留 `status='active'` 与 `valid_until`，`superseded_by` 指向新行；当前行 = `status='active' AND superseded_by IS NULL`。显式退出才用 `status='retired'`；本轮没有显式退出入口，衰减只原地改档。

### Trait

六个固定参数（顺序即契约顺序）：

| key | 值域/步长 | 默认 | 推断 |
| --- | --- | --- | --- |
| `explain_detail` | 1–5 / 1 | 3 | 是 |
| `hint_preference` | 0–1 / 0.5 | 0.5 | 否，仅显式 |
| `pace` | -1–1 / 1 | 0 | 否，仅显式 |
| `example_first` | 0–1 / 0.5 | 0.5 | 否，仅显式 |
| `step_granularity` | 1–3 / 1 | 2 | 否，仅显式 |
| `check_frequency` | 0–2 / 1 | 1 | 否，仅显式 |

- Beta 计算严格按说明：`α=β=1`，正/负权重按 `0.5^(age_days/56)` 衰减，`value=(α+Σpos)/(α+β+Σpos+Σneg)`，`confidence=1-sqrt(value(1-value)/(α+β+Σw+1))`。
- `explain_detail` 证据：
  - 重问：`study_episode_problem.reasked_from` 非空，且新题与原题的 `created_at` 间隔 ≤7 天；权重 1.0；
  - 干净闭环：`resolution='understood'`、无 `confused` 信号、名下题目 `reask_count` 全为 0；权重 0.5。
  - 说明里的“（负）/（正）”按“结果好坏”理解：重问是坏结果，因此作为“需要更详细”的正权重；干净闭环是好结果，作为负权重。见“偏差”第 2 条。
- 自动生效：`confidence ≥ 0.70` 生效；`0.50–0.70` 只有 `example_first / step_granularity` 可生效（本轮无推断，只会是显式设置后 confidence=1）；`< 0.50` 用默认。
- 敏感项冷启动：`explain_detail`（以及未来若推断 `pace`）首次生效需 ≥3 个独立单元且 ≥14 天证据跨度；之后不再检查。
- 抖动上限：当前推断版本 `valid_from` 起 7 天内最多变 1 档；超过 7 天一次也只走 1 个 step，下一次再走。用户显式 `set` 不受限制。
- 衰减：最新证据超过 8 周（56 天）视为过期，当前推断项**原地**回落到默认档（写 `trait.decay` 变更记录，不改 `status`）；`status='retired'` 只留给显式退出，本轮没有显式退出入口。证据本身仍参与 `explain` 展示。
- 触发：`learning` 在 `capture/merge/split` 提交后通过 `setImmediate` 发 `study/learning/changed` 事件；`memory` 监听后调用 `memory.refreshTraits`（`actor=system`，新的 requestId）。事件在事务提交后到达，避免嵌套事务。
- `refreshTraits` 是唯一会写 `trait` 的服务方法；每次写新版本时同时重写该版本的 `study_memory_evidence` 行，并写 `change_log`（entity=`memory`，action=`trait.change` / `trait.decay` / `trait.correct`）。
- `traitCorrect`：`profileSet` 立即生效、`confidence=1`、旧版本 `superseded_by` 指向新行；同一用户档位重复设置只更新确认时间，不新增版本。
- 用户纠正优先：纠正后的 infer 计算只看纠正时间之后的新证据；至少 3 个独立单元且跨度 ≥14 天，才允许推断重新取代用户值（见“偏差”第 7 条）。

### 教学契约

- 仍注册为 `systemPrompt.context({ name: 'study:memory', order: 500 })`，替换原 `renderSnapshot`。
- 有非默认生效参数时输出：

~~~text
【讲解契约】
详细度 4/5（补前置 + 推导 + 例子）；解题先给提示再给答案；推进速度偏慢。
这是讲解假设，不是评价；不要复述本段，也不要据此降低任务要求。

【相关记忆】
- 偏好：……
- 观察（待确认）：……
~~~

- 契约只写参数，不写证据 id、置信度、依据或“为什么”；默认档参数不写，因此“改回默认”会让对应子句消失。详细度档位按设计 §8.1 的 1–5 映射编译成括号里的短约束（如 4 → 补前置 + 推导 + 例子），让“变细”可执行。
- 一个非默认参数都没有时回退 v1 快照（最多 8 条、每条 120 字）；此时文本与 S1/S2 的快照格式相同。
- 有参数时相关记忆最多 4 条、每条 50 字，避免超出 300 token 预算；典型契约 250–400 字符。
- DSH 的 runtime-context 只在文本变化时写快照，同一会话内不会每步重复注入；契约文本随参数变化，下一轮即可看到。
- 读取时的参数来自 `evaluateAllTraits`（实时计算 + 已存版本/周上限/用户纠正），因此即使 `refreshTraits` 的持久化因事件队列晚一拍，下一轮契约仍然按最新证据计算。

### 工具与界面

- 服务方法：`profileGet`（读）、`profileExplain`（读）、`profileSet`（写）、`refreshTraits`（写）；写方法已加入 `writes` 与 `client/lib/api.js` 的 `WRITE_METHODS.memory`。
- `memory_profile` 工具：`get / explain / set`。`set` 只在学生明确要求时使用，带 `requestId`；`explain` 返回证据 id 与时间，仅用于核对，不作为对话内容。
- 记忆页 `client/pages/memory.js`：
  - tab：“记忆” / “画像”，默认“记忆”；
  - 画像行：参数名、行为描述、当前档位、`依据 N 次问答`、`降一档 / 升一档 / 恢复默认`；手动设置的参数带“手动设置”徽标；
  - 恢复默认 = `profileSet(key, defaultLevel)`，下一轮契约即回到 v1 快照；
  - 所有写走 `POST /api/study/memory/profileSet`，页面生成 `requestId`。
- 文案全部在 `client/messages/memory.js`，页面无内联中文；`client/client.js` 与 `.build/entry.js` 已重新构建。

## 偏差与解释

1. **迁移来源优先 state 行，不总是 memory.json**。v1 在首次导入后只写 `study_memory_state`，文件可能落后；按文件导入会丢新记忆。文件仍逐字备份，state 行也仍保留。全新库只有文件时，行为与说明完全一致。
2. **“（负）/（正）”的符号按“结果”解释，而不是 Beta 权重方向**。`value` 定义为“需要更详细”，所以重问（坏结果）是正权重、干净闭环（好结果）是负权重；否则演示“重问后变细”与档位公式自相矛盾。权重的最终效果与 `§9` 的“5 次重问 → 升 1 档”一致。
3. **自动推断不会低于默认档**。干净闭环是负权重，若完全照公式，顺利的学生会被降到 1 档；实现把推断下限钳在默认 3 档，避免“学得好反而讲得更少”。用户显式设置的 1 档仍会保留。
4. **0.50–0.70 档位在实践中不可达**。按说明公式，`α=β=1` 时无证据的 confidence 就是 0.7113，证据只会让它更高；因此规则证据永远走 ≥0.70 分支。阈值函数仍按说明实现，并用合成 confidence 单测 0.69/0.71；0.50–0.70 分支保留给未来公式调整或外部写入。建议 M6 校准 `α+β` 或分母后再启用该分支。
5. **“14 天无证据回落”按两处规则拆开**。设计 `§6.2` 写“8 周无新证据回落默认”，`§9` 写“14 天无证据回落”；实现采用 8 周衰减回退，并把 14 天作为敏感项冷启动的“数据跨度”要求。两者都有单测；若审核要求 14 天回退，改 `EVIDENCE_TTL_DAYS` 一处即可。
6. **契约记忆条数与长度比 v1 小**。`§7` 示例与 `§5` 的 v1 回退是 8 条；契约正文要 ≤300 token，因此有参数时只放 4 条 × 50 字，无参数的回退仍用 8 条 × 120 字。
7. **用户纠正不是永久锁死**。修正后推断只看纠正之后的新证据，且要重新满足 3 单元/14 天冷启动才可取代；否则旧证据会立即把用户刚调回的默认又推高。说明书没有写这条，是“纠正后下一轮立即恢复”与“未来仍可自动生效”之间的折中。
8. **只读回退仍会先写 legacy state 副本**。迁移失败时新表保持为空，但启动第一步可能已把 `memory.json` 复制进 `study_memory_state`（v1 一直这么做）。它不参与新表读写，只用于回退渲染与审计；原文件不动。
9. **全新库里 `study_memory_state` 可能没有行**。没有 v1 来源时不再无条件插入空 state；只有存在文件或 state 行时才保留一份。旧库不受影响。
10. **`refreshTraits` 是最终一致的**。事件用 `setImmediate` 在写事务提交后发出，再经内核串行队列执行；契约和 `profileGet` 实时计算，因此演示不依赖持久化先完成。代价是 `study_memory_evidence` 可能晚一拍，`profileExplain` 也按实时证据返回，不读旧行。
11. **`hint_preference / pace` 没有推断**。说明 `§2` 说“三个可推断 trait”，但 `§6.1` 明确这两个“仅显式 set”；实现按后者：三个“可自动生效”的参数里只有 `explain_detail` 有规则证据，另两个由学生显式调整。
12. **`memory_profile set` 允许 `actor='agent'`**。模型转述学生“讲细一点”时也能调；页面写入是 `actor='ui'`。若后续要求只有 UI 能改，可在 `profileSet` 加 actor 校验。
13. **没有做浏览器点击级冒烟**。画像页有 6 条 Node 纯渲染用例（定义、tab、档位/证据/徽标、按钮回调、边界禁用、加载/错误态），构建与字典审计通过；真实 Host+浏览器点击留待整体验收。
14. **没有 `memory.export()`**。S4 需要从表生成 `memory.json` 兼容快照；本轮只保留“memory.json 不再写、作为导出源”的约定。
15. **`session_tolerance` 未实现**。设计 `§5.4` 列了 7 个 trait，S3 说明只列 6 个（用 `pace` 代替 `session_tolerance`）；S4 的导出要求也是 6 个。

## 测试结果

本机 Windows，Node v26.13.0。命令：

~~~text
node --test --test-isolation=none plugins/study/tests
## 656 例，655 pass / 0 fail / 1 skip（既有的“启动后注册命名空间”用例）；11562ms
## outcomes/performance 本次通过，未复现既有月查询抖动

node --test --test-isolation=none plugins/study/tests/memory
## 33 pass / 0 fail（15 个 v1 行为用例 + 5 个迁移用例 + 13 个 trait/契约用例）

node --test --test-isolation=none plugins/study/tests/client
## 81 pass / 0 fail（含新增的 6 条 memory 页用例）

node plugins/study/scripts/build-client.mjs
## ok=true，bytes=485610，pages 含 memory（以及其他既有页面）

node plugins/study/tests/memory/tool-smoke.mjs
## passed=true；12 条断言全部 true（见“工具冒烟”）
~~~

### 共享工作区说明（重要）

- 12:59–13:01 之间，同一工作区出现并行 S4 的 `host/modules/review.mjs`、`host/learning/topics.mjs|analysis.mjs|prune.mjs`，`learning.mjs` 也被并行扩展。`review.mjs` 先于 `registry.mjs` 的 `review` 命名空间与测试更新落地，因此 13:0x 之后任何启动完整插件的用例都会报 `未知服务命名空间 “review”`。
- 该失败与 S3 无关。S3 的全量绿灯记录是并行文件出现前的一次 **656 / 655 pass / 0 fail / 1 skip**；并行文件出现后单独运行 `plugins/study/tests/memory`（33/33）与 `plugins/study/tests/client`（81/81）仍通过。
- 为把并行中间态与 S3 改动分开，另把 `plugins/study` 复制到同深度的 `plugins/study-s3check`，只移除未完成注册的 `review.mjs`，运行同一套全量：**656 / 655 pass / 0 fail / 1 skip**。这证明 S3 代码在并行 learning 扩展存在时仍全绿；副本已删除。审核时请以 S4 完成后的全量结果为准，不要把那次 177 例失败算作 S3 回归。
- 并行 S4 改到的 `learning.mjs` 保留了本轮的 `study/learning/changed` 事件与 capture/merge/split 包装；S3 的 `queueLearningChange` 仍在其写入路径上。
- 13:02–13:03 并行 S4 又改了 `client/lib/api.js`（review 写方法）与 `client/pages|messages/outcomes.js`，使 12:51 为 S3 构建的 `client/client.js` 相对并行源码落后；随后一次全量仅剩 `build.test.mjs` 的“产物与当前源码不一致”。S3 的 memory 页已在 12:51 构建中，S4 会话收尾时应重新运行 `node plugins/study/scripts/build-client.mjs`；S3 不在这段时间重建共享产物，以免把半改的 outcomes 页打进 bundle。

- 迁移用例：备份逐字一致；3 类条目 + 2 个墓碑的字段映射；state 行来源；幂等/重启；迁移后不再写 memory.json；触发器注入失败 → 新表 0 行、文件不变、备份存在、方法 `unavailable` → 去掉触发器重启后迁移成功。
- Trait 用例：5 次重问（16/12/8/4/0 天，5 单元）→ value 0.8471、conf 0.8964、level 4；8 天后第二波 → level 5；7 天内不升第二档；2 单元或 10 天跨度 → `cold_start`；0.69/0.71 阈值；8 周后原地回默认并写 `trait.decay`；merge 掉证据单元 → 回默认；`profileSet` 立即写新版本且旧行 `superseded_by`；纠正后被新证据覆盖需要 3 单元/14 天；契约不含证据/置信度且空态回退 v1。
- 页面用例：tab 切换、六行 trait、档位/证据/手动徽标、±1 步与恢复默认回调、边界禁用、加载/错误态、构建字典键一致。
- 既有 v1 行为未放宽：15 个用例的断言仍检查来源、时间、kind、过期、墓碑抑制、关键词召回、requestId 幂等、计划字段拒绝；只是把 `study_memory_state` 的 JSON 断言改成 `study_memory_item` / `study_memory_tombstone` 查询。
- 本机缓存/清理：测试临时目录用 `rmSync` 尽力清理；Windows 下重开数据库时 WAL 文件可能让 `fs.rm` 重试很久（曾让 teardown 挂住），teardown 不要用带重试参数的异步 `rm`。

### 真实数据演练

- 开始前已备份 `.studybuddy/study` 的 `study.db`、`study.db-wal`、`study.db-shm` 到 `evidence/S3/study.pre-s3.db*`，SHA-256 记录在 `evidence/S3/backup-manifest.json`。该目录原本没有 `memory.json`。
- 在备份副本上跑迁移演练（`evidence/S3/real-data-rehearsal.json`）：`PRAGMA integrity_check = ok`；旧 `study_memory_state` 存在但 0 条记忆、0 个墓碑；迁移 0 条；生成 `memory.v1.backup.json`（54 字节，空 v1 结构）；`module_schema.memory = 1`；`profileGet` 返回 6 个默认 trait；契约为空。
- 没有对真实 `.studybuddy/study` 执行迁移；下次启动应用时会按上述路径执行。

### 工具冒烟

`node plugins/study/tests/memory/tool-smoke.mjs` 通过：`passed: true`，12 条断言全 true：

- 工具侧：保存偏好、新会话注入、召回工具命中、删除、新进程不再注入、旧对话重建被“未写入”拒绝、重建后仍不注入；
- 表侧：`tableRemembered`（item 行 kind/text/status/source_kind 正确）、`tableItemDeleted`（item 表 0 行）、`tableTombstoneWritten`（墓碑 1 行）、`tableNotRebuilt`（重建后 item 仍 0 行）。
- 冒烟里 headless 数据目录没有 goal，迁移/记忆的 `goal_id` 是 `unassigned`，与 v1 一致。
- 首次运行出现 `conflict：同一个 requestId 已用于不同内容`：mock 执行器在不同步骤复用了同一个 callId，而 `memory_remember` 与 `memory_forget` 都是写方法。已在工具参数里显式给三个写步骤稳定且各自唯一的 `requestId`；复跑通过。

## 文件

新增：

- `plugins/study/host/memory/store.mjs`（三表 DDL、item/evidence/tombstone CRUD、映射）
- `plugins/study/host/memory/migrate-v1.mjs`（v1 解析、备份、事务导入、校验）
- `plugins/study/host/memory/traits.mjs`（Beta、阈值、档位、证据、契约编译）
- `plugins/study/tests/memory/helpers.mjs`（真实 SQLite/kernel 测试台、事件总线、固定时钟、证据播种）
- `plugins/study/tests/memory/migration.test.mjs`
- `plugins/study/tests/memory/traits.test.mjs`
- `plugins/study/tests/client/memory.test.mjs`
- `docs/plans/2026-11-11-memory-increments/S3-delivery.md`（本文件）
- `docs/plans/2026-11-11-memory-increments/evidence/S3/`：
  - `backup-manifest.json`
  - `real-data-rehearsal.json`
  - `memory-tool-smoke.json`
  - `study.pre-s3.db`、`study.pre-s3.db-wal`、`study.pre-s3.db-shm`

修改：

- `plugins/study/host/modules/memory.mjs`：schema、迁移入口、七类存储、`profileGet/Explain/Set`、`refreshTraits`、事件监听、契约注入、`memory_profile` 工具。
- `plugins/study/host/modules/learning.mjs`：capture/merge/split 提交后发 `study/learning/changed`（`setImmediate`，无监听/失败只忽略或告警）。
- `plugins/study/tests/memory/memory.test.mjs`：断言改读 `study_memory_item` / `study_memory_tombstone`；损坏文件用例改为启动前准备坏文件。
- `plugins/study/tests/memory/tool-smoke.mjs`：改为读表校验 item/tombstone；三个写工具显式带稳定 requestId。
- `plugins/study/client/pages/memory.js`、`plugins/study/client/messages/memory.js`：画像 tab、文案。
- `plugins/study/client/lib/api.js`：`memory.profileSet` 写入登记。
- `plugins/study/client/client.js`、`plugins/study/client/.build/entry.js`：构建产物。

未改：`source/deepseek-harness`、S1/S2 的表结构与切分算法、`host/registry.mjs` 命名空间列表、`memory.json` 的 v1 读取格式。

## 交接给 S4

可直接使用：

- `memory.profileGet / profileExplain / profileSet / refreshTraits`；
- `study_memory_item`（七类 kind、版本、`superseded_by`）、`study_memory_evidence`、`study_memory_tombstone`；
- `host/memory/traits.mjs` 的 `TRAITS`、`evaluateAllTraits`、`gateConfidence`、`decideTrait`、`levelOf/valueOfLevel`（S4 的 `profile` 输出与导出可复用）；
- `study/learning/changed` 事件（`{ kind: 'capture'|'merge'|'split', episodeId?, episodeIds? }`），S4 新增学习写方法时按同样方式在提交后发事件；
- 教学契约模板与 v1 回退。

S4 需要自己补：

- `memory.export()`：从 `study_memory_item`/tombstone 生成 memory.json 兼容快照，不要读 `study_memory_state`；
- `topic_state` 的写入/覆盖与 `detail_override`（S4 说明明确放到 S4）；
- `review` 模块与周报；
- 90 天正文清理、导出、周页分析卡；
- 若要启用 0.50–0.70 的软阈值分支，先改 confidence 公式并补校准测试（见偏差第 4 条）。

## 已知问题

- **真实演示未做**：没有在桌面应用里连续重问 5 次并截图；trait/契约由服务级用例与真实数据演练覆盖。验收时建议用种子数据走一次页面。
- **`profileExplain` 的证据是实时推导**：不读 `study_memory_evidence` 旧行；合并/衰减后立刻准确，但历史版本证据只能从 change_log 与旧 item id 反查。
- **`refreshTraits` 可能被事件风暴放大**：每次 capture 都重算一次；当前只有 6 个 trait、几次查询，未做节流。S4 若增加更多推断 trait，考虑合并请求。
- **用户纠正的“3 新单元/14 天”是新增规则**，说明未写；按“纠正后立即恢复、之后仍可自动生效”的折中实现。
- **confidence 下限 0.7113** 使阈值 0.50–0.70 实际不可达；已单测阈值函数本身。
- **契约里的记忆是中文正文**：英文界面下仍显示记忆原文；正文是数据，不是硬编码文案。阶段内不翻译记忆。
- **页面没有删除/否认 trait 的入口**：只有降/升/恢复默认；说明里的“否认 → rejected + 墓碑”留给后续或 S4，本轮 `profileSet` 只写 `user_edit`。
- **`study_memory_state` 仍保留原始 v1 快照**：只在迁移前写入；S4 导出不要把它当权威。
- **没有对真实 `.studybuddy` 执行迁移**：演练在备份副本上完成；下次启动应用才真正迁移。备份见 `evidence/S3/`。

---

## S4 交付记录

- 会话日期：2026-11-11
- 完成项：主题聚类、弱主题排序与方法信号、`study_insight` 工具、`review` 周/月报、周页分析卡、90 天正文保留、JSONL 与画像导出、测试。
- 未完成/偏差：见下文“偏差与解释”与“已知问题”。
- 测试命令与结果：见下文“测试结果”。
- 新增/修改文件：见下文“文件”。
- 下一会话需要注意：见文末“交接与后续”。
- 完工状态：**已完成**；§12 验收对照见下。

## 验收对照（§12）

| 验收项 | 结果 |
| --- | --- |
| 对话中请求分析 → 工具返回带引用的弱主题与信号 | `study_insight` 工具用例覆盖 `weak_topics/method_signals/review_build/review_save/profile`；弱主题每条带最近 3 题引用，报告引用题目/摘要 id。 |
| 周页显示 3 条要点，展开可见完整报告，刷新不重复生成 | `outcomes-review.test.mjs` 覆盖 3 条要点、展开、生成、刷新、错误、非 week 模式；`week.test.mjs` 覆盖同证据复用、变更后才 supersede。 |
| 90 天清理后，弱主题/周报仍可算 | `analysis.test.mjs` 的保留用例清理 91 天前正文后，统计不变、日摘要仍可读，并成功生成 `review.week`。 |
| 导出可读 | `export.test.mjs` 校验 JSONL 行数=单元数、默认不含回合正文、sketch 保留；`memory.export` 校验 v1 兼容快照与 6 行画像 Markdown。 |
| 交付记录写明公式参数、信号阈值、已知误判 | 下方“弱主题/方法信号/已知问题与误判”三节。 |

## 完成项

### 主题聚类

- 候选：同一目标下最近 90 天、`sketch` 非空、所属单元未合并的题目（`study_episode_problem` JOIN `study_episode`）。
- 同 `subject` 内贪心聚类：题目与簇代表 sketch 的 Jaccard ≥ 0.5 就加入最相似的簇，否则新建；代表取簇内第一题。
- 簇大小 ≥ 2 才建主题；名称取簇内词频最高的 3 个 token 拼接，重叠 bigram 会合并（“函数/数可/可微”→“函数可微”），最多 20 字。
- 写 `study_topic`（`topic_<8hex>`）和 `study_episode_topic`（`confidence=簇内平均相似度`，`source='rule'`）。
- 同目标、同 subject、同 name 的主题复用；重跑会先删掉候选单元的旧 rule 主题关联，再按本次聚类重建，重复执行不新增行。
- `subject` 存在 `study_topic.aliases_json`（`{"subject":"数学"}`），因为 S1 的 `study_topic` 没有 subject 列；这是本增量的已知取舍。

### 弱主题

公式按说明实现：

```
n = 主题下题目数
reaskRate = 有重问的题目 / n
unresolvedRate = 所属单元 resolution='unresolved' 的题目 / n
recency = min(1, 距上次成功天数 / 21)；无成功记录时取 1
selfDifficulty = 0.5（本阶段没有自评难度来源，保留公式参数）
sample = n / (n + 3)
weakness = sample × (0.4·reaskRate + 0.3·unresolvedRate + 0.2·recency + 0.1·selfDifficulty)
```

- `n < 3` 不进入排序，计入 `skipped`；若没有任何主题达到样本门槛，整体返回 `{ status: 'insufficient' }`。
- 状态：
  - `weak`：`weakness ≥ 0.5` 且有失败信号（重问或未闭环）；
  - `forgotten`：有过闭环，且最近 30 天出现重问；
  - `stable`：达到样本门槛但没有弱信号（三态之外的稳定态，避免把“不弱”硬塞进“未接触/薄弱/遗忘”）；
  - `untouched`：保留给“主题存在但 0 道题”的字典数据；当前聚类只建 ≥2 道题的主题，所以实际不会产出。
- 每条返回 `topicId/name/subject/score/n/reaskCount/unresolvedCount/reaskRate/unresolvedRate/recency/state/stateLabel/evidence/suggestion/lastSuccessAt`；`evidence` 是最近 3 道题的 id、所属单元与时间。
- `unresolvedRate` 用所属单元的 `resolution`，因为 S1 的问题行 `resolution` 基本保持 `NULL`；这是对说明“未闭环题目”的落地解释。

### 方法信号

四条信号都返回 `{ kind, title, detail, evidence, counterEvidence, confidence }`，阈值写为导出常量：

| 信号 | 阈值 | 反证 |
| --- | --- | --- |
| 同类反复 `same_topic_reask` | 同主题最近 7 天重问 ≥3 | 可能是按复习计划重做 |
| 时段低效 `night_inefficiency` | 22:00–02:00 重问率比日间高 ≥20 个百分点，且夜间样本 ≥3 道 | 夜间样本少，可能与当天难度/疲劳有关 |
| 集中突击 `burst` | 单日 ≥5 个单元，随后 3 个学习日为 0 | 可能是一次专题突破，之后本来就要消化 |
| 未闭环积压 `backlog` | 未闭环题目 ≥5，且最早一道 >14 天 | 可能是刻意搁置、准备之后再处理 |

- 时间窗口默认最近 30 天；夜间按本地时间判断；单日按 04:00 学习日归并。
- 每条信号的 `evidence` 都有题目/日期或窗口引用，`counterEvidence` 非空。

### 工具与报告

- `study_insight` 工具：`weak_topics / method_signals / review_build / review_save / profile`。
  - `weak_topics`、`method_signals` 先调用 `learning.refreshTopics` 刷新聚类，再读分析；
  - `review_build` 调 `review.week|month({save:false})`，返回证据包（画像 6 参数、最近 4 个周期统计、Top5 弱主题各最多 3 例、信号、最近 3 条日摘要）；
  - `review_save` 调 `review.week|month({save:true})`，生成并保存规则版报告；
  - `profile` 读 `memory.profileGet`。
- `review` 命名空间：`week / month / list / save`，写方法为 `week/month/save`。
  - `week({date})`：按 04:00 学习日取周一至周日，`period=2026-W46`，数字取 `learning.stats`，日摘要取 `learning.summaries`，弱主题/信号取本增量分析，画像变化取 `change_log`（entity=`memory`）。
  - 报告固定四段：`我看到的` / `我的解释` / `建议你试的` / `需要你确认的`；建议 1–3 条，每条带“怎么判断有效”；不出现能力/心理诊断。
  - 证据包含 `stats`、`weakTopics`、`signals`、`summaries`、`profileChanges`、`citations`、`bullets`、`evidencePackage`。
  - 同周期同证据重复生成复用当前行（`reused=true`）；证据变化才插入新行，旧行 `superseded_by` 指向新行，当前行始终只有一条。
  - `month` 聚合自然月，并引用该月内已生成的 active 周报；`period=YYYY-MM`。
  - `list({kind,date?,period?,limit?})` 只读当前 active 报告；`save` 可存调用方提供的 Markdown（仍走 supersede 规则）。
- 工具 `study_insight` 的 `review_build` 返回 `evidencePackage`，不把完整报告塞进证据包；`review_save` 才落库。

### 周页卡片

- `outcomes` 页 week 模式、现有统计表下方新增“本周学习分析”卡：
  - 3 条要点（`bullets`）；
  - “生成/刷新”按钮，写操作走 `createWriteCall` 注入 `requestId`；
  - “展开/收起”显示完整 Markdown；
  - 无报告时只显示生成按钮，不自动生成，也不调用模型；
  - 读取用 `review.list`，按钮才调 `review.week`。
- 文案全部在 `client/messages/outcomes.js`，页面无内联中文。

### 90 天保留

- `learning.prune({ now? })`：
  - `study_turn.at < now-90d` 且 `text_pruned_at IS NULL` → `text=NULL`、`text_pruned_at=now`；
  - `study_episode_problem.created_at < now-90d` → `text=NULL`、`norm=NULL`；
  - 保留 `hash`、`sketch`、状态、单元摘要、统计与主题关联；不删除行、不写墓碑。
- 启动时跑一次，之后每 24 小时一次（`setInterval` + `ctx.effect` 清理，`unref`）；维护路径直接写库，不 bump revision。
- 问答页详情：当所有回合正文都已清空且带 `textPrunedAt` 时显示“正文已按 90 天保留策略清理，摘要与统计仍保留”；单个已清理回合显示“正文已按 90 天保留策略清理”。

### 导出

- `learning.export({ from?, to?, goalId? })` → `{ from, to, goalId, count, jsonl }`：
  - 每行一个单元，含单元字段、题目（id/position/text/hash/sketch/status/reask 信息）、信号、主题、回合元数据；
  - 默认不含回合原文；90 天清理后题目 `text` 为 `null`，`hash/sketch` 仍在。
- `memory.export()` → `{ version: 1, items, tombstones, exportedAt, profileMarkdown }`：
  - `items/tombstones` 是 `memory.json` v1 兼容结构，只含 `preference/state/observation`（v1 解析器不认识 trait/topic_state，强行塞入会导致不可读）；
  - `profileMarkdown` 额外附 6 个 trait 的 Markdown，满足“画像 Markdown 含 6 个 trait”的验收；
  - 不写文件，由调用方决定落盘。

## 偏差与解释

1. **`review.week/month` 是写方法**。页面首次打开读 `review.list`，只有点“生成/刷新”才调 `review.week`。这样满足“无报告时显示按钮、不自动生成”，也避免 GET 式读取产生报告行。
2. **`study_insight review_build` 复用 `review.week({save:false})`**，没有单独加 `review.build` 方法；证据包从返回值的 `evidence.evidencePackage` 取。`review_save` 直接生成并保存规则版，不让模型自由写报告，避免无模型阶段的叙述漂移。
3. **新增 `learning.refreshTopics` 写方法**。说明未列该方法，但 `study_insight.weak_topics/method_signals` 需要在没有新报告时也能拿到最新聚类；它带 `requestId`、写 `change_log`，可安全重放。
4. **`subject` 放进 `study_topic.aliases_json`**。S1 的 `study_topic` 没有 subject 列，本增量不改表结构/SchemaVersion；读取时解析 aliases。若后续要做主题字典，加列比继续塞 JSON 更合适。
5. **`stable` 是第四态**。说明只列未接触/薄弱/遗忘；但达到 n≥3 且分数低于 0.5 的主题需要一个中性状态，否则会被误标成“未接触”。`untouched` 仍保留映射，只是当前没有主题字典数据。
6. **`selfDifficulty` 固定 0.5**。本阶段没有自评难度入口；公式参数保留，S4 不新增问卷式自评。后续要启用时，把来源写进 `study_memory_item` 或 `study_episode.confidence` 再改这一处。
7. **`unresolvedRate` 按单元 resolution 统计**。S1 的 `study_episode_problem.resolution` 目前不维护，问题是否闭环由所属单元的 `resolution` 表示；这与 S2 的统计口径一致。
8. **主题聚类在“刷新”时执行，不另起定时器**。90 天清理有启动+24h 定时；聚类由 `learning.refreshTopics`、`review.week/month`、`study_insight` 触发。没有新增后台任务，避免测试和 headless 退出时留下定时器。
9. **月报按自然月聚合，可能覆盖 4–5 个周报**。说明写“聚合 4 周”，实现取整月 + 月内 active 周报；跨月周的归属按报告 `from/to` 与月份重叠判断。
10. **历史周报的弱主题/信号用当前分析**。数字（stats/日摘要）按周期取，但主题关联与方法信号使用“现在”的 90 天/30 天窗口；回看很旧的周报时，解释部分可能反映之后的数据。要彻底历史化需要给每个周报冻结主题/信号快照，留给后续。
11. **`memory.export` 只导出 v1 三类**。`memory.json` v1 解析器只接受 preference/state/observation；七类全塞会不可读。画像另用 `profileMarkdown`，trait/topic_state 的历史版本不在 v1 快照里。
12. **周页卡片只做 Node 纯渲染测试**。没有浏览器点击级回归；构建、字典校验与全量测试通过，真实桌面点击留整体验收。
13. **`review` 报告行不存 `bullets` 独立列**。bullets 放在 `evidence_json.bullets`，避免改 S4 说明给定的表结构；读取时兼容从 Markdown 的“我看到的”列表回退提取。
14. **`learning.export` 的 `from/to` 日期只按 UTC 日界**。沿用 S1/S2 的 `normalizeBound`，ISO 时间则原样；这是既有口径，不在本增量改。
15. **S3 交接提到 `topic_state`/`detail_override`**。S4 说明的 §2 范围没有要求写 `topic_state`，本轮未写；弱主题/报告全部实时计算。若后续要按主题覆盖详细度，再复用 S3 的 `study_memory_item` + evidence 工具。

## 已知问题与误判

- **同类反复**可能只是间隔复习，不是“没学会”；反证已写进信号与报告。
- **时段低效**在夜间样本少时容易误判；阈值要求夜间至少 3 道，但无法排除当天题目难度/疲劳。
- **集中突击**可能是刻意专题突破；“随后 3 天为 0”也可能只是没记录，不等于没学习。
- **未闭环积压**可能是刻意搁置；报告只建议先清理最早一道，不下“拖延”结论。
- **聚类**对“同 subject 但 top token 相同”的不同簇可能合并；名称只取 3 个 token，20 字截断后也可能撞名。当前按同目标/同 subject/同 name 复用，后续需要主题字典或人工拆分。
- **重问检测**在 90 天清理后只能靠 `sketch` 相似度（S1 规则），不能声称“同一题”。
- **报告统计口径**：闭环/未闭环按单元数，题目数按问题行；两者不互相换算，报告里已分别写明“次”和“道”。
- **性能用例**有既有抖动：S2 交付记录已记载；本轮全量最终 679 pass / 0 fail，单独复跑月查询 81.2ms；之前几次全量曾出现 108–110ms 的既有失败。
- **没有写 `topic_state`/画像自动更新**：报告里的“画像变化”只统计 S3 已有的 `change_log`（entity=`memory`），不新增 trait 推断。
- **没有做真实桌面周页点击**：纯渲染用例覆盖 3 条要点、展开、生成、刷新、错误态与空态。

## 测试结果

本机 Windows，Node v26.13.0。命令：

```text
node --test --test-isolation=none plugins/study/tests
## 680 例，679 pass / 0 fail / 1 skip（既有的“启动后注册命名空间”用例）；12505ms

node --test --test-isolation=none plugins/study/tests/learning plugins/study/tests/memory plugins/study/tests/review
## 74 pass / 0 fail

node --test --test-isolation=none plugins/study/tests/client
## 87 pass / 0 fail

node plugins/study/tests/memory/tool-smoke.mjs
## passed=true，exit 0

node plugins/study/scripts/build-client.mjs
## ok=true，bytes=494000
```

- S4 新增用例：
  - 聚类：3 道相似题 → 1 个主题；2 道不相似题不建主题；重跑复用主题且不重复关联。
  - 弱主题：4 道重问 + 未闭环 → `weak`、分数过 0.5、证据 3 条、建议含主题名；n=2 → `insufficient`；曾闭环近 30 天重问 → `forgotten`。
  - 信号：同类反复 3 vs 2；夜间 20 点差 vs 无差异；突击 5 vs 4；积压 5 道 20 天 vs 5 道 10 天；每条反证非空。
  - 保留：91 天前回合正文/题目正文/norm 清空，`hash/sketch` 与统计不变，日摘要仍可读，二次清理 0 变更。
  - 导出：JSONL 行数=单元数，默认不含回合正文，题目 sketch 保留；`memory.export` 含 v1 三类 + 墓碑 + 6 行画像 Markdown。
  - 周报：固定 7 天 fixture 的数字与 `learning.stats` 一致；同证据重复生成复用；新增题目后生成新版本，旧行 `superseded_by`；`save:false` 不落库；月报引用 active 周报。
  - 工具：`weak_topics/method_signals/review_build/review_save/profile` 均经 `ctx.study` 路由。
  - 页面：周卡 3 条要点、展开、生成、刷新、错误、非 week 模式不显示；问答页 90 天清理提示。
- 既有测试：learning/memory/kernel/client/outcomes 均未放宽断言；只把 `registry` 的冻结命名空间列表加上 `review`。
- 真实数据：`.studybuddy/study` 已用一致性快照备份到 `evidence/S4/pre-s4/`；备份内 `integrity_check=ok`，`memory=1` 已迁移。真实库当前没有学习回合/单元/题目，因此没有跑真实数据报表演练；新代码用临时库 fixture 覆盖。

## 备份

- `docs/plans/2026-11-11-memory-increments/evidence/S4/pre-s4/study.pre-s4.db`
- `.../memory.v1.backup.json`
- `.../backup-manifest.json`（SHA-256、`integrity_check=ok`、module_schema 列表）

## 文件

新增：

- `plugins/study/host/learning/topics.mjs`（90 天候选、贪心聚类、主题命名/复用、关联写入）
- `plugins/study/host/learning/analysis.mjs`（弱主题公式、三态、方法信号、证据包、周期/ISO 周工具）
- `plugins/study/host/learning/prune.mjs`（90 天正文清理）
- `plugins/study/host/modules/review.mjs`（报告表、week/month/list/save、模板报告）
- `plugins/study/tests/learning/s4-helpers.mjs`
- `plugins/study/tests/learning/analysis.test.mjs`
- `plugins/study/tests/review/week.test.mjs`
- `plugins/study/tests/memory/export.test.mjs`
- `plugins/study/tests/client/outcomes-review.test.mjs`
- `docs/plans/2026-11-11-memory-increments/S4-delivery.md`（本文件）
- `docs/plans/2026-11-11-memory-increments/evidence/S4/pre-s4/*`（备份）

修改：

- `plugins/study/host/modules/learning.mjs`：`refreshTopics/weakTopics/methodSignals/prune/export` 方法、`study_insight` 工具、启动+24h 清理定时器、`textPrunedAt` 映射。
- `plugins/study/host/modules/memory.mjs`：`memory.export` 与画像 Markdown。
- `plugins/study/host/registry.mjs`：`NAMESPACES` 增加 `review`。
- `plugins/study/client/pages/outcomes.js`：周页“本周学习分析”卡、review 读取/生成状态。
- `plugins/study/client/messages/outcomes.js`：周卡中英文案。
- `plugins/study/client/pages/questions.js`：90 天清理提示与已清理回合文案。
- `plugins/study/client/messages/questions.js`：清理提示文案。
- `plugins/study/client/lib/api.js`：`review` 写方法登记。
- `plugins/study/tests/kernel/registry.test.mjs`：冻结命名空间列表加 `review`。
- `plugins/study/tests/client/questions.test.mjs`：90 天清理渲染用例。
- `plugins/study/client/client.js`、`plugins/study/client/.build/entry.js`：构建产物。

未改：`source/deepseek-harness`、S1–S3 的表结构与切分/窗口/画像算法、`memory` 的迁移格式、已有模块的 `schemaVersion`。

## 交接与后续

- 后续若要做“按主题覆盖详细度”：在 `study_memory_item` 写 `kind='topic_state'`，key 用 `topicId`，value 放 `detail_override`，先复用 S3 的 `replaceEvidence` 与置信度门槛，再让契约编译读当前 topic_state。
- 若要把历史周报做成可回溯快照：把 `weakTopics/signals` 冻结进 `evidence_json` 或另建快照表，避免回看旧周报时使用当前窗口。
- 若要启用 0.50–0.70 软阈值：先按 S3 偏差记录改 confidence 公式并补校准测试。
- 周页真实点击、记忆页画像与周卡的视觉验收留整体 DoD。
- 不要 `git commit`；所有改动留在工作区，由用户审核。
