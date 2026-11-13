# 插件拆分总体计划

- 日期：2026-11-11
- 状态：未开始
- 依据：[插件拆分与依赖模型（ADR）](../../decisions/plugin-split.md)
- 执行说明：[AGENT.md](AGENT.md) · 契约：[CONTRACTS.md](CONTRACTS.md) · 状态：[STATUS.md](STATUS.md)

## 1. 目标与成功标准

把当前“一个业务插件 + 内部模块系统”改造成“1 个内核插件 + 1 个业务基础插件 + 4 个功能插件 + 1 个平台插件 + 1 个组合 bundle”，并且：

1. 每个阶段结束时应用可启动、现有测试通过、页面/路由/工具/数据语义不变；
2. 功能插件可以单独关闭，其他功能不崩、页面显示“不可用”；
3. 插件之间没有业务实现 import、没有跨插件写、没有共用客户端单例；
4. 最终启动方式变成“带 `@studybuddy/bundle` 的定制 profile”，而不是启动器临时拼绝对路径；
5. 全过程不修改 `source/deepseek-harness`，不新增 npm 依赖，不拆数据库。

## 2. 目标架构

| 层 | 插件 | 角色 | 迁移完成阶段 |
| --- | --- | --- | --- |
| L0 | `@studybuddy/study-core` | 数据库、kernel、路由、`ctx.study`、客户端公共服务、今日页、导出 | P1 |
| L1 | `@studybuddy/study-facts` | 目标、资料、任务、时间块、计划、计时、计划创建上下文 | P3 |
| L2 | `@studybuddy/study-learning` | 答疑、问答单元、学习证据、周报/月报 | P4 |
| L2 | `@studybuddy/study-memory` | 学生记忆、教学参数、系统提示契约 | P2 |
| L2 | `@studybuddy/study-reminders` | 时段提醒、晚间复盘、回复完成提醒 | P5 |
| L3 | `@studybuddy/study-outcomes` | 完成统计、里程碑、反馈提示 | P6 |
| P | `@studybuddy/platform-windows-credentials` | Windows DPAPI 凭据提供器（现名；改名另议） | 已有，P7 纳入 bundle |
| C | `@studybuddy/bundle` | `cordis.patch.yml` 组合与部署策略 | P7 |

依赖方向只能向下：

```text
core
└─ facts
   ├─ learning ── outcomes
   ├─ memory（读 facts 目标表；消费 learning 事件可选）
   ├─ reminders
   └─ outcomes
```

`outcomes` 是唯一依赖两个下层功能插件的插件（facts + learning 的报告方法）；如果这个例外变多，重新评估分层，而不是继续加边。

## 3. 已定决策（执行时不要重新讨论）

| 决策 | 结论 | 影响 |
| --- | --- | --- |
| 完全解耦 | **不做**；采用分层 + 显式依赖 | 单库单 kernel 保持不变 |
| 事实层拆分 | `materials/plans/planning/tasks/timer` 作为**一个** `study-facts` | 不把 tasks/plans 做成两个可独立启停的插件 |
| 基础插件 | `study-core`、`study-facts` 产品内不可关闭 | 关闭时启动诊断明确报错 |
| 可选功能 | learning / memory / outcomes / reminders 可关闭 | 关闭后页面显示不可用，其他功能正常 |
| 共享代码 | 只放 `packages/`，功能插件不互相 import 实现 | 启停可信 |
| 数据 | 单 `study.db`；只有 core 打开；写走拥有者服务 | 幂等、revision、change_log 不变 |
| 客户端 | 一插件一 bundle、一 locale NS；页面 key 与 order 全局唯一 | 需要 core 客户端服务 |
| 发布组合 | `@studybuddy/bundle` 的 patch 层；启动器只准备环境 | P7 完成 |

## 4. 包布局

