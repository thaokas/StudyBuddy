# T09：计划草案、版本与规划工具

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T01、T08
- 波次：W3
- 状态：见 [STATUS](../STATUS.md) 的 T09 行

## 目标

Agent 能生成计划，界面与工具写同一份事实。

## 所有权（只能改这些路径）

- `plugins/study/host/modules/plans.mjs`
- `plugins/study/tests/plans/**`

## 交付

- 草案/确认/修订/撤销；版本、修订原因、`expectedRevision` 冲突检测。
- 容量校验（可用时间 vs 工作量）与冲突说明；试行标记。
- `study_plan` 工具（读今日/周、提交草案、应用修订、撤销）。
- `study_progress` 工具（读进度、记录反馈）。

## 验收

- 工具与 UI 调同一服务。
- 过期草案被拒并返回最新版本。
- 撤销生成新修订、不抹学习记录。
- 容量不足时保留"未安排"条目。
- 同 `requestId` 幂等。

## 不做

- 引导 UI（T10）、晚间自动调整（T12）、成果统计（T13）。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T01、T08 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T09 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
