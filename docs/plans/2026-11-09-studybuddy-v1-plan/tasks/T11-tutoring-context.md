# T11：任务答疑上下文

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：0.5 个会话
- 依赖：T06、T08
- 波次：W5
- 状态：见 [STATUS](../STATUS.md) 的 T11 行

## 目标

从任务进入答疑时自动带上任务、材料与最新计划。

## 所有权（只能改这些路径）

- `plugins/study/host/modules/tutoring.mjs`
- `plugins/study/client/actions/ask-task.js`
- `plugins/study/tests/tutoring/**`

## 交付

- 会话 source kind 与上下文注入（复用 DSH `agent.inject` 路径）。
- "问这道题"动作；返回任务。
- 任务与会话关联。

## 验收

- 新会话读到任务与材料片段。
- 不复制聊天状态。
- 自由聊天不受影响。
- 同一任务重复提问不重复注入。

## 不做

- 改造 DSH 对话内核。
- 独立答疑 Agent。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T06、T08 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T11 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
