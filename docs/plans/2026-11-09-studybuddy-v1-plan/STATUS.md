# STATUS：StudyBuddy v1 执行状态

最后更新：2026-11-11（T01–T17、T20 完成；issues 修复组 2 的 SB-02、SB-04、SB-06、SB-07 完成）  
本文件是**唯一状态来源**。计划见 [PLAN.md](PLAN.md)；任务卡在 [tasks/](tasks/)；每个会话先读 [AGENT.md](AGENT.md)。只在任务结束、阻塞或验收时更新，不逐条维护过程日志。

## 1. v0 基线（T00 已登记）

| 项 | 状态 | 证据/位置 | 备注 |
| --- | --- | --- | --- |
| DSH 源码固定 | 已固定 | `source/deepseek-harness`，基线 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，0.2.2-rc.1；当前分支 `task/studybuddy-model-config`（未提交） | Node 26.13 / pnpm 11.28.5 / Electron 44.7（内置 Node 24.21） |
| A01 源码与环境基线 | DONE | 旧计划 `00-discovery/A01-source-baseline.md` | 含基线锁定与验证脚本 |
| A02 扩展与桌面验证 | **DONE**（用户 2026-11-09 确认，非 T00 代签） | 旧计划 `00-discovery/evidence/A02/extension-map.md`、`validation-matrix.md` | 结论：DSH 主体路线可用；原探针无需核心前端补丁 |
| 日常启动入口 | 已存在 | `README.md`、`start-studybuddy.cmd`、`start-studybuddy.ps1`、`scripts/start-studybuddy.mjs` | 数据隔离在 `.studybuddy/`；`--prepare-only` 只初始化配置 |
| 凭据保护 | 已存在 | `platform/windows-credentials/index.mjs`；扫描证据 `docs/notes/evidence/2026-11-09-project-model-config/credential-storage-check.json` | Windows DPAPI CurrentUser；40 个文件未发现明文 Key |
| 模型配置 | 已存在并真实调用通过 | `docs/notes/2026-11-09-project-model-config.md`、`evidence/.../real-smoke.json` | 原生 `llm-pi-ai` 自定义提供商 `studybuddy-deepseek` / `deepseek-flash`；界面可增删改 |
| 桌面账号开关补丁 | 已存在并归档 | `patches/0001-desktop-account-toggle.patch`、`patches/README.md` | 9 文件 +72/−7（8 改 1 新）；反向应用校验通过 |
| 源码构建 gate | 已通过（2026-11-09 会话，T00 未重跑） | notes 第 21–23 行 | `build:artifacts` 8 gates；`build:check` 2 gates；桌面相关 3 个测试文件 14 例通过 |
| 工程测试 | 已执行（T00 重跑） | `tests/project/README.md`、`evidence/T00-unit-tests.txt` | 单元层 5/5 通过 |
| 桌面冒烟 | 已执行（T00 重跑） | `evidence/T00-desktop-smoke.json` | `passed: true`；无原生登录窗、账号 RPC 404、DPAPI 可读、模型设置可增删改 |
| A02 探针 | 已存在（非发布物） | `probes/A02/` | 学习页 slot + 共享服务 + 工具 + 真实模型证据 |
| 学习业务 | 未开始 | — | T01 起 |

**当前能做什么**：`.\start-studybuddy.cmd` 启动隔离数据根与 DPAPI 凭据的 DSH 桌面；聊天、原生模型设置、会话恢复、真实模型调用可用；账号引导已关闭。  
**当前不能做什么**：没有任何学习功能；无安装包；无计划/记忆/成果。

## 2. 测试命令

