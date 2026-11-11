# SB-21 计划项目结构与任务日期：日期进计划，钟点进工作台

- 状态：DONE（2026-11-11）
- 优先级：P1
- 来源：用户 2026-11-11 需求 2
- 依赖：SB-01（统一任务事实）、SB-19（创建计划对话）
- 预计：1–2 个会话
- 所有权：
  - `plugins/study/host/modules/plans.mjs`（projects、校验、diff、计数）
  - `plugins/study/host/facts.mjs`（materialize / live projection）
  - `plugins/study/host/modules/tasks.mjs`（任务项目列、视图、工具说明）
  - `plugins/study/host/modules/planning.mjs`、`host/prompts/plan-creation.md`（提示词 v2）
  - `plugins/study/client/pages/plan.js`、`client/messages/plan.js`
  - `plugins/study/client/pages/workbench.js`、`client/messages/workbench.js`
  - `plugins/study/client/pages/onboarding.js`、`client/messages/onboarding.js`（表单提示）
  - `plugins/study/tests/plans/projects.test.mjs`（新）、`tests/onboarding/**`、`tests/tasks/**`、`tests/client/**`、`tests/planning/**`
  - 本卡、`issues/tasks/README.md`、`STATUS.md`

## 1. 用户要求

一项计划由多个项目组成（练习册、章节学习等），一个项目下有多个任务，每天应完成指定的任务。因此计划生成时就要给每个任务分配日期；任务在当天的具体执行时间由当天任务台/工作台和用户自己的手动时间调整决定。

## 2. 目标模型

```
计划 (study_plan / revision snapshot)
├── 项目 projects[]：{ id, title, kind, materialId?, target?, note? }
│   ├── 任务 item：{ id, projectId, title, estimateMinutes, date, dependencies, … }
│   └── 任务 item：…
└── 项目 …
```

- **项目是任务分组**，不是时间段；一个项目可以横跨多天。
- **每个任务只带执行日期 `date`**；`start`/`end` 不是创建计划的输出。当天几点做，由学生在工作台拖/建时间块决定。
- 允许旧计划没有项目、或个别任务没有项目（legacy / 学生明确同意），但计划页会标为缺失信息，提示词要求新计划补全。

## 3. 服务与数据

### 3.1 `plans` 文档

- 新增 `projects` 段（最多 50 个）：
  - `id` 可省略，按标题/类型/材料/目标生成稳定 `proj_<hash>`；显式 id 必须唯一。
  - `kind` ∈ `workbook | chapter | course | review | other`，默认 `other`。
  - `materialId` 必须指向未删除材料；`target`/`note` 可选。
- `items[]` 新增 `projectId`；引用不存在的项目返回 `invalid`，`details.field = items[i].projectId`。
- `projects` 省略时继承当前草案/正式修订，便于只改任务的修订不丢项目。
- `plan.counts.projects` 与项目卡统计（任务数、分钟、日期范围）。
- 修订 diff 增加 `projects: { added, removed, changed }` 与 `projectsChanged`；`projectId` 进入条目 diff 字段。

### 3.2 物化到执行任务

- `materializePlan` 把 `projectId` / 项目标题写入 `study_task.project_id`、`project_title`，与既有 `scheduled_date = item.date` 一致；任务仍是执行事实的唯一来源。
- `study_task` 的项目两列是增量列：新库随模块 DDL 创建；旧库由 `ensureTaskProjectColumns` 幂等补列（`data_foundation_version` 已为 1 的库也能升级），基础迁移重放修订前也会补列。
- `taskView` 暴露 `scheduledDate`、`projectId`、`projectTitle`、`planItem`；工作台/Agent 工具读同一视图。

### 3.3 计划页

