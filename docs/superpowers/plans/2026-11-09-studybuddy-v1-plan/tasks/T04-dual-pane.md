# T04：双主栏实现

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T03、T05
- 波次：W4
- 状态：见 [STATUS](../STATUS.md) 的 T04 行

## 目标

落地左侧学习工作台、右侧对话（已确认方向），窄窗口自动回退。

## 所有权（只能改这些路径）

- 零补丁路线：`plugins/study/client/**`
- 核心补丁路线：`source/deepseek-harness/packages/client/ui-layout/**` 及其测试、`patches/0002-*.patch`、Agent Note

## 交付

- 默认视图为左学习、右对话。
- 宽度/分栏可调并记忆。
- 1024px 以下自动单栏。
- 启动恢复上次页面。
- 无会话时学习区仍可用（按 T03 结论补齐）。

## 验收

- 1440×900 下并列可用且拖拽不卡。
- 窄窗口回退正确。
- 重启恢复。
- 原生对话、附件、工具调用不受影响。
- 若改核心：`pnpm run test:gui` 与相关快照通过，补丁登记进 `patches/README.md`。

## 不做

- 业务内容、主题美化。
- 第二个前端应用。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T03、T05 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T04 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
