# SB-03 草案独立版本与并发保护

- 状态：DONE
- 优先级：P1
- 来源：issue 03
- 依赖：无（可与 SB-01 并行，但涉及 `plans.mjs` 时需等 SB-01 的数据结构定稿）
- 预计：0.5–1 个会话
- 所有权：`plugins/study/host/modules/plans.mjs`、`plugins/study/tests/plans/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-03`；设计 §4.6、§6、§8；T09 任务卡。

## 1. 问题

`saveDraft` 只校验正式 `baseRevision`；修改草案不提升正式版本，也不比较草案自己的修订号。正式版本同为 1 时，先保存新手动草案，再提交旧 Agent 草案，旧草案会被接受并覆盖新草案。

## 2. 当前证据

- `plans.mjs` 的 `saveDraft` 读取 `baseRevision`，但没有 `draftRevision`。
- `study_plan_draft` 表没有独立版本列。
- 复现脚本场景 3：同一正式修订下，旧草案覆盖新草案。

## 3. 正确业务逻辑

1. 草案是独立文档，有自己的递增版本 `draftRevision`。
2. 所有草案写入必须携带 `expectedDraftRevision`：
   - 新建草案：0；
   - 修改已有草案：上次读到的 `draftRevision`。
3. 版本不匹配返回 `conflict`，携带最新草案、差异和当前 `draftRevision`；不能静默覆盖。
4. 确认草案时同时校验正式 `baseRevision` 和草案版本；确认成功后草案删除或标记为已应用，并追加正式修订。
5. Agent 工具和引导页/计划页都必须带草案版本；`expectedDraftRevision` 不是可选装饰。

## 4. 修改范围

- `study_plan_draft` 增加 `revision`（整数，从 1 开始）或等价字段；迁移旧草案为 revision 1。
- `saveDraft` 增加 `expectedDraftRevision` 校验；返回最新草案和差异。
- `confirmPlan` 在确认时校验草案版本；旧版本拒绝。
- `study_plan` 工具参数增加 `expectedDraftRevision`，并在错误提示中返回最新值。
- 页面（引导/计划）读取草案后保存版本，写入时带回。
- 测试：旧草案覆盖新草案、确认旧草案、Agent/UI 并发、重启后版本保留。

## 5. 验收标准

- [ ] 正式版本相同，先保存手动草案 A，再提交旧草案 B：B 返回 `conflict`，A 保持不变。
- [ ] 携带正确 `expectedDraftRevision` 的修改成功，版本递增。
- [ ] 确认草案时携带过期版本返回 `conflict`，不追加正式修订。
- [ ] Agent 工具和 UI 都能拿到最新草案版本；错误信息包含当前版本。
- [ ] 旧数据库草案迁移后仍可读取/确认。
- [ ] `node --test --test-isolation=none plugins/study/tests/plans` 通过。

## 6. 不做

- 不改变正式修订的 `expectedRevision` 语义。
- 不实现自动合并；冲突交给调用方重新读取。
- 不在本卡改计划内容结构（SB-01 负责）。

## 7. 完成后

1. 记录迁移方式和并发测试结果。
2. 更新 `README.md` 状态表。
3. 如果 SB-01 已改表结构，合并迁移脚本，避免两次 schema 变更。

## 完成记录

- 会话：与 SB-01 同两个会话（2026-11-10/11）。
- 主要修改：
  - `plugins/study/host/modules/plans.mjs`：`study_plan_draft` 增加独立 `revision`，`study_plan.draft_revision` 同步；`saveDraft`/`confirm`/`discardDraft` 校验 `expectedDraftRevision`；不匹配返回 `conflict` 并携带当前版本与最新草案；确认同时校验正式 `baseRevision`；丢弃草案后版本继续递增，不能复用旧版本。
  - `study_plan` Agent 工具：参数增加 `expectedDraftRevision`，错误信息返回最新值。
  - 客户端：引导页、计划页读取草案后保存版本，写入时带回；Agent 与 UI 走同一服务契约。
  - `plugins/study/host/facts.mjs`：旧库迁移把已有草案标为 `revision = 1`。
- 并发语义：新建草案用 `expectedDraftRevision: 0`；修改/确认必须带上次读到的 `draftRevision`；旧草案不能覆盖新草案；失败时正式修订不追加，草案保持不变。
- 验证（真实结果）：
  - `node --test --test-isolation=none plugins/study/tests/plans`：40/40 通过。
  - `plugins/study/tests/plans/foundation.test.mjs` 的 SB-03 两例通过：旧草案的再次保存与确认均返回 `conflict`（含当前 `draftRevision`），重启后版本保留；丢弃草案后重建不能复用旧版本。
  - `node --test --test-isolation=none plugins/study/tests`：553 例，552 pass / 0 fail / 1 skip。
- 已知限制：不做自动合并，冲突后必须重新读取；旧草案迁移统一为 revision 1，迁移前无法区分更早的草案版本。
