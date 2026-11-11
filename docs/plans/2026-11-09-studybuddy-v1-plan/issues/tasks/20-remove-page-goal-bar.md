# SB-20 移除学习页面顶部的「当前目标」选择栏

- 状态：DONE（2026-11-11）
- 优先级：P2
- 来源：用户 2026-11-11 需求 1
- 依赖：SB-05（目标作用域）、SB-19（创建计划）
- 预计：0.5 个会话
- 所有权：
  - `plugins/study/client/plugin.js`
  - `plugins/study/client/components/goal-scope.js`（删除）
  - `plugins/study/client/messages/common.js`
  - `plugins/study/client/client.js`（重建）
  - 本卡、`issues/tasks/README.md`、`STATUS.md`

## 1. 问题

SB-05 在每个学习页面外统一包了一层 `GoalScope`：顶部显示「当前目标」下拉，切换后重挂载页面。实际使用中：

- 番茄钟、记忆等页面也被包住，顶部多出一条与当前任务无关的目标选择栏。
- 正常流程只有一个激活目标；目标是「创建计划」第一步保存的，页面顶部再放一个切换器没有实际用途。
- 没有目标时下拉只剩「请选择目标」一个空选项，是死控件。
- 每个被包裹的界面都重复渲染同一行，视觉上像页面标题的一部分，容易误认为是当前计划。

用户要求：页面顶部不显示当前计划/目标；番茄钟和记忆页的选择栏一起删除。

## 2. 决策

只移除 **界面入口**，保留 SB-05 的数据作用域：

- 服务层、Agent 工具、页面读写仍通过 `resolveActiveGoal(db, goalId)` 解析当前目标；`goal_id` 列、按目标过滤、跨目标不泄漏等规则不变。
- 目标的创建与激活只在「创建计划」的目标步骤发生；不再提供页面级切换。
- 页面挂载时读取当前激活目标；切换目标后，已打开的其他学习页面在下次进入时刷新（不额外广播重挂载）。

## 3. 修改

- 删除 `client/components/goal-scope.js`。
- `client/plugin.js`：`main` 槽直接注册 `page.Page`，去掉 `GoalScope` 包装与 `react` 默认导入。
- `client/messages/common.js`：删除 `common.currentGoal`、`common.noActiveGoal`（en/zh 同步）。
- 重建 `client/client.js` 与 `client/.build/entry.js`。

## 4. 验证

- `rg "GoalScope|currentGoal|noActiveGoal|goal-scope" plugins/study` 无残留。
- `node --test --test-isolation=none plugins/study/tests/client`：75/75。
- `node plugins/study/tests/onboarding/ui-smoke.mjs`：`passed: true`；截图 `plan.png`、`workbench-plan.png` 顶部不再出现目标栏。
- 番茄钟、记忆页与其它页面仍能读取当前目标的数据（服务层未改动；整套测试 632 例 630 pass / 1 fail / 1 skip，唯一失败为既有 `outcomes/performance` 阈值抖动）。

## 5. 已知限制

- 页面内没有切换目标的入口；要换目标需回「创建计划」修改目标（或由 Agent 显式更新）。这是本次需求的有意取舍。
- 目标在别处被修改时，已经打开的学习页面不会即时重挂载；离开再进入即可读到新目标。
- SB-05 的数据隔离验收项仍然有效，只是切换入口从页面移到创建/目标维护流程。
