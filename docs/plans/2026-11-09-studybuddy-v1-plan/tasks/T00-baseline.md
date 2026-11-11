# T00：基线收尾与计划落地

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：0.5 个会话
- 依赖：—
- 波次：W0
- 状态：见 [STATUS](../STATUS.md) 的 T00 行

## 目标

把"已完成但没记录"的 v0 固化，让计划、状态与测试命令成为唯一事实源。

## 所有权（只能改这些路径）

- `docs/plans/2026-11-09-studybuddy-v1-plan/**`
- `patches/**`
- `tests/project/README.md`
- 旧计划 README 顶部标记

## 交付

- STATUS 的 v0 交付表（启动入口、隔离数据根、DPAPI 凭据、模型配置、账号补丁、A02 探针）。
- 记录 A02 已 DONE（用户 2026-11-09 确认，非本任务代签）。
- `patches/0001-desktop-account-toggle.patch` 与 `patches/README.md`（9 文件 +72/−7，反向校验通过）。
- 两层测试命令：单元层与桌面冒烟；证据文件放 `evidence/`。
- 注明 `probes/A02/verify.mjs` 因断言上游干净树已不适用。

## 验收

- STATUS 能回答"现在能跑什么、缺什么"。
- 旧计划顶部有取代链接。
- 单元测试 5/5 通过、桌面冒烟 `passed: true` 并有证据文件。

## 不做

- 不改业务代码，不改 DSH 源码，不新增功能。

> 已完成（2026-11-09）。本卡保留为格式示例与回溯依据。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 — 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T00 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
