# T05：工作台：今日/周、任务与时间块

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T01、T02
- 波次：W3
- 状态：见 [STATUS](../STATUS.md) 的 T05 行

## 目标

不发一条消息也能看到并管理今天与本周。

## 所有权（只能改这些路径）

- `plugins/study/host/modules/tasks.mjs`
- `plugins/study/client/pages/workbench.js`
- `plugins/study/tests/tasks/**`

## 交付

- 任务 CRUD：学科、材料位置、完成条件、预计工作量、前置任务。
- 时间块 CRUD：日期、起止、固定/弹性、关联任务。
- 今日/周视图、日期切换、固定课程与学习任务区分。
- 乐观更新失败回滚；加载/空态/错误态。

## 验收

- 新建 → 改时间 → 重启仍在。
- 任务 ID 不随展示变化。
- 固定课程不计入学习完成量。
- 无模型可用。

## 不做

- 拖拽、进度录入（T06）。
- 计划版本（T09）、番茄钟（T07）。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T01、T02 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T05 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