| 层级 | 命令 | 期望 | 前置 |
| --- | --- | --- | --- |
| 单元/工程 | `node --test tests/project/config.test.mjs tests/project/credentials.test.mjs tests/project/import-errors.test.mjs` | 5 pass / 0 fail | 无 |
| 插件单元 | `node --test plugins/study/tests` | 全绿；T08 单独跑 `node --test plugins/study/tests/materials` 为 37 pass / 0 fail，整套数目随并行任务增加，以命令输出为准 | 无 |
| 创建计划单元 | `node --test --test-isolation=none plugins/study/tests/planning plugins/study/tests/materials/goal-tool.test.mjs` | 15 pass / 0 fail（link/claim/pre-step 注入、一次注入、重启、非法载荷；`study_goal` 字段合并、切激活、幂等） | 无 |
| 创建计划页面单元 | `node --test --test-isolation=none plugins/study/tests/onboarding plugins/study/tests/client` | 58 + 67 pass / 0 fail（三步流程、brief 解析与渲染、降级草案、预填顺序、bundle 新鲜度、字典键） | 无 |
| 番茄钟单元 | `node --test --test-isolation=none plugins/study/tests/timer` | 34 pass / 0 fail（生命周期、时长设置、中断确认、重启恢复、宿主路由、页面四态）；沙箱下用 `--test-isolation=none` 规避 `spawn EPERM` | 无 |
| 拖拽与进度单元 | `node --test --test-isolation=none plugins/study/tests/progress` | 42 pass / 0 fail（单块跨日移动、重叠显式保留、五态进度、待确认、完成率、重复点击、并发重提、旧库增量建表）；沙箱下用 `--test-isolation=none` 规避 `spawn EPERM` | 无 |
| 插件加载冒烟 | `node plugins/study/tests/kernel/loader-smoke.mjs`；`node plugins/study/tests/kernel/tool-smoke.mjs`；`node plugins/study/tests/materials/tool-smoke.mjs` | 均 `passed: true`；真实 DSH web/headless 启动，结束后自动清理临时 home | 需要可运行 `source` 的 tsx 启动；两个 `tool-smoke` 使用上游 mock 模型，无需 Key |
| 客户端构建 | `node plugins/study/scripts/build-client.mjs` | 退出 0，产物 `plugins/study/client/client.js`（改了 `client/**` 后必须重跑） | 需要 esbuild：优先本包安装，否则取固定源码树的 pnpm store |
| 客户端单元 | `node --test plugins/study/tests/client` | 55 pass / 0 fail（构建发现、barrel、包装、注册、页面四态、双语文案、产物新鲜度、T04 学习栏四态/宽度与上次页面） | 无 |
| 创造模式单元 | `node --test --test-isolation=none plugins/study/creator/tests` | 7 pass / 0 fail（profile bundle 与标记、已有 profile 保留、skill 挂载与文案、位置/数据边界、文档） | 无 |
| 创造 profile 合成 | `node plugins/study/creator/tests/profile-compose.mjs` | `passed: true`；layers [base, web-app, personalized]、skipped []、6 个 creator 行、skill 与标记已挂载；报告 `plugins/study/creator/evidence/profile-compose.json` | 无（需要已构建的 `source` app-boot lib） |
| 创造流程冒烟 | `node plugins/study/creator/tests/creation-smoke.mjs` | `passed: true`；报告与 7 张截图在 `plugins/study/creator/evidence/`；真实 Host + Edge + 脚本化模型：模式切换、生成、安装、重启、撤销、恢复、失败提示 | 需要 Edge 与宿主进程权限；使用隔离 Web profile，不触碰 `.studybuddy`；脚本不属于 `node --test` |
| 客户端 UI 冒烟 | `node plugins/study/tests/client/ui-smoke.mjs` | 报告 `passed: true` 与三张截图在 `plugins/study/tests/client/evidence/`；真实 Host + Edge，含中文/英文/停用插件三种运行 | 需要 Edge 与宿主进程权限；脚本会自行关掉首屏「预览版说明 → 添加 API Key → 稍后配置」链条 |
| 双主栏 UI 冒烟 | `node plugins/study/tests/client/dual-pane-smoke.mjs` | 报告 `passed: true` 与 13 张截图、`dual-pane.json` 在 `plugins/study/tests/client/evidence/`；真实 Host + Edge + 上游 mock 模型，1440×900 下拖拽、窄窗回退、保存宽度与上次页面 | 需要 Edge 与宿主进程权限；会重建客户端 bundle；核心布局包改动后先 `pnpm --filter @deepseek-ai/dsh-client-ui-layout bundle` |
| 完成提醒单元 | `node --test plugins/study/tests/notify` | 47 pass / 0 fail（完成检测、合并、权限降级、刷新去重、开关、导航、文案、装配） | 无 |
| 完成提醒 UI 冒烟 | `node plugins/study/tests/notify/ui-smoke.mjs` | 报告 `passed: true` 与两张截图在 `plugins/study/tests/notify/evidence/`；真实 Host + Edge，打开「设置 → 通用设置」驱动开关并验证刷新后保持 | 需要 Edge 与宿主进程权限；脚本按 `Ctrl+Alt+,` 打开设置（web 的 `settings.open` 组合） |
| 提醒与复盘单元 | `node --test --test-isolation=none plugins/study/tests/followup` | 51 pass / 0 fail（21 提醒：去重/合并/静默/专注/稍后/答复/无补发/设置/逾期；8 复盘：剩余/容量/草案/修订竞态/依赖失败/幂等；22 页面/banner/feed/安装） | 无 |
| 里程碑与反馈单元 | `node --test --test-isolation=none plugins/study/tests/milestones` | 46 pass / 0 fail（里程碑证据与达成日期、取消/待确认/部分完成不计、周月阶段小结、文案推断词审计、客户端基线/去重/自动消失/存储降级、真实服务到客户端集成） | 无 |
| 答疑上下文单元 | `node --test --test-isolation=none plugins/study/tests/tutoring` | 29 pass / 0 fail（任务/材料/正式计划注入、源 kind、同任务去重、requestId、pending/flush、重启、任务切换、显式刷新、自由聊天隔离、工具、动作、路由） | 无 |
| 答疑上下文冒烟 | `node plugins/study/tests/tutoring/tool-smoke.mjs` | 报告 `passed: true` 与 `evidence/tool-smoke.json`；真实 headless + mock 模型：`study_tutoring` 可见并调用，后续请求含任务/材料片段/最新计划，同一注入只有一条 `study-tutoring` 消息记录，自由聊天不再注入 | 需要 tsx 启动固定 `source`；mock 模型无需 Key |
| 桌面冒烟 | 先 `.\start-studybuddy.cmd`（或 `node scripts/start-studybuddy.mjs`），等日志出现 `dsh web: http`，再 `node tests/project/desktop.test.mjs` | `"passed": true`，报告在 `.studybuddy/test-results/desktop.json` | 应用必须运行；`--real` 需模型授权 |
| 核心补丁校验 | `git -C source/deepseek-harness apply --check -R "$PWD/patches/0001-desktop-account-toggle.patch"` | 退出 0 | 无 |

注意：`node --test tests/project` 会包含桌面冒烟，应用未启动时必然失败，属预期。`probes/A02/verify.mjs` 断言上游工作树干净，在 `patches/0001` 之后不再适用，仅作历史证据。本会话的 GUI 测试需要 `$env:NODE_ENV='test'`：会话环境带 `NODE_ENV=production` 时，vitest 的 jsdom 套件会统一报 `No such built-in module: node:`；T04 用 Node 24.13 + `NODE_ENV=test` 复跑 `test:gui`。

## 3. 任务状态

状态取值：`TODO / IN_PROGRESS / BLOCKED / REVIEW / DONE`。DONE 需有测试或证据行。

