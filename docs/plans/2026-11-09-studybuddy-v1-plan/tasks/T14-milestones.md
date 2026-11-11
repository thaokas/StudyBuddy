# T14：里程碑与轻量反馈

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：0.5 个会话
- 依赖：T13
- 波次：W6
- 状态：见 [STATUS](../STATUS.md) 的 T14 行

## 目标

有记录依据的鼓励，不做惩罚性打卡。

## 所有权（只能改这些路径）

- `plugins/study/host/modules/milestones.mjs`
- `plugins/study/client/components/feedback.js`
- `plugins/study/tests/milestones/**`

## 交付

- 里程碑：只引用真实记录的文案模板。
- 完成任务轻量反馈（本地、不每次调模型）。
- 周/月阶段小结。
- 明确不计算连续打卡惩罚。

## 验收

- 文案不含无依据推断。
- 取消/未完成不产生"成就"。
- 反馈不打断操作。
- 无模型也可显示既有里程碑。

## 不做

- 徽章经济、排行、社交分享。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T13 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T14 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
