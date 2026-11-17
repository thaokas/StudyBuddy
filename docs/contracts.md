# StudyBuddy 插件契约 v1（插件拆分后冻结）

- 日期：2026-11-11 初稿；2026-11-13 / 11-14 / 11-15 按代码核对；**2026-11-17 归档为冻结契约 v1**。
- 状态：**P1–P6 已落地，旧 `plugins/study` transitional shell 已删除**；当前实现以工作区未提交的插件拆分代码为准。**P7（`@studybuddy/bundle`、启动器去绝对路径、旧数据根迁移）尚未开始**，见 [roadmap.md](roadmap.md)。
- 用途：插件名 / 行 id、命名空间、方法、表所有权、读契约、事件、工具、页面、locale NS、侧栏 order、profile 行与版本以本文为准。代码与本文冲突时，先改本文并说明。
- 证据口径：拆分期间的 P0 审计与各阶段交付记录已随一次性计划文档归档删除，可从 git 历史取回；本文只保留冻结后仍有效的契约事实。

现状基线（2026-11-15 按代码核对）：**13 个命名空间 / 107 个方法 / 56 个声明写**；**14 个 Agent 工具**；**43 张基础表**（另 1 张 FTS5 虚拟表 + 5 张影子表，共 49 张 sqlite 表）；**32 个索引、10 个触发器**；**9 个页面**；14 份客户端字典（892 键，未逐项重算）；**108 条 HTTP 路由**（107 个方法各一条 POST + 导出独立路由）。

## 1. 插件注册表

| 插件 id（行 id） | 包名 | 层 | 目录 | 角色 |
| --- | --- | --- | --- | --- |
| `study-core` | `@studybuddy/study-core` | L0 | `plugins/study-core` | 内核：DB / kernel / 路由 / 客户端公共服务 / 今日 / 导出 |
| `study-facts` | `@studybuddy/study-facts` | L1 | `plugins/study-facts` | 业务基础：目标 / 资料 / 任务 / 时间块 / 计划 / 计时 / 计划创建 |
| `study-learning` | `@studybuddy/study-learning` | L2 | `plugins/study-learning` | 答疑 / 问答单元 / 学习证据 / 周月报 |
| `study-reminders` | `@studybuddy/study-reminders` | L2 | `plugins/study-reminders` | 提醒 / 晚间复盘 / 回复完成提醒 |
| `study-memory` | `@studybuddy/study-memory` | L2 | `plugins/study-memory` | 学生记忆 / 教学参数 / 系统提示契约 |
| `study-outcomes` | `@studybuddy/study-outcomes` | L3 | `plugins/study-outcomes` | 完成统计 / 里程碑 / 反馈 |
| `study-appearance` | `@studybuddy/study-appearance` | UI（client-only） | `plugins/study-appearance` | 品牌主题：6 套配色组 token 覆盖、梨伴 logo 槽位、外观设置行 |
| `study-pet` | `@studybuddy/study-pet` | UI（client-only） | `plugins/study-pet` | 「小搭」桌宠：`shell.overlay` 浮层、台词包、宠物设置行 |
| `project-credentials`（保持现 id） | `@studybuddy/platform-windows-credentials` | P | `platform/windows-credentials` | Windows DPAPI 凭据提供器 |
| —（bundle 不是插件行） | `@studybuddy/bundle` | C | `packages/study-bundle`（P7 目标） | 组合 patch 层 |

> 行 id 一旦发布不要改；`project-credentials` 沿用现有 profile 行 id。包名、profile 行名、客户端 bundle id 必须一致。
>
> 旧 `study`（`@studybuddy/study`）是迁移期 shell，**已删除**；文中出现的 `plugins/study` 路径均为历史记录。
>
> Creator skill 不是插件行：已迁到 `skills/study-creator`，验证脚本在 `tests/creator/`。

## 2. 命名空间

所有命名空间由 `ctx.study.register(ns, { methods, writes })` 注册。`writes` 是写方法集合，kernel 强制写方法带 `requestId`。**命名空间方法名即契约，不得改名。**