| ID | 任务 | 预计 | 状态 | 分支 | 证据/命令 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| T00 | 基线收尾与计划落地 | 0.5 | **DONE** | n/a（外层无 Git） | 本文 + `evidence/T00-*` + `patches/0001` | 2026-11-09 |
| T01 | study 内核与服务骨架 | 1 | **DONE** | n/a（外层无 Git） | `node --test plugins/study/tests` 46/46；`loader-smoke.mjs`、`tool-smoke.mjs` 均 `passed: true`；工程单元 5/5 | 见 [BOUNDARIES.md](BOUNDARIES.md)；数据在 `<root>/study/study.db` |
| T02 | 客户端构建与页面骨架 | 1 | **DONE** | n/a（外层无 Git） | 构建退出 0（pages: memory, today；actions: refresh）；`node --test plugins/study/tests/client` 38/38；整套插件测试 136/136；`ui-smoke.mjs` `passed: true`（中/英真实渲染、刷新动作、停用后无入口且路由 404），证据在 `plugins/study/tests/client/evidence/`；两个 kernel 冒烟仍 `passed: true` | 见 [BOUNDARIES.md](BOUNDARIES.md)；产物 `plugins/study/client/client.js` | 2026-11-10 |
| T03 | 双主栏方案验证 | 0.5 | **DONE** | n/a（外层无 Git） | `node probes/layout/run-route1.mjs` passed=true（1440×900：空白会话下学习区在发消息前可用；右栏上限导航展开 760px / 收成轨道 984px，对话列保持 400px；刷新恢复会话/面板/标签；学习区与原生对话都可操作）；`node probes/layout/run-route2.mjs` passed=true（隔离 web profile 安装 `dock-base@0.2.4`：与原生聊天并存、四边停靠、可悬浮；但侧栏仅 300px、`dock` 模式 `display:none` 编辑器区、对话列宽度不变）；`node probes/layout/estimate-route3.mjs` 生成 `evidence/route3.json`（源码约 +62、测试约 +99）；`node --test tests/project/config.test.mjs tests/project/credentials.test.mjs tests/project/import-errors.test.mjs` 5/5；结论见 `docs/decisions/layout.md` | 路线 1 方向相反且全局面板时学习区消失；路线 2 否决；选定路线 3（中央列内第二主栏，≤100 行预算内），由 T04 实施；探针与证据只在 `probes/layout/`，未改 DSH 源码 | 2026-11-10 |
| T04 | 双主栏实现 | 1 | **DONE** | n/a（外层无 Git） | `node plugins/study/tests/client/dual-pane-smoke.mjs` passed=true（真实 Host+Edge+上游 mock 模型，1440×900）：首屏 280/560/600、0 条消息时学习栏已加载今日数据；拖宽到 630（对话 530）并存 `study.layout.leftmain.width=630`；拖过最窄仍显示 320px（不消失）；窗口 1200px 时渲染夹到 520 但保存值保持 630，回 1440 恢复 630；打开工作台后刷新恢复宽度 630 与上次页面 workbench；回到对话清除 `study.layout.page`，再刷新停在对话；1023px 时学习栏与手柄消失、侧栏「工作台」页可用；回 1440 学习栏带 630 恢复；pageErrors/consoleErrors 均空；13 张截图与 `dual-pane.json` 在 `plugins/study/tests/client/evidence/` | `node --test plugins/study/tests/client` 55/55；`node --test plugins/study/tests` 344/345（唯一失败为 T20 既有 memory 快照真实时钟用例）；`pnpm run test:gui`（NODE_ENV=test，Node 24.13）743/744 文件、13100/13103 用例通过、2 skipped，唯一失败 `present-open.host.spec.ts` 的 Windows symlink EPERM（环境权限）；`pnpm run typecheck` 5/5 gates；工程单元 5/5；`git apply --check -R patches/0002-second-main-column.patch` 退出 0 | 见 [BOUNDARIES.md](BOUNDARIES.md)；手写核心补丁 5 文件 +97/−7（≤100）、0 个 locale key；另生成 `slot-catalog.ts` +35/−3（`verify-client-catalog` 通过）；`patches/0002` 749 行含测试/README/Agent Note | 2026-11-10 |
| T05 | 工作台：今日/周 | 1 | **DONE** | n/a（外层无 Git） | `node --test plugins/study/tests/tasks` 39/39；`node --test plugins/study/tests/client` 38/38；`node --test plugins/study/tests/kernel/plugin.test.mjs` 13/13；`node plugins/study/scripts/build-client.mjs` ok（pages：memory、today、workbench）；`node plugins/study/tests/client/ui-smoke.mjs` `passed: true`；整套插件测试 227/228，唯一失败为并行任务 T15 的 `notify/notifier.test.mjs`（`react` 解析，非 T05） | 见 [BOUNDARIES.md](BOUNDARIES.md)；新增 `client/messages/workbench.js` 是页面/字典配对契约要求；`kernel/plugin.test.mjs` 一处示例命名空间由 `tasks` 改为 `timer`，避免与新模块冲突 | 2026-11-10 |
| T06 | 拖拽、冲突与进度 | 1 | **DONE** | n/a（外层无 Git） | `node --test --test-isolation=none plugins/study/tests/progress` 42/42（跨日移动只改选中块且 id/taskId/createdAt 不变、change_log 只追加一次 move；create/update/move 重叠返回 `conflict` + `conflicts`，`allowOverlap: true` 才保存；五态进度、数量校验、待确认独立计数、取消不进完成率、未记录不推断未开始；相同状态不重复追加、触发器禁改删、重启回读；`expectedRevision` 过期拒绝并可按新修订重提、`requestId` 幂等；旧 v1 库在 apply 时增量建表）；`node --test --test-isolation=none plugins/study/tests/tasks` 39/39；`node --test --test-isolation=none plugins/study/tests/client` 38/38（含产物新鲜度）；`node plugins/study/scripts/build-client.mjs` ok（bytes 157868，pages [memory, timer, today, workbench]）；`node plugins/study/tests/kernel/loader-smoke.mjs` passed=true（真实 web profile 载入 tasks schema v1、鉴权路由 200、匿名 401）；`node --test plugins/study/tests` 328 例 327 pass / 1 fail，唯一失败为 T20 既有 memory 快照真实时钟用例（非本任务） | 见 [BOUNDARIES.md](BOUNDARIES.md)；`tasks` 服务 13 个方法（新增 `moveBlock`/`recordProgress`/`progress`）；无任务 Agent 工具，进度写入只经服务与页面 | 2026-11-10 |
| T07 | 番茄钟 | 0.5 | **DONE** | n/a（外层无 Git） | `node --test --test-isolation=none plugins/study/tests/timer` 34/34（生命周期/设置/中断确认/重启恢复/宿主路由/页面四态）；`node --test --test-isolation=none plugins/study/tests/client` 38/38；`node plugins/study/scripts/build-client.mjs` ok（bytes 157868，pages [memory, timer, today, workbench]）；`node plugins/study/tests/client/ui-smoke.mjs` passed=true（真实 Host+Edge，bundle 含 timer，中/英/停用三跑无页面/控制台异常）；整套插件 327/328，唯一失败为 T20 既有的 memory 快照时钟用例（非本任务） | 见 [BOUNDARIES.md](BOUNDARIES.md)；页面按 T02 契约落在 `client/pages/timer.js`（任务卡的 `client/panels/timer.js` 是 T02 前命名），新增同名 `client/messages/timer.js`；timer 服务 7 个方法 + 每 5 秒心跳，无模型工具 | 2026-11-10 |
| T08 | 目标与资料导入 | 1 | **DONE** | n/a（外层无 Git） | `node --test plugins/study/tests/materials` 37/37；`plugins/study/tests/materials/tool-smoke.mjs` `passed: true`（真实 headless 会话里模型可见并调用 `study_materials`，资料落库、片段进索引、change_log 记 `agent`）；`kernel/loader-smoke.mjs` `passed: true`（真实 web profile 载入 materials schema v1、鉴权路由 200、匿名 401） | 见 [BOUNDARIES.md](BOUNDARIES.md)；13 个 materials 方法 + `study_materials` 工具 |
| T09 | 计划草案、版本与工具 | 1 | **DONE** | n/a（外层无 Git） | `node --test --test-isolation=none plugins/study/tests/plans` 30/30（草案/容量/版本/进度/工具/路由）；整套 `node --test --test-isolation=none plugins/study/tests` 252/252；`node plugins/study/tests/plans/tool-smoke.mjs` `passed: true`（3 次真实 headless：模型可见并调用 `study_plan` 提交草案→确认修订 1，`study_progress` 读取进度；change_log actor 均为 `agent`，修订 applied、草案清空；连跑 3 次均 passed）；`node plugins/study/tests/kernel/loader-smoke.mjs` `passed: true`（真实 web profile 载入 plans schema v1，modules 含 plans，鉴权路由 200、匿名 401） | 见 [BOUNDARIES.md](BOUNDARIES.md)；plans 服务 12 个方法 + `study_plan`/`study_progress` 两个工具；容量不足/时间重叠需显式 `trial: true`，未安排条目保留 | 2026-11-10 |
| T10 | 首次使用与计划页 | 1 | **DONE** | n/a（外层无 Git） | `node --test --test-isolation=none plugins/study/tests/onboarding` 48/48（引导状态与存储续填、最少信息载荷、试行确认闸门、计划页四态、草案/修订差异、缺信息、材料来源、撤销载荷，以及 6 例真实 plans+materials 服务集成）；`node plugins/study/tests/onboarding/ui-smoke.mjs` passed=true（真实 Host+Edge：打开「开始」→跳过→重开→刷新看到修订 1；计划页显示阶段/周目标、任务与缺失信息，点击材料来源 `<details>` 打开并显示未核实页码；pageErrors/consoleErrors 空；3 张截图与 `ui-smoke.json` 在 `plugins/study/tests/onboarding/evidence/`）；`node --test --test-isolation=none plugins/study/tests/client` 55/55（含产物新鲜度与全量字典键审计）；`node plugins/study/scripts/build-client.mjs` ok（pages 含 onboarding、plan）；`node --test --test-isolation=none plugins/study/tests` 505 例 503 pass / 1 fail / 1 skipped（唯一失败为 T20 既有 memory 快照真实时钟用例，非本任务） | 见 [BOUNDARIES.md](BOUNDARIES.md)；引导页不自动打开，入口是侧栏「开始」；对话生成的草案由刷新检测后进入确认，页面不调用模型；新增 `client/messages/onboarding.js`、`client/messages/plan.js`（T02 页面/字典配对契约）；`client/client.js`、`client/.build/entry.js` 为共享产物，本次构建同时打包并行任务页面 | 2026-11-10 |
| T11 | 任务答疑上下文 | 0.5 | **DONE** | n/a（外层无 Git） | `node --test --test-isolation=none plugins/study/tests/tutoring` 29/29（注入/去重/requestId/pending/flush/重启/任务切换/显式刷新/自由聊天隔离/工具/动作/路由）；`node plugins/study/tests/tutoring/tool-smoke.mjs` passed=true（真实 headless + mock 模型：`study_tutoring` 可见并调用，后续请求含任务《第二章 导数习题》、材料片段与计划 19:00–19:30；同任务 3 次工具调用只产生 1 条注入，`change_log` actor=`agent`；随后自由聊天新增注入 0；`study-tutoring` 源在会话日志出现 2 次=inbox splice + admitted user/message；证据 `plugins/study/tests/tutoring/evidence/tool-smoke.json`）；`node plugins/study/tests/kernel/loader-smoke.mjs` passed=true（modules 与 route moduleIds 含 tutoring、匿名 401）；`node --test --test-isolation=none plugins/study/tests/client` 55/55（bundle 新鲜度、全量字典）；`node plugins/study/tests/client/ui-smoke.mjs` passed=true（真实 Host+Edge，zh/en/停用三跑 pageErrors/consoleErrors 空）；`node plugins/study/scripts/build-client.mjs` ok（bytes 364799，messages 含 tutoring，actions 含 ask-task）；本任务收尾时整套插件 506 例 504 pass / 1 fail / 1 skip，唯一失败为 T20 既有 memory 快照真实时钟用例（非本任务） | 见 [BOUNDARIES.md](BOUNDARIES.md)；`tutoring` 服务 5 个方法（open/flush/close 写，brief/context 读）+ `study_tutoring` 工具；同任务重复注入去重，事实变化需显式 `refresh:true`；新增 `client/messages/tutoring.js`、`host/registry.mjs` 命名空间与 `tests/kernel/registry.test.mjs` 断言是所有权外/共享改动；工作台任务行尚未渲染「问这道题」按钮（`workbench.js` 不在所有权内），入口留 T19 接线 | 2026-11-10 |
| T12 | 应用内提醒与晚间复盘 | 1 | **DONE** | n/a（外层无 Git） | `node --test --test-isolation=none plugins/study/tests/followup` 51/51（21 提醒 + 8 复盘 + 22 页面/feed/安装）；`node --test --test-isolation=none plugins/study/tests/client` 55/55（T12 收尾前一次运行）；`node --test --test-isolation=none plugins/study/tests/kernel/plugin.test.mjs` 12 pass / 1 skip（全部冻结命名空间均已被模块占用，晚注册用例按条件跳过）；`node plugins/study/tests/kernel/loader-smoke.mjs` passed=true（modules 含 followup schema v1、route moduleIds 含 followup、匿名 401）；`node plugins/study/tests/client/ui-smoke.mjs` passed=true（bundle pages 含 reminders，zh/en/停用三跑 pageErrors/consoleErrors 空）；`node plugins/study/scripts/build-client.mjs` ok（bytes 364513，pages 含 reminders）；整套插件在 T12 加入逾期用例前 503 例 501 pass / 1 fail / 1 skip，唯一失败为 T20 既有 memory 快照真实时钟用例；加入后最新整套/客户端重跑被并行 T10 的 `client/pages/onboarding.js` 与 `tests/onboarding/*` 语法错误挡住（非 T12） | 见 [BOUNDARIES.md](BOUNDARIES.md)；提醒来源为 T06 时间块；复盘到点只提示与预览，保存需学生点击；真实浏览器点击级提醒/复盘未做，留 T19 | 2026-11-10 |
| T13 | 日周月成果统计 | 1 | **DONE** | n/a（外层无 Git） | `node --test --test-isolation=none plugins/study/tests/outcomes` 33/33（三口径、取消不抬高、原计划不被修订重写、待确认、跨天/跨周/跨月、日快照与 change_log 基线、重启回读、只读、材料推进、页面四态、性能）；性能夹具超过 1 万行：月查询中位 59.2ms / 最大 70.0ms，周 26.3ms，日 16.1ms；`node --test --test-isolation=none plugins/study/tests/client` 55/55；`node plugins/study/scripts/build-client.mjs` ok（pages 含 outcomes）；`node plugins/study/tests/client/ui-smoke.mjs` passed=true（真实 Host+Edge，page/console 错误 0）；`node plugins/study/tests/kernel/loader-smoke.mjs` passed=true（moduleIds 含 outcomes、daySnapshots 1、鉴权 200/匿名 401）；`node scripts/backup-studybuddy.mjs --drill` ok=true；工程单元 5/5；整套插件 504 例 502 pass / 1 fail / 1 skipped（唯一失败为 T20 既有 memory 真实时钟用例） | 见 [BOUNDARIES.md](BOUNDARIES.md)；无自有表，从进度/日快照/change_log/计划修订重建；新增 `client/messages/outcomes.js`（T02 页面配对契约）；无 Agent 工具，T14 走 `outcomes` 服务；真实点击级成果页冒烟留 T19 | 2026-11-10 |
| T14 | 里程碑与轻量反馈 | 0.5 | **DONE** | n/a（外层无 Git） | `node --test --test-isolation=none plugins/study/tests/milestones` 46/46（文案证据/取消与待确认不计/达成日期不漂移/周月口径/客户端基线去重/自动消失/存储降级/真实服务到客户端集成）；`node --test --test-isolation=none plugins/study/tests/client` 55/55（含产物新鲜度与中文文案审计）；`node --test --test-isolation=none plugins/study/tests/kernel` 45 pass / 1 skip；`node plugins/study/scripts/build-client.mjs` ok（bytes 391023，messages 含 feedback）；`node plugins/study/tests/kernel/loader-smoke.mjs` passed=true（route moduleIds 含 milestones、鉴权 200/匿名 401、studyErrors 0）；`node plugins/study/tests/client/ui-smoke.mjs` passed=true（真实 Host+Edge，zh/en/停用三跑 pageErrors/consoleErrors 均空）；`node scripts/backup-studybuddy.mjs --drill` ok=true（26 项检查，0 失败）；工程单元 5/5；整套插件 552 例 550 pass / 1 fail / 1 skipped（唯一失败为 T20 既有 memory 快照真实时钟用例，非本任务） | 见 [BOUNDARIES.md](BOUNDARIES.md)；新增只读 `milestones` 命名空间（`overview`/`feedback`，无表、无 Agent 工具），只统计 outcomes 中 confirmed `done`；客户端只有 `client/components/feedback.js` + 必配 `client/messages/feedback.js`，`client/plugin.js` 加 import 与一行安装；轮询从 overlay 首次订阅开始，无订阅者不留计时器；已知限制：服务端阶段小结/里程碑文案为中文，英文界面卡片正文仍中文；卡片每周期只弹一次（首次有记录时展示并记账）；未做真实浏览器点击级反馈冒烟，留 T19 | 2026-11-10 |
| T15 | 回复完成通知 | 0.5 | **DONE** | n/a（外层无 Git） | `node --test plugins/study/tests/notify` 47/47；`node --test plugins/study/tests` 252/252；`node plugins/study/scripts/build-client.mjs` ok（bytes 102991，messages 含 notify）；`node plugins/study/tests/notify/ui-smoke.mjs` `passed: true`（真实 Host+Edge：「通用设置」出现「回复完成时提醒」，默认已开启且未写偏好，点击后写 `study.notify.completion.enabled=0` 并变「已关闭」，刷新后仍关闭，无页面异常、无插件控制台错误），报告与截图在 `plugins/study/tests/notify/evidence/` | 见 [BOUNDARIES.md](BOUNDARIES.md)；新增 `client/messages/notify.js` 与 `client/plugin.js` 两行接线（跨所有权原因见 [BOUNDARIES.md](BOUNDARIES.md)） | 2026-11-10 |
| T16 | DSH 创造模式与模式切换 | 1 | **DONE** | n/a（外层无 Git） | `node --test --test-isolation=none plugins/study/creator/tests` 7/7；`node plugins/study/creator/tests/profile-compose.mjs` `passed: true`（`prepareProfile` 写出的 desktop profile：layers [base, web-app, personalized]、skipped []、creator 6 行、skill 与标记已挂载，报告 `evidence/profile-compose.json`）；`node plugins/study/creator/tests/creation-smoke.mjs` `passed: true`（真实 Host + Edge + 脚本化模型，1440×900）：标准模式日常答疑 0 张卡片且请求无 `cordis_inspect_query`；模式菜单 4 项（标准/PTC/极简/创造）；创造会话请求 45 工具含 `cordis_inspect_query`；卡片生成后 Create 写真实包（`link:` 安装、`created-plugins` 副本、`/api/study/tasks/day`）、刷新后页签「学习清单」显示 `09:00–09:30 极限习题（30 分钟）`；标准会话后续请求仍是 42 工具无 Card，创造会话后续请求仍是 45 工具；新任务默认无 `agent-preset-registry` 写入；重启同一数据根后空会话仍显示「标准模式」，创造会话页签/数据仍在；撤销后依赖消失、刷新页签消失，恢复后依赖与页签回来；第二次 Create 收到 `structured_output {ready:false}` 后卡片显示「创建失败，可重试」+「重新创建」；page/console 错误为空；报告与 7 张截图在 `plugins/study/creator/evidence/`；`node --test --test-isolation=none plugins/study/tests` 552 例 550 pass / 1 fail（唯一失败为 T20 既有 memory 快照真实时钟用例）/ 1 skipped；工程单元 5/5 | 见 [BOUNDARIES.md](BOUNDARIES.md)；`prepareProfile` 首次启动把 `@deepseek-ai/dsh-personalized-recommendations` 写入隔离 profile 并留下 `.studybuddy-creator-enabled` 标记（插件页关闭后不再强开）；`plugins/study/creator/skills/study-creator` 复制到 `<数据根>/home/skills`；creator 参考为英文、`docs/creator.md` 为中文；未改 DSH 源码、客户端 bundle 或 `.studybuddy` 运行数据 | 2026-11-10 |
| T17 | 冷备份与数据导出 | 0.5 | **DONE** | n/a（外层无 Git） | `node scripts/backup-studybuddy.mjs --drill` `ok: true`（26 项检查：进程拒绝、备份/校验/恢复、篡改检测、任务↔时间块/计划↔目标/片段↔资料/进度↔计划修订交叉核对、`study_export` 工具与 `/api/study/export.json` 不含凭据）；真实数据根被运行中的应用占用时退出 3；对隔离的真实数据副本执行备份/校验/恢复：17 文件 376,538 字节、revision 0、`integrity_check`/`quick_check` 均 `ok`；`node plugins/study/tests/kernel/loader-smoke.mjs` `passed: true`（modules 含 export，鉴权 200/匿名 401）；整套插件测试 327/328，唯一失败为 T20 既有 memory 快照真实时钟用例 | 见 [BOUNDARIES.md](BOUNDARIES.md)；JSON 导出只读 `study.db`+`memory.json`，不含凭据/request_log/日志；`launch.json` 不备份；outcomes 在 T13 前为空并标明原因；无独立 UI 按钮，入口为 Agent 工具与鉴权路由 | 2026-11-10 |
| T18 | 发布候选包 | 0.5 | TODO | — | — | — |
| T19 | 全场景验收与回归 | 1 | TODO | — | — | — |
| T20 | 记忆验证与接入 | 1 | **DONE** | n/a（外层无 Git） | 隔离 headless profile 安装 `@restregular/dsh-memory` 0.30.1：加载、6 个工具、跨会话召回、重启持久化、修订、TTL、删除、中文词法均通过；但无来源字段、无删除墓碑、写入绕过 `ctx.study`，改本地模块。`node --test plugins/study/tests/memory` 15/15；`kernel`+`memory` 61/61；整套插件测试 136/136；`tests/memory/tool-smoke.mjs` `passed: true`；`build-client.mjs` 产出 `pages: memory, today` | 见 [BOUNDARIES.md](BOUNDARIES.md)、`docs/decisions/memory.md`、`evidence/T20-*` | 2026-11-10 |