```text
packages/
  study-contracts/     StudyError、错误码、命名空间、localDate、toolRequestId 等纯契约
  study-model/         facts 读模型、materializePlan、operation
  study-messages/      客户端共享字典（common/daily 等）
  test-support/        测试夹具、React 桩（按需建立）
  study-bundle/        C 组合补丁层（不是运行时代码）
plugins/
  study-core/          L0
  study-facts/         L1
  study-learning/      L2
  study-memory/        L2
  study-reminders/     L2
  study-outcomes/      L3
skills/study-creator/  Creator skill 内容（P6 从 plugins/study/creator 迁入）
tests/creator/         Creator 验证脚本与证据（P6 迁入）
platform/windows-credentials/   P（保留原位置）
```

约束：

- 不引入根 workspace、锁文件或新的包管理器；共享库先用相对路径 import，P7 评估 bundle 安装时再决定是否改成包名/`link:`。
- 每个 `plugins/study-*` 自带 `package.json`、`host/`、`client/`、`tests/`、`scripts/build-client.mjs`（可共享构建脚本）。
- `plugins/study` 在 P1–P5 仍是“旧 shell”，承载尚未迁出的模块/页面；P6 删除。删除前先把 `plugins/study/creator` 的 skill 内容与验证脚本迁到 `skills/study-creator/` 与 `tests/creator/`，并更新 `scripts/project-config.mjs` 的 `creatorSkillSource`。
- `platform/windows-credentials` 不改目录；P7 用 bundle 行引用它。

## 5. 阶段表

“业务行”指 core/facts/learning/memory/reminders/outcomes/shell，不含平台插件与探针。

| 阶段 | 内容 | 依赖 | 预计会话 | 业务行 | 主要产物 | 质量门 |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | 冻结契约（只写文档） | — | 0.5 | 1（shell） | `CONTRACTS.md` 完整版；包名/行 id/页面 order 定稿 | G0 |
| P1 | 抽 `study-core` + `study-contracts` / `study-model`；旧 shell 变第二行 | P0 | 1.5–2（可拆 P1a/P1b） | 2 | core 插件、共享库、模块注册 API、client 共享服务 | G1 |
| P2 | memory 试点：独立行 + 独立 client bundle | P1 | 1 | 3 | `study-memory`、第二 bundle、事件/降级验证 | G2 |
| P3 | 抽 `study-facts`（5 模块 + 4 页面） | P1/P2 | 1.5 | 4 | facts 插件；shell 只剩 learning/reminders/outcomes | G3 |
| P4 | 抽 `study-learning`（tutoring/learning/review + 问答页） | P3 | 1 | 5 | learning 插件；shell 只剩 reminders/outcomes | G4 |
| P5 | 抽 `study-reminders`（followup + 提醒页 + 完成提醒） | P3 | 0.5–1 | 6 | reminders 插件；修复 order 冲突；shell 只剩 outcomes | G5 |
| P6 | 抽 `study-outcomes`；删除旧 shell | P4/P5 | 0.5–1 | 6 | outcomes 插件；6 个业务行定型 | G6 |
| P7 | 建 `study-bundle`；清理启动器与 `a02-probe` | P0–P6 | 1 | 6 + 平台 + bundle | bundle patch、profile、启动器简化、文档 | G7 |

总计约 **8–10 个会话**（含测试与冒烟）。P1 是风险最高的一段，允许拆成：

- **P1a（host）**：core host + 共享库 + 模块注册 API；shell 仍拥有旧 client bundle；
- **P1b（client）**：core client 共享服务 + shell 客户端改造。
两段都完成才算 P1 DONE；P1a 结束时应用必须能启动。

## 6. 阶段依赖与回退

```text
P0 ─ P1 ─ P2 ─ P3 ─┬─ P4 ─┐
                    ├─ P5 ─┼─ P6 ─ P7
                    └──────┘
```

回退原则：

- P1–P5 旧 shell 一直保留，任何阶段失败都可以把 profile 行改回单 shell、把迁出的文件从备份恢复。
- 每个阶段开工前把要改的目录复制到 `.studybuddy/plugin-split-backup/<phase>/`（被忽略，不提交）；验收后删除。
- P7 保留旧启动器生成的 `home/cordis.patch.yml` 副本，直到 bundle 启动验证通过。
- 外层工作区没有 Git；不要用 `git checkout/reset` 恢复，也不要提交。

## 7. 质量门

