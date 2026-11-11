# SB-05 当前备考目标作用域贯通任务/计划/成果

- 状态：DONE
- 优先级：P1
- 来源：issue 06
- 依赖：SB-01
- 预计：1 个会话
- 所有权：`plugins/study/host/modules/materials.mjs`、`plugins/study/host/modules/plans.mjs`、`plugins/study/host/modules/tasks.mjs`、`plugins/study/host/modules/outcomes.mjs`、`plugins/study/host/modules/followup.mjs`、`plugins/study/host/modules/tutoring.mjs`、`plugins/study/host/modules/memory.mjs`、`plugins/study/client/pages/*.js`、`plugins/study/tests/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-06`；设计 §7.4；T08、T09 任务卡。

## 1. 问题

目标表支持多个目标和 `active` 标志，但业务上下文不按目标隔离：

- `plans.latestPlanRow` 按全局更新时间选择计划；激活 A 目标后仍可能返回最近创建的 B 计划。
- `tasks.day/week` 返回所有活跃任务；`study_task` 没有 `goal_id`。
- 复盘状态只按日期查询，没有目标维度。
- 成果统计混合所有目标；材料/答疑上下文可能跨目标。
- 记忆没有目标作用域（与 SB-14 配合）。

## 2. 当前证据

- `materials.mjs` 的 `study_goal` 有 `active`，`saveGoal` 可切换激活目标。
- `tasks.mjs` 的任务/时间块表没有 `goal_id`；`day/week` 无目标过滤。
- `plans.mjs` 的 `latestPlanRow` 没有 goal 过滤。
- 复现脚本场景 6：创建 A/B 目标及计划，激活 A，默认读取仍返回 B。

## 3. 正确业务逻辑

1. 每份业务数据有明确 `goalId`：计划、任务、时间块、进度、复盘、成果、材料关联、记忆。
2. 默认解析“当前激活目标”：显式传入 `goalId` 优先；否则读取 `study_goal.active = 1`；没有激活目标时返回明确空态，不猜最近计划。
3. 所有列表/今日/周/成果/复盘按当前目标过滤；跨目标查看必须显式切换或选择。
4. 复盘去重键为 `goalId + date`；同一日期不同目标分别记录。
5. 切换目标只影响后续读取/写入；不删除/迁移另一个目标的数据。
6. 任务/计划创建时写入当前 `goalId`；跨目标移动/复制必须显式操作并保留来源。
7. Agent 工具和 UI 使用同一 `resolveActiveGoal`，不能各自猜。

## 4. 修改范围

- `tasks`/`study_time_block`/`study_task_progress` 增加 `goal_id` 和索引；迁移旧数据到默认激活目标（没有则创建/标记 `unassigned`）。
- `plans` 按 `goalId` 查询；`latestPlanRow` 需要 goal 参数。
- `outcomes` 查询按 goal 过滤；`milestones` 同期。
- `followup` 的 review/due 按 goal；`review` 去重键 `goal+date`。
- `tutoring`/`memory` 读取当前目标上下文；记忆记录增加 `goalId`（SB-14 落字段）。
- UI 增加目标切换/当前目标显示；所有页面传 `goalId`。

## 5. 验收标准

- [ ] A/B 两个目标各有计划/任务；激活 A 后 `plans.get/today`、`tasks.day`、`outcomes.day` 只返回 A。
- [ ] 切到 B 后返回 B；不会出现 A 的任务或 B 的计划。
- [ ] 同一天两个目标各自复盘，记录不互相去重。
- [ ] 旧任务迁移后有明确 goal；无目标数据进入 `unassigned`，不丢失。
- [ ] Agent 工具与 UI 读取同一当前目标。
- [ ] `node --test --test-isolation=none plugins/study/tests` 相关模块通过。

## 6. 不做

- 不做多账号/同机隔离。
- 不做跨目标自动合并或复制；需要时显式操作。
- 不在本卡实现记忆相关性检索（SB-14 负责）。

