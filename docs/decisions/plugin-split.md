# 插件拆分与依赖模型（ADR）

- 日期：2026-11-11
- 状态：**提议（待评审）**；本文只做分析与清单，不改代码
- 相关代码：`plugins/study/host/index.mjs`、`host/db.mjs`、`host/kernel.mjs`、`host/registry.mjs`、`host/facts.mjs`、`client/lib/refresh.js`、`client/lib/study-page.js`、`scripts/project-config.mjs`
- 相关决策：[布局](layout.md)、[学习记忆](memory.md)、[目标与工作区](goal-workspaces.md)
- 执行计划：[docs/plans/2026-11-11-plugin-split](../plans/2026-11-11-plugin-split/README.md)（P0–P7，agent 操作说明）

## 1. 结论

要回答的问题是：拆分后的插件之间，应该完全解耦，还是保留基础插件、让后续插件依赖前面的基础插件？

**结论是后者，但不是“所有依赖都做成硬依赖”，而是分层 + 显式依赖。**

1. **不采用完全解耦。** 学习数据不是若干独立服务，而是一个有共享事实、跨表读写和单库事务的领域。把插件做成各自持有存储、只通过 API 通信，会破坏当前已经冻结的产品不变量：单库事务、`requestId` 幂等、全局 revision、`change_log`、当天快照。
2. **采用单向 DAG 分层。** 依赖只能从上层指向下层；基础插件不依赖功能插件；功能插件不 import 基础插件的业务实现，只通过服务、只读表契约、事件和客户端服务协作。
3. **基础插件只保留两类**：
   - `study-core`：技术基础，数据库、kernel、路由、客户端公共服务，**必须存在**；
   - `study-facts`：业务基础，目标、资料、任务、时间块、计划、计时、计划创建上下文，**产品内默认不可关闭**。
   其余 `learning`、`memory`、`outcomes`、`reminders` 是可选功能插件，关闭后产品降级但不崩溃。
4. **事实层不再拆成 `tasks` 和 `plans` 两个可独立启停的插件。** 复查表级读写后发现数据环：`tasks` 读 `study_goal`（materials 拥有），`plans` 又写 `study_task` / `study_task_progress` / `study_time_block`。拆成两个自由插件只能得到“互相依赖”或“必须同启同停”两个结果，不如作为一个基础插件。若未来要拆，先满足第 8 节的前置条件。
5. **平台能力单独成插件，可以完全独立。** 例如 `credentials-dpapi` 不共享任何学习事实，不需要跟着事实层走。真正的“完全解耦”只适合这类能力。
6. **目标清单**：6 个插件 + 1 个平台插件 + 1 个组合 bundle（第 6 节）。

> 修订记录：早期方案（按模块依赖）提出 `study-execution` / `study-plan` 两个插件。核对表级读写后调整为事实层单插件，理由见第 3.2 节与第 8 节。

---

## 2. “完全解耦”具体意味着什么

| 维度 | 完全解耦的要求 | 当前状态 |
| --- | --- | --- |
| 服务/生命周期 | 只通过公开服务或事件通信，插件可单独加载、卸载 | 单 `ctx.study` 服务；模块之间大量直接 SQL |
| 数据 | 各自拥有存储，跨插件只通过 API | 单 `study.db`，共享表与事务 |
| 事件 | 只发事件，不共享状态 | 只有少量事件（`study/learning/changed`、`agent/*`） |
| 客户端 | 独立 bundle、独立字典、独立导航 | 单 bundle、单 `study` 字典、单页面集合 |
| 版本/发行 | 可独立升级，兼容矩阵明确 | 单包单版本 |
| 故障隔离 | 一个插件崩溃/不可用不影响其他 | 单进程，共享 kernel |

如果按这个标准做，每个插件都要有自己的存储和迁移，跨域操作变成 saga/outbox，备份要协调多个存储，分析查询变成 N+1 次服务调用。对一个单用户、本地、桌面优先的产品来说，这是把分布式系统的复杂度引入到单机应用里，收益不成立。

**判断标准**：只有当插件之间没有共享事实、没有跨域事务、可以独立备份/恢复时，才值得完全解耦。`credentials-dpapi` 符合；学习事实层不符合。

---

## 3. 现状耦合证据

### 3.1 不可拆的共享底座

`host/db.mjs` 与 `host/kernel.mjs` 共同提供：

- 单 SQLite 文件 `<dataDir>/study.db` 与 WAL；
- `request_log`：按 `requestId` 重放写结果；
- `change_log`：追加式变更历史，触发器禁止更新/删除；
- `day_snapshot`：每天首次写入的只读快照；
- 全局 `revision`、调用串行队列、写事务边界。