| 门 | 通过条件 |
| --- | --- |
| G0 | `CONTRACTS.md` 无 TODO（除明确延后项）；包名、行 id、命名空间、表所有权、页面 key/order、locale NS、事件、工具、读契约版本都已定；用户确认 |
| G1 | core 行 + shell 行可启动；单库；所有现有测试通过；页面/路由/工具不变；客户端共享服务可用；`kernel.status` 能报告两个插件 |
| G2 | memory 独立行/独立 bundle；禁用 memory 后其他功能正常；`study/learning/changed` 缺失时 memory 正常；测试迁出 |
| G3 | facts 行承载 materials/plans/planning/tasks/timer 与 4 个页面；数据与 schema 不变；shell 只剩 learning/reminders/outcomes；现有测试通过 |
| G4 | learning 行承载 tutoring/learning/review 与问答页；review、事件、答疑上下文正常；shell 只剩 reminders/outcomes |
| G5 | reminders 行承载 followup、提醒页、完成提醒；order 冲突修复（reminders 17）；shell 只剩 outcomes |
| G6 | outcomes 行承载 outcomes/milestones 与成果页、反馈；旧 shell 删除；6 个业务行全部可启动；导出仍覆盖所有表 |
| G7 | bundle 启动；Plugins 页能看到各行；可选插件可关闭；`a02-probe` 和绝对路径行移除；启动器只准备环境/数据根/首次模型与凭据；README/备份文档更新 |

每个门的证据写进 [STATUS.md](STATUS.md)：命令、退出码、关键输出、截图路径（如适用）。

## 8. 主要风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| P1 生命周期改动大（模块注册、路由、当天快照、客户端服务） | 应用起不来或数据写坏 | 拆 P1a/P1b；先跑 headless/路由测试；保留旧 shell 可回退；不在 P1 改 schema |
| facts 插件过大 | 单会话做不完、构建变慢 | P3 允许拆 host/client 两会话；内部继续按模块组织；不提前拆 tasks/plans |
| 跨插件 SQL/写契约漂移 | 禁用插件后查询失败或绕过幂等 | CONTRACTS 登记 + 消费者测试；写只走服务；P1 起禁止跨插件 import |
| 客户端单例/字典/order 冲突 | 页面不刷新、文案缺失、侧栏顺序乱 | core 提供 `studyRefresh`/`studyNav`；一插件一 NS；order 表统一；组合启动测试 |
| 测试 import 路径大面积改动 | 套件红了、误改断言 | 测试随代码迁移，只改 import；不削弱断言；每阶段跑相关目录 + 全量 |
| 启动器/profile 双轨漂移 | 开发能跑、发行不能跑 | P7 单一 bundle；删除绝对路径行；`--prepare-only` + 真实启动双验证 |
| 没有 Git | 回退困难 | 阶段备份目录；小步提交给用户审核；不跨阶段混改 |
| 时间估计偏乐观 | 中途停在半成品 | 每个阶段以“应用可启动 + 测试绿”为停止条件；做不完就拆会话，不跳过质量门 |

## 9. 本计划不做

- 新功能、新页面、新模型调用、提示词改写；
- 发行打包、品牌、安装器、更新源、签名；
- 把 facts 再拆成 tasks/plans（ADR 第 8 节的前置条件未满足）；
- 拆数据库、拆 kernel、把插件做成独立进程/沙箱；
- 修改 `source/deepseek-harness` 或新增核心补丁；
- 删除 `patches/0001` / `patches/0002`；
- 把 `a02-probe` 改造成产品能力（它在 P7 被移除）。

## 10. 完成定义（整个计划）

1. `plugins/study` 旧 shell 不存在；`plugins/study-core|facts|learning|memory|reminders|outcomes` 与 `study-bundle` 存在。
2. profile/bundle 启动，6 个业务行 + 凭据插件可见；可选插件关闭矩阵通过。
3. `CONTRACTS.md` 是最终状态；`STATUS.md` 所有阶段 DONE 并有证据。
4. 现有功能测试全绿；`a02-probe` 不在产品 profile；启动器不再写绝对路径插件行。
5. 用户审核通过。