合计约 17 个会话；波次与依赖见 PLAN 第 4、5 节。

## 4. 交付记录

逐条交付记录已与第 3 节任务状态表合并：状态、分支、测试命令与结果、已知限制都在该表的「证据/命令」与「备注」两列。

历史逐条日志（T00–T20 每行一条）保留在 git 首次提交 105bbae 的旧版 STATUS.md 中，需要时用 `git show 105bbae:docs/plans/2026-11-09-studybuddy-v1-plan/STATUS.md` 取回。新增记录只写进第 3 节表格，不再追加独立日志。

## 5. 已知边界

已移到 [BOUNDARIES.md](BOUNDARIES.md)：内核与服务契约、各任务的已知限制、不变量。任务表「备注」列指向 [BOUNDARIES.md](BOUNDARIES.md) 的条目即出自该文件。

## 6. issues 修复组 2（每日闭环，2026-11-11）

| ID | 状态 | 证据 | 已知限制 |
| --- | --- | --- | --- |
| SB-02 | DONE | `study_tasks` 工具与 UI 共用 `tasks` 服务；`plan.js` 确认/修订/进度/拖拽、`workbench.js` 问这道题/开始番茄/进度、`ask-task` 会话先建后链；`daily-loop.test.mjs` 4/4，tasks+tutoring 68/68，plans 40/40 | 未做真实浏览器点击级拖拽；部分完成数量仍用 `prompt()` |
| SB-04 | DONE | 原始估算只读；`remainingMinutesOf` 幂等；`buildProposal` 纳入 `date:null`/未记录/待确认并拆分；容量不足保留 `unscheduledMinutes`；`analyzePlan`/`itemCounts`/`progressSummary` 不再把部分未安排显示成已排下；followup 38/38 | 贪心拆分，不优化学科交替/前置；未安排剩余是条目元数据 |
| SB-06 | DONE | 按块结束触发、`block:<id>` 身份、逐块答复、重复 claim 幂等；旧 `task:*` key 在加载时过期；followup 38/38 | 应用关闭不提醒；时段字段仅展示，不再参与身份 |
| SB-07 | DONE | 复盘决策 B（手动确认）；Schedule 降级记录在 `followup.recovery`；系统通知共用 reminder key、番茄完成通知、权限入口与可关闭恢复摘要；notify 51/51；真实 Edge 证据 `plugins/study/tests/notify/evidence/learning-browser.json` `passed: true` | 未做 Host→main 通知桥；Windows toast 可见性受系统限制 |
| SB-19 | DONE | 开始页改为「创建计划」：目标 → 材料 → 计划需求（brief）→「让助手开始规划」，保留手动草案降级；宿主新增 `planning` 服务（link 表 + `start/claim/get/close`）与 `agent/pre-step` 第一轮注入；新增 `study_goal` 工具（字段合并）；planning+goal 15/15、plan-creation 7/7、onboarding 58/58、client 67/67，整套 593 例 592 pass / 1 skip；`loader-smoke.mjs` `passed: true`（moduleIds 含 `planning`）；`onboarding/ui-smoke.mjs` `passed: true`（真实 Host + Edge：创建计划页四步、brief、暂不创建、刷新 done、计划页）；`plans/tool-smoke.mjs` `passed: true` | 未做真实模型端到端点击（提示词注入由 `agent/pre-step` 单测与页面冒烟分别覆盖）；创建页不提供「继续上次创建对话」入口；计划修改仍只在计划页/工作台 |
| SB-20 | DONE | 删除 `GoalScope` 与 `common.currentGoal/noActiveGoal`，所有 study 页面直接渲染 `page.Page`；client 75/75；`onboarding/ui-smoke.mjs` `passed: true`，计划/工作台截图顶部无目标栏 | 页面内不再提供切换目标；目标在别处变更后，已打开页面在下次进入时刷新 |
| SB-21 | DONE | 计划新增 `projects[]` + `item.projectId`，物化到 `study_task.project_id/project_title/scheduled_date`；计划页项目卡、按项目/日期分组、日期徽标与「到工作台安排」提示；工作台「今日计划/本周计划」组 + 「安排时间」预选任务；提示词 v2 要求项目和日期、不写钟点；projects 4/4、client 75/75、`plans/tool-smoke.mjs` `passed: true`、`ui-smoke` `passed: true`（`hasProjects=true`、`projectCount=2 个项目`、工作台计划组与时间块表单） | 无独立项目 CRUD；服务层仍允许 `date:null`（由提示词/缺失信息约束）；拖块改日期不改写计划分配日期 |

