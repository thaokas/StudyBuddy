# SB-01 统一任务、时间块、计划条目和进度

- 状态：DONE
- 优先级：P0
- 来源：issue 01、issue 04
- 依赖：无；建议作为所有后续卡的第一步
- 预计：2 个会话
- 所有权：`plugins/study/host/modules/plans.mjs`、`plugins/study/host/modules/tasks.mjs`、`plugins/study/host/modules/outcomes.mjs`、`plugins/study/host/modules/tutoring.mjs`、`plugins/study/host/db.mjs`、`plugins/study/tests/plans/**`、`plugins/study/tests/progress/**`、`plugins/study/tests/tasks/**`、`plugins/study/tests/outcomes/**`
- 开工阅读：本卡；`issues/2026-11-10-design-code-review.md#issue-01`、`#issue-04`；设计 §4.3、§5、§6；`PLAN.md` 第 7 节不变量。

## 1. 问题

计划条目（`study_plan_revision.snapshot_json.items`）和工作台任务/时间块（`study_task`、`study_time_block`）是两套业务事实：

- 引导页确认计划后，`plans` 有条目，但 `tasks.day` 没有任务、没有时间块；工作台和左栏为空。
- 工作台拖拽时间块只改 `study_time_block`，计划服务不更新；Agent 的 `study_plan today` 读不到这次拖拽。
- 计划条目 ID 默认由标题/材料/预计时间/日期/起止时间等内容生成；改期后如果调用方省略 ID，会得到新 ID，旧进度变成 `unrecorded`。
- 同一项学习可能同时以 plan item 和 task 存在，成果统计没有跨源去重。

## 2. 当前证据

- `plans.mjs` 的 `study_plan_revision` 只保存 `snapshot_json`；`confirmPlan` 只追加修订，没有创建任务/时间块。
- `tasks.mjs` 有独立的 `study_task`、`study_time_block`；没有计划条目到任务的关联字段。
- `plans.mjs` 的条目 ID 允许省略并按内容生成；`normalizeItem` 使用标题、材料、预计时间、日期、起止时间计算默认 ID。
- `outcomes.mjs` 的 `original/adjusted` 同时汇总 task 和 plan 单元，`bySource` 只分组，没有去重。
- 复现脚本：`node docs/superpowers/plans/2026-11-09-studybuddy-v1-plan/issues/evidence/design-code-review-probes.mjs`（场景 1、4）。

## 3. 正确业务逻辑

1. **唯一执行事实**：`study_task` + `study_time_block` 是“做什么/什么时候做”的权威记录。计划修订保存目标、假设、条目定义和稳定的 `taskId`/`blockIds`。
2. **确认即物化**：`plans.confirm` 在同一 SQLite 事务内，把本次修订中的每个执行条目创建为任务和时间块，并把生成的 ID 写回计划条目；失败则整个确认回滚。
3. **ID 稳定**：计划条目首次创建时分配不可变 `id`；后续修改必须带 `id`。禁止用标题、日期、起止时间、材料等内容重新生成 ID。
4. **双向可读**：`plans.today/week` 返回条目时带上当前任务/时间块的实时状态；`tasks.day/week` 不复制计划事实，只通过 `taskId` 关联。手动拖拽改块，计划页读到的就是新时间；Agent 调计划工具也能读到。
5. **进度唯一账本**：任务进度写入 `study_task_progress`；计划条目进度要么引用同一任务进度，要么只保留历史快照，不能维护两套可独立完成的进度。`study_progress` 与工作台勾选必须写同一账本。
6. **成果去重**：`outcomes` 对同一 `taskId` 只计一次；计划条目只作为任务的历史定义/基线，不再单独计入完成率。`bySource` 保留用于诊断，但不能让同一工作重复进入分母/分子。
7. **迁移**：已有数据库中的计划条目要生成任务/时间块，或明确标记“仅计划、尚未物化”，并写入迁移记录；不能静默丢弃，也不能用标题猜关联。旧 `plan_progress` 要映射到任务进度或保留为历史，必须有可核对的 trace。

## 4. 修改范围

### 4.1 数据模型

- 为计划条目增加 `taskId`、`blockIds`、`materialId` 的稳定引用；`id` 必填且唯一。
- 为 `study_task`、`study_time_block` 增加稳定的 `goalId`（SB-05 使用）；本卡可先预留字段和索引。
- 增加迁移表/迁移函数：`plan_item_id ↔ task_id`，记录来源修订号和迁移时间。
- 如需保留 `study_plan_progress`，把它定义为历史只读视图/兼容表，不能再作为第二套当前进度。

### 4.2 服务

- `plans.confirm` / `plans.revise` / `plans.undo` 与 `tasks.createTask/createBlock/moveBlock/updateTask/recordProgress` 通过同一个事务服务协作，不能在两个服务里各写一半。
- `plans.today/week` 读取任务/块实时状态；`tasks.day/week` 返回关联的计划条目 ID。
- `study_plan` 工具读今日/周时使用统一读模型；`study_progress` 写任务进度。
- 所有写操作使用 SB-08 的 `requestId` 约定。

