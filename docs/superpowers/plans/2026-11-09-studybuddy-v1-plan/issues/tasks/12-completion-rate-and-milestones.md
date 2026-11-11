# SB-12 完成率三口径统一与个人里程碑

- 状态：TODO
- 优先级：P1（完成率）/ P2（个人里程碑）
- 来源：issue 20
- 依赖：SB-01
- 预计：1 个会话
- 所有权：`plugins/study/host/modules/tasks.mjs`、`plugins/study/host/modules/outcomes.mjs`、`plugins/study/host/modules/milestones.mjs`、`plugins/study/client/pages/workbench.js`、`plugins/study/client/pages/outcomes.js`、`plugins/study/client/components/feedback.js`、`plugins/study/tests/outcomes/**`、`plugins/study/tests/milestones/**`、`plugins/study/tests/progress/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-20`；设计 §4.7；T13、T14 任务卡。

## 1. 问题

- 工作台自己的完成率把取消任务从分母扣除，两项任务完成一项、取消一项时显示 100%；成果页另算原计划/调整后/取消，两个页面口径不一致。
- 没有同时展示“原计划基线、调整后基线、取消数”，容易把取消当成完成。
- 里程碑只有固定完成条数目录，没有学生自己的阶段成果写入入口。

## 2. 当前证据

- `tasks.mjs` 的完成摘要从分母扣掉取消任务；工作台突出该比率。
- `outcomes.mjs` 另行计算原计划/调整后/取消占比。
- `milestones.mjs` 的 CATALOG 是固定模板；没有学生自定义里程碑表/入口。
- 复现脚本场景 20。

## 3. 正确业务逻辑

1. **单一成果服务**：工作台/成果页/里程碑都调用 `outcomes` 的三口径，不在页面本地重算“完成率”。
2. **三口径并列**：原计划（当天开始时存在的工作）、调整后（当前计划）、主动取消（数量和占比）同时显示；取消不进入分子，也不从原计划分母消失。
3. **未记录/待确认**：不当作完成，也不当作未学习；单独显示。
4. **个人里程碑**（如果保留“完整成就”）：学生可定义阶段成果（例如“完成高数第三章”），关联真实记录；只在确认完成记录满足时点亮；不做积分/连续打卡惩罚。
5. **取消**：取消任务只影响“取消占比”和调整后分母，不能把原计划完成率抬高。
6. **空数据**：没有计划/记录时显示空态，不伪造 100%。

## 4. 修改范围

- `tasks.mjs`：移除/降级本地完成率；返回原始计数，由成果服务计算。
- `outcomes.mjs`：确保三口径字段完整，供工作台复用；增加 `goalId` 过滤（SB-05）。
- `milestones.mjs`：增加个人里程碑存储/读取/点亮；复用 outcomes 的 confirmed done 记录。
- 页面：工作台显示三口径摘要；成果页/里程碑页使用同一数字。
- 测试：两项任务一完成一取消；原计划 50%、调整后 100%、取消 1；个人里程碑只由真实记录点亮；空态。

## 5. 验收标准

- [ ] 两项任务完成一项、取消一项：工作台同时显示原计划 1/2、调整后 1/1、取消 1；不再只显示 100%。
- [ ] 取消任务不提高原计划完成率。
- [ ] 成果页与工作台数字交叉核对一致。
- [ ] 个人里程碑只有在关联记录 confirmed done 时点亮；取消/待确认不计。
- [ ] 空数据不显示 100%；无模型可用。
- [ ] `node --test --test-isolation=none plugins/study/tests/outcomes plugins/study/tests/milestones plugins/study/tests/progress` 通过。

## 6. 不做

- 不做积分、徽章经济、排行、社交分享、连续打卡惩罚。
- 不把“提问次数”当掌握度。
- 不在本卡做提醒/复盘。

## 7. 完成后

1. 记录三口径数字对照和个人里程碑示例。
2. 更新 `README.md` 状态表。
3. 如果“完整成就”不包含个人自定义里程碑，可只完成完成率部分，并在卡末说明个人里程碑延后。
