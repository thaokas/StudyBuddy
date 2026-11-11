# SB-11 首次引导接入真实对话和默认备考会话

- 状态：TODO
- 优先级：P1
- 来源：issue 18（对话建档/默认会话部分）
- 依赖：SB-01、SB-05
- 预计：1–2 个会话
- 所有权：`plugins/study/client/pages/onboarding.js`、`plugins/study/host/modules/materials.mjs`、`plugins/study/host/modules/plans.mjs`、`plugins/study/client/messages/onboarding.js`、`scripts/project-config.mjs`（如 preset/session 需要）、`plugins/study/tests/onboarding/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-18`；设计 §4.1、§4.2、§4.4；T10 任务卡。

## 1. 问题

- T10 的目标是“第一次打开能用对话把计划谈出来”，当前是 `goal → materials → draft → confirm` 四步表单。
- 引导页只给一句“在对话里说……”的示例，不创建/打开会话，也不调用模型。
- 没有“目标 → 备考主会话”的持久映射；新会话不会自动带上目标上下文。
- 资料工具只支持检索/导入文本，Agent 没有目标读写工具；引导页无法让 Agent 自然补全目标。
- 没有按日启动细化/按执行校准的触发（滚动细化另见 SB-18）。

## 2. 当前证据

- `onboarding.js` 是表单；`materials.mjs` 的 `study_materials` 工具只有检索/文本导入/列表等动作，没有目标读写。
- `project-config.mjs` 没有注册学习规划/陪伴 preset 或默认备考会话映射。
- T10 验收“不填长表单也能开始”目前靠表单字段可选，不是对话。
- 复现/静态确认见 issue 18。

## 3. 正确业务逻辑

1. **对话优先，表单补充**：首次进入可以选“和助手聊”或“快速填写”；表单保留为快捷入口，不阻断。
2. **目标工具**：给 Agent 提供 `study_goal` 或扩展 `study_materials` 的 `getGoal/saveGoal` 动作，让对话能读取/保存考试、年份、期限、每日预算。
3. **默认备考会话**：每个激活目标保存一个 `mainSessionId`（或等价映射）；打开应用/目标时优先进入该会话；具体问题可另开会话，但共享目标上下文。
4. **目标上下文**：会话开始时注入当前目标、阶段目标、今日任务摘要；不把整份计划 JSON 塞进 prompt。
5. **渐进补充**：只追问会明显改变安排的信息；缺信息标假设，不阻断。
6. **无模型可用**：对话不可用时，表单/工作台仍可本地使用；明确提示需要配置模型。
7. **滚动细化**：不在本卡实现；本卡只预留“按日启动细化”的触发点，SB-18 做窗口/校准。

## 4. 修改范围

- `onboarding.js`：增加“和助手聊”入口，打开/创建默认备考会话；保留表单步骤。
- `materials.mjs`：增加目标读写 Agent 工具（或扩展 `study_materials`）；校验/权限与 `saveGoal` 一致。
- `project-config.mjs`/profile：注册学习 preset 或会话映射（如果 DSH 支持）；不支持则记录 BLOCKED 和降级。
- `plans/materials`：保存 `mainSessionId` 到目标或 profile 配置。
- 测试：首启无模型、对话入口、目标工具、默认会话复用、目标切换后会话切换。

## 5. 验收标准

- [ ] 首次进入可以选“和助手聊”，打开/创建默认备考会话，而不是只显示表单。
- [ ] Agent 能读取/保存目标；缺字段时标假设，不阻断。
- [ ] 目标 A 有主会话；切到 B 打开 B 的主会话，不混用。
- [ ] 表单仍可用；“稍后继续”保留。
- [ ] 无 API Key 时明确提示，本地表单/工作台可用。
- [ ] `node --test --test-isolation=none plugins/study/tests/onboarding plugins/study/tests/materials` 通过；真实 Host 做一次首启证据。

## 6. 不做

- 不实现滚动 7 天细化/每日校准（SB-18）。
- 不实现自动批量记忆提取（ACCEPTED-SCOPE）。
- 不要求模型一定按固定话术；只保证目标和会话可用。

## 7. 完成后

1. 记录首启对话/默认会话的实际证据和 DSH preset 可用性。
2. 更新 `README.md` 状态表。
3. 如果 DSH 不支持默认会话映射，记录 BLOCKED，并保留“手动打开备考会话”的降级。