这些不是“实现细节”，而是 `AGENT.md` 不变量、`docs/design` 里的产品承诺。任何“每个插件一个数据库”的方案都会让这些保证失效。

### 3.2 表级依赖（事实层不能简单对半拆）

| 依赖 | 证据 | 影响 |
| --- | --- | --- |
| `tasks` 读目标 | `modules/tasks.mjs` 多次调用 `resolveActiveGoal(db)`；`facts.mjs` 查询 `study_goal` | 任务依赖 materials 拥有的目标表 |
| `plans` 写任务 | `modules/plans.mjs` 从 `tasks.mjs` import `recordProgress`；`facts.mjs` 的 `materializePlan` 直接 INSERT/UPDATE `study_task`、`study_time_block` | 计划依赖 tasks 拥有的表，并直接写它 |
| `outcomes` 读多域 | `modules/outcomes.mjs` 直接查 `study_task`、`study_task_progress`、`study_plan`、`study_plan_progress`、`study_plan_task`、`study_plan_revision`、`study_material` | 统计是跨域只读，不是单域 API |
| `learning` 读 tutoring/tasks | `host/learning/repo.mjs` 的 `sessionLink` JOIN `study_tutoring_link` 与 `study_task` | 学习模块依赖 tutoring 与 tasks 的表 |
| `followup` 读目标 | `modules/followup.mjs` 用 SQL 查 `study_task.goal_id` / `study_plan.goal_id` | 提醒依赖事实层 |
| `memory` 读目标 | `modules/memory.mjs` 通过 `resolveActiveGoal(database)` 查 `study_goal` | 记忆依赖 facts 的目标表 |

结论：`goals / materials / tasks / plans / timer` 是**一个共享事实层**。拆成互相独立的插件会产生环；拆成“任务插件 + 计划插件”则必须约定它们同启同停、同版本发布，本质上是一个逻辑插件。

### 3.3 共享读模型

`host/facts.mjs` 被 materials、plans、followup、learning、tutoring、outcomes 共同使用，包含：

- `resolveActiveGoal`：当前备考目标；
- `materializePlan`：计划条目物化成任务；
- `itemLink`、`livePlanData` 等跨目标/计划/任务的读模型。

它既不属于某一个业务插件，也不能留在 kernel 里。拆分时应抽成共享库（如 `@studybuddy/study-model`），而不是让每个插件复制。

### 3.4 生命周期与 schema

`host/index.mjs` 当前是：

1. 扫描 `host/modules/*.mjs`；
2. 按 `deps` 拓扑排序；
3. 打开数据库，`verifyModules` 校验所有模块的 `schemaVersion`；
4. 任一模块版本不匹配 → 抛出 `unavailable`，**整个插件不加载**；
5. 应用所有 DDL；
6. 创建 kernel、注册路由；
7. 逐个 `apply` 模块；
8. 写当天快照。

拆成多个插件后，这个过程必须改成分阶段：core 先可用，各插件随后注册 schema 和命名空间；版本不匹配只应禁用该插件，而不是整个数据库。否则“独立启停”只是口号。

还有一个顺序问题：`outcomes` 在 `apply` 里安装当天快照生成器，而 kernel 在第一次服务调用时**只写一次**当天快照。拆开后如果 core 的接口先可用、`outcomes` 还没加载，当天的快照可能缺成果数据。这个问题需要组合就绪屏障或可重入快照，不能留给运气。

### 3.5 客户端单例

- `client/lib/refresh.js` 是模块级 `Set`，拆成多个 bundle 后每个 bundle 各有一份，跨插件刷新会静默失效；
- `client/lib/study-page.js` 记住最后打开的学习页，页面 key 列表写死在单插件里；
- `client/lib/definitions.js` 与 `build-client.mjs` 假设一个包、一个 barrel、一套字典、一个 `study` 命名空间；
- 当前只有一个 `@studybuddy/study` 客户端 bundle，`window.__ModuleLoader__.load({ id: '@studybuddy/study' })`。

这些必须提升为 `study-core` 提供的客户端服务，否则拆分只会把页面拆散，不会把状态拆对。

### 3.6 打包与产品组合

- 每个 host module 都用 `createRequire` 从固定源码树绝对路径拿 `defineTool`，这是发行包的阻塞项；
- `scripts/project-config.mjs` 的 `deploymentPolicy` 把 `project-credentials`、`study`、`a02-probe` 以绝对路径插入 profile；
- `a02-probe` 是 A02 验证探针，不应留在产品组合里；
- 客户端包名、profile 行名、bundle id 必须一致，否则 client-modules 找不到浏览器模块。