| 命名空间 | 拥有插件 | 方法（✅ = writes） | 写方法数 |
| --- | --- | --- | --- |
| `kernel` | `study-core` | `status` | 0 |
| `materials` | `study-facts` | ✅`saveGoal`、`getGoal`、`listGoals`、✅`importText`、✅`importFile`、✅`updateMaterial`、✅`deleteMaterial`、`list`、`get`、`outline`、`chunks`、`search`、`locate`、`verifyLocator` | 5 |
| `plans` | `study-facts` | `list`、`get`、`revisions`、`today`、`week`、`progress`、✅`saveDraft`、✅`discardDraft`、✅`confirm`、✅`revise`、✅`refine`、✅`undo`、✅`recordProgress` | 7 |
| `planning` | `study-facts` | ✅`start`、`pending`、✅`claim`、`get`、`latest`、✅`close` | 3 |
| `tasks` | `study-facts` | ✅`createTask`、✅`updateTask`、✅`replaceTask`、✅`deleteTask`、`getTask`、`listTasks`、✅`createBlock`、✅`updateBlock`、✅`deleteBlock`、✅`moveBlock`、✅`recordProgress`、`progress`、`day`、`week` | 9 |
| `timer` | `study-facts` | `status`、✅`start`、✅`pause`、✅`resume`、✅`finish`、✅`confirm`、✅`updateSettings` | 6 |
| `tutoring` | `study-learning` | ✅`open`、✅`flush`、✅`close`、`brief`、`context` | 3 |
| `learning` | `study-learning` | ✅`capture`、`list`、`get`、`stats`、`windowStatus`、✅`sealWindow`、✅`summarizeWindow`、`summaries`、✅`merge`、✅`split`、✅`refreshTopics`、`weakTopics`、`methodSignals`、✅`prune`、`export` | 7 |
| `review` | `study-learning` | ✅`week`、✅`month`、`list`、✅`save` | 3 |
| `memory` | `study-memory` | ✅`remember`、`recall`、✅`forget`、`profileGet`、`profileExplain`、✅`profileSet`、✅`refreshTraits`、`export` | 4 |
| `followup` | `study-reminders` | `due`、✅`claim`、✅`answer`、✅`snooze`、`getSettings`、✅`updateSettings`、`reviewPreview`、✅`review`、`reviewStatus`、✅`runDueCheck`、✅`runReview`、`recovery` | 7 |
| `outcomes` | `study-outcomes` | `day`、`week`、`month` | 0 |
| `milestones` | `study-outcomes` | `feedback`、`overview`、✅`savePersonal`、✅`listPersonal`、✅`deletePersonal` | 2 |

说明：

- `export` 不是命名空间：只有 `study_export` 工具 + `GET` / `POST /api/study/export.json`，归 `study-core`；POST 接受 `periods` / `includeFacts` 生成并写文件，GET 返回同一文档的下载。
- `tasks.replaceTask` 新建任务并让旧任务退休（旧任务写 `superseded_by` / `retired_at`，旧进度不迁移；直接改材料字段会被拒绝）；`plans.refine` 只细化指定日期的完整条目列表，不覆盖其他日期与未确认草案；`milestones` 的 `savePersonal/listPersonal/deletePersonal` 只读写自有表 `study_personal_milestone`，达成证据仍只读任务进度。
- `materials.verifyLocator` 返回分字段定位证据（只读）；`planning.latest` 读取当前目标最近一次创建会话（只读）；二者与上一条同属 2026-11-15 核销后新增 / 变更的契约面。
- `followup.runDueCheck` / `runReview` 是 `claim` / `reviewPreview` 的别名，仍按写方法声明。
- `review.week/month/save` 均写（`week/month` 默认落库并刷新主题；`save:false` 仍写学习主题表）。
- `tasks.deps=[]`，但 `getTask` 读 `study_plan_task`；拆到 facts 后是 facts 内部依赖，不再跨插件。
- 模块注册 API：`ctx.study.module({ id, deps, schemaVersion, schema, readContracts })`、`ctx.study.register`、`ctx.study.call`、`ctx.study.has(ns)`；`readContracts` 只记录数组元数据，不做读契约版本兼容性验证；尚无独立命名空间版本字段。模块版本不匹配时只抛该插件的 `unavailable`，不设置整库写锁。
- 快照与就绪：`ctx.study.composition()` 提供组合就绪屏障；组合完成后首次服务调用写当天 `day_snapshot`。`study-facts` 额外提供轻量 `studyFactsReady` 服务，上层用作用域 `ctx.inject` 等待，不写进顶层必需依赖。

## 3. 表所有权

> 计数（2026-11-15 按代码核对）：基础表 **43**（core 5 + facts 16 + learning 13 + memory 4 + reminders 4 + outcomes 1），FTS5 虚拟表 1 + 影子表 5，索引 32（schema 26 + 迁移 6），触发器 10。所有表为 STRICT；索引 / 触发器 / FTS 影子表跟随所属表。下表“DDL 来源”列相对各插件目录 `plugins/<pkg>/`。

