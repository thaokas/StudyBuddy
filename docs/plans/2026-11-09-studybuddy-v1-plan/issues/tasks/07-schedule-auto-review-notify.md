# SB-07 Schedule、复盘保存决策和学习通知

- 状态：DONE
- 优先级：P1
- 来源：issue 08
- 依赖：SB-04、SB-06
- 预计：1 个会话
- 所有权：`plugins/study/host/modules/followup.mjs`、`plugins/study/client/pages/reminders.js`、`plugins/study/client/notify.js`、`scripts/project-config.mjs`（如 Schedule/profile 需要）、`plugins/study/tests/followup/**`、`plugins/study/tests/notify/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-08`；设计 §4.6、§8；T12 任务卡；`session-116db5ef` 的 1.3。

## 1. 问题

- T12 写的是“Schedule 触发”，实际只有 Host 心跳 + Renderer 15 秒轮询；没有注册/验证 DSH Schedule。
- 晚间复盘到点只加载预览，保存必须学生点击；T12/spec 的“默认授权微调”没有落地，也没有“手动确认”这一产品决策的明确记录。
- 学习提醒只有应用内 banner；T15 的系统通知只覆盖“模型回复完成”，任务提醒没有简单 B 通知。
- 番茄钟结束没有学习通知。
- 启动/恢复没有“已恢复、待确认、待补做”的摘要；失败只留在本地状态。

## 2. 当前证据

- `followup.mjs` 用 `setInterval` 心跳；`client/pages/reminders.js` 用 `POLL_MS` 轮询。
- `reminders.js` 的 `review` 调用只在用户点击时发生。
- `client/notify.js` 的 Notification 只监听 session `running` 从 true 到 false。
- 没有 `ctx.schedule` 调用；没有启动摘要组件。
- 复现/静态确认见 issue 08。

## 3. 正确业务逻辑

### 3.1 调度

1. 用 DSH Schedule（或项目已锁定的等价持久化调度）注册“日内检查”和“晚间复盘”两个触发；触发时只调用确定性业务服务，不依赖 Renderer 存活。
2. 如果当前 DSH 版本的 Schedule 无法注册到 study profile，必须记录 BLOCKED/降级方案，并明确“应用关闭时不提醒”；不能继续把 Renderer 轮询写成 Schedule。
3. 触发前检查：应用状态、静默设置、当前目标、任务最新状态、已发送记录；失败可重试，只有保存成功才显示“已调整”。

### 3.2 复盘保存

必须先做一个明确决策，并写进 T12/文案：

- **选项 A（spec 默认）**：到点自动保存修订，设置里可关闭；提供撤销；失败保留 `needs_adjustment`。
- **选项 B（手动确认）**：到点只提醒/预览，学生点击后保存；文案明确“需要你确认”，不再写“自动调整”。

无论 A/B，都要求：保存前校验 `baseRevision` 和草案版本；保存成功才展示摘要；失败不宣布成功。

### 3.3 通知

1. 任务提醒的简单 B：在 Renderer 权限允许时用 `new Notification()` 发一条，和页内 banner 共用 reminder key；失败/拒绝权限时只保留页内。
2. 不做 Host→main 完整桥、不做点击通知跳转的复杂链路（本轮不做）。
3. 系统通知与页内提醒不能重复轰炸：同一 key 只发一次；页内已答复后不再发。
4. 番茄结束可以复用同一通知通道，但不自动完成任务。

### 3.4 启动/恢复

1. 启动时展示最近一次复盘状态、未答复提醒、待确认任务；合并遗漏，不逐条补发几天前的历史。
2. 关闭应用前/启动时说明“后台工作会停止/已恢复”，不承诺跨进程提醒。

## 4. 修改范围

- `followup.mjs`：注册 Schedule（或记录不可用）；抽取 `runDueCheck`/`runReview` 为可被调度和 UI 共用的服务；恢复摘要查询。
- `reminders.js`：保留预览；根据 A/B 决策增加自动保存或明确手动；显示启动摘要/失败状态。
- `notify.js` 或新 `client/notifications.js`：任务提醒简单 B，共用 key，权限降级；番茄结束通知。
- `tests/followup`、`tests/notify`：调度触发、去重、权限失败、自动/手动保存、启动摘要、无跨日补发。

## 5. 验收标准

