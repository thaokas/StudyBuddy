# StudyBuddy v1 开发计划

日期：2026-11-09  
状态：待执行。取代 [2026-11-08 计划](../2026-11-08-studybuddy-implementation/ARCHIVE.md) 的 39 任务结构；旧目录保留为历史记录。  
语义来源：[重新设计文档](../../specs/2026-11-08-studybuddy-redesign-design.md)（产品语义不变，本计划只改交付方式与范围）。  
状态表：[STATUS.md](STATUS.md)。单任务卡：[tasks/](tasks/)；每个会话先读的通用约定：[AGENT.md](AGENT.md)。本文件是计划，不是完成记录。

## 1. 目标与判断标准

用最少的新代码，把 DSH 变成能每天用的备考工作台：**打开即看今天、拖一下就排好、说一句就能答疑、晚上自动把没做完的排下去**。

判断标准只有三条：

1. 学生不发一条消息也能开始学习（看任务、拖时间、计时、勾进度）。
2. Agent 与界面读写同一份事实，不存在"聊天里的计划"和"页面里的计划"。
3. 每项任务都能在一个会话内完成，并留下可复核的测试或证据。

## 2. 已确认决策（2026-11-09）

| 决策 | 结论 | 影响 |
| --- | --- | --- |
| 成果与里程碑 | **完整成就**：日/周/月统计、里程碑、轻量反馈 | T13 + T14 |
| 个人工具 | **沿用 DSH 的模式切换**：平时用标准/答疑模式，创建个人工具时切到创造模式；四个模式（标准/PTC/极简/创造）都保留，至少保留创造 + 一个日常模式 | 删除旧 G01；T16 做模式切换接入与验证 |
| 通知 | 复用社区已验证的实现思路：回复完成时浏览器 Notification + 页内兜底 + 去重 | T15；不改 DSH 核心 |
| 备份 | **冷备份 + 业务数据导出**，不做热备份、不称"一致快照" | T17 |
| 布局 | **做双主栏**；先实测"零补丁（宽右栏）"是否够用，不够再最小改 `AppFrame` | T03 决策门 + T04 |
| 记忆 | 先花 2–3 小时验证现成 `dsh-memory`；零代码可用就零代码，否则退回本地记忆模块 | T20 |
| 开发流程 | 每个任务 1 个会话、单一方向；只改自己目录；不设独立"契约/测试底座"评审门 | 全文 |

## 3. 架构与工程约定

### 3.1 目录

```text
source/deepseek-harness/   固定 DSH 源码（fcc0ad4，0.2.2-rc.1）；核心补丁受预算约束
scripts/                   启动器、备份脚本（已有 start-studybuddy.mjs / project-config.mjs）
platform/windows-credentials/  DPAPI 凭据（已存在，归入 v0）
plugins/study/             StudyBuddy 唯一业务插件（host + client + tests）
patches/                   核心补丁的独立 patch 文件与重放说明
tests/project/             工程级测试（node:test）
```

不新增第二个业务插件；记忆若自建也是 `plugins/study/host/modules/memory.mjs`，不单独发包。

### 3.2 自动注册（并行开发的关键）

三个注册点全部"加文件即生效"，**任何任务都不手改多个任务共用的注册表**：

| 注册点 | 约定 | 由谁建立 |
| --- | --- | --- |
| Host 模块 | `host/modules/*.mjs` 导出 `{ id, deps = [], schema = [], apply(ctx, kernel) }`；`host/index.mjs` 扫描目录、按 `deps` 拓扑排序后依次 apply | T01 |
| 数据表 | 每个模块自带 `schema`（`CREATE TABLE IF NOT EXISTS`）；`host/db.mjs` 记录 `module_schema` 版本，不兼容时拒绝启动并提示备份 | T01 |
| 客户端页面 | `client/pages/*.js` 默认导出 `{ key, order, label, Page }`；`scripts/build-client.mjs` 生成 barrel 并用 esbuild 打包成单个 `client.js`（`react` 外置） | T02 |
| 界面动作 | `client/actions/*.js` 默认导出 `{ id, page?, run }`；由页面通过动作注册表渲染，避免改别人的页面文件 | T02 |

### 3.3 服务契约（T01 冻结，后续只增不改）