说明：本节取代 [BOUNDARIES.md](BOUNDARIES.md) 中 T11/T12/T13 关于“工作台无问这道题入口”“提醒按任务时段记账/计划条目未物化”“复盘不拆分”等旧描述；旧条目保留为历史记录。构建产物在最终源码稳定后重跑 `node plugins/study/scripts/build-client.mjs`；构建新鲜度测试在无宿主权限的沙箱内会因 esbuild `spawn EPERM` 失败，属环境限制。全量插件套件当前 555 例 553 pass / 1 skip；唯一失败是 T13 既有 `outcomes/performance.test.mjs` 的 100ms 阈值在并发负载下抖动（实测月查询 105ms，单跑 81.9ms 通过），与本组改动无关。

## 7. 创建计划（SB-19，2026-11-11）

目标：把「开始」页改造成「创建计划」，学生仍手填目标、材料和计划需求，点「让助手开始规划」后由模型在对话里主动提问、以探讨方式把计划谈出来；不新增 skill，提示词与工具都留在 study 插件内；计划的修改继续走计划页/工作台，与创建解耦。

**机制**

- `planning.start`（写）按会话保存「表单快照 + 提示词」；`planning.claim`（写）原子取走一次。
- `planning` 模块注册 `agent/pre-step`：只在会话 `turn 1 / step 1` 先 `pending`（读）再 `claim`（写），把消息追加到这一步（`source.kind = study-planning`、`form = instructions`），因此提示词与学生的开场白同一步进入模型，且只注入一次；普通会话第一步不会提交写事务。
- 客户端顺序固定：`connectWorkspace` → `planning.start` → `openSession` → `requestDraftInitialization`（预填「帮我按刚填的信息创建学习计划。」）。`start` 失败就不打开对话。
- 新增 `study_goal`（get/list/save）：`save` 带 `id` 时先读现状再合并，避免服务端整行覆盖清空字段；工作区关联不传即保持不变。
- 手动路径保留：brief 页的「不用助手，自己写草案」进入原草案→确认流程，满足无模型/断网可用。

