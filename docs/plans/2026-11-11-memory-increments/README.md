# 记忆系统渐进开发说明（S1–S4）

> **状态：S1–S4 已全部完成（2026-11-11）。** 交付记录见 [DELIVERY.md](DELIVERY.md)；本文件与 `Sx-*.md` 保留为执行说明与契约。

本目录把记忆系统拆成 4 个可独立执行的增量。每个增量对应一个**新会话**，按 S1 → S2 → S3 → S4 顺序执行；每个会话只做自己那份说明，不提前做后面的内容。

## 交付顺序与依赖

```
S1 证据层与问答单元
 └─ S2 窗口、摘要与问答记录页
     └─ S3 学生画像与讲法
         └─ S4 学习分析与周报
```

- S2 依赖 S1 的表、捕获与切分。
- S3 依赖 S1 的问答单元；S2 的摘要只用于展示，不阻塞 S3。
- S4 依赖 S1–S3 的全部数据。

## 每个会话的启动方式

把对应文件全文贴给新会话，或让新会话先读：

1. 本目录的 `README.md`
2. 对应增量的 `Sx-*.md`
3. `docs/specs/2026-11-11-student-memory-design.md` 的相关章节
4. `docs/plans/2026-11-11-memory-system-plan.md`

## 全局约束（四个会话都适用）

- **不修改** `source/deepseek-harness` 下的任何文件；DSH 是固定依赖。
- **不新增 npm 依赖**；SQLite 用内置 `node:sqlite`。
- 所有写操作走 `ctx.study.call(ns, method, payload, { requestId })`；模型工具不得直接写库。
- 新模块放在 `plugins/study/host/modules/*.mjs`，由 `index.mjs` 自动发现；模块导出 `{ id, deps, schema, schemaVersion, apply }`。
- **不 bump 已有模块的 `schemaVersion`**；新模块用 1。`memory` 目前 `schema` 为空、未被记录，可在 S3 安全地加表。
- 不改 `memory.json` 的 v1 读取行为，直到 S3 迁移完成。
- **本阶段不调用模型**：摘要、报告、画像全部用规则与模板，避免引入 `ctx.llm` 与 API 成本。模型润色留到以后。
- 中文界面文案必须走 `plugins/study/client/messages/*`，页面与字典同名（`build-client.mjs` 会校验）。
- 测试命令：`node --test plugins/study/tests`；新增测试放 `tests/learning/`、`tests/review/`。
- 不要 `git commit`；把改动留在工作区，由用户审核。
- 每个会话结束把记录追加到 [DELIVERY.md](DELIVERY.md)（四份原 `Sx-delivery.md` 已合册到该文件），说明改了什么、测试结果、偏差与遗留。

## 交付记录模板

```md
# Sx 交付记录
- 会话日期：
- 完成项：
- 未完成/偏差：
- 测试命令与结果：
- 新增/修改文件：
- 下一会话需要注意：
```

## 审核方式

四轮已全部完成。用户按 `docs/plans/2026-11-11-memory-system-plan.md` §10 的 DoD 复核，逐项结论见 [DELIVERY.md](DELIVERY.md) 末尾的验收对照：

- 捕获率与对账；
- 切分准确率（人工抽查）；
- 画像生效与纠正；
- 报告引用；
- 周页展示；
- 回归测试全绿。

若某项未通过，在 [DELIVERY.md](DELIVERY.md) 记录阻塞点并在对应增量内修复，不新增第五轮。
