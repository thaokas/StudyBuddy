# SB-13 导出使用真实成果服务并提供入口

- 状态：TODO
- 优先级：P1
- 来源：issue 22
- 依赖：SB-01
- 预计：0.5–1 个会话
- 所有权：`plugins/study/host/modules/export.mjs`、`plugins/study/client/pages/*.js` 或 `client/notify.js` 的设置入口、`docs/backup.md`、`plugins/study/tests/**`、`scripts/backup-studybuddy.mjs`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-22`；设计 §10；T17 任务卡。

## 1. 问题

- `export.mjs` 只根据 `study_outcome*` 表判断成果模块是否存在；成果是无表计算视图，导致导出错误标注“成果模块不存在、成果为空”。
- 导出没有覆盖 T17 要求的目标/资料/任务/计划/进度/成果/记忆的成果部分。
- 只有 Agent 工具和鉴权路由，没有应用内导出入口；普通学生不容易发现。
- 原始会话/导入文件的可选导出未实现（本轮不作为必修，见 ACCEPTED-SCOPE）。

## 2. 当前证据

- `export.mjs` 扫描 `study_outcome*` 表并设置 `availability.outcomes`；当前没有这些表。
- `docs/backup.md` 也写着“成果为空/模块不存在”，与实际 T13 成果服务不一致。
- 没有设置页/工作台导出按钮；只有 `study_export` 工具和 `/api/study/export.json`。
- 复现/静态确认见 issue 22。

## 3. 正确业务逻辑

1. 导出分为“原始事实”和“派生成果”：
   - 原始事实：目标、资料、片段、任务、时间块、计划修订、草案、进度、记忆、变更日志。
   - 派生成果：调用 `outcomes` 服务计算选定周期（至少当前日/周/月）的快照，或明确只导出可重算原始事实。
2. 不能用表名判断模块是否存在；用服务注册/能力探测（`ctx.study` 是否有 `outcomes`）或直接调用成果服务。
3. `availability.outcomes` 反映真实可用性；不可用时给出原因，不伪造空成果。
4. 默认排除凭据、`request_log`、日志、FTS；保持现有凭据形状检查。
5. 提供一个应用内入口（设置页/工作台/导出对话框），允许选择周期和是否包含原始事实；默认不包含原始会话/附件。
6. 导出文件写入 `<dataRoot>/study/exports/`，返回路径、字节数、revision、摘要。
7. 完整冷备份仍由 `scripts/backup-studybuddy.mjs` 负责，导出不是可恢复镜像。

## 4. 修改范围

- `export.mjs`：调用 `outcomes.day/week/month`（按可用性）；增加 `availability` 真实判断；更新文档注释。
- `docs/backup.md`：删除“成果为空/模块不存在”的过时描述；说明导出是原始事实+可选成果快照。
- 客户端：增加导出按钮/设置项，调用鉴权路由或 Agent 工具；显示成功路径/失败原因。
- 测试：导出包含真实成果、不可用原因、凭据排除、无原始会话默认、UI 入口。

## 5. 验收标准

- [ ] 导出不再错误标注“成果模块不存在”；`data.outcomes` 或 `data.outcomeSnapshot` 有真实日/周/月数据，或明确说明只导出原始事实。
- [ ] 导出包含 T17 要求的七类业务数据；凭据/request_log/日志不出现。
- [ ] 应用内有可发现的导出入口；失败有原因。
- [ ] 默认不包含原始会话/附件；如未来增加，必须显式选择。
- [ ] `node scripts/backup-studybuddy.mjs --drill` 通过；`node --test --test-isolation=none plugins/study/tests` 相关通过。

## 6. 不做

- 不做热备份/云同步/自动定时导出。
- 不导出凭据；不导出 `request_log`。
- 原始会话/导入文件可选导出留到后续（ACCEPTED-SCOPE）。

## 7. 完成后

1. 记录导出 JSON 的实际字段和 UI 入口证据。
2. 更新 `README.md` 状态表。
3. 如果 outcomes 服务未注册，导出应明确不可用，而不是伪造空成果。