---

## 4. 选项对比

| 维度 | A. 完全解耦（独立存储 + API） | B. 分层 DAG（推荐） | C. 保持单插件内部模块（现状） |
| --- | --- | --- | --- |
| 跨域事务/一致性 | 需 saga/outbox，跨库可能短暂不一致 | 单库单事务，保持一致 | 最好 |
| 独立启停 | 最好 | 好：基础插件必需，功能插件可选 | 无 |
| 独立发版 | 好 | 好：bundle 锁版本，插件各自版本 | 无 |
| 分析查询（outcomes） | N+1 服务调用或分析库 | 只读表契约 + 跨插件测试 | 直接 SQL |
| 备份/恢复 | 多存储协调 | 一个数据根 | 一个数据根 |
| 迁移/版本成本 | 最高 | 中 | 最低 |
| 开发/调试成本 | 最高 | 中 | 最低 |
| 适用场景 | 多产品、多团队、远程服务 | 单用户本地产品插件化 | 小团队快速迭代 |

**决定：B。** 对平台能力（凭据、更新、遥测）可以按 A 的方式做；对学习事实层不做 A。

---

## 5. 分层与依赖规则

### 5.1 层级

```text
L0  study-core            技术基础：DB / kernel / 路由 / 客户端公共服务 / 今日页 / 导出
L1  study-facts           业务基础：目标 / 资料 / 任务 / 时间块 / 计划 / 计时 / 计划创建上下文
L2  study-learning        答疑、问答单元、学习证据、周报/月报
L2  study-memory          学生记忆、教学参数、系统提示契约
L2  study-reminders       学习时段提醒、晚间复盘、回复完成提醒
L3  study-outcomes        完成统计、里程碑、反馈提示（依赖 learning 的报告方法）

P   credentials-dpapi     平台能力：Windows DPAPI 凭据提供器（独立）
C   study-bundle          组合与发布配方（patch 层，不含运行时代码）
```

依赖方向只能向下。`study-outcomes` 是唯一允许依赖两个下层功能插件的插件（facts + learning）；如果这个例外继续变多，应重新审视分层。

### 5.2 依赖种类与规则

| 类型 | 含义 | 允许 | 禁止/边界 | 实现 |
| --- | --- | --- | --- | --- |
| **服务依赖（硬）** | 插件加载前必须存在的 Cordis 服务 | 只对 `study`、`tools`、`systemPrompt` 等基础服务 | 功能插件之间不互相提供 Cordis 服务；可选依赖不写进 `inject` | `export const inject = ['study']` |
| **命名空间依赖** | 需要另一个插件的 `ctx.study` 方法 | 向下依赖，声明在模块清单 | 不声明就调用；依赖被禁用时静默失败 | `ctx.study.module({ id, deps })` + 核心校验 |
| **只读表契约** | 直接 SQL 读另一个插件拥有的表 | 向下、只读、显式声明表/列/版本 | 跨插件写；未声明的表 | 契约清单 + 跨插件测试；优先服务方法 |
| **事件（软）** | 通知“发生了什么” | 发布方不关心消费者；消费者容忍事件缺失 | 用事件当命令/写路径；事件名不版本化 | `ctx.emit` / `ctx.on`，事件名进契约 |
| **客户端依赖** | 客户端服务、页面、字典、导航 | 只依赖 core 客户端服务；页面按 key 导航 | 跨 bundle import 实现；共享模块级单例 | `dsh.client.inject` + 客户端服务 |
| **版本/组合** | 插件与 DSH、插件与插件之间的兼容 | bundle 固定一组兼容版本 | 任意版本混装 | `engines.dsh`、`schemaVersion`、read-contract 版本 |

具体规则：

