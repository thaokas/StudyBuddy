# StudyBuddy 架构总览

- 状态：2026-11-17 归档版。事实来源：当前工作区未提交的插件拆分实现（P1–P6 已落地）、[contracts.md](contracts.md)、[decisions/](decisions/) 与当前代码。**P7 尚未落地**，剩余工作见 [roadmap.md](roadmap.md)。
- 定位：本文回答“系统怎么搭、为什么这样搭”。具体命名空间 / 表 / 工具 / 页面 / 路由以实现契约为准，见 [contracts.md](contracts.md)；产品语义见 [specs/](specs/)。
- 口径：只写代码里存在的结构，不把计划目标画成既有实现；一次性开发计划、任务卡与证据已随归档删除，可从 git 历史取回。

## 1. 运行时栈

StudyBuddy 是 **Electron 桌面壳 + 固定版本 DeepSeek Harness（DSH）宿主 + DSH Web 前端**的组合，学习业务以插件行接入宿主，不重写上游。

| 层 | 组件 | 事实 |
| --- | --- | --- |
| 桌面壳 | `source/deepseek-harness/apps/desktop`（Electron） | 主进程用 Electron RunAsNode 子进程启动共享 profile runner（即 DSH Host）；渲染进程加载 `dsh-app://app/`；启动注入、就绪与关闭走 Node IPC |
| 宿主 | DSH Host（Cordis） | Agent 循环、会话、模型调用、工具调度、插件容器、HTTP/WS 路由；固定源码 `source/deepseek-harness`，版本 **0.2.2-rc.1**，commit `fcc0ad4` |
| 源码补丁 | `patches/0001`、`patches/0002` | `0001-desktop-account-toggle` 增加桌面账号开关，启动器设为 `0` 并禁用账号相关 bundle；`0002-second-main-column` 在中央列增加第二主栏槽，当前产品未注册使用（工作台缩略视图替代），补丁保留在固定源码树 |
| 模型 | 自定义提供商 `studybuddy-deepseek` | `anthropic-messages`，`https://api.deepseek.com/anthropic`，模型 `deepseek-flash`，思考档默认 `high`；模型设置由 DSH 原生设置页管理 |
| 凭据 | `platform/windows-credentials` | Windows CurrentUser DPAPI，`.studybuddy/home/credentials.dpapi`；模型配置只存 `STUDYBUDDY_DEEPSEEK_API_KEY` 引用 |
| 运行时 | Node ≥ 24.9（`node:sqlite` 必需）、Windows x64 | 当前文档基线 Node v26.13.0；产品先支持 Windows |
| 数据根 | 默认 `.studybuddy`，可用 `STUDYBUDDY_DATA_DIR` 覆盖 | 启动器 `scripts/start-studybuddy.mjs` 通过 `DSH_HOME=<数据根>/home` 指向 profile |

进程关系：

```text
Electron 主进程
  └─ RunAsNode 子进程：DSH Host（profile runner）
       ├─ 插件容器：9 行插入插件（8 个 study 行 + 凭据行）
       ├─ 业务库：<数据根>/study/study.db（SQLite STRICT + WAL）
       ├─ 会话与工具记录：<数据根>/home/{sessions,storages}
       └─ 本地 HTTP/WS：DSH 原生路由 + /api/study/*
  └─ 渲染进程：<dsh-app://app/>，加载各插件客户端 bundle
```

## 2. profile 插件行结构

启动器 `scripts/project-config.mjs#deploymentPolicy` 每次启动重写 `<数据根>/home/cordis.patch.yml`，当前为 **19 项逻辑行**：