- Host：`ctx.study.register(ns, impl)` / `ctx.study.call(ns, method, payload)`；`ns ∈ {kernel, tasks, materials, plans, timer, followup, outcomes, memory}`。
- 路由：`POST /api/study/<ns>/<method>`，请求体 `{ requestId, expectedRevision?, ... }`；成功 `{ ok: true, value, revision }`，失败 `{ ok: false, code, message, details }`，`code ∈ {invalid, conflict, not_found, unavailable}`。
- 幂等：`request_log(requestId unique, ns, method, result)`；同 `requestId` 返回首次结果，不同载荷同 ID 报 `conflict`。
- 历史：`change_log(at, actor, entity, entity_id, action, before, after, reason)` 只追加；`day_snapshot(date, plan_json)` 每天首开写一次。
- 所有写操作必须经过服务；前端与生成插件不得直接打开数据库文件。

### 3.4 核心补丁预算

| 补丁 | 现状 | 上限 |
| --- | --- | --- |
| 桌面账号开关（`DSH_DESKTOP_ACCOUNT_ENABLED`） | 9 文件 +72/−7（8 改 1 新），已存在，见 `patches/0001-desktop-account-toggle.patch` | 保持 |
| 布局（仅当 T03 判定零补丁不可行） | 5 个源码文件 +97/−7（`studyleft` 第二主栏，0 个新 locale key，含客户端测试与 Agent Note），见 `patches/0002-second-main-column.patch` | ≤100 行，须含客户端测试、locale 与 Agent Note；超出须用户批准 |

不修改 DSH 的 `pnpm-workspace.yaml`、锁文件、根 `package.json` 与插件注册表；插件通过启动器 profile overlay 注入。

### 3.5 每个任务的完成标准（DoD）

1. 代码只落在"所有权"目录内；越界改动视为未完成。
2. 至少一个可复跑的测试或证据脚本；结果写进 [STATUS.md](STATUS.md)。
3. 更新 STATUS 一行（状态、分支、命令、限制）。
4. 不引入未登记依赖；不把 mock 留在发布候选里。
5. 失败路径有明确提示，不静默成功。

## 4. 任务总表

预计单位"会话"≈ 3–5 小时有效工作（含测试）。总计约 **17 个会话**，关键路径 **9 个波次**。

| ID | 任务 | 预计 | 依赖 | 波次 | 主要产物 |
| --- | --- | --- | --- | --- | --- |
| T00 | 基线收尾与计划落地 | 0.5 | — | W0 | 状态表、旧计划归档标记、测试命令 |
| T01 | study 内核与服务骨架 | 1 | T00 | W1 | 插件包、DB、服务、路由、工具 |
| T02 | 客户端构建与页面骨架 | 1 | T01 | W2 | 构建脚本、页面注册、只读页 |
| T08 | 目标与资料导入 | 1 | T01 | W2 | 目标/资料/片段检索 |
| T20 | 记忆：现成插件验证与接入 | 1 | T01 | W2 | 零代码或本地记忆模块 |
| T03 | 双主栏方案验证 | 0.5 | T02 | W3 | 结论 + 选定方案 |
| T05 | 工作台：今日/周、任务与时间块 | 1 | T01, T02 | W3 | 任务/时间块 CRUD 与视图 |
| T09 | 计划草案、版本与规划工具 | 1 | T01, T08 | W3 | 计划服务与 Agent 工具 |
| T15 | 回复完成通知 | 0.5 | T02 | W3 | 通知 + 兜底 |
| T04 | 双主栏实现 | 1 | T03, T05 | W4 | 默认布局与记忆 |
| T06 | 拖拽、冲突与进度 | 1 | T05 | W4 | 直接操作与进度录入 |
| T07 | 番茄钟 | 0.5 | T05 | W4 | 本地计时与中断恢复 |
| T17 | 冷备份与数据导出 | 0.5 | T05, T08 | W4 | 备份脚本与导出 |
| T10 | 首次使用与计划页 | 1 | T04, T09 | W5 | 对话引导与计划确认 |
| T11 | 任务答疑上下文 | 0.5 | T06, T08 | W5 | 任务→答疑上下文 |
| T12 | 应用内提醒与晚间复盘 | 1 | T06, T09 | W5 | Schedule 提醒与重排 |
| T13 | 日周月成果统计 | 1 | T06, T09 | W5 | 三口径统计与页面 |
| T14 | 里程碑与轻量反馈 | 0.5 | T13 | W6 | 里程碑与阶段小结 |
| T16 | 个人工具：创造模式与模式切换 | 1 | T04, T09 | W6 | 模式切换、生成/安装/撤销/恢复 |
| T18 | 发布候选包与运行说明 | 0.5 | T07, T10–T17 | W7 | 候选 ZIP 与清单 |
| T19 | 全场景验收与回归 | 1 | T18 | W8 | 14 场景证据与结论 |

## 5. 依赖与并行

```text
W0  T00
W1  T01
W2  T02   T08   T20
W3  T03   T05   T09   T15
W4  T04   T06   T07   T17
W5  T10   T11   T12   T13
W6  T14   T16
W7  T18
W8  T19
```