### 4.3 迁移与回滚

- 迁移前自动备份/记录数据库版本；迁移失败回滚事务并给出可操作错误。
- 旧计划条目生成任务时保留原 `plan_item_id` 和旧进度记录；无法映射的条目进入 `unmigrated` 列表，不删除。
- 必须有 dry-run 或测试夹具：旧库（只有 plans）→ 新库（plans + tasks + blocks）→ 回读一致。

## 5. 验收标准

- [ ] 引导页确认含 1 项任务的计划后，`tasks.day` 返回 1 个任务和 1 个时间块；计划页显示同一条目的实时时间。
- [ ] 工作台把该块从 09:00 拖到 10:00，`plans.today` 和 `study_plan today` 都返回 10:00；没有第二份“聊天计划”。
- [ ] 改期/改时间后任务 ID、计划条目 ID、历史进度关联都不变。
- [ ] 取消或完成只写一条当前进度；成果中同一任务只计一次。
- [ ] 旧数据库迁移后，计划条目/任务/进度可以交叉核对；迁移失败不丢数据。
- [ ] `node --test --test-isolation=none plugins/study/tests/plans plugins/study/tests/tasks plugins/study/tests/progress plugins/study/tests/outcomes` 通过。
- [ ] `node plugins/study/tests/kernel/loader-smoke.mjs` 通过。

## 6. 不做

- 不重写 Agent 对话逻辑；不新增 UI 页面；不实现 SB-02 的按钮/工具（只保证服务读模型可用）。
- 不改变“取消不计入完成率”“未记录不等于未学习”等既有不变量。
- 不删除旧表；迁移以保留历史为优先。

## 7. 完成后

1. 在卡末追加“完成记录”：分支/会话、修改文件、迁移说明、测试命令与真实结果、已知限制。
2. 更新 `README.md` 状态表。
3. 如果发现 SB-02/SB-05 需要字段调整，先在本卡记录，不直接改它们的卡。

## 完成记录

- 会话：2026-11-10 至 2026-11-11 的数据基础修复会话（DSH，`rollout-2026-11-11T00-12-16-01a1c63b-…`）；本卡与 SB-05、SB-03、SB-08 串行完成。
- 主要修改：
  - `plugins/study/host/facts.mjs`：新增 `materializePlan`（确认/修订时在同一 SQLite 事务里创建或更新任务与时间块，并把稳定 `taskId`/`blockIds` 写回条目）、`livePlanData`（计划读取使用任务/时间块实时投影）、`migrateFoundation`（迁移）。
  - `plugins/study/host/db.mjs`：打开数据库时执行数据基础迁移。
  - `plugins/study/host/modules/plans.mjs`：确认/修订/撤销调用统一物化；条目 `id` 必填且不按内容重新生成；计划修订只保存定义与引用。
  - `plugins/study/host/modules/tasks.mjs`：`study_task`/`study_time_block` 增加 `goal_id`；计划条目到任务通过 `study_plan_task` 关联；`study_task_progress` 成为唯一当前进度账本；今日/周视图返回任务的实时时间与计划条目 ID。
  - `plugins/study/host/modules/outcomes.mjs`：按 `taskId` 去重计数，计划条目只作历史定义，`bySource` 仅诊断。
  - `plugins/study/host/modules/tutoring.mjs`：答疑上下文读取同一任务/计划事实。
  - 测试：`plugins/study/tests/plans/foundation.test.mjs`、`plugins/study/tests/plans/migration.test.mjs`，并同步更新受新契约影响的 `tasks`/`progress`/`outcomes`/`plans` 既有测试。
- 迁移说明：旧库首次打开时先 `VACUUM INTO <study.db>.foundation-<时间戳>.bak`；在单事务内补列（`goal_id`、`material_id`、`scheduled_date`、草案版本、`legacy_progress_id` 等）、建 `study_plan_task` 与 `study_foundation_unmigrated`、把历史计划修订物化为任务/时间块、把 `study_plan_progress` 映射到 `study_task_progress` 并保留旧 ID。失败整体回滚并给出备份路径；成功后写 `data_foundation_version=1`，只执行一次。无法映射的记录进入 `study_foundation_unmigrated`，不删除。
- 验证（真实结果）：
  - `node --test --test-isolation=none plugins/study/tests/plans plugins/study/tests/tasks plugins/study/tests/progress plugins/study/tests/outcomes`：154/154 通过。
  - `node --test --test-isolation=none plugins/study/tests`：553 例，552 pass / 0 fail / 1 skip。
  - `node plugins/study/tests/kernel/loader-smoke.mjs`：`passed: true`；模块含 `tasks`，鉴权路由 200、匿名 401。
  - `node --test --test-isolation=none plugins/study/tests/plans/foundation.test.mjs`：8/8（含 SB-01 的确认物化、拖拽后实时读取、进度与成果单任务计数）。
- 已知限制：迁移只在打开数据库时自动执行，没有独立 dry-run 命令；`study_plan_progress` 作为历史只读表保留；真实桌面点击级验收不在本卡范围。