| 分组 | 行 |
| --- | --- |
| 账号 / 遥测禁用（8） | `deepseek-account`、`llm-deepseek-account`、`ui-settings-account`、`account-controller`、`session-log-deepseek`、`session-telemetry-otel`、`desktop-product-telemetry`、`product-analytics`，均 `disabled: true` |
| 内置凭据禁用（1） | `credentials`（`disabled: true`），由 `project-credentials` 取代 |
| 工作区（1） | `workspace-controller`，`documentsDirectory` 指向 `<数据根>/workspace` |
| 插入插件行（9） | `project-credentials` → `study-core` → `study-facts` → `study-learning` → `study-reminders` → `study-memory` → `study-outcomes` → `study-appearance` → `study-pet` |

- 只有 `study-core` 接收 `config.dataDir`；其余业务插件无 config。
- **当前启动器逐行写插件源码的绝对路径**（`plugins/<pkg>/host/index.mjs`），这是 P7 的待办；`@studybuddy/bundle` 组合包尚未存在。
- profile 的 `dsh.profile.bundles` 保持 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-personalized-recommendations`（Creator bundle 只在首次出现时加入，用户在插件页关闭后不强行加回）。
- 已有数据根 profile 里可能残留旧 `a02-probe` 行；启动器已不再插入它，清理随 P7 的旧数据根迁移完成（见 [roadmap.md](roadmap.md)）。
- 行顺序表达依赖方向，但 Cordis 会并发初始化异步行，就绪靠组合屏障与 `studyFactsReady` 作用域等待，不靠行序。

## 3. 插件职责与依赖 DAG

| 层 | 插件 | 命名空间 | 自有表 | 页面 / 表现面 | Agent 工具 |
| --- | --- | --- | --- | --- | --- |
| L0 | `study-core` | `kernel` | 5（meta / module_schema / request_log / change_log / day_snapshot） | today | `study_status`、`study_export` |
| L1 | `study-facts` | `materials`、`plans`、`planning`、`tasks`、`timer` | 16（另 1 张 FTS5 虚拟表，不计入 43 张基础表） | onboarding、workbench、timer、plan | `study_goal`、`study_materials`、`study_tasks`、`study_plan`、`study_progress` |
| L2 | `study-learning` | `tutoring`、`learning`、`review` | 13 | questions | `study_tutoring`、`study_questions`、`study_insight` |
| L2 | `study-reminders` | `followup` | 4 | reminders；完成提醒与时段提醒 banner | — |
| L2 | `study-memory` | `memory` | 4（含 1 张命令式迁移表） | memory | `memory_remember`、`memory_recall`、`memory_forget`、`memory_profile` |
| L3 | `study-outcomes` | `outcomes`、`milestones` | 1（个人里程碑） | outcomes + 里程碑 overlay | — |
| UI | `study-appearance` | — | 0 | 6 套配色 token、品牌槽位、设置行 `study.appearance` order 35 | — |
| UI | `study-pet` | — | 0 | `shell.overlay` 小搭浮层、设置行 `study.pet` order 36 | — |
| P | `project-credentials` | — | — | 凭据提供器 | — |

依赖 DAG（单向，只允许向下）：

```text
project-credentials（平台能力，无学习依赖）
study-core（L0）── study-facts（L1）
                    ├── study-learning（L2） ── study-outcomes（L3，软依赖 review 方法）
                    ├── study-reminders（L2）
                    ├── study-memory（L2，可选消费 study/learning/changed）
                    └── study-outcomes（L3，读 facts 表）
