# T08：目标与资料导入

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T01
- 波次：W2
- 状态：见 [STATUS](../STATUS.md) 的 T08 行

## 目标

让计划和答疑有依据——目标、材料、可检索片段与来源。

## 所有权（只能改这些路径）

- `plugins/study/host/modules/materials.mjs`
- `plugins/study/tests/materials/**`

## 交付

- 目标：考试、年份、期限、每日时间预算。
- 资料：教材/练习册/课程、版本、目录、来源、核实状态。
- 文本/Markdown/PDF 文本导入切分为片段（含页码/章节定位与来源日期）。
- `materials.search` 检索；`study_materials` 工具（检索 + 导入文本）。

## 验收

- 导入文本可检索且结果带来源。
- 缺章节/题号时返回 `unverified` 标记而非编造。
- 扫描件/解析失败有明确原因。
- 删除资料后片段不再命中。

## 不做

- 联网检索院校信息。
- UI 页面（T10）。
- 向量检索。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T01 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T08 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
