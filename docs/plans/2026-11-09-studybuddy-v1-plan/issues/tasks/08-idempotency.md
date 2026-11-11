# SB-08 所有写入强制幂等身份

- 状态：DONE
- 优先级：P1
- 来源：issue 13
- 依赖：SB-01
- 预计：1 个会话
- 所有权：`plugins/study/host/kernel.mjs`、`plugins/study/host/modules/*.mjs`、`plugins/study/client/lib/api.js`、`plugins/study/client/pages/*.js`、`plugins/study/tests/kernel/**`、`plugins/study/tests/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-13`；设计 §6；T01/T09 任务卡。

## 1. 问题

`requestId` 和 `expectedRevision` 仍是可选参数：

- UI 的引导页 `saveGoal/saveDraft/confirm`、计划页 `undo` 没有传 `requestId`。
- `memory_remember`、`study_materials` 导入等 Agent 工具写入没有稳定操作身份；相同记忆以 Agent 身份连续写入两次会得到两条记录。
- `saveGoal` 无 id 时每次都创建新目标；网络重试/双击可能创建重复目标/计划。
- 现有测试只覆盖“调用方确实传了 requestId”的路径。

## 2. 当前证据

- `kernel.mjs` 的 `validateRequest` 允许 `undefined`；`request_log` 只在提供时写入。
- `memory.mjs` 工具写入只传 `actor`；`materials.mjs` 导入没有 requestId。
- `onboarding.js` 的 `saveGoal/saveDraft/confirm` 没有 requestId；`plan.js` 的 `undoPayload` 没有 requestId。
- 复现脚本场景 13。

## 3. 正确业务逻辑

1. **写调用必须有逻辑操作 ID**：UI 每次用户动作生成一个 `requestId`；重试复用同一个 ID，不能每次重试换新 ID。
2. **Agent 工具**：优先使用执行器提供的工具调用 ID；如果同一次业务重试跨工具调用，使用业务层生成的稳定 ID。
3. **Schedule/后台**：任务 key 或 `goalId + date + action` 作为稳定操作 ID，重跑不重复写。
4. **服务端**：`request_log` 命中相同 ID + 相同指纹返回首次结果；相同 ID + 不同载荷返回 `conflict`。
5. **创建型操作**：`saveGoal`/`saveDraft` 无 id 时也必须能通过 requestId 幂等，或要求客户端先传稳定 ID；不能重复创建。
6. **进度追加**：相同 requestId 不追加第二条；同一状态重复点击用业务去重或 requestId 兜底。
7. **资料导入**：同一文件/同一 requestId 不重复创建材料和片段。

## 4. 修改范围

- `kernel.mjs`：对声明为 write 的方法，要求提供 requestId（或由统一适配层注入）；错误信息明确“缺少 requestId”。
- `client/lib/api.js`：提供 `createWriteCall`，自动生成/复用 requestId，页面不再各自拼。
- 所有页面写调用改用统一 helper；引导/计划撤销补上 requestId。
- `memory.mjs`、`materials.mjs`、`plans.mjs`、`tasks.mjs`、`followup.mjs` 的工具/Schedule 写入传稳定 ID。
- 测试：双击/网络重试、Agent 重试、Schedule 补跑、相同 ID 不同载荷冲突、创建型操作不重复。

## 5. 验收标准

- [ ] 引导页双击“保存目标”只创建一个目标；网络重试不重复。
- [ ] 同一 `requestId` 的 `memory_remember` 只写一条；不同载荷同 ID 返回 `conflict`。
- [ ] 同一 `requestId` 的资料导入只创建一份材料/片段。
- [ ] `plans.undo` 重试不会撤销两次；进度追加不重复。
- [ ] 服务端在缺少 requestId 时明确拒绝，而不是静默放行。
- [ ] `node --test --test-isolation=none plugins/study/tests/kernel plugins/study/tests/plans plugins/study/tests/progress plugins/study/tests/memory plugins/study/tests/materials` 通过。

## 6. 不做

- 不改 `request_log` 的存储/清理策略；不引入外部队列。
- 不要求历史数据回填 requestId；只覆盖新写入。
- 不把 requestId 暴露给学生界面。

## 7. 完成后

1. 记录统一 helper 的用法和每个模块的 ID 来源。
2. 更新 `README.md` 状态表。
3. 如果某些旧测试依赖“可选 requestId”，同步改为显式 ID，不降低契约。

## 完成记录

- 会话：与 SB-01 同两个会话（2026-11-10/11）。
- 主要修改：
  - `plugins/study/host/kernel.mjs`：声明为写的方法缺少 `requestId` 时返回 `invalid`；`request_log` 同 ID 同指纹重放首次结果、同 ID 不同载荷返回 `conflict`；写方法在同一事务内执行，结果与 `request_log` 一起提交。
  - `plugins/study/host/operation.mjs`：新增 `toolRequestId(args, exec)`，优先显式 `requestId`，否则使用执行器 `callId`，缺失时报 `invalid`。
  - `plugins/study/host/modules/memory.mjs`：记忆状态写入 SQLite `study_memory_state`，与 `request_log` 同事务；旧 `memory.json` 保留用于迁移与核对。
  - `plugins/study/host/modules/materials.mjs`、`plans.mjs`、`tasks.mjs`、`followup.mjs` 的 Agent 工具写入传稳定操作身份；`client/lib/api.js` 新增 `createWriteCall`，页面写调用统一生成/复用 `requestId`。
  - 测试：`plugins/study/tests/plans/foundation.test.mjs`、`plugins/study/tests/client/idempotency.test.mjs`，并同步更新依赖可选 `requestId` 的既有测试。
- ID 来源：UI 每个用户动作生成一个 `requestId`，双击共享同一 Promise，网络结果不确定的重试复用同一 ID；Agent 工具使用 `exec.callId`（或显式 `requestId`）；服务端 `request_log` 以 `requestId` 为键；Schedule 用 `goalId + date + action` 作为稳定 ID。
- 验证（真实结果）：
  - `node --test --test-isolation=none plugins/study/tests/plans/foundation.test.mjs`：8/8；含“缺少 requestId 拒绝”“同 ID 同载荷重放、同 ID 不同载荷 conflict”“失败注入时记忆与请求记录一起回滚”“Agent 工具 callId 重放资料导入与记忆写入”。
  - `node --test --test-isolation=none plugins/study/tests/kernel plugins/study/tests/plans plugins/study/tests/progress plugins/study/tests/memory plugins/study/tests/materials`：180 例，179 pass / 0 fail / 1 skip（条件跳过的冻结命名空间用例）。
  - `node --test --test-isolation=none plugins/study/tests`：553 例，552 pass / 0 fail / 1 skip。
  - `node --test --test-isolation=none plugins/study/tests/client`：通过（含双击共享调用与网络重试复用 ID）。
- 已知限制：不要求历史数据回填 `requestId`；`request_log` 的存储/清理策略未改；如果同一次业务重试跨不同工具调用，需要调用方显式传同一个 `requestId`。