1. **`inject` 只表达必需依赖。** Cordis 的 `inject` 语义是“必需服务”，没有内建的 optional 列表；可选依赖用 `ctx.get(name)`、能力探测（`ctx.study.has(ns)`）或事件。把可选依赖写进 `inject`，会让禁用该插件时上层插件直接不加载，这不是我们想要的降级。
2. **功能插件之间不 import 业务实现。** 如果 `study-plan` import `study-tasks` 的 `recordProgress`，那么即使禁用 tasks 行，tasks 的代码仍在包里、逻辑仍会执行——启停就变得不可信。共享纯函数放 `@studybuddy/study-model`；跨插件写走 `ctx.study.call`（kernel 在已进入调用时是内联执行的，不会死锁）。
3. **写只能由表的拥有者执行。** 其他插件要么调用拥有者的服务方法，要么调用共享 model 库中明确标注“由 X 拥有、在 Y 的事务内执行”的函数。新增跨插件写必须走契约评审。
4. **读可以直接 SQL，但必须声明。** 每个插件在清单里列出它读取的其他插件的表/列/用途/契约版本；拥有者改 schema 时跑跨插件测试。稳定的粗粒度读取优先用服务方法；统计型 join 保留只读 SQL，避免 N+1。
5. **事件是通知，不是命令。** `study/learning/changed` 这类事件只表示“已提交的变化”，消费者不能假设事件一定到达，也不能用事件反向写数据。
6. **客户端一插件一命名空间。** `ctx.locale.register(ns, dict)` 对同一个 NS 的同一语种重复注册会抛错（`locale namespace "..." already has locale "..."`）。当前所有页面共用一个 `study` NS，拆分后必须每个插件用自己的 NS；`common.*` / `daily.*` 这类共享文案放共享消息库，由各插件构建时合并。
7. **页面 key 和侧栏 order 全局唯一。** `study.layout.page` 保存的是页面 key；拆包后 key 不能变，否则用户重启后回不到原页面。侧栏 order 需要统一分配，不能两个插件都写 16。
8. **版本不匹配只禁用该插件。** 拥有者 schema 升级、消费者未升级时，core 应把该插件标为不可用并给出诊断；其他插件继续工作。

### 5.3 基础插件的判定与约束

**基础插件**的定义：被两个以上功能插件依赖，并且拥有共享事实（表/读模型）的插件。

当前只有两个：

- `study-core`：所有插件依赖它的 `study` 服务和客户端服务；
- `study-facts`：learning、memory、reminders、outcomes 都依赖它的事实表/服务。

约束：

1. 基础插件只能依赖更下层（core），不能依赖任何功能插件；
2. 基础插件的 schema 变更 = 契约变更：提升 `schemaVersion` 或 read-contract 版本，更新 bundle 的兼容范围，跑所有消费者的契约测试；
3. 基础插件在产品 bundle 中默认视为“必需”，文档与启动诊断应明确说明不可关闭；
4. 新增基础插件需要单独 ADR，防止层级膨胀；如果出现第三个基础插件，优先考虑合并回 facts，而不是继续加层；
5. 功能插件对基础插件的依赖是正常的，不需要为了“看起来解耦”而绕成事件。

### 5.4 启停语义

| 插件 | 可否单独关闭 | 关闭后的行为 |
| --- | --- | --- |
| `study-core` | 否 | 所有学习路由、工具、页面消失；产品不成立 |
| `study-facts` | 否（产品内） | 计划/任务/资料/计时全部不可用；learning/memory/outcomes/reminders 失去基础 |
| `study-learning` | 是 | 问答页、答疑上下文、周报/月报消失；outcomes 的“报告”区不可用；memory 的教学参数刷新停止；facts/reminders 正常 |
| `study-memory` | 是 | 记忆页与教学契约消失；其他功能正常 |
| `study-outcomes` | 是 | 成果页与里程碑提示消失；记录本身仍在 |
| `study-reminders` | 是 | 提醒页与完成提醒横幅消失；计时与计划正常 |
| `credentials-dpapi` | 是 | 模型 Key 设置不可用；与学习数据无关 |

如果以后确实需要把 facts 拆成两个行（例如为了构建体积或团队归属），应把它们定义为**同启同停、同版本发布的基础插件对**，而不是两个可独立启停的插件；并在清单里声明双向的只读/写契约。详见第 8 节。

---

## 6. 插件清单

### 6.1 职责