study-appearance / study-pet（client-only，不进入 host DAG；桌宠可选取 studyClient）
```

规则（ADR 已采纳，代码按此执行）：

- 业务功能插件只 `inject = ['study', 'tools']`（memory 另有 `systemPrompt`），不互相提供 Cordis 服务；功能插件之间不 import 业务实现。
- 向下依赖用 `ctx.study.call`、只读表契约（`readContracts`，当前只登记元数据）和事件 `study/learning/changed`；**写只能由表拥有者执行**。
- `study-facts` 提供轻量 `studyFactsReady` 服务，上层用作用域 `ctx.inject` 等待，不写进顶层必需依赖；缺少 facts 时相关命名空间返回 unavailable，memory 仍可独立使用。
- 基础插件不可关闭：`study-core` 与 `study-facts` 是产品成立前提；`learning / reminders / memory / outcomes` 可关闭，关闭后对应页面 / 工具消失、其他功能降级但可用。
- 外观与桌宠是 **client-only**：不 `inject` 学习服务、不参与 host DAG；桌宠可选 `ctx.get('studyClient')` 只读 `timer/status`，服务缺失时静默降级。
- 每个插件一个 client bundle、一个 locale 命名空间；页面 key 与侧栏 order 全局唯一。

## 4. 数据层

| 位置 | 内容 | 归属 / 约束 |
| --- | --- | --- |
| `<数据根>/study/study.db` | 全部学习事实（目标、材料、任务、时间块、计划修订、问答证据、记忆、提醒、里程碑） | 单库单事务；表按插件归属；SQLite STRICT + WAL |
| `<数据根>/study/exports/` | `study_export` 写的 JSON 导出 | 排除 `request_log` 与 FTS；禁用插件的表进 `otherTables` |
| `<数据根>/home/sessions`、`home/storages` | DSH 原始会话与工具记录 | 归 DSH；学习侧只存 session / message 引用 |
| `<数据根>/home/credentials.dpapi` | 模型 API Key | CurrentUser DPAPI；配置只存凭据引用 |
| `<数据根>/home/profiles/desktop` | profile manifest 与 `cordis.patch.yml` | 启动器重写策略行；模型设置在 DSH 原生设置页 |
| `<数据根>/workspace` | 文件工作区 | 由 `workspace-controller` 指向 |

规模与结构（2026-11-15 按代码核对）：

- **49 张 sqlite 表** = 43 张基础表 + 1 张 FTS5 虚拟表（`study_material_fts`）+ 5 张 FTS 影子表；**32 个索引、10 个触发器**。
- 归属：core 5、facts 16、learning 13、memory 4、reminders 4、outcomes 1；外观 / 桌宠无自有表。
- 记忆主存（2026-11-11 起）是 `study_memory_item / evidence / tombstone` 三表；`memory.json` 只用于旧数据根迁移 / 导出兼容（旧数据根迁移会保留 `memory.v1.backup.json`）。
- 迁移各归各：每个插件在自己的 `apply` 中做幂等迁移；foundation 切片先 `VACUUM INTO` 备份再事务执行，失败回滚并返回 `unavailable`（附备份路径）。细节见 [contracts.md](contracts.md) §3。

内核不变量（由 `plugins/study-core/host/kernel.mjs` 统一保证）：

| 机制 | 语义 |
| --- | --- |
| `revision` | 全局单计数器；任何成功写都递增，因此 `expectedRevision` 是整库乐观锁 |
| `requestId` | 写方法强制携带；`request_log` 存指纹与响应，同 ID 同载荷重放结果，同 ID 不同载荷返回 `conflict` |
| `change_log` | 追加式变更历史（actor / entity / action / before / after / reason），触发器禁止 UPDATE / DELETE |
| `day_snapshot` | 每天第一次服务调用写入的只读快照，write-once；outcomes 通过 provider 供数，组合就绪前不写空快照 |
| 调用串行 | 单队列串行执行；`AsyncLocalStorage` 允许调用期内联，避免跨插件调用死锁 |
| 事务 | 单库单事务；学习记录只增不减（修订不可变、撤销追加新修订） |

## 5. 宿主服务面

界面与 Agent 不是两套后端，最终都落到同一个内核：

```text
界面 / 生成页 ──POST /api/study/<ns>/<method>──┐
                                             ├─→ ctx.study.call(ns, method, payload, { actor, requestId, expectedRevision })
Agent 工具 ────ctx.study.call(...)────────────┘
                                             └─→ kernel.call
