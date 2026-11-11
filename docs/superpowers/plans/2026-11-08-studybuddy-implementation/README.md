# StudyBuddy 开发计划与并行任务索引

> **已被 [2026-11-09 v1 计划](../2026-11-09-studybuddy-v1-plan/PLAN.md) 取代（2026-11-09）。** 本目录不再作为执行依据，仅保留 A01/A02 调研证据与历史记录；任务状态以新计划的 `STATUS.md` 为准。

日期：2026-11-08  
状态：已改为 MVP 优先的递进交付计划；尚未执行技术验证或实现任务。  
设计依据：[重新设计文档](../../specs/2026-11-08-studybuddy-redesign-design.md)

## 1. 架构决定与计划优先级

用户在设计文档之后补充了以下约束，本计划以此为准：

1. **DSH 是应用主体**，保留其 Host、Agent、会话、模型、工具、插件系统与桌面结构，不建设一个通过 SDK 调用 DSH 的平行业务应用。
2. **所有 StudyBuddy 业务能力通过 DSH 插件实现**。优先复用既有插件，其次薄适配，最后新增插件；不为每个小功能强制建立一个插件。
3. **允许按学习流程修改 DSH 前端与交互**。优先使用插件页面/组件；核心前端承担导航、布局、上下文联动与必要扩展槽，不内置计划算法或直接读写业务数据库。
4. Host/Agent 执行循环原则上不改。必要的底层扩展必须有最小复现、改动理由和上游同步说明，不以实现方便为由大幅分叉。
5. 不同时维护 SDK 独立界面路线。若 DSH 主体路线存在阻断，提交范围/方案决策，不擅自换架构。

逻辑插件边界：`study` 管业务事实，`memory` 管个性化记忆，`followup` 管提醒与复盘编排，`creator` 管受限小工具，`platform` 管桌面/数据适配。B01 先固定 DSH 基线与可选插件接入约定，后续包名/版本随相应验证逐步登记，不要求首次交付建齐五个插件。安装器、品牌、启动和构建配置属于发行集成，不是第二套业务后端。操作系统能力若不能直接从插件访问，只增加薄 Host 桥接，由插件实现策略。

保留设计默认值但不将其误当成用户要求：Windows 首发、未来 7 天精细规划、建议 21:30 复盘、一个学生且一个当前激活目标、小工具先限界面/记录类。应配置化；改变产品边界需用户确认。

## 2. 当前证据与使用方式

**开发者操作入口：[会话启动顺序与人工验收指南](DEVELOPER-RUNBOOK.md)**。该指南面向负责安排会话、合并和手动验收的人，不是 AI 必读材料，包含逐阶段并行批次和 5 次人工验收清单。

制定计划时成功读取了设计文档，未读取到根目录 README、package.json、AGENTS.md。Bash 因 WSL 挂载/启动错误无法执行目录扫描；**这不证明整个工作区没有源码或 Git 元数据**。所有源码布局和命令由 A01/B01/B03 实测后登记，本计划不伪造上游 API、文件路径或测试成功结果。

**先读 [递进式交付路线 RELEASES.md](RELEASES.md)**：S0 是基础 DSH MVP，S1—S4 逐步补齐学习能力；原文中的“首版/第一版”指 S4 完整首版，不是 MVP 的前置要求。

新会话需读取：本文件、[交付路线](RELEASES.md)、[执行规则](EXECUTION.md)、[依赖表](DEPENDENCIES.md)、领取的任务文件，以及其直接前置任务的交付记录。每份任务文件都有目标、文件边界、步骤、验收和交接要求。完整产品范围/14 个设计场景见 [覆盖矩阵](COVERAGE.md)；追加拆分时使用 [任务模板](TASK-TEMPLATE.md)。

推荐给 Agent 的指令：

> 阅读 `docs/superpowers/plans/2026-11-08-studybuddy-implementation/README.md`、同目录下的 `RELEASES.md`、`EXECUTION.md`、`DEPENDENCIES.md`，以及 `<任务文件完整路径>`。确认当前交付阶段，只执行该任务，不把未来阶段变成当前 MVP 的前置。先核对前置任务的验收证据和实际接口，前置不满足则报告阻塞。遵守文件所有权，用独立分支/worktree，补测试并回填交付记录。不要代做其他任务或自行变更架构/公共契约。

## 3. 大任务与小任务索引