| 插件 | 层 | 角色 | 迁入的 host 模块 | 命名空间/工具 | 客户端页面 | 关键依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| `@studybuddy/study-core` | L0 | 技术基础 | `host/index.mjs`、`db.mjs`、`kernel.mjs`、`registry.mjs`、`modules/kernel.mjs`、`modules/export.mjs` | `kernel`；`study_status`、`study_export`；`/api/study/*`、`/api/study/export.json` | 今日页；`studyClient`、`studyRefresh`、`studyNav`、`studyUi` 客户端服务 | 无 |
| `@studybuddy/study-facts` | L1 | 业务基础（学习事实与计划执行） | `modules/materials.mjs`、`plans.mjs`、`planning.mjs`、`tasks.mjs`、`timer.mjs`；`host/facts.mjs` 迁入共享 model 库 | `materials`、`plans`、`planning`、`tasks`、`timer` | 首次引导、计划、工作台、番茄钟 | core |
| `@studybuddy/study-learning` | L2 | 功能 | `modules/tutoring.mjs`、`learning.mjs`、`review.mjs`；`host/learning/*` | `tutoring`、`learning`、`review`；问答/洞察工具 | 问答记录页 | core、facts |
| `@studybuddy/study-memory` | L2 | 功能 | `modules/memory.mjs`；`host/memory/*` | `memory`；记忆工具 | 记忆页 | core、facts（读目标表）；learning 事件可选 |
| `@studybuddy/study-reminders` | L2 | 功能 | `modules/followup.mjs` | `followup`；提醒工具 | 提醒页、完成提醒横幅 | core、facts |
| `@studybuddy/study-outcomes` | L3 | 功能 | `modules/outcomes.mjs`、`milestones.mjs` | `outcomes`、`milestones` | 成果页、里程碑反馈 | core、facts、learning（报告方法） |
| `@studybuddy/credentials-dpapi` | P | 平台 | `platform/windows-credentials` | 凭据提供器 | — | 无 |
| `@studybuddy/bundle` | C | 组合 | `scripts/project-config.mjs` 的部署策略/行 | — | — | 以上全部 |

说明：

- `study-facts` 把工作台、计划、引导、计时四个页面放在同一个客户端 bundle 里，是因为它们共享 `tasks` / `plans` / `timer` 服务与页面间刷新。若构建体积或团队边界需要，后续可把 UI 拆成 client-only 包（如 `study-workbench-ui`、`study-plan-ui`），facts 保持 host-only；这属于第 9 节的未决问题，不阻塞本次拆分。
- `study-core` 保留 `export`，因为导出是整库转储，天然属于内核数据能力。将来若做备份/恢复界面，可再拆 `study-data`。

### 6.2 依赖矩阵

符号：**S** = 必需 Cordis 服务；**N** = 命名空间依赖；**R** = 只读表契约；**E** = 事件；**U** = 客户端依赖；**—** = 无。

| 插件 ＼ 依赖 | core | facts | learning | 其他 |
| --- | --- | --- | --- | --- |
| `core` | — | — | — | `tools`（S）、`connection`（可选 `ctx.get`） |
| `facts` | `study`、`tools`（S）；客户端服务（U） | — | — | `agent/pre-step`（planning 用 host 事件） |
| `learning` | `study`、`tools`（S）；客户端服务（U） | `tasks`、`materials`、`plans`（N）；`study_task`、`study_tutoring_link`（R） | — | `agent/inbox/claimed`（host 事件）；发布 `study/learning/changed`（E） |
| `memory` | `study`、`tools`、`systemPrompt`（S）；客户端服务（U） | `study_goal`（R） | `study/learning/changed`（E，可选） | — |
| `reminders` | `study`、`tools`（S）；客户端服务（U） | `tasks`、`plans`、`timer`（N）；`study_task`/`study_plan` 的目标读取（R） | — | — |
| `outcomes` | `study`、`tools`（S）；客户端服务（U） | `study_task*`、`study_plan*`、`study_material`（R） | `review`（N；客户端页调用，属于软依赖） | — |
| `credentials` | — | — | — | 无学习依赖 |

补充：

- 所有功能插件的 host 侧只 `inject` `study`（以及自己需要的 `tools` / `systemPrompt`），**不**注入其他功能插件的 Cordis 服务。功能插件之间的依赖体现在命名空间和只读表契约里，由 `study.module({ deps })` 记录。
- `outcomes` 的 host 模块不调用 `review`；只有成果页调用 `review` 方法。`learning` 被禁用时，成果页应把“报告”区显示为不可用，而不是整页失败。

### 6.3 关闭影响

见 5.4 的表。补充三条产品规则：

1. `core` 与 `facts` 不提供“关闭”入口；如果用户在 Plugins 页强行关闭，启动时给出明确诊断（“StudyBuddy 需要 study-core 与 study-facts”），并避免静默半启动。
2. 可选插件关闭后，Agent 可见的工具集会变化；系统提示词和计划生成提示不能假设某个工具一定存在，已有 `unavailable` 语义继续适用。
3. `study-creator` 的参考文档把 `kernel/tasks/plans/materials/outcomes/followup/timer/memory.recall` 当作稳定只读接口；插件可关闭后，这份契约要么保证这些命名空间始终存在（facts 与相关功能默认开启），要么在文档中标注“随插件可用性变化”。