| 表 / 对象 | 拥有插件 | DDL 来源 | 备注（增量列 / 迁移 / 命令式） |
| --- | --- | --- | --- |
| `meta`、`module_schema`、`request_log`、`change_log`、`day_snapshot` | `study-core` | `host/db.mjs` CORE_SCHEMA | 4 个触发器：change_log append-only ×2、day_snapshot write-once ×2；`CORE_SCHEMA_VERSION=1` |
| `study_goal`、`study_goal_workspace` | `study-facts` | `modules/materials.mjs` | `study_goal_workspace` 旧库由 `ensureGoalWorkspaceSchema` 幂等补建 |
| `study_material`、`study_material_chunk`、`study_material_fts`（FTS5） | `study-facts` | `modules/materials.mjs` | FTS 影子表 `_data/_idx/_content/_docsize/_config` 跟随 |
| `study_task`、`study_time_block`、`study_task_progress` | `study-facts` | `modules/tasks.mjs` + 迁移 | 增量列：`goal_id`（task/time_block/progress）、`material_id`、`scheduled_date`、`project_id`、`project_title`、`legacy_progress_id`、`replaces_task_id`、`superseded_by`、`retired_at`、`material_verification`；旧库由 `ensureProgressSchema` / `ensureTaskProjectColumns` 补建 |
| `study_plan`、`study_plan_revision`、`study_plan_draft`、`study_plan_progress` | `study-facts` | `modules/plans.mjs` + 迁移 | 增量列：`study_plan.draft_revision`、`study_plan_draft.revision`；2 个 append-only 触发器 |
| `study_plan_task`、`study_foundation_unmigrated` | `study-facts` | `packages/study-model/facts.mjs#migrateFoundation` | 迁移专属；`study_plan_task` 是计划条目 ↔ 任务的稳定映射 |
| `study_planning_link` | `study-facts` | `modules/planning.mjs` | — |
| `study_timer_session`、`study_timer_settings` | `study-facts` | `modules/timer.mjs` | — |
| `study_tutoring_link` | `study-learning` | `modules/tutoring.mjs` | — |
| `study_turn`、`study_episode`、`study_episode_problem`、`study_episode_turn`、`study_signal`、`study_topic`、`study_episode_topic`、`study_capture_gap`、`study_window`、`study_window_summary`、`study_topic_thread` | `study-learning` | `modules/learning.mjs` | 证据 / 问答单元 / 窗口 / 摘要 / 主题 |
| `study_learning_review` | `study-learning` | `modules/review.mjs` | 周 / 月报告 |
| `study_memory_item`、`study_memory_evidence`、`study_memory_tombstone` | `study-memory` | `plugins/study-memory/host/memory/store.mjs` → `modules/memory.mjs#schema` | schemaVersion=1，表结构不变 |
| `study_memory_state` | `study-memory` | `modules/memory.mjs#apply` 命令式 | 不在模块 `schema`、不记 `module_schema`；v1 迁移用，保留 |
| `study_followup_settings`、`study_followup_state`、`study_followup_reminder`、`study_followup_review` | `study-reminders` | `modules/followup.mjs` + 迁移 | 增量列：`study_followup_reminder.block_id`（模块 apply 命令式 ALTER）、`goal_id`（迁移）；2 个 append-only 触发器 |
| `study_personal_milestone` | `study-outcomes` | `modules/milestones.mjs`（schema 来自 `host/personal-milestones.mjs#personalSchema`） | schemaVersion=1；列 `id`、`goal_id`、`title`、`task_ids_json`、`created_at`；达成状态由 `study_task_progress` 只读推导，不在本表冗余 |
| `outcomes` 模块无自有表 | `study-outcomes` | — | 只读派生；通过 provider 向 core 的 `day_snapshot` 供数；`milestones` 的个人定义表见上一行 |

### 3.1 迁移对象与归属

- `study_plan_task`、`study_foundation_unmigrated` 与 `meta.data_foundation_*` 归 **`study-facts`**；`study_followup_*` 的 `goal_id` / 索引 / 历史回填归 **`study-reminders`**。
- `migrateFoundation` / `migrateReminderFoundation` 的代码是纯函数，放在 `packages/study-model/facts.mjs`；**调用者是拥有者插件**，core 不再调用：facts 在自己的 `apply` 中调用 `migrateFoundation`，reminders 在自己的 `apply` 中调用 `migrateReminderFoundation` 做 followup 幂等 ALTER 与回填。`data_foundation_version` 门禁留在 facts 切片；reminders 切片必须自身幂等（可重复执行）。
- 每个切片的失败语义：先 `VACUUM INTO <db>.foundation-<ts>.bak`，事务失败回滚并抛 `unavailable`（附备份路径）。
- 其它命令式迁移（`ensureGoalWorkspaceSchema`、`ensureProgressSchema`、`ensureTaskProjectColumns`、followup `block_id`、memory v1）保留在各拥有者插件内。

## 4. 读契约

> 只列跨插件只读。同一插件内部模块之间的读不算跨插件契约。拥有者改表必须 bump 读契约版本并跑消费者测试；当前代码把 `readContracts` 作为元数据记录，不做读契约版本兼容性校验（见 §2）。

