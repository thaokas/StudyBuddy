# SB-06 提醒按执行块结束时间触发，身份按块

- 状态：DONE
- 优先级：P1
- 来源：issue 07
- 依赖：无（建议在 SB-01 之后做，以便使用稳定块 ID）
- 预计：0.5–1 个会话
- 所有权：`plugins/study/host/modules/followup.mjs`、`plugins/study/tests/followup/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-07`；设计 §4.5；T12 任务卡。

## 1. 问题

- 现在只要时间块开始（`first.startMinute <= now`）就生成进度询问；09:00–10:00 的块在 09:00 就会被问，而不是等预计结束仍未勾选。
- 提醒身份是 `task + date + morning/afternoon/evening`；同一任务同一上午的两次执行只能有一个身份，无法分别答复。
- 同一时段内所有块被合并，包括尚未开始的未来块；`end` 取最大值、`minutes` 求和，导致“逾期 60 分钟”包含未来工作。

## 2. 当前证据

- `followup.mjs` 的 `computeDue` 只比较 `first.startMinute`。
- key 为 `task:${taskId}:${date}:${period}`。
- `tests/followup/reminders.test.mjs` 固定了“09:10 对 09:00–10:00 提问”和“把 09:40 的未来块合并”的行为。
- 复现脚本场景 7。

## 3. 正确业务逻辑

1. **结束触发**：只有执行块 `endMinute <= now` 且该任务当前没有完成/取消/待确认答复时，才进入询问。
2. **块级身份**：key 使用 `blockId`（或 `taskId + blockId`），同一任务不同执行块分别询问、分别答复；同一块只主动问一次。
3. **只合并展示**：多项同时到期可以合成一个 banner/feed，但每项保留独立 key、状态和答复；不能合并成一条无法区分的记录。
4. **不把未来块算逾期**：当前提醒的 `blocks/minutes/overdue` 只包含已结束且未完成的块；未来块不进入本次提醒。
5. **重新检查进度**：触发前读取最新任务进度；已完成/取消/已答复的块不再问。
6. **静默/专注/稍后/恢复不补发**：保留现有规则；延后期间不消耗询问次数，恢复后只问最近仍有效的块。
7. **幂等**：同一块重复轮询/重复 claim 不产生第二条提醒。

## 4. 修改范围

- `computeDue`：按块判断 `endMinute <= minute`；按 `blockId` 分组；过滤未来块。
- `study_followup_reminder`：key/字段支持 `block_id`；迁移旧 key 或让旧记录过期，不重放。
- `reminderItem`：`start/end/minutes/overdueMinutes` 只基于已结束块；`blocks` 只含已结束块。
- `claim/answer/snooze`：按块 key 幂等；答复写对应任务进度。
- 测试：开始不提醒、结束提醒、未来块不合并、同任务两块分别答复、静默/专注、无补发、重复轮询。

## 5. 验收标准

- [x] 09:00–10:00 的块在 09:00 不提醒；10:00 后仍未勾选才提醒。
- [x] 同一任务 09:00–09:30 和 09:40–10:10 两块，10:20 时合并展示但分别有 key/状态；10:10 前不把第二块算逾期。
- [x] 同一块重复轮询/claim 不产生第二条提醒。
- [x] 答复“完成”后对应任务进度为 done；另一块不受影响。
- [x] 关闭/重启应用不补发已错过的块。
- [x] `node --test --test-isolation=none plugins/study/tests/followup` 通过。

## 6. 不做

- 不实现系统通知（SB-07 的简单 B）。
- 不实现自动复盘（SB-07）。
- 不改变“未勾选不等于未学习”的语义。

## 7. 完成后

1. 记录新旧 key 的迁移/过期策略和测试结果。
2. 更新 `README.md` 状态表。
3. 与 SB-04 对齐：提醒答复只写进度，不直接移动块。

## 8. 完成记录（2026-11-11）

**实现**

- `computeDue` 只收集 `block.endMinute <= 当前分钟` 的非固定、有任务、任务未删除的块；未来块不进入 `newItems`/`pendingItems`/`deferredItems`，也不计入 `minutes`/`overdueMinutes`。
- 提醒身份改为 `block:<blockId>`；每块独立 `state`/`outcome`/`snooze_until`。同一任务多个块各自询问、各自答复；多项同时到期由客户端 banner/feed 合并展示，但服务返回逐项的 key、状态和答复。
- `study_followup_reminder` 增加 `block_id` 列；旧 `task:<task>:<date>:<period>` 记录在 `followup.apply` 时统一标记 `expired`，不重放；旧库通过 `PRAGMA table_info` 增量补列。
- `reminderItem` 的 `blocks` 只含已结束块；`start` 取最早开始，`end`/`minutes`/`overdueMinutes` 只基于已结束块。
- `claim` 以 key 幂等（`ON CONFLICT DO NOTHING`）；`answer` 按块写 `tasks.recordProgress`，重复同一答复返回 `duplicate`，进度写入失败时提醒保持 `shown`；`snooze` 按块延后，静默/专注只延后不消耗询问机会。
- 恢复点：`resumeInfo` 在心跳过期时把当前时刻作为新的 `resumed_at`，`computeDue` 只允许结束时间不早于恢复点的块；关闭/重启应用不补发已错过的块。

**测试**

- `node --test --test-isolation=none plugins/study/tests/followup`：38 pass / 0 fail。覆盖开始不提醒、结束提醒、两个块独立 key/逾期分钟、重复 claim/answer、答复写任务账本、静默/专注/稍后、重启不补发、失败不宣布成功。

**已知限制**

- 提醒仍由 Host 15 秒心跳和 Renderer 15 秒轮询驱动，不是 DSH Schedule；应用关闭时不提醒（与设计一致）。
- 同一任务被快捷答复为 `done` 后，另一未结束块仍会单独询问；这正是“按块分别答复”的语义，不是重复提醒。
- 提醒的时段字段仍保留用于页面分组/展示，但不再参与身份或触发判断。