```

- **13 个命名空间 / 107 个方法 / 56 个声明写 / 108 条 HTTP 路由**：每个注册方法挂一条 authenticated `POST /api/study/<ns>/<method>`；导出独立为 `GET` / `POST /api/study/export.json`（GET 下载、POST 生成并返回收据）。
- **14 个 Agent 工具**：`study_*` 10 个 + `memory_*` 4 个；`review`、`followup`、`outcomes`、`milestones`、`timer`、`planning` 无 Agent 工具，只有服务 / 路由 / UI。完整清单见 [contracts.md](contracts.md) §2、§6。
- **写约束**：跨插件写必须调用拥有者服务；kernel 对“未声明写却改了库”只告警，不拒绝；运行期没有按表权限隔离，靠契约与测试约束。
- **创造模式**（横切能力）：复用上游 `@deepseek-ai/dsh-personalized-recommendations` 提供创建卡片、生成、安装、撤销、恢复；StudyBuddy 只提供位置与数据规则（`skills/study-creator`）和启动器接线。生成插件只能经 `ctx.study.call` 或 `POST /api/study/...` 访问学习数据，不得打开 `study.db`、`credentials.dpapi`、`request_log`；写必须带 `requestId` 与读到的 `expectedRevision`。插件**不是沙箱**，与普通插件同权限；撤销只卸载 UI、源码保留，没有版本历史。

## 6. 客户端

- **一插件一 bundle 一 locale NS**：包名、profile 行 id、`window.__ModuleLoader__` bundle id 一致；每包 `exports["./client"]`；页面组件不得跨 bundle import。
- 共享库：`packages/study-client`（`ui.js` 共享样式、`definitions.js`、`actions.js`）、`packages/study-messages`（common / daily 共享文案，构建时合并进各插件 NS）、`packages/study-model`（facts 读模型、memory traits / read）、`packages/study-contracts`（冻结命名空间清单）。
- 客户端共享服务由 `study-core` 提供：`studyClient`（调用与写幂等）、`studyRefresh`（数据变更总线）、`studyNav`（页面恢复 / 导航，`study.layout.page`）、`studyUi`（面板图标）。功能插件在 `dsh.client.inject` 声明 `@studybuddy/study-core`。
- 页面注册进 DSH 的 `main` keyed slot；页面根是滚动容器，内容列居中，共享样式由 `packages/study-client/ui.js` 与 `study-core` 注入的样式表提供（Pi 式视觉改版见 [design/2026-11-17-study-page-redesign.md](design/2026-11-17-study-page-redesign.md)）。

| page key | 插件 | order | locale NS |
| --- | --- | --- | --- |
| `onboarding` | `study-facts` | 1 | `study-facts` |
| `workbench` | `study-facts` | 10 | `study-facts` |
| `timer` | `study-facts` | 15 | `study-facts` |
| `plan` | `study-facts` | 16 | `study-facts` |
| `reminders` | `study-reminders` | 17 | `study-reminders` |
| `today` | `study-core` | 20 | `study-core` |
| `outcomes` | `study-outcomes` | 25 | `study-outcomes` |
| `questions` | `study-learning` | 70 | `study-learning` |
| `memory` | `study-memory` | 80 | `study-memory` |

外观与桌宠不注册页面：外观只叠加主题 token 与品牌槽位（设置行 `study.appearance` order 35）；桌宠只注册 `shell.overlay` 与设置行 `study.pet` order 36。页面 key 是 `study.layout.page` 的持久化值，拆分后不能改名；侧栏 order 必须全局唯一。

## 7. 关键设计决策

| 决策 | 为什么 | 代价 / 边界 | 记录 |
| --- | --- | --- | --- |
| 复用 DSH，而不是分叉或另建后端 | 会话、模型、工具循环、插件容器都是上游成熟能力；产品只加业务插件与品牌壳 | 需要版本锁定、补丁重放与宿主能力验证 | [decisions/plugin-split.md](decisions/plugin-split.md) |
| 分层 DAG + 显式依赖，不做完全解耦 | 保留 requestId 幂等、全局 revision、change_log、当天快照等不变量；当前每个功能插件可独立启停 | 基础插件 schema 变更即契约变更；需要跨插件测试 | [decisions/plugin-split.md](decisions/plugin-split.md) |
| 单 SQLite 单库 + 单事务 | 学习数据跨表依赖（目标 / 任务 / 计划 / 统计），拆库要 saga / outbox，单机产品不划算 | 表归属靠契约与测试约束，没有运行期按表权限隔离 | [contracts.md](contracts.md) §3、§10 |
| 界面与 Agent 共用同一业务服务 | 防止“聊天里一份计划、页面里另一份计划”；工具与 UI 行为一致 | 工具集会随插件启停变化，提示词不能假设工具一定存在 | [contracts.md](contracts.md) §2、§5 |
| 写必须带 `requestId`，修订不可变 | 重复点击、模型重试、调度补跑都不重复创建 / 完成；学习记录不能被“撤销”抹掉 | 调用方要生成稳定 ID；数据只增不减，需要归档 / 清理策略 | [contracts.md](contracts.md) §4 |
| 分析 / 报告用确定性规则，不调模型 | 可重建、可解释、无额外费用；无 Key 也能用 | 表达不如模型灵活；需要模板与引用校验 | `plugins/study-learning/host/modules/review.mjs`、`host/learning/analysis.mjs` |
| 记忆只存会影响讲法的假设 | 不把提问次数当能力诊断；用户可纠正 / 删除，纠正优先于推断 | 只有 `explain_detail` 自动推断；其余需用户显式设置 | [decisions/memory.md](decisions/memory.md)、[contracts.md](contracts.md) §7 |
| 计时 / 提醒 / 复盘不依赖模型 | 断网、无 Key、费用不足时仍能学和记录 | 系统通知受 Windows 设置影响，应用内横幅才是兜底 | `modules/timer.mjs`、`modules/followup.mjs` |
| 外观只叠加 token，不换主题 | 保留 DSH 原生 `light/dark/system` 权威，避免用户选择被插件覆盖 | 只能在既有 token 层内做品牌，无法改变结构 | [design/appearance-plugin.md](design/appearance-plugin.md) |
| 桌宠 client-only，只读联动 | 不进入 host DAG，不影响学习数据与工具；服务缺失可静默降级 | 只做陪伴表现，不接写接口、不做 TTS / 模型对话 | [design/study-pet.md](design/study-pet.md) |

## 8. 已知边界

- **P7 未落地**：没有 `@studybuddy/bundle`；启动器仍逐行写插件绝对路径；已有数据根 profile 可能残留 `a02-probe`；旧数据根迁移未实现。
- **T18 / T19 未开始**：没有发布候选包，也未完成 14 场景全量验收（见 [roadmap.md](roadmap.md)）。
- **不是沙箱**：Creator 生成的插件与普通插件同权限，只承诺可撤销 / 可恢复；没有版本历史。
- **写隔离是契约级**：kernel 对未声明写只告警；`readContracts` 只登记元数据，不做版本兼容校验。
- **插件可关闭导致工具集变化**：提示词与 Creator 参考不能假设某工具一定存在；关闭可选插件后页面显示不可用而不是崩溃。
- **表现层限制**：桌宠 8 个状态共用一张静图、没有专属摆姿；外观只能在既有 token 层内做品牌。
- **记忆 / 提醒与设计的差距**：记忆当前 6 项教学参数（设计稿还有 `session_tolerance`），只有 `explain_detail` 自动推断；提醒没有“互动语气”设置；PDF 导入只有服务 / Agent 入口，页面无上传入口。
- **固定源码树**：DSH 升级需要重新生成并反向校验两枚补丁，属于发行准备事项，不随业务插件改动。