## 7. 完成后

1. 记录迁移策略、当前目标解析规则和 A/B 验收结果。
2. 更新 `README.md` 状态表。
3. 如果 SB-01 已加 `goalId` 预留字段，复用，不重复迁移。

## 完成记录

- 会话：与 SB-01 同两个会话（2026-11-10/11）。
- 主要修改：
  - `plugins/study/host/facts.mjs`：`resolveActiveGoal(db, goalId)` 作为服务、工具、页面的唯一目标解析入口；迁移补齐 `goal_id` 与索引。
  - `plugins/study/host/modules/materials.mjs`：`saveGoal` 维护唯一 `active` 目标。
  - `plugins/study/host/modules/plans.mjs`：`latestPlanRow`/`get`/`today`/`week`/`progress` 按目标查询；计划创建继承当前目标，跨目标转移必须显式。
  - `plugins/study/host/modules/tasks.mjs`：任务、时间块、进度写入和 `day`/`week`/`list`/`progress` 读取按 `goal_id` 过滤；时间块继承其任务的目标。
  - `plugins/study/host/modules/outcomes.mjs`、`followup.mjs`、`tutoring.mjs`、`memory.mjs`：成果、复盘、答疑上下文与记忆按当前目标读取；复盘去重键为 `goalId + date`；记忆记录带 `goalId`。
  - 客户端：`client/components/goal-scope.js` 提供当前目标下拉并在切换后重挂载学习界面；`client/plugin.js`、`client/studyleft.js` 包装页面；计划/工作台/成果/复盘/计时/引导页面读写都传当前目标。
  - 测试：`plugins/study/tests/plans/foundation.test.mjs`（两例 SB-05）、`tests/materials/goals.test.mjs`、`tests/followup/review.test.mjs`、`tests/client/*`。
- 迁移策略：`study_task`、`study_time_block`、`study_task_progress`、`study_followup_review`、`study_followup_reminder` 增加 `goal_id TEXT NOT NULL DEFAULT 'unassigned'` 和索引；迁移时把历史数据归到当前激活目标，没有激活目标则保留 `unassigned`。计划表补 `goal_id`。不会删除或复制另一个目标的数据。
- 当前目标解析规则：显式 `goalId` 优先（`unassigned` 可直接查询）；否则读取 `study_goal.active = 1`；没有激活目标时使用 `unassigned` 空作用域，不猜最近计划。Agent 工具与 UI 共用 `resolveActiveGoal`。
- 日程冲突语义：每个目标拥有独立日程。`createBlock`/`updateBlock`/`moveBlock` 的重叠检查只针对同一 `goal_id` 的时间块；同一目标内重叠仍返回 `conflict`，`allowOverlap: true` 才能保留。这样在 B 目标页面不会被 A 目标看不见的时间块拦住；把时间块改挂到另一目标的任务时，块随任务移动到该目标。界面一次只显示一个目标，跨目标查看必须显式切换。
- 验证（真实结果）：
  - `node --test --test-isolation=none plugins/study/tests/plans/foundation.test.mjs`：8/8；其中 A/B 切换后 `plans.get`、`tasks.day`、`outcomes.day`、`followup.reviewStatus` 只返回当前目标；同一天两个目标可各有一个 09:00–10:00 块，而同目标内重叠仍返回 `conflict`；记忆不跨目标泄漏。
  - 整套 `node --test --test-isolation=none plugins/study/tests`：553 例，552 pass / 0 fail / 1 skip。
  - `node plugins/study/tests/kernel/loader-smoke.mjs`：`passed: true`。
- 已知限制：没有跨目标合并日程或统一日历视图；历史 `unassigned` 数据不会自动并入后来创建的目标；目标切换依赖 `study:goal-changed` 事件重挂载页面；没有跨目标的自动迁移/复制。
