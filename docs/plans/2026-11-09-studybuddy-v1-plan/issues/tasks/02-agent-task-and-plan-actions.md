# SB-02 Agent 任务工具与计划页/工作台动作

- 状态：DONE
- 优先级：P0
- 来源：issue 01（产品接入部分）
- 依赖：SB-01
- 预计：1–2 个会话
- 所有权：`plugins/study/host/modules/tasks.mjs`、`plugins/study/host/modules/plans.mjs`、`plugins/study/host/modules/tutoring.mjs`、`plugins/study/client/pages/plan.js`、`plugins/study/client/pages/workbench.js`、`plugins/study/client/actions/ask-task.js`、`plugins/study/tests/plans/**`、`plugins/study/tests/tasks/**`、`plugins/study/tests/client/**`
- 开工阅读：SB-01 完成记录；`issues/2026-11-10-design-code-review.md#issue-01`；设计 §4.2–§4.4；T10、T11 任务卡。

## 1. 问题

服务统一后，Agent 和界面仍然缺少执行入口：

- `tasks` 命名空间没有注册 Agent 工具；Agent 只能通过 `study_plan` 看到计划条目，不能读取/创建/移动工作台任务和时间块。
- `plan.js` 只有“刷新/撤销”按钮；不能确认草案、应用修订、记录进度，也不能拖拽计划条目。
- 确认只存在引导页；引导完成后 Agent 再生成草案，学生只能重新打开引导页确认。
- `ask-task` action 虽然注册为 `page: 'workbench'`，但工作台页面没有渲染“问这道题”入口。
- 左栏只显示时间块，不提供“从任务开始答疑/计时”的入口。

## 2. 当前证据

- `tasks.mjs` 的 `apply` 只注册服务方法，没有 `defineTool`。
- `plans.mjs` 有 `study_plan`/`study_progress`，但读的是计划视图，不是工作台任务。
- `client/pages/plan.js` 只渲染刷新、撤销、重试按钮。
- `client/pages/workbench.js` 没有调用 `actions.run`/`actions.forPage`，`ask-task.js` 的入口不可达。
- 复现脚本场景 1 已确认“确认计划后工作台为空”。

## 3. 正确业务逻辑

1. **Agent 与 UI 同一服务**：新增 `study_tasks` 工具，至少支持 `day/week/list/create/update/moveBlock/recordProgress`；所有写操作调用 `ctx.study.call('tasks', …)`，不直接操作数据库。
2. **计划页可执行**：计划页提供“确认草案”“应用修订”“记录进度（完成/部分/未完成/取消）”；确认/修订仍走 `plans` 服务，进度走统一任务账本（SB-01）。
3. **不再有聊天专用计划**：Agent 的 `study_plan today` 与工作台 `tasks.day` 必须返回同一批任务/时间块；如果 Agent 要改时间，必须调用 `study_tasks.moveBlock` 或 `study_plan` 的修订动作，不能只改 JSON 快照。
4. **答疑入口**：工作台每个任务行提供“问这道题”，调用 `tutoring.open` 并带上当前 session；没有 session 时先创建/打开备考会话，不静默失败。
5. **计时入口**：任务行提供“开始番茄”入口，预填任务；计时完成不自动完成任务。
6. **无模型可用**：所有按钮/工具在无 API Key 时仍可本地工作；Agent 工具不可用时，界面动作仍可用。

## 4. 修改范围

### 4.1 Host

- 在 `tasks.mjs` 注册 `study_tasks` 工具；参数与返回值使用现有服务字段，不新增第二套 DTO。
- 给 `plans.mjs` 的 `study_plan` 增加任务读取/移动的协作逻辑，或明确由 `study_tasks` 负责执行事实，`study_plan` 只读计划。
- `tutoring.brief/open` 支持从任务行直接调用；确保同一 session 只链接一个任务。

### 4.2 Client

- `plan.js`：确认草案、应用修订、记录进度、撤销；草案差异/试行闸门沿用现有组件。
- `workbench.js`：任务行渲染“问这道题”“开始番茄”；进度控件写统一任务账本；拖拽调用 `tasks.moveBlock`。
- `studyleft.js`：如果需要，增加“打开工作台/开始答疑”的入口，但不要把写操作放进左栏。
- 所有写调用带 `requestId`，并显示服务失败原因。

### 4.3 测试