- [x] 不打开提醒页，Host 仍能在到点触发日内检查/复盘（或在卡末记录 Schedule 不可用的 BLOCKED 与降级）。
- [x] 复盘按选定 A/B 行为执行；保存失败不显示“已更新”，成功后摘要可见。
- [x] 任务提醒在权限允许时出现系统通知，页内 banner 仍在；同一 key 不重复。
- [x] 番茄结束有通知，但不自动完成任务。
- [x] 重启后显示最近有效摘要，不逐条补发历史提醒。
- [x] `node --test --test-isolation=none plugins/study/tests/followup plugins/study/tests/notify` 通过；真实浏览器通知做一次证据。

## 6. 不做

- 不做 Host→main 完整通知桥（C 方案）。
- 不做跨日补发历史提醒。
- 不做模型自主改目标。
- 不在本卡做复盘拆分（SB-04）。

## 7. 完成后

1. 记录 A/B 决策、Schedule 可用性、通知权限结果和测试证据。
2. 更新 `README.md` 状态表。
3. 如果 Schedule 不可用，必须在 T12/STATUS 记录降级，不得静默改成轮询。

## 8. 完成记录（2026-11-11）

**复盘保存决策：选项 B（手动确认）**

- 到点只生成预览并提示；保存必须由学生点击「保存调整」。
- 文案明确写「需要你确认后才保存调整」，不再宣称自动调整；`followup.recovery` 返回 `reviewDecision: 'manual_confirmation'`。
- 保存前校验 `baseRevision`；存在未确认草案时 `blocked/draft_pending`；预览后计划被手动修订时 `needs_adjustment/plan_changed`；`plans.revise` 失败保留 `needs_adjustment` 与错误原文，界面只显示“待调整”，不显示成功摘要。
- 每日 `committed`/`nothing_to_do` 后不再提示；`blocked`/`needs_adjustment` 仍提示。

**Schedule 可用性：降级并记录**

- 当前 DSH 的 `ctx.schedule` 面向 Session 投递 prompt，会唤醒模型 turn，不能注册“只调用确定性业务服务”的回调；因此没有把 Renderer 轮询写成 Schedule。
- 实际实现为 Host 每 15 秒 `runDueCheck`（claim）+ `due`，到复盘时间再 `runReview`（仅预览）；`followup.recovery.scheduling` 明确返回 `status: 'degraded'` 与原因，`reviewDecision` 也随恢复摘要返回。这是卡内允许的 BLOCKED/降级方案。
- 应用关闭后不承诺提醒。

**通知**

- `client/learning-notify.js`：提醒 key 同时作为系统通知 `tag`；`Notification.permission === 'granted'` 时每个 key 只发一次，拒绝/不支持时 `notify` 返回 false，页内 banner 不受影响；权限被拒绝不会消耗 key，之后授权仍可补发当前仍有效的提醒。
- 提醒页新增「启用学习系统通知」入口与权限状态；恢复 banner 也可请求权限并可关闭，不再永久占屏。
- 番茄 `phase='finished' && outcome='completed'` 时复用同一通道发一次通知，不完成任务；中断/提前结束不发。
- 真实浏览器证据：`node plugins/study/tests/notify/learning-browser-smoke.mjs` 用 Playwright + Edge 跑授权与拒绝两个 context，报告 `passed: true`，证据 `plugins/study/tests/notify/evidence/learning-browser.json`。

**启动/恢复摘要**

- `followup.recovery` 返回最近一次复盘状态、未答复提醒、待确认进度、调度降级与通知决策；banner 首次轮询读取，可关闭，不逐条补发历史提醒；关闭后下一次启动才重新出现。

**测试**

- `node --test --test-isolation=none plugins/study/tests/followup`：38 pass / 0 fail（含手动保存、过期 baseRevision、草案阻断、Host 检查服务不挂页面）。
- `node --test --test-isolation=none plugins/study/tests/notify`：51 pass / 0 fail（权限/去重/刷新/番茄/装配/页面）。
- 真实浏览器通知证据 `passed: true`（Edge；授权 context 首次发送 true、第二次 false；拒绝 context 不发且不抛错）。

**已知限制**

- 未做 Host→main 完整通知桥（C 方案），因此系统通知仍依赖 Renderer 存活；应用关闭时只有页内记录，没有后台推送。
- Windows toast 是否最终显示仍受 AppUserModelID/快捷方式限制；本卡证据证明浏览器 API 与权限降级路径，不证明每台机器的 toast 可见。
- 复盘仍不自动保存（决策 B），因此“到点自动调整”不是当前行为；这是明确的产品决策，不是遗漏。
