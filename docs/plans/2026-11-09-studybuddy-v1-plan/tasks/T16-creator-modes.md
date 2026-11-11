# T16：个人工具：创造模式与模式切换

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T04、T09
- 波次：W6
- 状态：见 [STATUS](../STATUS.md) 的 T16 行

## 目标

平时用日常模式答疑，需要个人工具时切到创造模式；Creator 生成并安装一个真实插件。

## 所有权（只能改这些路径）

- `plugins/study/creator/**`（skill/参考与模式说明）
- `scripts/project-config.mjs`（启用 bundle/预设的单行）
- `docs/creator.md`

## 交付

- 启用 `creation-recommendations`、`personalized-recommendations` 与 action cards，确认隔离 profile 可用。
- 模式切换：沿用 DSH preset；标准/PTC/极简/创造四个保留；日常默认标准，创造需显式切换；切换只影响后续请求；`agentPreset` 实际 id 以实测为准（Creator 可能用 `cordis`）。
- StudyBuddy 专用参考：`ctx.study` 调用示例、允许的页面位置、数据边界。
- 验证：切创造 → 生成 → 预览 → 安装 → 切回日常 → 重启仍在 → 撤销 → 恢复；失败有提示。

## 验收

- 界面能切换模式且新会话生效。
- 日常模式不出现创建卡片。
- 创造模式能生成图表/清单页并可用。
- 重启后仍在；撤销/恢复可用。
- 抽查生成代码只经服务读数据。
- 四个模式至少创造 + 一个日常模式实测可用。

## 不做

- 自建隔离沙箱、权限限制承诺、代码审计工具、模式自定义。

**备选**：若生成链路在 0.2.2-rc.1 上不可用，记录阻断并改走"声明式卡片"（+1 会话，需用户确认）。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T04、T09 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T16 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
