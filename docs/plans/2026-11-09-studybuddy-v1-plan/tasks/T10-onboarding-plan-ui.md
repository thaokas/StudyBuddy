# T10：首次使用与计划页

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T04、T09
- 波次：W5
- 状态：见 [STATUS](../STATUS.md) 的 T10 行

## 目标

第一次打开能用对话把计划谈出来，并看见它在哪。

## 所有权（只能改这些路径）

- `plugins/study/client/pages/onboarding.js`
- `plugins/study/client/pages/plan.js`
- `plugins/study/tests/onboarding/**`

## 交付

- 引导流程：目标 → 材料 → 草案 → 确认，允许先给少量信息。
- 计划页：阶段/周目标、任务、变更摘要、撤销。
- 试行风险提示；缺信息标注；"稍后继续"。

## 验收

- 不填长表单也能开始。
- 草案未确认不改正式安排。
- 差异可见。
- 材料来源可点开。
- 无模型时可跳过引导继续本地操作。

## 不做

- 记忆、成就。
- 计划算法（走 T09 服务）。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T04、T09 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T10 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