- 新增「项目」卡：项目名、类型徽标、材料、`N 项任务 · M 分钟`、日期范围、目标/备注；无项目时给出说明。
- 「任务安排」按项目分组，项目内再按日期分组；未分组任务单独标出。
- 条目显示「计划日期 YYYY-MM-DD」；没有时间块时显示「还没排具体时间 · 到工作台安排」，不再假装计划里有时钟。
- 缺失信息新增 `noProjects`、`ungrouped`；摘要显示项目数。
- 草案任务同样按项目展示；修订差异提示「项目划分有变化」。

### 3.4 工作台

- 新增「今日计划 / 本周计划」组：`scheduledDate` 落在当前日/周的任务优先展示，带项目徽标、计划日期和「安排时间」按钮。
- 「安排时间」直接打开时间块表单并预选该任务（日期取计划日期），学生填开始/结束即可保存。
- 已有时间块显示「已排：日期 HH:MM–HH:MM」；固定课程块不计入任务的已排学习时间。
- 其余任务仍按「已安排 / 未安排」展示；缩略视图新增「今日计划」卡。

### 3.5 创建计划提示词（v2）

- 第一轮读完事实后，先提出 2–5 个项目分法，再问 1–2 个关键缺口。
- 生成规则：`projects` 必填（2–5 个）；每个任务必须写 `projectId` 和 `date`；**不要写 `start`/`end`**；排不下时先讨论取舍，学生同意后才可留空并列出。
- 完成定义、呈现摘要（项目数、任务数、总分钟）、确认后的去向（计划页查看、工作台排时间）同步更新。
- `PROMPT_VERSION` 从 1 升到 2；工具 `study_plan` 的 `plan` 参数说明同步。

## 4. 验证

- `node --test --test-isolation=none plugins/study/tests/plans/projects.test.mjs`：4/4
  - 项目分组、确认后 `tasks.day` 带 `scheduledDate/projectId/projectTitle`；
  - 未知项目、重复项目 id、缺失材料被拒；
  - 未分组任务保留；省略 `projects` 的修订继承项目；项目改名进入 diff；
  - 旧库缺少项目列时，重启后 `ensureTaskProjectColumns` 补列且任务视图可读。
- `node --test --test-isolation=none plugins/study/tests`：632 例，630 pass / 1 fail / 1 skip；唯一失败为既有 `outcomes/performance` 的 100ms 阈值抖动（单跑 85.7–89.9ms 通过）。
- `node --test --test-isolation=none plugins/study/tests/client`：75/75（含 bundle 新鲜度、缩略视图今日计划）。
- `node plugins/study/scripts/build-client.mjs`：退出 0，bundle 474215 字节。
- `node plugins/study/tests/onboarding/ui-smoke.mjs`：`passed: true`
  - 计划页：`hasProjects=true`、`projectCount=2 个项目`、项目分组、日期徽标、缺失信息；
  - 工作台：`今日计划` 组含「第二章 导数习题」「计划日期 2026-11-11」「项目：章节学习」；
  - 点击「安排时间」打开时间块表单且任务已预选；
  - 截图：`plugins/study/tests/onboarding/evidence/plan.png`、`workbench-plan.png`、`workbench-block.png`。
- `node plugins/study/tests/plans/tool-smoke.mjs`：`passed: true`（旧载荷不含 projects 仍可用）。
- `node plugins/study/tests/kernel/loader-smoke.mjs`：`passed: true`。

## 5. 已知限制

- 没有独立的项目 CRUD 界面：项目随计划草案/修订由助手或手工 payload 维护；学生可在计划页确认/撤销、在工作台改任务和时间块。
- 服务层仍允许 `date: null`（容量不足、复习拆分等真实场景需要保留未安排工作）；「每个任务都有日期」由提示词与计划页缺失信息约束，不是硬拒绝。
- 工作台把时间块拖到另一天不会改写 `scheduled_date`：计划页跟随实时块显示日期，工作台「今日计划」仍按计划分配日期分组，二者不一致时以块为实际执行、以计划为原定意图。
- 项目标题/类型是计划快照的一部分；改名要通过修订，修订历史保留旧项目结构。