**命令与结果（2026-11-11 本机）**

- `node --test --test-isolation=none plugins/study/tests`：593 例 592 pass / 0 fail / 1 skip（skip 为既有的启动后注册命名空间用例）。
- `node --test --test-isolation=none plugins/study/tests/planning plugins/study/tests/materials/goal-tool.test.mjs`：15/15。
- `node --test --test-isolation=none plugins/study/tests/client`：67/67（含 bundle 新鲜度与全量字典键）。
- `node plugins/study/scripts/build-client.mjs`：退出 0，bundle 430480 字节。
- `node plugins/study/tests/kernel/loader-smoke.mjs`：`passed: true`，moduleIds 含 `planning`，匿名 401。
- `node plugins/study/tests/onboarding/ui-smoke.mjs`：`passed: true`；截图 `onboarding-goal.png`、`onboarding-brief.png`、`onboarding-done.png`、`plan.png` 在 `plugins/study/tests/onboarding/evidence/`。
- `node plugins/study/tests/plans/tool-smoke.mjs`：`passed: true`（同时修了 SB-03 之后漂移的 `expectedDraftRevision` 参数）。

**已知限制**

- 真实模型端到端点击未跑：`ui-smoke` 没有配置模型，因此只覆盖到「brief 页 + 按钮存在 + 暂不创建」；提示词注入由 `planning` 单测的 `agent/pre-step` 覆盖。接真实模型后应补一条点击级证据。
- 创建页不显示「继续上次创建对话」；学生可以在会话列表找到那次对话继续，草案保存在方案里。
- 计划页的 confirm/undo 与工作台任务编辑未改动；创建后的修改仍走这些既有入口。