### 6.4 客户端契约

1. **locale 命名空间一插件一个。** 当前所有页面共用一个 `study` NS；`ctx.locale.register` 对同一 NS 的同一语种重复注册会抛错，不能多个插件各注册一份 `study`。目标命名空间可以是 `study-core`、`study-facts`、`study-learning`、`study-memory`、`study-reminders`、`study-outcomes`。
2. **共享文案放共享库。** `client/messages/common.js` 与 `daily.js` 的键被多个页面使用；拆包后不要复制出多份，抽 `@studybuddy/study-messages`（普通库，不是插件），各插件构建时合并进自己的 NS。
3. **页面 key 保持不变。** `study.layout.page` 保存的是 key；拆包不能改 `today`、`workbench`、`plan`、`onboarding`、`timer`、`questions`、`memory`、`outcomes`、`reminders`。
4. **侧栏 order 统一分配。** 现在 `plan` 与 `reminders` 都是 16，单插件里靠 key 排序；拆包后应改成全局唯一值，例如：引导 1、工作台 10、计时 15、计划 16、提醒 17、今日 20、成果 25、问答 70、记忆 80。
5. **客户端共享服务由 core 提供。** `studyClient`（调用与写幂等）、`studyRefresh`（数据变更总线，替代 `refresh.js` 的模块级 Set）、`studyNav`（页面恢复/导航，动态页面 key 注册）、`studyUi`（面板图标、共享组件/样式）。功能插件的客户端在 `dsh.client.inject` 中声明 `@studybuddy/study-core`，确保顺序。
6. **禁止跨 bundle import 实现。** 共享 React 组件要么来自 core 的客户端服务，要么来自普通库并在各自 bundle 内联；不要依赖另一个插件的模块级单例。
7. **删除代码时的清理。** 拆分完成后，`client/plugin.js` 的全局页面注册、`build-client.mjs` 的单包 barrel、`definitions.js` 的单字典校验都要按插件替换；旧 bundle 不能与新 bundle 同时注册同一页面 key。

### 6.5 host 契约

1. **插件级 schema 注册。** `study-core` 提供 `ctx.study.module({ id, deps, schemaVersion, schema, readContracts })`；插件在 `apply` 中调用。core 按依赖顺序应用 DDL、写 `module_schema`；版本不匹配时只禁用该插件并给出备份指引。
2. **命名空间契约。** `registry.mjs` 的冻结列表变成“已知命名空间 + 版本”；插件只能注册自己声明的命名空间；`kernel.status` 动态报告已注册模块，而不是启动时的静态列表。
3. **路由仍由 core 统一提供。** 功能插件只注册命名空间方法，不各自注册 `/api/study/...`，避免重复实现认证与信封；`export` 的独立 GET 路由保留在 core。
4. **工具按插件注册。** 工具名全局唯一；插件关闭后工具自然消失；工具描述不得假设其他插件的方法存在。
5. **读契约清单。** 每个插件声明：读取的表/列、用途、拥有者、契约版本；拥有者升级 schema 时，跨插件测试必须覆盖。
6. **迁移各归各。** 每个插件在自己的 `apply` 中做幂等迁移（例如 `followup` 的 `ALTER TABLE`、`memory` 的 v1 迁移）；core 不替任何业务插件改表。
7. **导出/备份。** `export` 以只读方式转储所有表；被禁用插件的表仍保留、仍导出（归入 `otherTables`），不能让“关闭插件”变成“数据消失”。
8. **打包。** 每个包声明 `dsh.client.platform`、`exports['./client']`、`engines.dsh`；`defineTool` 改为 `@deepseek-ai/dsh-tools` 包引用 + `peerDependencies`；包名、profile 行名、bundle id 一致。

---

## 7. 迁移与验收

### 7.1 阶段

| 阶段 | 内容 | 目的 |
| --- | --- | --- |
| 0 | 本文（ADR）与契约清单：插件 id、命名空间、表所有权、读契约、页面 key、locale NS、侧栏 order、事件、工具 | 先冻结契约，再动代码 |
| 1 | 抽 `study-core` + `@studybuddy/study-contracts` / `study-model` 共享库；**仍保持一个 profile 行**，旧模块由 core 加载 | 在不改变部署的前提下验证 kernel 生命周期与客户端服务 |
| 2 | **memory 试点**：拆成独立行 + 独立客户端 bundle | 最小垂直切片：第二行、第二 bundle、第二字典、事件、测试 |
| 3 | 抽 `study-facts`（materials/plans/planning/tasks/timer + 四个页面） | 业务基础成型，其余功能插件才有依赖对象 |
| 4 | 抽 `study-learning` | 问答/证据/报告 |
| 5 | 抽 `study-reminders` | 提醒与完成提示 |
| 6 | 抽 `study-outcomes` | 统计与里程碑 |
| 7 | 建 `@studybuddy/bundle`；启动器只准备数据根/环境/首次模型与凭据；移除 `a02-probe` 与绝对路径行 | 产品组合版本化 |