| 消费者 | 拥有者 | 表 / 列 | 用途 | 版本 |
| --- | --- | --- | --- | --- |
| `study-memory` | `study-facts` | `study_goal(id, active)` | 共享 `resolveActiveGoal`；入口 readContracts 已登记；无表 / 活动目标时使用 unassigned | v1 |
| `study-memory` | `study-facts` | `study_planning_link(session_id, goal_id)` | 规划会话的当前目标作用域（`host/index.mjs` 的 `readContracts`；表缺失时忽略） | v1 |
| `study-memory` | `study-facts` | `study_task(id, goal_id, title, subject)` | 任务答疑会话作用域，并按标题 / 学科召回相关记忆 | v1 |
| `study-memory` | `study-learning` | `study_tutoring_link(session_id, task_id)` | 当前答疑会话的任务作用域 | v1 |
| `study-memory` | `study-learning` | `study_episode`、`study_episode_problem`、`study_signal`（只读；`tableExists` 守卫，缺失时返回空） | 教学参数证据推导（`host/memory/traits.mjs`） | v1（**软依赖**，learning 禁用时降级） |
| `study-learning` | `study-facts` | `study_task(id, goal_id, …)` | 问答单元关联任务 / 目标（`host/learning/repo.mjs#sessionLink`） | v1 |
| `study-learning` | `study-facts` | `study_tutoring_link` | 同插件表，仅登记 | v1 |
| `study-learning` | `study-memory` | `study_memory_item` 全列（当前 trait 版本） | 报告画像使用共享 `packages/study-model/memory-traits.mjs` / `memory-read.mjs`；只读，无表时使用默认参数 | v1 |
| `study-reminders` | `study-facts` | `study_task.id/goal_id`、`study_plan.id/goal_id`、`study_goal.id/active/rowid` | 回复 / 复盘目标归属；活跃目标回退与 foundation 回填 | v1 |
| `study-outcomes` | `study-facts` | `study_task*`、`study_time_block`、`study_plan*`、`study_plan_revision`、`study_plan_task`、`study_material(id,title)` | 日 / 周 / 月统计与对账、当天快照 payload | v1 |
| `study-outcomes` | `study-learning` | `review` 命名空间方法 | 成果页报告区（软依赖；不可用时局部降级） | v1 |
| `study-outcomes`（milestones 模块） | `study-facts` | `study_goal(id, active)`、`study_task(id, goal_id)`、`study_task_progress(id, task_id, goal_id, status, confirmed, date)` | 个人里程碑目标作用域、关联校验与达成证据 | v1 |
| `study-core` | 所有插件 | 全部表（导出） | `study_export` 工具与 `GET` + `POST /api/study/export.json` 只读转储；显式分组 + `otherTables`；排除 `request_log`、FTS 表与会话明细（`study_turn`、`study_episode_problem`、`study_episode_turn`、`study_capture_gap`、`study_memory_state`） | v1 |
| `study-core` | `study-outcomes` | `outcomes` 命名空间方法（`day/week/month`） | 导出附真实日 / 周 / 月成果快照；服务不可用时 `availability.outcomes` 写明原因，不伪造数据 | v1 |
| `study-core` | `study-memory` | `study_memory_item`、`study_memory_tombstone` | 导出当前 SQLite 记忆（条目 + 删除标记）；未建该表时回退下一行 | v1 |
| `study-core` | 所有插件 | 数据目录 `memory.json` | 旧数据根回退：当前 SQLite 记忆表不存在时原样附加（只读文件） | v1 |

### 4.1 写路径

| 写者 | 拥有者 | 方式 | 备注 |
| --- | --- | --- | --- |
| 各插件 | 自己 | `kernel.database`（core 提供的句柄）执行自有表 SQL | 启动期维护 / 迁移允许；服务调用内走 kernel 事务 |
| `study-facts`（plans） | `study-facts`（tasks） | 同插件，共享 `study-model` 的 `materializePlan` / `recordProgress` | 内部边界 |
| `study-outcomes` | `study-core`（`day_snapshot`） | `kernel.setDaySnapshotProvider(payload)`，由 core 在调用前落盘 | 允许的唯一跨插件写路径 |
| 任何插件 | 其他插件 | `ctx.study.call(ownerNamespace, method, payload, { requestId })` | 禁止直接 SQL 写 |
| 界面 / Agent | 各拥有插件 | `POST /api/study/<ns>/<method>` 或 `ctx.study.call` | 写方法强制 `requestId`（kernel 级）；HTTP 层依赖宿主 authenticated 路由 |

> kernel 对“未声明写却改了库”只 `logger.warn`，不拒绝；靠表所有权契约 + 测试（静态 SQL 扫描 / 变更检测）约束，不宣称运行期强制隔离。