规则：

- 同波次任务可并行；不同波次严格按依赖。波次是"最早可开始"，不是屏障。
- 串行接力：T05→T06→T11 共用 `workbench` 页面，按顺序接管，不并行。
- 只读消费：T10/T12/T13 只调用 T09 的服务，不放自己的计划逻辑。
- 每波最多 4 个会话；同一目录同时只有一个写入者。

## 6. 任务卡索引

每个任务一张独立卡片，便于一个会话只读一张卡开工。卡里写目标、所有权、交付、验收、不做、开工前与完成后；**状态只看 [STATUS](STATUS.md)**。

| ID | 任务 | 预计 | 依赖 | 波次 | 任务卡 |
| --- | --- | --- | --- | --- | --- |
| T00 | 基线收尾与计划落地 | 0.5 | — | W0 | [T00-baseline.md](tasks/T00-baseline.md) |
| T01 | study 内核与服务骨架 | 1 | T00 | W1 | [T01-kernel.md](tasks/T01-kernel.md) |
| T02 | 客户端构建与页面骨架 | 1 | T01 | W2 | [T02-client-skeleton.md](tasks/T02-client-skeleton.md) |
| T03 | 双主栏方案验证 | 0.5 | T02 | W3 | [T03-layout-spike.md](tasks/T03-layout-spike.md) |
| T04 | 双主栏实现 | 1 | T03、T05 | W4 | [T04-dual-pane.md](tasks/T04-dual-pane.md) |
| T05 | 工作台：今日/周、任务与时间块 | 1 | T01、T02 | W3 | [T05-workbench.md](tasks/T05-workbench.md) |
| T06 | 拖拽、冲突与进度 | 1 | T05 | W4 | [T06-drag-progress.md](tasks/T06-drag-progress.md) |
| T07 | 番茄钟 | 0.5 | T05 | W4 | [T07-timer.md](tasks/T07-timer.md) |
| T08 | 目标与资料导入 | 1 | T01 | W2 | [T08-materials.md](tasks/T08-materials.md) |
| T09 | 计划草案、版本与规划工具 | 1 | T01、T08 | W3 | [T09-plan-service.md](tasks/T09-plan-service.md) |
| T10 | 首次使用与计划页 | 1 | T04、T09 | W5 | [T10-onboarding-plan-ui.md](tasks/T10-onboarding-plan-ui.md) |
| T11 | 任务答疑上下文 | 0.5 | T06、T08 | W5 | [T11-tutoring-context.md](tasks/T11-tutoring-context.md) |
| T12 | 应用内提醒与晚间复盘 | 1 | T06、T09 | W5 | [T12-reminders-review.md](tasks/T12-reminders-review.md) |
| T13 | 日周月成果统计 | 1 | T06、T09 | W5 | [T13-outcomes.md](tasks/T13-outcomes.md) |
| T14 | 里程碑与轻量反馈 | 0.5 | T13 | W6 | [T14-milestones.md](tasks/T14-milestones.md) |
| T15 | 回复完成通知 | 0.5 | T02 | W3 | [T15-completion-notify.md](tasks/T15-completion-notify.md) |
| T16 | 个人工具：创造模式与模式切换 | 1 | T04、T09 | W6 | [T16-creator-modes.md](tasks/T16-creator-modes.md) |
| T17 | 冷备份与数据导出 | 0.5 | T05、T08 | W4 | [T17-backup-export.md](tasks/T17-backup-export.md) |
| T18 | 发布候选包与运行说明 | 0.5 | T07、T10–T17 | W7 | [T18-release-candidate.md](tasks/T18-release-candidate.md) |
| T19 | 全场景验收与回归 | 1 | T18 | W8 | [T19-acceptance.md](tasks/T19-acceptance.md) |
| T20 | 记忆：现成插件验证与接入 | 1 | T01 | W2 | [T20-memory.md](tasks/T20-memory.md) |

任务卡与 PLAN 冲突时以任务卡为准（任务卡是执行指令）；范围或决策变化先改 PLAN，再同步任务卡。

## 7. 不可违反的不变量

1. 界面与 Agent 只经 `ctx.study` 写；不直连数据库。
2. 幂等：同 `requestId` 只生效一次；不同载荷同 ID 报冲突。
3. 版本：过期草案不得覆盖新修订或手动修改。
4. "待确认"不等于"未完成"；未勾选不推断未学习。
5. 计时不等于完成；中断需学生确认；离线时间不计入。
6. 取消不计入完成率；不伪造"全部完成"。
7. 后台失败不得宣布成功（提醒、复盘、生成都一样）。
8. 凭据不进聊天、日志、导出包。
9. 无 Key/断网时本地功能完整可用。
10. 未提供的能力隐藏入口并写明，不放假按钮。

