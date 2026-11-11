# SB-04 剩余量、复盘拆分、暂定块和未安排再调度

- 状态：DONE
- 优先级：P1
- 来源：issue 05、issue 09
- 依赖：SB-01
- 预计：1–2 个会话
- 所有权：`plugins/study/host/modules/followup.mjs`、`plugins/study/host/modules/plans.mjs`、`plugins/study/tests/followup/**`、`plugins/study/tests/plans/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-05`、`#issue-09`；设计 §4.6；T12 任务卡。

## 1. 问题

- 部分完成的任务在每次复盘时用“当前估算 × 剩余比例”重新折算，并把折算值写回条目估算；连续复盘会重复缩小剩余量。
- 复盘跳过 `date === null`、未记录和待确认条目；未安排队列不会进入下次重排。
- 复盘只尝试把整项放入某一天，不能按剩余量拆分到多个执行块；未来两天各 30 分钟时，60 分钟任务仍全部未安排。
- 待确认工作没有暂定执行块，确认完成后也没有清理重复块的流程。

## 2. 当前证据

- `followup.mjs` 的 `remainingMinutesOf` 用当前 `estimateMinutes` 乘剩余比例；`applyProposal` 又把 `minutes` 写回 `estimateMinutes`。
- `buildProposal` 对 `date === null`、`unrecorded`、`pending_confirmation` 直接 `kept`。
- `placeItem` 只做整项放置，不能拆块。
- 复现脚本场景 5、9。

## 3. 正确业务逻辑

1. **保留计算基数**：任务保存原始估算、总工作量和累计完成量；剩余量每次从原始基数和最新进度计算，不修改原始估算。
2. **剩余量公式**：`remaining = max(1, ceil(originalEstimate × (total - done) / total))`；没有数量时按状态处理（partial 保留原估算并由用户补充，done 为 0）。
3. **可拆分**：复盘把剩余量拆成多个执行块，优先使用预留/弹性空间；每块保留 `taskId` 和来源。
4. **暂定块**：未记录/待确认任务可以生成 `tentative: true` 的暂定块，带 `assumption` 和 `sourceProgressRevision`。
5. **确认清理**：学生确认完成后，删除/标记该任务的暂定重复块；不能把已完成量再排一次。
6. **未安排再调度**：`date: null` 的剩余工作进入下一次复盘的候选队列；容量不足时保留未安排并解释，不静默删除。
7. **幂等**：同一进度版本重复复盘得到相同剩余量；不重复创建暂定块。

## 4. 修改范围

- `followup.mjs`：`remainingMinutesOf` 改为只读计算；`buildProposal` 纳入未安排队列和待确认暂定块；`placeItem` 支持拆分；`applyProposal` 不覆盖原始估算。
- `plans.mjs`/任务模型：提供原始估算、累计完成量、剩余量字段或计算服务；增加 `tentative`、`assumption` 字段。
- 复盘记录保存 `sourceProgressRevision`、拆分块和暂定块；支持清理。
- 测试：连续两次复盘不缩水；60 分钟 5/10 → 两次各 30；两天各 30 可拆；待确认暂定；完成清理；未安排队列参与。

## 5. 验收标准

- [x] 60 分钟任务完成 5/10，第一次复盘剩余 30；没有新进度时第二次复盘仍为 30。
- [x] 未来两天各 30 分钟，60 分钟任务可以拆成两个 30 分钟块，而不是全部未安排。
- [x] 未记录/待确认任务生成暂定块，标记假设来源；学生确认完成后暂定重复块被清理。
- [x] `date: null` 的剩余任务下次复盘仍能被考虑。
- [x] 容量不足时保留未安排并解释，不伪造排得下。
- [x] `node --test --test-isolation=none plugins/study/tests/followup plugins/study/tests/plans` 通过。

## 6. 不做

- 不实现自动保存（SB-07 负责）。
- 不改变提醒触发时间（SB-06 负责）。
- 不引入模型调用；拆分/暂定由确定性代码完成。

## 7. 完成后

1. 记录“同一进度重复复盘”的测试结果和拆分示例。
2. 更新 `README.md` 状态表。
3. 如果 SB-01 尚未提供原始估算字段，先补 SB-01，不在 followup 里复制一份。

## 8. 完成记录（2026-11-11）

**实现**

- `remainingMinutesOf` 只读：原始估算取计划条目/task 的 `estimateMinutes`，完成量取最新进度记录；`remaining = max(1, ceil(original × (total − done) / total))`。复盘不再把折算结果写回 `estimateMinutes`，同一进度重复复盘得到相同剩余量。
- `buildProposal` 纳入 `date:null` 的未安排工作、未记录任务和 `confirmed:false` 的待确认任务；待确认/未记录生成的块带 `tentative: true`、`assumption` 与 `sourceProgressRevision`。
- 拆分：按剩余分钟在后续 7 天（或目标期限）的声明容量与真实空闲区间内生成多个执行块，每块保留 `taskId`/`itemId`；容量不足的部分保留为 `unscheduledMinutes` 并在 `explanations` 解释，不伪造排得下。
- 保存：`applyProposal` 写入 `blocks` 与 `unscheduledMinutes`；`plans.analyzePlan`、`planView.counts`、`progressSummary` 与 `plans.today/week` 现在把“已排块 + 未安排剩余”一起计入，所以复盘后计划不会显示成只剩已排部分。
- 清理：`tasks.recordProgress` 在确认 `done`/`cancelled` 时删除该任务未来的 `tentative` 块；同一进度版本重复复盘不会新建重复暂定块。
- 未安排再调度：`buildProposal` 的入口条件改为 `date:null` 或 `unscheduledMinutes > 0`，下一次复盘仍会考虑这些剩余工作。

**测试**

- `node --test --test-isolation=none plugins/study/tests/followup`：38 pass / 0 fail。新增/覆盖：
  - 60 分钟 5/10 连续两次复盘剩余 30、原始估算仍为 60；
  - 两天各 30 分钟拆成两个真实块，且两个日期都能从 `plans.today` 读到同一任务；
  - 未记录/待确认生成暂定块，确认完成后清理；
  - 容量不足时 `capacity.verdict='partial'`、`scheduledMinutes=20`、`unscheduledMinutes=40`、计划计数与进度汇总一致；
  - `date:null` 工作参与下次复盘。
- `node --test --test-isolation=none plugins/study/tests/plans`：40 pass / 0 fail。

**已知限制**

- 拆分是确定性的贪心填充（优先原开始时间，再从头找空档），不做学科交替、难度或前置顺序的优化；前置顺序仍由 `plans` 的 `dependency_order` 拒绝违规编排。
- 无数量任务的 `partial` 仍保留原估算，由学生补充/记录；复盘只按状态处理，不臆造完成比例。
- 容量不足时 `unscheduledMinutes` 目前是计划条目的元数据（不额外生成“未安排块”），但已进入容量、计划和进度汇总，不再隐藏。