选择 memory 先行的理由：host 模块 `deps = []`、页面 423 行、已有独立测试，且能同时验证“跨插件事件（learning → memory，可选）”和“systemPrompt 注入”这两条边。它不需要 facts 先完成，适合作为第 2 步。

### 7.2 验收标准（针对耦合）

1. **依赖图无环**：解析各插件清单的 `deps`/readContracts，测试断言 DAG；`sortModuleDefinitions` 的环检测扩展到插件图。
2. **无跨插件业务 import**：静态检查各包的 import；只允许 `@studybuddy/study-contracts`、`study-model`、`study-messages` 等共享库和 core 的公开契约。
3. **无跨插件写**：扫描 SQL 的写语句，断言只写自己拥有的表；运行期可加薄包装做诊断（先测试后运行期）。
4. **组合启动测试**：所有行 + 所有客户端 bundle 加载后，命名空间、工具、页面、字典、侧栏 order 齐全且无重复。
5. **禁用矩阵测试**：逐个禁用可选插件，应用仍能启动；其他功能正常；对应页面显示“不可用”而不是崩溃；核心/事实插件被禁用时给出明确诊断。
6. **schema 不匹配测试**：提升某插件 `schemaVersion`，只有该插件不可用；其他插件仍能读写；备份指引出现。
7. **客户端契约测试**：locale NS 唯一；页面 key 唯一；侧栏 order 唯一；core 客户端服务存在；`study.layout.page` 仍能恢复旧 key。
8. **只读契约测试**：拥有者改表/列时，消费者查询测试失败并指出契约版本。
9. **导出/备份测试**：禁用某插件后，其表仍被导出/备份；恢复插件后数据可读。
10. **启动时间与包体积预算**：记录拆分前的 boot 时间与总字节数，拆分后不得显著回退（例如 +10% 以内）。

### 7.3 memory 试点的退出标准

- 第二个 profile 行、第二个客户端 bundle、独立 locale NS、独立侧栏入口；
- `memory` 命名空间与工具只在启用时存在；
- `study/learning/changed` 事件缺失时 memory 正常工作；
- 禁用 memory 后，问答页/成果页/计划页不受影响；
- 测试从 `plugins/study/tests/memory` 迁出后，全量套件仍通过；
- 文档记录新增的耦合（读 `study_goal`、消费 learning 事件）与契约版本。

---

## 8. 未来把 facts 拆成 tasks / plans 的前置条件

如果将来确实需要两个独立插件（代码归属、构建体积、发布节奏），先完成三件事：

1. **目标所有权外移。** 把 `study_goal` / `study_goal_workspace` 从 materials 拆到独立的 `study-goals` 基础插件（或并入 core 的共享事实层），并更新 tasks/plans/memory/learning/outcomes 的读契约。否则 tasks → goals 与 plans → tasks 仍会形成环。
2. **计划不再直接写任务表。** 把 `materializePlan` 的写入改成 tasks 拥有的服务方法（例如 `tasks.materializePlan`），或放入共享 model 库并明确“由 tasks 拥有、在 plans 调用的事务内执行”。plans 只拥有 `study_plan*` 与 `study_plan_task` 链接。
3. **进度所有权明确。** `study_task_progress` 归 tasks，`study_plan_progress` 归 plans；plans 的 `recordProgress` 通过服务委托给 tasks，并携带 `requestId`。

完成后的图应是：`goals → tasks → plans → learning/reminders/outcomes`，无环。若做不到，就保持 facts 单插件；或者接受“两个行、一个逻辑插件”的同启同停方案，并在 bundle 中锁定同一版本。

---

## 9. 风险与未决问题

### 风险