- 服务层：Agent 工具与 UI 调用同一方法，返回一致结果。
- 页面层：计划页确认后工作台出现任务；工作台拖拽后计划页读到新时间；ask-task 能调用 tutoring。
- 无 Key：页面按钮仍可执行本地写操作。

## 5. 验收标准

- [x] Agent 调用 `study_tasks day` 能看到工作台任务/时间块；调用 `moveBlock` 后计划页显示新时间。
- [x] 计划页能确认草案；确认后工作台/摘要出现对应任务和时间块。
- [x] 计划页能记录完成/部分/取消；成果页与工作台账本一致。
- [x] 工作台任务行出现“问这道题”，点击后创建/复用 session 并注入任务上下文。
- [x] 无 API Key 时上述本地按钮仍可用，错误有明确提示。
- [x] `node --test --test-isolation=none plugins/study/tests/plans plugins/study/tests/tasks plugins/study/tests/tutoring plugins/study/tests/client` 通过（客户端构建新鲜度需宿主权限）。
- [x] `node plugins/study/scripts/build-client.mjs` 成功，产物包含新增入口。

## 6. 不做

- 不重做计划算法、不做滚动细化（SB-18）。
- 不实现自动晚间复盘（SB-07）。
- 不在本卡引入新的页面；只补现有页面动作。

## 7. 完成后

1. 记录 Agent 工具/页面入口的实际调用链和测试结果。
2. 更新 `README.md` 状态表。
3. 如果发现 SB-01 的读模型不够，回到 SB-01 补，不在本卡另造字段。

## 8. 完成记录（2026-11-11）

**实际调用链**

- Agent：`study_tasks` → `ctx.study.call('tasks', …)` → `study_task` / `study_time_block` / `study_task_progress`；写操作统一经 `toolRequestId` 生成幂等键。支持 `day/week/list/create/update/createBlock/moveBlock/recordProgress`。
- 计划页：`plans.get` 读正式修订与草案；确认/应用修订走 `plans.confirm|revise`；进度走 `plans.recordProgress`（内部转 `tasks.recordProgress`）；拖拽走 `tasks.moveBlock`；撤销走 `plans.undo`。写入成功后发 `notifyStudyDataChanged`，始终显示服务失败原因。
- 工作台：任务行「问这道题」调 `actions.run('ask-task')`；无当前会话时 `activity.ensureSession` 先打开/创建会话，再 `tutoring.open` 注入任务；`tutoring.brief` 只在没有会话构造器时返回 brief。「开始番茄」调 `timer.start`，预填 `taskId`，计时完成不写任务完成。
- 读同一事实：`study_plan today/week` 通过 `livePlanData` 投影到 `study_task`/`study_time_block`，`tasks.day` 与计划页读到同一批任务和时间块；拖拽后计划页显示新时间。计划确认后 `materializePlan` 生成任务与执行块，工作台立即可见。

**测试与构建**

- `node --test --test-isolation=none plugins/study/tests/tasks plugins/study/tests/tutoring`：68 pass / 0 fail。
- `node --test --test-isolation=none plugins/study/tests/plans`：40 pass / 0 fail。
- `node --test --test-isolation=none plugins/study/tests/client/daily-loop.test.mjs`：4 pass / 0 fail（工具=服务、移动块、统一进度账本、计划页控件可达、ask-task 会话/幂等、写入后刷新信号）。
- `node plugins/study/scripts/build-client.mjs` 成功（bytes 409782），产物 `client/client.js` 含新增的 plan/workbench 动作、`ask-task` 与刷新信号。
- 构建新鲜度测试 `node --test --test-isolation=none plugins/study/tests/client/build.test.mjs` 在普通沙箱内因 esbuild `spawn EPERM` 无法完成；在宿主权限下 11/11 通过。

**已知限制**

- 没有做真实浏览器点击级的工作台拖拽/计划确认冒烟，留 T19 全场景回归；纯视图、服务与动作测试已覆盖契约。
- `ask-task` 复用当前主视图会话，或创建默认 workspace 会话；没有独立命名的“备考会话”，该项属于 SB-11。
- 计划页「部分完成」的数量输入仍使用 `prompt()`，后续可换内联表单；不影响服务写入与幂等。
- 左栏已被后续并行重构合并为工作台 compact 显示，因此本卡不再单独接线 `studyleft.js`；计划/任务写入通过 `client/lib/refresh.js` 通知当前挂载的工作台摘要刷新。