### 4.2 2026-11-15 核销后的业务口径

- `tasks.completionSummary` 的分母为计划内全部任务（取消留在分母，取消不抬高完成率；只有没有任何任务时 `rate=null`），与 outcomes 三口径一致；workbench 的回退卡与客户端 `summarizeProgress` 同规则。
- 软删除资料后，计划 `refine` / `revise` 允许保留同一 item / project 已引用的 `materialId`（读路径保持 `unverified`），新增或更换资料仍要求 active 资料或显式替代；显式替代后 item 的 `materialId=null`，允许一次性绑定新资料以重新核实 locator，已绑定 A 换 B 仍返回 `replacement_required`。
- 导出新增 `data.taskProgress`（`study_task_progress`）与 `summary.taskProgress`，收据分别显示计划进度 / 任务进度；`data.progress` 仍是计划进度。
- 记忆的现行主存是 `study.db` 的 `study_memory_item / evidence / tombstone` 三表；`memory.json` 只在迁移 / 导出兼容时使用（旧数据根会迁移并保留 `memory.v1.backup.json`）。

## 5. 事件

| 事件 | 生产者 | 消费者 | 语义 / payload | 版本 |
| --- | --- | --- | --- | --- |
| `study/learning/changed` | `study-learning` | `study-memory`（可选） | `{ kind: 'capture'\|'merge'\|'split', episodeId?, turnId?, episodeIds? }`；`setImmediate` 在写事务提交后发射；消费者不得假设一定到达、不得回写 | v1 |
| `agent/pre-step` | DSH Host | `study-facts`（planning） | 仅 `turn===1 && step===1` 且该 session 有 pending 创建上下文时，`await next()` 后追加一条 user message；只注入一次 | DSH |
| `agent/created` | DSH Host | `study-learning`（tutoring） | 会话创建后若 link 未注入则 `tutoring.flush` | DSH |
| `agent/inbox/claimed` | DSH Host | `study-learning` | 只处理 `message.source.kind === 'user'` 的文本，调用 `learning.capture`（`requestId=capture:<messageId>`）；失败写 `study_capture_gap` | DSH |

规则：事件只通知“发生了什么”，不是命令；消费者必须容忍事件缺失；新增事件先登记再实现。

## 6. 工具

> 14 个 Agent 工具，工具名全局唯一；均由各模块 `ctx.tools.register(defineTool(...))` 注册。`defineTool` 当前仍从固定 DSH 源码树以路径方式引入，改为包引用是 P7 事项（见 [roadmap.md](roadmap.md)）。

| 工具 | 拥有插件 | 调用命名空间 / 方法 | 写？ | 说明 |
| --- | --- | --- | --- | --- |
| `study_status` | `study-core` | `kernel.status` | 否 | 存储 / 修订 / 模块 / 命名空间 / 当天快照 |
| `study_export` | `study-core` | 直接导出 + `GET/POST /api/study/export.json` | 写文件 | 导出 JSON 到 `<dataDir>/exports/`；POST 生成并写文件，GET 下载同一文档 |
| `study_goal` | `study-facts` | `materials.getGoal/listGoals/saveGoal` | save 写 | 备考目标读写 |
| `study_materials` | `study-facts` | `materials.search/importText/list` | import 写 | 资料检索 / 导入 / 列表 |
| `study_tasks` | `study-facts` | `tasks.day/week/listTasks/createTask/updateTask/replaceTask/createBlock/moveBlock/recordProgress` | 部分写 | 任务与执行块唯一事实 |
| `study_plan` | `study-facts` | `plans.today/week/get/saveDraft/confirm/revise/refine/undo` | 部分写 | 计划草案 / 确认 / 修订 / 撤销 / 滚动细化 |
| `study_progress` | `study-facts` | `plans.progress/recordProgress` | record 写 | 进度读取 / 记录 |
| `study_tutoring` | `study-learning` | `tutoring.open/context/close` | open/close 写 | 任务答疑上下文 |
| `study_questions` | `study-learning` | `learning.list/get/stats` | 否 | 问答单元检索 |
| `study_insight` | `study-learning` | `learning.refreshTopics/weakTopics/methodSignals`、`review.week/month`、`memory.profileGet` | 是（refreshTopics/review） | 弱主题 / 方法信号 / 报告 / 画像；**单数名** |
| `memory_remember` | `study-memory` | `memory.remember` | 是 | 偏好 / 短期状态 / 观察 |
| `memory_recall` | `study-memory` | `memory.recall` | 否 | 按关键词 / 类型召回 |
| `memory_forget` | `study-memory` | `memory.forget` | 是 | 删除 + 墓碑 |
| `memory_profile` | `study-memory` | `memory.profileGet/profileExplain/profileSet` | set 写 | 讲解参数 |

