# 2026-11-08 第一代计划（已归档）

- 状态：**已被取代**，不作为执行依据。
- 取代者：[2026-11-09 v1 计划](../2026-11-09-studybuddy-v1-plan/PLAN.md)。
- 归档日期：2026-11-11（文档整理）。

## 1. 这里原来有什么

第一代的 39 任务计划，按模块分 A–I 九组，共约 40 个 Markdown 文件：

| 原文件 | 内容 | 现在 |
| --- | --- | --- |
| `README.md` | 计划总览、架构决策、插件边界 | 已删除 |
| `RELEASES.md` | S0–S4 递进交付路线 | 已删除 |
| `EXECUTION.md` | 跨会话执行与交接规则 | 已删除 |
| `DEPENDENCIES.md` | 39 任务的完整依赖表 | 已删除 |
| `COVERAGE.md` | 设计场景到任务的验收覆盖 | 已删除 |
| `DEVELOPER-RUNBOOK.md` | 会话启动顺序与人工验收清单 | 已删除 |
| `TASK-TEMPLATE.md` | 任务卡模板 | 已删除 |
| `01-foundation/` … `09-incremental-delivery/` | 33 张任务卡（B01–I04） | 已删除 |
| `00-discovery/` | A01 源码基线、A02 DSH 插件探针证据 | **保留** |

删除的内容全部可在首次提交 `105bbae` 中取回。

## 2. 为什么归档

- 2026-11-09 的计划把交付单位从"39 个模块任务"改成"T00–T20 共 20 个会话任务"，旧任务卡不再有人领取。
- 每个旧任务的去向已逐条记录在新计划 [PLAN.md §12](../2026-11-09-studybuddy-v1-plan/PLAN.md#12-与旧计划的关系) 的映射表里（例如 C01→T01、C02→T08、G01→T16、H03→T17）。
- 保留任务卡只会让人误以为有两套并行计划。

## 3. 仍然保留的 `00-discovery/`

A01/A02 是**证据**，不是计划，且仍在被引用：

- [STATUS.md](../2026-11-09-studybuddy-v1-plan/STATUS.md) 的 v0 基线表引用 `00-discovery/A01-source-baseline.md`、`evidence/A02/extension-map.md`、`validation-matrix.md`。
- [docs/manual/manual-start.md](../../manual/manual-start.md) 引用 `00-discovery/evidence/A01/` 的冒烟脚本与权限修复记录。

结论（[STATUS.md](../2026-11-09-studybuddy-v1-plan/STATUS.md) 已登记）：DSH 主体路线可用，原探针无需核心前端补丁。
