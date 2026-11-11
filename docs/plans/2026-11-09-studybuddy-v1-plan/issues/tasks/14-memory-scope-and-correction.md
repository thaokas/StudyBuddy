# SB-14 记忆目标/会话作用域、相关注入与纠错抑制

- 状态：TODO
- 优先级：P1
- 来源：issue 11、issue 12
- 依赖：SB-05（目标作用域）
- 预计：1–2 个会话
- 所有权：`plugins/study/host/modules/memory.mjs`、`plugins/study/client/pages/memory.js`、`plugins/study/client/messages/memory.js`、`plugins/study/tests/memory/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-11`、`#issue-12`；设计 §7.2–§7.4；T20 任务卡；`ACCEPTED-SCOPE.md` 第 2 条。

## 1. 问题

- 记忆记录只有 `text/kind/expiresAt/note`，没有 `goalId/sessionId/messageId/sourceRef`；目标之间会混用状态。
- 来源只有 actor/requestId/时间/自由文本，无法回答“这条记忆来自哪句话”。
- 自动注入按类型和更新时间固定取 8 条，不是按当前目标/任务/问题检索；偏好多了会挤掉相关状态。
- 纠正一条记忆（如“上午学数学”→“晚上学数学”）不保留替代关系；旧句再次写入会正常创建，两个相反偏好并存。
- 删除墓碑只按规范化正文 hash 匹配；近义改写/旧证据可绕过，墓碑超过 500 条会删除旧标记。

## 2. 当前证据

- `memory.mjs` 的 `ALLOWED_REMEMBER_KEYS` 不含 `goalId/sessionId/messageId`。
- `source` 结构只有 actor/requestId/at/note。
- `renderSnapshot` 按 `KIND_ORDER` + `updatedAt` 排序取前 8。
- `remember` 修改原记录时没有把旧正文加入抑制；`tombstones` 按 `contentHash` 匹配，超过上限裁剪。
- 复现/静态确认见 issue 11、12。

## 3. 正确业务逻辑

1. **作用域**：
   - 长期偏好：学生级，可选 `goalId=null`；
   - 目标观察/材料问题：`goalId` 必填；
   - 临时上下文：`sessionId` 必填，短期有效。
2. **来源**：每条记忆保存 `sourceRef`（会话 ID + 消息 ID/轮次 + 可选原话引用）和 `note`；至少能定位到原话。
3. **相关注入**：按当前 `goalId`、任务标题/学科、用户问题做词法检索，选 top N 并限制总字符/Token；偏好作为兜底，不挤掉相关状态。
4. **纠错**：
   - 修改记录时保存 `supersedes`/修订历史，旧正文加入抑制集合；
   - 明确偏好冲突时最新用户纠正优先；
   - 旧对话/提取器再次写入旧正文时返回 `suppressed`。
5. **删除抑制**：按作用域 + 内容 hash/规范化文本匹配；墓碑生命周期覆盖旧证据可重提取范围；超过上限时不能静默删除仍可重提取的墓碑（可压缩/归档）。
6. **不做自动批量提取**：本轮只保证显式 remember/recall/forget 和注入；v1.1 再做提取。

## 4. 修改范围

- `memory.json` 字段：`goalId/sessionId/sourceRef/supersedes`；迁移旧记录为 `scope: student`。
- `remember` 参数白名单增加作用域/来源；旧正文抑制；修订关系。
- `recall`/`renderSnapshot`：按当前目标/会话/查询检索；预算控制；返回来源。
- `forget`：作用域过滤；墓碑匹配范围；上限策略。
- 页面：显示作用域/来源/过期；删除/纠错；已删除列表可选。
- 测试：A/B 目标隔离、纠错后旧句被抑制、近义改写至少不直接覆盖、相关注入、墓碑上限、重启持久化。

## 5. 验收标准

- [ ] A 目标的观察不会注入 B 目标会话；切换目标后记忆集变化。
- [ ] 每条新记忆有 `goalId/sessionId/sourceRef`（按类型要求），页面可查看来源。
- [ ] 纠正“上午学数学”为“晚上学数学”后，再写旧句返回 `suppressed`，不会出现两个相反偏好。
- [ ] 注入按当前问题选相关记忆，不再固定取前 8；总字符预算可控。
- [ ] 删除后旧对话/重试不能重建；墓碑上限不会静默丢掉仍有效抑制。
- [ ] `node --test --test-isolation=none plugins/study/tests/memory` 通过。

## 6. 不做

- 不实现自动批量提取（v1.1）。
- 不引入向量/图数据库；继续词法检索。
- 不加密 `memory.json`（数据目录权限保护）；不改变导出排除策略。

## 7. 完成后

1. 记录记忆 schema 迁移、作用域规则和纠错示例。
2. 更新 `README.md` 状态表。
3. 如果 SB-05 的 `goalId` 解析未完成，先依赖它，不在 memory 里另造目标系统。
