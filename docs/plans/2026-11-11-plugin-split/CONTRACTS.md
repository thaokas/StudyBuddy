# 插件拆分契约清单

- 状态：**P0 待填写/核对**；每完成一个阶段由执行会话更新对应行
- 用途：拆分期间唯一的事实清单。插件名、行 id、命名空间、表所有权、读契约、事件、工具、页面、locale NS、侧栏 order、版本都以本文件为准；代码与文档冲突时，先停下来改本文件并说明。
- 填写规则：
  - 不确定的写 `待核对`，不要猜；
  - 表所有权按“谁建表谁拥有”填；索引/触发器/FTS 跟随所属表；
  - 读契约写“消费者 → 拥有者的表/列 + 用途 + 版本”，例如 `memory → study_goal(id, active) / 解析当前目标 / v1`；
  - 页面 key 不得改名（`study.layout.page` 依赖它）；order 用下表的目标值；
  - 新增/修改行必须在 STATUS 记录。

## 1. 插件注册表

| 插件 id（行 id） | 包名 | 层 | 目录 | 角色 | 首次出现 |
| --- | --- | --- | --- | --- | --- |
| `study-core` | `@studybuddy/study-core` | L0 | `plugins/study-core` | 内核：DB/kernel/路由/客户端公共服务/今日/导出 | P1 |
| `study`（旧 shell，临时） | `@studybuddy/study` | — | `plugins/study` | 迁移期承载未迁出模块/页面 | 现状，P6 删除 |
| `study-memory` | `@studybuddy/study-memory` | L2 | `plugins/study-memory` | 记忆/教学参数 | P2 |
| `study-facts` | `@studybuddy/study-facts` | L1 | `plugins/study-facts` | 目标/资料/任务/计划/计时 | P3 |
| `study-learning` | `@studybuddy/study-learning` | L2 | `plugins/study-learning` | 答疑/问答/证据/报告 | P4 |
| `study-reminders` | `@studybuddy/study-reminders` | L2 | `plugins/study-reminders` | 提醒/晚间复盘/完成提醒 | P5 |
| `study-outcomes` | `@studybuddy/study-outcomes` | L3 | `plugins/study-outcomes` | 统计/里程碑/反馈 | P6 |
| `project-credentials`（保持现 id） | `@studybuddy/platform-windows-credentials`（现名；改名另议） | P | `platform/windows-credentials` | DPAPI 凭据 | 现状 |
| —（bundle 不是插件行） | `@studybuddy/bundle` | C | `packages/study-bundle` | 组合 patch 层 | P7 |

> 行 id 一旦发布不要改；`project-credentials` 沿用现有 profile 行 id，避免用户数据里的覆盖项失效。
>
> Creator skill 不是插件行：P6 把 `plugins/study/creator/skills/study-creator` 迁到 `skills/study-creator`，把验证脚本与证据迁到 `tests/creator`，并更新 `scripts/project-config.mjs` 的 `creatorSkillSource`。

## 2. 命名空间