## 8. 设计场景 → 任务

| # | 场景 | 任务 |
| --- | --- | --- |
| 1 | 首次提供目标与现有课程 | T10 |
| 2 | 要求 7 天完成大量练习 | T09、T10 |
| 3 | 拖拽时间后询问 Agent | T06、T11 |
| 4 | 更换练习册 | T08、T09 |
| 5 | 未勾选但实际完成 | T06、T12 |
| 6 | 部分完成且明天无空闲 | T06、T12 |
| 7 | 晚间重排期间手动修改 | T12 |
| 8 | 关闭窗口、退出、睡眠、断网 | T12、T15、T19 |
| 9 | 新会话继续备考 | T20 |
| 10 | 纠正或删除记忆 | T20 |
| 11 | 完成日周月目标 | T13、T14 |
| 12 | 创建个人统计工具 | T16 |
| 13 | 无 Key 或服务不可用 | T01、T10、T18 |
| 14 | 升级失败 | T17、T18（**部分覆盖**：v1 无升级器） |

## 9. 风险与未验证

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 手写 `__ModuleLoader__` 与自动发现是上游测试夹具，非公开 API | DSH 升级可能失效 | 锁版本；升级后跑一次插件冒烟；异常记录在 STATUS |
| Creator 是实验特性，默认关闭 | T16 可能不可用 | T16 先验证再承诺；备选声明式卡片需用户确认 |
| 右栏是会话作用域、宽度受 `RIGHTBAR_MAX_RATIO` 限制 | 双主栏可能需核心补丁 | T03 先实测"无会话时可用"；补丁预算 ≤100 行 |
| Windows toast 依赖 AppUserModelID/快捷方式 | 系统通知可能不显示 | 页内兜底必须有；不把"通知"写进验收必过项 |
| 提醒只在应用运行时生效 | 关闭应用无提醒 | 文案明确；T19 场景 8 按此验收 |
| 核心补丁每次升级需重放 | 维护成本 | patch 文件 + 重放测试（T00、T18） |
| 生成插件与普通插件同权限 | 可绕过服务直读库 | 记入已知边界；T16 抽查；不宣称沙箱 |

## 10. v1 明确不做

安装器/签名/自动更新、在线一致备份、移动端、向量或图记忆、自动批量记忆提取、题库/课程平台、知识图谱、社交/云同步、插件市场、多用户。

## 11. 会话领取规则

1. 读 [AGENT.md](AGENT.md)、目标任务卡（`tasks/`）、以及 [STATUS.md](STATUS.md) 中该任务与其依赖行。
2. 前置未 DONE 不开工；确需并行只做只读或本目录 mock，不得提交生产路径。
3. 有 Git 时一个任务一个分支 `task/Txx-name`；当前外层工作区没有 Git，按目录所有权隔离，并在 STATUS 记录改动文件。只改所有权目录；共享文件（`scripts/project-config.mjs`、`plugins/study/host/index.mjs`）只允许 T01/T02 建，后续单行追加串行进行。
4. 完成后更新 STATUS：状态、分支、测试命令与结果、已知限制。
5. 失败就写 BLOCKED 与复现步骤，不改别人的代码绕过。

可直接粘贴给新会话的指令（只给任务卡路径即可）：

> 阅读 `docs/plans/2026-11-09-studybuddy-v1-plan/tasks/T01-kernel.md` 并执行。

任务卡第一步会要求会话读 AGENT.md；想更保险就同时给 `AGENT.md` 的路径。

## 12. 与旧计划的关系

- 旧 [39 任务计划](../2026-11-08-studybuddy-implementation/ARCHIVE.md) 保留作为调研与证据库（A01/A02 证据仍被引用），不再作为执行依据。
- 旧任务映射：B01/R01 → 已被 v0 实现吸收（T00 登记）；C01 → T01；C02 → T08；C03 → T05/T06；C04 → T09；C05 → T07；C06 → T13/T14；D01 → T03/T04；D02 → T10；D03 → T05/T06；D04 → T11；D05 → T20；E01 → T08；E02 → T09；E03 → T11；F01/F02 → T20；F03/F04 → T12；G01/G02 → T16（复用 DSH Creator 与模式切换，不自建沙箱）；H01 → 取消（应用内提醒）；H02 → v0 已覆盖，T18 复核；H03 → T17（降级）；H04 → T18（降级）；I01 → T12/T19；I02 → T16/T20；I03 → T19；I04 → T19。
