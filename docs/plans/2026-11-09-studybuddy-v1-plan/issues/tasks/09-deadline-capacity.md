# SB-09 期限、固定块和完整工作量进入容量判断

- 状态：TODO
- 优先级：P1
- 来源：issue 14
- 依赖：SB-01
- 预计：1 个会话
- 所有权：`plugins/study/host/modules/plans.mjs`、`plugins/study/host/modules/tasks.mjs`、`plugins/study/tests/plans/**`、`plugins/study/tests/tasks/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-14`；设计 §4.2；T09 任务卡。

## 1. 问题

容量判断只看计划 JSON 里的 `estimateMinutes` 和 `availability`：

- 读取了 `deadline`，但不判断条目日期是否超过期限；期限 11 月 10 日的目标，11 月 12 日任务仍判 `fits`。
- 不合并工作台固定课程/吃饭/休息块，计划可能把时间排到已被固定块占用的时段。
- 没有学习/练习/订正/休息的工作量拆分；没有用实际计时/完成记录校准估算。
- 依赖顺序只校验部分关系，没有把“必须在期限前完成”作为风险。

## 2. 当前证据

- `plans.mjs` 的 `analyzePlan` 按 JSON 条目和 `availability` 汇总，不读 `study_time_block`，不检查 `deadline`。
- 复现脚本场景 14：超期任务仍 `fits`。
- T09 验收只要求“容量不足保留未安排”，未覆盖期限/固定块。

## 3. 正确业务逻辑

1. **日历统一**：计划条目、任务、时间块、固定块使用同一本地日期/时区规则。
2. **期限约束**：条目 `date > goal.deadline` 或估算结束超过期限，产生 `deadline_exceeded` 风险；不能判 `fits`。用户仍可显式试行，但必须看到阶段影响。
3. **固定块占用**：容量扣除当天固定课程/吃饭/休息块；不能把学习块排到固定块上。
4. **工作量拆分**：条目可记录学习/练习/订正/休息分钟；容量按总分钟判断，不能只用一个估算。
5. **依赖**：前置任务未完成/安排在后续日期时产生 `dependency_order` 风险。
6. **估算校准**：实际计时/完成记录用于建议新估算，保留原始估算和学生决定；不能自动改写历史。
7. **结果**：返回按天容量、固定块占用、超期/依赖/重叠冲突和阶段目标影响；`requiresTrial` 仍由用户显式确认。

## 4. 修改范围

- `plans.analyzePlan`：读取当前目标的 deadline、固定块、任务/块；按天计算 available/used/fixed；增加 `deadline_exceeded`、`fixed_overlap`、`dependency_order`。
- 计划条目/任务增加工作量分类字段（可在 SB-01 预留）；旧数据默认全部算学习。
- 计时/完成记录读取用于估算建议；不自动写入。
- 测试：超期、固定块占用、依赖顺序、分类工作量、试行、容量不足、时区。

## 5. 验收标准

- [ ] 期限 11 月 10 日，11 月 12 日条目返回 `deadline_exceeded`，不能直接 `fits`。
- [ ] 09:00–10:00 固定课程存在时，09:30 学习块返回冲突，不能静默排入。
- [ ] 前置任务在后续日期时返回 `dependency_order` 风险。
- [ ] 学习/练习/订正/休息分钟参与容量；结果可解释。
- [ ] 用户显式 `trial:true` 仍可保留风险安排，不自动降低目标。
- [ ] `node --test --test-isolation=none plugins/study/tests/plans plugins/study/tests/tasks` 通过。

## 6. 不做

- 不自动改考试目标/教材/每日预算。
- 不自动缩减用户目标；只报告风险与选项。
- 不实现滚动细化（SB-18）。

## 7. 完成后

1. 记录新的容量字段/风险码和测试结果。
2. 更新 `README.md` 状态表。
3. 如果 SB-01 未提供固定块/任务关联，先补 SB-01。