无 Agent 工具：`review`、`followup`、`outcomes`、`milestones`、`timer`、`planning`（只有服务 / 路由 / UI）。

## 7. 客户端契约

### 7.1 页面

| key | 拥有插件 | 目标 order | 目标 locale NS | label key |
| --- | --- | --- | --- | --- |
| `onboarding` | `study-facts` | 1 | `study-facts` | `onboarding.panel` |
| `workbench` | `study-facts` | 10 | `study-facts` | `workbench.panel` |
| `timer` | `study-facts` | 15 | `study-facts` | `timer.panel` |
| `plan` | `study-facts` | 16 | `study-facts` | `plan.panel` |
| `reminders` | `study-reminders` | 17 | `study-reminders` | `reminders.panel` |
| `today` | `study-core` | 20 | `study-core` | `today.panel` |
| `outcomes` | `study-outcomes` | 25 | `study-outcomes` | `outcomes.panel` |
| `questions` | `study-learning` | 70 | `study-learning` | `questions.panel` |
| `memory` | `study-memory` | 80 | `study-memory` | `memory.panel` |

规则：key 不改名且必须等于文件名（`normalizePages` 强制）；order 全局唯一；label 必须在**本插件**字典中存在；页面组件不得跨 bundle import。

### 7.2 客户端共享服务（`study-core` 提供）

| 服务 | 职责 | 最小接口 |
| --- | --- | --- |
| `studyClient` | `call(ns, method, payload)`；自动为声明的写方法添加 / 复用 `requestId`，统一抛出携带错误信封信息的异常 | `call(ns, method, payload)`（含写调用） |
| `studyRefresh` | 数据变更发布 / 订阅 | `notifyStudyDataChanged(reason?)`、`onStudyDataChanged(listener) -> remove`、`dispose()` |
| `studyNav` | 自动记住 / 恢复最后页面，动态注册 page key | `registerPages(pageKeys) -> remove`、`dispose()`；`PAGE_KEY="study.layout.page"` 保持兼容 |
| `studyUi` | 面板图标共享视图 | `StudyPanelIcon` |

功能插件客户端必须在 `dsh.client.inject` 声明 `@studybuddy/study-core`，运行时通过 `ctx.inject([...])` 获取服务。拆分期草案中的独立 `write` / 错误类服务导出、`remember` / `restore` / `openPage` 便捷方法及 Workspace UI helper 服务未提供（尚无调用方）。

### 7.3 共享文案与跨 bundle 引用

| 模块 | 内容 | 归属 |
| --- | --- | --- |
| `common` | 原 7 键 + `common.refresh` | `packages/study-messages`（各插件构建时合并） |
| `daily` | 17 键（跨 plan/workbench/reminders/plugin） | `packages/study-messages` |
| `tutoring` | 2 键 | `study-facts`（随 `actions/ask-task.js`） |
| `feedback` | 37 键 | `study-outcomes`（随 `components/feedback.js`） |
| `notify` | 14 键 | `study-reminders`（随 `notify.js`） |
| 页面专属字典（9 个） | 各自页面 | 随页面迁入对应插件 |

- 一插件一个 locale NS；同一 NS 同语种重复注册会抛错。
- `client/learning-notify.js` 随 reminders 归 `study-reminders`；`onboarding` import `plan.js` 的 helper 属 facts 内部允许。

### 7.4 action、overlay 与非页面模块

| 模块 | 贡献 | 调用 | 归属 |
| --- | --- | --- | --- |
| `actions/ask-task.js`（id `ask-task`，page `workbench`） | 工作台“问这道题” | `tutoring.brief` → `tutoring.open`（带 requestId）→ 打开会话 | `study-facts`（软依赖 learning） |
| `actions/refresh.js`（id `refresh-today`，page `today`） | 今日页刷新 | `context.reload()` | `study-core` |
| `notify.js` | `shell.overlay` banner + `settings.general.item`（order 40；overlay / settings id 均为 `study.completion-notify`） | sessions 快照；无命名空间调用 | `study-reminders` |
| `components/feedback.js` | `shell.overlay` 里程碑卡片 / toast | `milestones.feedback/overview` | `study-outcomes` |
| `pages/reminders.js#installFollowupReminders` | `shell.overlay` 提醒 banner（order 30；overlay id `study.followup-reminders`） | `followup.*`；`layout.selectPanel("reminders")` | `study-reminders` |
| `learning-notify.js` | 系统通知构造器 | Web Notification | `study-reminders` |

localStorage 键（归属必须登记）：`study.layout.page`（core `studyNav`）、`study.notify.completion.*`（reminders）、`study.milestones.feedback.*`（outcomes）、`study.learning.notified.v1`（reminders）、工作台显示偏好（facts）。

