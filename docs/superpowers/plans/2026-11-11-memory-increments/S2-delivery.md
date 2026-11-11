# S2 交付记录

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
# 23 pass / 0 fail（S1 13 条 + S2 10 条：窗口 7、合并 2、拆分 1）

node --test --test-isolation=none plugins/study/tests/client
# 75 pass / 0 fail（含 buildClient 产物比对与 questions 页 7 条）

node --test --test-isolation=none plugins/study/tests
# 631 例，629 pass / 1 fail / 1 skip（最终全量；失败为下述既有性能抖动）
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
- `docs/superpowers/plans/2026-11-11-memory-increments/S2-delivery.md`（本文件）

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
