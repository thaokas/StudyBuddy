# SB-10 页码/题号必须有证据或标未核实

- 状态：TODO
- 优先级：P1
- 来源：issue 16
- 依赖：SB-01
- 预计：0.5–1 个会话
- 所有权：`plugins/study/host/modules/plans.mjs`、`plugins/study/host/modules/materials.mjs`、`plugins/study/client/pages/plan.js`、`plugins/study/tests/plans/**`、`plugins/study/tests/materials/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-16`；设计 §4.1、§5；T08/T09 任务卡。

## 1. 问题

计划条目的 `locator` 只做字段类型校验：

- 填了 `page`/`chapter`/`exercise` 就不能同时标 `unverified`；没有检查对应材料/目录/原文证据。
- 模型可以提交无出处的页码/题号，界面会当成已核实信息展示。
- 这与“信息不足时标记假设、不能凭空补页码题号”相反。

## 2. 当前证据

- `plans.mjs` 的 `normalizeLocator` 只校验类型，不查询 `study_material`/`study_material_chunk`。
- `unverified` 是调用方可选字段，非空 page/chapter/exercise 时不会自动置为 true。
- 复现/静态确认见 issue 16。

## 3. 正确业务逻辑

1. 每个 locator 字段（page/chapter/exercise）都有独立的核实状态和证据引用。
2. 只有以下情况可标 `verified`：
   - 材料片段/目录中能定位到该页码/章节/题号；
   - 学生明确声明并记录来源；
   - 导入文件自带页码/目录且解析成功。
3. 无法验证时保存为 `unverified`，并记录 `assumption`（例如“按目录第 2 章推断，页码待核实”）；任务仍可执行，但 UI 明确显示“待核实”。
4. 服务端不能因为字段非空就假定已核实；计划页显示核实状态和证据入口。
5. Agent 提交无出处页码时，服务优先降级为 `unverified`；如果模型声称已核实但无证据，拒绝或提示补充。
6. 资料删除/换版后，旧 locator 的证据失效，要重新标未核实，不静默保留“已核实”。

## 4. 修改范围

- `plans.mjs`：`normalizeLocator` 接收 `evidence`/`verification`；查询材料片段/目录做校验；返回 `unverified` + `assumption`。
- `materials.mjs`：提供 `verifyLocator`/`locate` 的确定性查询；返回匹配的 chunk/page/chapter 或 null。
- `client/pages/plan.js`：显示核实状态、证据详情、待核实提示。
- 测试：有证据的页码、无证据页码、目录推断、资料删除后失效、换版后失效。

## 5. 验收标准

- [ ] 无证据的 `page: 42` 被标 `unverified`，UI 显示“待核实”，不显示为已核实。
- [ ] 材料目录/片段能定位的章节标 `verified`，并给出证据引用。
- [ ] 模型提交“已核实”但无证据时被拒绝或降级。
- [ ] 删除/换版资料后，旧 locator 不再显示已核实。
- [ ] `node --test --test-isolation=none plugins/study/tests/plans plugins/study/tests/materials` 通过。

## 6. 不做

- 不实现 OCR/扫描件识别；扫描件仍按 T08 明确失败。
- 不保证所有教材目录都能自动解析；无法解析就标未核实。
- 不引入模型判断“看起来对不对”；只用材料证据/学生声明。

## 7. 完成后

1. 记录 locator 证据结构和测试夹具。
2. 更新 `README.md` 状态表。
3. 如果 SB-01 改了条目结构，合并字段，不另造 locator 副本。