- **facts 插件较大**：约 7k 行 host + 5k 行客户端源码；构建、测试、代码归属都会变重。缓解：内部继续按模块/包组织；满足第 8 节后再拆。
- **命名空间依赖不是 Cordis 强约束**：`inject` 只能等 `study` 服务；命名空间之间的依赖靠 `study.module({ deps })` + bundle 行序 + 组合测试。若未来需要动态启停时自动等待，要补 `ctx.study.whenAvailable(deps)` 一类的机制。
- **基础插件变更波及面大**：schema/读契约一变，四个消费者都要跑测试；bundle 必须锁版本。
- **客户端拆分容易出隐性单例问题**：`refresh.js` 只是最明显的一个；`study.layout.page`、动作注册表、面板图标、字典 NS 都要一起处理。
- **当天快照顺序**：`outcomes` 的 provider 与 kernel 的“一天只写一次”需要组合就绪屏障或可重入方案，必须在拆分前解决。
- **启停与工具集**：关闭可选插件会改变 Agent 可见工具；提示词、Creator 参考、用户预期都要同步。
- **不是沙箱**：拆分后插件仍在同一进程、拥有完整 host 权限；不要把它包装成安全隔离。
- **产品组合清理**：`a02-probe`、启动器绝对路径、`defineTool` 绝对路径都要在发行前处理。

### 未决问题

1. facts 层是“一个插件”还是“两个同启同停的行”？本文建议前者；若构建体积/团队归属有硬需求，再按第 8 节评估。
2. `review` 留在 learning 还是移到 outcomes？host 侧 review 读 learning 表，倾向留在 learning；代价是成果页对 review 有软依赖。
3. `export` 留在 core 还是拆 `study-data`？若做备份/恢复 UI，再拆。
4. facts 的 UI 是否拆成 client-only 包（`study-workbench-ui`、`study-plan-ui`）？可降低单包体积，但增加行数与客户端契约。
5. 基础插件是否需要在 Plugins 页“不可关闭”？DSH 的 plugin manager 没有第三方行的保护位；目前靠 bundle 文档 + 启动诊断。
6. 读契约的载体：`package.json` 的 `study` 字段、导出的 `contract` 常量，还是独立清单文件？需要和 core 的校验器一起定。
7. 是否需要 `ctx.study.whenAvailable(deps)`？取决于是否真的支持运行期动态启停。
8. 共享文案库 `@studybuddy/study-messages` 的归属：core 提供还是独立库？建议独立库，避免 core 依赖业务文案。

---

## 10. 附录：模块到插件映射

| 现有模块/文件 | 目标插件 |
| --- | --- |
| `host/index.mjs`、`host/db.mjs`、`host/kernel.mjs`、`host/registry.mjs` | `study-core` |
| `host/modules/kernel.mjs`、`host/modules/export.mjs` | `study-core` |
| `host/modules/materials.mjs`、`plans.mjs`、`planning.mjs`、`tasks.mjs`、`timer.mjs` | `study-facts` |
| `host/modules/tutoring.mjs`、`learning.mjs`、`review.mjs`、`host/learning/*` | `study-learning` |
| `host/modules/memory.mjs`、`host/memory/*` | `study-memory` |
| `host/modules/followup.mjs` | `study-reminders` |
| `host/modules/outcomes.mjs`、`milestones.mjs` | `study-outcomes` |
| `host/facts.mjs`、`host/operation.mjs` | 共享库 `study-model` / `study-contracts` |
| `client/lib/{api,storage,refresh,workspaces,study-page,panel-icon}.js`、`pages/today.js` | `study-core` 客户端 |
| `client/pages/{onboarding,plan,workbench,timer}.js` | `study-facts` 客户端 |
| `client/pages/questions.js`、`client/learning-notify.js` | `study-learning` 客户端 |
| `client/pages/memory.js` | `study-memory` 客户端 |
| `client/pages/reminders.js`、`client/notify.js` | `study-reminders` 客户端 |
| `client/pages/outcomes.js`、`client/components/feedback.js` | `study-outcomes` 客户端 |
| `client/messages/common.js`、`daily.js` | 共享库 `study-messages`（各插件合并） |
| `client/{plugin.js,lib/definitions.js,lib/actions.js}`、`scripts/build-client.mjs` | 按插件重建；core 保留客户端公共服务 |
| `platform/windows-credentials` | `credentials-dpapi` |
| `scripts/project-config.mjs` 的部署策略/插件行 | `study-bundle` |
| `plugins/study/creator/skills` | 保持 skill（或以后用 `ctx.skills.register` 做成 skill 插件） |
| `patches/0001`、`patches/0002` | 保持源码补丁，不属于业务插件 |
| `probes/A02`、`probes/layout` | 开发探针，移出产品组合 |
| `scripts/backup-studybuddy.mjs` | 冷备份工具；需要应用内备份时再评估 `study-data` 插件 |
