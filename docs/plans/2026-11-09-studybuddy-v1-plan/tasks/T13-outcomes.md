# T13：日周月成果统计

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T06、T09
- 波次：W5
- 状态：见 [STATUS](../STATUS.md) 的 T13 行

## 目标

可信的完成量与推进，不靠取消凑数。

## 所有权（只能改这些路径）

- `plugins/study/host/modules/outcomes.mjs`
- `plugins/study/client/pages/outcomes.js`
- `plugins/study/tests/outcomes/**`

## 交付

- 三口径完成率：原计划 / 调整后 / 主动取消。
- 材料推进条数。
- 日/周/月聚合与统计页、空态。
- 查询走日快照与变更日志。

## 验收

- 取消任务不提高完成率。
- 统计与任务明细可交叉核对。
- 跨天/时区正确。
- 1 万条记录内查询 <100ms。

## 不做

- 里程碑叙事、动画、积分（T14）。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T06、T09 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T13 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