| 命名空间 | 拥有插件 | 主要方法（P0 核对） | 写方法 | 备注 |
| --- | --- | --- | --- | --- |
| `kernel` | `study-core` | `status` | 无 | 只读状态 |
| `materials` | `study-facts` | `importText`、`importFile`、`list`、`get`、`outline`、`chunks`、`search`、`locate`（目标/资料/片段/检索，另有 helper 注册的方法以 P0 扫描为准） | `saveGoal`、`importText`、`importFile`、`updateMaterial`、`deleteMaterial` 等（核对） | 目标表在 facts |
| `plans` | `study-facts` | `list`、`get`、`revisions`、`today`、`week`、`progress`、`confirm`、`revise`、`undo`（草案方法见 writes） | `saveDraft`、`discardDraft`、`confirm`、`revise`、`undo`、`recordProgress` 等 | 与 tasks 同插件 |
| `planning` | `study-facts` | `start`、`pending`、`claim`、`get`、`close` | 同左 | 计划创建上下文 |
| `tasks` | `study-facts` | 任务/时间块/进度/日周视图（methods 由 helper 组装，P0 扫描） | `createTask`、`updateTask`、`deleteTask`、`createBlock`、`updateBlock`、`deleteBlock`、`moveBlock`、`recordProgress` | 事实层 |
| `timer` | `study-facts` | `status`、`start`、`pause`、`resume`、`finish`、`confirm`、`updateSettings`（methods 由 helper 组装，P0 扫描） | 除 `status` 外 | 依赖 tasks |
| `tutoring` | `study-learning` | `open`、`flush`、`close`、`brief`、`context` | `open`、`flush`、`close`（`brief`/`context` 只读） | 读 facts 服务 |
| `learning` | `study-learning` | `capture`、`list`、`get`、`stats`、`windowStatus`、`sealWindow`、`summarizeWindow`、`summaries`、`merge`、`split`、`refreshTopics`、`weakTopics`、`methodSignals`、`prune`、`export` | `capture`、`merge`、`split`、`refreshTopics` 等 | 发布 `study/learning/changed` |
| `review` | `study-learning` | `week`、`month`、`list`、`save` | 同左 | 成果页调用 |
| `memory` | `study-memory` | `remember`、`recall`、`forget`、`profileGet`、`profileExplain`、`profileSet`、`refreshTraits`（methods 由 helper 组装，P0 扫描） | 除只读外 | 读 goals；消费 learning 事件 |
| `followup` | `study-reminders` | `due`、`claim`、`answer`、`reviewPreview`、`review`、`runDueCheck`、`runReview`、`recovery`（另有设置方法，P0 扫描） | 同左 | 依赖 tasks/plans |
| `outcomes` | `study-outcomes` | `day`、`week`、`month` | 无 | 只读派生 |
| `milestones` | `study-outcomes` | methods 由 helper 组装（P0 扫描） | 无 | 只读派生 |
| —（export） | `study-core` | `study_export` 工具 + `GET /api/study/export.json` | 无 | 不是命名空间方法 |

## 3. 表所有权

> P0 必须按 `host/modules/*.mjs` 的 `schema` 完整核对，包含索引、触发器、FTS5 影子表与 `ALTER TABLE` 增量表。

| 表/对象 | 拥有插件 | 说明 | 迁移阶段 |
| --- | --- | --- | --- |
| `meta`、`module_schema`、`request_log`、`change_log`、`day_snapshot` | `study-core` | 内核核心表 | P1 |
| `study_goal`、`study_goal_workspace` | `study-facts` | 目标/工作区链接 | P3 |
| `study_material*`、`study_chunk*`、FTS 表 | `study-facts` | 资料/片段/检索 | P3 |
| `study_task`、`study_time_block`、`study_task_progress` | `study-facts` | 任务/时间块/进度 | P3 |
| `study_plan`、`study_plan_revision`、`study_plan_draft`、`study_plan_progress`、`study_plan_task` | `study-facts` | 计划/修订/链接/进度 | P3 |
| `study_planning_link` | `study-facts` | 计划创建会话关联 | P3 |
| `study_timer*` | `study-facts` | 计时会话/设置 | P3 |
| `study_tutoring_link` | `study-learning` | 会话↔任务链接 | P4 |
| `study_turn`、`study_episode*`、`study_signal`、`study_window*`、`study_summary*`、`study_topic*`、`study_capture_gap` | `study-learning` | 证据/问答单元/窗口/摘要/主题 | P4 |
| `study_learning_review` | `study-learning` | 周/月报告 | P4 |
| `study_memory_item`、`study_memory_evidence`、`study_memory_tombstone`、`study_memory_state` | `study-memory` | 记忆/证据/墓碑 | P2 |
| `study_followup_*` | `study-reminders` | 提醒/复盘设置/状态 | P5 |
| `outcomes`/`milestones` 无自有表 | `study-outcomes` | 只读派生 | P6 |

## 4. 读契约

> 只列“跨插件只读”。同一插件内部模块之间的读不算跨插件契约。P0 核对列名与用途；拥有者改表必须 bump 版本并跑消费者测试。