## 8. 页面目标栏移除与计划项目/任务日期（SB-20、SB-21，2026-11-11）

目标：去掉每个学习页面顶部的「当前目标」选择栏（番茄钟/记忆页同样不再出现）；把计划改成「计划 → 项目 → 任务」结构，计划生成时给每个任务分配日期，当天具体钟点交给工作台和用户手动安排。

**机制**

- 目标作用域只在数据层保留：`resolveActiveGoal`、`goal_id` 过滤、显式 `goalId` 都不变；界面不再提供切换器。`client/plugin.js` 直接注册 `page.Page`，删除 `components/goal-scope.js` 与 `common.currentGoal/noActiveGoal`。
- 计划文档新增 `projects[]`（`id/title/kind/materialId/target/note`）与 `items[].projectId`；项目 id 稳定生成，未知项目/重复 id 被拒；省略 `projects` 的修订继承上一版，便于只改任务。
- `materializePlan` 把项目与日期写进 `study_task.project_id/project_title/scheduled_date`；`study_task` 的两列是增量列，旧库在启动时由 `ensureTaskProjectColumns` 幂等补列，基础迁移重放修订前也补列。
- 计划页：项目卡（类型、材料、任务数/分钟、日期范围、目标/备注）、任务按项目再按日期分组、条目显示计划日期、未排时间提示「到工作台安排」；缺失信息新增「没有项目」「任务未归入项目」。修订 diff 增加 `projectsChanged` 与 `projectId` 字段。
- 工作台：按 `scheduledDate` 分「今日计划/本周计划」组，显示项目徽标、计划日期和「安排时间」；按钮打开时间块表单并预选任务。缩略视图增加「今日计划」卡。计划外的任务仍按「已安排/其他任务」展示。
- 提示词 v2：先提出 2–5 个项目分法；每个任务必须写 `projectId` 和 `date`；不写 `start/end`；排不下先讨论取舍，学生同意后才可留空并列出。`PROMPT_VERSION=2`。
- 表单提示语说明「助手会分项目并给每个任务分配日期，具体时间到工作台安排」。

