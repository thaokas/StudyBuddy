# 目标与 DSH 工作区关联

- 日期：2026-11-11
- 状态：已实施

## 结论

一个备考目标可以关联多个 DSH 工作区。关联是目标自身的元数据：DSH 负责工作区注册表与标题/路径，StudyBuddy 只保存工作区 id；界面每次从 DSH 的实时工作区快照解析名称，因此重命名会立即显示新名称，已删除的工作区显示为“工作区已不可用”而不是静默消失。

数据关系保持：

```text
备考项目（目标）
  ├─ 1 份正式计划（plans 服务的 plan.goalId）
  ├─ N 份学习资料（materials 服务的 goal_id）
  └─ N 个 DSH 工作区（study_goal_workspace）
```

## 数据与接口

- `materials.saveGoal` 增加可选 `workspaceIds: string[]`：
  - 省略：保留现有链接（旧客户端和切换 active 的调用不会被清空）；
  - `[]`：清空链接；
  - 数组：整体替换，去重并保持传入顺序；最多 32 个。
- `materials.getGoal` / `listGoals` 的目标摘要增加 `workspaceIds`，按链接创建顺序返回。
- 新表 `study_goal_workspace(goal_id, workspace_id, created_at)`；旧库在插件启动时由 `ensureGoalWorkspaceSchema` 幂等补建，不提升 `materials` 的 schemaVersion（沿用 tasks/progress 的增量表做法）。
- `study_export` 增加 `goalWorkspaces` 分组；旧库没有该表时导出为空数组。

## 界面

- **开始 → 目标**：新增“关联工作区”多选列表。展示 DSH 工作区的标题和路径；目标已关联但注册表里已不存在的工作区仍保留为可取消的“工作区已不可用”行。
- 旧版浏览器草稿没有 `workspaceIds` 字段；首次打开时从当前目标补齐，避免一次旧草稿保存把已有链接清空。
- **计划页**：正式计划摘要显示当前目标的关联工作区名称；已删除的链接标为“工作区已不可用”。

## 不做

- 不按工作区自动切换目标，也不把工作区内容复制进学习库；关联只是显式记录，不改变 DSH 工作区、会话或文件。
- 不在 DSH 工作区注册表里写学习目标，避免两套事实互相覆盖。
