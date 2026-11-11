# T07：番茄钟

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：0.5 个会话
- 依赖：T05
- 波次：W4
- 状态：见 [STATUS](../STATUS.md) 的 T07 行

## 目标

本地确定性计时，不调用模型。

## 所有权（只能改这些路径）

- `plugins/study/host/modules/timer.mjs`
- `plugins/study/client/panels/timer.js`
- `plugins/study/tests/timer/**`

## 交付

- 开始/暂停/结束，可调学习与休息时长。
- 关联任务。
- 重启恢复；睡眠/退出后标记中断并由学生确认。

## 验收

- 计时结束不自动完成任务。
- 中断需确认。
- 重启不虚增时长。
- 无网络可用。

## 不做

- 统计图表（T13）、提醒（T12）。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T05 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T07 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