**命令与结果（2026-11-11 本机）**

- `node --test --test-isolation=none plugins/study/tests/plans/projects.test.mjs`：4/4（项目分组与物化、未知/重复项目、缺失材料、旧库补列、未分组与修订继承）。
- `node --test --test-isolation=none plugins/study/tests`：632 例 630 pass / 1 fail / 1 skip；唯一失败为既有 `outcomes/performance.test.mjs` 的 100ms 阈值（月查询 median 85.7–89.9ms、max 99.1ms）；该文件单跑与 `outcomes/milestones` 子集均通过，失败随全量进程负载出现，未见与本组数据/查询改动相关的退化。
- `node --test --test-isolation=none plugins/study/tests/client`：75/75（含 bundle 新鲜度）。
- `node plugins/study/scripts/build-client.mjs`：退出 0，bundle 474215 字节（与并行会话的 questions/learning 页面同一次构建）。
- `node plugins/study/tests/kernel/loader-smoke.mjs`：`passed: true`。
- `node plugins/study/tests/onboarding/ui-smoke.mjs`：`passed: true`；计划页 `hasProjects=true`、`projectCount=2 个项目`；工作台 `今日计划` 组含「第二章 导数习题」「计划日期 2026-11-11」「项目：章节学习」，点「安排时间」后时间块表单已预选任务；截图 `plan.png`、`workbench-plan.png`、`workbench-block.png`。
- `node plugins/study/tests/plans/tool-smoke.mjs`：`passed: true`。

**已知限制**

- 没有独立项目 CRUD；项目随计划草案/修订由助手或手工 payload 维护，学生在计划页确认/撤销、在工作台改任务与时间块。
- 服务层仍允许 `date:null`（容量不足、复盘拆分等真实场景）；「每个任务都有日期」由提示词与计划页缺失信息约束，不是硬拒绝。
- 时间块拖到另一天不会改写 `scheduled_date`：计划页跟随实时块显示日期，工作台「今日计划」按计划分配日期分组；不一致时以块为实际执行、以计划为原定意图。
- 页面不再提供目标切换；目标变更后需要重新进入页面读取新作用域。

