# S4 交付记录

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
# 680 例，679 pass / 0 fail / 1 skip（既有的“启动后注册命名空间”用例）；12505ms

node --test --test-isolation=none plugins/study/tests/learning plugins/study/tests/memory plugins/study/tests/review
# 74 pass / 0 fail

node --test --test-isolation=none plugins/study/tests/client
# 87 pass / 0 fail

node plugins/study/tests/memory/tool-smoke.mjs
# passed=true，exit 0

node plugins/study/scripts/build-client.mjs
# ok=true，bytes=494000
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

- `docs/superpowers/plans/2026-11-11-memory-increments/evidence/S4/pre-s4/study.pre-s4.db`
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
- `docs/superpowers/plans/2026-11-11-memory-increments/S4-delivery.md`（本文件）
- `docs/superpowers/plans/2026-11-11-memory-increments/evidence/S4/pre-s4/*`（备份）

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