### 7.5 构建与 bundle 元数据

- 每插件一个 barrel + `client/client.js` + `exports["./client"]`；`BUNDLE_ID` = 包名；`window.__ModuleLoader__.load({ id })`。
- 页面 ↔ 同名 messages 文件 1:1（`discoverContributions` 强制）；共享字典由构建时合并进本插件 NS，不作为 messages 目录成员。
- `package.json` 需补 `engines.dsh`、`peerDependencies`（react/tools 等）；esbuild 改为包依赖 / peer，不再依赖固定源码树（P7）。
- 副作用注册（overlay / settings）由各插件 `apply` 自行安装并随 dispose 移除；id 全局唯一。

### 7.6 外观插件（`study-appearance`，client-only）

- **包 / bundle**：包名、profile 行 id、bundle id 均为 `@studybuddy/study-appearance`；host 为空 apply，`exports["./client"]` 提供浏览器端。
- **locale NS**：`study-appearance`（en/zh 字典，只用于设置行文案）。
- **页面**：不注册任何页面 / 侧栏入口；不占用 `study.layout.page` 的 key。
- **主题**：通过 `ctx.theme.overrideTokens('@studybuddy/study-appearance', { token: { light, dark } })` 叠加 `--dsw-alias-*` / `--dsw-specific-*` / 自定义 `--study-topbar`；**不调用 `setTheme()`**，用户原生 `light/dark/system` 选择保持权威。
- **三面**：侧边栏 = `--dsw-specific-sidebar-fill` 等；画布 = `--dsw-alias-bg-base` / `bg-layer-*`；顶栏 = 自定义 `--study-topbar`，由插件样式表挂到会话头 `header[data-window-drag]:has([data-conversation-header-leading])` 与 `[data-dockkit-strip]`；入口页（插件页 / 账号引导）的 drag 头部不参与，关闭开关时不生效。
- **槽位**：`sidebar.brand.mark`（24px 梨伴 logo）、`sidebar.brand.name`（`StudyBuddy` 字标）、`conversation.hero.brand.mark`（空会话首页 34px 梨伴 logo）、`settings.general.item`（id `study.appearance`，order 35）。品牌槽用 `priority:-1` 覆盖 official 构建的 priority 0 占用。
- **存储**：`study.appearance.enabled`、`study.appearance.light-pack`、`study.appearance.dark-pack`（Web Storage；每浏览器独立）。旧 MVP 的 `study.appearance.accent` 不读、不删。
- **样式**：一条插件自有 `<style id="study-appearance-styles">`，只做顶栏表面 / 选中色 / `prefers-reduced-motion|transparency|contrast|forced-colors` 降级；零 `!important`、不碰哈希类名、无全局 body 选择器。
- **加载约定**：`dsh.client.inject` 声明 sidebar/theme/conversation/settings/locale；运行期 `inject = ['slots','theme','locale']`，slot 注册用 `ctx.slots.inject` 等待声明。
- **与插件拆分的关系**：不依赖 `study-core` / `study-facts` 的任何 host 服务；P7 由 `@studybuddy/bundle` 引用。完整设计规范见 [design/appearance-plugin.md](design/appearance-plugin.md)。

### 7.7 桌宠插件（`study-pet`，client-only）

- **包 / bundle**：包名、profile 行 id、bundle id 均为 `@studybuddy/study-pet`；host 为空 apply，`exports["./client"]` 提供浏览器端；`dsh.client.platform='web'`。
- **locale NS**：`study-pet`（en/zh UI 字典；宠物台词另在 `client/lines.js` 的台词包，不进 locale NS）。
- **页面**：不注册页面 / 侧栏入口；只贡献 `shell.overlay`（id `study.pet`）与 `settings.general.item`（id `study.pet`，order 36）。
- **浮层**：注册在 `shell.overlay`（root list，层本身 `pointer-events:none`），根节点 `position: fixed` 自行管理 `pointer-events`；不手工挂 `document.body`，不碰哈希类名，无 `!important`。
- **状态来源**：标准 hook `useSessionStatus` 只读；`done` 只在 `running` 真→假边沿触发。可选 `ctx.get('studyClient')` 每 20 s 只读 `timer/status`，服务缺失 / 失败静默降级；不写任何 StudyBuddy 数据。
- **存储**：`study-pet:enabled`、`study-pet:chatter`、`study-pet:size`、`study-pet:position`、`study-pet:voice`（Web Storage；每浏览器独立）。损坏值 / 存储禁用均降级到内存或默认值。
- **语言功能**：zh/en 台词包（13 场景，每池 4–8 句）；气泡 TTL 4 s、同场景冷却 9 s、长场景 8 s 轮换；碎碎念 45–90 s；睡眠 20 s 进入、60–120 s 梦话；voice pack JSON 整体式校验覆盖（每池 ≤64 句、每句 ≤160 字符）。
- **可访问性**：主体 button + `aria-label`，SVG `aria-hidden`；`prefers-reduced-motion` / `prefers-contrast` / `forced-colors` 降级；动画 CSS-only。
- **与插件拆分的关系**：不依赖任何 host 服务，只可选读取 `studyClient`；P7 由 `@studybuddy/bundle` 引用。完整设计规范见 [design/study-pet.md](design/study-pet.md)。

