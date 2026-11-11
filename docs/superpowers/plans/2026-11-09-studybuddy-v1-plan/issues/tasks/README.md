# StudyBuddy issues 修复任务卡

本目录把 `issues/2026-11-10-design-code-review.md` 的 22 项审查结果拆成可独立开工的修复任务卡。每张卡对应一个修复会话，写清问题、涉及文件、正确业务逻辑、修改范围和验收标准。

这些卡按“精简版 v1”整理，范围依据：

- `session-116db5ef-bebd-4f2d-a45e-2d12dc7dac22` 中的产品决策；
- `docs/superpowers/plans/2026-11-09-studybuddy-v1-plan/PLAN.md` 与 `tasks/T00`–`T20`；
- `issues/2026-11-10-design-code-review.md` 的代码证据。

## 状态

| 状态 | 含义 |
| --- | --- |
| TODO | 尚未开始 |
| IN_PROGRESS | 正在修复 |
| REVIEW | 已改完，等待复跑/审阅 |
| DONE | 有测试或证据，且验收项通过 |
| BLOCKED | 前置不满足或需要产品决策 |

## 任务卡

| ID | 优先级 | 任务 | 来源问题 | 依赖 | 状态 |
| --- | --- | --- | --- | --- | --- |
| [SB-01](01-unified-task-facts.md) | P0 | 统一任务、时间块、计划条目和进度 | 01、04 | 无 | DONE |
| [SB-02](02-agent-task-and-plan-actions.md) | P0 | Agent 任务工具与计划页/工作台动作 | 01 | SB-01 | DONE |
| [SB-03](03-draft-concurrency.md) | P1 | 草案独立版本，旧草案不能覆盖新草案 | 03 | 无 | DONE |
| [SB-04](04-remaining-work-and-review-split.md) | P1 | 剩余量、复盘拆分、暂定块和未安排再调度 | 05、09 | SB-01 | DONE |
| [SB-05](05-goal-scope.md) | P1 | 当前备考目标作用域贯通任务/计划/成果 | 06 | SB-01 | DONE |
| [SB-06](06-reminder-timing-identity.md) | P1 | 提醒按执行块结束时间触发，身份按块 | 07 | 无 | DONE |
| [SB-07](07-schedule-auto-review-notify.md) | P1 | Schedule、复盘保存决策和学习通知 | 08 | SB-04、SB-06 | DONE |
| [SB-08](08-idempotency.md) | P1 | 所有写入强制幂等身份 | 13 | SB-01 | DONE |
| [SB-09](09-deadline-capacity.md) | P1 | 期限、固定块和完整工作量进入容量判断 | 14 | SB-01 | TODO |
| [SB-10](10-locator-evidence.md) | P1 | 页码/题号必须有证据或标未核实 | 16 | SB-01 | TODO |
| [SB-11](11-onboarding-conversation.md) | P1 | 首次引导接入真实对话和默认备考会话 | 18 | SB-01、SB-05 | TODO |
| [SB-12](12-completion-rate-and-milestones.md) | P1/P2 | 完成率三口径统一；个人里程碑 | 20 | SB-01 | TODO |
| [SB-13](13-export-outcomes.md) | P1 | 导出使用真实成果服务并提供入口 | 22 | SB-01 | TODO |
| [SB-14](14-memory-scope-and-correction.md) | P1 | 记忆目标/会话作用域、相关注入、纠错抑制 | 11、12 | SB-05 | TODO |
| [SB-15](15-same-day-drag.md) | P2 | 同日拖拽到起始分钟 | 19 | SB-01 | TODO |
| [SB-16](16-replacement-relation.md) | P2 | 换书/换任务建立明确替代关系 | 17 | SB-01 | TODO |
| [SB-17](17-release-candidate-acceptance.md) | P1 | T18 候选包与 T19 十四场景验收 | T18、T19 | SB-01–SB-13 | TODO |
| [SB-18](18-rolling-refinement.md) | P2 | 未来 7 天滚动细化与估算校准 | 18、14 | SB-01、SB-09 | TODO |
| [SB-19](19-create-plan-conversation.md) | P1 | 「开始」页改造为「创建计划」：表单起手 + 对话协作生成 | 18 | SB-01、SB-05 | DONE |
| [SB-20](20-remove-page-goal-bar.md) | P2 | 移除学习页面顶部的「当前目标」选择栏 | 2026-11-11 需求 | SB-05、SB-19 | DONE |
| [SB-21](21-plan-projects-and-dated-tasks.md) | P1 | 计划项目结构与任务日期：日期进计划，钟点进工作台 | 2026-11-11 需求 | SB-01、SB-19 | DONE |

## 建议顺序

1. **数据基础**：SB-01 → SB-05 → SB-03 → SB-08。
2. **每日闭环**：SB-02 → SB-06 → SB-04 → SB-07。
3. **事实可信**：SB-09 → SB-10 → SB-12 → SB-13。
4. **产品接入**：SB-11、SB-14、SB-15、SB-16、SB-18。
5. **交付验收**：SB-17。

SB-01 是所有后续卡的事实基础。它没有完成前，不建议并行修改 `plans.mjs`、`tasks.mjs`、`outcomes.mjs`、`followup.mjs` 的数据结构，避免二次迁移。

## 开工约定

1. 先读 `PLAN.md`、`AGENT.md`、本卡和对应 issue 原文；再读卡里列出的主要文件。
2. 只改本卡“所有权”列出的路径；需要共享文件时先确认没有并行写入者。
3. 先写失败测试或复现脚本，再改实现；完成后写清楚测试命令和结果。
4. 不把“未覆盖”写成“通过”；如果卡内验收项确实无法完成，在卡末记录 BLOCKED 和原因。
5. 完成后更新本 README 的状态表，并在卡末追加“完成记录”。

## 明确不进入本轮的事项

见 [ACCEPTED-SCOPE.md](ACCEPTED-SCOPE.md)。包括 Creator 沙箱、自动记忆提取、安装器/自动更新、热备份、公开信息联网入库、原始会话导出和跨日补发提醒。不要把这些问题当作本轮回归失败。