| 大任务/目录 | 小任务 | 目标 |
| --- | --- | --- |
| A `00-discovery/` | [A01 基线](00-discovery/A01-source-baseline.md)、[A02 桌面前端验证](00-discovery/A02-dsh-extension-spike.md)、[A03 记忆验证](00-discovery/A03-memory-spike.md)、[A04 隔离创建验证](00-discovery/A04-creator-spike.md) | 排除路线阻断，取得真实接口证据 |
| B `01-foundation/` | [B01 工程底座](01-foundation/B01-workspace.md)、[B02 公共契约](01-foundation/B02-contracts.md)、[B03 测试底座](01-foundation/B03-test-harness.md) | 固定并行协作边界 |
| C `02-study-plugin/` | [C01 存储](02-study-plugin/C01-storage.md)、[C02 目标资料](02-study-plugin/C02-goals-materials.md)、[C03 任务日程](02-study-plugin/C03-tasks-schedule.md)、[C04 计划修订](02-study-plugin/C04-plan-revisions.md)、[C05 番茄钟](02-study-plugin/C05-timer.md)、[C06 成果](02-study-plugin/C06-progress-outcomes.md) | 建立唯一业务事实源 |
| D `03-frontend/` | [D01 前端宿主](03-frontend/D01-shell-navigation.md)、[D02 首次使用](03-frontend/D02-onboarding.md)、[D03 工作台](03-frontend/D03-workbench.md)、[D04 对话联动](03-frontend/D04-chat-context.md)、[D05 设置与记忆](03-frontend/D05-settings-memory.md) | DSH 学习导向交互 |
| E `04-agent-tools/` | [E01 资料证据](04-agent-tools/E01-material-evidence.md)、[E02 规划工具](04-agent-tools/E02-planning-tools.md)、[E03 答疑上下文](04-agent-tools/E03-tutoring-context.md) | 复用 DSH Agent，不建立平行 Agent 系统 |
| F `05-memory-followup/` | [F01 记忆适配](05-memory-followup/F01-memory-adapter.md)、[F02 记忆提取](05-memory-followup/F02-memory-extraction.md)、[F03 提醒](05-memory-followup/F03-reminders.md)、[F04 晚间复盘](05-memory-followup/F04-evening-review.md) | 轻量记忆与可靠跟进 |
| G `06-creator/` | [G01 隔离宿主](06-creator/G01-restricted-runtime.md)、[G02 创建流程](06-creator/G02-creation-workflow.md) | 受限个人工具完整生命周期 |
| H `07-desktop-data/` | [H01 桌面生命周期](07-desktop-data/H01-desktop-lifecycle.md)、[H02 模型凭据](07-desktop-data/H02-model-credentials.md)、[H03 备份恢复](07-desktop-data/H03-backup-restore.md)、[H04 安装升级](07-desktop-data/H04-distribution.md) | 本地可靠交付 |
| I `08-integration/` | [I01 每日闭环](08-integration/I01-daily-loop.md)、[I02 记忆与创建](08-integration/I02-memory-creator.md)、[I03 故障安全](08-integration/I03-resilience-security.md)、[I04 发布验收](08-integration/I04-release-acceptance.md) | 验证实际组合而非只有 mock |
| R `09-incremental-delivery/` | [R01 基础 DSH MVP](09-incremental-delivery/R01-dsh-mvp.md)、[R02 本地学习版](09-incremental-delivery/R02-local-study.md)、[R03 AI 规划版](09-incremental-delivery/R03-agent-planning.md)、[R04 陪伴跟进版](09-incremental-delivery/R04-companion.md) | 分阶段交付可运行版本，最终由 I04 放行完整首版 |

共 10 个大任务、39 个可领取的小任务；每个任务预计一个有限开发会话或少量连续会话。若实际超出，应先提出进一步拆分，保留原 ID 与依赖追踪，不无限扩展单个任务。

## 4. 里程碑与并行策略

| 阶段 | 交付结果 | 放行 |
| --- | --- | --- |
| S0 基础 MVP | 原生 DSH 桌面、模型、对话、会话恢复、经验证工具/附件和插件加载；最小运行包 | R01 |
| S1 本地学习 | 手动目标/任务/时间块、拖拽、进度、番茄钟；不依赖 AI 规划 | R02 |
| S2 AI 规划 | 资料导入、协商确认计划、版本/撤销、任务答疑与上下文 | R03 |
| S3 陪伴跟进 | 提醒、晚间复盘、记忆与用户纠正删除 | R04 |
| S4 完整首版 | 个人工具、日周月成果、一致备份、升级恢复及全量验收 | I04 |

**首个可用版本的关键路径仅为 `A01 → A02 → B01 → R01`**，不等待学习数据库、记忆候选或受限 Creator。A03/A04 可提前并行排风险，但只阻塞对应功能线。A02 的 Schedule/通知/热备份缺口转交后续 H/F 任务，不冒充已验证，也不阻塞不包含这些能力的 MVP。

B01 后可同时推进 R01 和 B02/B03；B03 后优先并行 C01、D01、H01。发布放行依次为 `R01 → R02 → R03 → R04 → I04`，开发可按依赖提前并行。各阶段确切任务归属、退出条件和数据保护要求见 [RELEASES.md](RELEASES.md)，详细 DAG 见 [DEPENDENCIES.md](DEPENDENCIES.md)。

## 5. 质量底线与完整首版完成定义

以下要求按能力启用阶段适用：不要求 S0 就有尚未交付的学习/记忆/备份功能，但已启用的功能必须可靠。完整清单在 S4 汇合验收，不能反向阻塞基础 MVP。

- 生产实现与 DSH 实际插件接口连通，不能只在 mock 下成功。
- 界面与 Agent 使用同一业务写入口；版本、幂等、时间计算、持久化和计时由确定性代码负责。
- 断网/缺少 API Key 不妨碍本地计划、进度、拖拽、计时；后台失败不能宣布成功。
- 任务状态、待确认标记与计时记录独立；取消不伪装完成；剩余工作排不下时明确保留。
- 并发、重复触发、睡眠/退出、删除抑制、越权与恢复都有可复现测试。
- 所有领取任务有实际交付记录、测试命令/结果、已知限制；未执行测试必须明确标注。
- 版本锁定、来源许可、无凭据默认导出、完整一致性备份、安装与回滚证据齐全。

本文只是开发计划，不代表 DSH、记忆插件、隔离执行或安装兼容性已经得到验证。
