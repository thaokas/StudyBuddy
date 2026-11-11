# SB-16 换书/换任务建立明确替代关系

- 状态：TODO
- 优先级：P2
- 来源：issue 17
- 依赖：SB-01
- 预计：0.5–1 个会话
- 所有权：`plugins/study/host/modules/tasks.mjs`、`plugins/study/host/modules/plans.mjs`、`plugins/study/client/pages/workbench.js`、`plugins/study/client/pages/plan.js`、`plugins/study/tests/tasks/**`、`plugins/study/tests/plans/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-17`；设计 §6；T08/T09 任务卡。

## 1. 问题

- 任务/计划条目没有 `replaces/supersedes` 等替代字段或替换操作。
- 直接改任务的 `materialRef` 会沿用同一任务 ID 和已有完成状态：旧书的完成记录会被静默重新标注为新书。
- 没有“新任务引用旧任务、旧完成量保持原属”的流程。

## 2. 当前证据

- `tasks.mjs` 的 `study_task` 只有 `material_ref` 文本；`updateTask` 允许直接改。
- `plans.mjs` 的条目字段没有替代关系。
- 复现/静态确认见 issue 17。

## 3. 正确业务逻辑

1. 换书/换任务使用显式操作 `replaceTask`（或 `replaceMaterial`）：
   - 创建新任务，带 `replacesTaskId`；
   - 旧任务保留，记 `supersededBy`/`retiredAt`，不再出现在当前执行列表；
   - 旧进度记录保持原任务归属，不迁移、不改写。
2. 只有用户确认有依据的等价映射时，才允许把旧任务的完成量关联到新任务；默认不继承。
3. 新任务的教材/材料/章节题号必须重新提供或标 `unverified`；不能沿用旧书的页码题号。
4. 计划修订引用新任务 ID；旧计划修订保持历史，不回溯改写。
5. UI 提供“换书/替代”动作，展示旧任务、新任务、保留的完成记录；不能只改 `materialRef`。

## 4. 修改范围

- `tasks.mjs`：`replacesTaskId/supersededBy/retiredAt` 字段；`replaceTask` 服务；`updateTask` 禁止用 `materialRef` 直接替代（或警告）。
- `plans.mjs`：条目引用稳定工具 ID；替代时追加修订。
- UI：任务行“换书/替代”表单；展示旧记录/新任务。
- 测试：换书后旧任务完成量保留、新任务无继承、计划引用新任务、旧修订不变、重复替代幂等。

## 5. 验收标准

- [ ] 旧任务完成记录在换书后仍归旧任务，成果不消失、不迁移。
- [ ] 新任务带 `replacesTaskId`，旧任务带 `supersededBy`；当前列表只显示新任务。
- [ ] 新任务页码/题号未提供时标 `unverified`，不复制旧书位置。
- [ ] 直接改 `materialRef` 不再被当作换书；UI/服务提示使用替代操作。
- [ ] `node --test --test-isolation=none plugins/study/tests/tasks plugins/study/tests/plans` 通过。

## 6. 不做

- 不自动推断两本书题目等价。
- 不迁移旧完成量到新书。
- 不做教材版本管理平台；只做任务级替代关系。

## 7. 完成后

1. 记录换书数据示例和成果对照。
2. 更新 `README.md` 状态表。
3. 如果 SB-01 已加替代字段，复用。