| 消费者 | 拥有者 | 表/列 | 用途 | 版本 | 引入阶段 |
| --- | --- | --- | --- | --- | --- |
| `study-memory` | `study-facts` | `study_goal(id, active)` | `resolveActiveGoal` 解析当前目标 | v1 | P2 |
| `study-learning` | `study-facts` | `study_task(id, goal_id, ...)` | 问答单元关联任务/目标 | v1 | P4 |
| `study-learning` | `study-learning` | `study_tutoring_link` | 同插件，仅登记 | v1 | P4 |
| `study-outcomes` | `study-facts` | `study_task*`、`study_plan*`、`study_plan_task`、`study_material(id,title)` | 日/周/月统计与对账 | v1 | P6 |
| `study-reminders` | `study-facts` | `study_task.goal_id`、`study_plan.goal_id` | 提醒按目标分组/复盘 | v1 | P5 |
| `study-outcomes` | `study-learning` | `review` 命名空间方法 | 成果页报告区（软依赖） | v1 | P6 |
| `study-core` | 所有 | 全部表 | 导出/备份只读转储 | v1 | P1/P7 |

写路径（不属于读契约，但必须登记）：

| 写者 | 拥有者 | 方式 | 备注 |
| --- | --- | --- | --- |
| `study-facts`（plans） | `study-facts`（tasks） | 同插件，共享 `study-model` 的 `materializePlan` / `recordProgress` | 内部边界 |
| 任何插件 | 其他插件 | `ctx.study.call(ownerNamespace, method, payload, { requestId })` | 禁止直接 SQL 写 |
| 界面/Agent | 各拥有插件 | `POST /api/study/<ns>/<method>` 或 `ctx.study.call` | 必须带 `requestId` |

## 5. 事件

| 事件 | 生产者 | 消费者 | 语义 | 版本 |
| --- | --- | --- | --- | --- |
| `study/learning/changed` | `study-learning` | `study-memory`（可选） | 学习证据已提交，可重算教学参数 | v1 |
| `agent/pre-step` | DSH Host | `study-facts`（planning） | 计划创建上下文注入 | DSH |
| `agent/created` | DSH Host | `study-learning`（tutoring） | 会话创建后补投递上下文 | DSH |
| `agent/inbox/claimed` | DSH Host | `study-learning` | 捕获用户回合 | DSH |

规则：事件只通知“发生了什么”，不是命令；消费者必须容忍事件缺失；新增事件先登记再实现。

## 6. 工具

> P0 从各模块的 `ctx.tools.register` 扫描完整列表；工具名全局唯一。

| 工具 | 拥有插件 | 说明 | 阶段 |
| --- | --- | --- | --- |
| `study_status` | `study-core` | 内核状态 | P1 |
| `study_export` | `study-core` | 导出学习数据 | P1 |
| `study_questions`、`study_insights` 等 | `study-learning` | 问答/分析/报告 | P4 |
| `study_tutoring` 等 | `study-learning` | 答疑上下文 | P4 |
| memory 系列 | `study-memory` | remember/recall/forget/profile | P2 |
| tasks/plans/materials 系列 | `study-facts` | 事实层读写 | P3 |
| followup 系列 | `study-reminders` | 提醒/复盘 | P5 |

## 7. 客户端契约

### 7.1 页面

| key | 拥有插件 | 目标 order | 目标 locale NS | label key | 阶段 |
| --- | --- | --- | --- | --- | --- |
| `today` | `study-core` | 20 | `study-core` | `today.panel` | P1 |
| `onboarding` | `study-facts` | 1 | `study-facts` | `onboarding.panel` | P3 |
| `workbench` | `study-facts` | 10 | `study-facts` | `workbench.panel` | P3 |
| `timer` | `study-facts` | 15 | `study-facts` | `timer.panel` | P3 |
| `plan` | `study-facts` | 16 | `study-facts` | `plan.panel` | P3 |
| `reminders` | `study-reminders` | **17**（原 16） | `study-reminders` | `reminders.panel` | P5 |
| `outcomes` | `study-outcomes` | 25 | `study-outcomes` | `outcomes.panel` | P6 |
| `questions` | `study-learning` | 70 | `study-learning` | `questions.panel` | P4 |
| `memory` | `study-memory` | 80 | `study-memory` | `memory.panel` | P2 |

规则：key 不改名；order 全局唯一；label key 必须在所属插件字典中存在；页面组件不得跨 bundle import。

> 迁移期例外：P3–P4 期间 `plan=16` 与仍在 shell 的 `reminders=16` 跨插件同值，侧栏顺序由行序/注册序决定；P5 把 reminders 改为 17 后消除。最终状态必须唯一。

### 7.2 客户端共享服务（`study-core` 提供）