## 8. profile / bundle 行

当前启动器 `scripts/project-config.mjs#deploymentPolicy` 每次启动重写 `<数据根>/home/cordis.patch.yml`：**19 项逻辑行** = 8 个账号 / 遥测禁用 + `credentials.disabled` + `workspace-controller` + **9 个 insert 行**（`project-credentials` 与 8 个 study 插件行）。具体顺序：

```text
8 × 账号/遥测禁用 → credentials(disabled) → workspace-controller
→ [project-credentials, study-core, study-facts, study-learning, study-reminders,
   study-memory, study-outcomes, study-appearance, study-pet]
```

- **当前启动器仍逐行写插件源码的绝对路径**（`plugins/.../host/index.mjs`）；P7 的 `@studybuddy/bundle` 尚未落地。
- `study-core` 是唯一接收 `config.dataDir` 的业务行。
- profile bundles 保持：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-personalized-recommendations`（Creator bundle 只在首次出现时加入，用户关闭后不强行加回）。
- 已有数据根 profile 可能残留旧 `a02-probe` 行；启动器已不再插入它，清理随 P7 迁移完成。
- P7 目标：profile 的 `dsh.profile.bundles` 追加 `@studybuddy/bundle`；bundle 的 `cordis.patch.yml` 集中声明账号 / 遥测禁用、`workspace-controller`、`project-credentials`、8 个 study 行（core 带 `dataDir`），不含 `a02-probe`；启动器只负责数据根、环境变量、首次模型与凭据、Creator skill 安装。验收标准是“启动器不再逐行写插件绝对路径”。详见 [roadmap.md](roadmap.md)。

## 9. 兼容与版本

| 项 | 值 | 备注 |
| --- | --- | --- |
| DSH 版本 | `0.2.2-rc.1`，基线 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | 当前固定版本不升级；补丁 `0001`（桌面账号开关）与 `0002`（第二主栏）已应用并反向校验 |
| Node | 要求 ≥24.9（`node:sqlite` 必需） | 文档实测基线 v26.13.0 |
| pnpm | 文档基线 11.28.5 | 安装时按仓库 `packageManager` 自动使用 |
| 平台 | Windows x64 | 先 Windows |
| core schema | `CORE_SCHEMA_VERSION = 1` | 不 bump |
| 模块 schemaVersion | 有 schema 的模块均为 1 | 不 bump 既有模块 |
| 读契约版本 | 统一从 v1 开始 | 改表必须 bump |
| 客户端元数据 | `dsh.client.platform="web"`、`exports["./client"]`、`engines.dsh`、`peerDependencies` | 后两项已补 |
| 测试基线 | 插件全量 949 例（948 pass / 0 fail / 1 预期 skip）；`study-appearance` 139/139；`study-pet` 53/53 | 2026-11-15 核销后回归口径 |

## 10. 当前实现状态与边界

- **已落地**：`study-core` 内核与客户端公共服务；`study-facts`、`study-learning`、`study-reminders`、`study-memory`、`study-outcomes` 各自独立；旧 `plugins/study` shell 已删除；`study-appearance` 与 `study-pet` 作为 client-only 表现层插件接入。
- **未落地**：P7 bundle、启动器去绝对路径、旧数据根迁移（含 `a02-probe` 残留清理）；T18 发布候选包、T19 十四场景验收（见 [roadmap.md](roadmap.md)）。
- 写隔离靠契约 + 测试约束，kernel 对未声明写只告警；**不宣称运行期按表权限隔离**。
- `readContracts` 目前只做元数据登记，不做版本兼容校验；改表需人工 bump 并跑消费者测试。
- 插件**不是沙箱**：Creator 生成插件与普通插件同权限，只承诺可撤销 / 可恢复，不承诺安全隔离。
- 时间块计时、提醒、复盘不依赖模型：断网 / 无 Key 仍可用；系统通知受 Windows 设置影响，应用内横幅是兜底。
- 记忆当前实现六项教学参数，只有 `explain_detail` 自动推断；提醒没有“互动语气”设置；Creator 没有版本历史。以上产品设计未实现项与低风险待修项统一登记在 [roadmap.md](roadmap.md)。