| 服务 | 职责 | 替代的现有实现 |
| --- | --- | --- |
| `studyClient` | `call(ns, method, payload)`、写操作 `requestId` 幂等、错误信封 | `client/lib/api.js` |
| `studyRefresh` | 数据变更发布/订阅 | `client/lib/refresh.js` 的模块级 `Set` |
| `studyNav` | 记住/恢复最后页面、按 key 打开 | `client/lib/study-page.js` |
| `studyUi` | 面板图标、共享组件/样式 | `client/lib/panel-icon.js` 等 |

功能插件客户端必须 `inject` 这些服务（通过 `dsh.client.inject` 声明 `@studybuddy/study-core`）。

### 7.3 共享文案

| 模块 | 内容 | 归属 |
| --- | --- | --- |
| `client/messages/common.js` | 通用加载/错误/工作区文案 | `packages/study-messages` |
| `client/messages/daily.js` | 跨页动作/状态文案 | `packages/study-messages` |
| `client/messages/tutoring.js` | 仅 `tutoring.ask*`，服务 workbench 的“问这道题”动作 | `study-facts`（随 `actions/ask-task.js` 迁入） |
| 页面专属字典 | 各页面 `messages/<page>.js` | 随页面迁入对应插件 |

> `learning-notify.js` 被 reminders 页使用，P5 随 reminders 迁入 `study-reminders`；不要放进 learning，也不要跨 bundle import。

## 8. profile / bundle 行

目标 `@studybuddy/bundle/cordis.patch.yml`（P7 定稿）：

| 行/配置 | 内容 | 来源 |
| --- | --- | --- |
| 账号/遥测禁用 | `deepseek-account`、`llm-deepseek-account`、`ui-settings-account`、`account-controller`、`session-log-deepseek`、`session-telemetry-otel`、`desktop-product-telemetry`、`product-analytics` | 现有 `deploymentPolicy` |
| 内置 `credentials` | `disabled: true` | 现有策略 |
| `workspace-controller` | `documentsDirectory` 指向数据根 workspace | 现有策略 |
| `project-credentials` | `@studybuddy/platform-windows-credentials` + DPAPI 路径 | 现有策略 |
| `study-core` | `@studybuddy/study-core` + `dataDir` | 新增 |
| `study-facts`、`study-learning`、`study-memory`、`study-reminders`、`study-outcomes` | 包名行，无 config | 新增 |
| `a02-probe` | **删除** | 现有策略 |

- profile 的 `dsh.profile.bundles` 追加 `@studybuddy/bundle`；模型配置仍由启动器首次写入 profile，不在 bundle 里覆盖用户编辑。
- 开发期可用 `link:` 或 `--patch` 叠加；发行期固定版本。
- 行顺序：core → facts → memory/learning/reminders/outcomes；具体以依赖为准。

## 9. 兼容与版本

| 项 | 值 | 备注 |
| --- | --- | --- |
| DSH 版本 | `0.2.2-rc.1`，基线 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` | 本计划不升级 |
| Node | `v26.13.0` | 本机 |
| 平台 | Windows x64 | 先 Windows |
| core schema | `CORE_SCHEMA_VERSION`（以 `host/db.mjs` 为准） | 不 bump |
| 模块 schemaVersion | 现有模块以代码为准；新模块用 1 | 不 bump 既有模块 |
| 读契约版本 | 统一从 v1 开始 | 改表必须 bump |

## 10. P0 必须核对的清单

- [ ] 每个模块的 `id`、`deps`、`schemaVersion`、`schema` 与表/索引/触发器/FTS 完整列表；
- [ ] 每个命名空间的方法名与写方法集合（以 `register` 的 `writes` 为准）；
- [ ] 每个工具的名称、参数、所属插件；
- [ ] 每个页面的 key、order、label、locale NS、messages 依赖；
- [ ] `client/actions/*` 的 id、所属页面、运行依赖；
- [ ] 共享字典键的跨页使用清单（common/daily/其它）；
- [ ] `deploymentPolicy` 的完整行与 config；
- [ ] 现有测试目录与 import 依赖，确定迁移归属；
- [ ] 行 id、包名、`dsh.client.inject`、`engines.dsh` 的最终值；
- [ ] 用户对 facts 单插件、memory 试点、order 调整（reminders 17）的确认。
